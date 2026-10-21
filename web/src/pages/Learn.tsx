import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Badge, Empty, PageHead, Progress, useAction, useFetch, useToast } from '../components/ui';
import { fmtDate } from '../format';

export function Learn() {
  const q = useFetch(() => api.get('/api/learn/my').then((r) => r.data as any[]), []);
  return (
    <>
      <PageHead title="My courses" sub="Courses your school or team has given you. Finish the lessons at your own pace." />
      <MyPaths />
      <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="📚" title="No courses yet">When a course is shared with you, it will show up here.</Empty></div> : (
        <div className="grid cols-3">{list.map((c) => (
          <Link key={c.enrollment_id} to={`/learn/${c.course_id}`} className="card card-pad stack" style={{ textDecoration: 'none', color: 'inherit', borderTop: `5px solid ${c.color}` }}>
            <div className="row between"><b style={{ fontSize: 16 }}>{c.title}</b>{c.status === 'completed' ? <Badge tone="ok">Done ✓</Badge> : c.overdue ? <Badge tone="bad">Overdue</Badge> : null}</div>
            {c.summary && <div className="small muted">{c.summary}</div>}
            <Progress value={c.percent} tone={c.status === 'completed' ? 'ok' : ''} />
            <div className="row between small muted"><span>{c.done}/{c.total} lessons</span><span>{c.due_at && c.status !== 'completed' ? `Due ${fmtDate(c.due_at)}` : c.gives_certificate ? '🎓 Certificate' : ''}</span></div>
          </Link>))}</div>)}</Async>
    </>
  );
}

function MyPaths() {
  const q = useFetch(() => api.get('/api/learn/paths').then((r) => r.data as any[]), []);
  if (!q.data?.length) return null;
  return (
    <div className="stack" style={{ marginBottom: 14 }}>{q.data.map((p) => (
      <div key={p.id} className="card card-pad stack"><div className="row between wrap"><div><b style={{ fontSize: 16 }}>🧭 {p.title}</b>{p.summary && <div className="muted small">{p.summary}</div>}</div>{p.finished ? <Badge tone="ok">Path finished 🎉</Badge> : <span className="muted small">{p.done}/{p.total} courses</span>}</div>
        <Progress value={Math.round((p.done / p.total) * 100)} tone={p.finished ? 'ok' : ''} />
        <div className="row wrap gap-s">{p.steps.map((s: any, i: number) => <span key={s.course_id} className="row gap-s">{i > 0 && <span className="muted">→</span>}
          {s.state === 'locked' ? <span className="badge" title="Finish the course before this one to unlock it">🔒 {s.title}</span> : <Link className={`badge ${s.state === 'done' ? 'ok' : 'info'}`} to={`/learn/${s.course_id}`}>{s.state === 'done' ? '✓ ' : '▶ '}{s.title}</Link>}</span>)}</div></div>))}</div>
  );
}

export function LearnCourse() {
  const { id } = useParams(); const nav = useNavigate(); const q = useFetch(() => api.get(`/api/learn/courses/${id}`).then((r) => r.data as any), [id]); const [open, setOpen] = useState<string | null>(null);
  return (
    <Async q={q}>{(d: any) => {
      const cur = d.lessons.find((l: any) => l.id === (open ?? d.lessons.find((x: any) => !x.done)?.id ?? d.lessons[0]?.id));
      return (<>
        <PageHead title={d.course.title} sub={d.course.summary} actions={<button className="btn" onClick={() => nav('/learn')}>← All courses</button>} />
        <div className="card card-pad"><Progress value={d.percent} tone={d.enrollment.status === 'completed' ? 'ok' : ''} /><div className="muted small" style={{ marginTop: 6 }}>{d.done}/{d.total} required lessons done{d.enrollment.due_at && d.enrollment.status !== 'completed' ? ` · due ${fmtDate(d.enrollment.due_at)}` : ''}{d.enrollment.status === 'completed' && d.course.gives_certificate ? ' · your certificate is in My certificates 🎓' : ''}</div></div>
        <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16, marginTop: 12 }}>
          <div className="card" style={{ width: 260, flex: 'none' }}>{d.lessons.map((l: any, i: number) => (
            <button key={l.id} className="m-card" style={{ width: '100%', textAlign: 'left', background: cur?.id === l.id ? 'var(--bg-soft, #eef3f9)' : 'none', border: 0, cursor: 'pointer' }} onClick={() => setOpen(l.id)}>
              <span aria-hidden>{l.done ? '✅' : l.kind === 'quiz' ? '❓' : l.kind === 'video' ? '▶️' : l.kind === 'link' ? '🔗' : '📄'}</span> <span className="grow">{i + 1}. {l.title}{!l.required && <span className="muted small"> (optional)</span>}</span></button>))}</div>
          <div className="grow" style={{ minWidth: 280 }}>{cur ? <Lesson key={cur.id} courseId={d.course.id} lesson={cur} onDone={q.reload} /> : <div className="card"><Empty icon="📭" title="No lessons yet" /></div>}</div>
        </div></>);
    }}</Async>
  );
}

function Lesson({ courseId, lesson: l, onDone }: { courseId: string; lesson: any; onDone: () => void }) {
  const { busy, run } = useAction(); const toast = useToast(); const [ans, setAns] = useState<number[]>([]); const [res, setRes] = useState<any>(null);
  const finish = (answers?: number[]) => run(async () => {
    const r = (await api.post(`/api/learn/courses/${courseId}/lessons/${l.id}/complete`, answers ? { answers } : {})).data; setRes(r);
    if (r.just_completed && r.path_unlocked?.length) toast(`Course complete! Next on your path: ${r.path_unlocked[0]} 🧭`); else if (r.just_completed) toast(r.certificate_code ? `Course complete! Certificate ${r.certificate_code} 🎓` : 'Course complete! 🎉'); else if (r.passed) toast('Lesson done ✓');
    onDone();
  });
  return (
    <div className="card card-pad stack">
      <div className="row between"><h2 style={{ margin: 0 }}>{l.title}</h2>{l.minutes && <span className="muted small">{l.minutes} min</span>}</div>
      {l.kind !== 'quiz' && l.body && <div style={{ whiteSpace: 'pre-wrap' }}>{l.body}</div>}
      {(l.kind === 'video' || l.kind === 'link') && l.url && <a className="btn" href={l.url} target="_blank" rel="noreferrer noopener">{l.kind === 'video' ? '▶ Watch the video' : '🔗 Open the link'}</a>}
      {l.kind === 'quiz' && <>{(l.questions ?? []).map((qq: any, i: number) => (
        <fieldset key={i} style={{ border: 0, padding: 0, margin: 0 }}><legend><b>{i + 1}. {qq.q}</b></legend>{qq.options.map((o: string, j: number) => <label key={j} className="row gap-s" style={{ padding: '4px 0' }}><input type="radio" name={`q${i}`} checked={ans[i] === j} onChange={() => { const a = [...ans]; a[i] = j; setAns(a); }} /> {o}</label>)}</fieldset>))}
        {res && !res.passed && <p className="err" role="alert">You scored {res.score}%. You need {res.pass_percent}%. Have another go!</p>}
        {l.best_score != null && <div className="muted small">Best score {l.best_score}% · {l.attempts} attempt{l.attempts === 1 ? '' : 's'}</div>}</>}
      <div>{l.kind === 'quiz'
        ? <button className="btn primary" disabled={busy || ans.filter((x) => x !== undefined).length < (l.questions?.length ?? 0)} onClick={() => finish(ans)}>{l.done ? 'Try again' : 'Submit answers'}</button>
        : <button className="btn primary" disabled={busy || l.done} onClick={() => finish()}>{l.done ? 'Done ✓' : 'Mark as done'}</button>}</div>
    </div>
  );
}
