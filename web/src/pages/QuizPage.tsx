import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { fmtDateTime } from '../format';
import { Async, Badge, Empty, Field, PageHead, Stat, useAction, useFetch } from '../components/ui';

export default function QuizPage() {
  const { id } = useParams();
  const q = useFetch(() => api.get(`/api/quizzes/${id}`).then((r) => r.data), [id]);
  return (
    <Async q={q}>{(z: any) => (
      <>
        <PageHead title={z.title} sub={<>{z.batch_name} · {z.question_count} question{z.question_count === 1 ? '' : 's'} · {z.total_marks} marks{z.time_limit_minutes ? ` · ${z.time_limit_minutes} min` : ''} · {z.max_attempts} attempt{z.max_attempts === 1 ? '' : 's'}</>}
          actions={<><Link className="btn sm" to={`/classroom/${z.batch_id}`}>Back to classroom</Link>{z.can_manage && <Badge tone={z.published ? 'ok' : 'warn'}>{z.published ? 'Published' : 'Draft'}</Badge>}</>} />
        {z.instructions && <div className="card card-pad" style={{ marginBottom: 14, whiteSpace: 'pre-wrap' }}>{z.instructions}</div>}
        {z.can_manage ? <Author z={z} reload={q.reload} /> : <Learner z={z} reload={q.reload} />}
      </>
    )}</Async>
  );
}

/* ------------------------------------------------------------------ teacher */
interface QDraft { kind: 'single' | 'multiple' | 'short'; prompt: string; options: string[]; single: number; multi: number[]; accepted: string; marks: string }
const blank = (): QDraft => ({ kind: 'single', prompt: '', options: ['', ''], single: 0, multi: [], accepted: '', marks: '1' });
const fromApi = (x: any): QDraft => ({ kind: x.kind, prompt: x.prompt, options: x.options ?? ['', ''], single: x.kind === 'single' ? x.answer_key : 0, multi: x.kind === 'multiple' ? x.answer_key : [], accepted: x.kind === 'short' ? x.answer_key.join('\n') : '', marks: String(x.marks) });
const toApi = (d: QDraft) => ({ kind: d.kind, prompt: d.prompt, marks: Number(d.marks) || 1,
  ...(d.kind === 'short' ? { answer_key: d.accepted.split('\n').map((s) => s.trim()).filter(Boolean) } : { options: d.options.map((o) => o.trim()), answer_key: d.kind === 'single' ? d.single : [...d.multi].sort((a, b) => a - b) }) });

function Author({ z, reload }: { z: any; reload: () => void }) {
  const [qs, setQs] = useState<QDraft[]>(z.questions.map(fromApi));
  const [dirty, setDirty] = useState(false);
  const { busy, run } = useAction();
  const locked = z.has_attempts || !z.writable;
  const set = (i: number, p: Partial<QDraft>) => { setQs(qs.map((x, j) => (j === i ? { ...x, ...p } : x))); setDirty(true); };
  const save = () => run(async () => { await api.put(`/api/quizzes/${z.id}/questions`, { questions: qs.map(toApi) }); setDirty(false); reload(); }, 'Questions saved').catch(() => {});
  const publish = (published: boolean) => run(async () => { await api.post(`/api/quizzes/${z.id}/publish`, { published }); reload(); }, published ? 'Published to the class' : 'Unpublished');
  return (
    <div className="stack">
      {locked && <div className="banner" role="status">{z.has_attempts ? 'Learners have attempted this quiz, so the questions are locked.' : 'This batch is closed, so the quiz is read-only.'}</div>}
      <div className="row wrap">
        {!locked && <button className="btn primary" disabled={busy || !dirty} onClick={save}>Save questions</button>}
        {!z.published ? <button className="btn" disabled={busy || dirty || !qs.length || !z.writable} onClick={() => publish(true)} title={dirty ? 'Save your changes first' : ''}>Publish to class</button>
          : !z.has_attempts && <button className="btn" disabled={busy} onClick={() => publish(false)}>Unpublish</button>}
        {z.opens_at && <span className="muted small">Opens {fmtDateTime(z.opens_at)}</span>}{z.closes_at && <span className="muted small">Closes {fmtDateTime(z.closes_at)}</span>}
      </div>
      {qs.map((d, i) => (
        <div className="card card-pad stack" key={i}>
          <div className="row wrap"><b>Question {i + 1}</b>
            <select className="select" style={{ width: 170 }} disabled={locked} value={d.kind} onChange={(e) => set(i, { kind: e.target.value as QDraft['kind'], single: 0, multi: [] })}><option value="single">Single choice</option><option value="multiple">Multiple choice</option><option value="short">Short answer</option></select>
            <label className="row small">Marks <input className="input" style={{ width: 70 }} type="number" min={1} disabled={locked} value={d.marks} onChange={(e) => set(i, { marks: e.target.value })} /></label>
            <span className="grow" />{!locked && <button className="btn ghost sm danger" onClick={() => { setQs(qs.filter((_, j) => j !== i)); setDirty(true); }}>Remove</button>}</div>
          <textarea className="textarea" placeholder="Question" aria-label={`Question ${i + 1}`} disabled={locked} value={d.prompt} onChange={(e) => set(i, { prompt: e.target.value })} />
          {d.kind === 'short' ? <Field label="Accepted answers (one per line; case and spacing are ignored)"><textarea className="textarea" disabled={locked} value={d.accepted} onChange={(e) => set(i, { accepted: e.target.value })} /></Field> : <>
            {d.options.map((o, k) => (
              <div className="row" key={k}>
                <input type={d.kind === 'single' ? 'radio' : 'checkbox'} name={`q${i}`} disabled={locked} aria-label={`Option ${k + 1} is correct`} checked={d.kind === 'single' ? d.single === k : d.multi.includes(k)}
                  onChange={() => set(i, d.kind === 'single' ? { single: k } : { multi: d.multi.includes(k) ? d.multi.filter((x) => x !== k) : [...d.multi, k] })} />
                <input className="input" placeholder={`Option ${k + 1}`} disabled={locked} value={o} onChange={(e) => set(i, { options: d.options.map((x, j) => (j === k ? e.target.value : x)) })} />
                {!locked && d.options.length > 2 && <button className="btn ghost sm" aria-label="Remove option" onClick={() => set(i, { options: d.options.filter((_, j) => j !== k), single: d.single === k ? 0 : d.single > k ? d.single - 1 : d.single, multi: d.multi.filter((x) => x !== k).map((x) => (x > k ? x - 1 : x)) })}>✕</button>}
              </div>))}
            {!locked && d.options.length < 8 && <div><button className="btn sm" onClick={() => set(i, { options: [...d.options, ''] })}>＋ Option</button></div>}
            <span className="muted small">Tick the correct {d.kind === 'single' ? 'option' : 'options; learners must select exactly these to earn the marks'}.</span></>}
        </div>))}
      {!locked && <div><button className="btn" onClick={() => { setQs([...qs, blank()]); setDirty(true); }}>＋ Add question</button></div>}
      {!qs.length && locked && <div className="card"><Empty icon="❓" title="No questions">This quiz has no questions.</Empty></div>}
      {z.published && <Attempts id={z.id} />}
    </div>
  );
}

function Attempts({ id }: { id: string }) {
  const q = useFetch(() => api.get(`/api/quizzes/${id}/attempts`).then((r) => r.data), [id]);
  return (
    <div className="card"><div className="card-head"><h2>Attempts</h2></div>
      <Async q={q} rows={3} empty={(d: any[]) => !d.length}>{(rows: any[]) => rows.length ? rows.map((a) => (
        <div key={a.id} className="m-card" style={{ alignItems: 'center' }}>
          <div className="grow"><Link to={`/learners/${a.learner_id}`}>{a.full_name}</Link><div className="muted small">Attempt {a.attempt_no} · {fmtDateTime(a.submitted_at ?? a.started_at)}</div></div>
          <Badge tone={a.status === 'submitted' ? 'ok' : a.status === 'expired' ? 'bad' : 'warn'}>{a.status.replace('_', ' ')}</Badge>
          <b>{a.score == null ? '—' : `${a.score}/${a.max_score}`}</b></div>)) : <Empty icon="🕒" title="No attempts yet">Attempts appear when learners take the quiz.</Empty>}</Async></div>
  );
}

/* ------------------------------------------------------------------ learner */
function Learner({ z, reload }: { z: any; reload: () => void }) {
  const [attempt, setAttempt] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const { busy, run } = useAction();
  const start = () => run(async () => { setResult(null); setAttempt((await api.post(`/api/quizzes/${z.id}/attempts`)).data); });
  if (attempt) return <Taking attempt={attempt} quiz={z} onDone={(r) => { setAttempt(null); setResult(r); reload(); }} />;
  const reasons: Record<string, string> = { not_open: `This quiz opens ${fmtDateTime(z.opens_at)}.`, closed: 'This quiz has closed.', no_attempts_left: 'You have used all your attempts.' };
  return (
    <div className="stack">
      {result && <Result r={result} />}
      <div className="card card-pad stack">
        <div className="row wrap"><button className="btn primary" disabled={busy || !z.can_start} onClick={start}>{z.in_progress_attempt ? 'Resume quiz' : z.my_attempts.length ? 'Try again' : 'Start quiz'}</button>
          {!z.can_start && <span className="muted">{z.availability !== 'open' ? reasons[z.availability] : !z.writable ? 'This batch is closed.' : 'Only learners can take quizzes.'}</span>}</div>
        {z.time_limit_minutes && <span className="muted small">The {z.time_limit_minutes}-minute timer starts as soon as you begin and cannot be paused.</span>}
        {z.closes_at && <span className="muted small">Closes {fmtDateTime(z.closes_at)}</span>}
      </div>
      {z.my_attempts.length > 0 && <div className="card"><div className="card-head"><h2>Your attempts</h2></div>{z.my_attempts.map((a: any) => (
        <div className="m-card" key={a.id} style={{ alignItems: 'center' }}><div className="grow">Attempt {a.attempt_no}<div className="muted small">{fmtDateTime(a.submitted_at ?? a.started_at)}</div></div>
          <Badge tone={a.status === 'submitted' ? 'ok' : a.status === 'expired' ? 'bad' : 'warn'}>{a.status.replace('_', ' ')}</Badge><b>{a.score == null ? '—' : `${a.score}/${a.max_score}`}</b></div>))}</div>}
    </div>
  );
}

function Result({ r }: { r: any }) {
  return (
    <div className="card card-pad stack">
      <div className="grid cols-3"><Stat label="Score" value={`${r.score}/${r.max_score}`} /><Stat label="Percentage" value={`${r.percentage}%`} /><Stat label="Status" value={r.status === 'expired' ? 'Timed out' : 'Submitted'} /></div>
      {r.message && <div className="banner">{r.message}</div>}
      {r.review && <span className="muted small">Correct on {r.review.filter((x: any) => x.correct).length} of {r.review.length} questions.</span>}
    </div>
  );
}

function Taking({ attempt, quiz, onDone }: { attempt: any; quiz: any; onDone: (r: any) => void }) {
  const [ans, setAns] = useState<Record<string, any>>({});
  const [left, setLeft] = useState<number | null>(attempt.deadline_at ? new Date(attempt.deadline_at).getTime() - Date.now() : null);
  const { busy, run } = useAction();
  const submit = () => run(async () => onDone((await api.post(`/api/quizzes/attempts/${attempt.attempt_id}/submit`, { answers: ans })).data));
  useEffect(() => {
    if (left === null) return;
    const t = setInterval(() => setLeft(new Date(attempt.deadline_at).getTime() - Date.now()), 1000);
    return () => clearInterval(t);
  }, [attempt.deadline_at]); // eslint-disable-line
  useEffect(() => { if (left !== null && left <= 0 && !busy) void submit(); }, [left]); // eslint-disable-line
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn);
  }, []);
  const mm = left === null ? null : `${Math.max(0, Math.floor(left / 60000))}:${String(Math.max(0, Math.floor((left % 60000) / 1000))).padStart(2, '0')}`;
  const answered = Object.values(ans).filter((v) => v !== '' && v != null && !(Array.isArray(v) && !v.length)).length;
  return (
    <div className="stack">
      <div className="card card-pad row between" style={{ position: 'sticky', top: 0, zIndex: 5 }}>
        <span>Attempt {attempt.attempt_no} · {answered}/{attempt.questions.length} answered</span>
        {mm && <b style={{ color: left! < 60000 ? 'var(--bad)' : undefined }} role="timer">⏱ {mm}</b>}
      </div>
      {attempt.questions.map((q: any, i: number) => (
        <div className="card card-pad stack" key={q.id}>
          <div><b>{i + 1}. {q.prompt}</b> <span className="muted small">({q.marks} mark{q.marks === 1 ? '' : 's'}{q.kind === 'multiple' ? ' · select all that apply' : ''})</span></div>
          {q.kind === 'short' ? <input className="input" aria-label={`Answer ${i + 1}`} maxLength={500} value={ans[q.id] ?? ''} onChange={(e) => setAns({ ...ans, [q.id]: e.target.value })} />
            : q.options.map((o: string, k: number) => (
              <label key={k} className="row">
                <input type={q.kind === 'single' ? 'radio' : 'checkbox'} name={q.id} checked={q.kind === 'single' ? ans[q.id] === k : (ans[q.id] ?? []).includes(k)}
                  onChange={() => setAns({ ...ans, [q.id]: q.kind === 'single' ? k : (ans[q.id] ?? []).includes(k) ? (ans[q.id] as number[]).filter((x) => x !== k) : [...(ans[q.id] ?? []), k] })} />{o}</label>))}
        </div>))}
      <div><button className="btn primary" disabled={busy} onClick={() => (answered === attempt.questions.length || confirm(`You answered ${answered} of ${attempt.questions.length}. Submit anyway?`)) && submit()}>{busy ? 'Submitting…' : 'Submit quiz'}</button></div>
      <span className="muted small">{quiz.reveal_answers ? 'Correct answers are shown after you submit.' : 'Your score is shown after you submit.'}</span>
    </div>
  );
}
