import type { Request } from 'express';
import { Params, exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { learnerScope } from '../../lib/scope.js';
import { recordActivity } from '../../lib/timeline.js';
import { orgIdOf } from '../../middleware/auth.js';
import { assertManage, openRoom } from '../classroom/access.js';
import { addXp, setSourceXp } from './xp.js';

export const MAX_TEACHER_AWARD = 500;

/**
 * Who may be awarded, decided once for every award path (single, multi, bulk).
 *  - With a batch: the caller must manage THAT batch and every learner must be an active member of it.
 *  - Without a batch: only org-wide / branch admins, and only for learners inside their scope.
 * Learners are de-duplicated by learner_id.
 */
export async function verifyTargets(req: Request, learnerIds: string[], batchId: string | null | undefined, db?: Db, opts: { trustScope?: boolean } = {}) {
  const user = req.user!; const orgId = orgIdOf(req);
  const ids = [...new Set(learnerIds)];
  if (!ids.length) throw badRequest('Choose at least one learner.');
  let batch: { id: string; batch_code: string } | null = null;
  if (batchId) {
    const room = await openRoom(req, batchId, db);
    assertManage(room);
    batch = room.batch;
    if (!opts.trustScope) {
      const p = new Params();
      const ok = new Set((await query(`SELECT learner_id FROM learner_batch_memberships WHERE batch_id = ${p.add(batchId)} AND status = 'active' AND learner_id IN ${p.in(ids)}`, p.values, db)).map((r) => r.learner_id as string));
      const out = ids.filter((i) => !ok.has(i));
      if (out.length) throw badRequest(`${out.length} learner(s) are not active members of this batch.`, out.map((id) => ({ field: id, message: 'Not in this batch.' })));
    }
    return { ids, batch, orgId };
  }
  if (!user.isSuperAdmin && !user.access.orgWide && !user.access.branchIds.length) throw badRequest('Choose a batch for this award.', [{ field: 'batch_id', message: 'This is required.' }]);
  if (!opts.trustScope) {
    const p = new Params(); const sc = learnerScope(user, p, 'l');
    const ok = new Set((await query(`SELECT l.id FROM learners l WHERE l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL AND l.id IN ${p.in(ids)} ${sc ? `AND ${sc}` : ''}`, p.values, db)).map((r) => r.id as string));
    const out = ids.filter((i) => !ok.has(i));
    if (out.length) throw notFound('Learner');
    return { ids, batch, orgId };
  }
  return { ids, batch, orgId };
}

export function checkPoints(req: Request, points: number) {
  const user = req.user!;
  const manager = user.isSuperAdmin || user.permissions.has('gamification:manage');
  if (!Number.isInteger(points) || points === 0) throw badRequest('Enter a whole number of XP.', [{ field: 'points', message: 'Cannot be zero.' }]);
  if (points < 0 && !manager) throw badRequest('Only admins can deduct XP (as a correction).', [{ field: 'points', message: 'Enter a positive number.' }]);
  if (Math.abs(points) > (manager ? 10_000 : MAX_TEACHER_AWARD)) throw badRequest(`You can award up to ${manager ? 10_000 : MAX_TEACHER_AWARD} XP at a time.`, [{ field: 'points', message: `Maximum ${manager ? 10_000 : MAX_TEACHER_AWARD}.` }]);
}

/** Append XP for already-verified learners. `requestId` makes a retried request a no-op per learner. */
export async function awardXp(db: Db, req: Request, a: { ids: string[]; batchId?: string | null; points: number; reason: string; requestId?: string | null; sourceType?: string }) {
  const orgId = orgIdOf(req); let awarded = 0; let duplicate = 0;
  for (const id of a.ids) {
    const ok = await addXp(db, { orgId, learnerId: id, batchId: a.batchId, points: a.points, reason: a.reason, sourceType: a.sourceType ?? 'manual', userId: req.user!.id, dedupeKey: a.requestId ? `req:${a.requestId}:${id}` : null });
    if (ok) awarded++; else duplicate++;
  }
  return { awarded, duplicate };
}

export async function awardBadge(db: Db, req: Request, a: { badgeId: string; ids: string[]; batchId?: string | null; reason?: string | null }) {
  const orgId = orgIdOf(req); const userId = req.user!.id;
  const badge = await queryOne(`SELECT id, name, icon, xp_reward, status FROM badges WHERE id = $1 AND org_id = $2`, [a.badgeId, orgId], db);
  if (!badge) throw notFound('Badge');
  if (badge.status !== 'active') throw badRequest('This badge is not active, so it cannot be awarded.');
  const r = { awarded: 0, already_has: 0, xp_granted: 0 };
  for (const learnerId of a.ids) {
    const id = newId();
    try {
      await exec(`INSERT INTO learner_badges (id, org_id, learner_id, badge_id, batch_id, awarded_by, reason, xp_awarded) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [id, orgId, learnerId, badge.id, a.batchId ?? null, userId, a.reason ?? null, badge.xp_reward], db);
    } catch (e: any) { if (e?.errno === 1062) { r.already_has++; continue; } throw e; }
    if (badge.xp_reward) r.xp_granted += await setSourceXp(db, { orgId, learnerId, batchId: a.batchId, reason: `Badge: ${badge.name}`, sourceType: 'badge', sourceId: id, target: badge.xp_reward, userId, silent: true });
    await recordActivity(db, { orgId, learnerId, batchId: a.batchId, type: 'badge.awarded', title: `${badge.icon} Earned the "${badge.name}" badge${badge.xp_reward ? ` (+${badge.xp_reward} XP)` : ''}`, description: a.reason, meta: { badge_id: badge.id, learner_badge_id: id }, actorUserId: userId });
    r.awarded++;
  }
  return { ...r, badge: { id: badge.id, name: badge.name } };
}
