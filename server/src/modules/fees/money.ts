/** Money is handled as whole paise (integers) in code and DECIMAL(12,2) rupees in the database, so sums never drift. */
export const toPaise = (v: unknown): number => Math.round(Number(v) * 100);
export const fromPaise = (p: number): string => (p / 100).toFixed(2);
export const rupees = (p: number): string => `₹${(p / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Split `gross` paise across `parts` (proportional weights in paise) after taking `discount` paise off,
 * so the pieces add up to exactly gross - discount. Each piece keeps its share of the discount; the last piece absorbs rounding.
 */
export function discountedParts(parts: number[], discount: number): number[] {
  const gross = parts.reduce((a, b) => a + b, 0);
  if (discount < 0 || discount >= gross) throw new RangeError('The discount must be smaller than the fee.');
  let left = discount;
  return parts.map((p, i) => {
    const cut = i === parts.length - 1 ? left : Math.floor((p * discount) / gross);
    left -= cut;
    return p - cut;
  });
}

/** YYYY-MM-DD for "now" in an IANA timezone: dues are due on the organization's calendar day, not the server's. */
export const todayIn = (tz: string, d = new Date()): string => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
export const addDays = (ymd: string, days: number): string => { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
