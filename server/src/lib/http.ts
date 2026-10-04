import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { z, type ZodType } from 'zod';
import { badRequest } from './errors.js';

/** Wrap async handlers so rejections reach the error middleware. */
export const wrap =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export const ok = (res: Response, data: unknown, meta?: unknown, status = 200) =>
  res.status(status).json({ ok: true, data, ...(meta ? { meta } : {}) });

export function parse<T extends ZodType>(schema: T, input: unknown): z.infer<T> {
  const r = schema.safeParse(input);
  if (!r.success) {
    throw badRequest('Some fields need your attention.', r.error.issues.map((i) => ({
      field: i.path.join('.'),
      message: i.message,
    })));
  }
  return r.data;
}

export const uuid = z.string().uuid();
/** Comma separated query value or repeated key → string[] */
export const csvList = <T extends string = string>(item: ZodType<T> = z.string() as unknown as ZodType<T>) =>
  z.preprocess((v) => {
    if (v == null || v === '') return undefined;
    const arr = Array.isArray(v) ? v : String(v).split(',');
    return arr.map((s) => String(s).trim()).filter(Boolean);
  }, z.array(item).max(500).optional());

export const paging = z.object({
  page: z.coerce.number().int().min(1).default(1),
  page_size: z.coerce.number().int().min(1).max(100).default(25),
  order: z.enum(['asc', 'desc']).default('asc'),
});
