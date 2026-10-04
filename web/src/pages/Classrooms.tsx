import { Link } from 'react-router-dom';
import { api } from '../api';
import { fmtSchedule } from '../format';
import { Async, Badge, Empty, PageHead, StatusBadge, useFetch } from '../components/ui';
import { useAuth } from '../auth';

export default function Classrooms() {
  const { can } = useAuth();
  const manage = can('classroom:manage');
  const q = useFetch(() => api.get('/api/classrooms').then((r) => r.data), []);
  return (
    <>
      <PageHead title="Classroom" sub={manage ? 'Your batches: post updates, share materials and review work.' : 'Your classes, materials and assignments.'} />
      <Async q={q} empty={(d: any[]) => !d.length}>{(rows: any[]) => rows.length ? (
        <div className="grid cols-3">{rows.map((b) => (
          <Link key={b.id} to={`/classroom/${b.id}`} className="card card-pad" style={{ display: 'block', color: 'inherit' }}>
            <div className="row between"><b>{b.name}</b><StatusBadge s={b.status} /></div>
            <div className="muted small" style={{ marginTop: 4 }}>{b.course_name} · {fmtSchedule(b.schedule)}</div>
            <div className="muted small">Teacher: {b.teachers?.map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div>
            <div className="chips" style={{ marginTop: 10 }}>
              <Badge>{b.active_learners} learners</Badge><Badge>{b.assignments_total} assignments</Badge>
              {manage ? (Number(b.pending_review) > 0 && <Badge tone="warn">{b.pending_review} to review</Badge>) : (Number(b.pending_work) > 0 && <Badge tone="warn">{b.pending_work} pending</Badge>)}
            </div>
          </Link>))}</div>
      ) : <div className="card"><Empty icon="🏫" title="No classrooms yet">{manage ? 'Classrooms appear for batches you teach.' : 'Once you are added to a batch, its classroom shows up here.'}</Empty></div>}</Async>
    </>
  );
}
