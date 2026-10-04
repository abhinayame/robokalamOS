import { useState } from 'react';
import { api, qs } from '../api';
import { fmtNum } from '../format';
import { BatchSelector } from '../components/BatchSelector';
import { Async, Badge, Empty, Modal, PageHead, StatusBadge, useFetch } from '../components/ui';

const p = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);
const ROWS: { label: string; get: (m: any) => number | null; fmt: (v: number | null) => string; best: 'max' | 'min' | null }[] = [
  { label: 'Active learners', get: (m) => m.learners_active, fmt: (v) => fmtNum(v), best: null },
  { label: 'Attendance', get: (m) => m.attendance.pct, fmt: p, best: 'max' },
  { label: 'Average score', get: (m) => m.scores.avg_pct, fmt: p, best: 'max' },
  { label: 'Assignment completion', get: (m) => m.assignments.completion_pct, fmt: p, best: 'max' },
  { label: 'XP', get: (m) => m.xp.net, fmt: (v) => fmtNum(v), best: 'max' },
  { label: 'Badges', get: (m) => m.badges, fmt: (v) => fmtNum(v), best: 'max' },
  { label: 'Retention', get: (m) => m.retention_pct, fmt: p, best: 'max' },
  { label: 'Classes held', get: (m) => m.classes.held, fmt: (v) => fmtNum(v), best: null },
];

/** Compare 2-10 batches side by side. Every figure is computed on the server for batches the caller may see. */
export default function Analytics() {
  const [ids, setIds] = useState<string[]>([]);
  const [open, setOpen] = useState(false);
  const [range, setRange] = useState({ from: '', to: '' });
  const q = useFetch(() => (ids.length >= 2 ? api.get(`/api/analytics/compare${qs({ batch_ids: ids, ...range })}`) : Promise.resolve(null)), [ids.join(','), range.from, range.to]);
  return (
    <>
      <PageHead title="Compare batches" sub="Pick two or more batches to see them side by side." actions={<button className="btn primary" onClick={() => setOpen(true)}>{ids.length ? `Change batches (${ids.length})` : 'Choose batches'}</button>} />
      <div className="card card-pad row wrap" style={{ marginBottom: 14 }}><span className="muted small">Period (optional)</span>
        <label className="row small">From <input className="input" type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="row small">To <input className="input" type="date" value={range.to} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <span className="muted small">Applies to attendance, scores, XP and badges.</span></div>
      {ids.length < 2 ? <div className="card"><Empty icon="📈" title="Choose at least two batches">Compare learners, attendance, scores, assignment completion, XP, badges and retention.</Empty></div>
        : <Async q={q as any}>{(d: any) => d ? (
          <div className="card table-wrap"><table className="t" style={{ minWidth: 520 }}>
            <thead><tr><th>Metric</th>{d.data.map((b: any) => <th key={b.id}>{b.name}<div className="muted small">{b.course_name}</div><StatusBadge s={b.status} /></th>)}</tr></thead>
            <tbody>{ROWS.map((r) => { const vals = d.data.map((b: any) => r.get(b.metrics)); const nums = vals.filter((v: number | null): v is number => v !== null); const top = r.best && nums.length > 1 ? Math.max(...nums) : null;
              return <tr key={r.label}><td><b>{r.label}</b></td>{vals.map((v: number | null, i: number) => <td key={i}>{r.fmt(v)}{top !== null && v === top && nums.filter((x: number) => x === top).length === 1 && <> <Badge tone="ok">best</Badge></>}</td>)}</tr>; })}</tbody></table></div>) : null}</Async>}
      {open && <Modal wide title="Choose batches to compare" onClose={() => setOpen(false)} footer={<button className="btn primary" onClick={() => setOpen(false)}>Done</button>}><BatchSelector value={ids} onChange={(v) => setIds(v.slice(0, 10))} /><p className="muted small">Up to 10 batches.</p></Modal>}
    </>
  );
}
