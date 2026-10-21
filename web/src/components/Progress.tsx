import { api } from '../api';
import { Async, Badge, Empty, useFetch } from './ui';

/** One learner's month: every number comes from recorded attendance, scores and activity. */
export function ReportView({ learnerId, month }: { learnerId: string; month: string }) {
  const q = useFetch(() => api.get(`/api/progress/learners/${learnerId}/report?month=${month}`).then((r) => r.data), [learnerId, month]);
  return (
    <Async q={q}>{(r: any) => (
      <div className="stack">
        <div className="summary-grid">
          <div className="hl"><b>{r.attendance.overall_pct == null ? '—' : `${r.attendance.overall_pct}%`}</b><span>Attendance ({r.attendance.classes_marked} classes)</span></div>
          <div><b>{r.scores.average_pct == null ? '—' : `${r.scores.average_pct}%`}</b><span>Average score{r.scores.change != null ? ` (${r.scores.change >= 0 ? '+' : ''}${r.scores.change} vs last month)` : ''}</span></div>
          <div><b>{r.assignments.due ? `${r.assignments.done} of ${r.assignments.due}` : '—'}</b><span>Assignments done</span></div>
          <div><b>{r.xp_earned >= 0 ? '+' : ''}{r.xp_earned}</b><span>XP earned</span></div>
        </div>
        {!r.has_data && <div className="card"><Empty icon="🗓️" title="Nothing recorded this month">Attendance, scores and notes appear here as teachers record them.</Empty></div>}
        {r.attendance.batches.length > 0 && <div className="card card-pad"><h2 style={{ marginTop: 0 }}>Attendance</h2>{r.attendance.batches.map((b: any) => <div key={b.batch_id} className="row between wrap" style={{ padding: '4px 0' }}><span>{b.batch_name}</span><span className="muted">present {b.present} · late {b.late} · absent {b.absent}{b.pct == null ? '' : ` · ${b.pct}%`}</span></div>)}</div>}
        {r.scores.items.length > 0 && <div className="card card-pad"><h2 style={{ marginTop: 0 }}>Scores</h2>{r.scores.items.map((s: any, i: number) => <div key={i} className="row between wrap" style={{ padding: '4px 0' }}><span>{s.name} <span className="muted small">{s.batch_name}</span></span><b>{s.score}/{s.max_score}</b></div>)}</div>}
        {r.badges.length > 0 && <div className="card card-pad"><h2 style={{ marginTop: 0 }}>Badges earned</h2><div className="chips">{r.badges.map((b: string) => <Badge key={b} tone="ok">🏅 {b}</Badge>)}</div></div>}
        {r.notes.length > 0 && <div className="card card-pad"><h2 style={{ marginTop: 0 }}>Teacher notes</h2>{r.notes.map((n: any, i: number) => <p key={i} style={{ margin: '0 0 10px' }}><b>{n.teacher}</b> <span className="muted small">{n.batch_name}</span><br />{n.body}</p>)}</div>}
        <div><button className="btn" onClick={() => api.getFile(`/api/progress/learners/${learnerId}/report.pdf?month=${month}`, `progress-${month}.pdf`, true)}>Download PDF</button></div>
      </div>)}</Async>
  );
}

export const monthNow = () => new Intl.DateTimeFormat('en-CA').format(new Date()).slice(0, 7);
export const monthBefore = () => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return new Intl.DateTimeFormat('en-CA').format(d).slice(0, 7); };
