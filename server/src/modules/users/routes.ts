import { Router, type Request } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { normalizeMobile } from '../../lib/phone.js';
import { generatePassword, hashPassword, passwordProblem } from '../../lib/security.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';

/** Staff roles that can be granted through the API (learner/parent logins have their own endpoints). */
const STAFF_ROLES = ['org_admin', 'branch_admin', 'teacher', 'counsellor', 'accountant'] as const;
const roleGrant = z.object({ role: z.enum(STAFF_ROLES), branch_id: uuid.nullish() });

function assertCanGrant(req: Request, grants: z.infer<typeof roleGrant>[]) {
  const u = req.user!;
  if (u.isSuperAdmin || u.roles.includes('org_admin') && u.access.orgWide) return;
  // Branch admins may only create teachers / counsellors / accountants inside their own branches.
  for (const g of grants) {
    if (!['teacher', 'counsellor', 'accountant'].includes(g.role)) throw forbidden('You cannot grant that role.');
    if (g.role !== 'teacher' && (!g.branch_id || !u.access.branchIds.includes(g.branch_id))) {
      throw forbidden('You can only grant roles inside your own branch.');
    }
    if (g.branch_id && !u.access.branchIds.includes(g.branch_id)) throw forbidden('You can only grant roles inside your own branch.');
  }
}

async function validateBranches(orgId: string, grants: z.infer<typeof roleGrant>[]) {
  for (const g of grants) {
    if (g.role === 'branch_admin' && !g.branch_id) throw badRequest('A branch admin needs a branch.');
    if (g.branch_id && !(await queryOne(`SELECT 1 FROM branches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [g.branch_id, orgId]))) {
      throw badRequest('Unknown branch.');
    }
  }
}

const router = Router();
router.use(['/teachers', '/users'], requireOrg);

const userFields = `u.id, u.email, u.full_name, u.mobile, u.status, u.last_login_at, u.created_at,
  COALESCE((SELECT JSON_ARRAYAGG(JSON_OBJECT('role', r.code, 'branch_id', ur.branch_id))
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id), JSON_ARRAY()) AS roles`;

async function listStaff(req: Request, onlyRole?: string) {
  const q = parse(paging.extend({
    q: z.string().trim().max(100).optional(),
    status: z.enum(['active', 'disabled', 'invited']).optional(),
    role: z.enum(STAFF_ROLES).optional(),
  }), req.query);
  const p = new Params();
  const where = [`u.org_id = ${p.add(orgIdOf(req))}`, `u.deleted_at IS NULL`];
  const role = onlyRole ?? q.role;
  where.push(role
    ? `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = ${p.add(role)})`
    : `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code IN ${p.in(STAFF_ROLES)})`);
  if (q.status) where.push(`u.status = ${p.add(q.status)}`);
  if (q.q) { const s = p.add(`%${q.q}%`); where.push(`(u.full_name LIKE ${s} OR u.email LIKE ${s} OR u.mobile LIKE ${s})`); }
  const total = (await queryOne(`SELECT count(*) AS n FROM users u WHERE ${where.join(' AND ')}`, p.values))!.n;
  const rows = await query(
    `SELECT ${userFields},
            (SELECT count(*) FROM teacher_batch_memberships t WHERE t.teacher_user_id = u.id AND t.status = 'active') AS active_batches
       FROM users u WHERE ${where.join(' AND ')} ORDER BY u.full_name, u.id
      LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`,
    p.values,
  );
  return { rows, meta: { page: q.page, page_size: q.page_size, total } };
}

async function createStaff(req: Request, forceRole?: z.infer<typeof roleGrant>) {
  const body = parse(z.object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    mobile: z.string().optional(),
    password: z.string().optional(),
    roles: z.array(roleGrant).min(1).max(5).optional(),
  }), req.body);
  const grants = forceRole ? [forceRole] : body.roles;
  if (!grants) throw badRequest('Choose at least one role.');
  assertCanGrant(req, grants);
  await validateBranches(orgIdOf(req), grants);
  const mobile = body.mobile ? normalizeMobile(body.mobile) : null;
  if (body.mobile && !mobile) throw badRequest('Enter a valid 10 digit Indian mobile number.');
  const password = body.password ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(password);
  const user = await tx(async (db) => {
    if (await queryOne(`SELECT 1 FROM users WHERE email = $1 AND deleted_at IS NULL`, [body.email], db)) throw conflict('A user with this email already exists.', 'DUPLICATE');
    const id = newId();
    await exec(
      `INSERT INTO users (id, org_id, email, mobile, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, orgIdOf(req), body.email, mobile, hash, body.full_name, !body.password], db);
    for (const g of grants) {
      await exec(`INSERT INTO user_roles (id, user_id, role_id, org_id, branch_id) SELECT $1, $2, id, $3, $4 FROM roles WHERE code = $5`, [newId(), id, orgIdOf(req), g.branch_id ?? null, g.role], db);
    }
    const u = { id, email: body.email, full_name: body.full_name, mobile, status: 'active' };
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'user.created', entityType: 'user', entityId: id, next: { email: u.email, roles: grants }, req }, db);
    return u;
  });
  return { ...user, roles: grants, ...(body.password ? {} : { temporary_password: password }) };
}

// ---- Teachers ----
router.get('/teachers', requirePerm('teacher:read'), wrap(async (req, res) => {
  const { rows, meta } = await listStaff(req, 'teacher');
  ok(res, rows, meta);
}));
router.post('/teachers', requirePerm('user:manage'), wrap(async (req, res) => {
  ok(res, await createStaff(req, { role: 'teacher', branch_id: null }), undefined, 201);
}));
router.get('/teachers/:id', requirePerm('teacher:read'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const t = await queryOne(
    `SELECT ${userFields} FROM users u WHERE u.id = $1 AND u.org_id = $2 AND u.deleted_at IS NULL
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'teacher')`,
    [id, orgIdOf(req)]);
  if (!t) throw notFound('Teacher');
  const batches = await query(
    `SELECT b.id, b.batch_code, b.name, b.status, tm.role, tm.status AS assignment_status
       FROM teacher_batch_memberships tm JOIN batches b ON b.id = tm.batch_id
      WHERE tm.teacher_user_id = $1 AND tm.org_id = $2 ORDER BY tm.status, b.name`, [id, orgIdOf(req)]);
  ok(res, { ...t, batches });
}));

// ---- Staff users (any staff role) ----
router.get('/users', requirePerm('user:manage'), wrap(async (req, res) => {
  const { rows, meta } = await listStaff(req);
  ok(res, rows, meta);
}));
router.post('/users', requirePerm('user:manage'), wrap(async (req, res) => {
  ok(res, await createStaff(req), undefined, 201);
}));

router.patch('/users/:id', requirePerm('user:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({
    full_name: z.string().trim().min(2).max(120).optional(),
    mobile: z.string().nullable().optional(),
    status: z.enum(['active', 'disabled']).optional(),
  }), req.body);
  if (id === req.user!.id && body.status === 'disabled') throw badRequest('You cannot disable your own account.');
  const prev = await queryOne(`SELECT full_name, mobile, status FROM users WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgIdOf(req)]);
  if (!prev) throw notFound('User');
  let mobile: string | null | undefined = undefined;
  if (body.mobile !== undefined) {
    mobile = body.mobile ? normalizeMobile(body.mobile) : null;
    if (body.mobile && !mobile) throw badRequest('Enter a valid 10 digit Indian mobile number.');
  }
  const row = await tx(async (db) => {
    await exec(
      `UPDATE users SET full_name = COALESCE($3, full_name), mobile = CASE WHEN $4 THEN $5 ELSE mobile END, status = COALESCE($6, status)
        WHERE id = $1 AND org_id = $2`,
      [id, orgIdOf(req), body.full_name ?? null, mobile !== undefined, mobile ?? null, body.status ?? null], db);
    const r = await queryOne(`SELECT id, email, full_name, mobile, status FROM users WHERE id = $1`, [id], db);
    if (body.status === 'disabled') await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL`, [id], db);
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'user.updated', entityType: 'user', entityId: id, previous: prev, next: r, req }, db);
    return r;
  });
  ok(res, row);
}));

router.put('/users/:id/roles', requirePerm('user:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { roles } = parse(z.object({ roles: z.array(roleGrant).min(1).max(5) }), req.body);
  assertCanGrant(req, roles);
  await validateBranches(orgIdOf(req), roles);
  if (id === req.user!.id) throw badRequest('You cannot change your own roles.');
  const result = await tx(async (db) => {
    const target = await queryOne(`SELECT id FROM users WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, orgIdOf(req)], db);
    if (!target) throw notFound('User');
    const prev = await query(`SELECT r.code AS role, ur.branch_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [id], db);
    // Roles outside the staff set (learner/parent portal roles) are never touched here.
    const sp = new Params();
    await exec(`DELETE FROM user_roles WHERE user_id = ${sp.add(id)} AND role_id IN (SELECT id FROM roles WHERE code IN ${sp.in(STAFF_ROLES)})`, sp.values, db);
    for (const g of roles) {
      await exec(`INSERT INTO user_roles (id, user_id, role_id, org_id, branch_id) SELECT $1, $2, id, $3, $4 FROM roles WHERE code = $5`, [newId(), id, orgIdOf(req), g.branch_id ?? null, g.role], db);
    }
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'permission.changed', entityType: 'user', entityId: id, previous: prev, next: roles, req }, db);
    return roles;
  });
  ok(res, { id, roles: result });
}));

router.post('/users/:id/reset-password', requirePerm('user:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const u = await queryOne(`SELECT id FROM users WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgIdOf(req)]);
  if (!u) throw notFound('User');
  const pw = generatePassword();
  await tx(async (db) => {
    await exec(`UPDATE users SET password_hash = $2, must_change_password = TRUE, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [id, await hashPassword(pw)], db);
    await exec(`UPDATE auth_sessions SET revoked_at = NOW(3) WHERE user_id = $1 AND revoked_at IS NULL`, [id], db);
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'user.password_reset', entityType: 'user', entityId: id, req }, db);
  });
  ok(res, { id, temporary_password: pw });
}));

export default router;
