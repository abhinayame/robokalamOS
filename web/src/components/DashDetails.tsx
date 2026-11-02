import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { cap, fmtDate, fmtDateTime, fmtMoney, fmtNum } from '../format';
import { Icon } from './Icon';
import { Async, Badge, Empty, Modal, StatusBadge, useFetch } from './ui';

/** Reporting window for dashboard numbers. `from`/`to` only for `custom`. */
export type Period = { period: string; from?: string; to?: string };
export const PERIODS: { id: string; label: string; short: string }[] = [
  { id: 'week', label: 'This week', short: 'Week' }, { id: 'month', label: 'This month', short: 'Month' }, { id: 'quarter', label: 'This quarter', short: 'Quarter' },
  { id: 'half', label: 'This half-year', short: 'Half-year' }, { id: 'year', label: 'This year', short: 'Year' }, { id: 'all', label: 'All time', short: 'All time' }, { id: 'custom', label: 'Custom range', short: 'Custom' },
];
export const periodQs = (p: Period) => {
  const s = new URLSearchParams({ period: p.period });
  if (p.period === 'custom') { if (p.from) s.set('from', p.from); if (p.to) s.set('to', p.to); }
  return s.toString();
};
/** "this month", "this week" … for use inside sentences; custom ranges read "1 Feb – 28 Feb 2026". */
export const periodPhrase = (p: Period, server?: { start: string | null; end: string } | null) =>
  p.period === 'custom' && server?.start ? `${fmtDate(server.start)} – ${fmtDate(server.end)}` : (PERIODS.find((x) => x.id === p.period)?.label ?? 'This month').toLowerCase();

export function PeriodPicker({ value, onChange }: { value: Period; onChange: (p: Period) => void }) {
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(value.from ?? `${today.slice(0, 7)}-01`); const [to, setTo] = useState(value.to ?? today);
  return (
    <div className="period">
      <div className="period-chips" role="radiogroup" aria-label="Show numbers for">
        <Icon name="calendar" size={16} className="period-ic" />
        {PERIODS.map((p) => (
          <button key={p.id} type="button" role="radio" aria-checked={value.period === p.id} className={`period-chip ${value.period === p.id ? 'on' : ''}`}
            onClick={() => onChange(p.id === 'custom' ? { period: 'custom', from, to } : { period: p.id })}>{p.short}</button>))}
      </div>
      {value.period === 'custom' && (
        <form className="period-custom" onSubmit={(e) => { e.preventDefault(); onChange({ period: 'custom', from, to }); }}>
          <label>From <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></label>
          <label>To <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></label>
          <button className="btn sm primary" type="submit">Apply</button>
        </form>)}
    </div>
  );
}

type Col = { key: string; label: string; kind?: 'text' | 'money' | 'number' | 'pct' | 'date' | 'datetime' | 'status' };
const METHOD: Record<string, string> = { upi: 'UPI', cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', cheque: 'Cheque', online: 'Online' };
const cell = (v: any, kind?: Col['kind'], key?: string) => {
  if (v == null || v === '') return '—';
  if (key === 'method') return <Badge>{METHOD[String(v)] ?? cap(String(v))}</Badge>;
  switch (kind) {
    case 'money': return fmtMoney(v); case 'number': return fmtNum(Number(v)); case 'pct': return `${v}%`;
    case 'date': return fmtDate(String(v)); case 'datetime': return fmtDateTime(String(v)); case 'status': return <StatusBadge s={String(v)} />;
    default: return String(v);
  }
};
const plain = (v: any, kind?: Col['kind']) => (v == null ? '' : kind === 'status' ? cap(String(v)) : kind === 'date' ? String(v).slice(0, 10) : String(v));

function downloadCsv(name: string, cols: Col[], rows: any[]) {
  const esc = (s: string) => { const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s; return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };   // no spreadsheet formulas
  const csv = [cols.map((c) => esc(c.label)).join(','), ...rows.map((r) => cols.map((c) => esc(plain(r[c.key], c.kind))).join(','))].join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
  a.download = `${name}.csv`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** The records behind one dashboard number, in a sheet: summary numbers, a table (cards on phones), CSV, and a link to the full page. */
export function DetailsSheet({ metric, period, onClose }: { metric: string; period: Period; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/dashboard/details/${metric}?${periodQs(period)}`).then((r) => r.data), [metric, periodQs(period)]);
  const d: any = q.data;
  const title = d ? `${d.title}${d.period ? ` · ${periodPhrase(period, d.period)}` : ''}` : 'Details';
  return (
    <Modal wide title={title} onClose={onClose} footer={d && <>
      {d.rows.length > 0 && <button className="btn" onClick={() => downloadCsv(`${metric}-${d.period?.start ?? 'all'}-${d.period?.end ?? ''}`, d.columns, d.rows)}><Icon name="download" size={15} /> Download CSV</button>}
      {d.open && <Link className="btn primary" to={d.open.to} onClick={onClose}>{d.open.label} <Icon name="arrow-right" size={15} /></Link>}</>}>
      <Async q={q}>{(d: any) => (
        <div className="details">
          <div className="details-sum">{d.summary.map((s: any) => <div key={s.label}><span>{s.label}</span><b>{s.kind === 'money' ? fmtMoney(s.value) : s.kind === 'pct' ? (s.value == null ? '—' : `${s.value}%`) : fmtNum(s.value)}</b></div>)}</div>
          {d.period && <div className="muted small">{fmtDate(d.period.start) === '—' ? 'From the beginning' : fmtDate(d.period.start)} – {fmtDate(d.period.end)}</div>}
          {!d.rows.length ? <Empty compact icon="inbox" title="Nothing in this period">Try a longer period from the picker above the numbers.</Empty> : <>
            <div className="table-wrap details-table"><table className="t">
              <thead><tr>{d.columns.map((c: Col) => <th key={c.key} className={['money', 'number', 'pct'].includes(c.kind ?? '') ? 'num' : undefined}>{c.label}</th>)}<th aria-label="Open" /></tr></thead>
              <tbody>{d.rows.map((r: any, i: number) => { const main = (d.columns as Col[]).find((c) => !c.kind || c.kind === 'text') ?? d.columns[0]; return (
                <tr key={r.id ?? r.learner_id ?? i}>{d.columns.map((c: Col) => <td key={c.key} className={['money', 'number', 'pct'].includes(c.kind ?? '') ? 'num' : undefined}>{c === main && r.link ? <Link to={r.link} onClick={onClose}><b>{cell(r[c.key], c.kind, c.key)}</b></Link> : cell(r[c.key], c.kind, c.key)}</td>)}
                  <td>{r.link && <Link to={r.link} onClick={onClose} aria-label="Open" className="details-go"><Icon name="chevron" size={16} /></Link>}</td></tr>); })}</tbody>
            </table></div>
            <div className="details-cards">{d.rows.map((r: any, i: number) => {
              const cols = d.columns as Col[];
              const main = cols.find((c) => !c.kind || c.kind === 'text') ?? cols[0];
              const amount = cols.find((c) => c.kind === 'money') ?? cols.find((c) => c.kind === 'pct');
              const status = cols.find((c) => c.kind === 'status');
              const others = cols.filter((c) => c !== main && c !== amount && c !== status).slice(0, 3);
              const body = <><div className="row between"><b>{cell(r[main.key], main.kind)}</b>{amount && <b className="num">{cell(r[amount.key], amount.kind)}</b>}</div>
                <div className="details-meta">{others.map((c) => <span key={c.key}>{c.label}: {cell(r[c.key], c.kind, c.key)}</span>)}{status && cell(r[status.key], 'status', status.key)}</div></>;
              const k = r.id ?? r.learner_id ?? i;
              return r.link ? <Link key={k} to={r.link} onClick={onClose} className="m-card details-card">{body}</Link> : <div key={k} className="m-card details-card">{body}</div>;
            })}</div>
            {d.truncated && <div className="muted small">Showing the first {d.rows.length} of {fmtNum(d.total_rows)}. Open the full page for everything.</div>}
          </>}
        </div>
      )}</Async>
    </Modal>
  );
}
