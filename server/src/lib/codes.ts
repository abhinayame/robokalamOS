import { queryOne, exec, type Db } from '../db/pool.js';

/**
 * Atomically allocate the next number for an org-scoped counter.
 * Must run inside a transaction: LAST_INSERT_ID() is per connection.
 */
export async function nextCounter(db: Db, orgId: string, key: string): Promise<number> {
  await exec(
    `INSERT INTO org_counters (org_id, counter_key, value) VALUES ($1,$2,LAST_INSERT_ID(1))
     ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)`,
    [orgId, key], db,
  );
  const row = await queryOne<{ v: number }>('SELECT LAST_INSERT_ID() AS v', [], db);
  return Number(row!.v);
}

export async function nextLearnerCode(db: Db, orgId: string, prefix: string) {
  const n = await nextCounter(db, orgId, 'learner');
  return `${prefix}-LRN-${String(n).padStart(6, '0')}`;
}
export async function nextBatchCode(db: Db, orgId: string, prefix: string) {
  const n = await nextCounter(db, orgId, 'batch');
  return `${prefix}-BAT-${String(n).padStart(4, '0')}`;
}
