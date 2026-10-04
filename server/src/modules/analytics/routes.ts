import { Router } from 'express';
import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { attendancePct } from '../attendance/time.js';
import { batchVisibility } from '../attendance/routes.js';

const router = Router();
router.use(requireOrg, requirePerm('classroom:read'));

const monthKeys = (n: number) => { const out: string[] = []; const d = new Date(); d.setUTCDate(1);
  for (let i = n - 1; i >= 0; i--) { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1)); out.push(x.toISOString().slice(0, 7)); } return out; };
const r2 = (n: number) => Math.round(n * 100) / 100;

/** One learner: performance, attendance, XP and badge growth, assignment completion and course progress. Real rows only. */
router.get('/learner', wrap(async (req, res) => {
  const user = req.user!; const orgId = orgIdOf(req);
  const q = parse(z.object({ learner_id: uuid.optional(), months: z.coerce.number().int().min(2).max(24).default(6) }), req.query);
  const lid = q.learner_id ?? user.access.ownLearnerIds[0];
  if (!lid) throw badRequest('Choose a learner.', [{ field: 'learner_id', message: 'This is required.' }]);
  const lp = new Params(); const sc = learnerScope(user, lp, 'l');
  if (!(await queryOne(`SELECT 1 FROM learners l WHERE l.id = ${lp.add(lid)} AND l.org_id = ${lp.add(orgId)} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, lp.values))) throw notFound('Learner');
  const months = monthKeys(q.months); const since = `${months[0]}-01 00:00:00`;
  const idx = new Map(months.map((m, i) => [m, i]));

  // Batches this caller may see for the learner (staff are limited to their own scope).
  const bp = new Params();
  const bvis = batchVisibility(req, bp, lid, 'b');
  const batchRows = await query(
    `SELECT b.id, b.name, b.course_id, c.name AS course_name FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id
      WHERE m.learner_id = ${bp.add(lid)} AND m.status = 'active' AND b.deleted_at IS NULL ${bvis ? `AND ${bvis}` : ''}`, bp.values);
  const batchIds = batchRows.map((b) => b.id as string);
  const inB = (p: Params) => `IN ${p.in(batchIds.length ? batchIds : ['-'])}`;

  const performance = months.map((m) => ({ month: m, avg_pct: null as number | null, scored: 0 }));
  { const p = new Params();
    for (const r of await query(`SELECT DATE_FORMAT(updated_at, '%Y-%m') AS m, AVG(score / max_score * 100) AS pct, COUNT(*) AS n FROM scores WHERE learner_id = ${p.add(lid)} AND deleted_at IS NULL AND batch_id ${inB(p)} AND updated_at >= ${p.add(since)} GROUP BY m`, p.values)) { const i = idx.get(r.m); if (i !== undefined) performance[i] = { month: r.m, avg_pct: r2(Number(r.pct)), scored: Number(r.n) }; } }

  const attendance = months.map((m) => ({ month: m, pct: null as number | null, counted: 0 }));
  { const p = new Params();
    for (const r of await query(`SELECT DATE_FORMAT(s.starts_at, '%Y-%m') AS m, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent
        FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE a.learner_id = ${p.add(lid)} AND a.batch_id ${inB(p)} AND s.status <> 'cancelled' AND s.starts_at >= ${p.add(since)} GROUP BY m`, p.values)) {
      const i = idx.get(r.m); if (i === undefined) continue; const c = { present: Number(r.present), late: Number(r.late), absent: Number(r.absent) }; attendance[i] = { month: r.m, pct: attendancePct(c), counted: c.present + c.late + c.absent }; } }

  // XP and badges: scoped by classroom for staff, but a learner/parent sees their whole ledger.
  const own = user.access.ownLearnerIds.includes(lid) || user.access.orgWide;
  const xp = months.map((m) => ({ month: m, earned: 0, balance: 0 }));
  { const p = new Params(); const scope = own ? '' : `AND batch_id ${inB(p)}`;
    const before = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = ${p.add(lid)} ${scope} AND created_at < ${p.add(since)}`, p.values))!.n);
    const p2 = new Params(); const scope2 = own ? '' : `AND batch_id ${inB(p2)}`;
    for (const r of await query(`SELECT DATE_FORMAT(created_at, '%Y-%m') AS m, SUM(points) AS n FROM xp_transactions WHERE learner_id = ${p2.add(lid)} ${scope2} AND created_at >= ${p2.add(since)} GROUP BY m`, p2.values)) { const i = idx.get(r.m); if (i !== undefined) xp[i].earned = Number(r.n); }
    let bal = before; for (const x of xp) { bal += x.earned; x.balance = bal; } }
  const badges = months.map((m) => ({ month: m, awarded: 0, total: 0 }));
  { const p = new Params();
    const before = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_badges WHERE learner_id = ${p.add(lid)} AND revoked_at IS NULL AND awarded_at < ${p.add(since)}`, p.values))!.n);
    const p2 = new Params();
    for (const r of await query(`SELECT DATE_FORMAT(awarded_at, '%Y-%m') AS m, COUNT(*) AS n FROM learner_badges WHERE learner_id = ${p2.add(lid)} AND revoked_at IS NULL AND awarded_at >= ${p2.add(since)} GROUP BY m`, p2.values)) { const i = idx.get(r.m); if (i !== undefined) badges[i].awarded = Number(r.n); }
    let t = before; for (const b of badges) { t += b.awarded; b.total = t; } }

  // Assignment completion and course progress, per batch (never blended across unrelated batches without saying so).
  const perBatch: any[] = [];
  for (const b of batchRows) {
    const a = await queryOne(
      `SELECT COUNT(*) AS total, COALESCE(SUM(s.status IN ('submitted','late','evaluated')), 0) AS done FROM assignments a LEFT JOIN submissions s ON s.assignment_id = a.id AND s.learner_id = $2
        WHERE a.batch_id = $1 AND a.deleted_at IS NULL`, [b.id, lid]);
    const ss = await queryOne(
      `SELECT COUNT(*) AS held, COALESCE(SUM(at.status IN ('present','late')), 0) AS attended FROM class_sessions s LEFT JOIN attendance at ON at.session_id = s.id AND at.learner_id = $2
        WHERE s.batch_id = $1 AND s.status = 'completed'`, [b.id, lid]);
    perBatch.push({ batch_id: b.id, batch_name: b.name, course_id: b.course_id, course_name: b.course_name, assignments_total: Number(a!.total), assignments_done: Number(a!.done), sessions_held: Number(ss!.held), sessions_attended: Number(ss!.attended) });
  }
  const pctOf = (done: number, total: number) => (total ? r2((done / total) * 100) : null);
  const assignment_completion = perBatch.map((b) => ({ batch_id: b.batch_id, batch_name: b.batch_name, total: b.assignments_total, done: b.assignments_done, pct: pctOf(b.assignments_done, b.assignments_total) }));
  const courses = new Map<string, any>();
  for (const b of perBatch) { const c = courses.get(b.course_id) ?? { course_id: b.course_id, course_name: b.course_name, done: 0, total: 0, assignments_done: 0, assignments_total: 0, sessions_attended: 0, sessions_held: 0 };
    c.assignments_done += b.assignments_done; c.assignments_total += b.assignments_total; c.sessions_attended += b.sessions_attended; c.sessions_held += b.sessions_held; courses.set(b.course_id, c); }
  const course_progress = [...courses.values()].map((c) => ({ ...c, pct: pctOf(c.assignments_done + c.sessions_attended, c.assignments_total + c.sessions_held), basis: 'assignments handed in + classes attended, out of assignments set + classes held' }));
  const all = assignment_completion.reduce((a, b) => ({ done: a.done + b.done, total: a.total + b.total }), { done: 0, total: 0 });
  ok(res, { learner_id: lid, months, performance, attendance, xp, badges, assignment_completion, assignment_completion_overall: { ...all, pct: pctOf(all.done, all.total) }, course_progress });
}));

export default router;
