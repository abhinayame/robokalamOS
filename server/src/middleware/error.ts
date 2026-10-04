import type { NextFunction, Request, Response } from 'express';
import { AppError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const KEY_MESSAGES: Record<string, string> = {
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
  if (err?.errno === 1153) {   // ER_NET_PACKET_TOO_LARGE: file bigger than the database accepts
    return res.status(413).json({ ok: false, error: { code: 'TOO_LARGE', message: 'That file is too large. Please upload a smaller file.' } });
  }
  if (err?.errno === 1062) {
    const key = /for key '(?:[^']*\.)?([^']+)'/.exec(String(err.sqlMessage ?? err.message))?.[1] ?? '';
    const message = KEY_MESSAGES[key] ?? 'That record already exists.';
    return res.status(409).json({ ok: false, error: { code: 'DUPLICATE', message } });
  }
  // 1451/1452 foreign key, 4025/3819 CHECK constraint
  if ([1451, 1452, 4025, 3819].includes(err?.errno)) {
    return res.status(409).json({ ok: false, error: { code: 'CONSTRAINT', message: 'That change conflicts with related data.' } });
  }
  // 1264/1265/1292/1366/1406 out-of-range or malformed value
  if ([1264, 1265, 1292, 1366, 1406].includes(err?.errno)) {
    return res.status(400).json({ ok: false, error: { code: 'BAD_REQUEST', message: 'One of the values has an invalid format.' } });
  }
  logger.error({ err, id: req.id, path: req.path, method: req.method }, 'unhandled error');
  res.status(500).json({ ok: false, error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', request_id: req.id } });
}
