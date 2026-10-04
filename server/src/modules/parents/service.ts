import { z } from 'zod';
import { query, queryOne, type Db } from '../../db/pool.js';
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
  const row = await queryOne(
    `INSERT INTO parents (org_id, full_name, mobile, email) VALUES ($1,$2,$3,$4) RETURNING id, full_name, mobile, email`,
    [orgId, input.full_name, mobile, input.email ?? null], db,
  );
  return { parent: row!, created: true };
}

/** Link parent ↔ learner. The first linked parent becomes primary. */
export async function linkParent(db: Db, orgId: string, learnerId: string, parentId: string, relationship: string, makePrimary = false) {
  const hasPrimary = !!(await queryOne(`SELECT 1 FROM learner_parents WHERE learner_id = $1 AND is_primary`, [learnerId], db));
  const primary = makePrimary || !hasPrimary;
  if (primary) await query(`UPDATE learner_parents SET is_primary = false WHERE learner_id = $1 AND is_primary`, [learnerId], db);
  await query(
    `INSERT INTO learner_parents (learner_id, parent_id, org_id, relationship, is_primary) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (learner_id, parent_id) DO UPDATE SET relationship = EXCLUDED.relationship,
       is_primary = CASE WHEN EXCLUDED.is_primary THEN true ELSE learner_parents.is_primary END`,
    [learnerId, parentId, orgId, relationship, primary], db,
  );
}
