import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

/**
 * Zoom, backend only (Server-to-Server OAuth app). The client secret is read from the environment, sent only to Zoom,
 * and never logged, returned or stored. The meeting host is ONE Zoom user for the organization (ZOOM_HOST_USER).
 */
export interface MeetingInput { topic: string; startsAt: Date; durationMin: number; timezone: string }
export type MeetingResult = { ok: true; id: string; joinUrl: string } | { ok: false; retriable: boolean; code: string; message: string };
export interface ZoomProvider {
  createMeeting(i: MeetingInput): Promise<MeetingResult>;
  deleteMeeting(id: string): Promise<void>;
  /** A fresh host link (they expire after a couple of hours, so it is fetched when the teacher presses Start, never stored). */
  startUrl(id: string): Promise<{ ok: true; url: string } | { ok: false; message: string }>;
}

export const isConfigured = () => !!(env.ZOOM_ACCOUNT_ID && env.ZOOM_CLIENT_ID && env.ZOOM_CLIENT_SECRET);
export const isWebhookConfigured = () => !!env.ZOOM_WEBHOOK_SECRET_TOKEN;
const redact = (s: string) => ([env.ZOOM_CLIENT_SECRET, env.ZOOM_CLIENT_ID, env.ZOOM_ACCOUNT_ID] as (string | undefined)[]).reduce<string>((t, k) => (k ? t.split(k).join('[redacted]') : t), s).slice(0, 300);

class RealZoom implements ZoomProvider {
  private token: { value: string; exp: number } | null = null;
  private async bearer(): Promise<string> {
    if (this.token && this.token.exp > Date.now() + 60_000) return this.token.value;
    const url = new URL('/oauth/token', env.ZOOM_OAUTH_URL); url.searchParams.set('grant_type', 'account_credentials'); url.searchParams.set('account_id', env.ZOOM_ACCOUNT_ID!);
    const res = await fetch(url, { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${env.ZOOM_CLIENT_ID}:${env.ZOOM_CLIENT_SECRET}`).toString('base64')}` }, signal: AbortSignal.timeout(15_000) });
    const j: any = await res.json().catch(() => null);
    if (!res.ok || !j?.access_token) throw new Error(redact(String(j?.reason ?? j?.message ?? `Zoom sign-in failed (HTTP ${res.status})`)));
    this.token = { value: String(j.access_token), exp: Date.now() + Number(j.expires_in ?? 3600) * 1000 };
    return this.token.value;
  }
  private async call(method: string, path: string, body?: unknown) {
    const token = await this.bearer();
    const res = await fetch(new URL(path, env.ZOOM_API_URL), { method, headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
    const text = await res.text().catch(() => ''); let j: any = null; try { j = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { res, j };
  }
  async createMeeting(i: MeetingInput): Promise<MeetingResult> {
    if (!isConfigured()) return { ok: false, retriable: false, code: 'NOT_CONFIGURED', message: 'Zoom is not configured.' };
    try {
      const { res, j } = await this.call('POST', `/v2/users/${encodeURIComponent(env.ZOOM_HOST_USER)}/meetings`, {
        topic: i.topic.slice(0, 200), type: 2, start_time: i.startsAt.toISOString().replace(/\.\d{3}Z$/, 'Z'), duration: i.durationMin, timezone: i.timezone,
        settings: { join_before_host: false, waiting_room: true, mute_upon_entry: true, approval_type: 2, auto_recording: 'none', participant_video: false },
      });
      if (res.ok && j?.id && j?.join_url) return { ok: true, id: String(j.id), joinUrl: String(j.join_url) };
      logger.warn({ status: res.status }, 'Zoom rejected a meeting');
      return { ok: false, retriable: res.status === 429 || res.status >= 500, code: `HTTP_${res.status}`, message: redact(String(j?.message ?? `HTTP ${res.status}`)) };
    } catch (e: any) { return { ok: false, retriable: true, code: e?.name === 'TimeoutError' ? 'TIMEOUT' : 'NETWORK', message: redact(String(e?.message ?? 'Network error')) }; }
  }
  async deleteMeeting(id: string) { try { await this.call('DELETE', `/v2/meetings/${encodeURIComponent(id)}`); } catch (e) { logger.warn({ err: e }, 'could not delete a Zoom meeting'); } }
  async startUrl(id: string) {
    try { const { res, j } = await this.call('GET', `/v2/meetings/${encodeURIComponent(id)}`); return res.ok && j?.start_url ? { ok: true as const, url: String(j.start_url) } : { ok: false as const, message: redact(String(j?.message ?? `HTTP ${res.status}`)) }; }
    catch (e: any) { return { ok: false as const, message: redact(String(e?.message ?? 'Network error')) }; }
  }
}

let provider: ZoomProvider = new RealZoom();
export const getZoom = () => provider;
/** Tests inject a fake; production never calls this. */
export function setZoomProvider(p: ZoomProvider | null) { provider = p ?? new RealZoom(); }

// ------------------------------------------------------------------ webhook verification
const tokenKey = () => env.ZOOM_WEBHOOK_SECRET_TOKEN;
/** The answer Zoom expects to its one-time `endpoint.url_validation` challenge. */
export function validationAnswer(plainToken: string) {
  return { plainToken, encryptedToken: crypto.createHmac('sha256', tokenKey() ?? '').update(plainToken).digest('hex') };
}
/** `v0=` + HMAC-SHA256 of `v0:<timestamp>:<raw body>`; also rejects anything older than 5 minutes (replay). */
export function verifyWebhook(raw: Buffer | undefined, signature: string | undefined, timestamp: string | undefined, now = Date.now()): boolean {
  const secret = tokenKey();
  if (!raw || !signature || !timestamp || !secret) return false;
  const ts = Number(timestamp); if (!Number.isFinite(ts) || Math.abs(now - ts * 1000) > 5 * 60_000) return false;
  const want = `v0=${crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${raw.toString('utf8')}`).digest('hex')}`;
  return signature.length === want.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(want));
}
