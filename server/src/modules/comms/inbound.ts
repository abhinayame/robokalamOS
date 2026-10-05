import { createHash } from 'node:crypto';
import { exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { notifyUsers } from '../../lib/notify.js';
import { changeStatus } from '../crm/routes.js';
import { createFollowUp, logCrmActivity } from '../crm/service.js';

export type Intent = 'stop' | 'start' | 'interested' | 'other';
export interface InboundMessage { providerId: string; phone: string; text: string }

/** Plain keywords only: a message is a STOP only when that is all it says, so "please don't stop the class" is never an opt-out. */
export function classify(text: string): Intent {
  const t = text.toLowerCase().replace(/[^a-zऀ-ॿ ]+/g, ' ').trim().replace(/\s+/g, ' ');
  if (/^(stop|stop all|unsubscribe|cancel|opt out|optout|do not message|dont message|remove me)$/.test(t)) return 'stop';
  if (/^(start|subscribe|opt in|optin|unstop)$/.test(t)) return 'start';
  if (/^(yes|y|interested|demo|info|details|offer|book|call me|callback|schedule|fees|price)$/.test(t)) return 'interested';
  return 'other';
}

interface Match { org_id: string; learner_id: string }
/** Everyone in any organization that this phone number belongs to: as the learner's own number, or as a parent's. */
async function who(e164: string, db: Db): Promise<Match[]> {
  return query(`SELECT l.org_id, l.id AS learner_id FROM learners l WHERE l.mobile = $1 AND l.deleted_at IS NULL
      UNION SELECT l.org_id, l.id FROM parents pa JOIN learner_parents lp ON lp.parent_id = pa.id JOIN learners l ON l.id = lp.learner_id AND l.deleted_at IS NULL WHERE pa.mobile = $1 AND pa.deleted_at IS NULL`, [e164], db) as Promise<Match[]>;
}

/**
 * Act on messages people send us. STOP / START change the opt-out list in every organization that knows the number; a keyword like YES or
 * DEMO from a lead is logged on the CRM record, moves the lead to "interested" and hands the counsellor a follow-up due now. Anything else
 * is logged on the lead (if there is one) and shown in the Replies tab. A repeat of the same provider message is ignored.
 */
export async function processInbound(messages: InboundMessage[]) {
  const out = { received: messages.length, duplicate: 0, opted_out: 0, opted_in: 0, lead_updates: 0, logged: 0 };
  for (const m of messages) {
    const digits = m.phone.replace(/\D/g, ''); if (digits.length < 10) { out.logged++; continue; }
    const e164 = `+${digits}`; const intent = classify(m.text); const key = `meta-in:${m.providerId}`.slice(0, 190);
    await tx(async (db) => {
      try { await exec(`INSERT INTO webhook_events (provider, event_key, payload, outcome) VALUES ('meta',$1,$2,'inbound')`, [key, JSON.stringify({ phone: e164.replace(/\d(?=\d{4})/g, '•'), intent })], db); }
      catch (e: any) { if (e?.errno === 1062) { out.duplicate++; return; } throw e; }
      const people = await who(e164, db); const orgs = [...new Set(people.map((p) => p.org_id))];
      const body = m.text.slice(0, 1000);
      const log = async (orgId: string | null, learnerId: string | null, outcome: string) => exec(`INSERT INTO whatsapp_inbound (id, org_id, phone, learner_id, provider_message_id, body, intent, outcome) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [newId(), orgId, e164, learnerId, m.providerId, body, intent, outcome], db);
      if (!people.length) { await log(null, null, 'unknown_number'); out.logged++; return; }
      if (intent === 'stop') {
        for (const o of orgs) { await exec(`INSERT IGNORE INTO whatsapp_optouts (id, org_id, phone, reason) VALUES ($1,$2,$3,'Replied STOP on WhatsApp')`, [newId(), o, e164], db); await log(o, null, 'opted_out'); }
        out.opted_out++; return;
      }
      if (intent === 'start') {
        for (const o of orgs) { await exec(`DELETE FROM whatsapp_optouts WHERE org_id = $1 AND phone = $2`, [o, e164], db); await log(o, null, 'opted_in'); }
        out.opted_in++; return;
      }
      // Only STOP and START apply across schools. Anything else is shown only when exactly one school knows this number, so one school never reads another's conversation.
      if (orgs.length > 1) { await log(null, null, 'ambiguous_school'); out.logged++; return; }
      for (const p of people) {
        const lead = await queryOne(`SELECT lead_status, counsellor_user_id FROM crm_leads WHERE learner_id = $1`, [p.learner_id], db);
        if (!lead) { await log(p.org_id, p.learner_id, 'logged'); out.logged++; continue; }
        await logCrmActivity(db, { orgId: p.org_id, learnerId: p.learner_id, type: 'whatsapp_reply', description: `Replied on WhatsApp: "${body.slice(0, 200)}"` });
        if (intent === 'interested' && ['new', 'contacted'].includes(lead.lead_status)) await changeStatus(db, { orgId: p.org_id, learnerId: p.learner_id, to: 'interested', actorId: lead.counsellor_user_id ?? null });
        const closed = ['converted', 'not_interested', 'lost'].includes(lead.lead_status);
        if (lead.counsellor_user_id && !closed) {
          const open = await queryOne(`SELECT 1 FROM follow_ups WHERE learner_id = $1 AND status = 'open' AND note LIKE 'Replied on WhatsApp%' AND created_at > DATE_SUB(NOW(3), INTERVAL 1 DAY)`, [p.learner_id], db);
          if (!open) await createFollowUp(db, { orgId: p.org_id, learnerId: p.learner_id, assignedTo: lead.counsellor_user_id, dueAt: new Date(), note: `Replied on WhatsApp: "${body.slice(0, 120)}"`, actorId: lead.counsellor_user_id, quiet: true });
          await notifyUsers(db, { orgId: p.org_id, userIds: [lead.counsellor_user_id], kind: 'lead.replied', title: 'A lead replied on WhatsApp', body: body.slice(0, 200), link: `/learners/${p.learner_id}`, learnerId: null });
        }
        await log(p.org_id, p.learner_id, intent === 'interested' ? 'lead_interested' : 'lead_logged'); out.lead_updates++;
      }
    });
  }
  return out;
}

/** Meta: entry[].changes[].value.messages[]. Text, button and quick-reply messages carry text; media is recorded as "[media]". */
export function parseMetaInbound(body: any): InboundMessage[] {
  const out: InboundMessage[] = [];
  for (const e of Array.isArray(body?.entry) ? body.entry : []) for (const c of Array.isArray(e?.changes) ? e.changes : []) for (const m of Array.isArray(c?.value?.messages) ? c.value.messages : []) {
    if (!m?.from) continue;
    const text = m.text?.body ?? m.button?.text ?? m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[media]';
    out.push({ providerId: String(m.id ?? createHash('sha256').update(JSON.stringify(m)).digest('hex')), phone: String(m.from), text: String(text) });
  }
  return out;
}
