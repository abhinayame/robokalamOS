import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { AppError, badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, parse, uuid, wrap } from '../../lib/http.js';
import { learnerScope } from '../../lib/scope.js';
import { normalizeMobile } from '../../lib/phone.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { selectorSchema, type Selector } from '../selection/resolver.js';
import { isConfigured, isWebhookConfigured, senderNumberSet } from './aisensy.js';
import { TOKENS, paramsFor, resolveAudience, singleBatchName, tokensIn } from './audience.js';
import { env } from '../../config/env.js';

const router = Router();
router.use(requireOrg, requirePerm('comms:read'));
const campaign = requirePerm('comms:campaign');
const manage = requirePerm('comms:manage');

export const USE_CASES = ['welcome', 'batch_enrollment', 'class_reminder', 'class_cancellation', 'new_assignment', 'assignment_reminder', 'assignment_evaluated', 'score_received', 'badge_awarded', 'attendance_alert', 'fee_reminder', 'announcement', 'competition_reminder', 'event_reminder', 'parent_update', 'follow_up'] as const;
const dup = (what: string) => (e: any) => { if (e?.errno === 1062) throw conflict(`${what} with that name already exists.`, 'DUPLICATE'); throw e; };

/** Non-admins only ever see their own campaigns. */
const ownOnly = (req: any, p: Params, col = 'c.created_by') => (req.user!.isSuperAdmin || req.user!.access.orgWide ? '' : `AND ${col} = ${p.add(req.user!.id)}`);

/** What people sent us on WhatsApp (STOP, YES, questions) and what the app did about it. Phone numbers are masked. */
router.get('/replies', wrap(async (req, res) => {
  const rows = await query(`SELECT i.id, i.received_at, i.intent, i.outcome, i.body, i.phone, i.learner_id, l.full_name, l.learner_code FROM whatsapp_inbound i LEFT JOIN learners l ON l.id = i.learner_id WHERE i.org_id = $1 ORDER BY i.received_at DESC, i.id LIMIT 200`, [orgIdOf(req)]);
  ok(res, rows.map((r) => ({ ...r, phone: String(r.phone).replace(/\d(?=\d{4})/g, '•') })));
}));

router.get('/status', wrap(async (_req, res) => {
  // Only whether things are set. Values are never returned.
  ok(res, { configured: isConfigured(), webhook_configured: isWebhookConfigured(), provider: env.WHATSAPP_PROVIDER, sender_number_set: senderNumberSet(), worker_enabled: env.COMMS_WORKER === 'true', rate_per_second: env.WHATSAPP_RATE_PER_SECOND,
    webhook_path: isWebhookConfigured() ? (env.WHATSAPP_PROVIDER === 'meta' ? '/api/webhooks/meta' : '/api/webhooks/aisensy/<AISENSY_WEBHOOK_SECRET>') : null, tokens: TOKENS, use_cases: USE_CASES });
}));

// ------------------------------------------------------------------ templates
const tplBody = z.object({
  name: z.string().trim().min(2, 'Name the template.').max(120),
  aisensy_campaign_name: z.string().trim().min(1, 'Enter the AiSensy API campaign name.').max(160),
  use_case: z.enum(USE_CASES), body_preview: z.string().trim().max(2000).nullish(),
  variable_names: z.array(z.string().trim().min(1).max(60)).max(10).default([]), status: z.enum(['active', 'inactive']).default('active'),
});
router.get('/templates', wrap(async (req, res) => {
  ok(res, await query(`SELECT t.id, t.name, t.aisensy_campaign_name, t.use_case, t.body_preview, t.variable_names, t.status, (SELECT COUNT(*) FROM whatsapp_campaigns c WHERE c.template_id = t.id) AS campaigns FROM whatsapp_templates t WHERE t.org_id = $1 ORDER BY t.use_case, t.name LIMIT 300`, [orgIdOf(req)]));
}));
router.post('/templates', manage, wrap(async (req, res) => {
  const b = parse(tplBody, req.body); const id = newId();
  await exec(`INSERT INTO whatsapp_templates (id, org_id, name, aisensy_campaign_name, use_case, body_preview, variable_names, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, orgIdOf(req), b.name, b.aisensy_campaign_name, b.use_case, b.body_preview ?? null, JSON.stringify(b.variable_names), b.status, req.user!.id]).catch(dup('A template'));
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'whatsapp.template_created', entityType: 'whatsapp_template', entityId: id, next: b, req });
  ok(res, { id }, undefined, 201);
}));
router.patch('/templates/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const b = parse(tplBody.partial(), req.body);
  if (!(await queryOne(`SELECT 1 FROM whatsapp_templates WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]))) throw notFound('Template');
  const sets: string[] = []; const vals: unknown[] = [];
  for (const k of ['name', 'aisensy_campaign_name', 'use_case', 'body_preview', 'status'] as const) if (b[k] !== undefined) { vals.push(b[k] ?? null); sets.push(`${k} = $${vals.length + 2}`); }
  if (b.variable_names) { vals.push(JSON.stringify(b.variable_names)); sets.push(`variable_names = $${vals.length + 2}`); }
  if (sets.length) await exec(`UPDATE whatsapp_templates SET ${sets.join(', ')} WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req), ...vals]).catch(dup('A template'));
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'whatsapp.template_updated', entityType: 'whatsapp_template', entityId: id, next: b, req });
  ok(res, { id });
}));

// ------------------------------------------------------------------ opt-outs
router.get('/optouts', manage, wrap(async (req, res) => ok(res, await query(`SELECT id, phone, reason, created_at FROM whatsapp_optouts WHERE org_id = $1 ORDER BY created_at DESC LIMIT 1000`, [orgIdOf(req)]))));
router.post('/optouts', manage, wrap(async (req, res) => {
  const b = parse(z.object({ phone: z.string().trim().min(5).max(20), reason: z.string().trim().max(200).nullish() }), req.body);
  const phone = normalizeMobile(b.phone); if (!phone) throw badRequest('Enter a valid mobile number.', [{ field: 'phone', message: 'Not a valid mobile number.' }]);
  const id = newId();
  await exec(`INSERT INTO whatsapp_optouts (id, org_id, phone, reason, created_by) VALUES ($1,$2,$3,$4,$5)`, [id, orgIdOf(req), phone, b.reason ?? null, req.user!.id]).catch(dup('That number'));
  // Anything still waiting to go to this number stops now.
  await exec(`UPDATE whatsapp_recipients SET status = 'cancelled', last_error = 'Opted out' WHERE org_id = $1 AND phone = $2 AND status IN ('pending','queued')`, [orgIdOf(req), phone]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'whatsapp.optout_added', entityType: 'whatsapp_optout', entityId: id, next: { phone }, req });
  ok(res, { id, phone }, undefined, 201);
}));
router.delete('/optouts/:id', manage, wrap(async (req, res) => {
  const r = await exec(`DELETE FROM whatsapp_optouts WHERE id = $1 AND org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!r.affectedRows) throw notFound('Opt-out');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'whatsapp.optout_removed', entityType: 'whatsapp_optout', entityId: req.params.id as string, req });
  ok(res, { id: req.params.id, removed: true });
}));

// ------------------------------------------------------------------ campaigns
const campBody = z.object({
  name: z.string().trim().min(2, 'Name the campaign.').max(160), template_id: uuid, audience: z.enum(['parents', 'learners']).default('parents'),
  selector: selectorSchema, variables: z.array(z.string().max(1000)).max(10).default([]), scheduled_at: z.string().datetime({ offset: true }).nullish(),
});

async function loadTemplate(orgId: string, id: string) {
  const t = await queryOne(`SELECT id, name, aisensy_campaign_name, variable_names, status FROM whatsapp_templates WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!t) throw notFound('Template');
  return t as { id: string; name: string; aisensy_campaign_name: string; variable_names: string[] | null; status: string };
}
async function validateCampaign(orgId: string, b: z.infer<typeof campBody>) {
  const t = await loadTemplate(orgId, b.template_id);
  if (t.status !== 'active') throw badRequest('That template is switched off.', [{ field: 'template_id', message: 'Choose an active template.' }]);
  const n = (t.variable_names ?? []).length;
  if (b.variables.length !== n) throw badRequest(`This template needs ${n} value${n === 1 ? '' : 's'}.`, [{ field: 'variables', message: `Provide ${n} value${n === 1 ? '' : 's'}.` }]);
  const used = new Set(b.variables.flatMap(tokensIn));
  const bad = [...used].filter((u) => !(TOKENS as readonly string[]).includes(u));
  if (bad.length) throw badRequest(`Unknown placeholder {${bad[0]}}. You can use ${TOKENS.map((x) => `{${x}}`).join(', ')}.`, [{ field: 'variables', message: `Unknown placeholder {${bad[0]}}.` }]);
  if (used.has('parent_name') && b.audience === 'learners') throw badRequest('{parent_name} only works when messaging parents.', [{ field: 'variables', message: 'Switch the audience to parents or remove {parent_name}.' }]);
  if (used.has('batch_name') && !(await singleBatchName(orgId, b.selector))) throw badRequest('{batch_name} needs exactly one batch to be selected (and nothing else).', [{ field: 'variables', message: 'Select a single batch or remove {batch_name}.' }]);
  if (b.variables.some((v, i) => !v.trim() && n > i)) throw badRequest('Fill in every template value.', [{ field: 'variables', message: 'Every value is required.' }]);
  if (b.scheduled_at && (new Date(b.scheduled_at) <= new Date() || new Date(b.scheduled_at).getTime() > Date.now() + 90 * 86400_000)) throw badRequest('Schedule a time in the future (within 90 days).', [{ field: 'scheduled_at', message: 'Pick a time in the future.' }]);
  return t;
}

async function counts(campaignId: string) {
  const rows = await query(`SELECT status, COUNT(*) AS n FROM whatsapp_recipients WHERE campaign_id = $1 GROUP BY status`, [campaignId]);
  const c: Record<string, number> = { pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, cancelled: 0 };
  for (const r of rows) c[r.status] = Number(r.n);
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return { ...c, total, successful: c.sent + c.delivered + c.read, in_progress: c.pending + c.queued };
}

router.get('/campaigns', wrap(async (req, res) => {
  const p = new Params();
  const q = parse(z.object({ status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(20) }), req.query);
  const w = [`c.org_id = ${p.add(orgIdOf(req))}`]; const own = ownOnly(req, p); if (q.status) w.push(`c.status = ${p.add(q.status)}`);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM whatsapp_campaigns c WHERE ${w.join(' AND ')} ${own}`, p.values))!.n);
  const rows = await query(`SELECT c.id, c.name, c.status, c.kind, c.audience, c.scheduled_at, c.created_at, c.confirmed_at, c.finished_at, c.total_recipients, c.unique_learners, t.name AS template_name, u.full_name AS created_by_name
      FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id = c.template_id JOIN users u ON u.id = c.created_by WHERE ${w.join(' AND ')} ${own} ORDER BY c.created_at DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  const withCounts = await Promise.all(rows.map(async (r) => ({ ...r, counts: r.status === 'draft' ? null : await counts(r.id) })));
  ok(res, withCounts, { page: q.page, page_size: q.page_size, total });
}));

async function loadCampaign(req: any, id: string) {
  const p = new Params();
  const c = await queryOne(`SELECT c.*, t.name AS template_name, t.variable_names, t.body_preview, u.full_name AS created_by_name FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id = c.template_id JOIN users u ON u.id = c.created_by
      WHERE c.id = ${p.add(id)} AND c.org_id = ${p.add(orgIdOf(req))} ${ownOnly(req, p)}`, p.values);
  if (!c) throw notFound('Campaign');
  return c;
}

router.post('/campaigns', campaign, wrap(async (req, res) => {
  const b = parse(campBody, req.body); const orgId = orgIdOf(req);
  await validateCampaign(orgId, b);
  const id = newId();
  await exec(`INSERT INTO whatsapp_campaigns (id, org_id, name, template_id, audience, selector, variables, scheduled_at, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, orgId, b.name, b.template_id, b.audience, JSON.stringify(b.selector), JSON.stringify(b.variables), b.scheduled_at ? new Date(b.scheduled_at) : null, req.user!.id]);
  await audit({ orgId, actor: req.user, action: 'whatsapp.campaign_created', entityType: 'whatsapp_campaign', entityId: id, next: { name: b.name, template: b.template_id, audience: b.audience }, req });
  ok(res, { id }, undefined, 201);
}));

router.patch('/campaigns/:id', campaign, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCampaign(req, parse(uuid, req.params.id));
  if (c.status !== 'draft') throw conflict('Only a draft can be edited.', 'NOT_DRAFT');
  const b = parse(campBody, { name: c.name, template_id: c.template_id, audience: c.audience, selector: c.selector, variables: c.variables ?? [], scheduled_at: c.scheduled_at, ...req.body });
  await validateCampaign(orgId, b);
  await exec(`UPDATE whatsapp_campaigns SET name = $1, template_id = $2, audience = $3, selector = $4, variables = $5, scheduled_at = $6 WHERE id = $7`,
    [b.name, b.template_id, b.audience, JSON.stringify(b.selector), JSON.stringify(b.variables), b.scheduled_at ? new Date(b.scheduled_at) : null, c.id]);
  ok(res, { id: c.id });
}));

router.delete('/campaigns/:id', campaign, wrap(async (req, res) => {
  const c = await loadCampaign(req, parse(uuid, req.params.id));
  if (c.status !== 'draft') throw conflict('Only a draft can be deleted. Cancel a running campaign instead.', 'NOT_DRAFT');
  await exec(`DELETE FROM whatsapp_campaigns WHERE id = $1`, [c.id]);
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'whatsapp.campaign_deleted', entityType: 'whatsapp_campaign', entityId: c.id, req });
  ok(res, { id: c.id, deleted: true });
}));

/** The confirmation screen: exactly who would get a message, and why anyone would not. Sends nothing. */
router.post('/campaigns/:id/preview', campaign, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCampaign(req, parse(uuid, req.params.id));
  const r = await resolveAudience(req.user!, orgId, c.selector as Selector, c.audience);
  const org = (await queryOne(`SELECT name FROM organizations WHERE id = $1`, [orgId]))!.name as string;
  const batch = (await singleBatchName(orgId, c.selector)) ?? undefined;
  ok(res, {
    campaign_id: c.id, status: c.status, template: c.template_name, audience: c.audience, ...r.summary, ...r.counts,
    sample: r.recipients.slice(0, 5).map((x) => ({ learner: x.learner_name, phone: x.phone.replace(/\d(?=\d{4})/g, '•'), params: paramsFor((c.variables ?? []) as string[], x, { org_name: org, batch_name: batch }) })),
    warnings: [
      ...(r.counts.shared_phone_merged ? [`${r.counts.shared_phone_merged} learner(s) share a number with another learner (for example siblings). They get one message, personalised for the first child.`] : []),
      ...(r.counts.no_phone ? [`${r.counts.no_phone} learner(s) have no usable ${c.audience === 'parents' ? 'parent' : 'learner'} mobile number and will be skipped.`] : []),
      ...(r.counts.opted_out ? [`${r.counts.opted_out} number(s) have opted out and will be skipped.`] : []),
    ],
    ready: isConfigured() && r.counts.recipients > 0, configured: isConfigured(),
  });
}));

/** Freeze the recipient snapshot and start (or schedule) sending. Needs the numbers the sender just reviewed. */
router.post('/campaigns/:id/confirm', limit('campaign', 10), campaign, wrap(async (req, res) => {
  const orgId = orgIdOf(req);
  const b = parse(z.object({ confirm: z.literal(true, { message: 'Review the audience and confirm to send.' }), expected_recipients: z.number().int().min(0) }), req.body);
  if (!isConfigured()) throw conflict('WhatsApp is not connected yet. An admin needs to set the AiSensy details on the server.', 'NOT_CONFIGURED');
  const out = await tx(async (db) => {
    const c = await queryOne(`SELECT c.*, t.variable_names, t.status AS template_status FROM whatsapp_campaigns c JOIN whatsapp_templates t ON t.id = c.template_id WHERE c.id = $1 AND c.org_id = $2 FOR UPDATE`, [parse(uuid, req.params.id), orgId], db);
    if (!c || (!req.user!.isSuperAdmin && !req.user!.access.orgWide && c.created_by !== req.user!.id)) throw notFound('Campaign');
    if (c.status !== 'draft') throw conflict('This campaign has already been confirmed.', 'NOT_DRAFT');
    if (c.template_status !== 'active') throw badRequest('The template is switched off.');
    if (c.scheduled_at && new Date(c.scheduled_at) <= new Date()) throw badRequest('The scheduled time has passed. Pick a new time or send now.', [{ field: 'scheduled_at', message: 'Pick a time in the future.' }]);
    const r = await resolveAudience(req.user!, orgId, c.selector as Selector, c.audience, db);
    if (!r.counts.recipients) throw badRequest('Nobody can receive this message. Check phone numbers and opt-outs.');
    if (r.counts.recipients !== b.expected_recipients) throw new AppError(409, 'AUDIENCE_CHANGED', `The audience changed since you reviewed it: it is now ${r.counts.recipients} recipient(s), not ${b.expected_recipients}. Review it again.`, { ...r.summary, ...r.counts });
    const org = (await queryOne(`SELECT name FROM organizations WHERE id = $1`, [orgId], db))!.name as string;
    const batch = (await singleBatchName(orgId, c.selector, db)) ?? undefined;
    for (let i = 0; i < r.recipients.length; i += 500) {
      const ip = new Params();
      const rows = r.recipients.slice(i, i + 500).map((x) => `(${ip.add(newId())},${ip.add(orgId)},${ip.add(c.id)},${ip.add(x.learner_id)},${ip.add(x.parent_id)},${ip.add(x.phone)},${ip.add(JSON.stringify(paramsFor((c.variables ?? []) as string[], x, { org_name: org, batch_name: batch })))})`);
      await exec(`INSERT INTO whatsapp_recipients (id, org_id, campaign_id, learner_id, parent_id, phone, params) VALUES ${rows.join(',')}`, ip.values, db);
    }
    const scheduled = !!c.scheduled_at;
    await exec(`UPDATE whatsapp_campaigns SET status = $1, confirmed_at = NOW(3), confirmed_by = $2, started_at = $3, selected_batches = $4, batch_memberships = $5, unique_learners = $6, duplicates_removed = $7, total_recipients = $8, skipped = $9 WHERE id = $10`,
      [scheduled ? 'scheduled' : 'processing', req.user!.id, scheduled ? null : new Date(), r.summary.selected_batches, r.summary.batch_memberships, r.summary.unique_learners, r.summary.duplicates_removed, r.counts.recipients, r.counts.no_phone + r.counts.opted_out + r.counts.shared_phone_merged, c.id], db);
    return { id: c.id, status: scheduled ? 'scheduled' : 'processing', recipients: r.counts.recipients, skipped: r.counts.no_phone + r.counts.opted_out + r.counts.shared_phone_merged, ...r.summary };
  });
  await audit({ orgId, actor: req.user, action: 'whatsapp.campaign_confirmed', entityType: 'whatsapp_campaign', entityId: out.id, next: out, req });
  ok(res, out);
}));

router.post('/campaigns/:id/cancel', campaign, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCampaign(req, parse(uuid, req.params.id));
  if (!['scheduled', 'processing'].includes(c.status)) throw conflict(`A ${c.status} campaign cannot be cancelled.`, 'BAD_STATE');
  const out = await tx(async (db) => {
    const r = await exec(`UPDATE whatsapp_recipients SET status = 'cancelled', claim_token = NULL WHERE campaign_id = $1 AND status IN ('pending','queued')`, [c.id], db);
    await exec(`UPDATE whatsapp_campaigns SET status = 'cancelled', cancelled_at = NOW(3), cancelled_by = $2, finished_at = NOW(3) WHERE id = $1`, [c.id, req.user!.id], db);
    return { id: c.id, cancelled_recipients: r.affectedRows };
  });
  await audit({ orgId, actor: req.user, action: 'whatsapp.campaign_cancelled', entityType: 'whatsapp_campaign', entityId: c.id, next: out, req });
  ok(res, out);
}));

router.post('/campaigns/:id/retry-failed', campaign, wrap(async (req, res) => {
  const orgId = orgIdOf(req); const c = await loadCampaign(req, parse(uuid, req.params.id));
  if (!['completed', 'partially_failed', 'failed'].includes(c.status)) throw conflict('Only a finished campaign can be retried.', 'BAD_STATE');
  const out = await tx(async (db) => {
    // Opted-out numbers are never retried.
    const r = await exec(`UPDATE whatsapp_recipients r SET status = 'pending', attempts = 0, next_attempt_at = NULL, last_error = NULL, claim_token = NULL
        WHERE r.campaign_id = $1 AND r.status = 'failed' AND NOT EXISTS (SELECT 1 FROM whatsapp_optouts o WHERE o.org_id = r.org_id AND o.phone = r.phone)`, [c.id], db);
    if (r.affectedRows) await exec(`UPDATE whatsapp_campaigns SET status = 'processing', finished_at = NULL WHERE id = $1`, [c.id], db);
    return { id: c.id, requeued: r.affectedRows };
  });
  await audit({ orgId, actor: req.user, action: 'whatsapp.campaign_retried', entityType: 'whatsapp_campaign', entityId: c.id, next: out, req });
  ok(res, out);
}));

router.get('/campaigns/:id', wrap(async (req, res) => {
  const c = await loadCampaign(req, parse(uuid, req.params.id));
  const { selector, variables, variable_names, ...rest } = c;
  ok(res, { ...rest, selector, variables: variables ?? [], variable_names: variable_names ?? [], counts: await counts(c.id) });
}));

router.get('/campaigns/:id/recipients', wrap(async (req, res) => {
  const c = await loadCampaign(req, parse(uuid, req.params.id));
  const q = parse(z.object({ status: z.string().optional(), page: z.coerce.number().int().min(1).default(1), page_size: z.coerce.number().int().min(1).max(100).default(30) }), req.query);
  const p = new Params(); const w = [`r.campaign_id = ${p.add(c.id)}`]; if (q.status) w.push(`r.status = ${p.add(q.status)}`);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM whatsapp_recipients r WHERE ${w.join(' AND ')}`, p.values))!.n);
  const rows = await query(`SELECT r.id, r.learner_id, l.full_name, l.learner_code, r.phone, r.status, r.attempts, r.last_error, r.sent_at, r.delivered_at, r.read_at, r.next_attempt_at
      FROM whatsapp_recipients r JOIN learners l ON l.id = r.learner_id WHERE ${w.join(' AND ')} ORDER BY l.full_name, r.id LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows.map((r) => ({ ...r, phone: r.phone.replace(/\d(?=\d{4})/g, '•') })), { page: q.page, page_size: q.page_size, total });
}));

router.get('/recipients/:id/log', wrap(async (req, res) => {
  const r = await queryOne(`SELECT r.id, r.campaign_id FROM whatsapp_recipients r WHERE r.id = $1 AND r.org_id = $2`, [parse(uuid, req.params.id), orgIdOf(req)]);
  if (!r) throw notFound('Recipient');
  await loadCampaign(req, r.campaign_id);
  ok(res, await query(`SELECT event, status, error_code, error_message, created_at FROM whatsapp_messages WHERE recipient_id = $1 ORDER BY id`, [r.id]));
}));

/** Messages a learner's family was sent (staff view, learner scope applies). */
router.get('/learners/:id/messages', wrap(async (req, res) => {
  const p = new Params(); const sc = learnerScope(req.user!, p, 'l');
  const l = await queryOne(`SELECT l.id FROM learners l WHERE l.id = ${p.add(parse(uuid, req.params.id))} AND l.org_id = ${p.add(orgIdOf(req))} AND l.deleted_at IS NULL ${sc ? `AND ${sc}` : ''}`, p.values);
  if (!l) throw notFound('Learner');
  ok(res, (await query(`SELECT r.id, c.name AS campaign, c.id AS campaign_id, r.status, r.phone, r.sent_at, r.delivered_at, r.read_at, r.last_error FROM whatsapp_recipients r JOIN whatsapp_campaigns c ON c.id = r.campaign_id WHERE r.learner_id = $1 ORDER BY r.id DESC LIMIT 50`, [l.id]))
    .map((r) => ({ ...r, phone: r.phone.replace(/\d(?=\d{4})/g, '•') })));
}));

export default router;
