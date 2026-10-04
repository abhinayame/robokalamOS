import { z } from 'zod';
import { Params } from '../../db/pool.js';
import { csvList, uuid } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';

export const LEARNER_STATUSES = ['active', 'inactive', 'archived'] as const;
export const MEMBERSHIP_STATUSES = ['active', 'completed', 'left', 'transferred'] as const;

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD.');

/** Shared by the learner list, the selection engine and bulk actions. */
export const learnerFilterShape = {
  q: z.string().trim().max(100).optional(),
  status: z.array(z.enum(LEARNER_STATUSES)).max(3).optional(),
  branch_id: z.array(uuid).max(200).optional(),
  batch_id: z.array(uuid).max(500).optional(),
  course_id: z.array(uuid).max(200).optional(),
  program_id: z.array(uuid).max(200).optional(),
  teacher_id: z.array(uuid).max(200).optional(),
  academic_year: z.array(z.string().max(20)).max(20).optional(),
  membership_status: z.array(z.enum(MEMBERSHIP_STATUSES)).max(4).optional(),
  enrolled_from: date.optional(),
  enrolled_to: date.optional(),
  no_batch: z.boolean().optional(),
};
export const learnerFiltersBody = z.object(learnerFilterShape);

/** Same filters as query-string input (comma separated lists). */
export const learnerFiltersQuery = z.object({
  ...learnerFilterShape,
  status: csvList(z.enum(LEARNER_STATUSES)),
  branch_id: csvList(uuid),
  batch_id: csvList(uuid),
  course_id: csvList(uuid),
  program_id: csvList(uuid),
  teacher_id: csvList(uuid),
  academic_year: csvList(z.string().max(20)),
  membership_status: csvList(z.enum(MEMBERSHIP_STATUSES)),
  no_batch: z.preprocess((v) => (v === 'true' || v === true ? true : v === 'false' || v === false ? false : undefined), z.boolean().optional()),
});

export type LearnerFilters = z.infer<typeof learnerFiltersBody>;

/**
 * WHERE fragments for learners aliased `l` (tenant + soft-delete + scope + filters).
 * All membership-based filters (batch, course, program, teacher, year) are applied to the
 * SAME membership row, so "Course = Robotics AND Batch IN (A,B)" means one membership matching both.
 */
export function learnerWhere(user: AuthUser, orgId: string, f: LearnerFilters, p: Params, defaultStatuses?: readonly string[]): string[] {
  const w: string[] = [`l.org_id = ${p.add(orgId)}`, `l.deleted_at IS NULL`];
  const statuses = f.status ?? defaultStatuses;
  if (statuses?.length) w.push(`l.status = ANY(${p.add(statuses)}::text[])`);
  const scope = learnerScope(user, p, 'l');
  if (scope) w.push(scope);

  if (f.q) {
    const like = p.add(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
    w.push(`(l.full_name ILIKE ${like} OR l.learner_code ILIKE ${like} OR l.mobile ILIKE ${like} OR l.email ILIKE ${like}
      OR EXISTS (SELECT 1 FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id
                  WHERE lp.learner_id = l.id AND (pa.full_name ILIKE ${like} OR pa.mobile ILIKE ${like})))`);
  }
  if (f.branch_id?.length) w.push(`l.branch_id = ANY(${p.add(f.branch_id)}::uuid[])`);
  if (f.enrolled_from) w.push(`l.enrolled_on >= ${p.add(f.enrolled_from)}::date`);
  if (f.enrolled_to) w.push(`l.enrolled_on <= ${p.add(f.enrolled_to)}::date`);

  const m: string[] = [];
  if (f.batch_id?.length) m.push(`m.batch_id = ANY(${p.add(f.batch_id)}::uuid[])`);
  if (f.course_id?.length) m.push(`b.course_id = ANY(${p.add(f.course_id)}::uuid[])`);
  if (f.program_id?.length) m.push(`b.program_id = ANY(${p.add(f.program_id)}::uuid[])`);
  if (f.academic_year?.length) m.push(`b.academic_year = ANY(${p.add(f.academic_year)}::text[])`);
  if (f.teacher_id?.length) {
    m.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = m.batch_id AND t.status = 'active' AND t.teacher_user_id = ANY(${p.add(f.teacher_id)}::uuid[]))`);
  }
  if (m.length) {
    const ms = f.membership_status?.length ? f.membership_status : ['active'];
    w.push(`EXISTS (SELECT 1 FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id
              WHERE m.learner_id = l.id AND m.status = ANY(${p.add(ms)}::text[]) AND ${m.join(' AND ')})`);
  } else if (f.membership_status?.length) {
    w.push(`EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = ANY(${p.add(f.membership_status)}::text[]))`);
  }
  if (f.no_batch) w.push(`NOT EXISTS (SELECT 1 FROM learner_batch_memberships m WHERE m.learner_id = l.id AND m.status = 'active')`);
  return w;
}
