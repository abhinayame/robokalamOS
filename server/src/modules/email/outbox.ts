import crypto from 'node:crypto';
import { env } from '../../config/env.js';
import { exec, newId, query, queryOne, type Db } from '../../db/pool.js';
import { appUrl } from '../../lib/appurl.js';
import { logger } from '../../lib/logger.js';
import { getEmailProvider, isConfigured, type EmailProvider } from './provider.js';
import { renderEmail } from './template.js';

const BACKOFF_MIN = [1, 5, 30];
export const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;
const EMAIL = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]{2,}$/;
export const validEmail = (e: unknown): e is string => typeof e === 'string' && e.length <= 200 && EMAIL.test(e.trim());
const oneLine = (s: string) => s.replace(/[\r\n]+/g, ' ').trim();

/** Unsubscribe links are signed, so only a link we sent can opt an address out. */
const sig = (email: string, orgId: string | null) => crypto.createHmac('sha256', env.JWT_SECRET).update(`unsub|${orgId ?? ''}|${email}`).digest('base64url').slice(0, 32);
export const unsubscribeToken = (email: string, orgId: string | null) => `${Buffer.from(JSON.stringify([email, orgId])).toString('base64url')}.${sig(email, orgId)}`;
export function parseUnsubscribe(token: string): { email: string; orgId: string | null } | null {
  const [b, s] = token.split('.'); if (!b || !s) return null;
  try { const [email, orgId] = JSON.parse(Buffer.from(b, 'base64url').toString()); if (!validEmail(email)) return null; const want = sig(email, orgId ?? null); return s.length === want.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(want)) ? { email, orgId: orgId ?? null } : null; } catch { return null; }
}

export interface Queued { orgId?: string | null; to: string; toName?: string | null; subject: string; text: string; html?: string | null; category?: 'transactional' | 'notification'; learnerId?: string | null; dedupeKey?: string | null; delayMin?: number }

/** Put a message in the outbox (the worker sends it). Returns its id, or null when it was a repeat or the address opted out. */
export async function queueEmail(m: Queued, db?: Db): Promise<string | null> {
  const to = m.to.trim().toLowerCase();
  if (!validEmail(to)) return null;
  const category = m.category ?? 'notification';
  if (category === 'notification' && (await queryOne(`SELECT 1 FROM email_optouts WHERE email = $1 AND (org_id <=> $2 OR org_id IS NULL)`, [to, m.orgId ?? null], db))) return null;
  const id = newId();
  try {
    await exec(`INSERT INTO email_outbox (id, org_id, to_email, to_name, subject, body_text, body_html, category, learner_id, dedupe_key, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, DATE_ADD(NOW(3), INTERVAL $11 MINUTE))`,
      [id, m.orgId ?? null, to, m.toName ? oneLine(m.toName).slice(0, 160) : null, oneLine(m.subject).slice(0, 300), m.text.slice(0, 60_000), m.html?.slice(0, 500_000) ?? null, category, m.learnerId ?? null, m.dedupeKey?.slice(0, 190) ?? null, m.delayMin ?? 0], db);
  } catch (e: any) { if (e?.errno === 1062) return null; throw e; }
  return id;
}

/** A branded message built from parts (with an unsubscribe footer for notifications) and queued. */
export async function queueMessage(a: { orgId: string | null; orgName: string; color?: string; to: string; toName?: string | null; subject: string; title?: string; paragraphs: string[]; button?: { label: string; url: string } | null; category?: 'transactional' | 'notification'; learnerId?: string | null; dedupeKey?: string | null }, db?: Db) {
  const category = a.category ?? 'notification';
  const unsub = category === 'notification' ? `${appUrl()}/api/public/unsubscribe/${unsubscribeToken(a.to.trim().toLowerCase(), a.orgId)}` : null;
  const { html, text } = renderEmail({ orgName: a.orgName, color: a.color, title: a.title ?? a.subject, paragraphs: a.paragraphs, button: a.button, footer: unsub ? `You get this because your school uses ${a.orgName}. To stop these e-mails: ${unsub}` : null });
  return queueEmail({ orgId: a.orgId, to: a.to, toName: a.toName, subject: a.subject, text, html, category, learnerId: a.learnerId, dedupeKey: a.dedupeKey }, db);
}

/** One pass of the sender: claim a few waiting messages, send them, retry with back-off, give up after a few tries. Safe on several servers. */
export async function runEmailWorkerOnce(opts: { provider?: EmailProvider; limit?: number } = {}) {
  const provider = opts.provider ?? getEmailProvider();
  await exec(`UPDATE email_outbox SET status = 'pending', claim_token = NULL WHERE status = 'sending' AND claimed_at < DATE_SUB(NOW(3), INTERVAL 5 MINUTE)`);
  const token = newId();
  const claimed = await exec(`UPDATE email_outbox SET status = 'sending', claimed_at = NOW(3), claim_token = $1 WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= NOW(3)) ORDER BY created_at LIMIT ${Math.max(1, Math.min(opts.limit ?? 25, 200))}`, [token]);
  const stats = { claimed: claimed.affectedRows, sent: 0, retried: 0, failed: 0, skipped: 0 };
  if (!stats.claimed) return stats;
  for (const r of await query(`SELECT id, org_id, to_email, to_name, subject, body_text, body_html, category, attempts FROM email_outbox WHERE claim_token = $1 ORDER BY created_at`, [token])) {
    if (r.category === 'notification' && (await queryOne(`SELECT 1 FROM email_optouts WHERE email = $1 AND (org_id <=> $2 OR org_id IS NULL)`, [r.to_email, r.org_id]))) {
      await exec(`UPDATE email_outbox SET status = 'skipped', last_error = 'Recipient opted out', claim_token = NULL WHERE id = $1`, [r.id]); stats.skipped++; continue;
    }
    const res = await provider.send({ to: r.to_email, toName: r.to_name, subject: r.subject, text: r.body_text, html: r.body_html, headers: r.category === 'notification' ? { 'Auto-Submitted': 'auto-generated' } : undefined });
    const attempts = r.attempts + 1;
    if (res.ok) { await exec(`UPDATE email_outbox SET status = 'sent', attempts = $2, sent_at = NOW(3), last_error = NULL, claim_token = NULL WHERE id = $1`, [r.id, attempts]); stats.sent++; }
    else if (res.retriable && attempts < MAX_ATTEMPTS) { await exec(`UPDATE email_outbox SET status = 'pending', attempts = $2, last_error = $3, next_attempt_at = DATE_ADD(NOW(3), INTERVAL $4 MINUTE), claim_token = NULL WHERE id = $1`, [r.id, attempts, `${res.code}: ${res.message}`.slice(0, 500), BACKOFF_MIN[attempts - 1]]); stats.retried++; }
    else { await exec(`UPDATE email_outbox SET status = 'failed', attempts = $2, last_error = $3, claim_token = NULL WHERE id = $1`, [r.id, attempts, `${res.code}: ${res.message}`.slice(0, 500)]); stats.failed++; }
  }
  return stats;
}

let timer: NodeJS.Timeout | null = null; let busy = false;
export function startEmailWorker() {
  if (env.EMAIL_WORKER !== 'true' || timer) return;
  timer = setInterval(async () => {
    if (busy || !isConfigured()) return; busy = true;
    try { const s = await runEmailWorkerOnce(); if (s.claimed) logger.info(s, 'email worker pass'); } catch (e) { logger.error({ err: e }, 'email worker pass failed'); } finally { busy = false; }
  }, 5000);
  timer.unref();
}
export function stopEmailWorker() { if (timer) clearInterval(timer); timer = null; }
