import { Router } from 'express';
import { z } from 'zod';
import { Params, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { normalizeMobile } from '../../lib/phone.js';
import { learnerScope } from '../../lib/scope.js';
import { generatePassword, hashPassword, passwordProblem } from '../../lib/security.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';

const router = Router();
router.use(requireOrg);

/** Parents are visible when at least one linked child is within the caller's scope (or caller is org-wide). */
router.get('/', requirePerm('parent:read'), wrap(async (req, res) => {
  const q = parse(paging.extend({ q: z.string().trim().max(100).optional() }), req.query);
  const p = new Params();
  const where = [`pa.org_id = ${p.add(orgIdOf(req))}`, 'pa.deleted_at IS NULL'];
  const scope = learnerScope(req.user!, p, 'l');
  if (scope) where.push(`EXISTS (SELECT 1 FROM learner_parents lp JOIN learners l ON l.id = lp.learner_id WHERE lp.parent_id = pa.id AND l.deleted_at IS NULL AND ${scope})`);
  if (q.q) { const s = p.add(`%${q.q}%`); where.push(`(pa.full_name ILIKE ${s} OR pa.mobile ILIKE ${s} OR pa.email ILIKE ${s})`); }
  const total = (await queryOne(`SELECT count(*) AS n FROM parents pa WHERE ${where.join(' AND ')}`, p.values))!.n;
  const rows = await query(
    `SELECT pa.id, pa.full_name, pa.mobile, pa.email, (pa.user_id IS NOT NULL) AS has_login,
            (SELECT json_agg(json_build_object('id', l.id, 'full_name', l.full_name, 'learner_code', l.learner_code) ORDER BY l.full_name)
               FROM learner_parents lp JOIN learners l ON l.id = lp.learner_id WHERE lp.parent_id = pa.id AND l.deleted_at IS NULL) AS children
       FROM parents pa WHERE ${where.join(' AND ')} ORDER BY lower(pa.full_name), pa.id
      LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows.map((r) => ({ ...r, children: r.children ?? [] })), { page: q.page, page_size: q.page_size, total });
}));

async function scopedParent(req: any, id: string) {
  const p = new Params();
  const scope = learnerScope(req.user, p, 'l');
  const row = await queryOne(
    `SELECT pa.* FROM parents pa WHERE pa.id = ${p.add(id)} AND pa.org_id = ${p.add(orgIdOf(req))} AND pa.deleted_at IS NULL
       ${scope ? `AND EXISTS (SELECT 1 FROM learner_parents lp JOIN learners l ON l.id = lp.learner_id WHERE lp.parent_id = pa.id AND ${scope})` : ''}`, p.values);
  if (!row) throw notFound('Parent');
  return row;
}

router.get('/:id', requirePerm('parent:read'), wrap(async (req, res) => {
  const pa = await scopedParent(req, parse(uuid, req.params.id));
  const p = new Params();
  const scope = learnerScope(req.user!, p, 'l');
  const children = await query(
    `SELECT l.id, l.learner_code, l.full_name, l.status, lp.relationship, lp.is_primary,
            (SELECT count(*) FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active') AS active_batches
       FROM learner_parents lp JOIN learners l ON l.id = lp.learner_id
      WHERE lp.parent_id = ${p.add(pa.id)} AND l.deleted_at IS NULL ${scope ? `AND ${scope}` : ''} ORDER BY l.full_name`, p.values);
  const { user_id, ...rest } = pa;
  ok(res, { ...rest, has_login: !!user_id, children });
}));

router.patch('/:id', requirePerm('parent:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    full_name: z.string().trim().min(2).max(120).optional(),
    mobile: z.string().trim().nullable().optional(),
    email: z.string().trim().toLowerCase().email().nullable().optional(),
  }), req.body);
  const prev = await scopedParent(req, id);
  let mobile: string | null | undefined;
  if (body.mobile !== undefined) {
    mobile = body.mobile ? normalizeMobile(body.mobile) : null;
    if (body.mobile && !mobile) throw badRequest('Enter a valid 10 digit mobile number.');
    if (mobile && await queryOne(`SELECT 1 FROM parents WHERE org_id = $1 AND mobile = $2 AND deleted_at IS NULL AND id <> $3`, [orgIdOf(req), mobile, id])) {
      throw conflict('Another parent already uses this mobile number.', 'DUPLICATE');
    }
  }
  const row = await tx(async (db) => {
    const r = await queryOne(
      `UPDATE parents SET full_name = COALESCE($3, full_name), mobile = CASE WHEN $4::boolean THEN $5 ELSE mobile END,
              email = CASE WHEN $6::boolean THEN $7 ELSE email END WHERE id = $1 AND org_id = $2 RETURNING id, full_name, mobile, email`,
      [id, orgIdOf(req), body.full_name ?? null, mobile !== undefined, mobile ?? null, body.email !== undefined, body.email ?? null], db);
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'parent.updated', entityType: 'parent', entityId: id, previous: { full_name: prev.full_name, mobile: prev.mobile, email: prev.email }, next: r, req }, db);
    return r;
  });
  ok(res, row);
}));

router.post('/:id/login', requirePerm('learner:login'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email().optional(), password: z.string().optional() }), req.body ?? {});
  const pa = await scopedParent(req, id);
  if (pa.user_id) throw conflict('This parent already has a login.', 'LOGIN_EXISTS');
  const email = body.email ?? pa.email;
  if (!email) throw badRequest('Add an email address for the parent first.');
  const password = body.password ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(password);
  await tx(async (db) => {
    if (await queryOne(`SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email], db)) throw conflict('A user with this email already exists.', 'DUPLICATE');
    const u = await queryOne(`INSERT INTO users (org_id, email, mobile, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgIdOf(req), email, pa.mobile, hash, pa.full_name, !body.password], db);
    await query(`INSERT INTO user_roles (user_id, role_id, org_id) SELECT $1, id, $2 FROM roles WHERE key = 'parent'`, [u!.id, orgIdOf(req)], db);
    await query(`UPDATE parents SET user_id = $2, email = COALESCE(email, $3) WHERE id = $1`, [id, u!.id, email], db);
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'parent.login_created', entityType: 'parent', entityId: id, next: { email }, req }, db);
  });
  ok(res, { email, ...(body.password ? {} : { temporary_password: password }) }, undefined, 201);
}));

export default router;
