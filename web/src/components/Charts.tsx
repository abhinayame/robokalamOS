/** Small accessible line chart: real points only (gaps stay gaps), labelled axes, text summary for screen readers. */
export function LineChart({ title, points, unit = '', max, height = 140 }: { title: string; points: { label: string; value: number | null }[]; unit?: string; max?: number; height?: number }) {
  const w = 320; const padL = 30; const padB = 22; const padT = 10; const h = height;
  const vals = points.map((p) => p.value).filter((v): v is number => v !== null);
  const top = max ?? Math.max(10, Math.ceil(Math.max(0, ...vals) / 10) * 10);
  const x = (i: number) => padL + (points.length <= 1 ? (w - padL - 8) / 2 : (i * (w - padL - 8)) / (points.length - 1));
  const y = (v: number) => padT + (1 - v / top) * (h - padT - padB);
  const segs: string[] = []; let cur: string[] = [];
  points.forEach((p, i) => { if (p.value === null) { if (cur.length) segs.push(cur.join(' ')); cur = []; } else cur.push(`${x(i)},${y(p.value)}`); });
  if (cur.length) segs.push(cur.join(' '));
  const summary = vals.length ? `${title}: ${points.filter((p) => p.value !== null).map((p) => `${p.label} ${p.value}${unit}`).join(', ')}` : `${title}: no data yet`;
  return (
    <figure style={{ margin: 0 }}>
      <figcaption className="muted small" style={{ marginBottom: 4 }}><b>{title}</b></figcaption>
      <svg viewBox={`0 0 ${w} ${h}`} role="img" aria-label={summary} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {[0, 0.5, 1].map((f) => <g key={f}><line x1={padL} x2={w - 8} y1={y(top * f)} y2={y(top * f)} stroke="var(--line)" strokeWidth="1" /><text x={padL - 4} y={y(top * f) + 3} fontSize="9" textAnchor="end" fill="var(--muted, #667)">{Math.round(top * f)}</text></g>)}
        {segs.map((s, i) => <polyline key={i} points={s} fill="none" stroke="var(--brand, #1f3b63)" strokeWidth="2" strokeLinejoin="round" />)}
        {points.map((p, i) => p.value === null ? null : <circle key={i} cx={x(i)} cy={y(p.value)} r="3.5" fill="var(--brand, #1f3b63)"><title>{`${p.label}: ${p.value}${unit}`}</title></circle>)}
        {points.map((p, i) => <text key={i} x={x(i)} y={h - 6} fontSize="9" textAnchor="middle" fill="var(--muted, #667)">{p.label}</text>)}
      </svg>
      {!vals.length && <div className="muted small">No data in this period yet.</div>}
    </figure>
  );
}

export function BarRow({ label, value, total, sub }: { label: string; value: number; total: number; sub?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ margin: '6px 0' }}>
      <div className="row between small"><span>{label}</span><b>{total ? `${pct}%` : '—'} <span className="muted">{sub ?? `${value}/${total}`}</span></b></div>
      <div style={{ background: 'var(--line)', borderRadius: 6, height: 8 }} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}><div style={{ width: `${pct}%`, background: 'var(--ok, #168a5c)', height: 8, borderRadius: 6 }} /></div>
    </div>
  );
}
