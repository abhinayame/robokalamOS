import { Router } from 'express';
import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { ok, paging, parse, wrap } from '../../lib/http.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';

const router = Router();
router.use(requireOrg);

router.get('/', requirePerm('audit:read'), wrap(async (req, res) => {
  const q = parse(paging.extend({ entity_type: z.string().max(40).optional(), entity_id: z.string().max(80).optional(), action: z.string().max(60).optional(), actor_user_id: z.string().uuid().optional() }), req.query);
  const p = new Params();
  const where = [`a.org_id = ${p.add(orgIdOf(req))}`];
  if (q.entity_type) where.push(`a.entity_type = ${p.add(q.entity_type)}`);
  if (q.entity_id) where.push(`a.entity_id = ${p.add(q.entity_id)}`);
  if (q.action) where.push(`a.action LIKE ${p.add(`${q.action}%`)}`);
  if (q.actor_user_id) where.push(`a.actor_user_id = ${p.add(q.actor_user_id)}`);
  const total = (await queryOne(`SELECT count(*) AS n FROM audit_logs a WHERE ${where.join(' AND ')}`, p.values))!.n;
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.previous_data, a.new_data, a.actor_user_id, a.actor_email, a.ip, a.created_at
       FROM audit_logs a WHERE ${where.join(' AND ')} ORDER BY a.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows, { page: q.page, page_size: q.page_size, total });
}));

export default router;
