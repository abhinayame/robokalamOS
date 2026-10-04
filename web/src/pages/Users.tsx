import { useEffect, useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Avatar, Badge, Empty, ErrorState, Field, Modal, PageHead, Pager, SkeletonRows, StatusBadge, fieldErrors, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { cap, fmtDateTime } from '../format';

const ROLES = [['org_admin', 'Organization admin'], ['branch_admin', 'Branch admin'], ['teacher', 'Teacher'], ['counsellor', 'Counsellor'], ['accountant', 'Accountant']];

export default function Users() {
  const { me } = useAuth();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(false);
  const [roles, setRoles] = useState<any>(null);
  useEffect(() => setPage(1), [dq]);
  const list = useFetch(() => api.get(`/api/users${qs({ q: dq, page, page_size: 25 })}`), [dq, page]);
  const toast = useToast();
  const { busy, run } = useAction();
  const rows: any[] = list.data?.data ?? [];
  const [pw, setPw] = useState<{ email: string; pw: string } | null>(null);
  return (
    <>
      <PageHead title="Staff & roles" sub="Who can do what. Role changes are recorded in the audit log." actions={<button className="btn primary" onClick={() => setAdd(true)}>＋ Add staff</button>} />
      <div className="card">
        <div className="row" style={{ padding: 12 }}><input className="input" placeholder="Search staff…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search staff" /></div>
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonRows /> : !rows.length ? <Empty title="No staff found" /> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Name</th><th>Email</th><th>Roles</th><th>Last sign-in</th><th>Status</th><th /></tr></thead><tbody>
            {rows.map((u) => <tr key={u.id}><td><div className="row"><Avatar name={u.full_name} /><b>{u.full_name}</b></div></td><td>{u.email}</td>
              <td><div className="chips">{u.roles.map((r: any, i: number) => <Badge key={i} tone="info">{cap(r.role)}</Badge>)}</div></td><td className="small">{fmtDateTime(u.last_login_at)}</td><td><StatusBadge s={u.status} /></td>
              <td className="right nowrap">{u.id !== me?.id && <><button className="btn sm" onClick={() => setRoles(u)}>Roles</button>{' '}
                <button className="btn sm" disabled={busy} onClick={() => confirm(`Reset password for ${u.full_name}? They will be signed out everywhere.`) && run(async () => { const r = await api.post(`/api/users/${u.id}/reset-password`); setPw({ email: u.email, pw: r.data.temporary_password }); })}>Reset password</button>{' '}
                <button className="btn sm danger" disabled={busy} onClick={() => run(() => api.patch(`/api/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }).then(list.reload), u.status === 'active' ? 'User disabled' : 'User enabled')}>{u.status === 'active' ? 'Disable' : 'Enable'}</button></>}</td></tr>)}</tbody></table></div>)}
        {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
      </div>
      {add && <AddUser onClose={() => setAdd(false)} onDone={(p) => { setAdd(false); list.reload(); setPw(p); }} />}
      {roles && <RolesModal user={roles} onClose={() => setRoles(null)} onDone={() => { setRoles(null); list.reload(); toast('Roles updated'); }} />}
      {pw && <Modal title="Temporary password" onClose={() => setPw(null)} footer={<button className="btn primary" onClick={() => setPw(null)}>Done</button>}><div className="card card-pad"><div>Email: <b>{pw.email}</b></div><div>Temporary password: <b className="mono">{pw.pw}</b></div></div><p className="muted small">Shown only once. They must change it at next sign-in.</p></Modal>}
    </>
  );
}

function BranchRoles({ value, onChange }: { value: { role: string; branch_id?: string | null }[]; onChange: (v: { role: string; branch_id?: string | null }[]) => void }) {
  const branches = useFetch(() => api.get('/api/branches').then((r) => r.data as any[]), []);
  const has = (r: string) => value.find((x) => x.role === r);
  return <div className="stack-s">{ROLES.map(([r, label]) => (
    <div key={r} className="row"><label className="row gap-s grow"><input type="checkbox" checked={!!has(r)} onChange={() => onChange(has(r) ? value.filter((x) => x.role !== r) : [...value, { role: r, branch_id: null }])} /> {label}</label>
      {has(r) && ['branch_admin', 'counsellor', 'accountant'].includes(r) && <select className="select" style={{ width: 180 }} value={has(r)!.branch_id ?? ''} onChange={(e) => onChange(value.map((x) => x.role === r ? { ...x, branch_id: e.target.value || null } : x))} aria-label={`${label} branch`}><option value="">{r === 'branch_admin' ? 'Choose branch…' : 'Whole organization'}</option>{(branches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>}</div>))}</div>;
}

function RolesModal({ user, onClose, onDone }: { user: any; onClose: () => void; onDone: () => void }) {
  const [roles, setRoles] = useState<any[]>(user.roles.filter((r: any) => ROLES.some(([k]) => k === r.role)));
  const { busy, run } = useAction();
  const invalid = !roles.length || roles.some((r) => r.role === 'branch_admin' && !r.branch_id);
  return <Modal title={`Roles — ${user.full_name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || invalid} onClick={async () => { const r = await run(() => api.put(`/api/users/${user.id}/roles`, { roles })); if (r) onDone(); }}>Save roles</button></>}><BranchRoles value={roles} onChange={setRoles} /></Modal>;
}

function AddUser({ onClose, onDone }: { onClose: () => void; onDone: (p: { email: string; pw: string }) => void }) {
  const [v, setV] = useState({ full_name: '', email: '' });
  const [roles, setRoles] = useState<any[]>([{ role: 'teacher', branch_id: null }]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    try { const r = await api.post('/api/users', { ...v, roles }); onDone({ email: v.email, pw: r.data.temporary_password }); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title="Add staff member" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-u" disabled={busy || v.full_name.length < 2 || !v.email || !roles.length || roles.some((r) => r.role === 'branch_admin' && !r.branch_id)}>Add</button></>}>
    <form id="add-u" onSubmit={submit} className="stack" noValidate><Field label="Full name" error={errs.full_name}><input className="input" value={v.full_name} onChange={(e) => setV({ ...v, full_name: e.target.value })} autoFocus /></Field>
      <Field label="Email" error={errs.email}><input className="input" type="email" value={v.email} onChange={(e) => setV({ ...v, email: e.target.value })} /></Field>
      <Field label="Roles"><BranchRoles value={roles} onChange={setRoles} /></Field></form></Modal>;
}
