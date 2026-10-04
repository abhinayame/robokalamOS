import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, forbidden } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { csvCell } from '../../lib/security.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { enrollLearners, removeLearners } from '../batches/enrollment.js';
import { LEARNER_STATUSES } from '../learners/filters.js';
import { buildAudience, resolveLearnerIds, selectorSchema, summarizeAudience } from '../selection/resolver.js';

const router = Router();
router.use(requireOrg);

const actionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('assign_batch'), batch_id: uuid }),
  z.object({ action: z.literal('remove_batch'), batch_id: uuid, reason: z.string().max(200).optional() }),
  z.object({ action: z.literal('change_status'), status: z.enum(LEARNER_STATUSES) }),
]);

/**
 * ONE bulk-action engine. Recipients always come from the selection engine, i.e. they are
 * de-duplicated by learner_id, tenant-isolated and RBAC-scoped BEFORE anything is executed.
 * Nothing runs without `confirm: true` (use `dry_run: true` to preview).
 */
router.post('/learners', requirePerm('learner:bulk'), wrap(async (req, res) => {
  const body = parse(z.object({ selection: selectorSchema, dry_run: z.boolean().default(false), confirm: z.boolean().default(false) }).and(actionSchema), req.body);
  const user = req.user!;
  const orgId = orgIdOf(req);
  const needs = body.action === 'change_status' ? 'learner:update' : 'batch:enroll';
  if (!user.isSuperAdmin && !user.permissions.has(needs)) throw forbidden();

  const summary = await summarizeAudience(user, orgId, body.selection);
  if (body.dry_run) return ok(res, { action: body.action, dry_run: true, ...summary });
  if (!body.confirm) throw new AppError(400, 'CONFIRMATION_REQUIRED', 'Review the selection and confirm to continue.', summary);
  if (summary.unique_learners === 0) throw badRequest('No learners match this selection.');

  const result = await tx(async (db) => {
    const ids = await resolveLearnerIds(user, orgId, body.selection, db);
    const c = { db, user, orgId, req };
    let detail: Record<string, unknown>;
    if (body.action === 'assign_batch') {
      const r = await enrollLearners(c, body.batch_id, ids);
      detail = { joined: r.joined, rejoined: r.rejoined, already_member: r.already_member, skipped: r.skipped, affected: r.joined_ids.length };
    } else if (body.action === 'remove_batch') {
      const r = await removeLearners(c, body.batch_id, ids, { reason: body.reason ?? 'Removed in bulk' });
      detail = { removed: r.removed, not_member: r.not_member, affected: r.removed };
    } else {
      const rows = await query(
        `UPDATE learners SET status = $3 WHERE org_id = $1 AND id = ANY($2::uuid[]) AND deleted_at IS NULL AND status <> $3 RETURNING id`,
        [orgId, ids, body.status], db);
      const changed = rows.map((r) => r.id as string);
      if (changed.length) {
        await query(
          `INSERT INTO learner_activity (org_id, learner_id, type, title, actor_user_id)
           SELECT $1, x, 'learner.status_changed', $2, $3 FROM unnest($4::uuid[]) AS x`,
          [orgId, `Status changed to ${body.status}`, user.id, changed], db);
        if (body.status === 'archived') {
          const open = await query(`SELECT batch_id, array_agg(learner_id) AS learner_ids FROM learner_batch_memberships WHERE learner_id = ANY($1::uuid[]) AND status = 'active' GROUP BY batch_id`, [changed], db);
          for (const o of open) await removeLearners(c, o.batch_id, o.learner_ids, { reason: 'Learner archived' });
        }
      }
      detail = { changed: changed.length, unchanged: ids.length - changed.length, affected: changed.length };
    }
    await audit({ orgId, actor: user, action: `learner.bulk_${body.action}`, entityType: 'learner', entityId: null,
      next: { ...summary, ...detail, params: { ...body, selection: undefined } }, req }, db);
    return detail;
  });
  ok(res, { action: body.action, ...summary, ...result });
}));

const EXPORT_COLS: Record<string, [string, string]> = {
  learner_code: ['Learner ID', 'l.learner_code'], full_name: ['Name', 'l.full_name'], mobile: ['Mobile', 'l.mobile'], email: ['Email', 'l.email'],
  parent: ['Parent', 'pp.full_name'], parent_mobile: ['Parent Mobile', 'pp.mobile'], school: ['School', 'l.school'], location: ['Location', 'l.location'],
  status: ['Status', 'l.status'], enrolled_on: ['Enrollment Date', 'l.enrolled_on'],
  batches: ['Batches', `(SELECT string_agg(b.name, '; ' ORDER BY b.name) FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id WHERE m.learner_id = l.id AND m.status = 'active')`],
  courses: ['Courses', `(SELECT string_agg(DISTINCT c.name, '; ') FROM learner_batch_memberships m JOIN batches b ON b.id = m.batch_id JOIN courses c ON c.id = b.course_id WHERE m.learner_id = l.id AND m.status = 'active')`],
};

/** CSV export of a (de-duplicated, permission-scoped) selection. Spreadsheet formulas are neutralised. */
router.post('/learners/export', requirePerm('learner:export'), wrap(async (req, res) => {
  const body = parse(z.object({ selection: selectorSchema, columns: z.array(z.enum(Object.keys(EXPORT_COLS) as [string, ...string[]])).min(1).optional() }), req.body);
  const cols = body.columns ?? Object.keys(EXPORT_COLS);
  const a = buildAudience(req.user!, orgIdOf(req), body.selection);
  const rows = await query(
    `${a.withSql}
     SELECT ${cols.map((k) => `${EXPORT_COLS[k][1]} AS ${k}`).join(', ')}
       FROM learners l
       LEFT JOIN LATERAL (SELECT pa.full_name, pa.mobile FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id WHERE lp.learner_id = l.id AND lp.is_primary LIMIT 1) pp ON TRUE
      WHERE l.id IN (SELECT DISTINCT learner_id FROM elig) ORDER BY lower(l.full_name), l.id LIMIT 100000`, a.p.values);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'learner.exported', entityType: 'learner', next: { rows: rows.length, columns: cols }, req });
  const csv = [cols.map((k) => csvCell(EXPORT_COLS[k][0])).join(','), ...rows.map((r) => cols.map((k) => csvCell(r[k])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="learners-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + csv);
}));

export default router;
