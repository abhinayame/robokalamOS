import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { env } from '../config/env.js';

/**
 * Extra limits for the few endpoints that are expensive or abusable. Signed-in users are limited per user
 * (so one busy office behind one IP is not throttled together); everyone else per IP.
 */
export function limit(name: string, perMinute: number) {
  return rateLimit({
    windowMs: 60_000, limit: perMinute, standardHeaders: true, legacyHeaders: false,
    keyGenerator: (req: Request) => (req.user?.id ? `u:${req.user.id}` : ipKeyGenerator(req.ip ?? 'unknown')),
    skip: () => env.NODE_ENV === 'test' && process.env.TEST_LIMITS !== '1',
    message: { ok: false, error: { code: 'RATE_LIMITED', message: `Too many ${name} requests. Please wait a minute and try again.` } },
  });
}
