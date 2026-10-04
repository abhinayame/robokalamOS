import { Params, query, queryOne, type Db } from '../../db/pool.js';
import { attendancePct } from '../attendance/time.js';

export interface Range { from?: string; to?: string }
const r2 = (n: number) => Math.round(n * 100) / 100;
const ratio = (a: number, b: number) => (b > 0 ? r2((a / b) * 100) : null);

export interface BatchMetrics {
  batch_id: string;
  learners_active: number; learners_ever: number; left: number; completed: number;
  attendance: { present: number; late: number; absent: number; excused: number; pct: number | null };
  scores: { scored: number; avg_pct: number | null };
  assignments: { total: number; handed_in: number; expected: number; completion_pct: number | null };
  xp: { net: number; earned: number };
  badges: number;
  classes: { upcoming: number; held: number };
  retention_pct: number | null;
}

const chunks = <T,>(a: T[], n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const dayStart = (d: string) => `${d} 00:00:00`;
const nextDay = (d: string) => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return `${x.toISOString().slice(0, 10)} 00:00:00`; };

/**
 * Raw, additive components per batch (so course / program / organization totals are exact sums,
 * never averages of averages), plus the derived percentages. A handful of grouped queries, never one per batch.
 *  - attendance % = (present + late) / (present + late + absent); excused and unmarked are not counted
 *  - assignment completion = hand-ins by current members / (assignments set × current members)
 *  - retention = current members / (current members + left + transferred); learners who completed are not churn
 */
export async function batchMetrics(ids: string[], range: Range = {}, db?: Db): Promise<Map<string, BatchMetrics>> {
  const out = new Map<string, BatchMetrics>();
  for (const id of ids) out.set(id, { batch_id: id, learners_active: 0, learners_ever: 0, left: 0, completed: 0, attendance: { present: 0, late: 0, absent: 0, excused: 0, pct: null }, scores: { scored: 0, avg_pct: null }, assignments: { total: 0, handed_in: 0, expected: 0, completion_pct: null }, xp: { net: 0, earned: 0 }, badges: 0, classes: { upcoming: 0, held: 0 }, retention_pct: null });
  for (const part of chunks(ids)) {
    const get = (id: string) => out.get(id)!;
    let p = new Params();
    for (const r of await query(`SELECT batch_id, SUM(status = 'active') AS a, SUM(status IN ('left','transferred')) AS l, SUM(status = 'completed') AS c, COUNT(*) AS n FROM learner_batch_memberships WHERE batch_id IN ${p.in(part)} GROUP BY batch_id`, p.values, db)) {
      const m = get(r.batch_id); m.learners_active = Number(r.a); m.left = Number(r.l); m.completed = Number(r.c); m.learners_ever = Number(r.n);
      m.retention_pct = ratio(m.learners_active, m.learners_active + m.left);
    }
    p = new Params(); const att = [`a.batch_id IN ${p.in(part)}`, `s.status <> 'cancelled'`];
    if (range.from) att.push(`s.starts_at >= ${p.add(dayStart(range.from))}`); if (range.to) att.push(`s.starts_at < ${p.add(nextDay(range.to))}`);
    for (const r of await query(`SELECT a.batch_id, SUM(a.status = 'present') AS present, SUM(a.status = 'late') AS late, SUM(a.status = 'absent') AS absent, SUM(a.status = 'excused') AS excused FROM attendance a JOIN class_sessions s ON s.id = a.session_id WHERE ${att.join(' AND ')} GROUP BY a.batch_id`, p.values, db)) {
      const m = get(r.batch_id); const c = { present: Number(r.present), late: Number(r.late), absent: Number(r.absent), excused: Number(r.excused) }; m.attendance = { ...c, pct: attendancePct(c) };
    }
    p = new Params(); const sc = [`batch_id IN ${p.in(part)}`, 'deleted_at IS NULL'];
    if (range.from) sc.push(`updated_at >= ${p.add(dayStart(range.from))}`); if (range.to) sc.push(`updated_at < ${p.add(nextDay(range.to))}`);
    for (const r of await query(`SELECT batch_id, COUNT(*) AS n, AVG(score / max_score * 100) AS pct FROM scores WHERE ${sc.join(' AND ')} GROUP BY batch_id`, p.values, db)) get(r.batch_id).scores = { scored: Number(r.n), avg_pct: r2(Number(r.pct)) };
    p = new Params();
    for (const r of await query(`SELECT batch_id, COUNT(*) AS n FROM assignments WHERE batch_id IN ${p.in(part)} AND deleted_at IS NULL GROUP BY batch_id`, p.values, db)) get(r.batch_id).assignments.total = Number(r.n);
    p = new Params();
    for (const r of await query(`SELECT a.batch_id, COUNT(*) AS n FROM submissions s JOIN assignments a ON a.id = s.assignment_id AND a.deleted_at IS NULL
        JOIN learner_batch_memberships m ON m.batch_id = a.batch_id AND m.learner_id = s.learner_id AND m.status = 'active'
        WHERE a.batch_id IN ${p.in(part)} AND s.status IN ('submitted','late','evaluated') GROUP BY a.batch_id`, p.values, db)) get(r.batch_id).assignments.handed_in = Number(r.n);
    for (const id of part) { const m = get(id); m.assignments.expected = m.assignments.total * m.learners_active; m.assignments.completion_pct = ratio(Math.min(m.assignments.handed_in, m.assignments.expected), m.assignments.expected); }
    p = new Params(); const xq = [`batch_id IN ${p.in(part)}`];
    if (range.from) xq.push(`created_at >= ${p.add(dayStart(range.from))}`); if (range.to) xq.push(`created_at < ${p.add(nextDay(range.to))}`);
    for (const r of await query(`SELECT batch_id, SUM(points) AS net, SUM(GREATEST(points, 0)) AS earned FROM xp_transactions WHERE ${xq.join(' AND ')} GROUP BY batch_id`, p.values, db)) get(r.batch_id).xp = { net: Number(r.net), earned: Number(r.earned) };
    p = new Params(); const bq = [`batch_id IN ${p.in(part)}`, 'revoked_at IS NULL'];
    if (range.from) bq.push(`awarded_at >= ${p.add(dayStart(range.from))}`); if (range.to) bq.push(`awarded_at < ${p.add(nextDay(range.to))}`);
    for (const r of await query(`SELECT batch_id, COUNT(*) AS n FROM learner_badges WHERE ${bq.join(' AND ')} GROUP BY batch_id`, p.values, db)) get(r.batch_id).badges = Number(r.n);
    p = new Params();
    for (const r of await query(`SELECT batch_id, SUM(status IN ('scheduled','started') AND starts_at > NOW(3)) AS up, SUM(status = 'completed') AS held FROM class_sessions WHERE batch_id IN ${p.in(part)} GROUP BY batch_id`, p.values, db)) get(r.batch_id).classes = { upcoming: Number(r.up), held: Number(r.held) };
  }
  return out;
}

/** Sum raw components of several batches (course, program, whole organization). Unique learners must come from SQL, not from here. */
export function combine(ms: BatchMetrics[]) {
  const z = { learners_active: 0, left: 0, attendance: { present: 0, late: 0, absent: 0, excused: 0 }, scored: 0, score_sum: 0, a_total: 0, a_done: 0, a_expected: 0, xp_net: 0, xp_earned: 0, badges: 0, up: 0, held: 0 };
  for (const m of ms) {
    z.learners_active += m.learners_active; z.left += m.left;
    z.attendance.present += m.attendance.present; z.attendance.late += m.attendance.late; z.attendance.absent += m.attendance.absent; z.attendance.excused += m.attendance.excused;
    z.scored += m.scores.scored; z.score_sum += (m.scores.avg_pct ?? 0) * m.scores.scored;
    z.a_total += m.assignments.total; z.a_done += Math.min(m.assignments.handed_in, m.assignments.expected); z.a_expected += m.assignments.expected;
    z.xp_net += m.xp.net; z.xp_earned += m.xp.earned; z.badges += m.badges; z.up += m.classes.upcoming; z.held += m.classes.held;
  }
  return {
    memberships: z.learners_active, attendance_pct: attendancePct(z.attendance), ...z.attendance,
    avg_score_pct: z.scored ? r2(z.score_sum / z.scored) : null, scored: z.scored,
    assignment_completion_pct: ratio(z.a_done, z.a_expected), assignments: z.a_total, xp: z.xp_net, badges: z.badges,
    retention_pct: ratio(z.learners_active, z.learners_active + z.left), upcoming_classes: z.up, classes_held: z.held,
  };
}

/** Learners of ONE batch that deserve a closer look: low attendance or low scores, with the evidence. */
export async function needsAttention(batchId: string, db?: Db) {
  const rows = await query(
    `SELECT l.id AS learner_id, l.full_name,
            (SELECT SUM(a.status IN ('present','late')) FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' WHERE a.learner_id = l.id AND a.batch_id = $1) AS att,
            (SELECT SUM(a.status IN ('present','late','absent')) FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' WHERE a.learner_id = l.id AND a.batch_id = $1) AS att_n,
            (SELECT AVG(sc.score / sc.max_score * 100) FROM scores sc WHERE sc.learner_id = l.id AND sc.batch_id = $1 AND sc.deleted_at IS NULL) AS avg_score,
            (SELECT COUNT(*) FROM scores sc WHERE sc.learner_id = l.id AND sc.batch_id = $1 AND sc.deleted_at IS NULL) AS n_scores
       FROM learner_batch_memberships m JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL
      WHERE m.batch_id = $1 AND m.status = 'active' ORDER BY l.full_name LIMIT 1000`, [batchId], db);
  const out: { learner_id: string; full_name: string; reasons: string[]; attendance_pct: number | null; avg_score_pct: number | null }[] = [];
  for (const r of rows) {
    const att = Number(r.att_n ?? 0) >= 3 ? ratio(Number(r.att), Number(r.att_n)) : null;
    const avg = Number(r.n_scores) >= 2 ? r2(Number(r.avg_score)) : null;
    const reasons: string[] = [];
    if (att !== null && att < 75) reasons.push(`Attendance ${att}%`);
    if (avg !== null && avg < 50) reasons.push(`Average score ${avg}%`);
    if (reasons.length) out.push({ learner_id: r.learner_id, full_name: r.full_name, reasons, attendance_pct: att, avg_score_pct: avg });
  }
  return out.slice(0, 20);
}

export async function distinctLearners(where: string, params: unknown[], db?: Db) {
  return Number((await queryOne(`SELECT COUNT(DISTINCT m.learner_id) AS n FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id WHERE ${where}`, params, db))!.n);
}
