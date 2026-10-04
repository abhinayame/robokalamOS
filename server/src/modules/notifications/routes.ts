import { Router } from 'express';
import { z } from 'zod';
import { exec, query, queryOne } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';

const router = Router();
router.use(requireOrg);   // every user sees only their own notifications; there is no cross-user access

router.get('/', wrap(async (req, res) => {
  const q = parse(z.object({ unread: z.coerce.boolean().optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const where = `n.user_id = $1 AND n.org_id = $2 ${q.unread ? 'AND n.read_at IS NULL' : ''}`;
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where}`, [req.user!.id, orgIdOf(req)]))!.n);
  const rows = await query(
    `SELECT n.id, n.kind, n.title, n.body, n.link, n.read_at, n.created_at, n.learner_id, l.full_name AS learner_name
       FROM notifications n LEFT JOIN learners l ON l.id = n.learner_id WHERE ${where} ORDER BY n.created_at DESC, n.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, [req.user!.id, orgIdOf(req)]);
  const unread = Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND org_id = $2 AND read_at IS NULL`, [req.user!.id, orgIdOf(req)]))!.n);
  ok(res, rows, { page: q.page, page_size: q.page_size, total, unread });
}));

router.get('/unread-count', wrap(async (req, res) => {
  ok(res, { unread: Number((await queryOne(`SELECT COUNT(*) AS n FROM notifications WHERE user_id = $1 AND org_id = $2 AND read_at IS NULL`, [req.user!.id, orgIdOf(req)]))!.n) });
}));

router.post('/read-all', wrap(async (req, res) => {
  const r = await exec(`UPDATE notifications SET read_at = NOW(3) WHERE user_id = $1 AND org_id = $2 AND read_at IS NULL`, [req.user!.id, orgIdOf(req)]);
  ok(res, { updated: r.affectedRows });
}));

router.post('/:id/read', wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const r = await exec(`UPDATE notifications SET read_at = COALESCE(read_at, NOW(3)) WHERE id = $1 AND user_id = $2 AND org_id = $3`, [id, req.user!.id, orgIdOf(req)]);
  if (!r.affectedRows) throw notFound('Notification');
  ok(res, { id, read: true });
}));

export default router;
