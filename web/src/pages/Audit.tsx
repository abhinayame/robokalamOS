import { useState } from 'react';
import { api, qs } from '../api';
import { Async, Empty, PageHead, Pager, useFetch } from '../components/ui';
import { fmtDateTime } from '../format';

export default function Audit() {
  const [page, setPage] = useState(1);
  const [action, setAction] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const q = useFetch(() => api.get(`/api/audit${qs({ page, page_size: 30, action })}`), [page, action]);
  return (
    <>
      <PageHead title="Audit log" sub="Who did what, and what changed. Entries cannot be edited." />
      <div className="card">
        <div className="row" style={{ padding: 12 }}><select className="select" style={{ maxWidth: 280 }} value={action} onChange={(e) => { setAction(e.target.value); setPage(1); }} aria-label="Filter by action">
          <option value="">All activity</option><option value="auth.">Sign-ins</option><option value="learner.">Learners</option><option value="batch.">Batches</option><option value="permission.">Permission changes</option><option value="user.">Users</option><option value="organization.">Organization</option></select></div>
        <Async q={q}>{(r: any) => !r.data.length ? <Empty icon="🧾" title="Nothing recorded yet" /> : (
          <>
            <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th /></tr></thead><tbody>
              {r.data.map((a: any) => <>
                <tr key={a.id}><td className="small nowrap">{fmtDateTime(a.created_at)}</td><td>{a.actor_email ?? 'System'}</td><td className="mono">{a.action}</td><td className="small">{a.entity_type}{a.entity_id ? <span className="muted mono"> {String(a.entity_id).slice(0, 8)}</span> : ''}</td>
                  <td className="right">{(a.previous_data || a.new_data) && <button className="btn sm ghost" onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Hide' : 'Details'}</button>}</td></tr>
                {open === a.id && <tr key={`${a.id}d`}><td colSpan={5}><div className="grid cols-2"><div><b className="small">Before</b><pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(a.previous_data, null, 2) ?? '—'}</pre></div><div><b className="small">After</b><pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{JSON.stringify(a.new_data, null, 2) ?? '—'}</pre></div></div></td></tr>}</>)}</tbody></table></div>
            <Pager meta={r.meta} onPage={setPage} />
          </>)}</Async>
      </div>
    </>
  );
}
