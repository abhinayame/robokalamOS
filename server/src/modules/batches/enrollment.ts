import type { Request } from 'express';
import { Params, query, queryOne, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { canWriteBranch, learnerScope } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';

export interface EnrollCtx { db: Db; user: AuthUser; orgId: string; req?: Request }

/** Lock + validate a batch for membership changes (call inside a transaction). */
export async function lockBatchForWrite(c: EnrollCtx, batchId: string, forEnroll: boolean) {
  const b = await queryOne(
    `SELECT id, name, batch_code, status, capacity, branch_id FROM batches
      WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL FOR UPDATE`,
    [batchId, c.orgId], c.db,
  );
  if (!b) throw notFound('Batch');
  if (!canWriteBranch(c.user, b.branch_id)) throw forbidden('This batch belongs to a branch you do not manage.');
  if (forEnroll && (b.status === 'archived' || b.status === 'completed')) {
    throw conflict(`This batch is ${b.status}. Learners cannot be added to it.`, 'BATCH_CLOSED');
  }
  return b as { id: string; name: string; batch_code: string; status: string; capacity: number | null; branch_id: string | null };
}

export interface EnrollResult { requested: number; joined: number; rejoined: number; already_member: number; skipped: number; joined_ids: string[] }

/**
 * Add learners to a batch. Never creates learners; never duplicates a membership (UNIQUE learner_id+batch_id).
 * A learner who left earlier is re-activated on the same row. Capacity is enforced under the batch row lock.
 */
export async function enrollLearners(
  c: EnrollCtx, batchId: string, learnerIds: string[],
  opts: { transferredFrom?: { id: string; name: string } } = {},
): Promise<EnrollResult> {
  const ids = [...new Set(learnerIds)];            // dedupe by learner_id, always
  const batch = await lockBatchForWrite(c, batchId, true);

  const p = new Params();
  const scope = learnerScope(c.user, p, 'l');
  const eligibleSql = `SELECT l.id FROM learners l
      WHERE l.id = ANY(${p.add(ids)}::uuid[]) AND l.org_id = ${p.add(c.orgId)}
        AND l.deleted_at IS NULL AND l.status <> 'archived' ${scope ? `AND ${scope}` : ''}`;
  const eligible = (await query(eligibleSql, p.values, c.db)).map((r) => r.id as string);

  const alreadyActive = eligible.length
    ? (await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active' AND learner_id = ANY($2::uuid[])`, [batchId, eligible], c.db)).map((r) => r.learner_id as string)
    : [];
  const toAdd = eligible.filter((id) => !alreadyActive.includes(id));

  if (batch.capacity != null && toAdd.length) {
    const cur = (await queryOne(`SELECT count(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [batchId], c.db))!.n as number;
    if (cur + toAdd.length > batch.capacity) {
      throw new AppError(409, 'CAPACITY_EXCEEDED',
        `${batch.name} has ${Math.max(batch.capacity - cur, 0)} seat(s) left but ${toAdd.length} learner(s) need to be added.`,
        { capacity: batch.capacity, current: cur, requested: toAdd.length });
    }
  }

  let joinedRows: { learner_id: string; inserted: boolean }[] = [];
  if (toAdd.length) {
    joinedRows = await query(
      `INSERT INTO learner_batch_memberships (org_id, learner_id, batch_id, status, enrolled_by)
       SELECT $1, x, $2, 'active', $3 FROM unnest($4::uuid[]) AS x
       ON CONFLICT (learner_id, batch_id) DO UPDATE
          SET status = 'active', left_at = NULL, left_reason = NULL, joined_at = now(), enrolled_by = EXCLUDED.enrolled_by
        WHERE learner_batch_memberships.status <> 'active'
       RETURNING learner_id, (xmax = 0) AS inserted`,
      [c.orgId, batchId, c.user.id, toAdd], c.db,
    );
    const title = opts.transferredFrom ? `Transferred into ${batch.name}` : `Joined ${batch.name}`;
    await query(
      `INSERT INTO learner_activity (org_id, learner_id, batch_id, type, title, description, meta, actor_user_id)
       SELECT $1, x, $2, $3, $4, $5, $6::jsonb, $7 FROM unnest($8::uuid[]) AS x`,
      [c.orgId, batchId, opts.transferredFrom ? 'batch.transferred_in' : 'batch.joined', title,
        opts.transferredFrom ? `Moved from ${opts.transferredFrom.name}` : null,
        JSON.stringify({ batch_code: batch.batch_code }), c.user.id, joinedRows.map((r) => r.learner_id)], c.db,
    );
    await audit({
      orgId: c.orgId, actor: c.user, action: 'batch.learners_assigned', entityType: 'batch', entityId: batchId,
      next: { batch: batch.batch_code, count: joinedRows.length, learner_ids: joinedRows.slice(0, 200).map((r) => r.learner_id) }, req: c.req,
    }, c.db);
  }
  return {
    requested: ids.length,
    joined: joinedRows.filter((r) => r.inserted).length,
    rejoined: joinedRows.filter((r) => !r.inserted).length,
    already_member: alreadyActive.length,
    skipped: ids.length - eligible.length,
    joined_ids: joinedRows.map((r) => r.learner_id),
  };
}

export interface RemoveResult { requested: number; removed: number; not_member: number; removed_ids: string[] }

/** End a membership (kept for history). The learner stays in all other batches. */
export async function removeLearners(
  c: EnrollCtx, batchId: string, learnerIds: string[],
  opts: { reason?: string | null; status?: 'left' | 'transferred' | 'completed'; transferredTo?: { name: string } } = {},
): Promise<RemoveResult> {
  const ids = [...new Set(learnerIds)];
  const batch = await lockBatchForWrite(c, batchId, false);
  const status = opts.status ?? 'left';
  const p = new Params();
  const scope = learnerScope(c.user, p, 'l');
  const rows = await query(
    `UPDATE learner_batch_memberships m SET status = ${p.add(status)}, left_at = now(), left_reason = ${p.add(opts.reason ?? null)}
      WHERE m.batch_id = ${p.add(batchId)} AND m.org_id = ${p.add(c.orgId)} AND m.status = 'active'
        AND m.learner_id = ANY(${p.add(ids)}::uuid[])
        ${scope ? `AND EXISTS (SELECT 1 FROM learners l WHERE l.id = m.learner_id AND ${scope})` : ''}
      RETURNING m.learner_id`,
    p.values, c.db,
  );
  const removed = rows.map((r) => r.learner_id as string);
  if (removed.length) {
    const title = status === 'transferred' ? `Transferred out of ${batch.name}` : status === 'completed' ? `Completed ${batch.name}` : `Left ${batch.name}`;
    await query(
      `INSERT INTO learner_activity (org_id, learner_id, batch_id, type, title, description, meta, actor_user_id)
       SELECT $1, x, $2, $3, $4, $5, $6::jsonb, $7 FROM unnest($8::uuid[]) AS x`,
      [c.orgId, batchId, `batch.${status === 'transferred' ? 'transferred_out' : status}`, title,
        opts.transferredTo ? `Moved to ${opts.transferredTo.name}` : opts.reason ?? null,
        JSON.stringify({ batch_code: batch.batch_code }), c.user.id, removed], c.db,
    );
    await audit({
      orgId: c.orgId, actor: c.user, action: 'batch.learners_removed', entityType: 'batch', entityId: batchId,
      next: { batch: batch.batch_code, status, reason: opts.reason ?? null, count: removed.length, learner_ids: removed.slice(0, 200) }, req: c.req,
    }, c.db);
  }
  return { requested: ids.length, removed: removed.length, not_member: ids.length - removed.length, removed_ids: removed };
}
