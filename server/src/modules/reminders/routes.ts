import { Router } from 'express';
import { z } from 'zod';
import { Params, exec, newId, query, queryOne } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { ok, paging, parse, uuid, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg, requirePerm } from '../../middleware/auth.js';
import { isConfigured } from '../comms/aisensy.js';
import { tokensIn } from '../comms/audience.js';
import { isConfigured as paymentsConfigured } from '../fees/razorpay.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { KINDS, KIND_INFO, TOKENS, runRule, type Kind } from './engine.js';

const router = Router();
router.use(requireOrg, requirePerm('comms:read'));
const manage = requirePerm('comms:manage');

const body = z.object({
  name: z.string().trim().min(2, 'Name the rule.').max(120), kind: z.enum(KINDS), channel: z.enum(['whatsapp', 'email']).default('whatsapp'), template_id: uuid.nullish(), email_subject: z.string().trim().max(200).nullish(), email_body: z.string().trim().max(3000).nullish(), audience: z.enum(['parents', 'learners']).default('parents'),
  variables: z.array(z.string().max(1000)).max(10).default([]), offset_value: z.number().int().min(0).max(720),
  repeat_days: z.number().int().min(1).max(90).nullish(), max_sends: z.number().int().min(1).max(12).default(1),
  send_from_hour: z.number().int().min(0).max(23).default(9), send_to_hour: z.number().int().min(1).max(24).default(20), enabled: z.boolean().default(false),
});
type Body = z.infer<typeof body>;

async function validate(orgId: string, b: Body) {
  if (b.channel === 'email') {
    if (!b.email_subject?.trim() || !b.email_body?.trim()) throw badRequest('Write the e-mail subject and message.', [{ field: 'email_body', message: 'Subject and message are required.' }]);
    b.variables = [b.email_subject, b.email_body]; b.template_id = null;
  } else {
    if (!b.template_id) throw badRequest('Choose a WhatsApp template.', [{ field: 'template_id', message: 'Required.' }]);
    b.email_subject = null; b.email_body = null;
    const t = await queryOne(`SELECT variable_names, status FROM whatsapp_templates WHERE id = $1 AND org_id = $2`, [b.template_id, orgId]);
    if (!t) throw notFound('Template');
    if (t.status !== 'active') throw badRequest('That template is switched off.', [{ field: 'template_id', message: 'Choose an active template.' }]);
    const n = ((t.variable_names as string[] | null) ?? []).length;
    if (b.variables.length !== n) throw badRequest(`This template needs ${n} value${n === 1 ? '' : 's'}.`, [{ field: 'variables', message: `Provide ${n} value${n === 1 ? '' : 's'}.` }]);
  }
  const allowed = TOKENS[b.kind as Kind];
  const bad = [...new Set(b.variables.flatMap(tokensIn))].filter((x) => !allowed.includes(x));
  if (bad.length) throw badRequest(`{${bad[0]}} cannot be used in a "${KIND_INFO[b.kind as Kind].label}" reminder. You can use ${allowed.map((x) => `{${x}}`).join(', ')}.`, [{ field: 'variables', message: `Unknown placeholder {${bad[0]}}.` }]);
  if (b.audience === 'learners' && b.variables.some((v) => tokensIn(v).includes('parent_name'))) throw badRequest('{parent_name} only works when messaging parents.', [{ field: 'variables', message: 'Switch to parents or remove {parent_name}.' }]);
  if (b.variables.some((v) => !v.trim())) throw badRequest('Fill in every template value.', [{ field: 'variables', message: 'Every value is required.' }]);
  if (b.send_from_hour >= b.send_to_hour) throw badRequest('The sending window must end after it starts.', [{ field: 'send_to_hour', message: 'Choose a later end hour.' }]);
  if (b.kind !== 'fee_overdue' && (b.repeat_days || b.max_sends > 1)) throw badRequest('Repeating only applies to overdue-fee reminders.', [{ field: 'repeat_days', message: 'Only for fee overdue.' }]);
  if (b.kind === 'fee_overdue' && b.max_sends > 1 && !b.repeat_days) throw badRequest('Say how many days apart the repeats are.', [{ field: 'repeat_days', message: 'Required when sending more than once.' }]);
}
const dup = (e: any) => { if (e?.errno === 1062) throw conflict('A rule with that name already exists.', 'DUPLICATE'); throw e; };

router.get('/meta', wrap(async (_req, res) => {
  ok(res, { whatsapp_configured: isConfigured(), email_configured: emailConfigured(), online_payments: paymentsConfigured(), kinds: KINDS.map((k) => ({ kind: k, ...KIND_INFO[k], tokens: TOKENS[k] })) });
}));

router.get('/rules', wrap(async (req, res) => {
  const rows = await query(`SELECT r.id, r.name, r.kind, r.channel, r.email_subject, r.email_body, r.template_id, r.audience, r.variables, r.offset_value, r.repeat_days, r.max_sends, r.send_from_hour, r.send_to_hour, r.enabled, r.last_run_at, r.created_at, t.name AS template_name,
      (SELECT COUNT(*) FROM reminder_log g WHERE g.rule_id = r.id AND g.outcome = 'queued') AS sent_total,
      (SELECT COUNT(*) FROM reminder_log g WHERE g.rule_id = r.id AND g.outcome = 'queued' AND g.created_at >= DATE_SUB(NOW(3), INTERVAL 7 DAY)) AS sent_7d,
      (SELECT COUNT(*) FROM reminder_log g WHERE g.rule_id = r.id AND g.outcome = 'skipped') AS skipped_total
    FROM reminder_rules r LEFT JOIN whatsapp_templates t ON t.id = r.template_id AND t.org_id = r.org_id WHERE r.org_id = $1 ORDER BY r.kind, r.name`, [orgIdOf(req)]);
  ok(res, rows.map((r) => ({ ...r, enabled: !!r.enabled, sent_total: Number(r.sent_total), sent_7d: Number(r.sent_7d), skipped_total: Number(r.skipped_total) })));
}));

router.post('/rules', manage, wrap(async (req, res) => {
  const b = parse(body, req.body); const orgId = orgIdOf(req);
  await validate(orgId, b);
  const id = newId();
  await exec(`INSERT INTO reminder_rules (id, org_id, name, kind, channel, email_subject, email_body, template_id, audience, variables, offset_value, repeat_days, max_sends, send_from_hour, send_to_hour, enabled, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
    [id, orgId, b.name, b.kind, b.channel, b.email_subject ?? null, b.email_body ?? null, b.template_id ?? null, b.audience, JSON.stringify(b.variables), b.offset_value, b.repeat_days ?? null, b.max_sends, b.send_from_hour, b.send_to_hour, b.enabled, req.user!.id]).catch(dup);
  await audit({ orgId, actor: req.user, action: 'reminder_rule.created', entityType: 'reminder_rule', entityId: id, next: { name: b.name, kind: b.kind, enabled: b.enabled }, req });
  ok(res, { id }, undefined, 201);
}));

router.patch('/rules/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id); const orgId = orgIdOf(req);
  const cur = await queryOne(`SELECT name, kind, channel, email_subject, email_body, template_id, audience, variables, offset_value, repeat_days, max_sends, send_from_hour, send_to_hour, enabled FROM reminder_rules WHERE id = $1 AND org_id = $2`, [id, orgId]);
  if (!cur) throw notFound('Reminder rule');
  const b = parse(body, { ...cur, enabled: !!cur.enabled, ...req.body });
  await validate(orgId, b);
  await exec(`UPDATE reminder_rules SET name = $2, kind = $3, channel = $13, email_subject = $14, email_body = $15, template_id = $4, audience = $5, variables = $6, offset_value = $7, repeat_days = $8, max_sends = $9, send_from_hour = $10, send_to_hour = $11, enabled = $12 WHERE id = $1`,
    [id, b.name, b.kind, b.template_id ?? null, b.audience, JSON.stringify(b.variables), b.offset_value, b.repeat_days ?? null, b.max_sends, b.send_from_hour, b.send_to_hour, b.enabled, b.channel, b.email_subject ?? null, b.email_body ?? null]).catch(dup);
  await audit({ orgId, actor: req.user, action: b.enabled !== !!cur.enabled ? (b.enabled ? 'reminder_rule.enabled' : 'reminder_rule.disabled') : 'reminder_rule.updated', entityType: 'reminder_rule', entityId: id, previous: { enabled: !!cur.enabled }, next: { name: b.name, kind: b.kind, enabled: b.enabled }, req });
  ok(res, { id });
}));

router.delete('/rules/:id', manage, wrap(async (req, res) => {
  const id = parse(uuid, req.params.id);
  const r = await exec(`DELETE FROM reminder_rules WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]);
  if (!r.affectedRows) throw notFound('Reminder rule');
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'reminder_rule.deleted', entityType: 'reminder_rule', entityId: id, req });
  ok(res, { id, deleted: true });
}));

async function ownRule(req: any) {
  const id = parse(uuid, req.params.id);
  if (!(await queryOne(`SELECT 1 FROM reminder_rules WHERE id = $1 AND org_id = $2`, [id, orgIdOf(req)]))) throw notFound('Reminder rule');
  return id;
}

/** What this rule would send right now. Writes nothing. */
router.post('/rules/:id/preview', manage, wrap(async (req, res) => ok(res, await runRule(await ownRule(req), { dryRun: true }))));

/** Run the rule now (ignores the sending hours; still never repeats a reminder it already queued). */
router.post('/rules/:id/run', limit('bulk', 30), manage, wrap(async (req, res) => {
  const id = await ownRule(req);
  const r = await runRule(id, { force: true });
  await audit({ orgId: orgIdOf(req), actor: req.user, action: 'reminder_rule.run_now', entityType: 'reminder_rule', entityId: id, next: { queued: r.queued, campaigns: r.campaigns, skipped_reason: r.skipped_reason }, req });
  ok(res, r);
}));

router.get('/log', wrap(async (req, res) => {
  const q = parse(paging.extend({ rule_id: uuid.optional(), outcome: z.enum(['queued', 'skipped']).optional() }), req.query);
  const p = new Params(); const w = [`g.org_id = ${p.add(orgIdOf(req))}`];
  if (q.rule_id) w.push(`g.rule_id = ${p.add(q.rule_id)}`); if (q.outcome) w.push(`g.outcome = ${p.add(q.outcome)}`);
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM reminder_log g WHERE ${w.join(' AND ')}`, p.values))!.n);
  const rows = await query(`SELECT g.id, g.created_at, g.outcome, g.reason, g.campaign_id, r.name AS rule_name, r.kind, l.id AS learner_id, l.full_name, l.learner_code
      FROM reminder_log g JOIN reminder_rules r ON r.id = g.rule_id JOIN learners l ON l.id = g.learner_id WHERE ${w.join(' AND ')} ORDER BY g.id DESC LIMIT ${q.page_size} OFFSET ${(q.page - 1) * q.page_size}`, p.values);
  ok(res, rows, { page: q.page, page_size: q.page_size, total, total_pages: Math.ceil(total / q.page_size) });
}));

export default router;
