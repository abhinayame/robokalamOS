import { Params } from '../db/pool.js';
import type { AuthUser } from '../middleware/auth.js';

/**
 * SQL predicates that restrict rows to what the caller may see.
 * Returns '' when unrestricted (org-wide), otherwise a parenthesised predicate.
 * Tenant isolation (org_id = …) is always applied separately by the callers.
 */
export function learnerScope(user: AuthUser, p: Params, l = 'l'): string {
  const a = user.access;
  if (a.orgWide) return '';
  const ors: string[] = [];
  if (a.branchIds.length) {
    const b = p.add(a.branchIds);
    ors.push(`${l}.branch_id = ANY(${b}::uuid[])`);
    ors.push(`EXISTS (SELECT 1 FROM learner_batch_memberships sm JOIN batches sb ON sb.id = sm.batch_id
                       WHERE sm.learner_id = ${l}.id AND sm.status = 'active' AND sb.branch_id = ANY(${b}::uuid[]))`);
  }
  if (a.teacher) {
    const t = p.add(user.id);
    ors.push(`EXISTS (SELECT 1 FROM learner_batch_memberships sm JOIN teacher_batch_memberships st ON st.batch_id = sm.batch_id
                       WHERE sm.learner_id = ${l}.id AND sm.status = 'active' AND st.teacher_user_id = ${t} AND st.status = 'active')`);
  }
  if (a.ownLearnerIds.length) ors.push(`${l}.id = ANY(${p.add(a.ownLearnerIds)}::uuid[])`);
  return ors.length ? `(${ors.join(' OR ')})` : 'FALSE';
}

export function batchScope(user: AuthUser, p: Params, b = 'b'): string {
  const a = user.access;
  if (a.orgWide) return '';
  const ors: string[] = [];
  if (a.branchIds.length) ors.push(`${b}.branch_id = ANY(${p.add(a.branchIds)}::uuid[])`);
  if (a.teacher) {
    ors.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships st WHERE st.batch_id = ${b}.id
                       AND st.teacher_user_id = ${p.add(user.id)} AND st.status = 'active')`);
  }
  if (a.ownLearnerIds.length) {
    ors.push(`EXISTS (SELECT 1 FROM learner_batch_memberships sm WHERE sm.batch_id = ${b}.id
                       AND sm.status = 'active' AND sm.learner_id = ANY(${p.add(a.ownLearnerIds)}::uuid[]))`);
  }
  return ors.length ? `(${ors.join(' OR ')})` : 'FALSE';
}

/** True when the user may create/modify things in this branch (null branch = org level). */
export function canWriteBranch(user: AuthUser, branchId: string | null): boolean {
  if (user.access.orgWide) return true;
  return !!branchId && user.access.branchIds.includes(branchId);
}
