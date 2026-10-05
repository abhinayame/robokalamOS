import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { normalizeMobile } from '../../lib/phone.js';

/**
 * AiSensy WhatsApp, backend only. The API key is read from the environment, sent only to AiSensy,
 * and never logged, returned, or stored.
 */
export interface SendInput { destination: string; campaignName: string; userName: string; templateParams: string[] }
export type SendResult =
  | { ok: true; providerId: string | null }
  | { ok: false; retriable: boolean; code: string; message: string };

export interface WhatsAppProvider { send(m: SendInput): Promise<SendResult> }

export const isMeta = () => env.WHATSAPP_PROVIDER === 'meta';
export const isConfigured = () => (isMeta() ? !!(env.META_WA_TOKEN && env.META_PHONE_NUMBER_ID) : !!env.AISENSY_API_KEY);
export const isWebhookConfigured = () => (isMeta() ? !!(env.META_APP_SECRET && env.META_VERIFY_TOKEN) : !!env.AISENSY_WEBHOOK_SECRET);
export const senderNumberSet = () => (isMeta() ? !!env.META_PHONE_NUMBER_ID : !!env.AISENSY_WA_NUMBER);

/** AiSensy wants the number as digits with the country code (no +). Returns null when it is not a valid mobile. */
export function validateRecipient(phone: string | null | undefined): { e164: string; digits: string } | null {
  const e164 = normalizeMobile(phone);
  return e164 ? { e164, digits: e164.slice(1) } : null;
}

const redact = (s: string) => ([env.AISENSY_API_KEY, env.META_WA_TOKEN, env.META_APP_SECRET] as (string | undefined)[]).reduce<string>((t, k) => (k ? t.split(k).join('[redacted]') : t), s).slice(0, 300);

class AiSensyProvider implements WhatsAppProvider {
  async send(m: SendInput): Promise<SendResult> {
    if (!env.AISENSY_API_KEY) return { ok: false, retriable: false, code: 'NOT_CONFIGURED', message: 'WhatsApp is not configured.' };
    const body = { apiKey: env.AISENSY_API_KEY, campaignName: m.campaignName, destination: m.destination, userName: m.userName.slice(0, 100) || 'Learner', source: 'robokalam-learner-os', templateParams: m.templateParams };
    let res: Response;
    try {
      res = await fetch(new URL(env.AISENSY_CAMPAIGN_PATH, env.AISENSY_BASE_URL), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (e: any) {
      return { ok: false, retriable: true, code: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: redact(String(e?.message ?? 'Network error')) };
    }
    const text = await res.text().catch(() => '');
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && !(j && (j.success === false || j.success === 'false'))) {
      return { ok: true, providerId: String(j?.submitted_message_id ?? j?.messageId ?? j?.id ?? '') || null };
    }
    const message = redact(String(j?.message ?? j?.error ?? text ?? `HTTP ${res.status}`));
    // Rate limits and provider outages are worth retrying; a rejected number, template or key is not.
    const retriable = res.status === 429 || res.status >= 500;
    logger.warn({ status: res.status, retriable }, 'AiSensy rejected a message');
    return { ok: false, retriable, code: `HTTP_${res.status}`, message };
  }
}

/**
 * WhatsApp Cloud API (Meta) directly: no platform fee, free webhooks. The template name is the one approved in WhatsApp Manager
 * (stored in the same field as an AiSensy campaign name). The access token is read from the environment, sent only to Meta, never logged.
 */
const metaText = (v: string) => (v.replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, 1000) || '-');
export class MetaProvider implements WhatsAppProvider {
  async send(m: SendInput): Promise<SendResult> {
    if (!(env.META_WA_TOKEN && env.META_PHONE_NUMBER_ID)) return { ok: false, retriable: false, code: 'NOT_CONFIGURED', message: 'WhatsApp is not configured.' };
    const template: any = { name: m.campaignName, language: { code: env.META_TEMPLATE_LANGUAGE } };
    if (m.templateParams.length) template.components = [{ type: 'body', parameters: m.templateParams.map((t) => ({ type: 'text', text: metaText(t) })) }];
    let res: Response;
    try {
      res = await fetch(`${env.META_API_BASE}/${env.META_API_VERSION}/${env.META_PHONE_NUMBER_ID}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.META_WA_TOKEN}` }, body: JSON.stringify({ messaging_product: 'whatsapp', to: m.destination, type: 'template', template }), signal: AbortSignal.timeout(15_000) });
    } catch (e: any) { return { ok: false, retriable: true, code: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: redact(String(e?.message ?? 'Network error')) }; }
    const text = await res.text().catch(() => '');
    let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    const id = j?.messages?.[0]?.id;
    if (res.ok && id) return { ok: true, providerId: String(id) };
    const code = j?.error?.code;
    const message = redact(String(j?.error?.error_data?.details ?? j?.error?.message ?? text ?? `HTTP ${res.status}`));
    // 4 / 80007 / 130429 / 131048 / 131056 = rate limits; 131016 = temporary service problem. Everything else (bad number, template, token) is permanent.
    const retriable = res.status === 429 || res.status >= 500 || [4, 80007, 130429, 131016, 131048, 131056].includes(Number(code));
    logger.warn({ status: res.status, code, retriable }, 'WhatsApp Cloud API rejected a message');
    return { ok: false, retriable, code: code ? `META_${code}` : `HTTP_${res.status}`, message };
  }
}

const builtIn = (): WhatsAppProvider => (isMeta() ? new MetaProvider() : new AiSensyProvider());
let provider: WhatsAppProvider = builtIn();
export const getProvider = () => provider;
/** Tests inject a fake; production never calls this. */
export function setProvider(p: WhatsAppProvider | null) { provider = p ?? builtIn(); }

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendTemplateMessage(m: SendInput, p: WhatsAppProvider = provider) { return p.send(m); }

/** Many messages, never in one request: one HTTP call each, paced to the configured rate. */
export async function sendBulkTemplateMessages(items: (SendInput & { key: string })[], opts: { perSecond?: number; p?: WhatsAppProvider } = {}) {
  const gap = 1000 / (opts.perSecond ?? env.WHATSAPP_RATE_PER_SECOND);
  const out: { key: string; result: SendResult }[] = [];
  for (const it of items) { const t = Date.now(); out.push({ key: it.key, result: await sendTemplateMessage(it, opts.p) }); const left = gap - (Date.now() - t); if (left > 0) await sleep(left); }
  return out;
}

// ------------------------------------------------------------------ webhook parsing
export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';
export interface ParsedEvent { eventKey: string | null; providerId: string | null; status: DeliveryStatus | null; error: string | null }

const pick = (o: any, paths: string[]): unknown => { for (const p of paths) { let v = o; for (const k of p.split('.')) v = v?.[k]; if (v !== undefined && v !== null && v !== '') return v; } return undefined; };
const mapStatus = (raw: unknown): DeliveryStatus | null => {
  const s = String(raw ?? '').toLowerCase();
  if (!s) return null;
  if (/(fail|undeliver|reject|error)/.test(s)) return 'failed';
  if (/read|seen/.test(s)) return 'read';
  if (/deliver/.test(s)) return 'delivered';
  if (/sent|submitted|accepted/.test(s)) return 'sent';
  return null;
};

/**
 * Reads a delivery-status event. The field names AiSensy uses can differ by account/version, so several
 * common spellings are accepted; anything unrecognised is stored as ignored (never guessed).
 */
export function parseWebhook(body: any): ParsedEvent[] {
  const items: any[] = Array.isArray(body) ? body : Array.isArray(body?.events) ? body.events : [body];
  return items.filter((x) => x && typeof x === 'object').map((x) => {
    const providerId = pick(x, ['data.message.id', 'data.messageId', 'data.id', 'message.id', 'messageId', 'message_id', 'submitted_message_id', 'whatsappMessageId', 'id']);
    const status = mapStatus(pick(x, ['data.message.status', 'data.status', 'data.delivery_status', 'message.status', 'status', 'delivery_status', 'deliveryStatus', 'topic']));
    const error = pick(x, ['data.message.error', 'data.error.message', 'data.error', 'error.message', 'error', 'reason', 'failure_reason']);
    const eventKey = pick(x, ['event_id', 'eventId', 'webhook_id']);
    return { eventKey: eventKey ? String(eventKey) : null, providerId: providerId ? String(providerId) : null, status, error: error ? redact(typeof error === 'string' ? error : JSON.stringify(error)).slice(0, 500) : null };
  });
}

/** Meta's delivery callbacks: entry[].changes[].value.statuses[]. Incoming customer messages are ignored. */
export function parseMetaWebhook(body: any): ParsedEvent[] {
  const out: ParsedEvent[] = [];
  for (const e of Array.isArray(body?.entry) ? body.entry : []) for (const c of Array.isArray(e?.changes) ? e.changes : []) for (const st of Array.isArray(c?.value?.statuses) ? c.value.statuses : []) {
    const status = mapStatus(st?.status); const id = st?.id ? String(st.id) : null;
    const err = st?.errors?.[0]; const error = err ? redact(`${err.code ?? ''} ${err.title ?? ''} ${err.error_data?.details ?? err.message ?? ''}`.trim()).slice(0, 500) : null;
    out.push({ eventKey: id && status ? `meta:${id}:${status}` : null, providerId: id, status, error });
  }
  return out;
}
