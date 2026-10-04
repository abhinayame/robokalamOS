import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Empty, ErrorState, Field, Modal, PageHead, SkeletonRows, StatusBadge, fieldErrors, useAction, useFetch } from '../components/ui';
import { fmtDate, fmtNum } from '../format';

export default function Organizations() {
  const { chooseOrg } = useAuth();
  const [add, setAdd] = useState(false);
  const q = useFetch(() => api.get('/api/organizations?page_size=100').then((r) => r.data as any[]), []);
  const { busy, run } = useAction();
  return (
    <>
      <PageHead title="Organizations" sub="Every organization is fully isolated from the others." actions={<button className="btn primary" onClick={() => setAdd(true)}>＋ New organization</button>} />
      <div className="card">{q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonRows n={4} /> : !q.data.length ? <Empty icon="🏢" title="No organizations yet" action={<button className="btn primary" onClick={() => setAdd(true)}>Create the first one</button>} /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Organization</th><th>Prefix</th><th>Learners</th><th>Batches</th><th>Created</th><th>Status</th><th /></tr></thead><tbody>
          {q.data.map((o) => <tr key={o.id}><td><b>{o.name}</b><div className="muted small">{o.slug}</div></td><td><Badge>{o.code_prefix}</Badge></td><td>{fmtNum(o.learners)}</td><td>{fmtNum(o.batches)}</td><td className="small">{fmtDate(o.created_at)}</td><td><StatusBadge s={o.status} /></td>
            <td className="right nowrap"><button className="btn sm" onClick={() => { chooseOrg(o.id); location.href = '/'; }}>Open</button>{' '}
              <button className="btn sm" disabled={busy} onClick={() => run(() => api.patch(`/api/organizations/${o.id}/status`, { status: o.status === 'active' ? 'suspended' : 'active' }).then(q.reload), o.status === 'active' ? 'Organization suspended' : 'Organization reactivated')}>{o.status === 'active' ? 'Suspend' : 'Reactivate'}</button></td></tr>)}</tbody></table></div>)}</div>
      {add && <AddOrg onClose={() => setAdd(false)} onDone={() => q.reload()} />}
    </>
  );
}

function AddOrg({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ name: '', slug: '', code_prefix: 'RK', admin_name: '', admin_email: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [pw, setPw] = useState<string | null>(null);
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    try { const r = await api.post('/api/organizations', { name: v.name, slug: v.slug, code_prefix: v.code_prefix, admin: { full_name: v.admin_name, email: v.admin_email } }); setPw(r.data.admin.temporary_password); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title="New organization" onClose={onClose} footer={pw ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="org-f" disabled={busy || !v.name || !v.slug || !v.admin_name || !v.admin_email}>Create</button></>}>
    {pw ? <div className="stack"><p style={{ margin: 0 }}>Organization created. Share the administrator’s sign-in details securely.</p><div className="card card-pad"><div>Email: <b>{v.admin_email}</b></div><div>Temporary password: <b className="mono">{pw}</b></div></div><p className="muted small" style={{ margin: 0 }}>Shown only once.</p></div> : (
      <form id="org-f" onSubmit={submit} className="form-grid" noValidate>
        <Field label="Organization name" error={errs.name} className="full"><input className="input" value={v.name} onChange={set('name')} autoFocus /></Field>
        <Field label="URL name" error={errs.slug} hint="lower-case, e.g. robokalam-chennai"><input className="input" value={v.slug} onChange={(e) => setV({ ...v, slug: e.target.value.toLowerCase() })} /></Field>
        <Field label="ID prefix" error={errs.code_prefix} hint="Used in learner IDs, e.g. RK-LRN-000001"><input className="input" value={v.code_prefix} maxLength={6} onChange={(e) => setV({ ...v, code_prefix: e.target.value.toUpperCase() })} /></Field>
        <Field label="Admin name" error={errs['admin.full_name']}><input className="input" value={v.admin_name} onChange={set('admin_name')} /></Field>
        <Field label="Admin email" error={errs['admin.email']}><input className="input" type="email" value={v.admin_email} onChange={set('admin_email')} /></Field></form>)}</Modal>;
}
