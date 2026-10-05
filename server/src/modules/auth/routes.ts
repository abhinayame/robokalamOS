import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isProd } from '../../config/env.js';
import { exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, unauthorized } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { verifyAccess,
  hashPassword, passwordProblem, randomToken, sha256, signAccess, verifyPassword,
} from '../../lib/security.js';
import { ACCESS_COOKIE, authenticate } from '../../middleware/auth.js';
import { limit } from '../../middleware/limits.js';
import { appUrl } from '../../lib/appurl.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { queueMessage } from '../email/outbox.js';
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
  const sid = newId();
  await exec(
    `INSERT INTO auth_sessions (id, user_id, refresh_token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, DATE_ADD(NOW(3), INTERVAL $6 DAY))`,
    [sid, userId, sha256(refresh), req.get('user-agent')?.slice(0, 300) ?? null, req.ip ?? null, env.REFRESH_TOKEN_TTL_DAYS],
  );
  return { sid, refresh };
}

async function profile(userId: string) {
  const u = await queryOne(
    `SELECT u.id, u.email, u.full_name, u.mobile, u.org_id, u.must_change_password,
            o.name AS org_name, o.slug AS org_slug, o.code_prefix
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`,
    [userId],
  );
  const roles = await query(
    `SELECT r.code, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`,
    [userId],
  );
  const perms = await query(
    `SELECT DISTINCT p.code FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
       JOIN permissions p ON p.id = rp.permission_id WHERE ur.user_id = $1 ORDER BY 1`,
    [userId],
  );
  return {
    id: u!.id, email: u!.email, full_name: u!.full_name, mobile: u!.mobile,
    organization: u!.org_id ? { id: u!.org_id, name: u!.org_name, slug: u!.org_slug, code_prefix: u!.code_prefix } : null,
    must_change_password: u!.must_change_password,
    roles: [...new Set(roles.map((r) => r.code))],
    branch_ids: roles.filter((r) => r.branch_id).map((r) => r.branch_id),
    permissions: perms.map((p) => p.code),
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
    await exec(
      `UPDATE users SET failed_login_count = $2, locked_until = $3 WHERE id = $1`,
      [u.id, lock ? 0 : u.failed_login_count + 1, lock ? new Date(Date.now() + env.LOCKOUT_MINUTES * 60_000) : null],
    );
    await audit({ orgId: u.org_id, actor: { id: u.id, email: u.email }, action: 'auth.login_failed', entityType: 'user', entityId: u.id, req });
    throw genericFail;
  }
  if (u.status !== 'active') throw new AppError(403, 'ACCOUNT_DISABLED', 'This account is not active. Please contact your administrator.');

  await exec(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = NOW(3) WHERE id = $1`, [u.id]);
  const { sid, refresh } = await createSession(u.id, req);
  const access = signAccess({ sub: u.id, sid });
  const csrf = randomToken(24);
  setAuthCookies(res, access, refresh, csrf);
  await audit({ orgId: u.org_id, actor: { id: u.id, email: u.email }, action: 'auth.login', entityType: 'user', entityId: u.id, req });
  ok(res, { user: await profile(u.id), access_token: access, csrf_token: csrf });
}));

router.post('/refresh', limit('refresh', 60), wrap(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : null);
  if (!token) throw unauthorized();
  const next = randomToken(48);
  // Rotate atomically: a refresh token can only be used once.
  const rotated = await exec(
    `UPDATE auth_sessions SET refresh_token_hash = $2
      WHERE refresh_token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW(3)`,
    [sha256(token), sha256(next)],
  );
  const s = rotated.affectedRows === 1
    ? await queryOne(`SELECT id, user_id FROM auth_sessions WHERE refresh_token_hash = $1`, [sha256(next)])
    : null;
  if (!s) { clearAuthCookies(res); throw unauthorized('Your session has expired. Please sign in again.'); }
  const u = await queryOne(`SELECT status FROM users WHERE id = $1 AND deleted_at IS NULL`, [s.user_id]);
  if (!u || u.status !== 'active') { clearAuthCookies(res); throw unauthorized(); }
  const access = signAccess({ sub: s.user_id, sid: s.id });
  const csrf = randomToken(24);
  setAuthCookies(res, access, next, csrf);
  ok(res, { access_token: access, refresh_token: undefined, csrf_token: csrf });
}));

router.post('/logout', wrap(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE] ?? (typeof req.body?.refresh_token === 'string' ? req.body.refresh_token : null);
  if (token) await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE refresh_token_hash = $1`, [sha256(token)]);
  // A token-only client (no cookies) ends its session through the access token it is holding.
  const bearer = req.get('authorization')?.startsWith('Bearer ') ? verifyAccess(req.get('authorization')!.slice(7)) : null;
  if (bearer) await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE id = $1 AND user_id = $2`, [bearer.sid, bearer.sub]);
  clearAuthCookies(res);
  ok(res, { signed_out: true });
}));

router.get('/me', authenticate, wrap(async (req, res) => {
  const me = await profile(req.user!.id);
  ok(res, { ...me, active_org_id: req.orgId ?? null });
}));

router.post('/change-password', authenticate, limit('password change', 10), wrap(async (req, res) => {
  const body = parse(z.object({ current_password: z.string().min(1), new_password: z.string() }), req.body);
  const problem = passwordProblem(body.new_password);
  if (problem) throw badRequest(problem);
  const u = await queryOne(`SELECT password_hash FROM users WHERE id = $1`, [req.user!.id]);
  if (!u || !(await verifyPassword(body.current_password, u.password_hash))) throw new AppError(400, 'INVALID_CREDENTIALS', 'Your current password is incorrect.');
  await exec(`UPDATE users SET password_hash = $2, must_change_password = FALSE WHERE id = $1`, [req.user!.id, await hashPassword(body.new_password)]);
  // Sign out every other device.
  await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [req.user!.id, req.user!.sessionId]);
  await audit({ orgId: req.user!.userOrgId, actor: req.user, action: 'auth.password_changed', entityType: 'user', entityId: req.user!.id, req });
  ok(res, { changed: true });
}));

// ---- Password reset by e-mail (only when e-mail is configured) ----
const RESET_MINUTES = 30;
router.get('/capabilities', (_req, res) => { ok(res, { password_reset: emailConfigured() }); });

router.post('/forgot-password', limit('password reset', 5), wrap(async (req, res) => {
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email() }), req.body);
  // The answer is always the same, so nobody can use this to find out who has an account.
  const reply = () => ok(res, { sent: true });
  if (!emailConfigured()) return reply();
  const u = await queryOne(
    `SELECT u.id, u.org_id, u.email, u.full_name, u.status, o.name AS org_name, o.brand_app_name, o.brand_color
       FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE lower(u.email) = $1 AND u.deleted_at IS NULL`, [body.email]);
  if (!u || u.status !== 'active') return reply();
  const recent = await queryOne(`SELECT COUNT(*) AS n FROM password_resets WHERE user_id = $1 AND created_at > DATE_SUB(NOW(3), INTERVAL 1 HOUR)`, [u.id]);
  if (Number(recent?.n ?? 0) >= 3) return reply();
  const token = randomToken(32);
  await exec(`UPDATE password_resets SET used_at = NOW(3) WHERE user_id = $1 AND used_at IS NULL`, [u.id]);
  await exec(`INSERT INTO password_resets (id, user_id, token_hash, expires_at, requested_ip) VALUES ($1,$2,$3, DATE_ADD(NOW(3), INTERVAL ${RESET_MINUTES} MINUTE), $4)`, [newId(), u.id, sha256(token), req.ip ?? null]);
  await queueMessage({ orgId: u.org_id, orgName: u.brand_app_name || u.org_name || 'Learner OS', color: u.brand_color ?? undefined, to: u.email, toName: u.full_name,
    subject: 'Reset your password', paragraphs: [`Hi ${u.full_name}, we got a request to reset your password.`, `This link works once and expires in ${RESET_MINUTES} minutes. If you did not ask for it, you can ignore this e-mail; your password stays the same.`],
    button: { label: 'Choose a new password', url: `${appUrl()}/reset-password?token=${token}` }, category: 'transactional' });
  await audit({ orgId: u.org_id, action: 'auth.password_reset_requested', entityType: 'user', entityId: u.id, req });
  reply();
}));

const resetRow = (token: string) => queryOne(
  `SELECT id, user_id FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW(3)`, [sha256(token)]);

router.get('/reset-password/check', limit('password reset', 20), wrap(async (req, res) => {
  const t = typeof req.query.token === 'string' ? req.query.token : '';
  ok(res, { valid: t.length >= 20 && t.length <= 200 && !!(await resetRow(t)) });
}));

router.post('/reset-password', limit('password reset', 10), wrap(async (req, res) => {
  const body = parse(z.object({ token: z.string().min(20).max(200), new_password: z.string() }), req.body);
  const problem = passwordProblem(body.new_password);
  if (problem) throw badRequest(problem);
  const r = await resetRow(body.token);
  if (!r) throw new AppError(400, 'RESET_INVALID', 'This link has expired or was already used. Ask for a new one.');
  // Claim the token first, so two clicks cannot both succeed.
  const claim = await exec(`UPDATE password_resets SET used_at = NOW(3) WHERE id = $1 AND used_at IS NULL`, [r.id]);
  if (!claim.affectedRows) throw new AppError(400, 'RESET_INVALID', 'This link has expired or was already used. Ask for a new one.');
  await exec(`UPDATE users SET password_hash = $2, must_change_password = FALSE, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [r.user_id, await hashPassword(body.new_password)]);
  await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL`, [r.user_id]);
  await exec(`UPDATE password_resets SET used_at = COALESCE(used_at, NOW(3)) WHERE user_id = $1`, [r.user_id]);
  const u = await queryOne(`SELECT u.org_id, u.email, u.full_name, o.name AS org_name, o.brand_app_name, o.brand_color FROM users u LEFT JOIN organizations o ON o.id = u.org_id WHERE u.id = $1`, [r.user_id]);
  await audit({ orgId: u?.org_id ?? null, action: 'auth.password_reset_done', entityType: 'user', entityId: r.user_id, req });
  if (u) await queueMessage({ orgId: u.org_id, orgName: u.brand_app_name || u.org_name || 'Learner OS', color: u.brand_color ?? undefined, to: u.email, toName: u.full_name, subject: 'Your password was changed',
    paragraphs: ['Your password was just changed and you were signed out on all devices.', 'If this was not you, contact your school right away.'], category: 'transactional' });
  ok(res, { reset: true });
}));

export default router;
