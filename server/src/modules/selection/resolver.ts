import { z } from 'zod';
import { Params, query, queryOne, type Db } from '../../db/pool.js';
import { uuid } from '../../lib/http.js';
import { batchScope } from '../../lib/scope.js';
import type { AuthUser } from '../../middleware/auth.js';
import { LEARNER_STATUSES, MEMBERSHIP_STATUSES, learnerFiltersBody, learnerWhere } from '../learners/filters.js';

/**
 * The Batch Selection / Audience engine.
 *
 *   sources (UNION):  batch_ids ∪ course_ids ∪ program_ids ∪ branch_ids ∪ teacher_ids  → batches → memberships
 *                     ∪ learner_ids  ∪ all_learners
 *   narrowing (AND):  filters
 *   always:           deduplicate by learner_id, drop deleted learners, apply the caller's RBAC scope
 *
 * An EMPTY selector resolves to NOBODY (never "everyone"); `all_learners: true` must be explicit.
 * Every bulk feature (bulk actions today; WhatsApp, email, CRM, XP, export in later phases)
 * must obtain its recipients through this module so the deduplication rule lives in one place.
 */
export const selectorSchema = z.object({
  all_learners: z.boolean().optional(),
  batch_ids: z.array(uuid).max(5000).optional(),
  course_ids: z.array(uuid).max(1000).optional(),
  program_ids: z.array(uuid).max(1000).optional(),
  branch_ids: z.array(uuid).max(1000).optional(),
  teacher_ids: z.array(uuid).max(1000).optional(),
  learner_ids: z.array(uuid).max(10000).optional(),
  exclude_learner_ids: z.array(uuid).max(10000).optional(),
  membership_statuses: z.array(z.enum(MEMBERSHIP_STATUSES)).default(['active']),
  learner_statuses: z.array(z.enum(LEARNER_STATUSES)).default(['active']),
  filters: learnerFiltersBody.optional(),
});
export type Selector = z.infer<typeof selectorSchema>;

export interface Audience {
  /** `WITH …` prefix defining CTE `elig(learner_id, src)` — one row per raw hit, BEFORE dedupe. */
  withSql: string;
  p: Params;
  hasSource: boolean;
}

export function buildAudience(user: AuthUser, orgId: string, sel: Selector): Audience {
  const p = new Params();
  const f = sel.filters ?? {};
  const batchConds: string[] = [];
  const add = (col: string, ids?: string[]) => { if (ids?.length) batchConds.push(`${col} = ANY(${p.add(ids)}::uuid[])`); };
  if (!sel.all_learners) {
    add('b.id', sel.batch_ids);
    add('b.course_id', sel.course_ids);
    add('b.program_id', sel.program_ids);
    add('b.branch_id', sel.branch_ids);
    if (sel.teacher_ids?.length) {
      batchConds.push(`EXISTS (SELECT 1 FROM teacher_batch_memberships t WHERE t.batch_id = b.id AND t.status = 'active' AND t.teacher_user_id = ANY(${p.add(sel.teacher_ids)}::uuid[]))`);
    }
  }
  const hasBatchSource = batchConds.length > 0;
  const hasLearnerSource = !sel.all_learners && !!sel.learner_ids?.length;
  const hasFilters = Object.values(f).some((v) => v !== undefined && !(Array.isArray(v) && v.length === 0));
  const hasSource = !!sel.all_learners || hasBatchSource || hasLearnerSource || hasFilters;

  const parts: string[] = [];
  const ctes: string[] = [];
  if (hasBatchSource) {
    const scope = batchScope(user, p, 'b');
    ctes.push(`sel_batches AS (SELECT b.id FROM batches b WHERE b.org_id = ${p.add(orgId)} AND b.deleted_at IS NULL
      AND (${batchConds.join(' OR ')}) ${scope ? `AND ${scope}` : ''})`);
    parts.push(`SELECT m.learner_id, 'm'::text AS src FROM learner_batch_memberships m
                 WHERE m.org_id = ${p.add(orgId)} AND m.batch_id IN (SELECT id FROM sel_batches) AND m.status = ANY(${p.add(sel.membership_statuses)}::text[])`);
  }
  if (hasLearnerSource) parts.push(`SELECT x AS learner_id, 'l'::text AS src FROM unnest(${p.add(sel.learner_ids)}::uuid[]) AS x`);
  if (sel.all_learners || (hasFilters && !hasBatchSource && !hasLearnerSource)) {
    parts.push(`SELECT l.id AS learner_id, 'a'::text AS src FROM learners l WHERE l.org_id = ${p.add(orgId)} AND l.deleted_at IS NULL`);
  }
  if (!parts.length) parts.push(`SELECT NULL::uuid AS learner_id, 'x'::text AS src WHERE FALSE`);
  ctes.push(`raw AS (${parts.join(' UNION ALL ')})`);

  // Eligibility: tenant, soft delete, status, RBAC scope and the user's filters, all on the learner row.
  const where = learnerWhere(user, orgId, f, p, sel.learner_statuses);
  if (sel.exclude_learner_ids?.length) where.push(`l.id <> ALL(${p.add(sel.exclude_learner_ids)}::uuid[])`);
  ctes.push(`elig AS (SELECT r.learner_id, r.src FROM raw r JOIN learners l ON l.id = r.learner_id WHERE ${where.join(' AND ')})`);
  return { withSql: `WITH ${ctes.join(',\n')}`, p, hasSource };
}

export interface AudienceSummary {
  selected_batches: number;
  batch_memberships: number;
  unique_learners: number;
  duplicates_removed: number;
}

export async function summarizeAudience(user: AuthUser, orgId: string, sel: Selector, db?: Db): Promise<AudienceSummary> {
  const a = buildAudience(user, orgId, sel);
  const hasBatches = a.withSql.includes('sel_batches');
  const row = await queryOne(
    `${a.withSql}
     SELECT ${hasBatches ? '(SELECT count(*) FROM sel_batches)' : '0'} AS selected_batches,
            count(*) FILTER (WHERE src = 'm') AS batch_memberships,
            count(DISTINCT learner_id) AS unique_learners,
            count(*) AS raw_total
       FROM elig`,
    a.p.values, db,
  );
  return {
    selected_batches: row!.selected_batches,
    batch_memberships: row!.batch_memberships,
    unique_learners: row!.unique_learners,
    duplicates_removed: row!.raw_total - row!.unique_learners,
  };
}

/** Deduplicated learner ids for the selector (use inside the transaction that acts on them). */
export async function resolveLearnerIds(user: AuthUser, orgId: string, sel: Selector, db?: Db, limit = 100_000): Promise<string[]> {
  const a = buildAudience(user, orgId, sel);
  const rows = await query(`${a.withSql} SELECT DISTINCT learner_id FROM elig LIMIT ${limit}`, a.p.values, db);
  return rows.map((r) => r.learner_id);
}

export async function sampleAudience(user: AuthUser, orgId: string, sel: Selector, n = 8) {
  const a = buildAudience(user, orgId, sel);
  return query(
    `${a.withSql}
     SELECT l.id, l.learner_code, l.full_name FROM learners l
      WHERE l.id IN (SELECT DISTINCT learner_id FROM elig) ORDER BY lower(l.full_name), l.id LIMIT ${n}`,
    a.p.values,
  );
}
