import { exec, newId, queryOne, type Db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { recordActivity } from '../../lib/timeline.js';
import { setSourceXp } from '../gamification/xp.js';

export type SourceType = 'assignment' | 'quiz' | 'activity';
export const round2 = (n: number) => Math.round(n * 100) / 100;
export const pct = (score: number, max: number) => (max > 0 ? round2((score / max) * 100) : 0);

/** Performance band from a percentage. */
export const band = (p: number | null) => (p === null ? null : p >= 85 ? 'excellent' : p >= 70 ? 'good' : p >= 50 ? 'average' : 'needs_attention');

export interface ScoreInput {
  orgId: string; actorId: string; learnerId: string; batchId: string;
  sourceType: SourceType; sourceId: string; name: string; category?: string | null;
  score: number; max: number; feedback?: string | null;
  /** Only quizzes write a score on every attempt; skip the write when an existing score is better. */
  onlyIfHigher?: boolean;
}

/**
 * The single place a score is written. One live row per learner per graded item; every create/update
 * appends a score_history row (who, when, previous and new values) in the same transaction.
 * Call inside tx().
 */
export async function recordScore(db: Db, a: ScoreInput): Promise<{ id: string; action: 'created' | 'updated' | 'unchanged' }> {
  const score = round2(a.score); const max = round2(a.max);
  if (!(max > 0)) throw badRequest('The maximum score must be more than zero.');
  if (!(score >= 0) || score > max) throw badRequest(`Score must be between 0 and ${max}.`, [{ field: 'score', message: `Enter a number from 0 to ${max}.` }]);
  const cur = await queryOne(
    `SELECT id, score, max_score, feedback, category, activity_name FROM scores
      WHERE learner_id = $1 AND batch_id = $2 AND source_type = $3 AND source_id = $4 AND deleted_at IS NULL FOR UPDATE`,
    [a.learnerId, a.batchId, a.sourceType, a.sourceId], db);
  const feedback = a.feedback === undefined ? (cur?.feedback ?? null) : (a.feedback || null);
  if (!cur) {
    const id = newId();
    await exec(`INSERT INTO scores (id, org_id, learner_id, batch_id, teacher_user_id, source_type, source_id, activity_name, category, score, max_score, feedback) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, a.orgId, a.learnerId, a.batchId, a.actorId, a.sourceType, a.sourceId, a.name, a.category ?? null, score, max, feedback], db);
    await exec(`INSERT INTO score_history (org_id, score_id, changed_by, action, new_score, new_max, new_feedback) VALUES ($1,$2,$3,'created',$4,$5,$6)`, [a.orgId, id, a.actorId, score, max, feedback], db);
    await recordActivity(db, { orgId: a.orgId, learnerId: a.learnerId, batchId: a.batchId, type: 'score.recorded', title: `Scored ${score}/${max}: ${a.name}`, description: feedback, meta: { score_id: id, source_type: a.sourceType }, actorUserId: a.actorId });
    return { id, action: 'created' };
  }
  if (a.onlyIfHigher && score <= Number(cur.score) && max === Number(cur.max_score)) return { id: cur.id, action: 'unchanged' };
  const same = Number(cur.score) === score && Number(cur.max_score) === max && (cur.feedback ?? null) === feedback;
  if (same) return { id: cur.id, action: 'unchanged' };
  await exec(`UPDATE scores SET score = $1, max_score = $2, feedback = $3, teacher_user_id = $4, activity_name = $5, category = $6 WHERE id = $7`,
    [score, max, feedback, a.actorId, a.name, a.category ?? cur.category ?? null, cur.id], db);
  await exec(`INSERT INTO score_history (org_id, score_id, changed_by, action, previous_score, new_score, previous_max, new_max, previous_feedback, new_feedback) VALUES ($1,$2,$3,'updated',$4,$5,$6,$7,$8,$9)`,
    [a.orgId, cur.id, a.actorId, cur.score, score, cur.max_score, max, cur.feedback, feedback], db);
  await recordActivity(db, { orgId: a.orgId, learnerId: a.learnerId, batchId: a.batchId, type: 'score.updated', title: `Score changed ${Number(cur.score)} → ${score}/${max}: ${a.name}`, description: feedback, meta: { score_id: cur.id }, actorUserId: a.actorId });
  return { id: cur.id, action: 'updated' };
}

/** Soft-delete a score (frees the slot) and keep the trail. */
export async function removeScore(db: Db, orgId: string, actorId: string, scoreId: string) {
  const cur = await queryOne(`SELECT id, learner_id, batch_id, score, max_score, feedback, activity_name FROM scores WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`, [scoreId, orgId], db);
  if (!cur) return null;
  await exec(`UPDATE scores SET deleted_at = NOW(3) WHERE id = $1`, [scoreId], db);
  await exec(`INSERT INTO score_history (org_id, score_id, changed_by, action, previous_score, previous_max, previous_feedback) VALUES ($1,$2,$3,'deleted',$4,$5,$6)`, [orgId, scoreId, actorId, cur.score, cur.max_score, cur.feedback], db);
  // A bonus earned on this score goes with it (reversal row stays in the ledger).
  await setSourceXp(db, { orgId, learnerId: cur.learner_id, batchId: cur.batch_id, reason: `Bonus: ${cur.activity_name}`, sourceType: 'score', sourceId: scoreId, target: 0, userId: actorId });
  await recordActivity(db, { orgId, learnerId: cur.learner_id, batchId: cur.batch_id, type: 'score.removed', title: `Score removed: ${cur.activity_name}`, actorUserId: actorId });
  return cur;
}

export interface Cell { score: number; max: number; at: string | number | Date }
/** Totals, mean percentage, performance band and trend over scored items (any order in, chronological out). */
export function summarize(cells: Cell[], itemCount = cells.length) {
  const sorted = [...cells].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
  const pcts = sorted.map((c) => pct(c.score, c.max));
  const total = round2(sorted.reduce((s, c) => s + c.score, 0));
  const max_total = round2(sorted.reduce((s, c) => s + c.max, 0));
  const average_pct = pcts.length ? round2(pcts.reduce((s, p) => s + p, 0) / pcts.length) : null;
  let trend: 'up' | 'down' | 'steady' | null = null;
  if (pcts.length >= 4) {
    const last = pcts.slice(-3); const prev = pcts.slice(Math.max(0, pcts.length - 6), -3);
    const d = last.reduce((s, p) => s + p, 0) / last.length - prev.reduce((s, p) => s + p, 0) / prev.length;
    trend = d > 5 ? 'up' : d < -5 ? 'down' : 'steady';
  }
  return { scored: sorted.length, items: itemCount, completion_pct: itemCount ? round2((sorted.length / itemCount) * 100) : null, total, max_total, average_pct, overall_pct: max_total ? pct(total, max_total) : null, performance: band(average_pct), trend };
}
