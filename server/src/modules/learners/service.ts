import type { Request } from 'express';
import { exec, newId, queryOne, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { nextLearnerCode } from '../../lib/codes.js';
import { recordActivity } from '../../lib/timeline.js';
import type { AuthUser } from '../../middleware/auth.js';
import { enrollLearners } from '../batches/enrollment.js';
import { linkParent, upsertParent, type ParentInput } from '../parents/service.js';

export async function assertBranch(db: Db, orgId: string, branchId: string | null | undefined) {
  if (!branchId) return;
  if (!(await queryOne(`SELECT 1 FROM branches WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`, [branchId, orgId], db))) throw badRequest('Unknown branch.');
}

export async function findDuplicate(db: Db, orgId: string, mobile: string | null, email: string | null, exceptId?: string) {
  if (mobile) {
    const d = await queryOne(`SELECT id, learner_code, full_name FROM learners WHERE org_id = $1 AND mobile = $2 AND deleted_at IS NULL AND ($3 IS NULL OR id <> $3)`, [orgId, mobile, exceptId ?? null], db);
    if (d) return { field: 'mobile', existing: d };
  }
  if (email) {
    const d = await queryOne(`SELECT id, learner_code, full_name FROM learners WHERE org_id = $1 AND email = $2 AND deleted_at IS NULL AND ($3 IS NULL OR id <> $3)`, [orgId, email, exceptId ?? null], db);
    if (d) return { field: 'email', existing: d };
  }
  return null;
}


export interface NewLearner {
  full_name: string; email?: string | null; date_of_birth?: string | null; gender?: string | null; school?: string | null; location?: string | null;
  photo_url?: string | null; branch_id?: string | null; enrolled_on?: string | null; parent?: ParentInput; batch_ids?: string[];
}

/**
 * The one way a learner profile is created (single form and CSV import both come through here), so the rules cannot drift:
 * duplicate mobile/email is refused, the code comes from the org counter, a parent is found-or-created by mobile, batches are
 * joined through the enrolment engine (capacity, branch rights) and everything is audited. Run inside a transaction.
 * `mobile` must already be normalised.
 */
export async function createLearner(db: Db, c: { user: AuthUser; orgId: string; req?: Request }, body: NewLearner, mobile: string | null) {
  const { user, orgId, req } = c;
  await assertBranch(db, orgId, body.branch_id);
  const dup = await findDuplicate(db, orgId, mobile, body.email ?? null);
  if (dup) throw conflict(`A learner with this ${dup.field} already exists (${dup.existing.full_name}, ${dup.existing.learner_code}).`, 'DUPLICATE_LEARNER', dup);

  const org = await queryOne(`SELECT code_prefix FROM organizations WHERE id = $1`, [orgId], db);
  const code = await nextLearnerCode(db, orgId, org!.code_prefix);
  // Branch admins always create inside their own branch.
  const branchId = body.branch_id ?? (user.access.orgWide ? null : user.access.branchIds[0] ?? null);
  const newLearnerId = newId();
  await exec(
    `INSERT INTO learners (id, org_id, branch_id, learner_code, full_name, mobile, email, date_of_birth, gender, school, location, photo_url, enrolled_on, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,COALESCE($13, CURRENT_DATE),$14)`,
    [newLearnerId, orgId, branchId, code, body.full_name, mobile, body.email ?? null, body.date_of_birth ?? null, body.gender ?? null, body.school ?? null,
      body.location ?? null, body.photo_url ?? null, body.enrolled_on ?? null, user.id], db);
  const l = await queryOne(`SELECT * FROM learners WHERE id = $1`, [newLearnerId], db);
  await recordActivity(db, { orgId, learnerId: l!.id, type: 'learner.created', title: 'Joined Robokalam', description: `Learner profile ${code} created`, actorUserId: user.id });

  if (body.parent) {
    const { parent, created } = await upsertParent(db, orgId, body.parent);
    await linkParent(db, orgId, l!.id, parent.id, body.parent.relationship, true);
    await recordActivity(db, { orgId, learnerId: l!.id, type: 'parent.linked', title: `Parent linked: ${parent.full_name}`, meta: { parent_id: parent.id, reused: !created }, actorUserId: user.id });
  }
  for (const batchId of new Set(body.batch_ids ?? [])) {
    await enrollLearners({ db, user, orgId, req }, batchId, [l!.id]);
  }
  await audit({ orgId, actor: user, action: 'learner.created', entityType: 'learner', entityId: l!.id, next: { learner_code: code, full_name: l!.full_name, batch_ids: body.batch_ids ?? [] }, req }, db);
  return l!;
}
