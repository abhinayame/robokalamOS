import { z } from 'zod';
import { Params, query, queryOne } from '../../db/pool.js';
import { csvList, uuid } from '../../lib/http.js';
import { batchScope, learnerScope } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';
import { attendancePct } from '../attendance/time.js';
import { LEAD_STATUSES } from '../learners/filters.js';
import { getLevels, levelFor } from '../gamification/xp.js';
import { batchMetrics, combine, distinctLearners } from '../analytics/metrics.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const filterSchema = z.object({
  batch_id: csvList(uuid), course_id: uuid.optional(), program_id: uuid.optional(), branch_id: uuid.optional(),
  from: date.optional(), to: date.optional(), status: z.string().max(60).optional(), type: z.enum(['assignment', 'quiz', 'activity']).optional(), counsellor_id: uuid.optional(),
});
export type Filters = z.infer<typeof filterSchema>;
export type Row = Record<string, string | number | null>;
export interface Column { key: string; label: string; kind?: 'text' | 'number' | 'percent' | 'date' }
export interface Ctx { user: AuthUser; orgId: string; limit: number }
export interface ReportDef {
  id: string; title: string; description: string; filters: (keyof Filters)[]; columns: Column[];
  /** Extra permission the data behind the report needs. */
  needs?: string; adminOnly?: boolean;
  run(c: Ctx, f: Filters): Promise<Row[]>;
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const t = (c: string, label: string): Column => ({ key: c, label });
const n = (c: string, label: string): Column => ({ key: c, label, kind: 'number' });
const pc = (c: string, label: string): Column => ({ key: c, label, kind: 'percent' });
const dt = (c: string, label: string): Column => ({ key: c, label, kind: 'date' });
const day = (d: string) => `${d} 00:00:00`;
const after = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return `${x.toISOString().slice(0, 10)} 00:00:00`; };
const iso = (v: unknown) => (v ? String(v).slice(0, 16).replace('T', ' ') : null);
const chunks = <T,>(a: T[], k = 500) => Array.from({ length: Math.ceil(a.length / k) }, (_, i) => a.slice(i * k, i * k + k));

/** Batches the caller may see, narrowed by the common filters. */
function batchWhere(c: Ctx, f: Filters, p: Params, b = 'b') {
  const w = [`${b}.org_id = ${p.add(c.orgId)}`, `${b}.deleted_at IS NULL`];
  const sc = batchScope(c.user, p, b); if (sc) w.push(sc);
  if (f.batch_id?.length) w.push(`${b}.id IN ${p.in(f.batch_id)}`);
  if (f.course_id) w.push(`${b}.course_id = ${p.add(f.course_id)}`);
  if (f.program_id) w.push(`${b}.program_id = ${p.add(f.program_id)}`);
  if (f.branch_id) w.push(`${b}.branch_id = ${p.add(f.branch_id)}`);
  if (f.status) w.push(`${b}.status = ${p.add(f.status)}`);
  return w.join(' AND ');
}
async function visibleBatches(c: Ctx, f: Filters) {
  const p = new Params();
  return query(`SELECT b.id, b.batch_code, b.name, b.status, b.capacity, b.course_id, b.program_id, b.branch_id, c.name AS course_name, pr.name AS program_name, br.name AS branch_name
      FROM batches b JOIN courses c ON c.id = b.course_id JOIN programs pr ON pr.id = b.program_id LEFT JOIN branches br ON br.id = b.branch_id WHERE ${batchWhere(c, f, p)} ORDER BY b.name LIMIT ${c.limit}`, p.values);
}
/** Learners the caller may see who have an ACTIVE membership in the filtered batches (or all in scope when no batch filter). */
function learnerWhereFor(c: Ctx, f: Filters, p: Params) {
  const w = [`l.org_id = ${p.add(c.orgId)}`, 'l.deleted_at IS NULL'];
  const sc = learnerScope(c.user, p, 'l'); if (sc) w.push(sc);
  if (f.branch_id) w.push(`l.branch_id = ${p.add(f.branch_id)}`);
  if (f.status) w.push(`l.status = ${p.add(f.status)}`); else w.push(`l.status IN ('active','inactive')`);
  if (f.batch_id?.length || f.course_id || f.program_id) {
    const m: string[] = [];
    if (f.batch_id?.length) m.push(`m.batch_id IN ${p.in(f.batch_id)}`); if (f.course_id) m.push(`b.course_id = ${p.add(f.course_id)}`); if (f.program_id) m.push(`b.program_id = ${p.add(f.program_id)}`);
    w.push(`EXISTS (SELECT 1 FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id WHERE m.learner_id = l.id AND m.status = 'active' AND ${m.join(' AND ')})`);
  }
  return w.join(' AND ');
}

const metricCols = [n('learners', 'Active learners'), pc('attendance_pct', 'Attendance %'), pc('assignment_completion_pct', 'Assignment completion %'), pc('avg_score_pct', 'Average score %'), n('xp', 'XP'), n('badges', 'Badges'), pc('retention_pct', 'Retention %')];

export const REPORTS: ReportDef[] = [
  {
    id: 'learner', title: 'Learner report', description: 'One row per learner: batches, attendance, scores, assignments, XP and badges.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'status', 'from', 'to'],
    columns: [t('code', 'Learner ID'), t('name', 'Name'), t('status', 'Status'), t('batches', 'Batches'), t('courses', 'Courses'), pc('attendance_pct', 'Attendance %'), pc('avg_score_pct', 'Average score %'), n('assignments_done', 'Assignments done'), n('assignments_total', 'Assignments set'), n('xp', 'XP'), n('badges', 'Badges'), dt('enrolled', 'Enrolled on')],
    async run(c, f) {
      const p = new Params();
      const ls = await query(`SELECT l.id, l.learner_code, l.full_name, l.status, l.enrolled_on FROM learners l WHERE ${learnerWhereFor(c, f, p)} ORDER BY l.full_name, l.id LIMIT ${c.limit}`, p.values);
      const by = <T,>() => new Map<string, T>(); const att = by<any>(), sc = by<any>(), xp = by<any>(), bd = by<any>(), asg = by<any>(), bt = by<string[]>(), cs = by<Set<string>>();
      for (const part of chunks(ls.map((l) => l.id))) {
        let q = new Params(); const ids = q.in(part);
        for (const r of await query(`SELECT m.learner_id, b.name, co.name AS course FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses co ON co.id = b.course_id WHERE m.learner_id IN ${ids} AND m.status = 'active' AND b.deleted_at IS NULL ORDER BY b.name`, q.values)) { bt.set(r.learner_id, [...(bt.get(r.learner_id) ?? []), r.name]); cs.set(r.learner_id, (cs.get(r.learner_id) ?? new Set()).add(r.course)); }
        q = new Params(); const a = [`a.learner_id IN ${q.in(part)}`, `s.status <> 'cancelled'`]; if (f.from) a.push(`s.starts_at >= ${q.add(day(f.from))}`); if (f.to) a.push(`s.starts_at < ${q.add(after(f.to))}`);
        for (const r of await query(`SELECT a.learner_id, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE ${a.join(' AND ')} GROUP BY a.learner_id`, q.values)) att.set(r.learner_id, { present: Number(r.present), late: Number(r.late), absent: Number(r.absent) });
        q = new Params(); const s2 = [`learner_id IN ${q.in(part)}`, 'deleted_at IS NULL']; if (f.from) s2.push(`updated_at >= ${q.add(day(f.from))}`); if (f.to) s2.push(`updated_at < ${q.add(after(f.to))}`);
        for (const r of await query(`SELECT learner_id, AVG(score / max_score * 100) AS pct FROM scores WHERE ${s2.join(' AND ')} GROUP BY learner_id`, q.values)) sc.set(r.learner_id, r2(Number(r.pct)));
        q = new Params(); const x = [`learner_id IN ${q.in(part)}`]; if (f.from) x.push(`created_at >= ${q.add(day(f.from))}`); if (f.to) x.push(`created_at < ${q.add(after(f.to))}`);
        for (const r of await query(`SELECT learner_id, SUM(points) AS n FROM xp_transactions WHERE ${x.join(' AND ')} GROUP BY learner_id`, q.values)) xp.set(r.learner_id, Number(r.n));
        q = new Params();
        for (const r of await query(`SELECT learner_id, COUNT(*) AS n FROM learner_badges WHERE learner_id IN ${q.in(part)} AND revoked_at IS NULL GROUP BY learner_id`, q.values)) bd.set(r.learner_id, Number(r.n));
        q = new Params();
        for (const r of await query(`SELECT m.learner_id, COUNT(a.id) AS total, COALESCE(SUM(sub.status IN ('submitted','late','evaluated')), 0) AS done FROM learner_batch_memberships m JOIN assignments a ON a.batch_id = m.batch_id AND a.deleted_at IS NULL
            LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.learner_id = m.learner_id WHERE m.learner_id IN ${q.in(part)} AND m.status = 'active' GROUP BY m.learner_id`, q.values)) asg.set(r.learner_id, { total: Number(r.total), done: Number(r.done) });
      }
      return ls.map((l) => ({ code: l.learner_code, name: l.full_name, status: l.status, batches: (bt.get(l.id) ?? []).join(', '), courses: [...(cs.get(l.id) ?? [])].join(', '),
        attendance_pct: att.has(l.id) ? attendancePct(att.get(l.id)) : null, avg_score_pct: sc.get(l.id) ?? null, assignments_done: asg.get(l.id)?.done ?? 0, assignments_total: asg.get(l.id)?.total ?? 0, xp: xp.get(l.id) ?? 0, badges: bd.get(l.id) ?? 0, enrolled: l.enrolled_on ? String(l.enrolled_on).slice(0, 10) : null }));
    },
  },
  {
    id: 'batch', title: 'Batch report', description: 'One row per batch with the headline numbers side by side.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'status', 'from', 'to'],
    columns: [t('code', 'Batch code'), t('name', 'Batch'), t('course', 'Course'), t('program', 'Program'), t('branch', 'Branch'), t('status', 'Status'), t('teachers', 'Teachers'), ...metricCols, n('capacity', 'Capacity'), n('classes_held', 'Classes held')],
    async run(c, f) {
      const bs = await visibleBatches(c, f); const m = await batchMetrics(bs.map((b) => b.id), f);
      const tp = new Params(); const tn = new Map<string, string[]>();
      if (bs.length) for (const r of await query(`SELECT t.batch_id, u.full_name FROM teacher_batch_memberships t JOIN users u ON u.id = t.teacher_user_id WHERE t.status = 'active' AND t.batch_id IN ${tp.in(bs.map((b) => b.id))} ORDER BY t.role = 'lead' DESC, u.full_name`, tp.values)) tn.set(r.batch_id, [...(tn.get(r.batch_id) ?? []), r.full_name]);
      return bs.map((b) => { const x = m.get(b.id)!; return { code: b.batch_code, name: b.name, course: b.course_name, program: b.program_name, branch: b.branch_name ?? null, status: b.status, teachers: (tn.get(b.id) ?? []).join(', '), learners: x.learners_active, attendance_pct: x.attendance.pct, assignment_completion_pct: x.assignments.completion_pct, avg_score_pct: x.scores.avg_pct, xp: x.xp.net, badges: x.badges, retention_pct: x.retention_pct, capacity: b.capacity, classes_held: x.classes.held }; });
    },
  },
  ...(['course', 'program'] as const).map((kind): ReportDef => ({
    id: kind, title: `${kind === 'course' ? 'Course' : 'Program'} report`, description: `Every ${kind} with unique learners across all of its batches and the combined numbers.`, filters: ['course_id', 'program_id', 'branch_id', 'status', 'from', 'to'],
    columns: [t('name', kind === 'course' ? 'Course' : 'Program'), ...(kind === 'course' ? [t('program', 'Program')] : []), n('batches', 'Batches'), n('unique_learners', 'Unique learners'), n('memberships', 'Memberships'), pc('attendance_pct', 'Attendance %'), pc('assignment_completion_pct', 'Assignment completion %'), pc('avg_score_pct', 'Average score %'), n('xp', 'XP'), n('badges', 'Badges'), pc('retention_pct', 'Retention %')],
    async run(c, f) {
      const bs = await visibleBatches(c, { ...f, batch_id: undefined }); const m = await batchMetrics(bs.map((b) => b.id), f);
      const groups = new Map<string, { name: string; program?: string; batches: any[] }>();
      for (const b of bs) { const k = kind === 'course' ? b.course_id : b.program_id; const g: { name: string; program?: string; batches: any[] } = groups.get(k) ?? { name: kind === 'course' ? b.course_name : b.program_name, program: b.program_name, batches: [] }; g.batches.push(b); groups.set(k, g); }
      const out: Row[] = [];
      for (const [, g] of groups) {
        const ids = g.batches.map((b) => b.id); const p = new Params();
        // Unique learners come from SQL (distinct learner_id), because summing batch counts would double-count people in several batches.
        const uniq = await distinctLearners(`m.status = 'active' AND m.batch_id IN ${p.in(ids)}`, p.values);
        const x = combine(ids.map((id) => m.get(id)!));
        out.push({ name: g.name, ...(kind === 'course' ? { program: g.program ?? null } : {}), batches: ids.length, unique_learners: uniq, memberships: x.memberships, attendance_pct: x.attendance_pct, assignment_completion_pct: x.assignment_completion_pct, avg_score_pct: x.avg_score_pct, xp: x.xp, badges: x.badges, retention_pct: x.retention_pct });
      }
      return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    },
  })),
  {
    id: 'teacher', title: 'Teacher report', description: 'Workload and follow-through for each teacher: classes, attendance sheets, assignments, evaluations and awards.', filters: ['from', 'to'], adminOnly: true,
    columns: [t('name', 'Teacher'), t('email', 'Email'), n('batches', 'Active batches'), n('learners', 'Unique learners'), n('classes_held', 'Classes held'), n('classes_cancelled', 'Classes cancelled'), pc('sheets_marked_pct', 'Held classes with attendance %'), n('assignments', 'Assignments created'), n('pending', 'Waiting for evaluation'), n('evaluated', 'Evaluated'), n('avg_turnaround_hours', 'Avg hours to evaluate'), n('badges', 'Badges awarded'), n('xp', 'XP awarded')],
    async run(c, f) {
      const tp = new Params(); const w = [`u.org_id = ${tp.add(c.orgId)}`, 'u.deleted_at IS NULL', `EXISTS (SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = u.id AND r.code = 'teacher')`];
      if (!c.user.isSuperAdmin && !c.user.access.orgWide) { const bs = batchScope(c.user, tp, 'b'); w.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships tm JOIN batches b ON b.id = tm.batch_id WHERE tm.teacher_user_id = u.id AND tm.status = 'active' AND ${bs})`); }
      const ts = await query(`SELECT u.id, u.full_name, u.email FROM users u WHERE ${w.join(' AND ')} ORDER BY u.full_name LIMIT ${c.limit}`, tp.values);
      const out: Row[] = [];
      for (const u of ts) {
        const r = (sql: string, extra: unknown[] = []) => queryOne(sql, [u.id, ...extra]);
        const rng = (col: string) => `${f.from ? ` AND ${col} >= '${day(f.from)}'` : ''}${f.to ? ` AND ${col} < '${after(f.to)}'` : ''}`;   // dates are validated YYYY-MM-DD by the schema
        const mine = `EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = x.batch_id AND t.teacher_user_id = $1 AND t.status = 'active')`;
        const b = await r(`SELECT COUNT(*) AS n FROM teacher_batch_memberships WHERE teacher_user_id = $1 AND status = 'active'`);
        const l = await r(`SELECT COUNT(DISTINCT m.learner_id) AS n FROM learner_batch_memberships m JOIN teacher_batch_memberships t ON t.batch_id = m.batch_id AND t.teacher_user_id = $1 AND t.status = 'active' WHERE m.status = 'active'`);
        const s = await r(`SELECT COALESCE(SUM(x.status = 'completed'), 0) AS held, COALESCE(SUM(x.status = 'cancelled'), 0) AS cancelled, COALESCE(SUM(x.status = 'completed' AND EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = x.id)), 0) AS marked FROM class_sessions x WHERE ${mine}${rng('x.starts_at')}`);
        const a = await r(`SELECT COUNT(*) AS n FROM assignments x WHERE x.deleted_at IS NULL AND ${mine}${rng('x.created_at')}`);
        const pend = await r(`SELECT COUNT(*) AS n FROM submissions sub JOIN assignments x ON x.id = sub.assignment_id AND x.deleted_at IS NULL WHERE sub.status IN ('submitted','late') AND ${mine}`);
        const ev = await r(`SELECT COUNT(*) AS n, AVG(TIMESTAMPDIFF(MINUTE, sub.submitted_at, sub.evaluated_at)) / 60 AS hrs FROM submissions sub JOIN assignments x ON x.id = sub.assignment_id AND x.deleted_at IS NULL WHERE sub.status = 'evaluated' AND sub.evaluated_by = $1${rng('sub.evaluated_at')}`);
        const bd = await r(`SELECT COUNT(*) AS n FROM learner_badges x WHERE x.awarded_by = $1 AND x.revoked_at IS NULL${rng('x.awarded_at')}`);
        const xpq = await r(`SELECT COALESCE(SUM(GREATEST(x.points, 0)), 0) AS n FROM xp_transactions x WHERE x.created_by = $1${rng('x.created_at')}`);
        const held = Number(s!.held);
        out.push({ name: u.full_name, email: u.email, batches: Number(b!.n), learners: Number(l!.n), classes_held: held, classes_cancelled: Number(s!.cancelled), sheets_marked_pct: held ? r2((Number(s!.marked) / held) * 100) : null, assignments: Number(a!.n), pending: Number(pend!.n), evaluated: Number(ev!.n), avg_turnaround_hours: ev!.hrs == null ? null : r2(Number(ev!.hrs)), badges: Number(bd!.n), xp: Number(xpq!.n) });
      }
      return out;
    },
  },
  {
    id: 'attendance', title: 'Attendance report', description: 'Present, late, absent and excused per learner per batch. Batches are never merged.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'from', 'to'],
    columns: [t('batch', 'Batch'), t('code', 'Learner ID'), t('name', 'Learner'), n('present', 'Present'), n('late', 'Late'), n('absent', 'Absent'), n('excused', 'Excused'), pc('pct', 'Attendance %')],
    async run(c, f) {
      // Batches are walked in name order, a few at a time, and the walk stops once the row limit is reached: an organization-wide
      // report over hundreds of thousands of attendance rows never aggregates more than it will show.
      const bp = new Params();
      const ids = (await query(`SELECT b.id FROM batches b WHERE ${batchWhere(c, f, bp)} ORDER BY b.name, b.id`, bp.values)).map((r) => r.id as string);
      const out: Row[] = [];
      for (let i = 0; i < ids.length && out.length < c.limit; i += 20) {
        const p = new Params(); const w = [`a.batch_id IN ${p.in(ids.slice(i, i + 20))}`, `s.status <> 'cancelled'`, 'l.deleted_at IS NULL']; const ls = learnerScope(c.user, p, 'l'); if (ls) w.push(ls);
        if (f.from) w.push(`s.starts_at >= ${p.add(day(f.from))}`); if (f.to) w.push(`s.starts_at < ${p.add(after(f.to))}`);
        const rows = await query(`SELECT b.name AS batch, l.learner_code, l.full_name, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused
          FROM attendance a JOIN class_sessions s ON s.id = a.session_id JOIN batches b ON b.id = a.batch_id JOIN learners l ON l.id = a.learner_id WHERE ${w.join(' AND ')} GROUP BY a.batch_id, a.learner_id, b.name, l.learner_code, l.full_name ORDER BY b.name, l.full_name`, p.values);
        for (const r of rows) { const x = { present: Number(r.present), late: Number(r.late), absent: Number(r.absent) }; out.push({ batch: r.batch, code: r.learner_code, name: r.full_name, ...x, excused: Number(r.excused), pct: attendancePct(x) }); }
      }
      return out.slice(0, c.limit);
    },
  },
  {
    id: 'score', title: 'Score report', description: 'Every recorded score (assignments, quizzes, activities) with percentage and who scored it.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'type', 'from', 'to'],
    columns: [t('batch', 'Batch'), t('code', 'Learner ID'), t('name', 'Learner'), t('type', 'Type'), t('activity', 'Activity'), t('category', 'Category'), n('score', 'Score'), n('max', 'Maximum'), pc('pct', 'Percentage'), t('scored_by', 'Scored by'), dt('at', 'Updated')],
    async run(c, f) {
      const p = new Params(); const w = [batchWhere(c, f, p), `s.org_id = ${p.add(c.orgId)}`, 's.deleted_at IS NULL', 'l.deleted_at IS NULL']; const ls = learnerScope(c.user, p, 'l'); if (ls) w.push(ls);
      if (f.type) w.push(`s.source_type = ${p.add(f.type)}`); if (f.from) w.push(`s.updated_at >= ${p.add(day(f.from))}`); if (f.to) w.push(`s.updated_at < ${p.add(after(f.to))}`);
      // With no batch-level filter the newest rows come straight off the (org, updated_at) index instead of sorting every score.
      const broad = !f.batch_id?.length && !f.course_id && !f.program_id && !f.branch_id && !f.status;
      const rows = await query(`SELECT b.name AS batch, l.learner_code, l.full_name, s.source_type, s.activity_name, s.category, s.score, s.max_score, s.updated_at, u.full_name AS by_name
        FROM scores s ${broad ? 'FORCE INDEX (idx_scores_org_updated)' : ''} JOIN batches b ON b.id = s.batch_id JOIN learners l ON l.id = s.learner_id JOIN users u ON u.id = s.teacher_user_id WHERE ${w.join(' AND ')} ORDER BY s.updated_at DESC, s.id DESC LIMIT ${c.limit}`, p.values);
      return rows.map((r) => ({ batch: r.batch, code: r.learner_code, name: r.full_name, type: r.source_type, activity: r.activity_name, category: r.category, score: Number(r.score), max: Number(r.max_score), pct: r2((Number(r.score) / Number(r.max_score)) * 100), scored_by: r.by_name, at: iso(r.updated_at) }));
    },
  },
  {
    id: 'achievement', title: 'Achievement report', description: 'Badges awarded: who earned what, when, why, and who awarded it.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'from', 'to'],
    columns: [t('code', 'Learner ID'), t('name', 'Learner'), t('badge', 'Badge'), t('category', 'Category'), t('batch', 'Batch'), n('xp', 'XP'), t('reason', 'Reason'), t('awarded_by', 'Awarded by'), dt('at', 'Awarded'), t('state', 'State')],
    async run(c, f) {
      const p = new Params(); const w = ['l.deleted_at IS NULL', `lb.org_id = ${p.add(c.orgId)}`]; const ls = learnerScope(c.user, p, 'l'); if (ls) w.push(ls);
      if (f.batch_id?.length) w.push(`lb.batch_id IN ${p.in(f.batch_id)}`);
      if (f.course_id || f.program_id || f.branch_id) { const bp: string[] = []; if (f.course_id) bp.push(`bb.course_id = ${p.add(f.course_id)}`); if (f.program_id) bp.push(`bb.program_id = ${p.add(f.program_id)}`); if (f.branch_id) bp.push(`bb.branch_id = ${p.add(f.branch_id)}`); w.push(`lb.batch_id IN (SELECT bb.id FROM batches bb WHERE ${bp.join(' AND ')})`); }
      if (f.from) w.push(`lb.awarded_at >= ${p.add(day(f.from))}`); if (f.to) w.push(`lb.awarded_at < ${p.add(after(f.to))}`);
      const rows = await query(`SELECT l.learner_code, l.full_name, bd.name AS badge, bd.category, b.name AS batch, lb.xp_awarded, lb.reason, u.full_name AS by_name, lb.awarded_at, lb.revoked_at
        FROM learner_badges lb JOIN learners l ON l.id = lb.learner_id JOIN badges bd ON bd.id = lb.badge_id JOIN users u ON u.id = lb.awarded_by LEFT JOIN batches b ON b.id = lb.batch_id WHERE ${w.join(' AND ')} ORDER BY lb.awarded_at DESC, lb.id LIMIT ${c.limit}`, p.values);
      return rows.map((r) => ({ code: r.learner_code, name: r.full_name, badge: r.badge, category: r.category, batch: r.batch, xp: Number(r.xp_awarded), reason: r.reason, awarded_by: r.by_name, at: iso(r.awarded_at), state: r.revoked_at ? 'Revoked' : 'Active' }));
    },
  },
  {
    id: 'xp', title: 'XP report', description: 'XP earned and deducted in the period, the current balance and level, per learner.', filters: ['batch_id', 'course_id', 'program_id', 'branch_id', 'from', 'to'],
    columns: [t('code', 'Learner ID'), t('name', 'Learner'), n('earned', 'Earned in period'), n('deducted', 'Deducted in period'), n('net', 'Net in period'), n('balance', 'Balance now'), t('level', 'Level')],
    async run(c, f) {
      const p = new Params(); const ls = await query(`SELECT l.id, l.learner_code, l.full_name FROM learners l WHERE ${learnerWhereFor(c, f, p)} ORDER BY l.full_name, l.id LIMIT ${c.limit}`, p.values);
      const { levels } = await getLevels(c.orgId); const per = new Map<string, any>(); const bal = new Map<string, number>();
      for (const part of chunks(ls.map((l) => l.id))) {
        let q = new Params(); const w = [`learner_id IN ${q.in(part)}`]; if (f.from) w.push(`created_at >= ${q.add(day(f.from))}`); if (f.to) w.push(`created_at < ${q.add(after(f.to))}`);
        for (const r of await query(`SELECT learner_id, COALESCE(SUM(GREATEST(points, 0)), 0) AS e, COALESCE(SUM(LEAST(points, 0)), 0) AS d FROM xp_transactions WHERE ${w.join(' AND ')} GROUP BY learner_id`, q.values)) per.set(r.learner_id, { e: Number(r.e), d: Number(r.d) });
        q = new Params();
        for (const r of await query(`SELECT learner_id, SUM(points) AS n FROM xp_transactions WHERE learner_id IN ${q.in(part)} GROUP BY learner_id`, q.values)) bal.set(r.learner_id, Number(r.n));
      }
      return ls.map((l) => { const x = per.get(l.id) ?? { e: 0, d: 0 }; const b = bal.get(l.id) ?? 0; return { code: l.learner_code, name: l.full_name, earned: x.e, deducted: x.d, net: x.e + x.d, balance: b, level: levelFor(b, levels).level.name }; });
    },
  },
  {
    id: 'crm', title: 'CRM report', description: 'Leads with stage, source, counsellor, interest, follow-ups and activity.', filters: ['status', 'counsellor_id', 'from', 'to'], needs: 'crm:read',
    columns: [t('code', 'Learner ID'), t('name', 'Name'), t('mobile', 'Mobile'), t('stage', 'Stage'), t('temperature', 'Temperature'), t('source', 'Source'), t('counsellor', 'Counsellor'), t('interest', 'Interested in'), dt('next_follow_up', 'Next follow-up'), n('activities', 'Activities'), dt('created', 'Added'), dt('converted', 'Converted')],
    async run(c, f) {
      const p = new Params(); const w = [`l.org_id = ${p.add(c.orgId)}`, 'l.deleted_at IS NULL']; const ls = learnerScope(c.user, p, 'l'); if (ls) w.push(ls);
      if (f.status) { const st = f.status.split(',').filter((x) => (LEAD_STATUSES as readonly string[]).includes(x)); if (st.length) w.push(`cl.lead_status IN ${p.in(st)}`); }
      if (f.counsellor_id) w.push(`cl.counsellor_user_id = ${p.add(f.counsellor_id)}`); if (f.from) w.push(`cl.created_at >= ${p.add(day(f.from))}`); if (f.to) w.push(`cl.created_at < ${p.add(after(f.to))}`);
      const rows = await query(`SELECT l.learner_code, l.full_name, l.mobile, cl.lead_status, cl.temperature, cl.lead_source, cu.full_name AS counsellor, co.name AS course, pr.name AS program, cl.next_follow_up_at, cl.created_at, cl.converted_at,
          (SELECT COUNT(*) FROM crm_activities a WHERE a.learner_id = l.id) AS acts
        FROM crm_leads cl JOIN learners l ON l.id = cl.learner_id LEFT JOIN users cu ON cu.id = cl.counsellor_user_id LEFT JOIN courses co ON co.id = cl.interested_course_id LEFT JOIN programs pr ON pr.id = cl.interested_program_id
        WHERE ${w.join(' AND ')} ORDER BY cl.created_at DESC, l.id LIMIT ${c.limit}`, p.values);
      return rows.map((r) => ({ code: r.learner_code, name: r.full_name, mobile: r.mobile, stage: String(r.lead_status).replace(/_/g, ' '), temperature: r.temperature, source: r.lead_source, counsellor: r.counsellor, interest: r.course ?? r.program ?? null, next_follow_up: iso(r.next_follow_up_at), activities: Number(r.acts), created: iso(r.created_at), converted: iso(r.converted_at) }));
    },
  },
  {
    id: 'communication', title: 'Communication report', description: 'WhatsApp campaigns: audience, delivery results and who sent them.', filters: ['status', 'from', 'to'], needs: 'comms:read',
    columns: [t('name', 'Campaign'), t('template', 'Template'), t('audience', 'Audience'), t('status', 'Status'), n('unique_learners', 'Unique learners'), n('recipients', 'Recipients'), n('sent', 'Sent'), n('delivered', 'Delivered'), n('read', 'Read'), n('failed', 'Failed'), n('skipped', 'Skipped'), t('created_by', 'Created by'), dt('created', 'Created'), dt('finished', 'Finished')],
    async run(c, f) {
      const p = new Params(); const w = [`c.org_id = ${p.add(c.orgId)}`]; if (!c.user.isSuperAdmin && !c.user.access.orgWide) w.push(`c.created_by = ${p.add(c.user.id)}`);
      if (f.status) w.push(`c.status = ${p.add(f.status)}`); if (f.from) w.push(`c.created_at >= ${p.add(day(f.from))}`); if (f.to) w.push(`c.created_at < ${p.add(after(f.to))}`);
      const rows = await query(`SELECT c.name, t.name AS template, c.audience, c.status, c.unique_learners, c.total_recipients, c.skipped, u.full_name AS by_name, c.created_at, c.finished_at,
          (SELECT COALESCE(SUM(r.status IN ('sent','delivered','read')), 0) FROM whatsapp_recipients r WHERE r.campaign_id = c.id) AS sent,
          (SELECT COALESCE(SUM(r.status IN ('delivered','read')), 0) FROM whatsapp_recipients r WHERE r.campaign_id = c.id) AS delivered,
          (SELECT COALESCE(SUM(r.status = 'read'), 0) FROM whatsapp_recipients r WHERE r.campaign_id = c.id) AS rd,
          (SELECT COALESCE(SUM(r.status = 'failed'), 0) FROM whatsapp_recipients r WHERE r.campaign_id = c.id) AS failed
        FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id = c.template_id JOIN users u ON u.id = c.created_by WHERE ${w.join(' AND ')} ORDER BY c.created_at DESC LIMIT ${c.limit}`, p.values);
      return rows.map((r) => ({ name: r.name, template: r.template, audience: r.audience, status: String(r.status).replace(/_/g, ' '), unique_learners: Number(r.unique_learners), recipients: Number(r.total_recipients), sent: Number(r.sent), delivered: Number(r.delivered), read: Number(r.rd), failed: Number(r.failed), skipped: Number(r.skipped), created_by: r.by_name, created: iso(r.created_at), finished: iso(r.finished_at) }));
    },
  },
];
export const findReport = (id: string) => REPORTS.find((r) => r.id === id);
