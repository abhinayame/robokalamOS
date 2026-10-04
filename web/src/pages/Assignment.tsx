import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, friendly, qs } from '../api';
import { cap, fmtDateTime } from '../format';
import { FileLinks, FilePicker, type FileRef } from '../components/Files';
import { Async, Badge, Empty, Field, Modal, PageHead, Stat, fieldErrors, useAction, useFetch } from '../components/ui';

const TONE: Record<string, string> = { upcoming: '', due: 'warn', completed: 'ok', late: 'bad', returned: 'warn', submitted: 'info', evaluated: 'ok', not_submitted: '' };

export default function Assignment() {
  const { id } = useParams();
  const q = useFetch(() => api.get(`/api/assignments/${id}`).then((r) => r.data), [id]);
  return (
    <Async q={q}>{(a: any) => (
      <>
        <PageHead title={a.title} sub={<>{a.batch_name} · {a.due_at ? `Due ${fmtDateTime(a.due_at)}` : 'No due date'} · {a.max_marks} marks</>}
          actions={<><Link className="btn sm" to={`/classroom/${a.batch_id}`}>Back to classroom</Link>{a.state && <Badge tone={TONE[a.state]}>{cap(a.state)}</Badge>}</>} />
        <div className="grid cols-2" style={{ alignItems: 'start' }}>
          <div className="card card-pad stack">
            {a.description && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{a.description}</p>}
            {a.instructions && <div><b>Instructions</b><p style={{ whiteSpace: 'pre-wrap', margin: '4px 0 0' }}>{a.instructions}</p></div>}
            {!a.description && !a.instructions && <span className="muted">No extra instructions.</span>}
            <FileLinks files={a.files} />
            {a.allow_resubmit && <span className="muted small">Resubmitting is allowed until it is evaluated.</span>}
          </div>
          {a.can_manage ? <TeacherPanel a={a} onChange={q.reload} /> : <LearnerPanel a={a} onChange={q.reload} />}
        </div>
      </>
    )}</Async>
  );
}

/* ------------------------------------------------------------------ learner */
function LearnerPanel({ a, onChange }: { a: any; onChange: () => void }) {
  const s = a.submission;
  const [body, setBody] = useState(s?.body ?? '');
  const [link, setLink] = useState(s?.link_url ?? '');
  const [files, setFiles] = useState<FileRef[]>(s?.files ?? []);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  useEffect(() => { setBody(s?.body ?? ''); setLink(s?.link_url ?? ''); setFiles(s?.files ?? []); }, [s?.id, s?.version, s?.status]); // eslint-disable-line
  const send = (submit: boolean) => { setErrs({}); return run(async () => {
    try { await api.put(`/api/assignments/${a.id}/submission`, { body: body || null, link_url: link || null, file_ids: files.map((f) => f.id), submit }); onChange(); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }, submit ? 'Submitted' : 'Draft saved').catch(() => {}); };

  if (!a.can_submit) return (
    <div className="card card-pad stack">
      <h2 style={{ margin: 0 }}>Your work</h2>
      {s && s.status !== 'draft' ? <>
        <div className="row wrap"><Badge tone={TONE[s.status]}>{cap(s.status)}</Badge>{s.score != null && <b>Score {s.score}/{a.max_marks}</b>}{s.submitted_at && <span className="muted small">Submitted {fmtDateTime(s.submitted_at)}</span>}</div>
        {s.body && <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.body}</p>}
        {s.link_url && <a href={s.link_url} target="_blank" rel="noopener noreferrer nofollow">{s.link_url}</a>}
        <FileLinks files={s.files} />
        {s.feedback && <div className="banner"><div><b>Teacher feedback</b><div style={{ whiteSpace: 'pre-wrap' }}>{s.feedback}</div></div></div>}
      </> : <Empty icon="🔒" title="Nothing submitted">{a.writable ? 'Only the learner can submit this work.' : 'This batch is closed, so submissions are no longer accepted.'}</Empty>}
    </div>
  );
  return (
    <div className="card card-pad stack">
      <h2 style={{ margin: 0 }}>Your work</h2>
      {s?.status === 'returned' && <div className="banner"><div><b>Returned for changes</b><div style={{ whiteSpace: 'pre-wrap' }}>{s.feedback}</div></div></div>}
      {s?.status && s.status !== 'draft' && s.status !== 'returned' && <div className="muted small">Submitted {fmtDateTime(s.submitted_at)} · you can update and resubmit.</div>}
      <Field label="Your answer" error={errs.body}><textarea className="textarea" value={body} onChange={(e) => setBody(e.target.value)} /></Field>
      <Field label="Link (optional)" error={errs.link_url}><input className="input" placeholder="https://" value={link} onChange={(e) => setLink(e.target.value)} /></Field>
      <Field label="Files"><FilePicker value={files} onChange={setFiles} max={5} /></Field>
      <div className="row wrap"><button className="btn" disabled={busy} onClick={() => send(false)}>Save draft</button><button className="btn primary" disabled={busy} onClick={() => send(true)}>{busy ? 'Working…' : s && s.status !== 'draft' ? 'Resubmit' : 'Submit'}</button></div>
      {a.due_at && new Date(a.due_at) < new Date() && <span className="muted small">This is past the due date; it will be marked late.</span>}
    </div>
  );
}

/* ------------------------------------------------------------------ teacher */
function TeacherPanel({ a, onChange }: { a: any; onChange: () => void }) {
  const [filter, setFilter] = useState('');
  const [search, setSearch] = useState('');
  const q = useFetch(() => api.get(`/api/assignments/${a.id}/submissions${qs({ status: filter, search })}`).then((r) => r.data), [a.id, filter, search]);
  const [review, setReview] = useState<string | null>(null);
  return (
    <div className="stack">
      <div className="grid cols-3"><Stat label="Learners" value={a.stats.members} /><Stat label="Handed in" value={a.stats.handed_in} /><Stat label="To review" value={a.stats.to_review} /></div>
      <div className="card">
        <div className="card-head"><h2>Submissions</h2>
          <div className="row wrap"><input className="input" style={{ width: 160 }} placeholder="Search learner" value={search} onChange={(e) => setSearch(e.target.value)} />
            <select className="select" style={{ width: 150 }} aria-label="Filter" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All</option><option value="to_review">To review</option><option value="not_submitted">Not submitted</option><option value="evaluated">Evaluated</option><option value="returned">Returned</option><option value="late">Late</option></select></div></div>
        <Async q={q}>{(rows: any[]) => rows.length ? rows.map((r) => (
          <div className="m-card" key={r.learner_id} style={{ alignItems: 'center' }}>
            <div className="grow"><Link to={`/learners/${r.learner_id}`}>{r.full_name}</Link><div className="muted small">{r.learner_code}{r.submitted_at ? ` · ${fmtDateTime(r.submitted_at)}` : ''}</div></div>
            {r.score != null && <b>{r.score}/{a.max_marks}</b>}<Badge tone={TONE[r.status]}>{cap(r.status)}</Badge>
            {r.submission_id && r.status !== 'not_submitted' && <button className="btn sm" onClick={() => setReview(r.submission_id)}>{['submitted', 'late'].includes(r.status) ? 'Review' : 'View'}</button>}
          </div>)) : <Empty icon="📭" title="No learners match">Try a different filter.</Empty>}</Async>
      </div>
      {review && <ReviewModal id={review} onClose={() => setReview(null)} onDone={() => { setReview(null); q.reload(); onChange(); }} />}
    </div>
  );
}

function ReviewModal({ id, onClose, onDone }: { id: string; onClose: () => void; onDone: () => void }) {
  const q = useFetch(() => api.get(`/api/submissions/${id}`).then((r) => r.data), [id]);
  const [fb, setFb] = useState<string | null>(null);
  const [score, setScore] = useState<string | null>(null);
  const [bonus, setBonus] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const { busy, run } = useAction();
  const act = (action: 'evaluate' | 'return') => {
    setErr('');
    const sv = score ?? (q.data?.score == null ? '' : String(q.data.score));
    if (action === 'evaluate' && (sv === '' || Number.isNaN(Number(sv)) || Number(sv) < 0 || Number(sv) > q.data.max_marks)) { setErr(`Enter a score from 0 to ${q.data.max_marks}.`); return; }
    return run(async () => { await api.post(`/api/submissions/${id}/review`, { action, feedback: (fb ?? q.data?.feedback) || null, ...(action === 'evaluate' ? { score: Number(sv), ...(bonus !== null && bonus !== '' ? { bonus_xp: Number(bonus) } : {}) } : {}) }); onDone(); }, action === 'evaluate' ? 'Scored and marked evaluated' : 'Returned to learner');
  };
  const s = q.data;
  return (
    <Modal wide title={s ? `${s.learner.name} · ${s.assignment_title}` : 'Submission'} onClose={onClose}
      footer={s?.can_review ? <><button className="btn" disabled={busy} onClick={() => act('return')}>Return for changes</button><button className="btn primary" disabled={busy} onClick={() => act('evaluate')}>Score & mark evaluated</button></> : undefined}>
      <Async q={q}>{(s: any) => (
        <div className="stack">
          <div className="row wrap"><Badge tone={TONE[s.status]}>{cap(s.status)}</Badge>{s.score != null && <b>{s.score}/{s.max_marks}</b>}<span className="muted small">Submitted {fmtDateTime(s.submitted_at)} · version {s.version}</span></div>
          {s.body ? <p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.body}</p> : <span className="muted">No written answer.</span>}
          {s.link_url && <a href={s.link_url} target="_blank" rel="noopener noreferrer nofollow">{s.link_url}</a>}
          <FileLinks files={s.files} />
          {s.can_review && <Field label={`Score (out of ${s.max_marks})`} error={err}><input className="input" type="number" min={0} max={s.max_marks} style={{ maxWidth: 140 }} value={score ?? s.score ?? ''} onChange={(e) => setScore(e.target.value)} /></Field>}
          {s.can_review && <Field label="Bonus XP (optional)" hint={s.bonus_xp ? `Currently +${s.bonus_xp} XP` : 'Extra XP for excellent work, 0–500.'}><input className="input" type="number" min={0} max={500} style={{ maxWidth: 140 }} value={bonus ?? ''} onChange={(e) => setBonus(e.target.value)} /></Field>}
          {s.can_review && <Field label="Feedback to learner" hint="Required when returning work for changes."><textarea className="textarea" value={fb ?? s.feedback ?? ''} onChange={(e) => setFb(e.target.value)} /></Field>}
        </div>)}</Async>
    </Modal>
  );
}
