import { api, qs } from '../api';
import { BarRow, LineChart } from './Charts';
import { Async, Empty, useFetch } from './ui';

const mlabel = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });

/** Performance, attendance, XP and badge growth, completion and course progress for one learner. */
export function LearnerAnalytics({ learnerId }: { learnerId?: string }) {
  const q = useFetch(() => api.get(`/api/analytics/learner${qs({ learner_id: learnerId, months: 6 })}`).then((r) => r.data), [learnerId]);
  return (
    <Async q={q}>{(a: any) => (
      <div className="stack">
        <div className="grid cols-2">
          <div className="card card-pad"><LineChart title="Average score % by month" unit="%" max={100} points={a.performance.map((p: any) => ({ label: mlabel(p.month), value: p.avg_pct }))} /></div>
          <div className="card card-pad"><LineChart title="Attendance % by month (all batches combined)" unit="%" max={100} points={a.attendance.map((p: any) => ({ label: mlabel(p.month), value: p.pct }))} /></div>
          <div className="card card-pad"><LineChart title="XP balance" points={a.xp.map((p: any) => ({ label: mlabel(p.month), value: p.balance }))} /></div>
          <div className="card card-pad"><LineChart title="Badges earned (total)" points={a.badges.map((p: any) => ({ label: mlabel(p.month), value: p.total }))} /></div>
        </div>
        <div className="grid cols-2">
          <div className="card card-pad"><h3 style={{ marginTop: 0 }}>Assignment completion</h3>
            {a.assignment_completion.length ? <>{a.assignment_completion.map((b: any) => <BarRow key={b.batch_id} label={b.batch_name} value={b.done} total={b.total} />)}</> : <Empty icon="📝" title="No assignments yet">Nothing has been assigned.</Empty>}</div>
          <div className="card card-pad"><h3 style={{ marginTop: 0 }}>Course progress</h3>
            {a.course_progress.length ? a.course_progress.map((c: any) => <BarRow key={c.course_id} label={c.course_name} value={c.assignments_done + c.sessions_attended} total={c.assignments_total + c.sessions_held} sub={`${c.assignments_done}/${c.assignments_total} assignments · ${c.sessions_attended}/${c.sessions_held} classes`} />) : <Empty icon="📚" title="No courses yet">Join a batch to see progress.</Empty>}</div>
        </div>
      </div>)}</Async>
  );
}
