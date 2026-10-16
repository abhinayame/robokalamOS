import { Router } from 'express';
import { z } from 'zod';
import { Params, query } from '../../db/pool.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { batchScope } from '../../lib/scope.js';
import { orgIdOf, requireAnyPerm, requireOrg } from '../../middleware/auth.js';
import { addDays, zonedToUtc } from '../attendance/time.js';
import { orgInfo } from '../fees/service.js';
import { todayIn } from '../fees/money.js';

const router = Router(); // mounted at /api/timetable
router.use(requireOrg, requireAnyPerm('classroom:read'));

const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));

/** The week's classes for whoever is asking: a learner's or child's batches, a teacher's batches, or everything in an admin's reach. */
router.get('/week', wrap(async (req, res) => {
  const q = parse(z.object({ start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query); const orgId = orgIdOf(req); const org = await orgInfo(orgId);
  const start = mondayOf(q.start ?? todayIn(org.tz)); const from = zonedToUtc(start, '00:00', org.tz); const to = zonedToUtc(addDays(start, 7), '00:00', org.tz);
  const p = new Params(); const sc = batchScope(req.user!, p, 'b');
  const rows = await query(`SELECT s.id, s.batch_id, s.title, s.starts_at, s.ends_at, s.status, s.meeting_url IS NOT NULL AS has_link, b.name AS batch_name, c.name AS course_name
      FROM class_sessions s JOIN batches b ON b.id = s.batch_id AND b.deleted_at IS NULL JOIN courses c ON c.id = b.course_id
     WHERE s.org_id = ${p.add(orgId)} AND s.starts_at >= ${p.add(from)} AND s.starts_at < ${p.add(to)} ${sc ? `AND ${sc}` : ''} ORDER BY s.starts_at, s.id LIMIT 500`, p.values);
  ok(res, { start, end: addDays(start, 6), timezone: org.tz, today: todayIn(org.tz), sessions: rows.map((r) => ({ ...r, has_link: !!r.has_link })) });
}));
export default router;
