import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../format';
import { Async, Badge, Empty, PageHead, useAction, useFetch } from '../components/ui';

/** Family chat: one conversation per learner between their parents and the school. */
export default function Messages() {
  const { id } = useParams(); const nav = useNavigate(); const { can } = useAuth();
  const list = useFetch(() => api.get('/api/chat/threads').then((r) => r.data as any[]), []);
  useEffect(() => { const t = setInterval(list.reload, 15000); return () => clearInterval(t); }, [list.reload]);
  const open = async (row: any) => { if (row.thread_id) return nav(`/messages/${row.thread_id}`); const t = (await api.post('/api/chat/threads', { learner_id: row.learner_id })).data; list.reload(); nav(`/messages/${t.id}`); };
  return (
    <>
      <PageHead title="Messages" sub="A private conversation between a child's family and their teachers. Be kind and keep it about learning. The school can see these conversations." />
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
        <div className="card" style={{ width: 300, flex: 'none', maxWidth: '100%' }}>
          <Async q={list}>{(rows: any[]) => !rows.length ? <Empty icon="💬" title="No conversations yet">A parent can start one from here, and it shows up for the teachers.</Empty> : <>{rows.map((r) => (
            <button key={r.learner_id} className="m-card" style={{ width: '100%', textAlign: 'left', border: 0, cursor: 'pointer', background: r.thread_id && r.thread_id === id ? 'var(--bg-soft, #eef3f9)' : 'none' }} onClick={() => open(r)}>
              <div className="grow"><b>{r.learner_name}</b>{r.status === 'closed' && <> <Badge>Closed</Badge></>}<div className="muted small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 190 }}>{r.last_body ?? 'Start a conversation'}</div></div>
              {r.unread > 0 && <Badge tone="bad">{r.unread}</Badge>}
            </button>))}</>}</Async>
        </div>
        <div className="grow" style={{ minWidth: 280 }}>{id ? <Thread key={id} id={id} moderator={can('chat:moderate')} onChange={list.reload} /> : <div className="card"><Empty icon="💬" title="Pick a conversation" /></div>}</div>
      </div>
    </>
  );
}

function Thread({ id, moderator, onChange }: { id: string; moderator: boolean; onChange: () => void }) {
  const q = useFetch(() => api.get(`/api/chat/threads/${id}/messages`).then((r) => r.data as any), [id]); const [body, setBody] = useState(''); const { busy, run } = useAction(); const end = useRef<HTMLDivElement>(null);
  useEffect(() => { api.post(`/api/chat/threads/${id}/read`).then(onChange).catch(() => undefined); const t = setInterval(q.reload, 10000); return () => clearInterval(t); }, [id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [q.data?.messages?.length]);
  const send = () => run(async () => { await api.post(`/api/chat/threads/${id}/messages`, { body }); setBody(''); q.reload(); onChange(); });
  return (
    <Async q={q}>{(d: any) => (
      <div className="card" style={{ display: 'flex', flexDirection: 'column', minHeight: 420 }}>
        <div className="card-head"><h2>About {d.thread.learner_name}</h2>{moderator && <button className="btn sm" onClick={() => run(async () => { await api.post(`/api/chat/threads/${id}/status`, { status: d.thread.status === 'open' ? 'closed' : 'open' }); q.reload(); onChange(); })}>{d.thread.status === 'open' ? 'Close conversation' : 'Reopen'}</button>}</div>
        <div className="stack-s" style={{ padding: 14, flex: 1, maxHeight: 460, overflowY: 'auto' }}>
          {!d.messages.length && <div className="muted small">No messages yet. Say hello 👋</div>}
          {d.messages.map((m: any) => (
            <div key={m.id} style={{ alignSelf: m.mine ? 'flex-end' : 'flex-start', maxWidth: '82%' }}>
              <div className="muted" style={{ fontSize: 11, textAlign: m.mine ? 'right' : 'left' }}>{m.mine ? 'You' : m.sender_name}{m.role === 'staff' && !m.mine ? ' · school' : ''} · {fmtDateTime(m.created_at)}</div>
              <div style={{ background: m.hidden ? 'transparent' : m.mine ? 'var(--brand, #12263f)' : 'var(--bg-soft, #eef3f9)', color: m.mine && !m.hidden ? '#fff' : 'inherit', border: m.hidden ? '1px dashed var(--line, #ccd)' : 0, padding: '8px 12px', borderRadius: 14, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontStyle: m.hidden ? 'italic' : 'normal' }}>{m.hidden ? 'This message was removed.' : m.body}</div>
              {m.can_hide && !m.hidden && <button className="btn ghost sm" style={{ fontSize: 11 }} onClick={() => confirm('Remove this message for everyone?') && run(async () => { await api.post(`/api/chat/messages/${m.id}/hide`); q.reload(); })}>{m.mine ? 'Take back' : 'Remove'}</button>}
            </div>))}<div ref={end} />
        </div>
        {d.thread.status === 'closed' ? <div className="card-pad muted small">This conversation was closed by the school.</div> : (
          <form className="row" style={{ padding: 12, borderTop: '1px solid var(--line, #e3e8ef)' }} onSubmit={(e) => { e.preventDefault(); if (body.trim()) send(); }}>
            <textarea className="input grow" rows={2} maxLength={2000} placeholder="Write a message…" aria-label="Message" value={body} onChange={(e) => setBody(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && body.trim()) { e.preventDefault(); send(); } }} />
            <button className="btn primary" disabled={busy || !body.trim()}>Send</button></form>)}
      </div>)}</Async>
  );
}
