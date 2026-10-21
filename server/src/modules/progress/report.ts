import { query, queryOne, type Db } from '../../db/pool.js';
import { zonedToUtc } from '../attendance/time.js';

export const monthOk = (m: string) => /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
const nextMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 12 ? `${y! + 1}-01-01` : `${y}-${String(mm! + 1).padStart(2, '0')}-01`; };
export const prevMonth = (m: string) => { const [y, mm] = m.split('-').map(Number); return mm === 1 ? `${y! - 1}-12` : `${y}-${String(mm! - 1).padStart(2, '0')}`; };
const r1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Everything a parent would want to know about one learner for one month, from data already recorded (nothing is invented):
 * attendance per batch, assignments due, scores, XP and badges earned, and the teachers' own notes.
 */
export async function buildReport(orgId: string, learnerId: string, month: string, tz: string, db?: Db) {
  const from = zonedToUtc(`${month}-01`, '00:00', tz); const to = zonedToUtc(nextMonth(month), '00:00', tz);
  const learner = await queryOne(`SELECT l.id, l.full_name, l.learner_code FROM learners l WHERE l.id = $1 AND l.org_id = $2 AND l.deleted_at IS NULL`, [learnerId, orgId], db);
  if (!learner) return null;
  const attendance = await query(`SELECT b.id AS batch_id, b.name AS batch_name,
      COALESCE(SUM(a.status = 'present'), 0) AS present, COALESCE(SUM(a.status = 'late'), 0) AS late, COALESCE(SUM(a.status = 'absent'), 0) AS absent, COALESCE(SUM(a.status = 'excused'), 0) AS excused
    FROM attendance a JOIN class_sessions s ON s.id = a.session_id AND s.status <> 'cancelled' JOIN batches b ON b.id = s.batch_id
    WHERE a.learner_id = $1 AND a.org_id = $2 AND s.starts_at >= $3 AND s.starts_at < $4 GROUP BY b.id, b.name ORDER BY b.name`, [learnerId, orgId, from, to], db);
  const att = attendance.map((r) => { const p = Number(r.present), l = Number(r.late), a = Number(r.absent); const n = p + l + a; return { batch_id: r.batch_id, batch_name: r.batch_name, present: p, late: l, absent: a, excused: Number(r.excused), pct: n ? r1(((p + l) / n) * 100) : null }; });
  const tot = att.reduce((s, r) => ({ ok: s.ok + r.present + r.late, n: s.n + r.present + r.late + r.absent }), { ok: 0, n: 0 });
  const asg = await queryOne(`SELECT COUNT(*) AS total, COALESCE(SUM(sub.status IN ('submitted','late','evaluated')), 0) AS done
      FROM assignments a JOIN learner_batch_memberships m ON m.batch_id = a.batch_id AND m.learner_id = $1 JOIN batches b ON b.id = a.batch_id AND b.deleted_at IS NULL
      LEFT JOIN submissions sub ON sub.assignment_id = a.id AND sub.learner_id = m.learner_id
     WHERE a.org_id = $2 AND a.deleted_at IS NULL AND a.due_at >= $3 AND a.due_at < $4`, [learnerId, orgId, from, to], db);
  const scores = await query(`SELECT s.activity_name AS name, s.score, s.max_score, b.name AS batch_name, s.created_at FROM scores s JOIN batches b ON b.id = s.batch_id
     WHERE s.learner_id = $1 AND s.org_id = $2 AND s.deleted_at IS NULL AND s.created_at >= $3 AND s.created_at < $4 ORDER BY s.created_at LIMIT 50`, [learnerId, orgId, from, to], db);
  const pct = (rows: any[]) => (rows.length ? r1(rows.reduce((s, x) => s + (Number(x.score) / Number(x.max_score)) * 100, 0) / rows.length) : null);
  const pfrom = zonedToUtc(`${prevMonth(month)}-01`, '00:00', tz);
  const prev = await query(`SELECT s.score, s.max_score FROM scores s WHERE s.learner_id = $1 AND s.org_id = $2 AND s.deleted_at IS NULL AND s.created_at >= $3 AND s.created_at < $4`, [learnerId, orgId, pfrom, from], db);
  const xp = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1 AND org_id = $2 AND created_at >= $3 AND created_at < $4`, [learnerId, orgId, from, to], db))!.n);
  const badges = await query(`SELECT bd.name FROM learner_badges lb JOIN badges bd ON bd.id = lb.badge_id WHERE lb.learner_id = $1 AND lb.org_id = $2 AND lb.revoked_at IS NULL AND lb.awarded_at >= $3 AND lb.awarded_at < $4 ORDER BY lb.awarded_at`, [learnerId, orgId, from, to], db);
  const notes = await query(`SELECT n.body, u.full_name AS teacher, b.name AS batch_name FROM progress_notes n JOIN users u ON u.id = n.author_user_id JOIN batches b ON b.id = n.batch_id WHERE n.learner_id = $1 AND n.org_id = $2 AND n.month = $3 ORDER BY b.name, u.full_name`, [learnerId, orgId, month], db);
  const cur = pct(scores); const before = pct(prev);
  return {
    month, learner,
    attendance: { batches: att, overall_pct: tot.n ? r1((tot.ok / tot.n) * 100) : null, classes_marked: tot.n },
    assignments: { due: Number(asg!.total), done: Number(asg!.done) },
    scores: { items: scores.map((s) => ({ name: s.name, score: Number(s.score), max_score: Number(s.max_score), batch_name: s.batch_name })), average_pct: cur, previous_average_pct: before, change: cur !== null && before !== null ? r1(cur - before) : null },
    xp_earned: xp, badges: badges.map((b) => b.name as string), notes,
    has_data: tot.n > 0 || Number(asg!.total) > 0 || scores.length > 0 || xp !== 0 || badges.length > 0 || notes.length > 0,
  };
}
export type Report = NonNullable<Awaited<ReturnType<typeof buildReport>>>;
