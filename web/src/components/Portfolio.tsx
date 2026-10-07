import { useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, Empty, Field, Modal, useAction, useFetch, useToast } from './ui';
import { fmtDate } from './../format';

const TONE: Record<string, string> = { pending: 'warn', published: 'ok', rejected: 'bad' };
const LABEL: Record<string, string> = { pending: 'Waiting for a teacher', published: 'Published', rejected: 'Needs a change' };

/** A learner's projects. Parents see only what a teacher has published; the learner also sees their own pending and rejected ones. */
export function PortfolioGrid({ learnerId, canAdd, learners }: { learnerId: string; canAdd?: boolean; learners?: never }) {
  void learners; const { can, hasRole } = useAuth(); const toast = useToast(); const { busy, run } = useAction();
  const q = useFetch(() => api.get(`/api/portfolio/learners/${learnerId}`).then((r) => r.data as any[]), [learnerId]);
  const [add, setAdd] = useState(false); const reviewer = can('portfolio:review'); const mine = hasRole('learner');
  return (
    <div className="stack">
      {(canAdd ?? (mine || reviewer)) && <div><button className="btn primary" onClick={() => setAdd(true)}>＋ Add a project</button></div>}
      <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="🤖" title="No projects yet">{mine ? 'Add a photo or video of something you built. A teacher checks it before your family can see it.' : 'Projects appear here once a teacher has published them.'}</Empty></div> : (
        <div className="portfolio-grid">{list.map((it) => (
          <div className="card portfolio-card" key={it.id}>
            {it.files[0] && /^image\//.test(it.files[0].mime) ? <img src={`/api/files/${it.files[0].id}?inline=1`} alt={it.title} loading="lazy" /> : <div className="portfolio-ph">🤖</div>}
            <div className="card-pad stack-s">
              <div className="row between"><b>{it.title}</b><Badge tone={TONE[it.status]}>{LABEL[it.status]}</Badge></div>
              {it.description && <div className="small">{it.description}</div>}
              <div className="muted small">{fmtDate(it.created_at)}{it.batch_name ? ` · ${it.batch_name}` : ''}</div>
              {it.files.slice(1).length > 0 && <div className="row gap-s wrap">{it.files.slice(1).map((f: any) => /^image\//.test(f.mime) ? <a key={f.id} href={`/api/files/${f.id}?inline=1`} target="_blank" rel="noreferrer noopener"><img className="portfolio-thumb" src={`/api/files/${f.id}?inline=1`} alt="" loading="lazy" /></a> : <button key={f.id} className="btn sm" onClick={() => api.openFile(f.id, f.name, true)}>{f.name}</button>)}</div>}
              {it.video_url && <a href={it.video_url} target="_blank" rel="noreferrer noopener">▶ Watch the video</a>}
              {it.status === 'rejected' && it.reject_reason && <p className="err small" style={{ margin: 0 }}>{it.reject_reason}</p>}
              {it.feedback && <p className="small" style={{ margin: 0, padding: 8, background: 'var(--bg-soft, #f3f6fa)', borderRadius: 8 }}><b>{it.feedback_by_name ?? 'Teacher'}:</b> {it.feedback}</p>}
              <div className="row gap-s wrap">
                {reviewer && <button className="btn sm" disabled={busy} onClick={() => { const f = prompt('Your comment for the learner', it.feedback ?? ''); if (f !== null) run(async () => { await api.put(`/api/portfolio/${it.id}/feedback`, { feedback: f }); q.reload(); }, 'Comment saved.'); }}>Comment</button>}
                {(reviewer || (mine && true)) && <button className="btn sm" disabled={busy} onClick={() => { if (confirm(`Remove “${it.title}”?`)) run(async () => { await api.del(`/api/portfolio/${it.id}`); q.reload(); }, 'Project removed.'); }}>Remove</button>}
              </div>
            </div>
          </div>))}</div>)}</Async>
      {add && <AddModal learnerId={learnerId} onClose={() => setAdd(false)} onDone={() => { q.reload(); toast(reviewer ? 'Project published.' : 'Sent to your teacher for a quick check.'); }} />}
    </div>
  );
}

function AddModal({ learnerId, onClose, onDone }: { learnerId: string; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ title: '', description: '', video_url: '' }); const [files, setFiles] = useState<{ id: string; name: string }[]>([]); const [err, setErr] = useState('');
  const { busy, run } = useAction(); const pick = useRef<HTMLInputElement>(null);
  const valid = f.title.trim().length >= 2 && (files.length > 0 || f.video_url.trim());
  return (
    <Modal wide title="Add a project" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !valid} onClick={() => run(async () => {
      setErr(''); try { await api.post('/api/portfolio', { learner_id: learnerId, title: f.title, description: f.description || null, video_url: f.video_url || null, file_ids: files.map((x) => x.id) }); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } })}>{busy ? 'Saving…' : 'Add project'}</button></>}>
      <div className="stack">
        <Field label="Project name"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus placeholder="My line-follower robot" /></Field>
        <Field label="What is it? (optional)"><textarea className="input" rows={3} maxLength={1000} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Photos" hint="Up to 6 pictures (JPG, PNG, GIF, WebP) or a PDF."><div className="stack-s">
          {files.map((x) => <div key={x.id} className="row between"><span className="small">{x.name}</span><button className="btn sm ghost" onClick={() => setFiles(files.filter((y) => y.id !== x.id))} aria-label={`Remove ${x.name}`}>✕</button></div>)}
          {files.length < 6 && <><input ref={pick} type="file" accept="image/*,application/pdf" aria-label="Add a photo" onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) run(async () => { const up = await api.upload(file); setFiles((p) => [...p, { id: up.id, name: up.name }]); }); }} /></>}
        </div></Field>
        <Field label="Or a video link (optional)" hint="A link starting with https://, such as YouTube or Google Drive."><input className="input" value={f.video_url} onChange={(e) => setF({ ...f, video_url: e.target.value })} placeholder="https://…" /></Field>
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

export function ReviewQueue() {
  const q = useFetch(() => api.get('/api/portfolio/review').then((r) => r.data as any[]), []); const { busy, run } = useAction();
  return (
    <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="✅" title="Nothing waiting">New projects from learners show up here for a quick check.</Empty></div> : (
      <div className="portfolio-grid">{list.map((it) => (
        <div className="card portfolio-card" key={it.id}>
          {it.files[0] && /^image\//.test(it.files[0].mime) ? <img src={`/api/files/${it.files[0].id}?inline=1`} alt={it.title} loading="lazy" /> : <div className="portfolio-ph">🤖</div>}
          <div className="card-pad stack-s"><b>{it.title}</b><div className="muted small">{it.learner_name}{it.batch_name ? ` · ${it.batch_name}` : ''} · {fmtDate(it.created_at)}</div>
            {it.description && <div className="small">{it.description}</div>}{it.video_url && <a href={it.video_url} target="_blank" rel="noreferrer noopener">▶ Video link</a>}
            <div className="row gap-s"><button className="btn sm primary" disabled={busy} onClick={() => run(async () => { await api.post(`/api/portfolio/${it.id}/review`, { decision: 'approve' }); q.reload(); }, 'Published.')}>Approve</button>
              <button className="btn sm" disabled={busy} onClick={() => { const reason = prompt('What should the learner change?'); if (reason && reason.trim()) run(async () => { await api.post(`/api/portfolio/${it.id}/review`, { decision: 'reject', reason }); q.reload(); }, 'Sent back to the learner.'); }}>Ask for a change</button></div></div>
        </div>))}</div>)}</Async>
  );
}
