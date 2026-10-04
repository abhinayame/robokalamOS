import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Avatar, Badge, Empty, ErrorState, PageHead, Pager, SkeletonRows, useDebounced, useFetch } from '../components/ui';
import { fmtMobile } from '../format';

export default function Parents() {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [dq]);
  const list = useFetch(() => api.get(`/api/parents${qs({ q: dq, page, page_size: 25 })}`), [dq, page]);
  const rows: any[] = list.data?.data ?? [];
  return (
    <>
      <PageHead title="Parents" sub="Parents are shared across siblings — one record per parent mobile." />
      <div className="card">
        <div className="row" style={{ padding: 12 }}><input className="input" placeholder="Search name, mobile or email…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search parents" /></div>
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonRows /> : !rows.length ? <Empty icon="🧑‍🧒" title={dq ? 'No parents match' : 'No parents yet'}>Parents are added from a learner’s profile.</Empty> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Parent</th><th>Mobile</th><th>Email</th><th>Children</th><th>Login</th></tr></thead><tbody>
            {rows.map((p) => <tr key={p.id}><td><div className="row"><Avatar name={p.full_name} /><b>{p.full_name}</b></div></td><td>{fmtMobile(p.mobile)}</td><td>{p.email ?? '—'}</td>
              <td><div className="chips">{p.children.map((c: any) => <Link key={c.id} to={`/learners/${c.id}`}><Badge>{c.full_name}</Badge></Link>)}</div></td><td>{p.has_login ? <Badge tone="ok">Yes</Badge> : <span className="muted">No</span>}</td></tr>)}</tbody></table></div>)}
        {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
      </div>
    </>
  );
}
