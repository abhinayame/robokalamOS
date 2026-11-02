import { z } from 'zod';
import { queryOne } from '../../db/pool.js';
import { badRequest } from '../../lib/errors.js';
import { addDays, zonedToUtc } from '../attendance/time.js';

/** Reporting windows a dashboard can be viewed for. Every window ends today (inclusive) in the organization's time zone. */
export const PERIODS = ['week', 'month', 'quarter', 'half', 'year', 'all', 'custom'] as const;
export type PeriodKey = (typeof PERIODS)[number];

const LABEL: Record<PeriodKey, string> = { week: 'This week', month: 'This month', quarter: 'This quarter', half: 'This half-year', year: 'This year', all: 'All time', custom: 'Custom range' };
const ymd = /^\d{4}-\d{2}-\d{2}$/;
export const periodQuery = z.object({
  period: z.enum(PERIODS).optional(),
  from: z.string().regex(ymd, 'Use YYYY-MM-DD').optional(),
  to: z.string().regex(ymd, 'Use YYYY-MM-DD').optional(),
});

export type Range = {
  key: PeriodKey; label: string;
  /** Local calendar dates, both inclusive (null `start` = from the beginning). */
  start: string | null; end: string;
  /** UTC instants for system timestamps (created_at, awarded_at, starts_at …): `[from, to)`. */
  fromTs: string | null; toTs: string;
  /** Local wall-clock bounds for payments.paid_at, which the fees module stores and compares as local time. */
  fromLocal: string | null; toLocal: string;
};

const ts = (d: Date) => d.toISOString().slice(0, 23).replace('T', ' ');

export async function orgTimezone(orgId: string) {
  return ((await queryOne(`SELECT timezone FROM organizations WHERE id = $1`, [orgId]))?.timezone as string) || 'Asia/Kolkata';
}

/** Resolve `?period=` (and `from`/`to` for custom) to concrete bounds. Returns null when no period was asked for (legacy, unfiltered numbers). */
export function resolveRange(q: z.infer<typeof periodQuery>, tz: string, now = new Date()): Range | null {
  if (!q.period && !q.from && !q.to) return null;
  const key: PeriodKey = q.period ?? 'custom';
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now);
  const [y, m] = today.split('-').map(Number);
  let start: string | null; let end = today;
  switch (key) {
    case 'week': { const wd = (new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7; start = addDays(today, -wd); break; }   // Monday-based weeks
    case 'month': start = `${today.slice(0, 7)}-01`; break;
    case 'quarter': start = `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`; break;
    case 'half': start = `${y}-${m <= 6 ? '01' : '07'}-01`; break;
    case 'year': start = `${y}-01-01`; break;
    case 'all': start = null; break;
    case 'custom': {
      if (!q.from || !q.to) throw badRequest('Choose both a start and an end date.');
      if (q.from > q.to) throw badRequest('The start date must be on or before the end date.');
      start = q.from; end = q.to; break;
    }
  }
  const next = addDays(end, 1);
  return {
    key, label: LABEL[key], start, end,
    fromTs: start ? ts(zonedToUtc(start, '00:00', tz)) : null, toTs: ts(zonedToUtc(next, '00:00', tz)),
    fromLocal: start ? `${start} 00:00:00` : null, toLocal: `${next} 00:00:00`,
  };
}

/** SQL condition `col` within the range, adding the bounds to `p`. `local` picks the wall-clock bounds (payments). */
export function within(col: string, r: Range, add: (v: unknown) => string, local = false) {
  const from = local ? r.fromLocal : r.fromTs; const to = local ? r.toLocal : r.toTs;
  return `${from ? `${col} >= ${add(from)} AND ` : ''}${col} < ${add(to)}`;
}

export const publicRange = (r: Range) => ({ key: r.key, label: r.label, start: r.start, end: r.end });
