import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { LessonEditor } from '../components/LessonEditor';
import { Async, Badge, Empty, Field, Modal, PageHead, Progress, Stat, Tabs, useAction, useFetch, useToast } from '../components/ui';
import { fmtDate, fmtDateTime } from '../format';
import { AssignModal } from './Courses';
import { FileLinks } from '../components/Files';

type Tab = 'content' | 'details' | 'learners' | 'work' | 'discussion' | 'reviews' | 'analytics' | 'news';
const KIND_ICON: Record<string, string> = { text: '📄', video: '▶️', link: '🔗', quiz: '❓', file: '📎', assignment: '✍️' };
const ICONS = ['📘', '🤖', '🧪', '💻', '🎨', '🔬', '🧠', '📐', '🚀', '🎵', '🌱', '🛡️'];

/** One page to build, publish and run a course: content, details, learners, work to review, Q&A, reviews, numbers and announcements. */
export default function CourseStudio() {
  const { id } = useParams(); const nav = useNavigate(); const { can } = useAuth(); const manage = can('lms:manage'); const toast = useToast(); const { busy, run } = useAction();
  const q = useFetch(() => api.get(`/api/lms/courses/${id}/studio`).then((r) => r.data as any), [id]); const [tab, setTab] = useState<Tab>('content'); const [pub, setPub] = useState(false); const [assign, setAssign] = useState(false);
  return (
    <Async q={q}>{(d: any) => { const c = d.course; const live = c.status === 'published'; return (
      <>
        <PageHead title={<>{c.icon ? `${c.icon} ` : ''}{c.title} <Badge tone={live ? 'ok' : ''}>{c.status}</Badge></> as any} sub={`${d.lessons.length} lesson${d.lessons.length === 1 ? '' : 's'} · ${d.stats.enrolled} enrolled · ${d.stats.completed} finished${d.stats.rating_avg ? ` · ★ ${d.stats.rating_avg} (${d.stats.rating_count})` : ''}`}
          actions={<>
            <Link className="btn" to="/courses">← All courses</Link>
            <button className="btn" onClick={() => nav(`/learn/preview/${c.id}`)}>👁 Preview</button>
            {manage && <button className="btn" disabled={busy} onClick={() => run(async () => { const r = (await api.post(`/api/lms/courses/${c.id}/duplicate`)).data; nav(`/courses/${r.id}`); }, 'Copied as a draft.')}>⧉ Copy</button>}
            {manage && live && <button className="btn primary" onClick={() => setAssign(true)}>Assign</button>}
            {manage && (live ? <button className="btn" disabled={busy} onClick={() => confirm('Take this course back to draft? People already on it keep their progress but will not see it until it is published again.') && run(async () => { await api.post(`/api/lms/courses/${c.id}/unpublish`); q.reload(); }, 'Back to draft.')}>Unpublish</button>
              : <button className="btn primary" onClick={() => setPub(true)}>Publish…</button>)}
          </>} />
        {!live && <div className="banner warn" role="status" style={{ marginBottom: 12 }}>This course is a <b>draft</b>: only you can see it. {d.checklist.ready ? 'It is ready, press Publish when you want people to be able to take it.' : 'Finish the checklist under Publish… to make it live.'}</div>}
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'content', label: 'Content' }, { id: 'details', label: 'Details' }, { id: 'learners', label: 'Learners', badge: d.stats.enrolled }, { id: 'work', label: 'Work to review' }, { id: 'discussion', label: 'Q&A' }, { id: 'reviews', label: 'Reviews', badge: d.stats.rating_count || undefined }, { id: 'analytics', label: 'Numbers' }, { id: 'news', label: 'Announcements' }]} />
        {tab === 'content' && <Content d={d} manage={manage} reload={q.reload} />}
        {tab === 'details' && <Details d={d} manage={manage} reload={q.reload} />}
        {tab === 'learners' && <Learners d={d} manage={manage} onAssign={() => setAssign(true)} />}
        {tab === 'work' && <Work d={d} manage={manage} />}
        {tab === 'discussion' && <Discussion d={d} manage={manage} />}
        {tab === 'reviews' && <Reviews d={d} manage={manage} />}
        {tab === 'analytics' && <Numbers d={d} />}
        {tab === 'news' && <News d={d} manage={manage} />}
        {pub && <PublishModal d={d} onClose={() => setPub(false)} onDone={() => { setPub(false); q.reload(); toast('Published. It is live now.'); }} />}
        {assign && <AssignModal course={{ id: c.id, title: c.title, audience: c.audience }} onClose={() => setAssign(false)} onDone={q.reload} />}
      </>); }}</Async>
  );
}

function PublishModal({ d, onClose, onDone }: { d: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [err, setErr] = useState('');
  return (
    <Modal title="Ready to publish?" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Not yet</button><button className="btn primary" disabled={busy || !d.checklist.ready} onClick={() => run(async () => { setErr(''); try { await api.post(`/api/lms/courses/${d.course.id}/publish`); onDone(); } catch (e: any) { setErr(e?.message ?? 'Could not publish.'); throw e; } })}>Publish now</button></>}>
      <div className="stack"><p className="muted small" style={{ margin: 0 }}>Publishing makes the course available. {d.course.enrollment_mode === 'open' ? 'It is OPEN, so people in its audience can find it in the catalog and join themselves.' : 'It is assigned only: nobody sees it until you assign it.'}</p>
        {d.checklist.items.map((i: any) => <div key={i.id} className="m-card" style={{ alignItems: 'flex-start' }}><span aria-hidden>{i.ok ? '✅' : i.blocking ? '⛔' : '💡'}</span><div className="grow"><b>{i.label}</b>{!i.ok && <div className="muted small">{i.hint}{!i.blocking && ' (optional)'}</div>}</div></div>)}
        {err && <p className="err" role="alert">{err}</p>}</div>
    </Modal>
  );
}

// ------------------------------------------------------------------ content
function Content({ d, manage, reload }: { d: any; manage: boolean; reload: () => void }) {
  const { busy, run } = useAction(); const [ed, setEd] = useState<any>(null); const [modForm, setModForm] = useState<any>(null); const c = d.course;
  const order: string[] = d.lessons.map((l: any) => l.id);
  const move = (id: string, delta: number) => { const i = order.indexOf(id); const j = i + delta; const a = d.lessons[i], b = d.lessons[j]; if (!b || a.module_id !== b.module_id) return; const next = [...order]; [next[i], next[j]] = [next[j], next[i]]; run(async () => { await api.post(`/api/lms/courses/${c.id}/lessons/reorder`, { ids: next }); reload(); }); };
  const moveMod = (id: string, delta: number) => { const ids = d.modules.map((m: any) => m.id); const i = ids.indexOf(id); const j = i + delta; if (j < 0 || j >= ids.length) return; [ids[i], ids[j]] = [ids[j], ids[i]]; run(async () => { await api.post(`/api/lms/courses/${c.id}/modules/reorder`, { ids }); reload(); }); };
  const groups = [{ id: null as string | null, title: d.modules.length ? 'Not in a module' : 'Lessons', summary: null as string | null }, ...d.modules.map((m: any) => ({ id: m.id as string, title: m.title as string, summary: m.summary as string | null }))];
  const total = d.lessons.reduce((s: number, l: any) => s + (l.minutes ?? 0), 0);
  return (
    <div className="stack">
      {manage && <div className="row wrap"><button className="btn primary" onClick={() => setEd({ module: d.modules.length ? d.modules[d.modules.length - 1].id : null })}>＋ Add a lesson</button><button className="btn" onClick={() => setModForm({})}>＋ Add a module</button><span className="muted small">{d.lessons.length} lessons{total ? ` · about ${total} min` : ''}. Modules group lessons into weeks or topics, like chapters.</span></div>}
      {groups.map((g) => { const ls = d.lessons.filter((l: any) => (l.module_id ?? null) === g.id); if (!ls.length && g.id === null) return null; return (
        <div key={g.id ?? 'none'} className="card">
          <div className="card-head"><div><h2 style={{ margin: 0 }}>{g.title}</h2>{g.summary && <div className="muted small">{g.summary}</div>}</div>
            {manage && g.id && <div className="row gap-s"><button className="btn ghost sm" aria-label="Move module up" disabled={busy} onClick={() => moveMod(g.id!, -1)}>↑</button><button className="btn ghost sm" aria-label="Move module down" disabled={busy} onClick={() => moveMod(g.id!, 1)}>↓</button><button className="btn sm" onClick={() => setEd({ module: g.id })}>＋ Lesson</button><button className="btn sm" onClick={() => setModForm(g)}>Rename</button>
              <button className="btn sm" disabled={busy} onClick={() => confirm('Remove this module? Its lessons are kept, just ungrouped.') && run(async () => { await api.del(`/api/lms/modules/${g.id}`); reload(); }, 'Module removed.')}>Remove</button></div>}</div>
          {!ls.length ? <Empty icon="📭" title="No lessons here yet" /> : ls.map((l: any) => (
            <div key={l.id} className="m-card" style={{ alignItems: 'center' }}><span aria-hidden style={{ fontSize: 20 }}>{KIND_ICON[l.kind]}</span><div className="grow"><b>{l.title}</b><div className="muted small">{l.kind}{l.minutes ? ` · ${l.minutes} min` : ''}{l.required ? '' : ' · optional'}{l.kind === 'quiz' ? ` · ${l.questions?.length ?? 0} questions` : ''}{l.kind === 'file' ? ` · ${l.files?.length ?? 0} file(s)` : ''}</div></div>
              {manage && <><button className="btn ghost sm" aria-label="Move up" disabled={busy} onClick={() => move(l.id, -1)}>↑</button><button className="btn ghost sm" aria-label="Move down" disabled={busy} onClick={() => move(l.id, 1)}>↓</button>
                <button className="btn sm" onClick={() => setEd({ lesson: l })}>Edit</button><button className="btn sm" disabled={busy} onClick={() => confirm(`Remove “${l.title}”?`) && run(async () => { await api.del(`/api/lms/lessons/${l.id}`); reload(); }, 'Removed.')}>Remove</button></>}</div>))}
        </div>); })}
      {!d.lessons.length && !d.modules.length && <div className="card"><Empty icon="🧱" title="Build your course" action={manage ? <button className="btn primary" onClick={() => setEd({})}>Add the first lesson</button> : undefined}>Add reading, videos, downloads, quizzes and assignments. Group them into modules if the course is long.</Empty></div>}
      {ed && <LessonEditor courseId={c.id} modules={d.modules} lesson={ed.lesson} defaultModule={ed.module} onClose={() => setEd(null)} onSaved={reload} />}
      {modForm && <ModuleForm course={c.id} mod={modForm} onClose={() => setModForm(null)} onDone={reload} />}
    </div>
  );
}
function ModuleForm({ course, mod, onClose, onDone }: { course: string; mod: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [t, setT] = useState(mod.title ?? ''); const [s, setS] = useState(mod.summary ?? '');
  return (
    <Modal title={mod.id ? 'Rename module' : 'New module'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || t.trim().length < 2} onClick={() => run(async () => { const body = { title: t, summary: s || null }; if (mod.id) await api.patch(`/api/lms/modules/${mod.id}`, body); else await api.post(`/api/lms/courses/${course}/modules`, body); onDone(); onClose(); }, 'Saved.')}>Save</button></>}>
      <div className="stack"><Field label="Module name"><input className="input" value={t} onChange={(e) => setT(e.target.value)} placeholder="e.g. Week 1: Getting started" autoFocus /></Field><Field label="What is it about? (optional)"><input className="input" value={s} onChange={(e) => setS(e.target.value)} /></Field></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ details
function Details({ d, manage, reload }: { d: any; manage: boolean; reload: () => void }) {
  const c = d.course; const { busy, run } = useAction(); const [err, setErr] = useState('');
  const designs = useFetch(() => api.get('/api/certificates/designs').then((r) => r.data as any[]).catch(() => []), []);
  const [f, setF] = useState({ title: c.title, summary: c.summary ?? '', audience: c.audience, color: c.color, icon: c.icon ?? '', category: c.category ?? '', level: c.level ?? '', description: c.description ?? '', outcomes: (c.outcomes as string[]).join('\n'), requirements: c.requirements ?? '', instructor_name: c.instructor_name ?? '', language: c.language ?? 'English', enrollment_mode: c.enrollment_mode, sequential: !!c.sequential, min_grade: c.min_grade ?? '', xp_reward: c.xp_reward ?? 0, certificate_design_id: c.certificate_design_id ?? '' });
  const set = (p: object) => setF({ ...f, ...p });
  const save = () => run(async () => {
    setErr('');
    try {
      await api.patch(`/api/lms/courses/${c.id}`, { title: f.title, summary: f.summary || null, audience: f.audience, color: f.color, certificate_design_id: f.certificate_design_id || null });
      await api.patch(`/api/lms/courses/${c.id}/details`, { category: f.category || null, level: f.level || null, description: f.description || null, outcomes: f.outcomes.split('\n').map((x) => x.trim()).filter(Boolean), requirements: f.requirements || null, instructor_name: f.instructor_name || null, language: f.language, icon: f.icon || null, color: f.color, enrollment_mode: f.enrollment_mode, sequential: f.sequential, min_grade: f.min_grade ? Number(f.min_grade) : null, xp_reward: Number(f.xp_reward) || 0 });
      reload();
    } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; }
  }, 'Saved.');
  return (
    <div className="grid cols-2">
      <div className="card card-pad stack"><h2>About the course</h2>
        <Field label="Course name"><input className="input" value={f.title} disabled={!manage} onChange={(e) => set({ title: e.target.value })} /></Field>
        <Field label="Short description" hint="Shown on the course card."><textarea className="input" rows={2} value={f.summary} disabled={!manage} onChange={(e) => set({ summary: e.target.value })} /></Field>
        <Field label="Full description" hint="Shown on the course page. What is it, who is it for?"><textarea className="input" rows={5} value={f.description} disabled={!manage} onChange={(e) => set({ description: e.target.value })} /></Field>
        <Field label="What will people learn? (one per line)"><textarea className="input" rows={4} value={f.outcomes} disabled={!manage} onChange={(e) => set({ outcomes: e.target.value })} placeholder={'Build a simple robot\nRead a sensor'} /></Field>
        <Field label="Before you start (optional)"><input className="input" value={f.requirements} disabled={!manage} onChange={(e) => set({ requirements: e.target.value })} /></Field>
        <div className="row wrap"><Field label="Taught by"><input className="input" value={f.instructor_name} disabled={!manage} onChange={(e) => set({ instructor_name: e.target.value })} /></Field><Field label="Language"><input className="input" style={{ width: 130 }} value={f.language} disabled={!manage} onChange={(e) => set({ language: e.target.value })} /></Field></div>
        <div className="row wrap"><Field label="Category"><input className="input" value={f.category} disabled={!manage} onChange={(e) => set({ category: e.target.value })} placeholder="e.g. Robotics" /></Field>
          <Field label="Level"><select className="select" value={f.level} disabled={!manage} onChange={(e) => set({ level: e.target.value })}><option value="">Any</option><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></Field></div>
        <Field label="Look"><div className="row wrap gap-s">{ICONS.map((i) => <button key={i} type="button" className={`btn sm ${f.icon === i ? 'primary' : ''}`} disabled={!manage} aria-label={`Icon ${i}`} onClick={() => set({ icon: f.icon === i ? '' : i })}>{i}</button>)}<input type="color" aria-label="Course colour" value={f.color} disabled={!manage} onChange={(e) => set({ color: e.target.value })} /></div></Field>
      </div>
      <div className="card card-pad stack"><h2>Who and how</h2>
        <Field label="Who is it for"><select className="select" value={f.audience} disabled={!manage} onChange={(e) => set({ audience: e.target.value })}><option value="learners">Learners</option><option value="staff">Staff / onboarding</option><option value="both">Everyone</option></select></Field>
        <Field label="How do people get in?"><div className="stack-s">
          <label className="row gap-s" style={{ alignItems: 'flex-start' }}><input type="radio" name="em" checked={f.enrollment_mode === 'assigned'} disabled={!manage} onChange={() => set({ enrollment_mode: 'assigned' })} /><span><b>Assigned</b><div className="muted small">You give the course to batches or staff. Best for onboarding and class work.</div></span></label>
          <label className="row gap-s" style={{ alignItems: 'flex-start' }}><input type="radio" name="em" checked={f.enrollment_mode === 'open'} disabled={!manage} onChange={() => set({ enrollment_mode: 'open' })} /><span><b>Open</b><div className="muted small">It appears in the Course catalog and people join themselves, like Coursera.</div></span></label></div></Field>
        <label className="row gap-s"><input type="checkbox" checked={f.sequential} disabled={!manage} onChange={(e) => set({ sequential: e.target.checked })} /> Lessons unlock one after another</label>
        <div className="row wrap"><Field label="Minimum quiz grade to finish (%)" hint="Average of the quizzes. Empty = none."><input className="input" type="number" min={1} max={100} style={{ width: 120 }} value={f.min_grade} disabled={!manage} onChange={(e) => set({ min_grade: e.target.value })} /></Field>
          <Field label="XP for finishing" hint="Learners only. 0 = none."><input className="input" type="number" min={0} max={1000} style={{ width: 120 }} value={f.xp_reward} disabled={!manage} onChange={(e) => set({ xp_reward: e.target.value })} /></Field></div>
        <Field label="Certificate for learners who finish"><select className="select" value={f.certificate_design_id} disabled={!manage} onChange={(e) => set({ certificate_design_id: e.target.value })}><option value="">No certificate</option>{(designs.data ?? []).filter((x: any) => x.status === 'active').map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        {err && <p className="err" role="alert">{err}</p>}
        {manage && <div><button className="btn primary" disabled={busy || f.title.trim().length < 2} onClick={save}>Save details</button></div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ learners
function Learners({ d, manage, onAssign }: { d: any; manage: boolean; onAssign: () => void }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${d.course.id}/progress`).then((r) => r.data as any), [d.course.id]); const { busy, run } = useAction(); const toast = useToast();
  const nudge = (who: string) => run(async () => { const r = (await api.post(`/api/lms/courses/${d.course.id}/nudge`, { who })).data; toast(r.notified ? `Nudged ${r.notified} ${r.notified === 1 ? 'person' : 'people'}.` : 'Nobody needs a nudge right now (or they were nudged in the last day).'); });
  return (
    <div className="stack">
      <Async q={q}>{(p: any) => (<>
        <div className="grid cols-4"><Stat label="Enrolled" value={p.summary.enrolled} /><Stat label="Finished" value={p.summary.completed} /><Stat label="Not started" value={p.summary.not_started} /><Stat label="Overdue" value={p.summary.overdue} sub={`Average ${p.summary.average_percent}%`} /></div>
        <div className="row wrap gap-s">{manage && d.course.status === 'published' && <button className="btn primary" onClick={onAssign}>Assign to people</button>}
          {manage && <><button className="btn" disabled={busy} onClick={() => nudge('not_started')}>Nudge people who have not started</button><button className="btn" disabled={busy} onClick={() => nudge('overdue')}>Nudge overdue</button><button className="btn" disabled={busy} onClick={() => nudge('inactive')}>Nudge inactive for a week</button></>}
          <button className="btn" onClick={() => api.getFile(`/api/lms/courses/${d.course.id}/progress.csv`, 'course-progress.csv')}>⬇ CSV</button></div>
        {!p.rows.length ? <div className="card"><Empty icon="👥" title="Nobody is enrolled yet">{d.course.enrollment_mode === 'open' && d.course.status === 'published' ? 'People can join from the Course catalog.' : 'Assign the course to batches or staff.'}</Empty></div> : (
          <div className="card table-wrap"><table className="t"><thead><tr><th>Name</th><th>Progress</th><th>Due</th><th>Last activity</th><th /></tr></thead><tbody>{p.rows.map((r: any) => (
            <tr key={r.id}><td>{r.name}<br /><span className="muted small">{r.kind === 'staff' ? 'Staff' : 'Learner'} · {r.ref}</span></td><td style={{ minWidth: 150 }}><Progress value={r.percent} tone={r.status === 'completed' ? 'ok' : ''} /><span className="muted small">{r.done}/{r.total}{r.status === 'completed' ? ' · finished' : ''}</span></td>
              <td className="nowrap">{r.due_at ? fmtDate(r.due_at) : '—'} {r.overdue && <Badge tone="bad">Overdue</Badge>}</td><td className="nowrap">{r.last_activity_at ? fmtDateTime(r.last_activity_at) : '—'}</td>
              <td>{manage && <button className="btn ghost sm" disabled={busy} onClick={() => confirm(`Take ${r.name} off this course?`) && run(async () => { await api.del(`/api/lms/enrollments/${r.id}`); q.reload(); }, 'Removed.')}>Remove</button>}</td></tr>))}</tbody></table></div>)}</>)}</Async>
    </div>
  );
}

// ------------------------------------------------------------------ work to review
function Work({ d, manage }: { d: any; manage: boolean }) {
  const [status, setStatus] = useState<'submitted' | 'returned' | 'accepted'>('submitted'); const q = useFetch(() => api.get(`/api/lms/submissions?status=${status}&course_id=${d.course.id}`).then((r) => r.data as any[]), [status, d.course.id]); const [open, setOpen] = useState<any>(null);
  return (
    <div className="stack"><Tabs value={status} onChange={setStatus} tabs={[{ id: 'submitted', label: 'Waiting for you' }, { id: 'returned', label: 'Sent back' }, { id: 'accepted', label: 'Accepted' }]} />
      <Async q={q}>{(rows: any[]) => !rows.length ? <div className="card"><Empty icon="✅" title="Nothing here">Work handed in for assignment lessons appears here.</Empty></div> : <div className="card">{rows.map((r) => (
        <div key={r.id} className="m-card" style={{ alignItems: 'flex-start' }}><div className="grow"><b>{r.name}</b> <span className="muted small">· {r.lesson} · {fmtDateTime(r.updated_at)}</span>{r.body && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{r.body}</div>}<FileLinks files={r.files} />{r.feedback && <div className="small muted" style={{ marginTop: 4 }}>Your note: {r.feedback}</div>}</div>
          {manage && r.status === 'submitted' && <button className="btn sm primary" onClick={() => setOpen(r)}>Review</button>}</div>))}</div>}</Async>
      {open && <ReviewModal sub={open} onClose={() => setOpen(null)} onDone={q.reload} />}</div>
  );
}
function ReviewModal({ sub, onClose, onDone }: { sub: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [fb, setFb] = useState('');
  const go = (decision: 'accept' | 'return') => run(async () => { await api.post(`/api/lms/submissions/${sub.id}/review`, { decision, feedback: fb || null }); onDone(); onClose(); }, decision === 'accept' ? 'Accepted.' : 'Sent back.');
  return (
    <Modal title={`Review · ${sub.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn" disabled={busy || fb.trim().length < 2} onClick={() => go('return')}>Send back</button><button className="btn primary" disabled={busy} onClick={() => go('accept')}>Accept</button></>}>
      <div className="stack"><b>{sub.lesson}</b>{sub.body && <div style={{ whiteSpace: 'pre-wrap' }}>{sub.body}</div>}<FileLinks files={sub.files} /><Field label="Your feedback" hint="Required when you send it back."><textarea className="input" rows={3} value={fb} onChange={(e) => setFb(e.target.value)} /></Field></div>
    </Modal>
  );
}

// ------------------------------------------------------------------ discussion
function Discussion({ d, manage }: { d: any; manage: boolean }) {
  const q = useFetch(() => api.get(`/api/learn/courses/${d.course.id}/discussions`).then((r) => r.data as any[]), [d.course.id]); const [open, setOpen] = useState<string | null>(null); const { run } = useAction();
  return (
    <div className="stack"><Async q={q}>{(rows: any[]) => !rows.length ? <div className="card"><Empty icon="💬" title="No questions yet">When people ask questions in this course, they show up here and you get a notification.</Empty></div> : <div className="card">{rows.map((r) => (
      <div key={r.id}><button className="m-card" style={{ width: '100%', textAlign: 'left', border: 0, background: 'none', cursor: 'pointer', opacity: r.hidden ? 0.5 : 1 }} onClick={() => setOpen(open === r.id ? null : r.id)}><div className="grow"><b>{r.pinned && '📌 '}{r.title}</b>{r.resolved && <> <Badge tone="ok">Answered</Badge></>}{r.hidden && <> <Badge tone="bad">Hidden</Badge></>}<div className="muted small">{r.name} · {r.replies} repl{r.replies === 1 ? 'y' : 'ies'} · {fmtDateTime(r.last_activity_at)}</div></div></button>
        {open === r.id && <Thread id={r.id} manage={manage} onChange={q.reload} extra={manage ? <div className="row gap-s wrap"><button className="btn sm" onClick={() => run(async () => { await api.post(`/api/lms/discussions/${r.id}/${r.resolved ? 'reopen' : 'resolve'}`); q.reload(); })}>{r.resolved ? 'Reopen' : 'Mark answered'}</button><button className="btn sm" onClick={() => run(async () => { await api.post(`/api/lms/discussions/${r.id}/${r.pinned ? 'unpin' : 'pin'}`); q.reload(); })}>{r.pinned ? 'Unpin' : 'Pin'}</button><button className="btn sm" onClick={() => run(async () => { await api.post(`/api/lms/discussions/${r.id}/${r.hidden ? 'unhide' : 'hide'}`); q.reload(); })}>{r.hidden ? 'Show again' : 'Hide'}</button></div> : null} />}</div>))}</div>}</Async></div>
  );
}
/** One discussion: the question, its replies, and a reply box. Used by the studio and the player. */
export function Thread({ id, manage, onChange, extra }: { id: string; manage?: boolean; onChange?: () => void; extra?: React.ReactNode }) {
  const q = useFetch(() => api.get(`/api/learn/discussions/${id}`).then((r) => r.data as any), [id]); const [body, setBody] = useState(''); const { busy, run } = useAction();
  return (
    <Async q={q} rows={2}>{(t: any) => (
      <div className="card-pad stack-s" style={{ background: 'var(--bg-soft, #f4f7fb)' }}>
        <div style={{ whiteSpace: 'pre-wrap' }}>{t.body}</div>{extra}
        {t.replies.map((r: any) => <div key={r.id} style={{ padding: '6px 10px', borderLeft: `3px solid ${r.staff ? 'var(--brand, #12263f)' : 'var(--line, #cbd5e1)'}`, opacity: r.hidden ? 0.5 : 1 }}><div className="muted small"><b>{r.name}</b>{r.staff && <> <Badge tone="info">Teacher</Badge></>} · {fmtDateTime(r.created_at)}{manage && <> · <button className="btn ghost sm" onClick={() => run(async () => { await api.post(`/api/lms/replies/${r.id}/${r.hidden ? 'unhide' : 'hide'}`); q.reload(); onChange?.(); })}>{r.hidden ? 'Show' : 'Hide'}</button></>}</div><div style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div></div>)}
        <div className="row"><textarea className="input grow" rows={2} placeholder="Write a reply…" aria-label="Reply" value={body} onChange={(e) => setBody(e.target.value)} /><button className="btn primary" disabled={busy || !body.trim()} onClick={() => run(async () => { await api.post(`/api/learn/discussions/${id}/replies`, { body }); setBody(''); q.reload(); onChange?.(); })}>Reply</button></div>
      </div>)}</Async>
  );
}

// ------------------------------------------------------------------ reviews
function Stars({ n }: { n: number }) { return <span aria-label={`${n} out of 5`} style={{ color: '#f5a524' }}>{'★'.repeat(n)}<span style={{ color: '#cbd5e1' }}>{'★'.repeat(5 - n)}</span></span>; }
function Reviews({ d, manage }: { d: any; manage: boolean }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${d.course.id}/reviews`).then((r) => r.data as any[]), [d.course.id]); const { run } = useAction();
  return (
    <Async q={q}>{(rows: any[]) => !rows.length ? <div className="card"><Empty icon="⭐" title="No reviews yet">People can rate the course once they are half way through.</Empty></div> : <div className="card">{rows.map((r) => (
      <div key={r.id} className="m-card" style={{ alignItems: 'flex-start', opacity: r.hidden_at ? 0.5 : 1 }}><div className="grow"><Stars n={r.rating} /> <b>{r.name}</b> <span className="muted small">· {fmtDate(r.created_at)}</span>{r.hidden_at && <> <Badge tone="bad">Hidden</Badge></>}{r.comment && <div style={{ marginTop: 2 }}>{r.comment}</div>}</div>
        {manage && <button className="btn sm" onClick={() => run(async () => { await api.post(`/api/lms/reviews/${r.id}/${r.hidden_at ? 'unhide' : 'hide'}`); q.reload(); })}>{r.hidden_at ? 'Show' : 'Hide'}</button>}</div>))}</div>}</Async>
  );
}

// ------------------------------------------------------------------ numbers
function Numbers({ d }: { d: any }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${d.course.id}/analytics`).then((r) => r.data as any), [d.course.id]);
  return (
    <Async q={q}>{(a: any) => (
      <div className="stack">
        <div className="grid cols-4"><Stat label="Enrolled" value={a.enrolled} /><Stat label="Started" value={a.started} sub={a.enrolled ? `${Math.round((a.started / a.enrolled) * 100)}% of enrolled` : undefined} /><Stat label="Finished" value={a.completed} sub={`${a.completion_percent}% completion`} /><Stat label="Rating" value={a.rating ? `★ ${a.rating.avg}` : '—'} sub={a.rating ? `${a.rating.count} review${a.rating.count === 1 ? '' : 's'}` : 'No reviews yet'} /></div>
        <div className="card"><div className="card-head"><h2>Where people are</h2><span className="muted small">Share of enrolled people who finished each lesson</span></div>
          {a.lessons.map((l: any) => (
            <div key={l.id} className="card-pad" style={{ borderBottom: '1px solid var(--line, #e3e8ef)' }}><div className="row between"><b>{KIND_ICON[l.kind]} {l.title}</b><span className="muted small">{l.completed} done · {l.percent}%{l.avg_score != null ? ` · avg score ${l.avg_score}%` : ''}{l.tries ? ` · ${l.tries} tries` : ''}</span></div><Progress value={l.percent} />
              {l.questions && <div className="stack-s" style={{ marginTop: 8 }}>{l.questions.map((x: any, i: number) => <div key={i} className="row between small"><span>{i + 1}. {x.q}</span><span style={{ color: x.percent_correct < 50 ? 'var(--bad, #c0392b)' : 'inherit' }}>{x.answered ? `${x.percent_correct}% got it right` : 'not answered yet'}</span></div>)}</div>}</div>))}
          {!a.lessons.length && <Empty icon="📊" title="No lessons yet" />}</div>
      </div>)}</Async>
  );
}

// ------------------------------------------------------------------ announcements
function News({ d, manage }: { d: any; manage: boolean }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${d.course.id}/announcements`).then((r) => r.data as any[]), [d.course.id]); const [t, setT] = useState(''); const [b, setB] = useState(''); const { busy, run } = useAction(); const toast = useToast();
  return (
    <div className="stack">
      {manage && <div className="card card-pad stack"><h2>Post an announcement</h2><p className="muted small" style={{ margin: 0 }}>Everyone enrolled gets a notification (and their parents see it for learners).</p>
        <Field label="Title"><input className="input" value={t} onChange={(e) => setT(e.target.value)} /></Field><Field label="Message"><textarea className="input" rows={3} value={b} onChange={(e) => setB(e.target.value)} /></Field>
        <div><button className="btn primary" disabled={busy || t.trim().length < 2 || b.trim().length < 2} onClick={() => run(async () => { const r = (await api.post(`/api/lms/courses/${d.course.id}/announcements`, { title: t, body: b })).data; toast(`Sent to ${r.notified} ${r.notified === 1 ? 'person' : 'people'}.`); setT(''); setB(''); q.reload(); })}>Send</button></div></div>}
      <Async q={q}>{(rows: any[]) => !rows.length ? null : <div className="card">{rows.map((r) => <div key={r.id} className="m-card" style={{ alignItems: 'flex-start' }}><div className="grow"><b>{r.title}</b><div style={{ whiteSpace: 'pre-wrap' }}>{r.body}</div><div className="muted small">{r.author} · {fmtDateTime(r.created_at)}</div></div></div>)}</div>}</Async>
    </div>
  );
}
