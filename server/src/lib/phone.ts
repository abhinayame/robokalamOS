/** Normalise an Indian mobile to +91XXXXXXXXXX. Returns null when invalid. */
export function normalizeMobile(input: string | null | undefined): string | null {
  if (input == null) return null;
  let d = String(input).replace(/[\s\-().]/g, '');
  if (d === '') return null;
  if (d.startsWith('+')) d = d.slice(1);
  if (!/^\d+$/.test(d)) return null;
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  if (!/^[6-9]\d{9}$/.test(d)) return null;
  return `+91${d}`;
}
