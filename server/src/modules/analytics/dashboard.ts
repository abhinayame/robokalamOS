import type { Request } from 'express';
import { Params, query, queryOne } from '../../db/pool.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import { orgIdOf } from '../../middleware/auth.js';
import { addDays, attendancePct, zonedToUtc } from '../attendance/time.js';
import { getLevels, levelFor } from '../gamification/xp.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

async function todayBounds(orgId: string) {
  const tz = (await queryOne(`SELECT timezone FROM organizations WHERE id = $1`, [orgId]))!.timezone as string;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
  return { start: zonedToUtc(today, '00:00', tz), end: zonedToUtc(addDays(today, 1), '00:00', tz) };
}
const ts = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

/** Real numbers across everything the caller may see. Missing modules (CRM, WhatsApp) are simply left out for roles without access. */
export async function adminKpis(req: Request) {
  const user = req.user!; const orgId = orgIdOf(req);
  const bp = new Params(); const bs = batchScope(user, bp, 'b');
  const bWhere = `b.org_id = ${bp.add(orgId)} AND b.deleted_at IS NULL ${bs ? `AND ${bs}` : ''}`;
  const lp = new Params(); const ls = learnerScope(user, lp, 'l');
  const lWhere = `l.org_id = ${lp.add(orgId)} AND l.deleted_at IS NULL ${ls ? `AND ${ls}` : ''}`;
  const attP = queryOne(`SELECT COALESCE(SUM(a.status IN ('present','late')), 0) AS ok, COALESCE(SUM(a.status IN ('present','late','absent')), 0) AS n
      FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' JOIN batches b ON b.id = a.batch_id WHERE ${bWhere}`, bp.values);
  const bp2 = new Params(); const bs2 = batchScope(user, bp2, 'b');
  const w2 = `b.org_id = ${bp2.add(orgId)} AND b.deleted_at IS NULL ${bs2 ? `AND ${bs2}` : ''}`;
  const scP = queryOne(`SELECT COUNT(*) AS n, AVG(s.score / s.max_score * 100) AS pct FROM scores s JOIN batches b ON b.id = s.batch_id WHERE s.deleted_at IS NULL AND ${w2}`, bp2.values);
  const bp3 = new Params(); const bs3 = batchScope(user, bp3, 'b');
  const w3 = `b.org_id = ${bp3.add(orgId)} AND b.deleted_at IS NULL ${bs3 ? `AND ${bs3}` : ''}`;
  const pendP = queryOne(`SELECT COUNT(*) AS n FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.deleted_at IS NULL JOIN batches b ON b.id = a.batch_id WHERE s.status IN ('submitted','late') AND ${w3}`, bp3.values);
  const xpP = queryOne(`SELECT COALESCE(SUM(x.points), 0) AS n FROM xp_transactions x JOIN batches b ON b.id = x.batch_id WHERE ${w3}`, bp3.values);
  const badP = queryOne(`SELECT COUNT(*) AS n FROM learner_badges lb JOIN learners l ON l.id = lb.learner_id WHERE lb.revoked_at IS NULL AND ${lWhere}`, lp.values);
  const upP = queryOne(`SELECT COUNT(*) AS n FROM class_sessions s JOIN batches b ON b.id = s.batch_id WHERE s.status IN ('scheduled','started') AND s.starts_at > NOW(3) AND s.starts_at < DATE_ADD(NOW(3), INTERVAL 7 DAY) AND ${w3}`, bp3.values);
  const [att, sc, pend, xp, bad, up] = await Promise.all([attP, scP, pendP, xpP, badP, upP]);
  const out: Record<string, unknown> = {
    pending_evaluations: Number(pend!.n), attendance_pct: attendancePct({ present: Number(att!.ok), late: 0, absent: Number(att!.n) - Number(att!.ok) }),
    avg_score_pct: sc!.pct == null ? null : r2(Number(sc!.pct)), scores_recorded: Number(sc!.n), total_xp: Number(xp!.n), badges_awarded: Number(bad!.n), upcoming_classes_7d: Number(up!.n),
  };
  if (user.isSuperAdmin || user.permissions.has('crm:read')) {
    const cp = new Params(); const cs = learnerScope(user, cp, 'l');
    const row = await queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(cl.lead_status NOT IN ('converted','not_interested','lost')), 0) AS open, COALESCE(SUM(cl.lead_status = 'converted'), 0) AS converted
        FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id WHERE l.org_id = ${cp.add(orgId)} AND l.deleted_at IS NULL ${cs ? `AND ${cs}` : ''}`, cp.values);
    out.crm = { leads: Number(row!.total), open: Number(row!.open), converted: Number(row!.converted) };
  }
  if (user.isSuperAdmin || user.permissions.has('fee:read')) {
    const tz = (await queryOne(`SELECT timezone FROM organizations WHERE id = $1`, [orgId]))?.timezone ?? 'Asia/Kolkata';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
    const fp = new Params(); const fs = learnerScope(user, fp, 'l');
    const row = await queryOne(`SELECT COALESCE(SUM(i.amount - i.paid_amount), 0) AS outstanding, COALESCE(SUM(IF(i.due_date < ${fp.add(today)}, i.amount - i.paid_amount, 0)), 0) AS overdue
        FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' JOIN learners l ON l.id = i.learner_id AND l.deleted_at IS NULL
        WHERE i.org_id = ${fp.add(orgId)} AND i.status IN ('pending','partial') ${fs ? `AND ${fs}` : ''}`, fp.values);
    const mp = new Params(); const ms = learnerScope(user, mp, 'l');
    const paid = await queryOne(`SELECT COALESCE(SUM(p.amount - p.refunded_amount), 0) AS n FROM payments p JOIN learners l ON l.id = p.learner_id WHERE p.org_id = ${mp.add(orgId)} AND p.paid_at >= ${mp.add(`${today.slice(0, 7)}-01 00:00:00`)} ${ms ? `AND ${ms}` : ''}`, mp.values);
    out.fees = { outstanding: Number(row!.outstanding), overdue: Number(row!.overdue), collected_this_month: Number(paid!.n) };
  }
  if (user.isSuperAdmin || user.permissions.has('comms:read')) {
    const p = new Params(); const own = user.isSuperAdmin || user.access.orgWide ? '' : `AND created_by = ${p.add(user.id)}`;
    const row = await queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(status IN ('scheduled','processing')), 0) AS active FROM whatsapp_campaigns WHERE org_id = ${p.add(orgId)} AND status <> 'draft' ${own}`, p.values);
    out.campaigns = { total: Number(row!.total), active: Number(row!.active) };
  }
  return out;
}

export async function teacherExtras(req: Request) {
  const user = req.user!; const orgId = orgIdOf(req);
  const { start, end } = await todayBounds(orgId);
  const mine = `b.org_id = $1 AND b.deleted_at IS NULL AND EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = b.id AND t.teacher_user_id = $2 AND t.status = 'active')`;
  const today = await query(`SELECT s.id, s.batch_id, b.name AS batch_name, s.title, s.starts_at, s.ends_at, s.status, s.meeting_url IS NOT NULL AS has_meeting,
        (SELECT COUNT(*) FROM attendance a WHERE a.session_id = s.id) AS marked
      FROM class_sessions s JOIN batches b ON b.id = s.batch_id WHERE ${mine} AND s.starts_at >= $3 AND s.starts_at < $4 AND s.status <> 'cancelled' ORDER BY s.starts_at`, [orgId, user.id, ts(start), ts(end)]);
  const pending = await query(`SELECT a.id AS assignment_id, a.title, a.batch_id, b.name AS batch_name, COUNT(*) AS n, MIN(s.submitted_at) AS oldest
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.deleted_at IS NULL JOIN batches b ON b.id = a.batch_id WHERE s.status IN ('submitted','late') AND ${mine}
      GROUP BY a.id, a.title, a.batch_id, b.name ORDER BY oldest LIMIT 10`, [orgId, user.id]);
  const recent = await query(`SELECT s.id, s.status, s.submitted_at, l.id AS learner_id, l.full_name, a.id AS assignment_id, a.title, b.name AS batch_name
      FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.deleted_at IS NULL JOIN batches b ON b.id = a.batch_id JOIN learners l ON l.id = s.learner_id
      WHERE s.status IN ('submitted','late','evaluated') AND ${mine} ORDER BY s.submitted_at DESC LIMIT 8`, [orgId, user.id]);
  const num = async (sql: string) => Number((await queryOne(sql, [orgId, user.id]))!.n);
  const assignments = await num(`SELECT COUNT(*) AS n FROM assignments a JOIN batches b ON b.id = a.batch_id WHERE a.deleted_at IS NULL AND ${mine}`);
  const badges = await num(`SELECT COUNT(*) AS n FROM learner_badges lb WHERE lb.revoked_at IS NULL AND lb.org_id = $1 AND lb.awarded_by = $2 AND lb.awarded_at > DATE_SUB(NOW(3), INTERVAL 30 DAY)`);
  const att = await queryOne(`SELECT COALESCE(SUM(a.status IN ('present','late')), 0) AS ok, COALESCE(SUM(a.status IN ('present','late','absent')), 0) AS n FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' JOIN batches b ON b.id = a.batch_id WHERE ${mine}`, [orgId, user.id]);
  const sc = await queryOne(`SELECT AVG(s.score / s.max_score * 100) AS pct FROM scores s JOIN batches b ON b.id = s.batch_id WHERE s.deleted_at IS NULL AND ${mine}`, [orgId, user.id]);
  return {
    today_sessions: today.map((s) => ({ ...s, has_meeting: !!s.has_meeting, marked: Number(s.marked) })),
    pending_evaluations: pending.map((r) => ({ ...r, n: Number(r.n) })), pending_evaluations_total: pending.reduce((a, r) => a + Number(r.n), 0),
    recent_submissions: recent, assignments_total: assignments, badges_awarded_30d: badges,
    attendance_pct: attendancePct({ present: Number(att!.ok), late: 0, absent: Number(att!.n) - Number(att!.ok) }), avg_score_pct: sc!.pct == null ? null : r2(Number(sc!.pct)),
  };
}

/** The "MY PROGRESS" block for one learner (their own dashboard, or a child on the parent dashboard). */
export async function childProgress(learnerId: string, orgId: string) {
  const { levels } = await getLevels(orgId);
  const xp = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1`, [learnerId]))!.n);
  const badges = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_badges WHERE learner_id = $1 AND revoked_at IS NULL`, [learnerId]))!.n);
  const sc = await queryOne(`SELECT AVG(s.score / s.max_score * 100) AS pct, COUNT(*) AS n FROM scores s JOIN batches b ON b.id = s.batch_id AND b.deleted_at IS NULL WHERE s.learner_id = $1 AND s.deleted_at IS NULL`, [learnerId]);
  const att = await queryOne(`SELECT COALESCE(SUM(a.status IN ('present','late')), 0) AS ok, COALESCE(SUM(a.status IN ('present','late','absent')), 0) AS n FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' WHERE a.learner_id = $1`, [learnerId]);
  const asg = await queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(sub.status IN ('submitted','late','evaluated')), 0) AS done
      FROM assignments a JOIN learner_batch_memberships m ON m.batch_id = a.batch_id AND m.learner_id = $1 AND m.status = 'active' JOIN batches b ON b.id = a.batch_id AND b.deleted_at IS NULL
      LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.learner_id = m.learner_id WHERE a.deleted_at IS NULL`, [learnerId]);
  const pending = await query(`SELECT a.id, a.title, a.due_at, b.name AS batch_name FROM assignments a JOIN learner_batch_memberships m ON m.batch_id = a.batch_id AND m.learner_id = $1 AND m.status = 'active' JOIN batches b ON b.id = a.batch_id AND b.deleted_at IS NULL
      LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.learner_id = m.learner_id WHERE a.deleted_at IS NULL AND (sub.id IS NULL OR sub.status IN ('draft','returned')) ORDER BY (a.due_at IS NULL), a.due_at LIMIT 5`, [learnerId]);
  const recent = await query(`SELECT s.activity_name, s.score, s.max_score, s.updated_at, b.name AS batch_name FROM scores s JOIN batches b ON b.id = s.batch_id WHERE s.learner_id = $1 AND s.deleted_at IS NULL ORDER BY s.updated_at DESC LIMIT 5`, [learnerId]);
  const classes = await query(`SELECT s.id, s.title, s.starts_at, s.ends_at, s.status, s.meeting_url IS NOT NULL AS has_meeting, b.name AS batch_name FROM class_sessions s JOIN learner_batch_memberships m ON m.batch_id = s.batch_id AND m.learner_id = $1 AND m.status = 'active' JOIN batches b ON b.id = s.batch_id AND b.deleted_at IS NULL
      WHERE s.status IN ('scheduled','started') AND s.starts_at > DATE_SUB(NOW(3), INTERVAL 3 HOUR) ORDER BY s.starts_at LIMIT 5`, [learnerId]);
  const feedback = await query(`SELECT s.activity_name AS title, s.feedback, s.updated_at AS at, u.full_name AS by_teacher FROM scores s JOIN users u ON u.id = s.teacher_user_id WHERE s.learner_id = $1 AND s.deleted_at IS NULL AND s.feedback IS NOT NULL AND s.feedback <> '' ORDER BY s.updated_at DESC LIMIT 3`, [learnerId]);
  const lv = levelFor(xp, levels);
  return {
    xp, level: lv.level.name, level_no: lv.level.level_no, next_level: lv.next?.name ?? null, xp_to_next: lv.xp_to_next, badges,
    avg_score_pct: sc!.pct == null ? null : r2(Number(sc!.pct)), scores_recorded: Number(sc!.n),
    attendance_pct: attendancePct({ present: Number(att!.ok), late: 0, absent: Number(att!.n) - Number(att!.ok) }),
    assignments: { done: Number(asg!.done), total: Number(asg!.total) },
    pending_assignments: pending, recent_scores: recent.map((r) => ({ ...r, score: Number(r.score), max_score: Number(r.max_score) })),
    upcoming_classes: classes.map((c) => ({ ...c, has_meeting: !!c.has_meeting })), feedback,
  };
}
