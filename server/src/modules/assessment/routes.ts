import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { assertManage, assertWritable, openRoom, viewedLearner } from '../classroom/access.js';
import { setSourceXp } from '../gamification/xp.js';
import { band, pct, recordScore, removeScore, summarize } from './scoring.js';

export const assessmentRouter = Router();   // mounted at /api/classrooms
export const scoresRouter = Router();       // mounted at /api/scores
assessmentRouter.use(requireOrg, requirePerm('classroom:read'));
scoresRouter.use(requireOrg, requirePerm('classroom:read'));

const num = (v: unknown) => (v == null ? null : Number(v));

// ------------------------------------------------------------------ manual activities & scoring
const activityBody = z.object({
  name: z.string().trim().min(1, 'Name the activity.').max(255),
  category: z.string().trim().max(60).nullish(),
  max_score: z.number().positive().max(100000).default(100),
  held_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
});

assessmentRouter.get('/:batchId/activities', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const rows = await query(
    `SELECT a.id, a.name, a.category, a.max_score, a.held_on, a.created_at,
            (SELECT COUNT(*) FROM scores s WHERE s.source_type = 'activity' AND s.source_id = a.id AND s.deleted_at IS NULL) AS scored
       FROM activities a WHERE a.batch_id = $1 AND a.deleted_at IS NULL ORDER BY COALESCE(a.held_on, DATE(a.created_at)) DESC, a.created_at DESC LIMIT 500`, [room.batch.id]);
  ok(res, rows.map((r) => ({ ...r, max_score: Number(r.max_score), scored: Number(r.scored) })));
}));

assessmentRouter.post('/:batchId/activities', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const b = parse(activityBody, req.body);
  const id = newId();
  await exec(`INSERT INTO activities (id, org_id, batch_id, name, category, max_score, held_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, orgIdOf(req), room.batch.id, b.name, b.category ?? null, b.max_score, b.held_on ?? null, req.user!.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'activity.created', entityType: 'activity', entityId: id, next: { name: b.name, batch: room.batch.batch_code }, req });
  ok(res, { id }, undefined, 201);
}));

assessmentRouter.patch('/:batchId/activities/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id);
  const b = parse(activityBody.partial(), req.body);
  const cur = await queryOne(`SELECT id, max_score FROM activities WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [id, room.batch.id]);
  if (!cur) throw notFound('Activity');
  if (b.max_score !== undefined && Number(cur.max_score) !== b.max_score) {
    const n = await queryOne(`SELECT COUNT(*) AS n FROM scores WHERE source_type = 'activity' AND source_id = $1 AND deleted_at IS NULL`, [id]);
    if (Number(n!.n) > 0) throw badRequest('Scores are already recorded, so the maximum cannot change. Create a new activity instead.');
  }
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['name', 'category', 'max_score', 'held_on'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 1}`); }
  if (sets.length) await exec(`UPDATE activities SET ${sets.join(', ')} WHERE id = $1`, [id, ...vals]);
  if (b.name || b.category !== undefined) await exec(`UPDATE scores SET activity_name = COALESCE($2, activity_name), category = $3 WHERE source_type = 'activity' AND source_id = $1`, [id, b.name ?? null, b.category === undefined ? (await queryOne(`SELECT category FROM activities WHERE id = $1`, [id]))!.category : b.category]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'activity.updated', entityType: 'activity', entityId: id, next: b, req });
  ok(res, { id });
}));

assessmentRouter.delete('/:batchId/activities/:id', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room); assertWritable(room);
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  await tx(async (db) => {
    const r = await exec(`UPDATE activities SET deleted_at = NOW(3) WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [id, room.batch.id], db);
    if (!r.affectedRows) throw notFound('Activity');
    for (const s of await query(`SELECT id FROM scores WHERE source_type = 'activity' AND source_id = $1 AND deleted_at IS NULL`, [id], db)) await removeScore(db, orgId, req.user!.id, s.id);
  });
  await audit({ orgId, actor: req.user, action: 'activity.deleted', entityType: 'activity', entityId: id, req });
  ok(res, { id, deleted: true });
}));

/** The scoring sheet: every active learner of the batch with their current score for this activity. */
assessmentRouter.get('/:batchId/activities/:id/scores', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const a = await queryOne(`SELECT id, name, category, max_score FROM activities WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), room.batch.id]);
  if (!a) throw notFound('Activity');
  const rows = await query(
    `SELECT l.id AS learner_id, l.full_name, l.learner_code, s.id AS score_id, s.score, s.feedback, s.updated_at,
            (SELECT COALESCE(SUM(x.points), 0) FROM xp_transactions x WHERE x.source_type = 'score' AND x.source_id = s.id) AS bonus_xp
       FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL
       LEFT JOIN scores s ON s.learner_id = l.id AND s.source_type = 'activity' AND s.source_id = $2 AND s.deleted_at IS NULL
      WHERE m.batch_id = $1 AND m.status = 'active' ORDER BY l.full_name, l.id LIMIT 1000`, [room.batch.id, a.id]);
  ok(res, { activity: { ...a, max_score: Number(a.max_score) }, rows: rows.map((r) => ({ ...r, score: num(r.score), bonus_xp: r.score_id ? Number(r.bonus_xp) : 0 })) });
}));

const entriesBody = z.object({
  entries: z.array(z.object({ learner_id: uuid, score: z.number().nullable(), feedback: z.string().trim().max(5000).nullish(), bonus_xp: z.number().int().min(0).max(500).optional() })).min(1).max(1000),
});

/** Save many scores at once. One entry per learner (duplicates are merged, last wins); `score: null` clears. */
assessmentRouter.put('/:batchId/activities/:id/scores', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  assertManage(room);
  const b = parse(entriesBody, req.body); const orgId = orgIdOf(req);
  const byLearner = new Map<string, (typeof b.entries)[number]>();
  for (const e of b.entries) byLearner.set(e.learner_id, e);
  const out = await tx(async (db) => {
    const a = await queryOne(`SELECT id, name, category, max_score FROM activities WHERE id = $1 AND batch_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), room.batch.id], db);
    if (!a) throw notFound('Activity');
    const p = new Params();
    const members = new Set((await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = ${p.add(room.batch.id)} AND status = 'active' AND learner_id IN ${p.in([...byLearner.keys()])}`, p.values, db)).map((r) => r.learner_id as string));
    const outsiders = [...byLearner.keys()].filter((id) => !members.has(id));
    if (outsiders.length) throw badRequest(`${outsiders.length} learner(s) are not active members of this batch.`, outsiders.map((id) => ({ field: id, message: 'Not in this batch.' })));
    const res2 = { created: 0, updated: 0, unchanged: 0, cleared: 0 };
    for (const e of byLearner.values()) {
      if (e.score === null) {
        const cur = await queryOne(`SELECT id FROM scores WHERE learner_id = $1 AND source_type = 'activity' AND source_id = $2 AND deleted_at IS NULL`, [e.learner_id, a.id], db);
        if (cur) { await removeScore(db, orgId, req.user!.id, cur.id); res2.cleared++; }
        continue;
      }
      const r = await recordScore(db, { orgId, actorId: req.user!.id, learnerId: e.learner_id, batchId: room.batch.id, sourceType: 'activity', sourceId: a.id, name: a.name, category: a.category, score: e.score, max: Number(a.max_score), feedback: e.feedback });
      res2[r.action]++;
      if (e.bonus_xp !== undefined) await setSourceXp(db, { orgId, learnerId: e.learner_id, batchId: room.batch.id, reason: `Bonus: ${a.name}`, sourceType: 'score', sourceId: r.id, target: e.bonus_xp, userId: req.user!.id });
    }
    return res2;
  });
  await audit({ orgId, actor: req.user, action: 'scores.saved', entityType: 'batch', entityId: room.batch.id, next: { activity: req.params.id, ...out }, req });
  ok(res, out);
}));

// ------------------------------------------------------------------ gradebook
assessmentRouter.get('/:batchId/gradebook', wrap(async (req, res) => {
  const room = await openRoom(req, parse(uuid, req.params.batchId));
  const q = parse(z.object({
    type: z.enum(['assignment', 'quiz', 'activity']).optional(), category: z.string().trim().max(60).optional(),
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    item: uuid.optional(), learner_id: uuid.optional(), search: z.string().trim().max(100).optional(),
  }), req.query);
  const bid = room.batch.id;

  // Columns = every gradable item of the batch (so completion counts items nobody has been scored on yet).
  const cols = [
    ...(await query(`SELECT id, 'assignment' AS type, title AS name, 'Assignment' AS category, max_marks AS max, COALESCE(due_at, created_at) AS at FROM assignments WHERE batch_id = $1 AND deleted_at IS NULL`, [bid])),
    ...(await query(`SELECT q.id, 'quiz' AS type, q.title AS name, 'Quiz' AS category, (SELECT COALESCE(SUM(marks),0) FROM questions WHERE quiz_id = q.id) AS max, COALESCE(q.closes_at, q.created_at) AS at FROM quizzes q WHERE q.batch_id = $1 AND q.deleted_at IS NULL AND q.published = TRUE`, [bid])),
    ...(await query(`SELECT id, 'activity' AS type, name, COALESCE(category, 'Activity') AS category, max_score AS max, COALESCE(held_on, created_at) AS at FROM activities WHERE batch_id = $1 AND deleted_at IS NULL`, [bid])),
  ].map((c: any) => ({ key: `${c.type}:${c.id}`, id: c.id, type: c.type as string, name: c.name as string, category: c.category as string, max: Number(c.max), at: c.at }))
    .filter((c) => (!q.type || c.type === q.type) && (!q.category || c.category.toLowerCase() === q.category.toLowerCase()) && (!q.item || c.id === q.item)
      && (!q.from || new Date(c.at) >= new Date(`${q.from}T00:00:00`)) && (!q.to || new Date(c.at) <= new Date(`${q.to}T23:59:59`)))
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

  // Rows: managers see the whole batch; a learner or parent sees only their own row.
  const lp = new Params();
  const where = [`m.batch_id = ${lp.add(bid)}`, `m.status = 'active'`, 'l.deleted_at IS NULL'];
  if (!room.canManage) { const me = viewedLearner(room, q.learner_id); where.push(me ? `l.id = ${lp.add(me)}` : 'FALSE'); }
  else if (q.learner_id) where.push(`l.id = ${lp.add(q.learner_id)}`);
  if (q.search && room.canManage) { const s = `%${q.search.replace(/[%_\\]/g, '\\$&')}%`; where.push(`(l.full_name LIKE ${lp.add(s)} OR l.learner_code LIKE ${lp.add(s)})`); }
  const learners = await query(`SELECT l.id, l.full_name, l.learner_code FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id WHERE ${where.join(' AND ')} ORDER BY l.full_name, l.id LIMIT 1000`, lp.values);

  const cells = new Map<string, any>();
  if (learners.length && cols.length) {
    const sp = new Params();
    const rows = await query(`SELECT id, learner_id, source_type, source_id, score, max_score, feedback, updated_at FROM scores WHERE batch_id = ${sp.add(bid)} AND deleted_at IS NULL AND learner_id IN ${sp.in(learners.map((l) => l.id))}`, sp.values);
    for (const s of rows) cells.set(`${s.learner_id}|${s.source_type}:${s.source_id}`, s);
  }
  const colByKey = new Map(cols.map((c) => [c.key, c]));
  const out = learners.map((l) => {
    const mine: Record<string, any> = {}; const scored: { score: number; max: number; at: any }[] = [];
    for (const c of cols) {
      const s = cells.get(`${l.id}|${c.key}`);
      if (!s) continue;
      mine[c.key] = { score_id: s.id, score: Number(s.score), max: Number(s.max_score), pct: pct(Number(s.score), Number(s.max_score)), feedback: s.feedback };
      scored.push({ score: Number(s.score), max: Number(s.max_score), at: colByKey.get(c.key)!.at });
    }
    return { learner_id: l.id, full_name: l.full_name, ...(room.canManage ? { learner_code: l.learner_code } : {}), cells: mine, summary: summarize(scored, cols.length) };
  });
  const avgs = out.map((r) => r.summary.average_pct).filter((x): x is number => x !== null);
  ok(res, {
    columns: cols, rows: out, can_manage: room.canManage,
    batch_summary: room.canManage ? { learners: out.length, items: cols.length, average_pct: avgs.length ? Math.round((avgs.reduce((s, x) => s + x, 0) / avgs.length) * 100) / 100 : null } : undefined,
  });
}));

// ------------------------------------------------------------------ scores of a learner (any batch)
scoresRouter.get('/', wrap(async (req, res) => {
  const user = req.user!; const orgId = orgIdOf(req);
  const q = parse(z.object({ learner_id: uuid.optional(), batch_id: uuid.optional(), course_id: uuid.optional(), type: z.enum(['assignment', 'quiz', 'activity']).optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const learnerId = q.learner_id ?? user.access.ownLearnerIds[0];
  if (!learnerId) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const lp = new Params(); const scope = learnerScope(user, lp, 'l');
  if (!(await queryOne(`SELECT 1 FROM learners l WHERE l.id = ${lp.add(learnerId)} AND l.org_id = ${lp.add(orgId)} AND l.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}`, lp.values))) throw notFound('Learner');
  const p = new Params();
  const where = [`s.org_id = ${p.add(orgId)}`, `s.learner_id = ${p.add(learnerId)}`, 's.deleted_at IS NULL', 'b.deleted_at IS NULL'];
  // Staff only see scores from batches inside their own scope.
  if (!user.access.orgWide && !user.access.ownLearnerIds.includes(learnerId)) {
    const parts: string[] = [];
    if (user.access.branchIds.length) parts.push(`b.branch_id IN ${p.in(user.access.branchIds)}`);
    if (user.access.teacher) parts.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships st WHERE st.batch_id = b.id AND st.teacher_user_id = ${p.add(user.id)} AND st.status = 'active')`);
    where.push(parts.length ? `(${parts.join(' OR ')})` : 'FALSE');
  }
  if (q.batch_id) where.push(`s.batch_id = ${p.add(q.batch_id)}`);
  if (q.course_id) where.push(`b.course_id = ${p.add(q.course_id)}`);
  if (q.type) where.push(`s.source_type = ${p.add(q.type)}`);
  if (q.from) where.push(`s.updated_at >= ${p.add(`${q.from} 00:00:00`)}`);
  if (q.to) where.push(`s.updated_at <= ${p.add(`${q.to} 23:59:59`)}`);
  const rows = await query(
    `SELECT s.id, s.batch_id, b.name AS batch_name, c.name AS course_name, s.source_type, s.source_id, s.activity_name, s.category, s.score, s.max_score, s.feedback, s.created_at, s.updated_at, t.full_name AS scored_by
       FROM scores s JOIN batches b ON b.id = s.batch_id JOIN courses c ON c.id = b.course_id JOIN users t ON t.id = s.teacher_user_id
      WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC, s.id LIMIT 500`, p.values);
  const items = rows.map((r) => ({ ...r, score: Number(r.score), max_score: Number(r.max_score), pct: pct(Number(r.score), Number(r.max_score)), band: band(pct(Number(r.score), Number(r.max_score))) }));
  ok(res, items, { learner_id: learnerId, summary: summarize(items.map((i) => ({ score: i.score, max: i.max_score, at: i.updated_at }))) });
}));

scoresRouter.get('/:id/history', wrap(async (req, res) => {
  const s = await queryOne(`SELECT id, batch_id, learner_id, activity_name FROM scores WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!s) throw notFound('Score');
  const room = await openRoom(req, s.batch_id);
  if (!room.canManage && !req.user!.access.ownLearnerIds.includes(s.learner_id)) throw notFound('Score');
  const rows = await query(
    `SELECT h.id, h.action, h.previous_score, h.new_score, h.previous_max, h.new_max, h.previous_feedback, h.new_feedback, h.changed_at, u.full_name AS changed_by
       FROM score_history h JOIN users u ON u.id = h.changed_by WHERE h.score_id = $1 ORDER BY h.changed_at DESC, h.id DESC`, [s.id]);
  ok(res, rows.map((r) => ({ ...r, previous_score: num(r.previous_score), new_score: num(r.new_score), previous_max: num(r.previous_max), new_max: num(r.new_max) })), { activity_name: s.activity_name });
}));

scoresRouter.delete('/:id', wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const s = await queryOne(`SELECT id, batch_id FROM scores WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [parse(uuid, req.params.id), orgId]);
  if (!s) throw notFound('Score');
  const room = await openRoom(req, s.batch_id);
  assertManage(room);
  await tx((db) => removeScore(db, orgId, req.user!.id, s.id));
  await audit({ orgId, actor: req.user, action: 'score.deleted', entityType: 'score', entityId: s.id, req });
  ok(res, { id: s.id, deleted: true });
}));
