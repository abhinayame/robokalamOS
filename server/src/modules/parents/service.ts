import { z } from 'zod';
import { exec, newId, queryOne, type Db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { normalizeMobile } from '../../lib/phone.js';

export const parentInput = z.object({
  full_name: z.string().trim().min(2).max(120),
  mobile: z.string().trim().optional().nullable(),
  email: z.string().trim().toLowerCase().email().optional().nullable().or(z.literal('').transform(() => null)),
  relationship: z.string().trim().max(30).default('guardian'),
});
export type ParentInput = z.infer<typeof parentInput>;

/**
 * Find-or-create a parent. Parents are de-duplicated by mobile within the organization,
 * so siblings automatically share ONE parent record (and one parent login).
 */
export async function upsertParent(db: Db, orgId: string, input: ParentInput) {
  const mobile = input.mobile ? normalizeMobile(input.mobile) : null;
  if (input.mobile && !mobile) throw badRequest('Enter a valid 10 digit parent mobile number.', [{ field: 'parent.mobile', message: 'Invalid mobile number.' }]);
  if (mobile) {
    const existing = await queryOne(`SELECT id, full_name, mobile, email FROM parents WHERE org_id = $1 AND mobile = $2 AND deleted_at IS NULL`, [orgId, mobile], db);
    if (existing) return { parent: existing, created: false };
  }
  const id = newId();
  await exec(
    `INSERT INTO parents (id, org_id, full_name, mobile, email) VALUES ($1,$2,$3,$4,$5)`,
    [id, orgId, input.full_name, mobile, input.email ?? null], db,
  );
  return { parent: { id, full_name: input.full_name, mobile, email: input.email ?? null }, created: true };
}

/** Link parent ↔ learner. The first linked parent becomes primary. */
export async function linkParent(db: Db, orgId: string, learnerId: string, parentId: string, relationship: string, makePrimary = false) {
  const hasPrimary = !!(await queryOne(`SELECT 1 FROM learner_parents WHERE learner_id = $1 AND is_primary`, [learnerId], db));
  const primary = makePrimary || !hasPrimary;
  if (primary) await exec(`UPDATE learner_parents SET is_primary = FALSE WHERE learner_id = $1 AND is_primary`, [learnerId], db);
  await exec(
    `INSERT INTO learner_parents (learner_id, parent_id, org_id, relationship, is_primary) VALUES ($1,$2,$3,$4,$5)
     ON DUPLICATE KEY UPDATE relationship = VALUES(relationship), is_primary = IF(VALUES(is_primary), TRUE, is_primary)`,
    [learnerId, parentId, orgId, relationship, primary], db,
  );
}
