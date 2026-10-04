import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Avatar, Badge, Empty, ErrorState, Field, Modal, PageHead, Pager, SkeletonRows, StatusBadge, fieldErrors, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { fmtDateTime } from '../format';

export default function Teachers() {
  const { can } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(false);
  const [detail, setDetail] = useState<string | null>(null);
  useEffect(() => setPage(1), [dq]);
  const list = useFetch(() => api.get(`/api/teachers${qs({ q: dq, page, page_size: 25 })}`), [dq, page]);
  const rows: any[] = list.data?.data ?? [];
  return (
    <>
      <PageHead title="Teachers" actions={can('user:manage') && <button className="btn primary" onClick={() => setAdd(true)}>＋ Add teacher</button>} />
      <div className="card">
        <div className="row" style={{ padding: 12 }}><input className="input" placeholder="Search teachers…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search teachers" /></div>
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonRows /> : !rows.length ? <Empty icon="🎓" title="No teachers yet" action={can('user:manage') ? <button className="btn primary" onClick={() => setAdd(true)}>Add a teacher</button> : undefined}>Teachers can be assigned to batches once added.</Empty> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Teacher</th><th>Email</th><th>Active batches</th><th>Last sign-in</th><th>Status</th></tr></thead><tbody>
            {rows.map((t) => <tr key={t.id}><td><button className="btn ghost" style={{ padding: 0 }} onClick={() => setDetail(t.id)}><span className="row"><Avatar name={t.full_name} /><b>{t.full_name}</b></span></button></td><td>{t.email}</td><td>{t.active_batches}</td><td className="small">{fmtDateTime(t.last_login_at)}</td><td><StatusBadge s={t.status} /></td></tr>)}</tbody></table></div>)}
        {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
      </div>
      {add && <AddTeacher onClose={() => setAdd(false)} onDone={() => { list.reload(); }} />}
      {detail && <TeacherDetail id={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function TeacherDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/teachers/${id}`).then((r) => r.data), [id]);
  return <Modal title="Teacher" onClose={onClose}>{q.error ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonRows n={3} /> : (
    <div className="stack"><div className="row"><Avatar name={q.data.full_name} lg /><div><h2>{q.data.full_name}</h2><div className="muted">{q.data.email}</div></div></div>
      <h3>Batches</h3>{!q.data.batches.length ? <span className="muted">Not assigned to any batch.</span> : q.data.batches.map((b: any) => <div key={b.id} className="row between"><span>{b.name} <span className="muted mono">{b.batch_code}</span></span><span className="row gap-s"><Badge>{b.role}</Badge>{b.assignment_status === 'removed' ? <Badge tone="warn">removed</Badge> : <StatusBadge s={b.status} />}</span></div>)}</div>)}</Modal>;
}

function AddTeacher({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ full_name: '', email: '', mobile: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [pw, setPw] = useState<string | null>(null);
  const { busy, run } = useAction();
  const toast = useToast();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    try { const r = await api.post('/api/teachers', { ...v, mobile: v.mobile || undefined }); setPw(r.data.temporary_password); onDone(); toast('Teacher added'); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title="Add teacher" onClose={onClose} footer={pw ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-t" disabled={busy || v.full_name.length < 2 || !v.email}>Add teacher</button></>}>
    {pw ? <div className="stack"><p style={{ margin: 0 }}>Share these details securely. The teacher must change the password on first sign-in.</p><div className="card card-pad"><div>Email: <b>{v.email}</b></div><div>Temporary password: <b className="mono">{pw}</b></div></div><p className="muted small" style={{ margin: 0 }}>Shown only once.</p></div> : (
      <form id="add-t" onSubmit={submit} className="stack" noValidate><Field label="Full name" error={errs.full_name}><input className="input" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} autoFocus /></Field>
        <Field label="Email" error={errs.email}><input className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
        <Field label="Mobile (optional)" error={errs.mobile}><input className="input" value={v.mobile} onChange={(e) => setV({ ...v, mobile: e.target.value })} /></Field></form>)}</Modal>;
}
