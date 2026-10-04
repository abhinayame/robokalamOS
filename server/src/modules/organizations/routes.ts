import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound, badRequest } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { generatePassword, hashPassword, passwordProblem } from '../../lib/security.js';
import { requireOrg, requirePerm, requireSuperAdmin } from '../../middleware/auth.js';

const router = Router();

const createSchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}$/, 'Use lower case letters, numbers and dashes.'),
  code_prefix: z.string().trim().toUpperCase().regex(/^[A-Z0-9]{2,6}$/).default('RK'),
  timezone: z.string().default('Asia/Kolkata'),
  admin: z.object({
    full_name: z.string().trim().min(2).max(120),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().optional(),
  }),
});

// Platform level: list / create organizations (super admin only)
router.get('/', requireSuperAdmin, wrap(async (req, res) => {
  const q = parse(paging.extend({ q: z.string().trim().max(100).optional() }), req.query);
  const where = q.q ? `AND (o.name LIKE $1 OR o.slug LIKE $1)` : '';
  const params: unknown[] = q.q ? [`%${q.q}%`] : [];
  const total = (await queryOne(`SELECT count(*) AS n FROM organizations o WHERE o.deleted_at IS NULL ${where}`, params))!.n;
  const rows = await query(
    `SELECT o.id, o.name, o.slug, o.code_prefix, o.status, o.timezone, o.created_at,
            (SELECT count(*) FROM learners l WHERE l.org_id = o.id AND l.deleted_at IS NULL) AS learners,
            (SELECT count(*) FROM batches b WHERE b.org_id = o.id AND b.deleted_at IS NULL) AS batches
       FROM organizations o WHERE o.deleted_at IS NULL ${where}
      ORDER BY o.name LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`,
    params,
  );
  ok(res, rows, { page: q.page, page_size: q.page_size, total });
}));

router.post('/', requireSuperAdmin, wrap(async (req, res) => {
  const body = parse(createSchema, req.body);
  const password = body.admin.password ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  const result = await tx(async (db) => {
    if (await queryOne(`SELECT 1 FROM organizations WHERE slug = $1`, [body.slug], db)) throw conflict('That organization URL name is taken.', 'DUPLICATE');
    const orgId = newId();
    await exec(
      `INSERT INTO organizations (id, name, slug, code_prefix, timezone) VALUES ($1,$2,$3,$4,$5)`,
      [orgId, body.name, body.slug, body.code_prefix, body.timezone], db,
    );
    const org = await queryOne(`SELECT id, name, slug, code_prefix, timezone, status, settings, created_at FROM organizations WHERE id = $1`, [orgId], db);
    const userId = newId();
    await exec(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, must_change_password)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, orgId, body.admin.email, await hashPassword(password), body.admin.full_name, !body.admin.password], db,
    );
    const user = { id: userId, email: body.admin.email, full_name: body.admin.full_name };
    await exec(
      `INSERT INTO user_roles (id, user_id, role_id, org_id) SELECT $1, $2, id, $3 FROM roles WHERE code = 'org_admin'`,
      [newId(), userId, orgId], db,
    );
    await audit({ orgId: org!.id, actor: req.user, action: 'organization.created', entityType: 'organization', entityId: org!.id, next: { name: org!.name, slug: org!.slug, admin: user!.email }, req }, db);
    return { org, user };
  });
  ok(res, {
    organization: result.org,
    admin: { ...result.user, ...(body.admin.password ? {} : { temporary_password: password }) },
  }, undefined, 201);
}));

// Tenant level: the caller's own organization
router.get('/current', requireOrg, wrap(async (req, res) => {
  const org = await queryOne(`SELECT id, name, slug, code_prefix, timezone, status, settings, created_at FROM organizations WHERE id = $1`, [req.orgId]);
  if (!org) throw notFound('Organization');
  ok(res, org);
}));

router.patch('/current', requireOrg, requirePerm('org:manage'), wrap(async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(2).max(120).optional(),
    timezone: z.string().optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }), req.body);
  const prev = await queryOne(`SELECT name, timezone, settings FROM organizations WHERE id = $1`, [req.orgId]);
  await exec(
    `UPDATE organizations SET name = COALESCE($2, name), timezone = COALESCE($3, timezone), settings = COALESCE($4, settings)
      WHERE id = $1`,
    [req.orgId, body.name ?? null, body.timezone ?? null, body.settings ? JSON.stringify(body.settings) : null],
  );
  const next = await queryOne(`SELECT id, name, slug, code_prefix, timezone, status, settings FROM organizations WHERE id = $1`, [req.orgId]);
  await audit({ orgId: req.orgId!, actor: req.user, action: 'organization.updated', entityType: 'organization', entityId: req.orgId, previous: prev, next: { name: next!.name, timezone: next!.timezone, settings: next!.settings }, req });
  ok(res, next);
}));

router.patch('/:id/status', requireSuperAdmin, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { status } = parse(z.object({ status: z.enum(['active', 'suspended', 'archived']) }), req.body);
  const upd = await exec(`UPDATE organizations SET status = $2 WHERE id = $1 AND deleted_at IS NULL`, [id, status]);
  if (!upd.affectedRows && !(await queryOne(`SELECT 1 FROM organizations WHERE id = $1 AND deleted_at IS NULL`, [id]))) throw notFound('Organization');
  const row = { id, status };
  await audit({ orgId: id, actor: req.user, action: 'organization.status_changed', entityType: 'organization', entityId: id, next: { status }, req });
  ok(res, row);
}));

export default router;
