import { Router } from 'express';
import { z } from 'zod';
import { exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { notifyAbout } from '../../lib/notify.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';
import { assertManage, assertWritable, openRoom } from '../classroom/access.js';

/** Live polls for a class: the teacher asks, learners answer once, everyone sees the counts. Answers are anonymous: counts only, never who chose what. */
const router = Router(); // mounted at /api/polls
router.use(requireOrg);

const shape = async (p: any, room: { canManage: boolean; learnerIds: string[] }, mineOnly?: string | null) => {
  const votes = await query(`SELECT choice, COUNT(*) AS n FROM poll_votes WHERE poll_id = $1 GROUP BY choice`, [p.id]);
  const counts = (p.options as string[]).map((_, i) => Number(votes.find((v) => v.choice === i)?.n ?? 0)); const total = counts.reduce((a, b) => a + b, 0);
  const mine = mineOnly ? (await queryOne(`SELECT choice FROM poll_votes WHERE poll_id = $1 AND learner_id = $2`, [p.id, mineOnly]))?.choice ?? null : null;
  const showResults = room.canManage || p.status === 'closed' || mine !== null;
  return { id: p.id, batch_id: p.batch_id, question: p.question, options: p.options, status: p.status, created_at: p.created_at, my_choice: mine, total, ...(showResults ? { counts } : {}) };
};

router.get('/', wrap(async (req, res) => {
  const batchId = parse(uuid, req.query.batch_id); const room = await openRoom(req, batchId);
  const rows = await query(`SELECT id, batch_id, question, options, status, created_at FROM polls WHERE batch_id = $1 AND org_id = $2 ORDER BY status = 'closed', created_at DESC LIMIT 30`, [batchId, orgIdOf(req)]);
  ok(res, await Promise.all(rows.map((p) => shape(p, room, room.learnerIds[0] ?? null))));
}));
router.post('/', limit('poll', 20), wrap(async (req, res) => {
  const b = parse(z.object({ batch_id: uuid, session_id: uuid.nullish(), question: z.string().trim().min(3, 'Write the question.').max(300), options: z.array(z.string().trim().min(1).max(120)).min(2).max(6) }), req.body); const orgId = orgIdOf(req);
  const room = await openRoom(req, b.batch_id); assertManage(room); assertWritable(room); const id = newId();
  await tx(async (db) => {
    await exec(`INSERT INTO polls (id, org_id, batch_id, session_id, question, options, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [id, orgId, b.batch_id, b.session_id ?? null, b.question, JSON.stringify(b.options), req.user!.id], db);
    const ids = (await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [b.batch_id], db)).map((r) => r.learner_id as string);
    if (ids.length) await notifyAbout(db, { orgId, learnerIds: ids, kind: 'poll.open', title: 'New poll in class', body: b.question.slice(0, 140), link: `/classroom/${b.batch_id}`, excludeUserId: req.user!.id });
  });
  ok(res, { id }, undefined, 201);
}));
router.post('/:id/vote', limit('vote', 60), wrap(async (req, res) => {
  const b = parse(z.object({ choice: z.number().int().min(0).max(5) }), req.body); const orgId = orgIdOf(req);
  const p = await queryOne(`SELECT id, batch_id, options, status FROM polls WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgId]); if (!p) throw notFound('Poll');
  const room = await openRoom(req, p.batch_id); if (!req.user!.roles.includes('learner') || !room.canInteract || !room.learnerIds[0]) throw forbidden('Only learners in this class can vote.');
  if (p.status !== 'open') throw new AppError(409, 'CLOSED', 'This poll is closed.'); if (b.choice >= (p.options as string[]).length) throw new AppError(400, 'BAD_CHOICE', 'Pick one of the options.');
  try { await exec(`INSERT INTO poll_votes (poll_id, learner_id, org_id, choice) VALUES ($1,$2,$3,$4)`, [p.id, room.learnerIds[0], orgId, b.choice]); }
  catch (e: any) { if (e?.errno === 1062) throw new AppError(409, 'VOTED', 'You already voted in this poll.'); throw e; }
  ok(res, await shape({ ...p, question: '', created_at: null }, room, room.learnerIds[0]), undefined, 201);
}));
router.post('/:id/close', wrap(async (req, res) => {
  const p = await queryOne(`SELECT id, batch_id FROM polls WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]); if (!p) throw notFound('Poll');
  const room = await openRoom(req, p.batch_id); assertManage(room);
  await exec(`UPDATE polls SET status = 'closed', closed_at = NOW(3) WHERE id = $1 AND status = 'open'`, [p.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'poll.closed', entityType: 'poll', entityId: p.id, req }); ok(res, { closed: true });
}));
export default router;
