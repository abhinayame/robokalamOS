import { Router, type Request } from 'express';
import { z } from 'zod';
import { Params, query, queryOne, tx, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { nextLearnerCode } from '../../lib/codes.js';
import { normalizeMobile } from '../../lib/phone.js';
import { canWriteBranch, learnerScope } from '../../lib/scope.js';
import { generatePassword, hashPassword, passwordProblem } from '../../lib/security.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf, requireAnyPerm, requireOrg, requirePerm } from '../../middleware/auth.js';
import { enrollLearners, removeLearners } from '../batches/enrollment.js';
import { linkParent, parentInput, upsertParent } from '../parents/service.js';
import { LEARNER_STATUSES, learnerFiltersQuery, learnerWhere } from './filters.js';

const router = Router();
router.use(requireOrg);

const SORTS: Record<string, string> = {
  name: 'lower(l.full_name)',
  learner_code: 'l.learner_code',
  enrolled_on: 'l.enrolled_on',
  created_at: 'l.created_at',
  status: 'l.status',
  last_activity: `(SELECT max(a.occurred_at) FROM learner_activity a WHERE a.learner_id = l.id)`,
  batches: `(SELECT count(*) FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active')`,
};

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

const learnerFields = z.object({
  full_name: z.string().trim().min(2, 'Enter the learner name.').max(120),
  mobile: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().toLowerCase().email('Enter a valid email.').optional().nullable().or(z.literal('').transform(() => null)),
  date_of_birth: dateStr.optional().nullable(),
  gender: z.enum(['female', 'male', 'other', 'undisclosed']).optional().nullable(),
  school: z.string().trim().max(200).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  photo_url: z.string().url().max(500).refine((u) => u.startsWith('https://'), 'Photo URL must use https.').optional().nullable(),
  branch_id: uuid.optional().nullable(),
  enrolled_on: dateStr.optional(),
});

// ---------------------------------------------------------------- helpers
async function assertBranch(db: Db, orgId: string, branchId: string | null | undefined) {
  if (!branchId) return;
  if (!(await queryOne(`SELECT 1 FROM branches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [branchId, orgId], db))) throw badRequest('Unknown branch.');
}

async function findDuplicate(db: Db, orgId: string, mobile: string | null, email: string | null, exceptId?: string) {
  if (mobile) {
    const d = await queryOne(`SELECT id, learner_code, full_name FROM learners WHERE org_id = $1 AND mobile = $2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [orgId, mobile, exceptId ?? null], db);
    if (d) return { field: 'mobile', existing: d };
  }
  if (email) {
    const d = await queryOne(`SELECT id, learner_code, full_name FROM learners WHERE org_id = $1 AND lower(email) = $2 AND deleted_at IS NULL AND ($3::uuid IS NULL OR id <> $3)`, [orgId, email, exceptId ?? null], db);
    if (d) return { field: 'email', existing: d };
  }
  return null;
}

/** Load one learner the caller may see (tenant + RBAC scope enforced in SQL). */
async function scopedLearner(req: Request, id: string, db: Db = undefined as any) {
  const p = new Params();
  const scope = learnerScope(req.user!, p, 'l');
  const row = await queryOne(
    `SELECT l.* FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}`,
    p.values, db,
  );
  if (!row) throw notFound('Learner');   // 404 (not 403) so other tenants'/learners' ids are not revealed
  return row;
}

function assertWritable(req: Request, branchId: string | null) {
  if (!canWriteBranch(req.user!, branchId)) throw forbidden('You can only manage learners of your own branch.');
}

async function enrich(rows: any[], orgId: string) {
  if (!rows.length) return rows;
  const ids = rows.map((r) => r.id);
  const batches = await query(
    `SELECT m.learner_id, b.id, b.batch_code, b.name, b.status, c.name AS course_name, pr.name AS program_name,
            (SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name, 'role', t.role) ORDER BY t.role, u.full_name)
               FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id
              WHERE t.batch_id = b.id AND t.status = 'active') AS teachers
       FROM learner_batch_memberships m
       JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id JOIN programs pr ON pr.id = b.program_id
      WHERE m.learner_id = ANY($1::uuid[]) AND m.status = 'active' AND m.org_id = $2
      ORDER BY b.name`, [ids, orgId]);
  const parents = await query(
    `SELECT lp.learner_id, pa.id, pa.full_name, pa.mobile FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id
      WHERE lp.learner_id = ANY($1::uuid[]) AND lp.is_primary AND pa.deleted_at IS NULL`, [ids]);
  const acts = await query(`SELECT learner_id, max(occurred_at) AS last FROM learner_activity WHERE learner_id = ANY($1::uuid[]) GROUP BY learner_id`, [ids]);
  const branches = await query(`SELECT id, name FROM branches WHERE org_id = $1`, [orgId]);
  return rows.map((r) => {
    const bs = batches.filter((b) => b.learner_id === r.id);
    const teachers = new Map<string, any>();
    bs.forEach((b) => (b.teachers ?? []).forEach((t: any) => teachers.set(t.id, { id: t.id, full_name: t.full_name })));
    return {
      id: r.id, learner_code: r.learner_code, full_name: r.full_name, photo_url: r.photo_url, mobile: r.mobile, email: r.email,
      school: r.school, location: r.location, status: r.status, enrolled_on: r.enrolled_on,
      branch: branches.find((b) => b.id === r.branch_id) ?? null,
      parent: parents.find((p) => p.learner_id === r.id) ?? null,
      batches: bs.map(({ learner_id, teachers: _t, ...b }) => b),
      courses: [...new Set(bs.map((b) => b.course_name))],
      teachers: [...teachers.values()],
      last_activity: acts.find((a) => a.learner_id === r.id)?.last ?? null,
    };
  });
}

// ---------------------------------------------------------------- list
router.get('/', requirePerm('learner:read'), wrap(async (req, res) => {
  const q = parse(paging.extend({ sort: z.enum(Object.keys(SORTS) as [string, ...string[]]).default('name') }).extend(learnerFiltersQuery.shape), req.query);
  const { page, page_size, sort, order, ...filters } = q;
  const p = new Params();
  const where = learnerWhere(req.user!, orgIdOf(req), filters, p, ['active', 'inactive']);
  const total = (await queryOne(`SELECT count(*) AS n FROM learners l WHERE ${where.join(' AND ')}`, p.values))!.n as number;
  const rows = await query(
    `SELECT l.* FROM learners l WHERE ${where.join(' AND ')}
      ORDER BY ${SORTS[sort]} ${order === 'desc' ? 'DESC' : 'ASC'} NULLS LAST, l.id
      LIMIT ${page_size} OFFSET ${(page - 1) * page_size}`, p.values);
  ok(res, await enrich(rows, orgIdOf(req)), { page, page_size, total, total_pages: Math.ceil(total / page_size) });
}));

// ---------------------------------------------------------------- create
router.post('/', requirePerm('learner:create'), wrap(async (req, res) => {
  const body = parse(learnerFields.extend({
    parent: parentInput.optional(),
    batch_ids: z.array(uuid).max(20).optional(),
  }), req.body);
  const orgId = orgIdOf(req);
  const mobile = body.mobile ? normalizeMobile(body.mobile) : null;
  if (body.mobile && !mobile) throw badRequest('Enter a valid 10 digit mobile number.', [{ field: 'mobile', message: 'Invalid mobile number.' }]);
  assertWritable(req, body.branch_id ?? (req.user!.access.orgWide ? null : req.user!.access.branchIds[0] ?? null));

  const created = await tx(async (db) => {
    await assertBranch(db, orgId, body.branch_id);
    const dup = await findDuplicate(db, orgId, mobile, body.email ?? null);
    if (dup) throw conflict(`A learner with this ${dup.field} already exists (${dup.existing.full_name}, ${dup.existing.learner_code}).`, 'DUPLICATE_LEARNER', dup);

    const org = await queryOne(`SELECT code_prefix FROM organizations WHERE id = $1`, [orgId], db);
    const code = await nextLearnerCode(db, orgId, org!.code_prefix);
    // Branch admins always create inside their own branch.
    const branchId = body.branch_id ?? (req.user!.access.orgWide ? null : req.user!.access.branchIds[0] ?? null);
    const l = await queryOne(
      `INSERT INTO learners (org_id, branch_id, learner_code, full_name, mobile, email, date_of_birth, gender, school, location, photo_url, enrolled_on, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12::date, CURRENT_DATE),$13) RETURNING *`,
      [orgId, branchId, code, body.full_name, mobile, body.email ?? null, body.date_of_birth ?? null, body.gender ?? null, body.school ?? null,
        body.location ?? null, body.photo_url ?? null, body.enrolled_on ?? null, req.user!.id], db);
    await recordActivity(db, { orgId, learnerId: l!.id, type: 'learner.created', title: 'Joined Robokalam', description: `Learner profile ${code} created`, actorUserId: req.user!.id });

    if (body.parent) {
      const { parent, created } = await upsertParent(db, orgId, body.parent);
      await linkParent(db, orgId, l!.id, parent.id, body.parent.relationship, true);
      await recordActivity(db, { orgId, learnerId: l!.id, type: 'parent.linked', title: `Parent linked: ${parent.full_name}`, meta: { parent_id: parent.id, reused: !created }, actorUserId: req.user!.id });
    }
    for (const batchId of new Set(body.batch_ids ?? [])) {
      await enrollLearners({ db, user: req.user!, orgId, req }, batchId, [l!.id]);
    }
    await audit({ orgId, actor: req.user, action: 'learner.created', entityType: 'learner', entityId: l!.id, next: { learner_code: code, full_name: l!.full_name, batch_ids: body.batch_ids ?? [] }, req }, db);
    return l!;
  });
  ok(res, await getLearner360(req, created.id), undefined, 201);
}));

// ---------------------------------------------------------------- learner 360
async function getLearner360(req: Request, id: string) {
  const l = await scopedLearner(req, id);
  const orgId = orgIdOf(req);
  const [parents, memberships, branch, login, counts] = await Promise.all([
    query(`SELECT pa.id, pa.full_name, pa.mobile, pa.email, lp.relationship, lp.is_primary, (pa.user_id IS NOT NULL) AS has_login
             FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id
            WHERE lp.learner_id = $1 AND pa.deleted_at IS NULL ORDER BY lp.is_primary DESC, pa.full_name`, [id]),
    query(`SELECT m.id AS membership_id, m.status AS membership_status, m.joined_at, m.left_at, m.left_reason,
                  b.id AS batch_id, b.batch_code, b.name AS batch_name, b.status AS batch_status, b.academic_year, b.schedule,
                  b.start_date, b.end_date, c.id AS course_id, c.name AS course_name, pr.id AS program_id, pr.name AS program_name,
                  (SELECT json_agg(json_build_object('id', u.id, 'full_name', u.full_name, 'role', t.role) ORDER BY t.role, u.full_name)
                     FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id
                    WHERE t.batch_id = b.id AND t.status = 'active') AS teachers
             FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id
             JOIN courses c ON c.id = b.course_id JOIN programs pr ON pr.id = b.program_id
            WHERE m.learner_id = $1 AND m.org_id = $2
            ORDER BY (m.status = 'active') DESC, m.joined_at DESC`, [id, orgId]),
    l.branch_id ? queryOne(`SELECT id, name, code FROM branches WHERE id = $1`, [l.branch_id]) : null,
    l.user_id ? queryOne(`SELECT email, last_login_at, status FROM users WHERE id = $1`, [l.user_id]) : null,
    queryOne(`SELECT count(*) AS n FROM learner_activity WHERE learner_id = $1`, [id]),
  ]);
  const active = memberships.filter((m) => m.membership_status === 'active');
  const { created_by, user_id, ...profile } = l;
  void created_by;
  return {
    ...profile,
    branch, parents, memberships,
    login: login ? { email: login.email, status: login.status, last_login_at: login.last_login_at } : null,
    stats: {
      active_batches: active.length,
      total_batches: memberships.length,
      courses: new Set(active.map((m) => m.course_id)).size,
      programs: new Set(active.map((m) => m.program_id)).size,
      activity_events: counts!.n,
    },
    has_login: !!user_id,
  };
}

router.get('/:id', requireAnyPerm('learner:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  ok(res, await getLearner360(req, parse(uuid, req.params.id)));
}));

router.get('/:id/timeline', requireAnyPerm('learner:read', 'portal:learner', 'portal:parent'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const q = parse(z.object({ page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(30), type: z.string().max(40).optional() }), req.query);
  await scopedLearner(req, id);
  const params: unknown[] = [id, orgIdOf(req)];
  let where = 'a.learner_id = $1 AND a.org_id = $2';
  if (q.type) { params.push(`${q.type}%`); where += ` AND a.type LIKE $${params.length}`; }
  const total = (await queryOne(`SELECT count(*) AS n FROM learner_activity a WHERE ${where}`, params))!.n;
  const rows = await query(
    `SELECT a.id, a.type, a.title, a.description, a.meta, a.batch_id, a.occurred_at, u.full_name AS actor_name
       FROM learner_activity a LEFT JOIN users u ON u.id = a.actor_user_id
      WHERE ${where} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, params);
  ok(res, rows, { page: q.page, page_size: q.page_size, total });
}));

// ---------------------------------------------------------------- update / archive / restore
router.patch('/:id', requirePerm('learner:update'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(learnerFields.partial().extend({ status: z.enum(LEARNER_STATUSES).optional() }), req.body);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const prev = await queryOne(`SELECT * FROM learners WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [id, orgId], db);
    if (!prev) throw notFound('Learner');
    await scopedLearner(req, id, db);
    assertWritable(req, prev.branch_id);
    if (body.branch_id !== undefined) { assertWritable(req, body.branch_id ?? null); await assertBranch(db, orgId, body.branch_id); }

    let mobile: string | null | undefined;
    if (body.mobile !== undefined) {
      mobile = body.mobile ? normalizeMobile(body.mobile) : null;
      if (body.mobile && !mobile) throw badRequest('Enter a valid 10 digit mobile number.', [{ field: 'mobile', message: 'Invalid mobile number.' }]);
    }
    const dup = await findDuplicate(db, orgId, mobile ?? null, body.email ?? null, id);
    if (dup) throw conflict(`A learner with this ${dup.field} already exists (${dup.existing.full_name}, ${dup.existing.learner_code}).`, 'DUPLICATE_LEARNER', dup);

    const fields: Record<string, unknown> = { ...body };
    delete fields.mobile;
    if (mobile !== undefined) fields.mobile = mobile;
    const keys = Object.keys(fields).filter((k) => fields[k] !== undefined);
    if (!keys.length) return;
    const next = await queryOne(
      `UPDATE learners SET ${keys.map((k, i) => `${k} = $${i + 3}`).join(', ')} WHERE id = $1 AND org_id = $2 RETURNING *`,
      [id, orgId, ...keys.map((k) => fields[k])], db);
    const changed = keys.filter((k) => String(prev[k] ?? '') !== String(next![k] ?? ''));
    if (!changed.length) return;
    await recordActivity(db, { orgId, learnerId: id, type: body.status && body.status !== prev.status ? 'learner.status_changed' : 'learner.updated',
      title: body.status && body.status !== prev.status ? `Status changed to ${body.status}` : 'Profile updated',
      description: changed.filter((k) => k !== 'status').length ? `Updated: ${changed.filter((k) => k !== 'status').join(', ')}` : null, actorUserId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'learner.updated', entityType: 'learner', entityId: id,
      previous: Object.fromEntries(changed.map((k) => [k, prev[k]])), next: Object.fromEntries(changed.map((k) => [k, next![k]])), req }, db);
  });
  ok(res, await getLearner360(req, id));
}));

router.delete('/:id', requirePerm('learner:delete'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const prev = await scopedLearner(req, id, db);
    assertWritable(req, prev.branch_id);
    if (prev.status === 'archived') return;
    await queryOne(`UPDATE learners SET status = 'archived' WHERE id = $1`, [id], db);
    // Archiving ends active memberships (kept as history, re-join on restore is explicit).
    const batches = await query(`SELECT batch_id FROM learner_batch_memberships WHERE learner_id = $1 AND status = 'active'`, [id], db);
    for (const b of batches) await removeLearners({ db, user: req.user!, orgId, req }, b.batch_id, [id], { reason: 'Learner archived' });
    await recordActivity(db, { orgId, learnerId: id, type: 'learner.status_changed', title: 'Learner archived', actorUserId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'learner.archived', entityType: 'learner', entityId: id, previous: { status: prev.status }, next: { status: 'archived' }, req }, db);
  });
  ok(res, { id, status: 'archived' });
}));

router.post('/:id/restore', requirePerm('learner:delete'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const prev = await scopedLearner(req, id, db);
    assertWritable(req, prev.branch_id);
    await queryOne(`UPDATE learners SET status = 'active' WHERE id = $1`, [id], db);
    await recordActivity(db, { orgId, learnerId: id, type: 'learner.status_changed', title: 'Learner restored', actorUserId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'learner.restored', entityType: 'learner', entityId: id, previous: { status: prev.status }, next: { status: 'active' }, req }, db);
  });
  ok(res, await getLearner360(req, id));
}));

// ---------------------------------------------------------------- batches of one learner
router.post('/:id/batches', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { batch_id } = parse(z.object({ batch_id: uuid }), req.body);
  await scopedLearner(req, id);
  const result = await tx((db) => enrollLearners({ db, user: req.user!, orgId: orgIdOf(req), req }, batch_id, [id]));
  ok(res, { ...result, learner: await getLearner360(req, id) }, undefined, result.joined || result.rejoined ? 201 : 200);
}));

router.delete('/:id/batches/:batchId', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const batchId = parse(uuid, req.params.batchId);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.slice(0, 200) : null;
  await scopedLearner(req, id);
  const result = await tx((db) => removeLearners({ db, user: req.user!, orgId: orgIdOf(req), req }, batchId, [id], { reason }));
  if (!result.removed) throw notFound('Active batch membership');
  ok(res, { ...result, learner: await getLearner360(req, id) });
}));

/** Move a learner from one batch to another atomically. */
router.post('/:id/transfer', requirePerm('batch:enroll'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const { from_batch_id, to_batch_id } = parse(z.object({ from_batch_id: uuid, to_batch_id: uuid }), req.body);
  if (from_batch_id === to_batch_id) throw badRequest('Choose a different batch to move to.');
  await scopedLearner(req, id);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const c = { db, user: req.user!, orgId, req };
    const from = await queryOne(`SELECT name FROM batches WHERE id = $1 AND org_id = $2`, [from_batch_id, orgId], db);
    const to = await queryOne(`SELECT name FROM batches WHERE id = $1 AND org_id = $2`, [to_batch_id, orgId], db);
    if (!from || !to) throw notFound('Batch');
    // Lock in a stable order to avoid deadlocks between concurrent transfers.
    const rem = await removeLearners(c, from_batch_id, [id], { status: 'transferred', transferredTo: { name: to.name } });
    if (!rem.removed) throw conflict('The learner is not currently in the batch you are moving from.', 'NOT_A_MEMBER');
    await enrollLearners(c, to_batch_id, [id], { transferredFrom: { id: from_batch_id, name: from.name } });
  });
  ok(res, await getLearner360(req, id));
}));

// ---------------------------------------------------------------- parents of one learner
router.post('/:id/parents', requirePerm('parent:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ parent_id: uuid.optional(), parent: parentInput.optional(), relationship: z.string().max(30).default('guardian'), is_primary: z.boolean().default(false) }), req.body);
  const l = await scopedLearner(req, id);
  assertWritable(req, l.branch_id);
  if (!body.parent_id && !body.parent) throw badRequest('Choose an existing parent or enter new parent details.');
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    let parent: any;
    if (body.parent_id) {
      parent = await queryOne(`SELECT id, full_name FROM parents WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [body.parent_id, orgId], db);
      if (!parent) throw notFound('Parent');
    } else parent = (await upsertParent(db, orgId, body.parent!)).parent;
    await linkParent(db, orgId, id, parent.id, body.parent?.relationship ?? body.relationship, body.is_primary);
    await recordActivity(db, { orgId, learnerId: id, type: 'parent.linked', title: `Parent linked: ${parent.full_name}`, actorUserId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'learner.parent_linked', entityType: 'learner', entityId: id, next: { parent_id: parent.id }, req }, db);
  });
  ok(res, await getLearner360(req, id), undefined, 201);
}));

router.delete('/:id/parents/:parentId', requirePerm('parent:manage'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const parentId = parse(uuid, req.params.parentId);
  const l = await scopedLearner(req, id);
  assertWritable(req, l.branch_id);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    const r = await query(`DELETE FROM learner_parents WHERE learner_id = $1 AND parent_id = $2 AND org_id = $3 RETURNING parent_id, is_primary`, [id, parentId, orgId], db);
    if (!r.length) throw notFound('Parent link');
    if (r[0].is_primary) {
      await query(`UPDATE learner_parents SET is_primary = true WHERE (learner_id, parent_id) IN (SELECT learner_id, parent_id FROM learner_parents WHERE learner_id = $1 ORDER BY created_at LIMIT 1)`, [id], db);
    }
    await recordActivity(db, { orgId, learnerId: id, type: 'parent.unlinked', title: 'Parent unlinked', actorUserId: req.user!.id });
    await audit({ orgId, actor: req.user, action: 'learner.parent_unlinked', entityType: 'learner', entityId: id, previous: { parent_id: parentId }, req }, db);
  });
  ok(res, await getLearner360(req, id));
}));

// ---------------------------------------------------------------- portal login
router.post('/:id/login', requirePerm('learner:login'), wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const body = parse(z.object({ email: z.string().trim().toLowerCase().email().optional(), password: z.string().optional() }), req.body ?? {});
  const l = await scopedLearner(req, id);
  assertWritable(req, l.branch_id);
  if (l.user_id) throw conflict('This learner already has a login.', 'LOGIN_EXISTS');
  const email = body.email ?? l.email;
  if (!email) throw badRequest('Add an email address for the learner first.');
  const password = body.password ?? generatePassword();
  const problem = passwordProblem(password);
  if (problem) throw badRequest(problem);
  const hash = await hashPassword(password);
  const orgId = orgIdOf(req);
  await tx(async (db) => {
    if (await queryOne(`SELECT 1 FROM users WHERE lower(email) = $1 AND deleted_at IS NULL`, [email], db)) throw conflict('A user with this email already exists.', 'DUPLICATE');
    const u = await queryOne(`INSERT INTO users (org_id, email, mobile, password_hash, full_name, must_change_password) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, email, l.mobile, hash, l.full_name, !body.password], db);
    await query(`INSERT INTO user_roles (user_id, role_id, org_id) SELECT $1, id, $2 FROM roles WHERE key = 'learner'`, [u!.id, orgId], db);
    await query(`UPDATE learners SET user_id = $2 WHERE id = $1`, [id, u!.id], db);
    await audit({ orgId, actor: req.user, action: 'learner.login_created', entityType: 'learner', entityId: id, next: { email }, req }, db);
  });
  ok(res, { email, ...(body.password ? {} : { temporary_password: password }) }, undefined, 201);
}));

export default router;
