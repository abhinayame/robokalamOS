import { env } from '../../config/env.js';
import { Params, exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { isConfigured } from '../comms/aisensy.js';
import { render, resolvePeople } from '../comms/audience.js';
import { isConfigured as emailConfigured } from '../email/provider.js';
import { queueMessage, validEmail } from '../email/outbox.js';
import { createPayLink } from '../fees/paylinks.js';
import { isConfigured as paymentsConfigured } from '../fees/razorpay.js';
import { rupees, toPaise, todayIn } from '../fees/money.js';
import { orgInfo } from '../fees/service.js';

export const KINDS = ['fee_due', 'fee_overdue', 'class_upcoming', 'absence', 'demo_upcoming'] as const;
export type Kind = (typeof KINDS)[number];
const PEOPLE = ['learner_name', 'learner_first_name', 'parent_name', 'org_name', 'batch_name'];
/** The placeholders a rule's template values may use, per kind. */
export const TOKENS: Record<Kind, string[]> = {
  fee_due: [...PEOPLE, 'amount_due', 'due_date', 'installment_label', 'pay_link'],
  fee_overdue: [...PEOPLE, 'amount_due', 'due_date', 'installment_label', 'days_overdue', 'pay_link'],
  class_upcoming: [...PEOPLE, 'class_title', 'class_date', 'class_time'],
  absence: [...PEOPLE, 'class_title', 'class_date'],
  demo_upcoming: [...PEOPLE, 'demo_title', 'demo_date', 'demo_time', 'demo_where'],
};
export const KIND_INFO: Record<Kind, { label: string; offset_label: string; default_offset: number; description: string }> = {
  fee_due: { label: 'Fee due soon', offset_label: 'days before the due date', default_offset: 3, description: 'Tells the parent an installment is coming up. Sent once per installment.' },
  fee_overdue: { label: 'Fee overdue', offset_label: 'days after the due date', default_offset: 2, description: 'Chases an unpaid installment, optionally every few days up to a limit.' },
  class_upcoming: { label: 'Class reminder', offset_label: 'hours before the class', default_offset: 3, description: 'Reminds each learner (or parent) of a scheduled class. Sent once per class per learner.' },
  absence: { label: 'Absence follow-up', offset_label: 'hours after the absence was marked', default_offset: 1, description: 'Tells the parent their child was marked absent. Sent once per absence.' },
  demo_upcoming: { label: 'Demo class reminder', offset_label: 'hours before the demo', default_offset: 24, description: 'Reminds the family of a booked demo class. Sent once per booking.' },
};

export interface Rule {
  id: string; org_id: string; name: string; kind: Kind; channel: 'whatsapp' | 'email'; template_id: string | null; audience: 'parents' | 'learners'; variables: string[]; offset_value: number; repeat_days: number | null;
  max_sends: number; send_from_hour: number; send_to_hour: number; enabled: number | boolean; created_by: string | null;
}

interface Candidate { key: string; learner_id: string; ctx: Record<string, string>; installment_id?: string }

const hourIn = (tz: string, d = new Date()) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(d));
const dateLabel = (v: unknown, tz: string) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(String(v).length <= 10 ? `${v}T00:00:00Z` : String(v)));
const timeLabel = (v: unknown, tz: string) => new Intl.DateTimeFormat('en-IN', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(String(v)));
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
const LIMIT = 5000;

/** Everything a rule could act on right now (before removing what it has already handled). */
async function candidatesFor(rule: Rule, tz: string, orgName: string, db?: Db): Promise<Candidate[]> {
  const today = todayIn(tz); const o = rule.org_id;
  const base = { org_name: orgName };
  if (rule.kind === 'fee_due' || rule.kind === 'fee_overdue') {
    const p = new Params();
    const when = rule.kind === 'fee_due'
      ? `i.due_date >= ${p.add(today)} AND i.due_date <= DATE_ADD(${p.add(today)}, INTERVAL ${p.add(rule.offset_value)} DAY)`
      : `DATEDIFF(${p.add(today)}, i.due_date) >= ${p.add(rule.offset_value)}`;
    const rows = await query(`SELECT i.id, i.learner_id, i.label, i.amount, i.paid_amount, i.due_date, b.name AS batch_name
        FROM fee_installments i JOIN learner_fees f ON f.id = i.learner_fee_id AND f.status = 'active' JOIN learners l ON l.id = i.learner_id AND l.deleted_at IS NULL AND l.status = 'active' LEFT JOIN batches b ON b.id = f.batch_id
       WHERE i.org_id = ${p.add(o)} AND i.status IN ('pending','partial') AND ${when} ORDER BY i.due_date, i.id LIMIT ${LIMIT}`, p.values, db);
    const out: Candidate[] = [];
    for (const r of rows) {
      const od = daysBetween(today, String(r.due_date).slice(0, 10));
      let k = 0;
      if (rule.kind === 'fee_overdue') {
        k = rule.repeat_days ? Math.floor((od - rule.offset_value) / rule.repeat_days) : 0;
        if (k >= rule.max_sends) continue;
      }
      out.push({ key: `${rule.kind}:i:${r.id}:${k}`, learner_id: r.learner_id, installment_id: r.id, ctx: { ...base, batch_name: r.batch_name ?? '', amount_due: rupees(toPaise(r.amount) - toPaise(r.paid_amount)).replace(/\.00$/, ''), due_date: dateLabel(r.due_date, tz), installment_label: r.label, days_overdue: String(Math.max(od, 0)) } });
    }
    return out;
  }
  if (rule.kind === 'class_upcoming') {
    const p = new Params();
    const rows = await query(`SELECT s.id, s.title, s.starts_at, b.name AS batch_name, m.learner_id FROM class_sessions s JOIN batches b ON b.id = s.batch_id AND b.deleted_at IS NULL
        JOIN learner_batch_memberships m ON m.batch_id = s.batch_id AND m.status = 'active' JOIN learners l ON l.id = m.learner_id AND l.deleted_at IS NULL AND l.status = 'active'
       WHERE s.org_id = ${p.add(o)} AND s.status = 'scheduled' AND s.starts_at > NOW(3) AND s.starts_at <= DATE_ADD(NOW(3), INTERVAL ${p.add(rule.offset_value)} HOUR) ORDER BY s.starts_at, s.id LIMIT 20000`, p.values, db);
    return rows.map((r) => ({ key: `class_upcoming:s:${r.id}:${r.learner_id}`, learner_id: r.learner_id, ctx: { ...base, batch_name: r.batch_name, class_title: r.title || r.batch_name, class_date: dateLabel(r.starts_at, tz), class_time: timeLabel(r.starts_at, tz) } }));
  }
  if (rule.kind === 'demo_upcoming') {
    const p = new Params();
    const rows = await query(`SELECT bk.id, bk.learner_id, s.title, s.starts_at, s.location, s.meeting_url FROM demo_bookings bk JOIN demo_slots s ON s.id = bk.slot_id AND s.status = 'open'
        JOIN learners l ON l.id = bk.learner_id AND l.deleted_at IS NULL
       WHERE bk.org_id = ${p.add(o)} AND bk.status = 'booked' AND s.starts_at > NOW(3) AND s.starts_at <= DATE_ADD(NOW(3), INTERVAL ${p.add(rule.offset_value)} HOUR) ORDER BY s.starts_at, bk.id LIMIT 5000`, p.values, db);
    return rows.map((r) => ({ key: `demo_upcoming:b:${r.id}`, learner_id: r.learner_id, ctx: { ...base, batch_name: '', demo_title: r.title, demo_date: dateLabel(r.starts_at, tz), demo_time: timeLabel(r.starts_at, tz), demo_where: r.meeting_url ? 'online' : (r.location || 'our centre') } }));
  }
  const p = new Params();
  const rows = await query(`SELECT a.id, a.learner_id, s.title, s.starts_at, b.name AS batch_name FROM attendance a JOIN class_sessions s ON s.id = a.session_id JOIN batches b ON b.id = s.batch_id
      JOIN learners l ON l.id = a.learner_id AND l.deleted_at IS NULL AND l.status = 'active'
     WHERE a.org_id = ${p.add(o)} AND a.status = 'absent' AND a.marked_at <= DATE_SUB(NOW(3), INTERVAL ${p.add(rule.offset_value)} HOUR) AND a.marked_at >= DATE_SUB(NOW(3), INTERVAL 48 HOUR) ORDER BY a.marked_at, a.id LIMIT 20000`, p.values, db);
  return rows.map((r) => ({ key: `absence:a:${r.id}`, learner_id: r.learner_id, ctx: { ...base, batch_name: r.batch_name, class_title: r.title || r.batch_name, class_date: dateLabel(r.starts_at, tz) } }));
}

async function alreadyDone(ruleId: string, keys: string[], db?: Db) {
  const done = new Set<string>();
  for (let i = 0; i < keys.length; i += 1000) {
    const p = new Params();
    for (const r of await query(`SELECT dedupe_key FROM reminder_log WHERE rule_id = ${p.add(ruleId)} AND dedupe_key IN ${p.in(keys.slice(i, i + 1000))}`, p.values, db)) done.add(r.dedupe_key as string);
  }
  return done;
}

export interface RunResult { candidates: number; fresh: number; queued: number; campaigns: number; skipped: { no_phone: number; opted_out: number }; window_open: boolean; skipped_reason?: string; sample: { learner: string; phone: string; params: string[] }[] }

/**
 * One pass of one rule. `dryRun` reports what would be sent and writes nothing. Without `force` a rule only acts inside its sending hours.
 * Every reminder is claimed through the unique (rule, key) row first, so running twice, or on two servers, never sends twice.
 */
export async function runRule(ruleId: string, opts: { force?: boolean; dryRun?: boolean } = {}): Promise<RunResult> {
  const out: RunResult = { candidates: 0, fresh: 0, queued: 0, campaigns: 0, skipped: { no_phone: 0, opted_out: 0 }, window_open: true, sample: [] };
  const rule = await queryOne(`SELECT r.*, t.variable_names, t.status AS template_status FROM reminder_rules r LEFT JOIN whatsapp_templates t ON t.id = r.template_id AND t.org_id = r.org_id WHERE r.id = $1`, [ruleId]) as (Rule & { variable_names: string[] | null; template_status: string | null }) | null;
  if (!rule) throw new Error('Rule not found');
  const org = await orgInfo(rule.org_id);
  const hour = hourIn(org.tz);
  out.window_open = hour >= rule.send_from_hour && hour < rule.send_to_hour;
  if (!opts.dryRun) {
    if (!opts.force && !out.window_open) { out.skipped_reason = 'outside sending hours'; return out; }
    if (rule.channel === 'email' && !emailConfigured()) { out.skipped_reason = 'E-mail is not configured'; return out; }
    if (rule.channel === 'whatsapp' && rule.template_status !== 'active') { out.skipped_reason = 'template is switched off'; return out; }
    if (rule.channel === 'whatsapp' && !isConfigured()) { out.skipped_reason = 'WhatsApp is not configured'; return out; }
  }
  const all = await candidatesFor(rule, org.tz, org.name);
  out.candidates = all.length;
  const done = await alreadyDone(rule.id, all.map((c) => c.key));
  let fresh = all.filter((c) => !done.has(c.key));
  out.fresh = fresh.length;
  const usesLink = rule.variables.some((v) => /\{pay_link\}/.test(v));
  if (usesLink && !paymentsConfigured()) { if (!opts.dryRun) { out.skipped_reason = 'the message uses {pay_link} but online payments are not configured'; return out; } }

  // Payment links are made before the database transaction: they call out to Razorpay and must not hold locks while they wait.
  if (usesLink && !opts.dryRun && paymentsConfigured()) {
    for (const c of fresh) {
      if (!c.installment_id) continue;
      try { c.ctx.pay_link = (await createPayLink({ orgId: rule.org_id, userId: null }, c.learner_id, [c.installment_id])).short_url; }
      catch (e: any) { c.ctx.pay_link = ''; logger.warn({ err: e?.message }, 'reminder: could not create a payment link'); }
    }
  }
  const ids = [...new Set(fresh.map((c) => c.learner_id))];
  if (rule.channel === 'email') return runEmailRule(rule, org, fresh, ids, out, !!opts.dryRun);
  const people = await resolvePeople(rule.org_id, ids, rule.audience, undefined, { oneMessagePerPhone: false });
  const who = new Map(people.recipients.map((r) => [r.learner_id, r]));
  const why = new Map(people.skipped.map((s) => [s.learner_id, s.reason]));
  const render1 = (c: Candidate) => { const r = who.get(c.learner_id)!; const ctx = { ...c.ctx, learner_name: r.learner_name, learner_first_name: r.learner_name.split(/\s+/)[0] ?? r.learner_name, parent_name: r.parent_name ?? 'Parent' }; return rule.variables.map((v) => render(v, ctx)); };
  const sendable = fresh.filter((c) => who.has(c.learner_id));
  out.skipped.no_phone = fresh.filter((c) => why.get(c.learner_id) === 'no_phone').length;
  out.skipped.opted_out = fresh.filter((c) => why.get(c.learner_id) === 'opted_out').length;
  out.sample = sendable.slice(0, 5).map((c) => ({ learner: who.get(c.learner_id)!.learner_name, phone: who.get(c.learner_id)!.phone.replace(/\d(?=\d{4})/g, '•'), params: render1(c) }));
  if (opts.dryRun) { out.queued = sendable.length; return out; }

  await tx(async (db) => {
    await queryOne(`SELECT id FROM reminder_rules WHERE id = $1 FOR UPDATE`, [rule.id], db);                 // two servers: one at a time
    const again = await alreadyDone(rule.id, fresh.map((c) => c.key), db);
    fresh = fresh.filter((c) => !again.has(c.key));
    const send = fresh.filter((c) => who.has(c.learner_id));
    // A phone (a parent with two children) and a learner can appear once per campaign, so extra reminders go in a later wave.
    const waves: { phones: Set<string>; learners: Set<string>; items: Candidate[] }[] = [];
    for (const c of send) {
      const r = who.get(c.learner_id)!;
      let w = waves.find((x) => !x.phones.has(r.phone) && !x.learners.has(c.learner_id));
      if (!w) { w = { phones: new Set(), learners: new Set(), items: [] }; waves.push(w); }
      w.phones.add(r.phone); w.learners.add(c.learner_id); w.items.push(c);
    }
    const stamp = new Intl.DateTimeFormat('en-IN', { timeZone: org.tz, day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date());
    for (const [n, w] of waves.entries()) {
      const cid = newId();
      await exec(`INSERT INTO whatsapp_campaigns (id, org_id, name, template_id, audience, selector, variables, status, created_by, confirmed_at, started_at, unique_learners, total_recipients, kind, rule_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,'processing',$8,NOW(3),NOW(3),$9,$9,'auto',$10)`,
        [cid, rule.org_id, `${rule.name} · ${stamp}${waves.length > 1 ? ` (${n + 1}/${waves.length})` : ''}`.slice(0, 160), rule.template_id, rule.audience, JSON.stringify({ auto: true, rule: rule.id }), JSON.stringify(rule.variables), rule.created_by ?? await fallbackCreator(rule.org_id, db), w.items.length, rule.id], db);
      for (let i = 0; i < w.items.length; i += 500) {
        const ip = new Params(); const lp = new Params();
        const part = w.items.slice(i, i + 500);
        await exec(`INSERT INTO whatsapp_recipients (id, org_id, campaign_id, learner_id, parent_id, phone, params) VALUES ${part.map((c) => { const r = who.get(c.learner_id)!; return `(${ip.add(newId())},${ip.add(rule.org_id)},${ip.add(cid)},${ip.add(c.learner_id)},${ip.add(r.parent_id)},${ip.add(r.phone)},${ip.add(JSON.stringify(render1(c)))})`; }).join(',')}`, ip.values, db);
        await exec(`INSERT INTO reminder_log (org_id, rule_id, dedupe_key, learner_id, campaign_id, outcome) VALUES ${part.map((c) => `(${lp.add(rule.org_id)},${lp.add(rule.id)},${lp.add(c.key)},${lp.add(c.learner_id)},${lp.add(cid)},'queued')`).join(',')}`, lp.values, db);
      }
      out.queued += w.items.length; out.campaigns++;
    }
    const skip = fresh.filter((c) => !who.has(c.learner_id));
    for (let i = 0; i < skip.length; i += 500) {
      const lp = new Params();
      await exec(`INSERT INTO reminder_log (org_id, rule_id, dedupe_key, learner_id, outcome, reason) VALUES ${skip.slice(i, i + 500).map((c) => `(${lp.add(rule.org_id)},${lp.add(rule.id)},${lp.add(c.key)},${lp.add(c.learner_id)},'skipped',${lp.add(why.get(c.learner_id) ?? 'no_phone')})`).join(',')}`, lp.values, db);
    }
    await exec(`UPDATE reminder_rules SET last_run_at = NOW(3) WHERE id = $1`, [rule.id], db);
  });
  return out;
}

/** The e-mail branch: same candidates, same once-only log, but each reminder becomes a message in the e-mail outbox. */
async function runEmailRule(rule: Rule, org: { tz: string; name: string }, fresh: Candidate[], ids: string[], out: RunResult, dryRun: boolean): Promise<RunResult> {
  const branding = await queryOne(`SELECT COALESCE(brand_app_name, name) AS name, brand_color FROM organizations WHERE id = $1`, [rule.org_id]);
  const addr = new Map<string, { email: string; name: string; parent_name: string | null; learner_name: string }>();
  for (let i = 0; i < ids.length; i += 1000) {
    const p = new Params(); const part = ids.slice(i, i + 1000);
    const ls = await query(`SELECT id, full_name, email FROM learners WHERE id IN ${p.in(part)} AND deleted_at IS NULL`, p.values);
    const pp = new Params();
    const ps = rule.audience === 'parents' ? await query(`SELECT lp.learner_id, pa.full_name, pa.email FROM learner_parents lp JOIN parents pa ON pa.id = lp.parent_id AND pa.deleted_at IS NULL WHERE lp.learner_id IN ${pp.in(part)} AND pa.email IS NOT NULL ORDER BY lp.is_primary DESC, lp.created_at, pa.id`, pp.values) : [];
    const par = new Map<string, any>(); for (const r of ps) if (validEmail(r.email) && !par.has(r.learner_id)) par.set(r.learner_id, r);
    for (const l of ls) {
      const x = rule.audience === 'parents' ? par.get(l.id) : l;
      if (x && validEmail(x.email)) addr.set(l.id, { email: x.email.trim().toLowerCase(), name: x.full_name, parent_name: rule.audience === 'parents' ? x.full_name : null, learner_name: l.full_name });
    }
  }
  const opted = new Set((await query(`SELECT email FROM email_optouts WHERE org_id = $1 OR org_id IS NULL`, [rule.org_id])).map((r) => r.email as string));
  const reasonFor = (c: Candidate) => { const a = addr.get(c.learner_id); return !a ? 'no_email' : opted.has(a.email) ? 'opted_out' : null; };
  const sendable = fresh.filter((c) => !reasonFor(c));
  out.skipped = { no_phone: fresh.filter((c) => reasonFor(c) === 'no_email').length, opted_out: fresh.filter((c) => reasonFor(c) === 'opted_out').length };
  const make = (c: Candidate) => { const a = addr.get(c.learner_id)!; const ctx = { ...c.ctx, learner_name: a.learner_name, learner_first_name: a.learner_name.split(/\s+/)[0] ?? a.learner_name, parent_name: a.parent_name ?? 'Parent' }; return { subject: render(rule.variables[0] ?? '', ctx), text: (rule as any).email_body ? renderBody((rule as any).email_body as string, ctx) : '' }; };
  out.sample = sendable.slice(0, 5).map((c) => { const m = make(c); return { learner: addr.get(c.learner_id)!.learner_name, phone: addr.get(c.learner_id)!.email.replace(/^(.).*(@.*)$/, '$1•••$2'), params: [m.subject] }; });
  if (dryRun) { out.queued = sendable.length; return out; }
  await tx(async (db) => {
    await queryOne(`SELECT id FROM reminder_rules WHERE id = $1 FOR UPDATE`, [rule.id], db);
    const again = await alreadyDone(rule.id, fresh.map((c) => c.key), db);
    const todo = fresh.filter((c) => !again.has(c.key));
    for (const c of todo) {
      const why = reasonFor(c); const lp = new Params();
      if (why) { await exec(`INSERT INTO reminder_log (org_id, rule_id, dedupe_key, learner_id, outcome, reason) VALUES (${lp.add(rule.org_id)},${lp.add(rule.id)},${lp.add(c.key)},${lp.add(c.learner_id)},'skipped',${lp.add(why)})`, lp.values, db); continue; }
      const a = addr.get(c.learner_id)!; const m = make(c);
      await queueMessage({ orgId: rule.org_id, orgName: branding?.name ?? org.name, color: branding?.brand_color ?? undefined, to: a.email, toName: a.name, subject: m.subject, paragraphs: m.text.split(/\n{2,}/).map((t) => t.trim()).filter(Boolean), category: 'notification', learnerId: c.learner_id, dedupeKey: `rule:${rule.id}:${c.key}` }, db);
      await exec(`INSERT INTO reminder_log (org_id, rule_id, dedupe_key, learner_id, outcome) VALUES (${lp.add(rule.org_id)},${lp.add(rule.id)},${lp.add(c.key)},${lp.add(c.learner_id)},'queued')`, lp.values, db);
      out.queued++;
    }
    await exec(`UPDATE reminder_rules SET last_run_at = NOW(3) WHERE id = $1`, [rule.id], db);
  });
  return out;
}
/** Like render(), but keeps paragraph breaks (e-mail bodies are several paragraphs). */
const renderBody = (t: string, ctx: Record<string, string>) => t.split(/\n{2,}/).map((x) => render(x, ctx)).join('\n\n');

async function fallbackCreator(orgId: string, db: Db) {
  const u = await queryOne(`SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.org_id = $1 AND r.code = 'org_admin' AND u.deleted_at IS NULL ORDER BY u.created_at LIMIT 1`, [orgId], db);
  if (!u) throw new Error('No organization admin to own automatic campaigns.');
  return u.id as string;
}

/** Every enabled rule, once. Errors in one rule never stop the others. */
export async function runAllRules() {
  const rules = await query(`SELECT r.id FROM reminder_rules r JOIN organizations o ON o.id = r.org_id AND o.status = 'active' AND o.deleted_at IS NULL WHERE r.enabled = TRUE`);
  const totals = { rules: rules.length, queued: 0, campaigns: 0 };
  for (const r of rules) {
    try { const x = await runRule(r.id); totals.queued += x.queued; totals.campaigns += x.campaigns; }
    catch (e) { logger.error({ err: e, rule: r.id }, 'reminder rule failed'); }
  }
  return totals;
}

let timer: NodeJS.Timeout | null = null; let first: NodeJS.Timeout | null = null; let busy = false;
export function startReminders() {
  if (env.COMMS_WORKER !== 'true' || env.REMINDERS !== 'true' || timer) return;
  const pass = async () => { if (busy || !isConfigured()) return; busy = true; try { const t = await runAllRules(); if (t.queued) logger.info(t, 'reminders queued'); } catch (e) { logger.error({ err: e }, 'reminder pass failed'); } finally { busy = false; } };
  first = setTimeout(pass, 90_000); first.unref();
  timer = setInterval(pass, 5 * 60_000); timer.unref();
}
export function stopReminders() { if (timer) clearInterval(timer); if (first) clearTimeout(first); timer = null; first = null; }
