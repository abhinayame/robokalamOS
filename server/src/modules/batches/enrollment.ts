import type { Request } from 'express';
import { Params, exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, conflict, forbidden, notFound } from '../../lib/errors.js';
import { canWriteBranch, learnerScope } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';

export interface EnrollCtx { db: Db; user: AuthUser; orgId: string; req?: Request }

const chunk = <T,>(a: T[], n = 500) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

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

/** One timeline row per learner, written set-based. */
async function timelineFor(c: EnrollCtx, learnerIds: string[], batchId: string, type: string, title: string, description: string | null, meta: object) {
  for (const part of chunk(learnerIds)) {
    const p = new Params();
    await exec(
      `INSERT INTO learner_activity (org_id, learner_id, batch_id, type, title, description, meta, actor_user_id)
       SELECT ${p.add(c.orgId)}, l.id, ${p.add(batchId)}, ${p.add(type)}, ${p.add(title)}, ${p.add(description)}, ${p.add(JSON.stringify(meta))}, ${p.add(c.user.id)}
         FROM learners l WHERE l.id IN ${p.in(part)}`,
      p.values, c.db,
    );
  }
}

export interface EnrollResult { requested: number; joined: number; rejoined: number; already_member: number; skipped: number; joined_ids: string[] }

/**
 * Add learners to a batch. Never creates learners; never duplicates a membership (UNIQUE learner_id+batch_id).
 * A learner who left earlier is re-activated on the same row. Capacity is enforced under a row lock on the
 * batch, which also serialises concurrent enrolments into the same batch.
 */
export async function enrollLearners(
  c: EnrollCtx, batchId: string, learnerIds: string[],
  opts: { transferredFrom?: { id: string; name: string } } = {},
): Promise<EnrollResult> {
  const ids = [...new Set(learnerIds)];            // dedupe by learner_id, always
  const batch = await lockBatchForWrite(c, batchId, true);

  const p = new Params();
  const scope = learnerScope(c.user, p, 'l');
  const eligible = (await query(
    `SELECT l.id FROM learners l
      WHERE l.id IN ${p.in(ids)} AND l.org_id = ${p.add(c.orgId)}
        AND l.deleted_at IS NULL AND l.status <> 'archived' ${scope ? `AND ${scope}` : ''}`,
    p.values, c.db)).map((r) => r.id as string);

  const ep = new Params();
  const existing = eligible.length
    ? await query(`SELECT learner_id, status FROM learner_batch_memberships WHERE batch_id = ${ep.add(batchId)} AND learner_id IN ${ep.in(eligible)} FOR UPDATE`, ep.values, c.db)
    : [];
  const status = new Map(existing.map((r) => [r.learner_id as string, r.status as string]));
  const alreadyActive = eligible.filter((id) => status.get(id) === 'active');
  const toReactivate = eligible.filter((id) => status.has(id) && status.get(id) !== 'active');
  const toInsert = eligible.filter((id) => !status.has(id));
  const toAdd = [...toReactivate, ...toInsert];

  if (batch.capacity != null && toAdd.length) {
    const cur = Number((await queryOne(`SELECT COUNT(*) AS n FROM learner_batch_memberships WHERE batch_id = $1 AND status = 'active'`, [batchId], c.db))!.n);
    if (cur + toAdd.length > batch.capacity) {
      throw new AppError(409, 'CAPACITY_EXCEEDED',
        `${batch.name} has ${Math.max(batch.capacity - cur, 0)} seat(s) left but ${toAdd.length} learner(s) need to be added.`,
        { capacity: batch.capacity, current: cur, requested: toAdd.length });
    }
  }

  for (const part of chunk(toInsert)) {
    const ip = new Params();
    const rows = part.map((lid) => `(${ip.add(newId())},${ip.add(c.orgId)},${ip.add(lid)},${ip.add(batchId)},'active',${ip.add(c.user.id)})`);
    await exec(`INSERT INTO learner_batch_memberships (id, org_id, learner_id, batch_id, status, enrolled_by) VALUES ${rows.join(',')}`, ip.values, c.db);
  }
  for (const part of chunk(toReactivate)) {
    const rp = new Params();
    await exec(
      `UPDATE learner_batch_memberships SET status = 'active', left_at = NULL, left_reason = NULL, joined_at = NOW(3), enrolled_by = ${rp.add(c.user.id)}
        WHERE batch_id = ${rp.add(batchId)} AND learner_id IN ${rp.in(part)}`,
      rp.values, c.db,
    );
  }

  if (toAdd.length) {
    const title = opts.transferredFrom ? `Transferred into ${batch.name}` : `Joined ${batch.name}`;
    await timelineFor(c, toAdd, batchId, opts.transferredFrom ? 'batch.transferred_in' : 'batch.joined', title,
      opts.transferredFrom ? `Moved from ${opts.transferredFrom.name}` : null, { batch_code: batch.batch_code });
    await audit({
      orgId: c.orgId, actor: c.user, action: 'batch.learners_assigned', entityType: 'batch', entityId: batchId,
      next: { batch: batch.batch_code, count: toAdd.length, learner_ids: toAdd.slice(0, 200) }, req: c.req,
    }, c.db);
  }
  // CRM: a lead who gets a batch is converted (same profile, nothing copied); the CRM timeline records it.
  for (const part of chunk(toAdd)) {
    const cp = new Params();
    const open = await query(`SELECT learner_id FROM crm_leads WHERE learner_id IN ${cp.in(part)} AND lead_status NOT IN ('converted')`, cp.values, c.db);
    for (const o of open) {
      await exec(`UPDATE crm_leads SET lead_status = 'converted', lost_reason = NULL, converted_at = NOW(3) WHERE learner_id = $1`, [o.learner_id], c.db);
      await exec(`UPDATE follow_ups SET status = 'cancelled', completed_at = NOW(3) WHERE learner_id = $1 AND status = 'open'`, [o.learner_id], c.db);
      await exec(`UPDATE crm_leads SET next_follow_up_at = NULL WHERE learner_id = $1`, [o.learner_id], c.db);
      await exec(`INSERT INTO crm_activities (id, org_id, learner_id, type, description, staff_user_id) VALUES ($1,$2,$3,'batch_assigned',$4,$5)`, [newId(), c.orgId, o.learner_id, `Assigned to ${batch.name}; lead converted`, c.user.id], c.db);
    }
  }
  return {
    requested: ids.length,
    joined: toInsert.length,
    rejoined: toReactivate.length,
    already_member: alreadyActive.length,
    skipped: ids.length - eligible.length,
    joined_ids: toAdd,
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
  const removed = (await query(
    `SELECT m.learner_id FROM learner_batch_memberships m
      WHERE m.batch_id = ${p.add(batchId)} AND m.org_id = ${p.add(c.orgId)} AND m.status = 'active' AND m.learner_id IN ${p.in(ids)}
        ${scope ? `AND EXISTS (SELECT 1 FROM learners l WHERE l.id = m.learner_id AND ${scope})` : ''}
      FOR UPDATE`,
    p.values, c.db)).map((r) => r.learner_id as string);

  for (const part of chunk(removed)) {
    const up = new Params();
    await exec(
      `UPDATE learner_batch_memberships SET status = ${up.add(status)}, left_at = NOW(3), left_reason = ${up.add(opts.reason ?? null)}
        WHERE batch_id = ${up.add(batchId)} AND status = 'active' AND learner_id IN ${up.in(part)}`,
      up.values, c.db,
    );
  }
  if (removed.length) {
    const title = status === 'transferred' ? `Transferred out of ${batch.name}` : status === 'completed' ? `Completed ${batch.name}` : `Left ${batch.name}`;
    await timelineFor(c, removed, batchId, `batch.${status === 'transferred' ? 'transferred_out' : status}`, title,
      opts.transferredTo ? `Moved to ${opts.transferredTo.name}` : opts.reason ?? null, { batch_code: batch.batch_code });
    await audit({
      orgId: c.orgId, actor: c.user, action: 'batch.learners_removed', entityType: 'batch', entityId: batchId,
      next: { batch: batch.batch_code, status, reason: opts.reason ?? null, count: removed.length, learner_ids: removed.slice(0, 200) }, req: c.req,
    }, c.db);
  }
  return { requested: ids.length, removed: removed.length, not_member: ids.length - removed.length, removed_ids: removed };
}
