export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]!.toUpperCase()).join('');
export const fmtDate = (d?: string | null) => (d ? new Date(d.length === 10 ? `${d}T00:00:00` : d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const fmtDateTime = (d?: string | null) => (d ? new Date(d).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtNum = (n?: number | null) => (n == null ? '—' : n.toLocaleString('en-IN'));
export const fmtMobile = (m?: string | null) => (m ? m.replace(/^\+91(\d{5})(\d{5})$/, '+91 $1 $2') : '—');
export const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const fmtSchedule = (s: any) => {
  if (!s || !Array.isArray(s.days) || !s.days.length) return 'Not scheduled';
  const t = s.start && s.end ? ` · ${s.start}–${s.end}` : '';
  return `${[...s.days].sort().map((d: number) => DAYS[d]).join(', ')}${t}`;
};
export const statusTone = (s: string): 'ok' | 'warn' | 'bad' | 'info' | '' =>
  ({ active: 'ok', upcoming: 'info', completed: '', archived: 'warn', inactive: 'warn', left: 'warn', transferred: 'info', disabled: 'bad' } as any)[s] ?? '';
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');

/** Rupees from a DECIMAL string or number: ₹3,600 or ₹3,600.50. */
export const fmtMoney = (v?: string | number | null) => { if (v == null || v === '') return '—'; const n = Number(v); return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 })}`; };
