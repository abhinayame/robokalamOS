import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { record } from '../lib/metrics.js';

declare module 'express-serve-static-core' { interface Request { id?: string } }

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;
let warnedProxy = false;

/** A short label that never contains ids or query strings, so logs and metrics group by endpoint. */
const label = (req: Request) => {
  const base = `${req.baseUrl ?? ''}${req.route?.path && req.route.path !== '/' ? req.route.path : ''}`;
  return `${req.method} ${base || req.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id')}`;
};

/**
 * Request id, access log and metrics. Bodies, query strings, cookies and tokens are never logged.
 * Every response carries X-Request-Id so a user can quote it and an admin can find the exact log line.
 */
export function observe(req: Request, res: Response, next: NextFunction) {
  const inbound = req.get('x-request-id');
  req.id = inbound && SAFE_ID.test(inbound) ? inbound : crypto.randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // API answers are personal data: never let a browser or proxy keep a copy.
  if (req.path.startsWith('/api')) res.setHeader('Cache-Control', 'no-store');
  if (!warnedProxy && env.NODE_ENV === 'production' && env.TRUST_PROXY !== 'true' && req.get('x-forwarded-for')) {
    warnedProxy = true;
    logger.warn('Requests arrive through a proxy but TRUST_PROXY is not "true": every visitor shares one IP, so the rate limits (and the audit log IP) are wrong. Set TRUST_PROXY=true.');
  }
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const route = label(req);
    if (req.path === '/api/health') return;
    record(route, res.statusCode, ms);
    if (req.path.startsWith('/assets/')) return;
    const level = res.statusCode >= 500 ? 'error' : ms > 2000 ? 'warn' : 'info';
    logger[level]({ id: req.id, route, status: res.statusCode, ms: Math.round(ms), user: req.user?.id, org: (req as any).orgId, ip: req.ip, bytes: Number(res.getHeader('content-length')) || undefined }, ms > 2000 && res.statusCode < 500 ? 'slow request' : 'request');
  });
  next();
}
