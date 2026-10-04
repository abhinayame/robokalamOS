import { queryOne, type Db } from '../db/pool.js';

/** Atomically allocate the next number for an org-scoped counter (call inside a transaction). */
export async function nextCounter(db: Db, orgId: string, key: string): Promise<number> {
  const row = await queryOne<{ value: number }>(
    `INSERT INTO org_counters (org_id, counter_key, value) VALUES ($1,$2,1)
     ON CONFLICT (org_id, counter_key) DO UPDATE SET value = org_counters.value + 1
     RETURNING value`,
    [orgId, key],
    db,
  );
  return row!.value;
}

export async function nextLearnerCode(db: Db, orgId: string, prefix: string) {
  const n = await nextCounter(db, orgId, 'learner');
  return `${prefix}-LRN-${String(n).padStart(6, '0')}`;
}
export async function nextBatchCode(db: Db, orgId: string, prefix: string) {
  const n = await nextCounter(db, orgId, 'batch');
  return `${prefix}-BAT-${String(n).padStart(4, '0')}`;
}
