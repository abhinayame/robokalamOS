import crypto from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { processWebhook } from './delivery.js';

/**
 * Delivery-status webhooks from AiSensy. Public by necessity, so it only accepts a request whose URL carries the
 * shared secret (compared in constant time). Any other path or secret looks like a 404; the secret is never logged.
 */
const router = Router();
router.post('/aisensy/:secret', async (req, res) => {
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
export default router;
