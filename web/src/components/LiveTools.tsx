import { useEffect, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../format';
import { Async, Badge, Empty, Field, Modal, useAction, useFetch, useToast } from './ui';

/** The classroom's "Live" tab: polls for everyone, plus the QR check-in screen for the teacher. */
export default function LiveTools({ room }: { room: any }) {
  const { hasRole } = useAuth(); const isLearner = hasRole('learner');
  return (
    <div className="stack">
      {room.can_manage && room.writable && <CheckinPanel room={room} />}
      <Polls room={room} isLearner={isLearner} />
    </div>
  );
}

function CheckinPanel({ room }: { room: any }) {
  const sessions = useFetch(() => api.get(`/api/classrooms/${room.id}/sessions`).then((r) => r.data as any[]), [room.id]); const [sid, setSid] = useState(''); const [show, setShow] = useState(false);
  const { busy, run } = useAction();
  const open = (id: string) => run(async () => { await api.post(`/api/checkin/sessions/${id}/open`, { minutes: 20 }); setSid(id); setShow(true); }, 'Check-in is open for 20 minutes.');
  const soon = (sessions.data ?? []).filter((s) => s.status !== 'cancelled').sort((a, b) => Math.abs(+new Date(a.starts_at) - Date.now()) - Math.abs(+new Date(b.starts_at) - Date.now())).slice(0, 4);
  return (
    <div className="card"><div className="card-head"><h2>QR check-in</h2></div>
      <div className="card-pad stack">
        <p className="muted small" style={{ margin: 0 }}>Show the code on the classroom screen. Learners scan it with their phone camera, sign in, and are marked present. The code changes every 30 seconds, so a photo of it will not work later. A mark you make by hand always wins.</p>
        <Async q={sessions as any} rows={2}>{() => !soon.length ? <Empty icon="📅" title="No classes scheduled">Schedule a class under Attendance first.</Empty> : (
          <div className="stack-s">{soon.map((s) => <div key={s.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{s.title || 'Class'}</b><div className="muted small">{fmtDateTime(s.starts_at)} · {s.status}</div></div>
            <button className="btn sm primary" disabled={busy} onClick={() => open(s.id)}>Open check-in</button></div>)}</div>)}</Async>
      </div>
      {show && <CodeScreen sessionId={sid} onClose={() => setShow(false)} />}
    </div>
  );
}

function CodeScreen({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null); const toast = useToast();
  useEffect(() => {
    let dead = false; let t: any;
    const tick = async () => { try { const r = (await api.get(`/api/checkin/sessions/${sessionId}/code`)).data; if (!dead) { setD(r); t = setTimeout(tick, r.open ? Math.min(8000, Math.max(2000, (r.expires_in ?? 5) * 1000 - 1000)) : 5000); } } catch { if (!dead) t = setTimeout(tick, 8000); } };
    tick(); return () => { dead = true; clearTimeout(t); };
  }, [sessionId]);
  return (
    <Modal wide title="Scan to check in" onClose={onClose} footer={<><button className="btn" onClick={async () => { await api.post(`/api/checkin/sessions/${sessionId}/close`); toast('Check-in closed.'); onClose(); }}>Close check-in</button><button className="btn primary" onClick={onClose}>Hide</button></>}>
      <div style={{ textAlign: 'center' }}>
        {d?.open ? <><img src={d.qr} alt="Check-in QR code" style={{ width: 'min(360px, 80vw)', background: '#fff', padding: 8, borderRadius: 12 }} />
          <div style={{ fontSize: 28, fontWeight: 800, marginTop: 8 }}>{d.checked_in} checked in</div><div className="muted small">The code refreshes by itself. Keep this window open.</div></>
          : d ? <Empty icon="🔒" title="Check-in is closed">{d.checked_in} learner{d.checked_in === 1 ? '' : 's'} checked in.</Empty> : <div className="skeleton" style={{ height: 360 }} />}
      </div>
    </Modal>
  );
}

function Polls({ room, isLearner }: { room: any; isLearner: boolean }) {
  const q = useFetch(() => api.get(`/api/polls?batch_id=${room.id}`).then((r) => r.data as any[]), [room.id]); const [add, setAdd] = useState(false); const { busy, run } = useAction();
  useEffect(() => { const t = setInterval(q.reload, 10000); return () => clearInterval(t); }, [q.reload]);
  return (
    <div className="card"><div className="card-head"><h2>Polls</h2>{room.can_manage && room.writable && <button className="btn primary sm" onClick={() => setAdd(true)}>＋ Ask a question</button>}</div>
      <Async q={q}>{(list: any[]) => !list.length ? <Empty icon="📊" title="No polls yet">{room.can_manage ? 'Ask the class a quick question and watch the answers come in.' : 'Your teacher can ask the class a question here.'}</Empty> : (
        <div className="stack" style={{ padding: 14 }}>{list.map((p) => (
          <div key={p.id} className="card card-pad stack-s">
            <div className="row between"><b>{p.question}</b><Badge tone={p.status === 'open' ? 'ok' : ''}>{p.status === 'open' ? 'Open' : 'Closed'}</Badge></div>
            {p.options.map((o: string, i: number) => {
              const n = p.counts?.[i]; const pct = p.counts && p.total ? Math.round((n / p.total) * 100) : 0; const mine = p.my_choice === i;
              return p.counts ? (
                <div key={i}><div className="row between small"><span>{mine && '✔ '}{o}</span><span className="muted">{n} · {pct}%</span></div><div className="progress"><div style={{ width: `${pct}%` }} /></div></div>
              ) : <button key={i} className="btn" style={{ justifyContent: 'flex-start' }} disabled={busy || !isLearner || p.status !== 'open'} onClick={() => run(async () => { await api.post(`/api/polls/${p.id}/vote`, { choice: i }); q.reload(); }, 'Answer sent.')}>{o}</button>;
            })}
            <div className="row between small muted"><span>{p.total} answer{p.total === 1 ? '' : 's'} · answers are anonymous</span>
              {room.can_manage && p.status === 'open' && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api.post(`/api/polls/${p.id}/close`); q.reload(); }, 'Poll closed.')}>Close poll</button>}</div>
          </div>))}</div>)}</Async>
      {add && <PollModal room={room} onClose={() => setAdd(false)} onDone={q.reload} />}
    </div>
  );
}

function PollModal({ room, onClose, onDone }: { room: any; onClose: () => void; onDone: () => void }) {
  const [question, setQ] = useState(''); const [opts, setOpts] = useState(['', '']); const { busy, run } = useAction(); const ok = question.trim().length >= 3 && opts.filter((o) => o.trim()).length >= 2;
  return (
    <Modal title="Ask the class" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ok} onClick={() => run(async () => { await api.post('/api/polls', { batch_id: room.id, question, options: opts.map((o) => o.trim()).filter(Boolean) }); onDone(); onClose(); }, 'Poll sent to the class.')}>Send</button></>}>
      <div className="stack"><Field label="Question"><input className="input" value={question} onChange={(e) => setQ(e.target.value)} autoFocus /></Field>
        {opts.map((o, i) => <Field key={i} label={`Option ${i + 1}`}><input className="input" value={o} onChange={(e) => setOpts(opts.map((x, j) => (j === i ? e.target.value : x)))} /></Field>)}
        {opts.length < 6 && <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setOpts([...opts, ''])}>＋ Option</button>}
        <p className="muted small" style={{ margin: 0 }}>Learners are notified. Answers are anonymous; you only see counts.</p></div>
    </Modal>
  );
}
