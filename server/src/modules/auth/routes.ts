import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import {
  hashPassword, passwordProblem, randomToken, sha256, signAccess, verifyPassword,
} from '../../lib/security.js';
import { ACCESS_COOKIE, authenticate } from '../../middleware/auth.js';
import { CSRF_COOKIE } from '../../middleware/csrf.js';

const REFRESH_COOKIE = 'rk_rt';
const router = Router();

// Constant-time-ish defence against user enumeration by response timing.
const DUMMY_HASH = await hashPassword('not-a-real-password');

const cookieBase = { httpOnly: true, sameSite: 'lax' as const, secure: isProd, domain: env.COOKIE_DOMAIN || undefined };

function setAuthCookies(res: Response, access: string, refresh: string, csrf: string) {
  res.cookie(ACCESS_COOKIE, access, { ...cookieBase, path: '/', maxAge: env.ACCESS_TOKEN_TTL_MIN * 60_000 });
  res.cookie(REFRESH_COOKIE, refresh, { ...cookieBase, path: '/api/auth', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
  // Readable by JS on purpose (double-submit token).
  res.cookie(CSRF_COOKIE, csrf, { ...cookieBase, httpOnly: false, path: '/', maxAge: env.REFRESH_TOKEN_TTL_DAYS * 86_400_000 });
}
function clearAuthCookies(res: Response) {
  res.clearCookie(ACCESS_COOKIE, { ...cookieBase, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...cookieBase, path: '/api/auth' });
  res.clearCookie(CSRF_COOKIE, { ...cookieBase, httpOnly: false, path: '/' });
}

async function createSession(userId: string, req: Request) {
  const refresh = randomToken(48);
  const row = await queryOne(
    `INSERT INTO auth_sessions (user_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4, now() + ($5 || ' days')::interval) RETURNING id`,
    [userId, sha256(refresh), req.get('user-agent')?.slice(0, 300) ?? null, req.ip ?? null, String(env.REFRESH_TOKEN_TTL_DAYS)],
  );
  return { sid: row!.id as string, refresh };
}

async function profile(userId: string) {
  const u = await queryOne(
    `SELECT u.id, u.email, u.full_name, u.mobile, u.org_id, u.must_change_password,
            o.name AS org_name, o.slug AS org_slug, o.code_prefix
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
    [userId],
  );
  const roles = await query(
    `SELECT r.key, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId],
  );
  const perms = await query(
    `SELECT DISTINCT p.key FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1 ORDER BY 1`,
    [userId],
  );
  return {
    id: u!.id, email: u!.email, full_name: u!.full_name, mobile: u!.mobile,
    organization: u!.org_id ? { id: u!.org_id, name: u!.org_name, slug: u!.org_slug, code_prefix: u!.code_prefix } : null,
    must_change_password: u!.must_change_password,
    roles: [...new Set(roles.map((r) => r.key))],
    branch_ids: roles.filter((r) => r.branch_id).map((r) => r.branch_id),
    permissions: perms.map((p) => p.key),
  };
}

const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: env.LOGIN_RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.NODE_ENV === 'test' && process.env.TEST_LIMITS !== '1',
  message: { ok: false, error: { code: 'RATE_LIMITED', message: 'Too many sign-in attempts. Please wait a few minutes and try again.' } },
});

router.post('/login', loginLimiter, wrap(async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }), req.body);
  const u = await queryOne(
    `SELECT id, org_id, email, password_hash, status, failed_login_count, locked_until
       FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`,
    [body.email],
  );
  const genericFail = new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');
  if (!u) { await verifyPassword(body.password, DUMMY_HASH); throw genericFail; }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Please try again later.');
  }
  const valid = await verifyPassword(body.password, u.password_hash);
  if (!valid) {
    const lock = u.failed_login_count + 1 >= env.MAX_FAILED_LOGINS;
    await query(
      `UPDATE users SET failed_login_count = $2, locked_until = $3 WHERE id = $1`,
      [u.id, lock ? 0 : u.failed_login_count + 1, lock ? new Date(Date.now() + env.LOCKOUT_MINUTES * 60_000) : null],
    );
    await audit({ orgId: u.org_id, actor: { id: u.id, email: u.email }, action: 'auth.login_failed', entityType: 'user', entityId: u.id, req });
    throw genericFail;
  }
  if (u.status !== 'active') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is not active. Please contact your administrator.');

  await query(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`, [u.id]);
  const { sid, refresh } = await createSession(u.id, req);
  const access = signAccess({ sub: u.id, sid });
  const csrf = randomToken(24);
  setAuthCookies(res, access, refresh, csrf);
  await audit({ orgId: u.org_id, actor: { id: u.id, email: u.email }, action: 'auth.login', entityType: 'user', entityId: u.id, req });
  ok(res, { user: await profile(u.id), access_token: access, csrf_token: csrf });
}));

router.post('/refresh', wrap(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : null);
  if (!token) throw unauthorized();
  const next = randomToken(48);
  // Rotate atomically: a refresh token can only be used once.
  const s = await queryOne(
    `UPDATE auth_sessions SET refresh_token_hash = $2
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > now()
      RETURNING id, user_id`,
    [sha256(token), sha256(next)],
  );
  if (!s) { clearAuthCookies(res); throw unauthorized('Your session has expired. Please sign in again.'); }
  const u = await queryOne(`SELECT status FROM users WHERE id = $1 AND deleted_at IS NULL`, [s.user_id]);
  if (!u || u.status !== 'active') { clearAuthCookies(res); throw unauthorized(); }
  const access = signAccess({ sub: s.user_id, sid: s.id });
  const csrf = randomToken(24);
  setAuthCookies(res, access, next, csrf);
  ok(res, { access_token: access, refresh_token: undefined, csrf_token: csrf });
}));

router.post('/logout', wrap(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) await query(`UPDATE auth_sessions SET revoked_at = now() WHERE refresh_token_hash = $1`, [sha256(token)]);
  clearAuthCookies(res);
  ok(res, { signed_out: true });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const me = await profile(req.user!.id);
  ok(res, { ...me, active_org_id: req.orgId ?? null });
}));

router.post('/change-password', authenticate, wrap(async (req, res) => {
  const body = parse(z.object({ current_password: z.string().min(1), new_password: z.string() }), req.body);
  const problem = passwordProblem(body.new_password);
  if (problem) throw badRequest(problem);
  const u = await queryOne(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
  if (!u || !(await verifyPassword(body.current_password, u.password_hash))) throw new AppError(400, 'INVALID_CREDENTIALS', 'Your current password is incorrect.');
  await query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [req.user!.id, await hashPassword(body.new_password)]);
  // Sign out every other device.
  await query(`UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [req.user!.id, req.user!.sessionId]);
  await audit({ orgId: req.user!.userOrgId, actor: req.user, action: 'auth.password_changed', entityType: 'user', entityId: req.user!.id, req });
  ok(res, { changed: true });
}));

export default router;
