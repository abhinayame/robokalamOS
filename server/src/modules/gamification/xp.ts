import { Params, exec, query, queryOne, type Db } from '../../db/pool.js';
import { recordActivity } from '../../lib/timeline.js';

export interface Level { level_no: number; name: string; min_xp: number }
export const DEFAULT_LEVELS: Level[] = [
  { level_no: 1, name: 'Explorer', min_xp: 0 }, { level_no: 2, name: 'Learner', min_xp: 101 }, { level_no: 3, name: 'Achiever', min_xp: 301 },
  { level_no: 4, name: 'Innovator', min_xp: 601 }, { level_no: 5, name: 'Champion', min_xp: 1001 }, { level_no: 6, name: 'Master', min_xp: 2001 },
];

export async function getLevels(orgId: string, db?: Db): Promise<{ levels: Level[]; custom: boolean }> {
  const rows = await query(`SELECT level_no, name, min_xp FROM levels WHERE org_id = $1 ORDER BY level_no`, [orgId], db);
  return rows.length ? { levels: rows.map((r) => ({ level_no: Number(r.level_no), name: r.name, min_xp: Number(r.min_xp) })), custom: true } : { levels: DEFAULT_LEVELS, custom: false };
}

/** Level, and progress towards the next, for an XP total (negative totals count as 0). */
export function levelFor(xp: number, levels: Level[]) {
  const x = Math.max(0, xp);
  const sorted = [...levels].sort((a, b) => a.min_xp - b.min_xp);
  let cur = sorted[0]; for (const l of sorted) if (x >= l.min_xp) cur = l;
  const next = sorted.find((l) => l.min_xp > cur.min_xp) ?? null;
  return { level: cur, next, progress_pct: next ? Math.min(100, Math.round(((x - cur.min_xp) / (next.min_xp - cur.min_xp)) * 100)) : 100, xp_to_next: next ? next.min_xp - x : 0 };
}

export interface XpInput { orgId: string; learnerId: string; batchId?: string | null; points: number; reason: string; sourceType: string; sourceId?: string | null; userId?: string | null; dedupeKey?: string | null; silent?: boolean }

/** The only writer of the ledger. Returns false when the dedupe key was already used (a retry). Call inside tx(). */
export async function addXp(db: Db, a: XpInput): Promise<boolean> {
  if (!a.points) return false;
  try {
    await exec(`INSERT INTO xp_transactions (org_id, learner_id, batch_id, points, reason, source_type, source_id, dedupe_key, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [a.orgId, a.learnerId, a.batchId ?? null, a.points, a.reason.slice(0, 255), a.sourceType, a.sourceId ?? null, a.dedupeKey ?? null, a.userId ?? null], db);
  } catch (e: any) {
    if (e?.errno === 1062) return false;
    throw e;
  }
  if (!a.silent) await recordActivity(db, { orgId: a.orgId, learnerId: a.learnerId, batchId: a.batchId, type: a.points > 0 ? 'xp.awarded' : 'xp.adjusted', title: `${a.points > 0 ? '+' : ''}${a.points} XP: ${a.reason}`, meta: { source_type: a.sourceType }, actorUserId: a.userId });
  return true;
}

/**
 * Make the NET XP of one source (a score's bonus, a badge's reward) equal `target` by appending the difference.
 * Idempotent: calling it twice with the same target writes nothing the second time.
 */
export async function setSourceXp(db: Db, a: Omit<XpInput, 'points' | 'dedupeKey'> & { sourceId: string; target: number }) {
  const net = Number((await queryOne(`SELECT COALESCE(SUM(points), 0) AS n FROM xp_transactions WHERE learner_id = $1 AND source_type = $2 AND source_id = $3`, [a.learnerId, a.sourceType, a.sourceId], db))!.n);
  const delta = a.target - net;
  if (!delta) return 0;
  await addXp(db, { ...a, points: delta, reason: delta > 0 ? a.reason : `Reversed: ${a.reason}` });
  return delta;
}

export async function balances(learnerIds: string[], db?: Db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < learnerIds.length; i += 1000) {
    const p = new Params();
    for (const r of await query(`SELECT learner_id, SUM(points) AS xp FROM xp_transactions WHERE learner_id IN ${p.in(learnerIds.slice(i, i + 1000))} GROUP BY learner_id`, p.values, db)) out.set(r.learner_id, Number(r.xp));
  }
  return out;
}
