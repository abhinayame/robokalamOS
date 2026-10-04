import { Params, query, queryOne, type Db } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import type { AuthUser } from '../../middleware/auth.js';
import { resolveLearnerIds, summarizeAudience, type Selector } from '../selection/resolver.js';
import { validateRecipient } from './aisensy.js';

export const TOKENS = ['learner_name', 'learner_first_name', 'parent_name', 'org_name', 'batch_name'] as const;
export const MAX_RECIPIENTS = 20_000;

const tokenRe = /\{([a-z_]+)\}/g;
export function tokensIn(text: string) { return [...text.matchAll(tokenRe)].map((m) => m[1]); }

/** A parameter value for AiSensy: tokens filled, line breaks flattened (template parameters cannot hold them). */
export function render(text: string, ctx: Record<string, string>) {
  return text.replace(tokenRe, (_m, k) => ctx[k] ?? '').replace(/\s*[\r\n]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim().slice(0, 1000);
}

export interface Resolved {
  summary: { selected_batches: number; batch_memberships: number; unique_learners: number; duplicates_removed: number };
  counts: { with_phone: number; no_phone: number; opted_out: number; shared_phone_merged: number; recipients: number };
  recipients: { learner_id: string; parent_id: string | null; phone: string; learner_name: string; parent_name: string | null }[];
}

/**
 * The single place an audience becomes people to message:
 *   selection engine (RBAC-scoped, de-duplicated by learner) → one phone per learner → drop opt-outs →
 *   one message per phone number (siblings sharing a parent's number get one).
 */
export async function resolveAudience(user: AuthUser, orgId: string, selector: Selector, audience: 'parents' | 'learners', db?: Db): Promise<Resolved> {
  const summary = await summarizeAudience(user, orgId, selector, db);
  const ids = summary.unique_learners ? await resolveLearnerIds(user, orgId, selector, db, MAX_RECIPIENTS + 1) : [];
  if (ids.length > MAX_RECIPIENTS) throw badRequest(`A campaign can reach at most ${MAX_RECIPIENTS.toLocaleString('en-IN')} people. Narrow the audience or split it into campaigns.`);
  const learners: any[] = [];
  for (let i = 0; i < ids.length; i += 1000) {
    const p = new Params();
    learners.push(...await query(`SELECT id, full_name, mobile FROM learners WHERE id IN ${p.in(ids.slice(i, i + 1000))} AND deleted_at IS NULL ORDER BY full_name, id`, p.values, db));
  }
  const parentOf = new Map<string, { id: string; full_name: string; mobile: string | null }>();
  if (audience === 'parents') {
    for (let i = 0; i < ids.length; i += 1000) {
      const p = new Params();
      // Primary parent first; otherwise any parent who has a usable mobile.
      for (const r of await query(`SELECT lp.learner_id, pa.id, pa.full_name, pa.mobile FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL
          WHERE lp.learner_id IN ${p.in(ids.slice(i, i + 1000))} AND pa.mobile IS NOT NULL ORDER BY lp.is_primary DESC, lp.created_at, pa.id`, p.values, db)) {
        if (!parentOf.has(r.learner_id) && validateRecipient(r.mobile)) parentOf.set(r.learner_id, r);
      }
    }
  }
  const optp = new Params();
  const opted = new Set((await query(`SELECT phone FROM whatsapp_optouts WHERE org_id = ${optp.add(orgId)}`, optp.values, db)).map((r) => r.phone as string));
  const counts = { with_phone: 0, no_phone: 0, opted_out: 0, shared_phone_merged: 0, recipients: 0 };
  const seen = new Set<string>(); const recipients: Resolved['recipients'] = [];
  for (const l of learners) {
    const par = audience === 'parents' ? parentOf.get(l.id) : undefined;
    const v = validateRecipient(audience === 'parents' ? par?.mobile : l.mobile);
    if (!v) { counts.no_phone++; continue; }
    counts.with_phone++;
    if (opted.has(v.e164)) { counts.opted_out++; continue; }
    if (seen.has(v.e164)) { counts.shared_phone_merged++; continue; }
    seen.add(v.e164);
    recipients.push({ learner_id: l.id, parent_id: par?.id ?? null, phone: v.e164, learner_name: l.full_name, parent_name: par?.full_name ?? null });
  }
  counts.recipients = recipients.length;
  return { summary, counts, recipients };
}

/** The template parameters for one recipient. */
export function paramsFor(vars: string[], r: { learner_name: string; parent_name: string | null }, ctx: { org_name: string; batch_name?: string }) {
  const c = { learner_name: r.learner_name, learner_first_name: r.learner_name.split(/\s+/)[0] ?? r.learner_name, parent_name: r.parent_name ?? 'Parent', org_name: ctx.org_name, batch_name: ctx.batch_name ?? '' };
  return vars.map((v) => render(v, c));
}

/** The one batch name {batch_name} may mean: only valid when exactly one batch is selected. */
export async function singleBatchName(orgId: string, selector: Selector, db?: Db): Promise<string | null> {
  if (selector.batch_ids?.length !== 1 || selector.course_ids?.length || selector.program_ids?.length || selector.branch_ids?.length || selector.teacher_ids?.length || selector.learner_ids?.length || selector.all_learners) return null;
  return (await queryOne(`SELECT name FROM batches WHERE id = $1 AND org_id = $2`, [selector.batch_ids[0], orgId], db))?.name ?? null;
}
