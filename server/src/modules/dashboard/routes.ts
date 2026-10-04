import { Router, type Request } from 'express';
import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { badRequest, forbidden } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { adminKpis, childProgress, teacherExtras } from '../analytics/dashboard.js';

const router = Router();
router.use(requireOrg);

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Classes derived from each batch's weekly schedule (no fabricated data: only what teachers configured). */
function classesFor(batches: any[], tz: string, daysAhead: number) {
  const out: { date: string; batch_id: string; batch_name: string; batch_code: string; start?: string; end?: string; mode?: string; venue?: string }[] = [];
  const today = new Date();
  for (let i = 0; i <= daysAhead; i++) {
    const d = new Date(today.getTime() + i * 86_400_000);
    const wd = WEEKDAYS.indexOf(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d));
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
    for (const b of batches) {
      const s = b.schedule ?? {};
      if (!Array.isArray(s.days) || !s.days.includes(wd)) continue;
      if (b.start_date && date < b.start_date) continue;
      if (b.end_date && date > b.end_date) continue;
      out.push({ date, batch_id: b.id, batch_name: b.name, batch_code: b.batch_code, start: s.start, end: s.end, mode: s.mode, venue: s.venue });
    }
  }
  return out.sort((a, b) => (a.date + (a.start ?? '')).localeCompare(b.date + (b.start ?? '')));
}

async function orgTz(orgId: string) {
  return (await queryOne(`SELECT timezone FROM organizations WHERE id = $1`, [orgId]))!.timezone as string;
}

async function adminView(req: Request) {
  const orgId = orgIdOf(req);
  const lp = new Params(); lp.add(orgId);
  const ls = learnerScope(req.user!, lp, 'l');
  const lWhere = `l.org_id = $1 AND l.deleted_at IS NULL ${ls ? `AND ${ls}` : ''}`;
  const bp = new Params(); bp.add(orgId);
  const bs = batchScope(req.user!, bp, 'b');
  const bWhere = `b.org_id = $1 AND b.deleted_at IS NULL ${bs ? `AND ${bs}` : ''}`;

  const learners = await queryOne(
    `SELECT COALESCE(SUM(l.status <> 'archived'), 0) AS total,
            COALESCE(SUM(l.status = 'active'), 0) AS active,
            COALESCE(SUM(l.status = 'inactive'), 0) AS inactive,
            COALESCE(SUM(l.status = 'archived'), 0) AS archived,
            COALESCE(SUM(l.status = 'active' AND NOT EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active')), 0) AS without_batch,
            COALESCE(SUM((SELECT COUNT(*) FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active') >= 2), 0) AS multi_batch
       FROM learners l WHERE ${lWhere}`, lp.values);
  const batches = await queryOne(
    `SELECT COALESCE(SUM(b.status <> 'archived'), 0) AS total, COALESCE(SUM(b.status = 'active'), 0) AS active,
            COALESCE(SUM(b.status = 'upcoming'), 0) AS upcoming, COALESCE(SUM(b.status = 'completed'), 0) AS completed,
            COALESCE(SUM(b.status = 'archived'), 0) AS archived FROM batches b WHERE ${bWhere}`, bp.values);
  const teachers = await queryOne(
    `SELECT count(*) AS n FROM users u WHERE u.org_id = $1 AND u.deleted_at IS NULL AND u.status = 'active'
        AND EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'teacher')`, [orgId]);
  const memberships = await queryOne(
    `SELECT count(*) AS n FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id WHERE m.status = 'active' AND ${bWhere.replace('b.org_id = $1', 'b.org_id = $1')}`, bp.values);
  const topBatches = await query(
    `SELECT b.id, b.name, b.batch_code, b.status, b.capacity,
            (SELECT count(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS active_learners
       FROM batches b WHERE ${bWhere} AND b.status IN ('active','upcoming') ORDER BY active_learners DESC, b.name LIMIT 6`, bp.values);
  const trend = await query(
    `SELECT DATE_FORMAT(l.created_at, '%Y-%m') AS month, COUNT(*) AS learners
       FROM learners l WHERE ${lWhere} AND l.created_at >= DATE_SUB(DATE_FORMAT(NOW(), '%Y-%m-01'), INTERVAL 5 MONTH)
      GROUP BY DATE_FORMAT(l.created_at, '%Y-%m') ORDER BY month`, lp.values);
  const recent = await query(
    `SELECT a.id, a.type, a.title, a.occurred_at, l.id AS learner_id, l.full_name, l.learner_code
       FROM learner_activity a JOIN learners l ON l.id = a.learner_id
      WHERE a.org_id = $1 AND l.deleted_at IS NULL ${ls ? `AND ${ls}` : ''} ORDER BY a.occurred_at DESC, a.id DESC LIMIT 10`, lp.values);
  const classRows = await query(`SELECT b.id, b.name, b.batch_code, b.schedule, b.start_date, b.end_date FROM batches b WHERE ${bWhere} AND b.status = 'active'`, bp.values);
  return {
    learners, batches, teachers: teachers!.n, active_memberships: memberships!.n, top_batches: topBatches, enrollment_trend: trend, recent_activity: recent,
    upcoming_classes: classesFor(classRows, await orgTz(orgId), 7).slice(0, 10),
  };
}

async function teacherView(req: Request) {
  const orgId = orgIdOf(req);
  const my = await query(
    `SELECT b.id, b.name, b.batch_code, b.status, b.schedule, b.start_date, b.end_date, t.role, c.name AS course_name,
            (SELECT count(*) FROM learner_batch_memberships m WHERE m.batch_id = b.id AND m.status = 'active') AS active_learners
       FROM teacher_batch_memberships t JOIN batches b ON b.id = t.batch_id JOIN courses c ON c.id = b.course_id
      WHERE t.teacher_user_id = $1 AND t.status = 'active' AND t.org_id = $2 AND b.deleted_at IS NULL AND b.status <> 'archived' ORDER BY b.name`, [req.user!.id, orgId]);
  const uniq = await queryOne(
    `SELECT count(DISTINCT m.learner_id) AS n, count(*) AS memberships
       FROM learner_batch_memberships m JOIN teacher_batch_memberships t ON t.batch_id = m.batch_id AND t.status = 'active' AND t.teacher_user_id = $1
       JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL AND l.status = 'active'
      WHERE m.status = 'active' AND m.org_id = $2`, [req.user!.id, orgId]);
  const classes = classesFor(my.filter((b) => b.status === 'active'), await orgTz(orgId), 7);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: await orgTz(orgId) }).format(new Date());
  return {
    my_batches: my, unique_learners: uniq!.n, batch_memberships: uniq!.memberships,
    today_classes: classes.filter((c) => c.date === today), upcoming_classes: classes.filter((c) => c.date > today).slice(0, 10),
  };
}

async function learnerBatches(ids: string[], orgId: string) {
  if (!ids.length) return [];
  const p = new Params();
  const rows = await query(
    `SELECT m.learner_id, b.id, b.name, b.batch_code, b.status, b.schedule, b.start_date, b.end_date, c.name AS course_name,
            (SELECT JSON_ARRAYAGG(JSON_OBJECT('id', u.id, 'full_name', u.full_name, 'role', t.role))
               FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id WHERE t.batch_id = b.id AND t.status = 'active') AS teachers
       FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id
      WHERE m.learner_id IN ${p.in(ids)} AND m.status = 'active' AND m.org_id = ${p.add(orgId)} AND b.status <> 'archived' ORDER BY b.name`, p.values);
  return rows.map((r) => ({ ...r, teachers: [...(r.teachers ?? [])].sort((a: any, b: any) => (a.role === b.role ? 0 : a.role === 'lead' ? -1 : 1)) }));
}

async function childView(req: Request, ids: string[]) {
  const orgId = orgIdOf(req);
  const tz = await orgTz(orgId);
  const lp = new Params();
  const learners = ids.length ? await query(`SELECT id, learner_code, full_name, status, photo_url, enrolled_on FROM learners WHERE id IN ${lp.in(ids)} AND org_id = ${lp.add(orgId)} AND deleted_at IS NULL ORDER BY full_name`, lp.values) : [];
  const batches = await learnerBatches(ids, orgId);
  return learners.map((l) => {
    const bs = batches.filter((b) => b.learner_id === l.id);
    return { ...l, batches: bs.map(({ learner_id, ...b }) => ({ ...b, teachers: b.teachers ?? [] })), today_classes: classesFor(bs.filter((b) => b.status === 'active'), tz, 0), upcoming_classes: classesFor(bs.filter((b) => b.status === 'active'), tz, 7).slice(0, 8) };
  });
}

router.get('/', requirePerm('dashboard:view'), wrap(async (req, res) => {
  const u = req.user!;
  const { view } = parse(z.object({ view: z.enum(['admin', 'teacher', 'learner', 'parent']).optional() }), req.query);
  const available: string[] = [];
  const staff = u.isSuperAdmin || u.roles.some((r) => ['org_admin', 'branch_admin', 'counsellor', 'accountant'].includes(r));
  if (staff) available.push('admin');
  if (u.roles.includes('teacher')) available.push('teacher');
  if (u.roles.includes('learner')) available.push('learner');
  if (u.roles.includes('parent')) available.push('parent');
  const chosen = view ?? available[0];
  if (!chosen) throw forbidden();
  if (!available.includes(chosen)) throw badRequest('That dashboard is not available for your account.');
  let data: unknown;
  if (chosen === 'admin') { const [view, kpis] = await Promise.all([adminView(req), adminKpis(req)]); data = { ...view, kpis }; }   // independent aggregates: run side by side
  else if (chosen === 'teacher') data = { ...(await teacherView(req)), ...(await teacherExtras(req)) };
  else { const kids = await childView(req, u.access.ownLearnerIds); data = { children: await Promise.all(kids.map(async (k: any) => ({ ...k, progress: await childProgress(k.id, orgIdOf(req)) }))) }; }
  ok(res, { view: chosen, available_views: available, ...(data as object) });
}));

export default router;
