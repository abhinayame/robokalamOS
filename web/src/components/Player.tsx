import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Badge, Empty, Field, Modal, Progress, Tabs, useAction, useFetch, useToast } from './ui';
import { FileLinks, FilePicker, type FileRef } from './Files';
import { Markdown, VideoEmbed } from './Markdown';
import { fmtDate, fmtDateTime } from '../format';
import { Thread } from '../pages/CourseStudio';

const ICON: Record<string, string> = { text: '📄', video: '▶️', link: '🔗', quiz: '❓', file: '📎', assignment: '✍️' };
const shuffled = <T,>(a: T[], seed: number) => { const r = [...a]; let s = seed || 1; for (let i = r.length - 1; i > 0; i--) { s = (s * 1664525 + 1013904223) % 4294967296; const j = s % (i + 1); [r[i], r[j]] = [r[j]!, r[i]!]; } return r; };

/** The course player: modules and lessons on the left, the lesson in the middle, notes and Q&A below. Used for learners and for an author's preview. */
export default function Player({ preview = false }: { preview?: boolean }) {
  const { id } = useParams(); const nav = useNavigate();
  const q = useFetch(() => api.get(preview ? `/api/lms/courses/${id}/preview` : `/api/learn/courses/${id}`).then((r) => r.data as any), [id]);
  const [open, setOpen] = useState<string | null>(null); const [done, setDone] = useState<any>(null);
  return (
    <Async q={q}>{(d: any) => {
      const lessons: any[] = d.lessons; const firstOpen = lessons.find((l) => !l.done && !l.locked) ?? lessons[0]; const cur = lessons.find((l) => l.id === (open ?? firstOpen?.id)); const i = lessons.findIndex((l) => l.id === cur?.id);
      const next = lessons.slice(i + 1).find((l) => !l.locked) ?? null; const prev = i > 0 ? lessons[i - 1] : null; const c = d.course;
      const go = (l: any) => { setOpen(l.id); window.scrollTo({ top: 0, behavior: 'smooth' }); };
      return (
        <>
          {preview && <div className="banner warn" role="status" style={{ marginBottom: 10 }}>👁 <b>Preview.</b> This is how learners see the course. Nothing you do here is saved. <Link to={`/courses/${c.id}`}>Back to the studio</Link></div>}
          <div className="card card-pad" style={{ borderTop: `5px solid ${c.color}`, marginBottom: 12 }}>
            <div className="row between wrap"><div><button className="btn ghost sm" onClick={() => nav(preview ? `/courses/${c.id}` : '/learn')}>← {preview ? 'Studio' : 'My courses'}</button><h1 style={{ margin: '4px 0' }}>{c.icon ? `${c.icon} ` : ''}{c.title}</h1>{c.summary && <div className="muted">{c.summary}</div>}</div>
              <div style={{ minWidth: 220 }}><Progress value={d.percent} tone={d.enrollment.status === 'completed' ? 'ok' : ''} /><div className="muted small" style={{ marginTop: 4 }}>{d.done}/{d.total} required lessons{d.grade != null ? ` · quiz grade ${d.grade}%` : ''}{c.min_grade ? ` (need ${c.min_grade}%)` : ''}{d.enrollment.due_at && d.enrollment.status !== 'completed' ? ` · due ${fmtDate(d.enrollment.due_at)}` : ''}</div>
                {d.enrollment.status === 'completed' && <Badge tone="ok">Finished ✓{c.gives_certificate ? ' · certificate in My certificates' : ''}</Badge>}</div></div>
            {!preview && <Announcements courseId={c.id} />}
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
            <Sidebar d={d} cur={cur} onPick={go} />
            <div className="grow" style={{ minWidth: 280 }}>{cur ? <LessonView key={cur.id} d={d} lesson={cur} preview={preview} next={next} prev={prev} onGo={go} onChange={q.reload} onDone={(r) => setDone(r)} /> : <div className="card"><Empty icon="📭" title="No lessons yet" /></div>}</div>
          </div>
          {done && <Celebration d={d} r={done} preview={preview} onClose={() => { setDone(null); q.reload(); }} />}
        </>); }}</Async>
  );
}

function Sidebar({ d, cur, onPick }: { d: any; cur: any; onPick: (l: any) => void }) {
  const mods: any[] = d.modules; const chapters = mods.filter((m) => !m.parent_id);
  const groups: { id: string | null; title: string; depth: number; lessons: any[] }[] = [{ id: null, title: mods.length ? 'Start here' : 'Lessons', depth: 0, lessons: d.lessons.filter((l: any) => !l.module_id) }];
  for (const m of chapters) { groups.push({ id: m.id, title: m.title, depth: 0, lessons: d.lessons.filter((l: any) => l.module_id === m.id) }); for (const x of mods.filter((y) => y.parent_id === m.id)) groups.push({ id: x.id, title: x.title, depth: 1, lessons: d.lessons.filter((l: any) => l.module_id === x.id) }); }
  const num = new Map<string, number>(); d.lessons.forEach((l: any, i: number) => num.set(l.id, i + 1));
  return (
    <nav aria-label="Course content" className="card" style={{ width: 290, flex: 'none', maxWidth: '100%' }}>
      {groups.map((g) => { if (!g.lessons.length) return null; const doneN = g.lessons.filter((l: any) => l.done).length; return (
        <div key={g.id ?? 'none'}><div className="card-pad" style={{ background: 'var(--bg-soft, #f4f7fb)', borderBottom: '1px solid var(--line, #e3e8ef)', paddingLeft: 16 + g.depth * 14 }}><b>{g.depth ? '↳ ' : ''}{g.title}</b><div className="muted small">{doneN}/{g.lessons.length} done</div></div>
          {g.lessons.map((l: any) => (
            <button key={l.id} className="m-card" disabled={l.locked} aria-current={cur?.id === l.id ? 'true' : undefined} title={l.locked ? 'Finish the lessons before this one to unlock it' : undefined} onClick={() => onPick(l)}
              style={{ width: '100%', textAlign: 'left', border: 0, cursor: l.locked ? 'not-allowed' : 'pointer', background: cur?.id === l.id ? 'var(--bg-soft, #eef3f9)' : 'none', opacity: l.locked ? 0.55 : 1, paddingLeft: 16 + g.depth * 14 }}>
              <span aria-hidden>{l.locked ? '🔒' : l.done ? '✅' : ICON[l.kind]}</span><span className="grow">{num.get(l.id)}. {l.title}{!l.required && <span className="muted small"> (optional)</span>}{l.minutes ? <span className="muted small"> · {l.minutes} min</span> : null}</span></button>))}</div>); })}
    </nav>
  );
}

function Announcements({ courseId }: { courseId: string }) {
  const q = useFetch(() => api.get(`/api/learn/courses/${courseId}/announcements`).then((r) => r.data as any[]).catch(() => []), [courseId]); const a = q.data?.[0];
  if (!a || Date.now() - new Date(a.created_at).getTime() > 14 * 86400_000) return null;
  return <div className="banner" role="status" style={{ marginTop: 10 }}>📣 <b>{a.title}</b> {a.body} <span className="muted small">· {a.author}, {fmtDateTime(a.created_at)}</span></div>;
}

function LessonView({ d, lesson: l, preview, next, prev, onGo, onChange, onDone }: { d: any; lesson: any; preview: boolean; next: any; prev: any; onGo: (l: any) => void; onChange: () => void; onDone: (r: any) => void }) {
  const { busy, run } = useAction(); const toast = useToast(); const [tab, setTab] = useState<'notes' | 'qa'>('notes'); const courseId = d.course.id;
  const markDone = () => run(async () => {
    if (preview) { toast('Preview only: nothing is saved.'); return; }
    const r = (await api.post(`/api/learn/courses/${courseId}/lessons/${l.id}/complete`, {})).data; onChange();
    if (r.just_completed) onDone(r); else { toast('Lesson done ✓'); if (next) onGo(next); }
  });
  return (
    <div className="stack">
      <div className="card card-pad stack">
        <div className="row between wrap"><h2 style={{ margin: 0 }}>{ICON[l.kind]} {l.title}</h2><div className="row gap-s">{l.minutes ? <span className="muted small">{l.minutes} min</span> : null}{l.done && <Badge tone="ok">Done ✓</Badge>}{!l.required && <Badge>Optional</Badge>}</div></div>
        {l.kind === 'text' && l.body && <Markdown text={l.body} />}
        {l.kind === 'video' && <>{l.url && <VideoEmbed url={l.url} title={l.title} />}{l.body && <Markdown text={l.body} />}</>}
        {l.kind === 'link' && <>{l.body && <Markdown text={l.body} />}{l.url && <div><a className="btn" href={l.url} target="_blank" rel="noreferrer noopener">🔗 Open the link</a></div>}</>}
        {l.kind === 'file' && <>{l.body && <Markdown text={l.body} />}<FileLinks files={l.files ?? []} />{!l.files?.length && <div className="muted small">No files yet.</div>}</>}
        {l.kind === 'quiz' && <Quiz courseId={courseId} lesson={l} preview={preview} onChange={onChange} onDone={onDone} />}
        {l.kind === 'assignment' && <Assignment courseId={courseId} lesson={l} preview={preview} onChange={onChange} onDone={onDone} />}
        <div className="row between wrap" style={{ marginTop: 6 }}>
          <button className="btn" disabled={!prev} onClick={() => prev && onGo(prev)}>← Previous</button>
          <div className="row gap-s">{!['quiz', 'assignment'].includes(l.kind) && <button className="btn primary" disabled={busy || l.done} onClick={markDone}>{l.done ? 'Done ✓' : next ? 'Mark complete and continue' : 'Mark complete'}</button>}
            {next && (l.done || ['quiz', 'assignment'].includes(l.kind)) && <button className="btn" onClick={() => onGo(next)}>Next →</button>}</div></div>
      </div>
      {!preview && <div className="card"><Tabs value={tab} onChange={setTab} tabs={[{ id: 'notes', label: '📝 My notes' }, { id: 'qa', label: '💬 Questions' }]} />{tab === 'notes' ? <Notes courseId={courseId} lessonId={l.id} /> : <QA courseId={courseId} lessonId={l.id} />}</div>}
    </div>
  );
}

function Notes({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const [body, setBody] = useState(''); const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle'); const first = useRef(true); const timer = useRef<any>(null);
  useEffect(() => { first.current = true; api.get(`/api/learn/courses/${courseId}/notes`).then((r) => { setBody((r.data as any[]).find((n) => n.lesson_id === lessonId)?.body ?? ''); }).catch(() => undefined); return () => clearTimeout(timer.current); }, [courseId, lessonId]);
  const change = (v: string) => { setBody(v); setState('saving'); clearTimeout(timer.current); timer.current = setTimeout(async () => { try { await api.put(`/api/learn/courses/${courseId}/lessons/${lessonId}/notes`, { body: v }); setState('saved'); } catch { setState('idle'); } }, 900); };
  return <div className="card-pad stack-s"><textarea className="input" rows={4} placeholder="Jot down anything you want to remember. Only you can see your notes." aria-label="My notes" value={body} onChange={(e) => change(e.target.value)} /><div className="muted small">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : 'Notes save by themselves.'}</div></div>;
}

function QA({ courseId, lessonId }: { courseId: string; lessonId: string }) {
  const q = useFetch(() => api.get(`/api/learn/courses/${courseId}/discussions`).then((r) => r.data as any[]), [courseId]); const [open, setOpen] = useState<string | null>(null); const [ask, setAsk] = useState(false); const [all, setAll] = useState(false);
  return (
    <div className="card-pad stack"><div className="row between wrap"><span className="muted small">Ask your teacher or classmates. Be kind and specific.</span><div className="row gap-s"><label className="row gap-s small"><input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Whole course</label><button className="btn sm primary" onClick={() => setAsk(true)}>Ask a question</button></div></div>
      <Async q={q} rows={2}>{(rows: any[]) => { const list = rows.filter((r) => all || r.lesson_id === lessonId); return !list.length ? <div className="muted small">{all ? 'No questions yet.' : 'No questions about this lesson yet.'}</div> : <div>{list.map((r) => <div key={r.id}><button className="m-card" style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', cursor: 'pointer' }} onClick={() => setOpen(open === r.id ? null : r.id)}><div className="grow"><b>{r.pinned && '📌 '}{r.title}</b>{r.resolved && <> <Badge tone="ok">Answered</Badge></>}<div className="muted small">{r.name} · {r.replies} repl{r.replies === 1 ? 'y' : 'ies'}</div></div></button>{open === r.id && <Thread id={r.id} onChange={q.reload} />}</div>)}</div>; }}</Async>
      {ask && <AskModal courseId={courseId} lessonId={lessonId} onClose={() => setAsk(false)} onDone={q.reload} />}</div>
  );
}
function AskModal({ courseId, lessonId, onClose, onDone }: { courseId: string; lessonId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [t, setT] = useState(''); const [b, setB] = useState('');
  return (
    <Modal title="Ask a question" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || t.trim().length < 3 || b.trim().length < 3} onClick={() => run(async () => { await api.post(`/api/learn/courses/${courseId}/discussions`, { title: t, body: b, lesson_id: lessonId }); onDone(); onClose(); }, 'Question posted.')}>Post</button></>}>
      <div className="stack"><Field label="Title"><input className="input" value={t} onChange={(e) => setT(e.target.value)} placeholder="e.g. How do I wire the sensor?" autoFocus /></Field><Field label="Details"><textarea className="input" rows={4} value={b} onChange={(e) => setB(e.target.value)} /></Field></div>
    </Modal>
  );
}

function Quiz({ courseId, lesson: l, preview, onChange, onDone }: { courseId: string; lesson: any; preview: boolean; onChange: () => void; onDone: (r: any) => void }) {
  const { busy, run } = useAction(); const [ans, setAns] = useState<(number | undefined)[]>([]); const [res, setRes] = useState<any>(null); const [round, setRound] = useState(1);
  const qs: { q: string; options: string[] }[] = l.questions ?? [];
  const order = useMemo(() => qs.map((q, qi) => ({ qi, q, opts: (l.shuffle ? shuffled(q.options.map((_, i) => i), qi + round * 97 + l.id.length) : q.options.map((_, i) => i)) })), [l.id, round]); // eslint-disable-line react-hooks/exhaustive-deps
  const qOrder = useMemo(() => (l.shuffle ? shuffled(order, round * 31 + 7) : order), [order, l.shuffle, round]);
  const left = l.attempts_left; const out = left === 0 && !l.done;
  const submit = () => run(async () => {
    if (preview) { setRes({ preview: true }); return; }
    const r = (await api.post(`/api/learn/courses/${courseId}/lessons/${l.id}/complete`, { answers: qs.map((_, i) => ans[i] ?? 0) })).data; setRes(r); onChange(); if (r.just_completed) onDone(r);
  });
  const retry = () => { setAns([]); setRes(null); setRound((x) => x + 1); };
  if (res && !res.preview) return (
    <div className="stack">
      <div className={`banner ${res.passed ? '' : 'warn'}`} role="status"><b>{res.passed ? `Passed with ${res.score}% 🎉` : `You scored ${res.score}%. You need ${res.pass_percent}%.`}</b>{res.needs_grade && <div>Your quiz grade is {res.grade}%. The course needs {res.min_grade}% overall, so retake a quiz to lift it.</div>}</div>
      {res.review && <div className="stack-s">{res.review.map((r: any, i: number) => <div key={i} className="card card-pad"><b>{i + 1}. {qs[i]?.q}</b><div className="small">Right answer: <b>{qs[i]?.options[r.correct]}</b>{r.yours !== r.correct && <> · you chose {qs[i]?.options[r.yours]}</>}</div>{r.explanation && <div className="muted small">💡 {r.explanation}</div>}</div>)}</div>}
      <div className="row gap-s">{(res.attempts_left == null || res.attempts_left > 0) && <button className="btn primary" onClick={retry}>{res.passed ? 'Retake to improve' : 'Try again'}</button>}{res.attempts_left != null && <span className="muted small">{res.attempts_left} attempt{res.attempts_left === 1 ? '' : 's'} left</span>}</div>
    </div>);
  return (
    <div className="stack">
      {l.best_score != null && <div className="muted small">Best score {l.best_score}% · {l.attempts} attempt{l.attempts === 1 ? '' : 's'}{left != null ? ` · ${left} left` : ''}</div>}
      {l.max_attempts && !l.done && left != null && left > 0 && <div className="muted small">You have {left} attempt{left === 1 ? '' : 's'}. Pass mark {l.pass_percent}%.</div>}
      {out ? <div className="banner warn">You used all your attempts. Ask your teacher if you need another go.</div> : <>
        {qOrder.map((o, pos) => <fieldset key={o.qi} style={{ border: 0, padding: 0, margin: 0 }}><legend><b>{pos + 1}. {o.q.q}</b></legend>{o.opts.map((oi) => <label key={oi} className="row gap-s" style={{ padding: '4px 0' }}><input type="radio" name={`q${o.qi}-${round}`} checked={ans[o.qi] === oi} onChange={() => { const a = [...ans]; a[o.qi] = oi; setAns(a); }} /> {o.q.options[oi]}</label>)}</fieldset>)}
        {res?.preview && <div className="banner">Preview: your answers are not graded or saved.</div>}
        <div><button className="btn primary" disabled={busy || qs.some((_, i) => ans[i] === undefined)} onClick={submit}>{l.done ? 'Retake and submit' : 'Submit answers'}</button></div></>}
    </div>
  );
}

function Assignment({ courseId, lesson: l, preview, onChange, onDone }: { courseId: string; lesson: any; preview: boolean; onChange: () => void; onDone: (r: any) => void }) {
  const { busy, run } = useAction(); const toast = useToast(); const sub = l.submission; const [body, setBody] = useState(sub?.body ?? ''); const [files, setFiles] = useState<FileRef[]>([]);
  const accepted = sub?.status === 'accepted'; const waiting = sub?.status === 'submitted';
  return (
    <div className="stack">
      {l.body && <Markdown text={l.body} />}
      {sub && <div className={`banner ${sub.status === 'returned' ? 'warn' : ''}`} role="status">{accepted ? '✅ Accepted.' : waiting ? '⏳ Handed in. Your teacher will review it.' : '↩️ Sent back for changes.'}{sub.feedback && <div>“{sub.feedback}”</div>}</div>}
      {sub?.files?.length ? <div><div className="muted small">Your files</div><FileLinks files={sub.files} /></div> : null}
      {!accepted && <>
        <Field label="Your answer"><textarea className="input" rows={5} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write your answer, or attach a file below." /></Field>
        <div><div className="muted small" style={{ marginBottom: 4 }}>Attach a file (optional)</div><FilePicker value={files} onChange={setFiles} max={3} /></div>
        <div><button className="btn primary" disabled={busy || (!body.trim() && !files.length)} onClick={() => run(async () => {
          if (preview) { toast('Preview only: nothing is saved.'); return; }
          const r = (await api.post(`/api/learn/courses/${courseId}/lessons/${l.id}/submit`, { body: body || null, file_ids: files.map((f) => f.id) })).data; onChange(); if (r.just_completed) onDone(r); else toast(r.status === 'accepted' ? 'Done ✓' : 'Handed in. Your teacher will take a look.');
        })}>{sub ? 'Hand in again' : 'Hand in'}</button></div></>}
    </div>
  );
}

function Celebration({ d, r, preview, onClose }: { d: any; r: any; preview: boolean; onClose: () => void }) {
  const nav = useNavigate(); const { busy, run } = useAction(); const [rating, setRating] = useState(0); const [comment, setComment] = useState(''); const [sent, setSent] = useState(false);
  return (
    <Modal title="🎉 You finished the course!" onClose={onClose} footer={<><button className="btn" onClick={() => { onClose(); nav('/learn/record'); }}>My learning record</button><button className="btn primary" onClick={onClose}>Keep going</button></>}>
      <div className="stack" style={{ textAlign: 'center' }}>
        <div style={{ fontSize: 64 }} aria-hidden>🏆</div><h2 style={{ margin: 0 }}>{d.course.title}</h2>
        {r.grade != null && <div>Your quiz grade: <b>{r.grade}%</b></div>}
        {r.certificate_code && <div className="banner">🎓 Your certificate <code>{r.certificate_code}</code> is ready in <Link to="/my-certificates" onClick={onClose}>My certificates</Link>.</div>}
        {d.course.xp_reward > 0 && !preview && <div>+{d.course.xp_reward} XP added to your profile ⚡</div>}
        {r.path_unlocked?.length > 0 && <div className="banner">🧭 Next on your path: <b>{r.path_unlocked[0]}</b></div>}
        {r.path_finished?.length > 0 && <div className="banner">🧭 You completed the path <b>{r.path_finished[0]}</b>!</div>}
        <div><div className="muted small">How was the course?</div><div role="radiogroup" aria-label="Rating" style={{ fontSize: 30 }}>{[1, 2, 3, 4, 5].map((n) => <button key={n} type="button" role="radio" aria-checked={rating === n} aria-label={`${n} star${n === 1 ? '' : 's'}`} onClick={() => setRating(n)} style={{ background: 'none', border: 0, cursor: 'pointer', color: n <= rating ? '#f5a524' : '#cbd5e1' }}>★</button>)}</div>
          {rating > 0 && !sent && <><textarea className="input" rows={2} placeholder="Tell others what you liked (optional)" value={comment} onChange={(e) => setComment(e.target.value)} /><button className="btn sm primary" style={{ marginTop: 6 }} disabled={busy} onClick={() => run(async () => { await api.put(`/api/learn/courses/${d.course.id}/review`, { rating, comment: comment || null }); setSent(true); }, 'Thank you for the review!')}>Send review</button></>}{sent && <div className="muted small">Thanks! 💛</div>}</div>
      </div>
    </Modal>
  );
}
