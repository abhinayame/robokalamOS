import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { recordScore } from '../assessment/scoring.js';
import { setSourceXp } from '../gamification/xp.js';
import { attachFiles, filesFor } from '../files/store.js';
import { assertManage, assignmentState, openRoom, viewedLearner } from './access.js';

export const assignmentsRouter = Router();
export const submissionsRouter = Router();
assignmentsRouter.use(requireOrg, requirePerm('classroom:read'));
submissionsRouter.use(requireOrg, requirePerm('classroom:read'));

const httpUrl = z.string().trim().max(1000).url().refine((u) => /^https?:\/\//i.test(u), 'Use a link that starts with http:// or https://');

async function loadAssignment(id: string, orgId: string) {
  const a = await queryOne(
    `SELECT a.*, t.title AS topic_title FROM assignments a LEFT JOIN topics t ON t.id = a.topic_id WHERE a.id = $1 AND a.org_id = $2 AND a.deleted_at IS NULL`, [id, orgId]);
  if (!a) throw notFound('Assignment');
  return a;
}
const shapeSubmission = (s: any, files?: Map<string, any[]>) => s && ({
  id: s.id, assignment_id: s.assignment_id, learner_id: s.learner_id, status: s.status, body: s.body, link_url: s.link_url,
  submitted_at: s.submitted_at, evaluated_at: s.evaluated_at, feedback: s.feedback, version: s.version, updated_at: s.updated_at,
  files: files?.get(s.id) ?? [],
});

// ------------------------------------------------------------------ cross-classroom list
// Learner/parent: their (or a child's) work across batches. Staff: pass learner_id (Learner 360) or batch_id.
assignmentsRouter.get('/', wrap(async (req, res) => {
  const user = req.user!; const orgId = orgIdOf(req);
  const q = parse(z.object({
    learner_id: uuid.optional(), batch_id: uuid.optional(),
    state: z.enum(['upcoming', 'due', 'completed', 'late', 'returned']).optional(),
    page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(50),
  }), req.query);

  let learnerId = q.learner_id ?? null;
  if (!learnerId && user.access.ownLearnerIds.length) learnerId = user.access.ownLearnerIds[0];
  if (!learnerId) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const lp = new Params();
  const scope = learnerScope(user, lp, 'l');
  const lr = await queryOne(`SELECT l.id FROM learners l WHERE l.id = ${lp.add(learnerId)} AND l.org_id = ${lp.add(orgId)} AND l.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}`, lp.values);
  if (!lr) throw notFound('Learner');

  const p = new Params();
  const where = [`a.org_id = ${p.add(orgId)}`, 'a.deleted_at IS NULL', 'b.deleted_at IS NULL', `m.learner_id = ${p.add(learnerId)}`, `m.status = 'active'`];
  if (q.batch_id) where.push(`a.batch_id = ${p.add(q.batch_id)}`);
  // Batches in a teacher's/branch scope only: a staff user must not read other batches' work through a shared learner.
  if (!user.access.orgWide && !user.access.ownLearnerIds.includes(learnerId)) {
    const parts: string[] = [];
    if (user.access.branchIds.length) parts.push(`b.branch_id IN ${p.in(user.access.branchIds)}`);
    if (user.access.teacher) parts.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships st WHERE st.batch_id = b.id AND st.teacher_user_id = ${p.add(user.id)} AND st.status = 'active')`);
    where.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
  }
  const rows = await query(
    `SELECT a.id, a.batch_id, b.name AS batch_name, a.title, a.due_at, a.max_marks, a.allow_resubmit, s.id AS submission_id, s.status AS submission_status, s.submitted_at
       FROM assignments a JOIN batches b ON b.id = a.batch_id
       JOIN learner_batch_memberships m ON m.batch_id = a.batch_id
       LEFT JOIN submissions s ON s.assignment_id = a.id AND s.learner_id = m.learner_id
      WHERE ${where.join(' AND ')} ORDER BY (a.due_at IS NULL), a.due_at, a.created_at DESC LIMIT 500`, p.values);
  let items = rows.map((r) => ({ ...r, max_marks: Number(r.max_marks), allow_resubmit: !!r.allow_resubmit,
    state: assignmentState(r, r.submission_status ? { status: r.submission_status } : null) }));
  const counts = items.reduce<Record<string, number>>((m, i) => ({ ...m, [i.state]: (m[i.state] ?? 0) + 1 }), {});
  if (q.state) items = items.filter((i) => i.state === q.state);
  const total = items.length;
  ok(res, items.slice((q.page - 1) * q.page_size, q.page * q.page_size), { page: q.page, page_size: q.page_size, total, counts, learner_id: learnerId });
}));

// ------------------------------------------------------------------ detail
assignmentsRouter.get('/:id', wrap(async (req, res) => {
  const a = await loadAssignment(parse(uuid, req.params.id), orgIdOf(req));
  const room = await openRoom(req, a.batch_id);
  const q = parse(z.object({ learner_id: uuid.optional() }), req.query);
  const attach = await filesFor('assignment', [a.id]);
  const out: any = {
    id: a.id, batch_id: a.batch_id, batch_name: room.batch.name, topic_id: a.topic_id, topic_title: a.topic_title, title: a.title,
    description: a.description, instructions: a.instructions, due_at: a.due_at, max_marks: Number(a.max_marks), allow_resubmit: !!a.allow_resubmit,
    created_at: a.created_at, files: attach.get(a.id) ?? [], can_manage: room.canManage, can_submit: false, writable: room.writable,
  };
  if (room.canManage) {
    const c = await queryOne(
      `SELECT COUNT(*) AS members,
              SUM(s.status IN ('submitted','late','evaluated','returned')) AS handed_in,
              SUM(s.status IN ('submitted','late')) AS to_review,
              SUM(s.status = 'evaluated') AS evaluated
         FROM learner_batch_memberships m LEFT JOIN submissions s ON s.learner_id = m.learner_id AND s.assignment_id = $2
        WHERE m.batch_id = $1 AND m.status = 'active'`, [a.batch_id, a.id]);
    out.stats = { members: Number(c!.members), handed_in: Number(c!.handed_in ?? 0), to_review: Number(c!.to_review ?? 0), evaluated: Number(c!.evaluated ?? 0) };
  } else {
    const learnerId = viewedLearner(room, q.learner_id);
    if (!learnerId) throw notFound('Assignment');
    const s = await queryOne(`SELECT * FROM submissions WHERE assignment_id = $1 AND learner_id = $2`, [a.id, learnerId]);
    const sf = s ? await filesFor('submission', [s.id]) : undefined;
    out.learner_id = learnerId;
    out.submission = shapeSubmission(s, sf);
    if (out.submission) {
      const sc = await queryOne(`SELECT score FROM scores WHERE learner_id = $1 AND source_type = 'assignment' AND source_id = $2 AND deleted_at IS NULL`, [learnerId, a.id]);
      out.submission.score = s.status === 'evaluated' && sc ? Number(sc.score) : null;
    }
    out.state = assignmentState(a, s);
    out.can_submit = room.canInteract && room.writable && room.learnerIds.includes(learnerId)
      && (!s || ['draft', 'returned'].includes(s.status) || (a.allow_resubmit && s.status !== 'evaluated'));
  }
  ok(res, out);
}));

// ------------------------------------------------------------------ learner: draft / submit
const submitBody = z.object({
  body: z.string().trim().max(20_000).nullish(),
  link_url: httpUrl.nullish().or(z.literal('').transform(() => null)),
  file_ids: z.array(uuid).max(5).default([]),
  submit: z.boolean().default(false),
});

assignmentsRouter.put('/:id/submission', requirePerm('classroom:interact'), wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const a = await loadAssignment(parse(uuid, req.params.id), orgId);
  const b = parse(submitBody, req.body);
  const result = await tx(async (db) => {
    const room = await openRoom(req, a.batch_id, db);
    // Only the learner themself submits; parents and teachers have read/review access only.
    if (!room.canInteract || !room.learnerIds.length) throw forbidden('Only learners in this batch can submit work.');
    if (!room.writable) throw conflict(`This batch is ${room.batch.status}, so it no longer accepts submissions.`, 'BATCH_CLOSED');
    const learnerId = room.learnerIds[0];
    const hasContent = !!(b.body || b.link_url || b.file_ids.length);
    if (b.submit && !hasContent) throw badRequest('Add your answer, a link or a file before submitting.', [{ field: 'body', message: 'Nothing to submit yet.' }]);

    let s = await queryOne(`SELECT * FROM submissions WHERE assignment_id = $1 AND learner_id = $2 FOR UPDATE`, [a.id, learnerId], db);
    if (s) {
      const open = ['draft', 'returned'].includes(s.status) || (a.allow_resubmit && s.status !== 'evaluated');
      if (!open) throw conflict(s.status === 'evaluated' ? 'This work has already been evaluated.' : 'You have already submitted this assignment.', 'ALREADY_SUBMITTED');
    }
    const late = !!(b.submit && a.due_at && new Date(a.due_at).getTime() < Date.now());
    const status = b.submit ? (late ? 'late' : 'submitted') : (s && s.status === 'returned' ? 'returned' : 'draft');
    let id = s?.id as string | undefined;
    if (!id) {
      id = newId();
      await exec(`INSERT INTO submissions (id, org_id, assignment_id, learner_id, status, body, link_url) VALUES ($1,$2,$3,$4,'draft',$5,$6)`, [id, orgId, a.id, learnerId, b.body ?? null, b.link_url ?? null], db);
    }
    await exec(
      `UPDATE submissions SET body = $1, link_url = $2, status = $3${b.submit ? ', submitted_at = NOW(3), version = version + 1, evaluated_at = NULL, evaluated_by = NULL' : ''} WHERE id = $4`,
      [b.body ?? null, b.link_url ?? null, status, id], db);
    await attachFiles(db, { orgId, userId: req.user!.id, ownerType: 'submission', ownerId: id, fileIds: b.file_ids, replace: true, max: 5 });
    if (b.submit) {
      await recordActivity(db, { orgId, learnerId, batchId: a.batch_id, type: 'assignment.submitted', title: `Submitted: ${a.title}${late ? ' (late)' : ''}`, meta: { assignment_id: a.id, submission_id: id, late }, actorUserId: req.user!.id });
    }
    return { id, status, late };
  });
  if (b.submit) await audit({ orgId, actor: req.user, action: 'submission.submitted', entityType: 'submission', entityId: result.id, next: { assignment: a.title, late: result.late }, req });
  ok(res, result);
}));

// ------------------------------------------------------------------ teacher: submissions of an assignment
assignmentsRouter.get('/:id/submissions', wrap(async (req, res) => {
  const a = await loadAssignment(parse(uuid, req.params.id), orgIdOf(req));
  const room = await openRoom(req, a.batch_id);
  assertManage(room);
  const q = parse(z.object({ status: z.enum(['not_submitted', 'submitted', 'late', 'evaluated', 'returned', 'to_review']).optional(), search: z.string().trim().max(100).optional() }), req.query);
  const p = new Params();
  const where = [`m.batch_id = ${p.add(a.batch_id)}`, `m.status = 'active'`, 'l.deleted_at IS NULL'];
  if (q.search) where.push(`(l.full_name LIKE ${p.add(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`)} OR l.learner_code LIKE ${p.add(`%${q.search.replace(/[%_\\]/g, '\\$&')}%`)})`);
  if (q.status === 'not_submitted') where.push(`(s.id IS NULL OR s.status = 'draft')`);
  else if (q.status === 'to_review') where.push(`s.status IN ('submitted','late')`);
  else if (q.status) where.push(`s.status = ${p.add(q.status)}`);
  const rows = await query(
    `SELECT l.id AS learner_id, l.full_name, l.learner_code, s.id AS submission_id, COALESCE(s.status, 'not_submitted') AS status, s.submitted_at, s.evaluated_at, s.version, sc.score
       FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id
       LEFT JOIN submissions s ON s.learner_id = l.id AND s.assignment_id = ${p.add(a.id)}
       LEFT JOIN scores sc ON sc.learner_id = l.id AND sc.source_type = 'assignment' AND sc.source_id = s.assignment_id AND sc.deleted_at IS NULL
      WHERE ${where.join(' AND ')} ORDER BY l.full_name, l.id LIMIT 1000`, p.values);
  ok(res, rows.map((r) => ({ ...r, score: r.score == null ? null : Number(r.score), status: r.status === 'draft' ? 'not_submitted' : r.status })), { total: rows.length });
}));

// ------------------------------------------------------------------ submissions
submissionsRouter.get('/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const s = await queryOne(
    `SELECT s.*, a.batch_id, a.title AS assignment_title, a.max_marks, a.due_at, a.allow_resubmit, l.full_name AS learner_name, l.learner_code
       FROM submissions s JOIN assignments a ON a.id = s.assignment_id JOIN learners l ON l.id = s.learner_id
      WHERE s.id = $1 AND s.org_id = $2 AND a.deleted_at IS NULL`, [parse(uuid, req.params.id), orgId]);
  if (!s) throw notFound('Submission');
  const room = await openRoom(req, s.batch_id);
  if (!room.canManage && !req.user!.access.ownLearnerIds.includes(s.learner_id)) throw notFound('Submission');
  const files = await filesFor('submission', [s.id]);
  const sc = await queryOne(`SELECT score, max_score FROM scores WHERE learner_id = $1 AND source_type = 'assignment' AND source_id = $2 AND deleted_at IS NULL`, [s.learner_id, s.assignment_id]);
  ok(res, { ...shapeSubmission(s, files), score: sc ? Number(sc.score) : null, assignment_title: s.assignment_title, max_marks: Number(s.max_marks), due_at: s.due_at, batch_id: s.batch_id,
    learner: { id: s.learner_id, name: s.learner_name, ...(room.canManage ? { code: s.learner_code } : {}) }, can_review: room.canManage && ['submitted', 'late', 'evaluated', 'returned'].includes(s.status) });
}));

submissionsRouter.post('/:id/review', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ action: z.enum(['evaluate', 'return']), feedback: z.string().trim().max(10_000).nullish(), score: z.number().min(0).max(100000).optional(), bonus_xp: z.number().int().min(0).max(500).optional() }), req.body);
  if (b.action === 'return' && !b.feedback) throw badRequest('Tell the learner what to fix before returning the work.', [{ field: 'feedback', message: 'This is required to return work.' }]);
  if (b.action === 'evaluate' && b.score === undefined) throw badRequest('Enter the score for this work.', [{ field: 'score', message: 'This is required to mark work evaluated.' }]);
  const out = await tx(async (db) => {
    const s = await queryOne(
      `SELECT s.id, s.status, s.learner_id, a.batch_id, a.title, a.max_marks, s.assignment_id FROM submissions s JOIN assignments a ON a.id = s.assignment_id
        WHERE s.id = $1 AND s.org_id = $2 AND a.deleted_at IS NULL FOR UPDATE`, [parse(uuid, req.params.id), orgId], db);
    if (!s) throw notFound('Submission');
    const room = await openRoom(req, s.batch_id, db);
    if (!room.canManage) throw notFound('Submission');
    if (!['submitted', 'late', 'evaluated'].includes(s.status)) throw conflict('Only submitted work can be reviewed.', 'NOT_SUBMITTED');
    const status = b.action === 'evaluate' ? 'evaluated' : 'returned';
    if (b.action === 'evaluate') {
      const rs = await recordScore(db, { orgId, actorId: req.user!.id, learnerId: s.learner_id, batchId: s.batch_id, sourceType: 'assignment', sourceId: s.assignment_id, name: s.title, category: 'Assignment', score: b.score!, max: Number(s.max_marks), feedback: b.feedback ?? null });
      if (b.bonus_xp !== undefined) await setSourceXp(db, { orgId, learnerId: s.learner_id, batchId: s.batch_id, reason: `Bonus: ${s.title}`, sourceType: 'score', sourceId: rs.id, target: b.bonus_xp, userId: req.user!.id });
    }
    await exec(`UPDATE submissions SET status = $1, feedback = $2, evaluated_at = NOW(3), evaluated_by = $3 WHERE id = $4`, [status, b.feedback ?? null, req.user!.id, s.id], db);
    await recordActivity(db, { orgId, learnerId: s.learner_id, batchId: s.batch_id, type: `assignment.${status}`,
      title: status === 'evaluated' ? `Evaluated: ${s.title}` : `Returned for changes: ${s.title}`, description: b.feedback ?? null, meta: { submission_id: s.id }, actorUserId: req.user!.id });
    return { id: s.id, status };
  });
  await audit({ orgId, actor: req.user, action: `submission.${out.status}`, entityType: 'submission', entityId: out.id, req });
  ok(res, out);
}));
