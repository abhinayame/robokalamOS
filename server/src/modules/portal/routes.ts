import { Router } from 'express';
import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { batchVisibility } from '../attendance/routes.js';

/** Family/learner portal extras: what the existing Phase 2-4 endpoints do not already return. */
const router = Router();
router.use(requireOrg, requirePerm('classroom:read'));

async function visibleLearnerId(req: any, requested?: string) {
  const user = req.user!; const orgId = orgIdOf(req);
  const id = requested ?? user.access.ownLearnerIds[0];
  if (!id) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const p = new Params(); const sc = learnerScope(user, p, 'l');
  if (!(await queryOne(`SELECT 1 FROM learners l WHERE l.id = ${p.add(id)} AND l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values))) throw notFound('Learner');
  return id as string;
}

router.get('/announcements', wrap(async (req, res) => {
  const q = parse(z.object({ learner_id: uuid.optional() }), req.query);
  const lid = await visibleLearnerId(req, q.learner_id);
  const p = new Params();
  const w = [`m.learner_id = ${p.add(lid)}`, `m.status = 'active'`, 'b.deleted_at IS NULL', 'cp.deleted_at IS NULL', `cp.kind IN ('announcement','link')`];
  const vis = batchVisibility(req, p, lid); if (vis) w.push(vis);
  const rows = await query(
    `SELECT cp.id, cp.kind, cp.title, cp.body, cp.url, cp.pinned, cp.created_at, b.id AS batch_id, b.name AS batch_name, u.full_name AS author
       FROM classroom_posts cp JOIN batches b ON b.id = cp.batch_id JOIN learner_batch_memberships m ON m.batch_id = cp.batch_id JOIN users u ON u.id = cp.author_user_id
      WHERE ${w.join(' AND ')} ORDER BY cp.pinned DESC, cp.created_at DESC LIMIT 20`, p.values);
  ok(res, rows.map((r) => ({ ...r, pinned: !!r.pinned })));
}));

/** Teacher feedback in one place: score feedback and feedback on returned/evaluated submissions. */
router.get('/feedback', wrap(async (req, res) => {
  const q = parse(z.object({ learner_id: uuid.optional() }), req.query);
  const lid = await visibleLearnerId(req, q.learner_id);
  const p = new Params();
  const w = [`s.learner_id = ${p.add(lid)}`, 's.deleted_at IS NULL', 'b.deleted_at IS NULL', `s.feedback IS NOT NULL`, `s.feedback <> ''`];
  const vis = batchVisibility(req, p, lid); if (vis) w.push(vis);
  const scores = await query(
    `SELECT 'score' AS kind, s.activity_name AS title, s.feedback, s.score, s.max_score, s.updated_at AS at, b.name AS batch_name, u.full_name AS by_teacher
       FROM scores s JOIN batches b ON b.id = s.batch_id JOIN users u ON u.id = s.teacher_user_id WHERE ${w.join(' AND ')} ORDER BY s.updated_at DESC LIMIT 20`, p.values);
  const p2 = new Params();
  const w2 = [`sub.learner_id = ${p2.add(lid)}`, `sub.status = 'returned'`, `sub.feedback IS NOT NULL`, 'a.deleted_at IS NULL', 'b.deleted_at IS NULL'];
  const vis2 = batchVisibility(req, p2, lid); if (vis2) w2.push(vis2);
  const returned = await query(
    `SELECT 'returned' AS kind, a.title, sub.feedback, NULL AS score, NULL AS max_score, sub.evaluated_at AS at, b.name AS batch_name, u.full_name AS by_teacher
       FROM submissions sub JOIN assignments a ON a.id = sub.assignment_id JOIN batches b ON b.id = a.batch_id LEFT JOIN users u ON u.id = sub.evaluated_by WHERE ${w2.join(' AND ')} ORDER BY sub.evaluated_at DESC LIMIT 20`, p2.values);
  const all = [...scores, ...returned].map((r) => ({ ...r, score: r.score == null ? null : Number(r.score), max_score: r.max_score == null ? null : Number(r.max_score) }))
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()).slice(0, 25);
  ok(res, all);
}));

export default router;
