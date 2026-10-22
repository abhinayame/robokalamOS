import { Router } from 'express';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { exec, newId, queryOne } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { ok, parse, wrap } from '../../lib/http.js';
import { limit } from '../../middleware/limits.js';
import { orgIdOf, requireOrg } from '../../middleware/auth.js';
import { allowedEndpoint, hashEndpoint, isConfigured } from './service.js';

/** Each person manages only their own devices. */
const router = Router(); // mounted at /api/push
router.use(requireOrg);

router.get('/config', wrap(async (req, res) => {
  const n = Number((await queryOne(`SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = $1`, [req.user!.id]))!.n);
  ok(res, { enabled: isConfigured(), public_key: isConfigured() ? env.VAPID_PUBLIC_KEY : null, devices: n });
}));
router.post('/subscribe', limit('push', 20), wrap(async (req, res) => {
  if (!isConfigured()) throw badRequest('Notifications are not switched on for this school yet.');
  const b = parse(z.object({ endpoint: z.string().max(1000), keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }) }), req.body);
  if (!allowedEndpoint(b.endpoint)) throw badRequest('That notification service is not supported.');
  await exec(`INSERT INTO push_subscriptions (id, org_id, user_id, endpoint_hash, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), org_id = VALUES(org_id), p256dh = VALUES(p256dh), auth = VALUES(auth), failures = 0`,
    [newId(), orgIdOf(req), req.user!.id, hashEndpoint(b.endpoint), b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200) || null]);
  ok(res, { subscribed: true }, undefined, 201);
}));
router.post('/unsubscribe', wrap(async (req, res) => {
  const b = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
  await exec(`DELETE FROM push_subscriptions WHERE endpoint_hash = $1 AND user_id = $2`, [hashEndpoint(b.endpoint), req.user!.id]);
  ok(res, { subscribed: false });
}));
export default router;
