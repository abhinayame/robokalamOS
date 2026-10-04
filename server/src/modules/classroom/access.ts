import type { Request } from 'express';
import { Params, query, queryOne, type Db } from '../../db/pool.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { batchScope } from '../../lib/scope.js';
import { orgIdOf } from '../../middleware/auth.js';

export interface Room {
  batch: { id: string; name: string; batch_code: string; status: string; branch_id: string | null; course_id: string; schedule: any };
  /** May post, create classwork and review submissions in THIS batch (admins in scope, or an active teacher of it). */
  canManage: boolean;
  /** The caller's own learner profile(s) that are active members of this batch (a learner, or a parent's children). */
  learnerIds: string[];
  /** May comment and submit work (a learner with an active membership). */
  canInteract: boolean;
  /** Archived and completed batches are read-only (except reviewing existing submissions). */
  writable: boolean;
}

/**
 * The single gate for everything inside a classroom. Returns 404 (never 403) when the batch is
 * outside the caller's scope, so the existence of other batches is not revealed.
 */
export async function openRoom(req: Request, batchId: string, db?: Db): Promise<Room> {
  const user = req.user!;
  const orgId = orgIdOf(req);
  const p = new Params();
  const scope = batchScope(user, p, 'b');
  const batch = await queryOne(
    `SELECT b.id, b.name, b.batch_code, b.status, b.branch_id, b.course_id, b.schedule FROM batches b
      WHERE b.id = ${p.add(batchId)} AND b.org_id = ${p.add(orgId)} AND b.deleted_at IS NULL ${scope ? `AND ${scope}` : ''}`, p.values, db);
  if (!batch) throw notFound('Classroom');

  let canManage = false;
  if (user.isSuperAdmin || user.permissions.has('classroom:manage')) {
    const a = user.access;
    if (user.isSuperAdmin || a.orgWide || (batch.branch_id && a.branchIds.includes(batch.branch_id))) canManage = true;
    else if (a.teacher) {
      canManage = !!(await queryOne(
        `SELECT 1 FROM teacher_batch_memberships WHERE batch_id = $1 AND teacher_user_id = $2 AND status = 'active'`, [batch.id, user.id], db));
    }
  }
  let learnerIds: string[] = [];
  if (user.access.ownLearnerIds.length) {
    const lp = new Params();
    learnerIds = (await query(
      `SELECT learner_id FROM learner_batch_memberships WHERE batch_id = ${lp.add(batch.id)} AND status = 'active' AND learner_id IN ${lp.in(user.access.ownLearnerIds)}`, lp.values, db))
      .map((r) => r.learner_id as string);
  }
  const isLearnerUser = user.roles.includes('learner');
  return {
    batch, canManage, learnerIds,
    canInteract: isLearnerUser && user.permissions.has('classroom:interact') && learnerIds.length > 0,
    writable: !['archived', 'completed'].includes(batch.status),
  };
}

export function assertManage(room: Room) {
  if (!room.canManage) throw forbidden('Only the teachers of this batch can do that.');
}
export function assertWritable(room: Room) {
  if (!room.writable) throw conflict(`This batch is ${room.batch.status}, so its classroom is read-only.`, 'BATCH_CLOSED');
}

/** Which learner's work a non-manager is looking at: their own, or a chosen child of a parent. */
export function viewedLearner(room: Room, requested?: string | null): string | null {
  if (requested) return room.learnerIds.includes(requested) ? requested : null;
  return room.learnerIds[0] ?? null;
}

/** Learner-facing assignment state: upcoming | due | completed | late | returned. */
export function assignmentState(a: { due_at: string | null }, s: { status: string } | null | undefined, now = Date.now()): 'upcoming' | 'due' | 'completed' | 'late' | 'returned' {
  const due = a.due_at ? new Date(a.due_at).getTime() : null;
  if (s?.status === 'evaluated') return 'completed';
  if (s?.status === 'returned') return 'returned';
  if (s?.status === 'submitted') return 'completed';
  if (s?.status === 'late') return 'late';
  if (due !== null && due < now) return 'late';                       // overdue and not handed in
  if (due !== null && due - now <= 3 * 86_400_000) return 'due';       // due within 3 days
  return 'upcoming';
}
