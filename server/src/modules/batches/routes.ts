import { Router } from 'express';
import { z } from 'zod';
import { Params, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { nextBatchCode } from '../../lib/codes.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { csvList, ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { batchScope, canWriteBranch, learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { enrollLearners, removeLearners } from './enrollment.js';
import { MEMBERSHIP_STATUSES } from '../learners/filters.js';

const router = Router();
router.use(requireOrg);

const BATCH_STATUSES = ['upcoming', 'active', 'completed', 'archived'] as const;
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h).');
const scheduleSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),   // 0 = Sunday
  start: time.optional(),
  end: time.optional(),
  mode: z.enum(['online', 'offline', 'hybrid']).default('offline'),
  venue: z.string().max(200).optional(),
}).refine((s) => !s.start || !s.end || s.end > s.start, { message: 'End time must be after start time.' });
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const batchFields = z.object({
  name: z.string().trim().min(2).max(120),
  branch_id: uuid.nullish(),
  program_id: uuid,
  course_id: uuid,
  academic_year: z.string().trim().regex(/^\d{4}(-\d{2})?$/, 'Use 2026 or 2026-27.'),
  start_date: dateStr.nullish(),
  end_date: dateStr.nullish(),
  schedule: scheduleSchema.optional(),
  capacity: z.number().int().min(1).max(10000).nullish(),
  status: z.enum(BATCH_STATUSES).optional(),
});

const BATCH_SELECT = `
  b.id, b.batch_code, b.name, b.status, b.academic_year, b.start_date, b.end_date, b.schedule, b.capacity, b.created_at,
  b.branch_id, br.name AS branch_name, b.program_id, pr.name AS program_name, b.course_id, c.name AS course_name,
  (SELECT count(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS active_learners,
  (SELECT count(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id) AS total_memberships,
  (SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name, 'role', t.role) ORDER BY t.role, u.full_name)
     FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id WHERE t.batch_id = b.id AND t.status = 'active') AS teachers`;
const BATCH_FROM = `FROM batches b JOIN programs pr ON pr.id = b.program_id JOIN courses c ON c.id = b.course_id LEFT JOIN branches br ON br.id = b.branch_id`;

async function validateCatalog(db: Db, orgId: string, f: { branch_id?: string | null; program_id: string; course_id: string }) {
  const c = await queryOne(`SELECT program_id FROM courses WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [f.course_id, orgId], db);
  if (!c) throw badRequest('Unknown course.');
  if (c.program_id !== f.program_id) throw badRequest('That course does not belong to the selected program.');
  if (f.branch_id && !(await queryOne(`SELECT 1 FROM branches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [f.branch_id, orgId], db))) throw badRequest('Unknown branch.');
}

// ------------------------------------------------------------------ list
router.get('/', requireAnyPerm('batch:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const q = parse(paging.extend({
    q: z.string().trim().max(100).optional(),
    status: csvList(z.enum(BATCH_STATUSES)),
    course_id: csvList(uuid), program_id: csvList(uuid), branch_id: csvList(uuid), teacher_id: csvList(uuid),
    academic_year: csvList(z.string().max(20)),
    sort: z.enum(['name', 'batch_code', 'start_date', 'created_at', 'active_learners', 'status']).default('name'),
    include_archived: z.coerce.boolean().optional(),
  }), req.query);
  const p = new Params();
  const where = [`b.org_id = ${p.add(orgIdOf(req))}`, 'b.deleted_at IS NULL'];
  const scope = batchScope(req.user!, p, 'b');
  if (scope) where.push(scope);
  if (q.status?.length) where.push(`b.status = ANY(${p.add(q.status)}::text[])`);
  else if (!q.include_archived) where.push(`b.status <> 'archived'`);
  if (q.course_id) where.push(`b.course_id = ANY(${p.add(q.course_id)}::uuid[])`);
  if (q.program_id) where.push(`b.program_id = ANY(${p.add(q.program_id)}::uuid[])`);
  if (q.branch_id) where.push(`b.branch_id = ANY(${p.add(q.branch_id)}::uuid[])`);
  if (q.academic_year) where.push(`b.academic_year = ANY(${p.add(q.academic_year)}::text[])`);
  if (q.teacher_id) where.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = b.id AND t.status = 'active' AND t.teacher_user_id = ANY(${p.add(q.teacher_id)}::uuid[]))`);
  if (q.q) { const s = p.add(`%${q.q}%`); where.push(`(b.name ILIKE ${s} OR b.batch_code ILIKE ${s} OR c.name ILIKE ${s})`); }
  const sortSql = { name: 'lower(b.name)', batch_code: 'b.batch_code', start_date: 'b.start_date', created_at: 'b.created_at', active_learners: 'active_learners', status: 'b.status' }[q.sort];
  const total = (await queryOne(`SELECT count(*) AS n ${BATCH_FROM} WHERE ${where.join(' AND ')}`, p.values))!.n;
  const rows = await query(
    `SELECT ${BATCH_SELECT} ${BATCH_FROM} WHERE ${where.join(' AND ')}
      ORDER BY ${sortSql} ${q.order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, b.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows.map((r) => ({ ...r, teachers: r.teachers ?? [] })), { page: q.page, page_size: q.page_size, total });
}));

// ------------------------------------------------------------------ detail
async function loadBatch(req: any, id: string) {
  const p = new Params();
  const scope = batchScope(req.user, p, 'b');
  const row = await queryOne(
    `SELECT ${BATCH_SELECT} ${BATCH_FROM} WHERE b.id = ${p.add(id)} AND b.org_id = ${p.add(orgIdOf(req))} AND b.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}`, p.values);
  if (!row) throw notFound('Batch');
  return { ...row, teachers: row.teachers ?? [] };
}

router.get('/:id', requireAnyPerm('batch:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const b = await loadBatch(req, parse(uuid, req.params.id));
  const stats = await queryOne(
    `SELECT count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'left') AS left,
            count(*) FILTER (WHERE status = 'transferred') AS transferred, count(*) FILTER (WHERE status = 'completed') AS completed
       FROM learner_batch_memberships WHERE batch_id = $1`, [b.id]);
  ok(res, { ...b, membership_stats: stats });
}));

// People tab: learners in the batch (paged, learners/parents never see this list)
router.get('/:id/learners', requirePerm('batch:read'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  await loadBatch(req, id);
  const q = parse(paging.extend({ q: z.string().trim().max(100).optional(), status: csvList(z.enum(MEMBERSHIP_STATUSES)) }), req.query);
  const p = new Params();
  const where = [`m.batch_id = ${p.add(id)}`, `m.org_id = ${p.add(orgIdOf(req))}`, 'l.deleted_at IS NULL', `m.status = ANY(${p.add(q.status?.length ? q.status : ['active'])}::text[])`];
  const scope = learnerScope(req.user!, p, 'l');
  if (scope) where.push(scope);
  if (q.q) { const s = p.add(`%${q.q}%`); where.push(`(l.full_name ILIKE ${s} OR l.learner_code ILIKE ${s} OR l.mobile ILIKE ${s})`); }
  const total = (await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id WHERE ${where.join(' AND ')}`, p.values))!.n;
  const rows = await query(
    `SELECT l.id, l.learner_code, l.full_name, l.mobile, l.status AS learner_status, m.status AS membership_status, m.joined_at, m.left_at, m.left_reason,
            (SELECT count(*) FROM learner_batch_memberships o WHERE o.learner_id = l.id AND o.status = 'active') AS total_active_batches
       FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id
      WHERE ${where.join(' AND ')} ORDER BY lower(l.full_name), l.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows, { page: q.page, page_size: q.page_size, total });
}));

// ------------------------------------------------------------------ create / update
router.post('/', requirePerm('batch:create'), wrap(async (req, res) => {
  const body = parse(batchFields.extend({ teacher_id: uuid.optional() }), req.body);
  const orgId = orgIdOf(req);
  const branchId = body.branch_id ?? (req.user!.access.orgWide ? null : req.user!.access.branchIds[0] ?? null);
  if (!canWriteBranch(req.user!, branchId)) throw forbidden('You can only create batches in your own branch.');
  const id = await tx(async (db) => {
    await validateCatalog(db, orgId, { ...body, branch_id: branchId });
    const org = await queryOne(`SELECT code_prefix FROM organizations WHERE id = $1`, [orgId], db);
    const code = await nextBatchCode(db, orgId, org!.code_prefix);
    const b = await queryOne(
      `INSERT INTO batches (org_id, branch_id, program_id, course_id, batch_code, name, academic_year, start_date, end_date, schedule, capacity, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
      [orgId, branchId, body.program_id, body.course_id, code, body.name, body.academic_year, body.start_date ?? null, body.end_date ?? null,
        JSON.stringify(body.schedule ?? { days: [], mode: 'offline' }), body.capacity ?? null, body.status ?? 'upcoming', req.user!.id], db);
    if (body.teacher_id) await assignTeacher(db, req, b!.id, body.teacher_id, 'lead');
    await audit({ orgId, actor: req.user, action: 'batch.created', entityType: 'batch', entityId: b!.id, next: { batch_code: code, name: body.name }, req }, db);
    return b!.id as string;
  });
  ok(res, await loadBatch(req, id), undefined, 201);
}));

router.patch('/:id', requirePerm('batch:update'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(batchFields.partial(), req.body);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const prev = await queryOne(`SELECT * FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, orgId], db);
    if (!prev) throw notFound('Batch');
    if (!canWriteBranch(req.user!, prev.branch_id)) throw forbidden('This batch belongs to a branch you do not manage.');
    if (body.branch_id !== undefined && !canWriteBranch(req.user!, body.branch_id ?? null)) throw forbidden('You cannot move a batch to that branch.');
    const merged = { branch_id: body.branch_id !== undefined ? body.branch_id : prev.branch_id, program_id: body.program_id ?? prev.program_id, course_id: body.course_id ?? prev.course_id };
    if (body.program_id || body.course_id || body.branch_id) await validateCatalog(db, orgId, merged);
    if (body.capacity != null) {
      const cur = (await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [id], db))!.n as number;
      if (body.capacity < cur) throw conflict(`This batch already has ${cur} active learners. Capacity cannot be lower.`, 'CAPACITY_TOO_LOW');
    }
    const fields: Record<string, unknown> = { ...body };
    if (body.schedule) fields.schedule = JSON.stringify(body.schedule);
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return;
    const next = await queryOne(`UPDATE batches SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`, [id, orgId, ...keys.map((k) => fields[k])], db);
    const changed = keys.filter((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next![k] ?? null) && String(prev[k]) !== String(next![k]));
    await audit({ orgId, actor: req.user, action: body.status && body.status !== prev.status ? 'batch.status_changed' : 'batch.updated', entityType: 'batch', entityId: id,
      previous: Object.fromEntries(changed.map((k) => [k, prev[k]])), next: Object.fromEntries(changed.map((k) => [k, next![k]])), req }, db);
  });
  ok(res, await loadBatch(req, id));
}));

// ------------------------------------------------------------------ learner memberships
const learnerIdsBody = z.object({ learner_ids: z.array(uuid).min(1).max(2000) });

router.post('/:id/learners', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { learner_ids } = parse(learnerIdsBody, req.body);
  await loadBatch(req, id);
  const result = await tx((db) => enrollLearners({ db, user: req.user!, orgId: orgIdOf(req), req }, id, learner_ids));
  ok(res, { ...result, batch: await loadBatch(req, id) }, undefined, 201);
}));

router.delete('/:id/learners', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { learner_ids, reason } = parse(learnerIdsBody.extend({ reason: z.string().max(200).optional() }), req.body);
  await loadBatch(req, id);
  const result = await tx((db) => removeLearners({ db, user: req.user!, orgId: orgIdOf(req), req }, id, learner_ids, { reason }));
  ok(res, { ...result, batch: await loadBatch(req, id) });
}));

// ------------------------------------------------------------------ teacher memberships
async function assignTeacher(db: Db, req: any, batchId: string, teacherId: string, role: 'lead' | 'co') {
  const orgId = orgIdOf(req);
  const teacher = await queryOne(
    `SELECT u.id, u.full_name FROM users u WHERE u.id = $1 AND u.org_id = $2 AND u.deleted_at IS NULL AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.key = 'teacher')`, [teacherId, orgId], db);
  if (!teacher) throw badRequest('That user is not an active teacher in this organization.');
  if (role === 'lead') {
    // Demote the current lead to co-teacher so history is kept and the one-lead rule holds.
    const cur = await queryOne(`SELECT teacher_user_id FROM teacher_batch_memberships WHERE batch_id = $1 AND role = 'lead' AND status = 'active' AND teacher_user_id <> $2`, [batchId, teacherId], db);
    if (cur) await query(`UPDATE teacher_batch_memberships SET role = 'co' WHERE batch_id = $1 AND teacher_user_id = $2`, [batchId, cur.teacher_user_id], db);
  }
  await query(
    `INSERT INTO teacher_batch_memberships (org_id, batch_id, teacher_user_id, role, assigned_by) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (batch_id, teacher_user_id) DO UPDATE SET role = EXCLUDED.role, status = 'active', removed_at = NULL, assigned_at = now(), assigned_by = EXCLUDED.assigned_by`,
    [orgId, batchId, teacherId, role, req.user.id], db);
  await audit({ orgId, actor: req.user, action: 'batch.teacher_assigned', entityType: 'batch', entityId: batchId, next: { teacher_id: teacherId, role }, req }, db);
  return teacher;
}

router.post('/:id/teachers', requirePerm('batch:assign_teacher'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { teacher_id, role } = parse(z.object({ teacher_id: uuid, role: z.enum(['lead', 'co']).default('co') }), req.body);
  await tx(async (db) => {
    const b = await queryOne(`SELECT branch_id, status FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, orgIdOf(req)], db);
    if (!b) throw notFound('Batch');
    if (!canWriteBranch(req.user!, b.branch_id)) throw forbidden('This batch belongs to a branch you do not manage.');
    if (b.status === 'archived') throw conflict('This batch is archived.', 'BATCH_CLOSED');
    await assignTeacher(db, req, id, teacher_id, role);
  });
  ok(res, await loadBatch(req, id), undefined, 201);
}));

router.delete('/:id/teachers/:teacherId', requirePerm('batch:assign_teacher'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const teacherId = parse(uuid, req.params.teacherId);
  await tx(async (db) => {
    const b = await queryOne(`SELECT branch_id FROM batches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, orgIdOf(req)], db);
    if (!b) throw notFound('Batch');
    if (!canWriteBranch(req.user!, b.branch_id)) throw forbidden('This batch belongs to a branch you do not manage.');
    const r = await query(`UPDATE teacher_batch_memberships SET status = 'removed', removed_at = now() WHERE batch_id = $1 AND teacher_user_id = $2 AND org_id = $3 AND status = 'active' RETURNING role`, [id, teacherId, orgIdOf(req)], db);
    if (!r.length) throw notFound('Teacher assignment');
    await audit({ orgId: orgIdOf(req), actor: req.user, action: 'batch.teacher_removed', entityType: 'batch', entityId: id, previous: { teacher_id: teacherId, role: r[0].role }, req }, db);
  });
  ok(res, await loadBatch(req, id));
}));

export default router;
