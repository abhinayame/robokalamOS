import crypto from 'node:crypto';
import webpush from 'web-push';
import { env } from '../../config/env.js';
import { exec, query } from '../../db/pool.js';
import { logger } from '../../lib/logger.js';

/**
 * Web push to the installed app. A notification row is the single source of truth: a worker pushes each new one ONCE (at most once, never a backlog
 * after downtime), to every device its user has allowed. Only the big browser push services are accepted as endpoints, so a user cannot make
 * the server call an arbitrary address. Dead subscriptions (404/410) are removed; flaky ones are dropped after repeated failures.
 */
export const isConfigured = () => !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
const HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
export function allowedEndpoint(raw: string): boolean {
  try { const u = new URL(raw); return u.protocol === 'https:' && !u.port && HOSTS.some((h) => h.test(u.hostname)); } catch { return false; }
}
export const hashEndpoint = (e: string) => crypto.createHash('sha256').update(e).digest('hex');

export interface PushPayload { title: string; body?: string | null; url?: string | null }
export type SendFn = (sub: { endpoint: string; keys: { p256dh: string; auth: string } }, payload: string) => Promise<{ ok: true } | { ok: false; gone: boolean; message: string }>;
const real: SendFn = async (sub, payload) => {
  try { webpush.setVapidDetails(env.VAPID_SUBJECT!, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!); await webpush.sendNotification(sub, payload, { TTL: 3600, timeout: 10_000 }); return { ok: true }; }
  catch (e: any) { return { ok: false, gone: e?.statusCode === 404 || e?.statusCode === 410, message: String(e?.statusCode ?? e?.code ?? 'error') }; }
};
let sender: SendFn = real;
export function setPushSender(fn: SendFn | null) { sender = fn ?? real; }

export async function pushToUser(userId: string, p: PushPayload) {
  const subs = await query(`SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1 LIMIT 10`, [userId]);
  const body = JSON.stringify({ title: p.title.slice(0, 120), body: (p.body ?? '').slice(0, 160), url: p.url && p.url.startsWith('/') ? p.url : '/' });
  let sent = 0;
  for (const s of subs) {
    const r = await sender({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body);
    if (r.ok) { sent++; await exec(`UPDATE push_subscriptions SET failures = 0, last_ok_at = NOW(3) WHERE id = $1`, [s.id]); }
    else if (r.gone) await exec(`DELETE FROM push_subscriptions WHERE id = $1`, [s.id]);
    else { await exec(`UPDATE push_subscriptions SET failures = failures + 1 WHERE id = $1`, [s.id]); await exec(`DELETE FROM push_subscriptions WHERE id = $1 AND failures >= 5`, [s.id]); logger.warn({ code: r.message }, 'web push failed'); }
  }
  return sent;
}

/** One worker pass. Without keys nothing is ever pushed, and waiting notifications are marked skipped so enabling push later does not flood anyone. */
export async function runPushOnce() {
  const rows = await query(`SELECT id, user_id, title, body, link FROM notifications WHERE push_state = 'pending' AND created_at < DATE_SUB(NOW(3), INTERVAL 1 SECOND) ORDER BY created_at LIMIT 100`);
  if (!rows.length) return { claimed: 0, pushed: 0 };
  const ids = rows.map((r) => r.id as string);
  await exec(`UPDATE notifications SET push_state = '${isConfigured() ? 'sent' : 'skipped'}' WHERE push_state = 'pending' AND id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`, ids);
  if (!isConfigured()) return { claimed: rows.length, pushed: 0 };
  let pushed = 0; for (const r of rows) pushed += await pushToUser(r.user_id, { title: r.title, body: r.body, url: r.link });
  return { claimed: rows.length, pushed };
}
let timer: NodeJS.Timeout | null = null; let busy = false;
export function startPushWorker() {
  if (env.PUSH_WORKER !== 'true' || timer) return;
  timer = setInterval(async () => { if (busy) return; busy = true; try { const s = await runPushOnce(); if (s.claimed) logger.info(s, 'push worker pass'); } catch (e) { logger.error({ err: e }, 'push worker pass failed'); } finally { busy = false; } }, 5000);
  timer.unref();
}
export function stopPushWorker() { if (timer) clearInterval(timer); timer = null; }
