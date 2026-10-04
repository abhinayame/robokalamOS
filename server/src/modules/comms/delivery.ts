import { env } from '../../config/env.js';
import { exec, newId, query, queryOne, tx, type Db } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';
import { createHash } from 'node:crypto';
import { getProvider, parseWebhook, sleep, validateRecipient, type DeliveryStatus, type WhatsAppProvider } from './aisensy.js';

const RANK: Record<string, number> = { pending: 0, queued: 1, sent: 2, delivered: 3, read: 4 };
const BACKOFF_MIN = [1, 5, 15];            // retry after 1, 5, 15 minutes
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

async function logMessage(db: Db, m: { orgId: string; campaignId: string | null; recipientId: string | null; learnerId: string | null; phone: string | null; providerId?: string | null; event: string; status: string; errorCode?: string | null; errorMessage?: string | null }) {
  await exec(`INSERT INTO whatsapp_messages (org_id, campaign_id, recipient_id, learner_id, phone, provider_message_id, event, status, error_code, error_message) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [m.orgId, m.campaignId, m.recipientId, m.learnerId, m.phone, m.providerId ?? null, m.event, m.status, m.errorCode ?? null, m.errorMessage?.slice(0, 500) ?? null], db);
}

/** Close campaigns whose recipients are all finished. */
export async function finalizeCampaigns(db?: Db) {
  const open = await query(`SELECT c.id FROM whatsapp_campaigns c WHERE c.status = 'processing'
      AND NOT EXISTS (SELECT 1 FROM whatsapp_recipients r WHERE r.campaign_id = c.id AND r.status IN ('pending','queued'))`, [], db);
  for (const c of open) {
    const r = await queryOne(`SELECT COALESCE(SUM(status = 'failed'), 0) AS failed, COALESCE(SUM(status IN ('sent','delivered','read')), 0) AS ok FROM whatsapp_recipients WHERE campaign_id = $1`, [c.id], db);
    const failed = Number(r!.failed); const okN = Number(r!.ok);
    const status = failed === 0 ? 'completed' : okN === 0 ? 'failed' : 'partially_failed';
    await exec(`UPDATE whatsapp_campaigns SET status = $1, finished_at = NOW(3) WHERE id = $2 AND status = 'processing'`, [status, c.id], db);
  }
  return open.length;
}

/**
 * One pass of the sender. Safe to run from several processes at once (rows are claimed with a token).
 * Scheduled campaigns start when due; stuck claims are released; failures retry with back-off, then stop.
 */
export async function runWorkerOnce(opts: { provider?: WhatsAppProvider; limit?: number; perSecond?: number } = {}) {
  const provider = opts.provider ?? getProvider();
  const limit = opts.limit ?? 50;
  await exec(`UPDATE whatsapp_campaigns SET status = 'processing', started_at = COALESCE(started_at, NOW(3)) WHERE status = 'scheduled' AND scheduled_at <= NOW(3)`);
  await exec(`UPDATE whatsapp_recipients SET status = 'pending', claim_token = NULL WHERE status = 'queued' AND claimed_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)`);
  const token = newId();
  const claimed = await exec(
    `UPDATE whatsapp_recipients SET status = 'queued', claimed_at = NOW(3), claim_token = $1
      WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3))
        AND campaign_id IN (SELECT id FROM (SELECT id FROM whatsapp_campaigns WHERE status = 'processing') c)
      ORDER BY id LIMIT ${Math.max(1, Math.min(limit, 500))}`, [token]);
  const stats = { claimed: claimed.affectedRows, sent: 0, retried: 0, failed: 0 };
  if (stats.claimed) {
    const rows = await query(
      `SELECT r.id, r.org_id, r.campaign_id, r.learner_id, r.phone, r.params, r.attempts, t.aisensy_campaign_name, l.full_name
         FROM whatsapp_recipients r JOIN whatsapp_campaigns c ON c.id = r.campaign_id JOIN whatsapp_templates t ON t.id = c.template_id JOIN learners l ON l.id = r.learner_id
        WHERE r.claim_token = $1 ORDER BY r.id`, [token]);
    const gap = 1000 / (opts.perSecond ?? env.WHATSAPP_RATE_PER_SECOND);
    for (const r of rows) {
      const t0 = Date.now();
      const v = validateRecipient(r.phone);
      const opted = await queryOne(`SELECT 1 FROM whatsapp_optouts WHERE org_id = $1 AND phone = $2`, [r.org_id, r.phone]);
      const live = await queryOne(`SELECT status FROM whatsapp_campaigns WHERE id = $1`, [r.campaign_id]);
      if (live?.status !== 'processing') { await exec(`UPDATE whatsapp_recipients SET status = 'cancelled', claim_token = NULL WHERE id = $1 AND status = 'queued'`, [r.id]); continue; }
      let res: Awaited<ReturnType<WhatsAppProvider['send']>>;
      if (!v) res = { ok: false, retriable: false, code: 'INVALID_NUMBER', message: 'Not a valid mobile number.' };
      else if (opted) res = { ok: false, retriable: false, code: 'OPTED_OUT', message: 'This number has opted out.' };
      else res = await provider.send({ destination: v.digits, campaignName: r.aisensy_campaign_name, userName: r.full_name, templateParams: Array.isArray(r.params) ? r.params : [] });
      const attempts = r.attempts + 1;
      await tx(async (db) => {
        if (res.ok) {
          await exec(`UPDATE whatsapp_recipients SET status = 'sent', attempts = $2, provider_message_id = $3, sent_at = NOW(3), last_error = NULL, claim_token = NULL WHERE id = $1`, [r.id, attempts, res.providerId], db);
          await logMessage(db, { orgId: r.org_id, campaignId: r.campaign_id, recipientId: r.id, learnerId: r.learner_id, phone: r.phone, providerId: res.providerId, event: 'sent', status: 'sent' });
        } else if (res.retriable && attempts < MAX_ATTEMPTS) {
          await exec(`UPDATE whatsapp_recipients SET status = 'pending', attempts = $2, last_error = $3, next_attempt_at = DATE_ADD(NOW(3), INTERVAL $4 MINUTE), claim_token = NULL WHERE id = $1`, [r.id, attempts, res.message.slice(0, 500), BACKOFF_MIN[attempts - 1]], db);
          await logMessage(db, { orgId: r.org_id, campaignId: r.campaign_id, recipientId: r.id, learnerId: r.learner_id, phone: r.phone, event: 'attempt', status: 'retry', errorCode: res.code, errorMessage: res.message });
        } else {
          await exec(`UPDATE whatsapp_recipients SET status = 'failed', attempts = $2, last_error = $3, claim_token = NULL WHERE id = $1`, [r.id, attempts, `${res.code}: ${res.message}`.slice(0, 500)], db);
          await logMessage(db, { orgId: r.org_id, campaignId: r.campaign_id, recipientId: r.id, learnerId: r.learner_id, phone: r.phone, event: 'failed', status: 'failed', errorCode: res.code, errorMessage: res.message });
        }
      });
      if (res.ok) { stats.sent++; await replayUnmatched(res.providerId); }
      else if (res.retriable && attempts < MAX_ATTEMPTS) stats.retried++; else stats.failed++;
      const left = gap - (Date.now() - t0); if (left > 0 && provider === getProvider()) await sleep(left);
    }
  }
  await finalizeCampaigns();
  return stats;
}

// ------------------------------------------------------------------ webhooks
/** Apply one delivery event to the recipient it belongs to. Never moves a status backwards. */
async function applyStatus(db: Db, providerId: string, status: DeliveryStatus, error: string | null): Promise<'applied' | 'ignored' | 'unmatched'> {
  const r = await queryOne(`SELECT id, org_id, campaign_id, learner_id, phone, status FROM whatsapp_recipients WHERE provider_message_id = $1 FOR UPDATE`, [providerId], db);
  if (!r) return 'unmatched';
  await logMessage(db, { orgId: r.org_id, campaignId: r.campaign_id, recipientId: r.id, learnerId: r.learner_id, phone: r.phone, providerId, event: status, status, errorMessage: error });
  if (status === 'failed') {
    if ((RANK[r.status] ?? 0) >= RANK.delivered) return 'ignored';
    await exec(`UPDATE whatsapp_recipients SET status = 'failed', last_error = $2 WHERE id = $1`, [r.id, error ?? 'Delivery failed'], db);
    return 'applied';
  }
  if ((RANK[status] ?? 0) <= (RANK[r.status] ?? 0)) return 'ignored';          // late or repeated event
  await exec(`UPDATE whatsapp_recipients SET status = $2, last_error = NULL,
      sent_at = COALESCE(sent_at, NOW(3)), delivered_at = CASE WHEN $2 IN ('delivered','read') THEN COALESCE(delivered_at, NOW(3)) ELSE delivered_at END,
      read_at = CASE WHEN $2 = 'read' THEN COALESCE(read_at, NOW(3)) ELSE read_at END WHERE id = $1`, [r.id, status], db);
  return 'applied';
}

/** Store and apply a webhook delivery. The same event twice does nothing the second time. */
export async function processWebhook(body: unknown) {
  const events = parseWebhook(body);
  const out = { received: events.length, applied: 0, ignored: 0, unmatched: 0, duplicate: 0 };
  for (const ev of events.length ? events : [{ eventKey: null, providerId: null, status: null, error: null }]) {
    const raw = JSON.stringify(Array.isArray(body) || (body as any)?.events ? ev : body);
    const key = ev.eventKey ?? createHash('sha256').update(`${ev.providerId}|${ev.status}|${raw}`).digest('hex');
    await tx(async (db) => {
      try {
        await exec(`INSERT INTO webhook_events (provider, event_key, payload, provider_message_id, delivery_status, error_message) VALUES ('aisensy',$1,$2,$3,$4,$5)`, [key.slice(0, 190), JSON.stringify(body ?? null).slice(0, 60000), ev.providerId, ev.status, ev.error], db);
      } catch (e: any) { if (e?.errno === 1062) { out.duplicate++; return; } throw e; }
      let outcome: string;
      if (!ev.providerId || !ev.status) { outcome = 'ignored'; out.ignored++; }
      else { outcome = await applyStatus(db, ev.providerId, ev.status, ev.error); out[outcome as 'applied' | 'ignored' | 'unmatched']++; }
      await exec(`UPDATE webhook_events SET outcome = $1 WHERE provider = 'aisensy' AND event_key = $2`, [outcome, key.slice(0, 190)], db);
    });
  }
  await finalizeCampaigns();
  return out;
}

/** A webhook can arrive before we have recorded the provider's id; apply what was waiting once we have it. */
export async function replayUnmatched(providerId: string | null) {
  if (!providerId) return;
  const waiting = await query(`SELECT id, delivery_status, error_message FROM webhook_events WHERE provider = 'aisensy' AND outcome = 'unmatched' AND provider_message_id = $1 ORDER BY id`, [providerId]);
  for (const w of waiting) {
    try { await tx(async (db) => { const o = await applyStatus(db, providerId, w.delivery_status, w.error_message); await exec(`UPDATE webhook_events SET outcome = $1 WHERE id = $2`, [o, w.id], db); }); }
    catch (e) { logger.warn({ err: e }, 'replay of a waiting webhook failed'); }
  }
}
