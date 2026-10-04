import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';

const router = Router();


const code = z.string().trim().toUpperCase().regex(/^[A-Z0-9][A-Z0-9_-]{0,19}$/, 'Use letters, numbers, dash or underscore (max 20).');
const status = z.enum(['active', 'inactive', 'archived']);

function crud(table: 'branches' | 'programs' | 'courses', label: string, extra: {
  cols: string[]; create: z.ZodObject<any>; update: z.ZodObject<any>; select: string; joins?: string;
}) {
  const base = router;
  const path = `/${table}`;
  base.get(path, requireOrg, requirePerm('catalog:read'), wrap(async (req, res) => {
    const q = parse(z.object({ status: status.optional(), program_id: uuid.optional(), include_archived: z.coerce.boolean().optional() }), req.query);
    const params: unknown[] = [orgIdOf(req)];
    let where = `t.org_id = $1 AND t.deleted_at IS NULL`;
    if (q.status) { params.push(q.status); where += ` AND t.status = $${params.length}`; }
    else if (!q.include_archived) where += ` AND t.status <> 'archived'`;
    if (q.program_id && table === 'courses') { params.push(q.program_id); where += ` AND t.program_id = $${params.length}`; }
    const rows = await query(`SELECT ${extra.select} FROM ${table} t ${extra.joins ?? ''} WHERE ${where} ORDER BY t.name`, params);
    ok(res, rows);
  }));

  base.post(path, requireOrg, requirePerm(table === 'branches' ? 'branch:manage' : 'catalog:manage'), wrap(async (req, res) => {
    const body = parse(extra.create, req.body) as Record<string, unknown>;
    const cols = ['org_id', ...extra.cols];
    const vals = [orgIdOf(req), ...extra.cols.map((c) => body[c] ?? null)];
    if (table === 'courses') {
      const prog = await queryOne(`SELECT 1 FROM programs WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [body.program_id, orgIdOf(req)]);
      if (!prog) throw notFound('Program');
    }
    let row;
    try {
      row = await queryOne(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, vals);
    } catch (e: any) {
      if (e.code === '23505') throw conflict(`A ${label} with this code already exists.`, 'DUPLICATE');
      throw e;
    }
    await audit({ orgId: orgIdOf(req), actor: req.user, action: `${label}.created`, entityType: label, entityId: row!.id, next: row, req });
    ok(res, row, undefined, 201);
  }));

  base.patch(`${path}/:id`, requireOrg, requirePerm(table === 'branches' ? 'branch:manage' : 'catalog:manage'), wrap(async (req, res) => {
    const id = parse(uuid, req.params.id);
    const body = parse(extra.update, req.body) as Record<string, unknown>;
    const keys = Object.keys(body).filter((k) => body[k] !== undefined);
    if (!keys.length) return ok(res, await queryOne(`SELECT * FROM ${table} WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]));
    const prev = await queryOne(`SELECT * FROM ${table} WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [id, orgIdOf(req)]);
    if (!prev) throw notFound(label);
    let row;
    try {
      row = await queryOne(
        `UPDATE ${table} SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(',')} WHERE id = $1 AND org_id = $2 RETURNING *`,
        [id, orgIdOf(req), ...keys.map((k) => body[k])]);
    } catch (e: any) {
      if (e.code === '23505') throw conflict(`A ${label} with this code already exists.`, 'DUPLICATE');
      throw e;
    }
    await audit({ orgId: orgIdOf(req), actor: req.user, action: `${label}.updated`, entityType: label, entityId: id, previous: prev, next: row, req });
    ok(res, row);
  }));
}

crud('branches', 'branch', {
  cols: ['name', 'code', 'city', 'address'],
  create: z.object({ name: z.string().trim().min(2).max(120), code, city: z.string().trim().max(80).optional(), address: z.string().trim().max(300).optional() }),
  update: z.object({ name: z.string().trim().min(2).max(120).optional(), city: z.string().trim().max(80).optional(), address: z.string().trim().max(300).optional(), status: status.optional() }),
  select: 't.id, t.name, t.code, t.city, t.address, t.status',
});
crud('programs', 'program', {
  cols: ['name', 'code', 'description'],
  create: z.object({ name: z.string().trim().min(2).max(120), code, description: z.string().trim().max(1000).optional() }),
  update: z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(1000).optional(), status: status.optional() }),
  select: 't.id, t.name, t.code, t.description, t.status',
});
crud('courses', 'course', {
  cols: ['program_id', 'name', 'code', 'description'],
  create: z.object({ program_id: uuid, name: z.string().trim().min(2).max(120), code, description: z.string().trim().max(1000).optional() }),
  update: z.object({ name: z.string().trim().min(2).max(120).optional(), description: z.string().trim().max(1000).optional(), status: status.optional() }),
  select: 't.id, t.name, t.code, t.description, t.status, t.program_id, p.name AS program_name',
  joins: 'JOIN programs p ON p.id = t.program_id',
});

export default router;
