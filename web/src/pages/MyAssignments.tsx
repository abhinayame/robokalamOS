import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { cap, fmtDateTime } from '../format';
import { Async, Badge, Empty, PageHead, Tabs, useFetch } from '../components/ui';

const TONE: Record<string, string> = { upcoming: '', due: 'warn', completed: 'ok', late: 'bad', returned: 'warn' };
type S = '' | 'upcoming' | 'due' | 'late' | 'returned' | 'completed';

export function AssignmentList({ learnerId }: { learnerId?: string }) {
  const [state, setState] = useState<S>('');
  const q = useFetch(() => api.get(`/api/assignments${qs({ learner_id: learnerId, state })}`), [learnerId, state]);
  const counts = q.data?.meta?.counts ?? {};
  return (
    <>
      <Tabs value={state} onChange={setState} tabs={[{ id: '', label: 'All' }, ...(['due', 'upcoming', 'late', 'returned', 'completed'] as const).map((s) => ({ id: s as S, label: cap(s), badge: counts[s] ?? 0 }))]} />
      <Async q={q as any} empty={(d: any) => !d.data.length}>{(d: any) => d.data.length ? <div className="card">{d.data.map((a: any) => (
        <Link key={a.id} to={`/assignments/${a.id}`} className="m-card" style={{ alignItems: 'center', color: 'inherit' }}>
          <div className="grow"><b>{a.title}</b><div className="muted small">{a.batch_name} · {a.due_at ? `Due ${fmtDateTime(a.due_at)}` : 'No due date'}</div></div><Badge tone={TONE[a.state]}>{cap(a.state)}</Badge></Link>))}</div>
        : <div className="card"><Empty icon="🎉" title="Nothing here">No assignments in this view.</Empty></div>}</Async>
    </>
  );
}

export default function MyAssignments() {
  return <><PageHead title="Assignments" sub="Everything assigned to you, across your batches." /><AssignmentList /></>;
}
