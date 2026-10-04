import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const PG_MESSAGES: Record<string, string> = {
  uq_learners_org_mobile: 'A learner with this mobile number already exists.',
  uq_learners_org_email: 'A learner with this email already exists.',
  uq_users_email: 'A user with this email already exists.',
  uq_parents_org_mobile: 'A parent with this mobile number already exists.',
  uq_learner_batch: 'This learner is already in that batch.',
  uq_tbm_one_lead: 'This batch already has a lead teacher.',
};

export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ ok: false, error: { code: 'NOT_FOUND', message: 'That endpoint does not exist.' } });
}

export function errorHandler(err: any, req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ ok: false, error: { code: err.code, message: err.message, details: err.details } });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_JSON', message: 'The request body is not valid JSON.' } });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, error: { code: 'TOO_LARGE', message: 'The request is too large.' } });
  }
  if (err?.code === '23505') {
    const message = PG_MESSAGES[err.constraint] ?? 'That record already exists.';
    return res.status(409).json({ ok: false, error: { code: 'DUPLICATE', message } });
  }
  if (err?.code === '23503' || err?.code === '23514') {
    return res.status(409).json({ ok: false, error: { code: 'CONSTRAINT', message: 'That change conflicts with related data.' } });
  }
  if (err?.code === '22P02') {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'One of the values has an invalid format.' } });
  }
  logger.error({ err, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.' } });
}
