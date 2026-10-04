import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDateTime } from '../format';
import { Async, Empty, Field, PageHead, useAction, useFetch } from '../components/ui';

const show = (kind: string | undefined, v: unknown) => (v === null || v === undefined || v === '' ? '—' : kind === 'percent' ? `${v}%` : typeof v === 'number' ? v.toLocaleString('en-IN') : String(v));

/** Report catalogue: preview on screen, download CSV or Excel, or print / save as PDF. */
export default function Reports() {
  const [sp] = useSearchParams();
  const list = useFetch(() => api.get('/api/reports').then((r) => r.data as any[]), []);
  const [id, setId] = useState(sp.get('report') ?? '');
  const [f, setF] = useState<Record<string, string>>({ batch_id: sp.get('batch_id') ?? '', course_id: '', program_id: '', branch_id: '', from: '', to: '', status: '', type: '', counsellor_id: '' });
  useEffect(() => { if (!id && list.data?.length) setId(list.data[0].id); }, [list.data]); // eslint-disable-line
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const programs = useFetch(() => api.get('/api/programs').then((r) => r.data as any[]), []);
  const branches = useFetch(() => api.get('/api/branches').then((r) => r.data as any[]), []);
  const batches = useFetch(() => api.get('/api/batches?page_size=100&sort=name').then((r) => r.data as any[]), []);
  const key = JSON.stringify([id, f]);
  const clean = Object.fromEntries(Object.entries(f).filter(([, v]) => v));
  const q = useFetch(() => (id ? api.get(`/api/reports/${id}${qs(clean)}`).then((r) => r.data) : Promise.resolve(null)), [key]);
  const { busy, run } = useAction();
  const def = list.data?.find((r) => r.id === id);
  const download = (format: 'csv' | 'xlsx') => run(() => api.download(`/api/reports/${id}/export`, { format, filters: clean }, `${id}-report-${new Date().toISOString().slice(0, 10)}.${format}`), `${format.toUpperCase()} downloaded`);
  const sel = (k: string, label: string, opts: any[] | null | undefined) => def?.filters.includes(k) && <Field label={label}><select className="select" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">Any</option>{(opts ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>;
  return (
    <>
      <div className="no-print"><PageHead title="Reports" sub="Download any report as CSV or Excel, or print it as a PDF. You only ever see learners and batches within your own access." /></div>
      <Async q={list}>{(rows: any[]) => (
        <div className="stack">
          <div className="card card-pad no-print stack">
            <div className="form-grid">
              <Field label="Report"><select className="select" value={id} onChange={(e) => setId(e.target.value)}>{rows.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}</select></Field>
              {sel('batch_id', 'Batch', batches.data)}{sel('course_id', 'Course', courses.data)}{sel('program_id', 'Program', programs.data)}{sel('branch_id', 'Branch', branches.data)}
              {def?.filters.includes('type') && <Field label="Type"><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All</option><option value="assignment">Assignments</option><option value="quiz">Quizzes</option><option value="activity">Activities</option></select></Field>}
              {def?.filters.includes('status') && <Field label="Status"><input className="input" value={f.status} placeholder="e.g. active" onChange={(e) => setF({ ...f, status: e.target.value })} /></Field>}
              {def?.filters.includes('from') && <Field label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>}
              {def?.filters.includes('to') && <Field label="To"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>}
            </div>
            {def && <div className="muted small">{def.description}</div>}
            <div className="row wrap"><button className="btn" disabled={busy || !id} onClick={() => download('csv')}>Download CSV</button><button className="btn" disabled={busy || !id} onClick={() => download('xlsx')}>Download Excel</button><button className="btn primary" disabled={!q.data?.rows?.length} onClick={() => window.print()}>Print / save as PDF</button><button className="btn ghost" onClick={() => setF({ batch_id: '', course_id: '', program_id: '', branch_id: '', from: '', to: '', status: '', type: '', counsellor_id: '' })}>Clear filters</button></div>
          </div>
          <Async q={q as any}>{(d: any) => d ? (
            <div className="card report-sheet"><div className="card-head"><h2>{d.title}</h2><span className="muted small">{d.rows.length}{d.truncated ? '+' : ''} row(s) · generated {fmtDateTime(d.generated_at)}</span></div>
              {d.truncated && <div className="banner no-print">Showing the first {d.rows.length} rows. Download CSV or Excel for the full report.</div>}
              {d.rows.length ? <div className="table-wrap"><table className="t"><thead><tr>{d.columns.map((c: any) => <th key={c.key}>{c.label}</th>)}</tr></thead>
                <tbody>{d.rows.map((r: any, i: number) => <tr key={i}>{d.columns.map((c: any) => <td key={c.key} style={c.kind === 'number' || c.kind === 'percent' ? { textAlign: 'right' } : undefined}>{show(c.kind, r[c.key])}</td>)}</tr>)}</tbody></table></div>
                : <Empty icon="📄" title="No rows">Nothing matches these filters.</Empty>}</div>) : null}</Async>
        </div>)}</Async>
    </>
  );
}
