import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';

export const CSRF_COOKIE = 'rk_csrf';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Double-submit CSRF protection for cookie-authenticated browsers.
 * Bearer-token clients (Postman, integrations) are not CSRF-able and skip it.
 */
export function csrfProtection(req: Request, _res: Response, next: NextFunction) {
  if (SAFE.has(req.method)) return next();
  if (req.get('authorization')?.startsWith('Bearer ')) return next();
  if (req.path === '/api/auth/login') return next();
  const usesCookies = req.cookies?.rk_at || req.cookies?.rk_rt;
  if (!usesCookies) return next();
  const cookie = req.cookies?.[CSRF_COOKIE];
  const header = req.get('x-csrf-token');
  const valid =
    cookie && header && cookie.length === header.length &&
    crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
  if (!valid) return next(new AppError(403, 'CSRF_FAILED', 'Your session could not be verified. Please refresh the page and try again.'));
  next();
}
