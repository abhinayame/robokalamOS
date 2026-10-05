import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { limit } from '../../middleware/limits.js';
import { logger } from '../../lib/logger.js';
import { processWebhook } from './delivery.js';
import { parseMetaInbound, processInbound } from './inbound.js';

/**
 * Delivery-status webhooks from AiSensy. Public by necessity, so it only accepts a request whose URL carries the
 * shared secret (compared in constant time). Any other path or secret looks like a 404; the secret is never logged.
 */
const router = Router();
router.post('/aisensy/:secret', limit('webhook', 600), async (req, res) => {
  const want = env.AISENSY_WEBHOOK_SECRET;
  const got = String(req.params.secret ?? '');
  const ok = !!want && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
  if (!ok) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  try {
    const r = await processWebhook(req.body);
    res.json({ ok: true, data: r });
  } catch (e) {
    logger.error({ err: e }, 'webhook processing failed');
    res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Could not process the event.' } });   // AiSensy can retry
  }
});

/**
 * WhatsApp Cloud API (Meta). GET answers Meta's one-time subscription check (our verify token echoed back); POST is accepted only with a valid
 * X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret), compared in constant time.
 */
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
router.get('/meta', limit('webhook', 60), (req, res) => {
  const want = env.META_VERIFY_TOKEN;
  if (want && req.query['hub.mode'] === 'subscribe' && same(String(req.query['hub.verify_token'] ?? ''), want)) return void res.status(200).type('text/plain').send(String(req.query['hub.challenge'] ?? ''));
  res.status(403).json({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed.' } });
});
router.post('/meta', limit('webhook', 600), async (req, res) => {
  const secret = env.META_APP_SECRET; const raw: Buffer | undefined = (req as any).rawBody;
  const sig = String(req.get('x-hub-signature-256') ?? '');
  const want = secret && raw ? `sha256=${crypto.createHmac('sha256', secret).update(raw).digest('hex')}` : null;
  if (!want || !same(sig, want)) return res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'Not found.' } });
  try { const inbound = parseMetaInbound(req.body); res.json({ ok: true, data: { ...(await processWebhook(req.body, 'meta')), inbound: inbound.length ? await processInbound(inbound) : null } }); }
  catch (e) { logger.error({ err: e }, 'meta webhook processing failed'); res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Could not process the event.' } }); }
});
export default router;
