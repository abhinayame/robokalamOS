import { api } from '../api';
import { fmtDate, fmtSchedule } from '../format';
import { Async, Empty, PageHead, StatusBadge, useFetch } from '../components/ui';

export default function MyClasses() {
  const q = useFetch(() => api.get('/api/dashboard').then((r) => r.data), []);
  return (
    <>
      <PageHead title="My classes" sub="Every batch you or your children are part of." />
      <Async q={q}>{(d: any) => {
        const kids: any[] = d.children ?? [];
        if (!kids.some((k) => k.batches.length)) return <div className="card"><Empty icon="🏫" title="No classes yet">Once you are added to a batch it will show up here.</Empty></div>;
        return <div className="stack">{kids.map((k) => (
          <div className="card" key={k.id}><div className="card-head"><h2>{k.full_name}</h2></div>
            {k.batches.map((b: any) => <div key={b.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{b.name}</b><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div><div className="muted small">{fmtDate(b.start_date)} → {fmtDate(b.end_date)} · Teacher: {b.teachers.map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div><StatusBadge s={b.status} /></div>)}
          </div>))}</div>;
      }}</Async>
    </>
  );
}
