import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtNum } from '../format';
import { Async, Badge, Empty, Stat, useFetch } from './ui';
import { BarRow, LineChart } from './Charts';

const p = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

/** The batch dashboard: headline numbers, attendance by month, score bands and who needs a closer look. */
export function BatchInsights({ batchId }: { batchId: string }) {
  const q = useFetch(() => api.get(`/api/analytics/batch/${batchId}`).then((r) => r.data), [batchId]);
  return (
    <Async q={q}>{(d: any) => { const m = d.metrics; const bands = d.score_bands; const nb = bands.excellent + bands.good + bands.average + bands.needs_attention; return (
      <div className="stack">
        <div className="grid cols-4">
          <Stat label="Active learners" value={fmtNum(m.learners_active)} sub={`${m.left} left · ${m.completed} completed`} />
          <Stat label="Attendance" value={p(m.attendance.pct)} sub={`${m.classes.held} classes held · ${m.classes.upcoming} coming`} />
          <Stat label="Assignment completion" value={p(m.assignments.completion_pct)} sub={`${m.assignments.total} assignment(s) set`} />
          <Stat label="Average score" value={p(m.scores.avg_pct)} sub={`${fmtNum(m.scores.scored)} scores`} />
          <Stat label="XP" value={fmtNum(m.xp.net)} />
          <Stat label="Badges" value={fmtNum(m.badges)} />
          <Stat label="Retention" value={p(m.retention_pct)} sub="Current members of everyone who joined and did not complete" />
          <Stat label="Teacher" value={d.teachers.map((t: any) => t.full_name).join(', ') || '—'} />
        </div>
        <div className="grid cols-2">
          <div className="card card-pad"><LineChart title="Attendance % by month" unit="%" max={100} points={d.attendance_by_month.map((x: any) => ({ label: x.month.slice(5), value: x.pct }))} /></div>
          <div className="card card-pad"><h3 style={{ marginTop: 0 }}>How learners are doing</h3>
            {nb ? <>{[['Excellent (85%+)', bands.excellent], ['Good (70-84%)', bands.good], ['Average (50-69%)', bands.average], ['Needs attention (<50%)', bands.needs_attention]].map(([l, v]) => <BarRow key={l as string} label={l as string} value={v as number} total={nb} sub={`${v} learner${v === 1 ? '' : 's'}`} />)}</> : <Empty icon="📊" title="No scores yet">Bands appear once learners are scored.</Empty>}</div>
        </div>
        <div className="card"><div className="card-head"><h2>Needs a closer look</h2><span className="muted small">Attendance under 75% (3+ marked classes) or average under 50% (2+ scores)</span></div>
          {d.needs_attention.length ? d.needs_attention.map((l: any) => <div key={l.learner_id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/learners/${l.learner_id}`}><b>{l.full_name}</b></Link></div>{l.reasons.map((r: string) => <Badge key={r} tone="warn">{r}</Badge>)}</div>) : <Empty icon="✅" title="Nobody flagged">No learner crosses those thresholds right now.</Empty>}</div>
        <div className="row wrap"><Link className="btn sm" to={`/reports?report=batch&batch_id=${batchId}`}>Batch report</Link><Link className="btn sm" to={`/reports?report=attendance&batch_id=${batchId}`}>Attendance report</Link><Link className="btn sm" to={`/reports?report=score&batch_id=${batchId}`}>Score report</Link></div>
      </div>); }}</Async>
  );
}
