import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Razorpay Payment Links, backend only. A payment link is a hosted page: the learner pays on Razorpay's site, so no card data or
 * API key ever touches our pages. The key secret is read from the environment, sent only to Razorpay, and never logged or returned.
 */
export interface LinkInput { amountPaise: number; referenceId: string; description: string; expiresAt: Date; customer: { name: string; contact?: string | null; email?: string | null }; callbackUrl?: string | null }
export type LinkResult = { ok: true; id: string; shortUrl: string } | { ok: false; retriable: boolean; code: string; message: string };
export interface PaymentProvider { createLink(i: LinkInput): Promise<LinkResult>; cancelLink(id: string): Promise<void> }

export const isConfigured = () => !!(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
export const isWebhookConfigured = () => !!env.RAZORPAY_WEBHOOK_SECRET;

const redact = (s: string) => ([env.RAZORPAY_KEY_SECRET, env.RAZORPAY_KEY_ID] as (string | undefined)[]).reduce<string>((t, k) => (k ? t.split(k).join('[redacted]') : t), s).slice(0, 300);
const auth = () => `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

class RazorpayProvider implements PaymentProvider {
  async createLink(i: LinkInput): Promise<LinkResult> {
    if (!isConfigured()) return { ok: false, retriable: false, code: 'NOT_CONFIGURED', message: 'Online payments are not configured.' };
    const body: Record<string, unknown> = {
      amount: i.amountPaise, currency: 'INR', accept_partial: false, reference_id: i.referenceId.slice(0, 40), description: i.description.slice(0, 2000),
      expire_by: Math.floor(i.expiresAt.getTime() / 1000), customer: Object.fromEntries(Object.entries({ name: i.customer.name.slice(0, 100), contact: i.customer.contact ?? undefined, email: i.customer.email ?? undefined }).filter(([, v]) => v)),
      notify: { sms: false, email: false }, reminder_enable: false,
    };
    if (i.callbackUrl) { body.callback_url = i.callbackUrl; body.callback_method = 'get'; }
    let res: Response;
    try {
      res = await fetch(new URL('/v1/payment_links', env.RAZORPAY_BASE_URL), { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: auth() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
    } catch (e: any) { return { ok: false, retriable: true, code: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: redact(String(e?.message ?? 'Network error')) }; }
    const text = await res.text().catch(() => ''); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (res.ok && j?.id && j?.short_url) return { ok: true, id: String(j.id), shortUrl: String(j.short_url) };
    logger.warn({ status: res.status }, 'Razorpay rejected a payment link');
    return { ok: false, retriable: res.status === 429 || res.status >= 500, code: `HTTP_${res.status}`, message: redact(String(j?.error?.description ?? j?.message ?? text ?? `HTTP ${res.status}`)) };
  }
  async cancelLink(id: string) {
    if (!isConfigured()) return;
    try { await fetch(new URL(`/v1/payment_links/${encodeURIComponent(id)}/cancel`, env.RAZORPAY_BASE_URL), { method: 'POST', headers: { Authorization: auth() }, signal: AbortSignal.timeout(15_000) }); }
    catch (e) { logger.warn({ err: e }, 'could not cancel a Razorpay payment link'); }
  }
}

let provider: PaymentProvider = new RazorpayProvider();
export const getPaymentProvider = () => provider;
/** Tests inject a fake; production never calls this. */
export function setPaymentProvider(p: PaymentProvider | null) { provider = p ?? new RazorpayProvider(); }

/** Constant-time check of X-Razorpay-Signature (hex HMAC-SHA256 of the raw request body). */
export function verifySignature(raw: Buffer | undefined, header: string | undefined, secret = env.RAZORPAY_WEBHOOK_SECRET): boolean {
  if (!raw || !header || !secret) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.trim().toLowerCase();
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
