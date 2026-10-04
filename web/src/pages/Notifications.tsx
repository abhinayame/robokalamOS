import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDateTime } from '../format';
import { Async, Badge, Empty, PageHead, useAction, useFetch } from '../components/ui';

const ICON: Record<string, string> = { 'attendance.absent': '🚫', 'class.cancelled': '❌', 'assignment.posted': '📝', 'assignment.evaluated': '✅', 'assignment.returned': '↩️', 'score.received': '📊', 'badge.awarded': '🏅' };

export default function Notifications() {
  const nav = useNavigate();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const q = useFetch(() => api.get(`/api/notifications${qs({ unread: unreadOnly ? 1 : undefined, page })}`), [unreadOnly, page]);
  const { busy, run } = useAction();
  const ping = () => window.dispatchEvent(new Event('rk:notifications'));
  const open = async (n: any) => { if (!n.read_at) { await api.post(`/api/notifications/${n.id}/read`).catch(() => {}); ping(); } if (n.link) nav(n.link); else q.reload(); };
  return (
    <>
      <PageHead title="Notifications" sub="Updates about you and your children." actions={<>
        <label className="row small"><input type="checkbox" checked={unreadOnly} onChange={(e) => { setUnreadOnly(e.target.checked); setPage(1); }} /> Unread only</label>
        <button className="btn sm" disabled={busy || !q.data?.meta?.unread} onClick={() => run(async () => { await api.post('/api/notifications/read-all'); ping(); q.reload(); }, 'All marked as read')}>Mark all read</button></>} />
      <Async q={q as any}>{(d: any) => d.data.length ? (
        <div className="card">{d.data.map((n: any) => (
          <button key={n.id} className="m-card" style={{ width: '100%', textAlign: 'left', background: n.read_at ? undefined : 'var(--info-soft)', border: 0, borderBottom: '1px solid var(--line)', cursor: 'pointer', alignItems: 'center' }} onClick={() => open(n)}>
            <span aria-hidden style={{ fontSize: 22 }}>{ICON[n.kind] ?? '🔔'}</span>
            <div className="grow"><b>{n.title}</b>{n.learner_name && <> <Badge>{n.learner_name}</Badge></>}{n.body && <div className="small">{n.body}</div>}<div className="muted small">{fmtDateTime(n.created_at)}</div></div>
            {!n.read_at && <Badge tone="info">New</Badge>}
          </button>))}
          {d.meta.total > page * d.meta.page_size && <div className="m-card"><button className="btn sm" onClick={() => setPage(page + 1)}>Older</button></div>}
          {page > 1 && <div className="m-card"><button className="btn ghost sm" onClick={() => setPage(page - 1)}>Newer</button></div>}
        </div>) : <div className="card"><Empty icon="🔔" title={unreadOnly ? 'You are all caught up' : 'No notifications yet'}>Absences, new assignments, scores, badges and cancelled classes will show up here.</Empty></div>}</Async>
    </>
  );
}
