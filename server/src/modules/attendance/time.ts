/** Wall-clock time in an IANA zone → the UTC instant. DST-safe (re-checks the offset once). */
export function zonedToUtc(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = date.split('-').map(Number); const [hh, mm] = hhmm.split(':').map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const offsetAt = (t: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(t));
    const g = (k: string) => Number(parts.find((p) => p.type === k)!.value);
    return Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'), g('second')) - t;
  };
  let t = wall - offsetAt(wall);
  t = wall - offsetAt(t);
  return new Date(t);
}

export const addDays = (date: string, n: number) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
export const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** Attendance % = (present + late) / (present + late + absent). Excused and unmarked sessions are not counted. */
export function attendancePct(c: { present: number; late: number; absent: number }) {
  const counted = c.present + c.late + c.absent;
  return counted ? Math.round(((c.present + c.late) / counted) * 10000) / 100 : null;
}

export function providerFromUrl(url: string): 'google_meet' | 'zoom' | 'other' {
  try { const h = new URL(url).hostname; if (h.endsWith('meet.google.com')) return 'google_meet'; if (h.endsWith('zoom.us') || h.endsWith('zoom.com')) return 'zoom'; } catch { /* fall through */ }
  return 'other';
}
