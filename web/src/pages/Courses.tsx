import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { Async, Badge, Empty, Field, Modal, PageHead, Progress, Stat, Tabs, useAction, useFetch, useToast } from '../components/ui';
import Paths from './Paths';
import { fmtDate, fmtDateTime } from '../format';

const AUD: Record<string, string> = { learners: 'Learners', staff: 'Staff / onboarding', both: 'Everyone' };

export default function Courses() {
  const nav = useNavigate(); const toast = useToast(); const { run } = useAction(); const { can } = useAuth(); const manage = can('lms:manage'); const q = useFetch(() => api.get('/api/lms/courses').then((r) => r.data as any[]), []);
  const [tab, setTab] = useState<'courses' | 'paths'>('courses'); const [edit, setEdit] = useState<any>(null); const [assign, setAssign] = useState<any>(null); const [prog, setProg] = useState<any>(null); const [lessons, setLessons] = useState<any>(null);
  return (
    <>
      <PageHead title="Courses" sub="Build a course once, share it with learners or with the staff you are onboarding, and watch who has finished." actions={manage && tab === 'courses' ? <button className="btn primary" onClick={() => setEdit({})}>＋ New course</button> : undefined} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'courses', label: 'Courses' }, { id: 'paths', label: 'Learning paths' }]} />
      {tab === 'paths' ? <Paths manage={manage} /> : <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="📚" title="No courses yet" action={manage ? <button className="btn primary" onClick={() => setEdit({})}>Create the first course</button> : undefined}>For example: “Welcome to the team” for new teachers.</Empty></div> : (
        <div className="grid cols-3">{list.map((c) => (
          <div key={c.id} className="card card-pad stack" style={{ borderTop: `5px solid ${c.color}` }}>
            <div className="row between"><b style={{ fontSize: 16 }}>{c.title}</b><Badge tone={c.status === 'published' ? 'ok' : ''}>{c.status}</Badge></div>
            <div className="muted small">{AUD[c.audience]} · {c.lessons} lesson{c.lessons == 1 ? '' : 's'} · {c.enrolled} enrolled · {c.completed} finished</div>
            {manage && c.status !== 'published' && <div className="banner warn small" role="status">Draft: nobody can see it yet. <button className="btn sm primary" style={{ marginLeft: 6 }} onClick={() => run(async () => { try { await api.post(`/api/lms/courses/${c.id}/publish`); q.reload(); toast('Published. You can assign it now.'); } catch (e: any) { toast(e?.message ?? 'Could not publish.', 'err'); nav(`/courses/${c.id}`); } })}>Publish</button></div>}
            <div className="row gap-s wrap"><button className="btn sm primary" onClick={() => nav(`/courses/${c.id}`)}>Open studio</button><button className="btn sm" onClick={() => setProg(c)}>Progress</button>
              {manage && <><button className="btn sm" onClick={() => setLessons(c)}>Lessons</button><button className="btn sm" onClick={() => setEdit(c)}>Edit</button><button className="btn sm" disabled={c.status !== 'published'} title={c.status !== 'published' ? 'Publish the course first' : undefined} onClick={() => setAssign(c)}>Assign</button>{c.status === 'published' && <button className="btn sm" onClick={() => run(async () => { await api.post(`/api/lms/courses/${c.id}/unpublish`); q.reload(); }, 'Back to draft.')}>Unpublish</button>}</>}</div>
          </div>))}</div>)}</Async>}
      {edit && <CourseModal course={edit} onClose={() => setEdit(null)} onDone={q.reload} />}
      {assign && <AssignModal course={assign} onClose={() => setAssign(null)} onDone={q.reload} />}
      {prog && <ProgressModal course={prog} manage={manage} onClose={() => setProg(null)} />}
      {lessons && <LessonsModal course={lessons} onClose={() => { setLessons(null); q.reload(); }} />}
    </>
  );
}

export function CourseModal({ course, onClose, onDone }: { course: any; onClose: () => void; onDone: () => void }) {
  const isNew = !course.id; const { busy, run } = useAction(); const [err, setErr] = useState('');
  const designs = useFetch(() => api.get('/api/certificates/designs').then((r) => r.data as any[]).catch(() => []), []);
  const [f, setF] = useState({ title: course.title ?? '', summary: course.summary ?? '', audience: course.audience ?? 'learners', color: course.color ?? '#12263f', certificate_design_id: course.certificate_design_id ?? '', status: course.status ?? 'draft' });
  const save = () => run(async () => { setErr(''); const body = { ...f, summary: f.summary || null, certificate_design_id: f.certificate_design_id || null }; try { if (isNew) await api.post('/api/lms/courses', body); else await api.patch(`/api/lms/courses/${course.id}`, body); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } }, 'Saved.');
  return (
    <Modal title={isNew ? 'New course' : `Edit · ${course.title}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.title.trim().length < 2} onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Course name"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <Field label="Short description"><textarea className="input" rows={2} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        <div className="row wrap"><Field label="Who is it for"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="learners">Learners</option><option value="staff">Staff / onboarding</option><option value="both">Everyone</option></select></Field>
          <Field label="Colour"><input type="color" value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label="Course colour" /></Field>
          {!isNew && <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></Field>}</div>
        <Field label="Certificate for learners who finish" hint="Staff get a completion record, not a certificate."><select className="select" value={f.certificate_design_id} onChange={(e) => setF({ ...f, certificate_design_id: e.target.value })}><option value="">No certificate</option>{(designs.data ?? []).filter((d: any) => d.status === 'active').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
        {err && <p className="err" role="alert">{err}</p>}
        {isNew && <p className="muted small" style={{ margin: 0 }}>Save first, then add lessons and publish.</p>}
      </div>
    </Modal>
  );
}

const blank = { title: '', kind: 'text', body: '', url: '', minutes: '', required: true, pass_percent: 70, questions: [] as { q: string; options: string[]; answer: number }[] };
function LessonsModal({ course, onClose }: { course: any; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${course.id}`).then((r) => r.data as any), [course.id]); const { busy, run } = useAction();
  const [ed, setEd] = useState<any>(null); const [err, setErr] = useState(''); const [pick, setPick] = useState(false); const toast = useToast();
  const move = (ids: string[], i: number, d: number) => { const a = [...ids]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; run(async () => { await api.post(`/api/lms/courses/${course.id}/lessons/reorder`, { ids: a }); q.reload(); }); };
  const save = () => run(async () => {
    setErr(''); const body = { title: ed.title, kind: ed.kind, body: ed.body || null, url: ed.url || null, minutes: ed.minutes ? Number(ed.minutes) : null, required: ed.required, pass_percent: Number(ed.pass_percent), questions: ed.kind === 'quiz' ? ed.questions : null };
    try { if (ed.id) await api.put(`/api/lms/lessons/${ed.id}`, body); else await api.post(`/api/lms/courses/${course.id}/lessons`, body); setEd(null); q.reload(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; }
  }, 'Lesson saved.');
  return (
    <Modal wide title={`Lessons · ${course.title}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      {ed ? (
        <div className="stack">
          <div className="row wrap"><Field label="Lesson name" className="grow"><input className="input" value={ed.title} onChange={(e) => setEd({ ...ed, title: e.target.value })} autoFocus /></Field>
            <Field label="Type"><select className="select" value={ed.kind} onChange={(e) => setEd({ ...ed, kind: e.target.value })}><option value="text">Reading</option><option value="video">Video link</option><option value="link">Web link</option><option value="quiz">Quiz</option></select></Field></div>
          {(ed.kind === 'text' || ed.kind === 'video' || ed.kind === 'link') && <Field label={ed.kind === 'text' ? 'Lesson text' : 'Notes (optional)'}><textarea className="input" rows={ed.kind === 'text' ? 8 : 3} value={ed.body} onChange={(e) => setEd({ ...ed, body: e.target.value })} /></Field>}
          {(ed.kind === 'video' || ed.kind === 'link') && <Field label="Link (https://…)"><input className="input" value={ed.url} onChange={(e) => setEd({ ...ed, url: e.target.value })} /></Field>}
          {ed.kind === 'quiz' && <>
            <Field label="Pass mark (%)"><input className="input" type="number" min={1} max={100} style={{ width: 90 }} value={ed.pass_percent} onChange={(e) => setEd({ ...ed, pass_percent: e.target.value })} /></Field>
            {ed.questions.map((qq: any, i: number) => (
              <div key={i} className="card card-pad stack-s"><div className="row"><input className="input grow" placeholder={`Question ${i + 1}`} value={qq.q} onChange={(e) => { const qs2 = [...ed.questions]; qs2[i] = { ...qq, q: e.target.value }; setEd({ ...ed, questions: qs2 }); }} /><button className="btn ghost sm" onClick={() => setEd({ ...ed, questions: ed.questions.filter((_: any, k: number) => k !== i) })}>Remove</button></div>
                {qq.options.map((o: string, j: number) => <div key={j} className="row"><input type="radio" name={`ans${i}`} checked={qq.answer === j} onChange={() => { const qs2 = [...ed.questions]; qs2[i] = { ...qq, answer: j }; setEd({ ...ed, questions: qs2 }); }} aria-label={`Option ${j + 1} is correct`} /><input className="input grow" placeholder={`Option ${j + 1}`} value={o} onChange={(e) => { const op = [...qq.options]; op[j] = e.target.value; const qs2 = [...ed.questions]; qs2[i] = { ...qq, options: op }; setEd({ ...ed, questions: qs2 }); }} /></div>)}
                {qq.options.length < 6 && <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => { const qs2 = [...ed.questions]; qs2[i] = { ...qq, options: [...qq.options, ''] }; setEd({ ...ed, questions: qs2 }); }}>＋ Option</button>}
                <div className="muted small">Tick the circle next to the right answer. Learners never see which one it is.</div></div>))}
            <div className="row gap-s wrap"><button className="btn sm" onClick={() => setEd({ ...ed, questions: [...ed.questions, { q: '', options: ['', ''], answer: 0 }] })}>＋ Add a question</button>
              <button className="btn sm" onClick={() => setPick(true)}>📚 Add from question bank</button>
              {ed.questions.length > 0 && <button className="btn sm" onClick={() => { const topic = prompt('Save these questions to the bank under which topic?', ''); if (topic && topic.trim().length >= 2) run(async () => { const r = (await api.post('/api/bank/bulk', { topic, questions: ed.questions.filter((x: any) => x.q.trim() && x.options.filter((o: string) => o.trim()).length >= 2) })).data; toast(`${r.added} saved, ${r.skipped} already there.`); }); }}>Save these to the bank</button>}</div></>}
          <label className="row gap-s"><input type="checkbox" checked={ed.required} onChange={(e) => setEd({ ...ed, required: e.target.checked })} /> Required to finish the course</label>
          {err && <p className="err" role="alert">{err}</p>}
          <div className="row gap-s"><button className="btn primary" disabled={busy || ed.title.trim().length < 2} onClick={save}>Save lesson</button><button className="btn" onClick={() => setEd(null)}>Cancel</button></div>
        </div>
      ) : (
        <Async q={q}>{(c: any) => (<div className="stack">
          {c.lessons.map((l: any, i: number, all: any[]) => (
            <div key={l.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{i + 1}. {l.title}</b> <span className="muted small">{l.kind}{l.required ? '' : ' · optional'}</span></div>
              <button className="btn ghost sm" aria-label="Move up" disabled={busy || i === 0} onClick={() => move(all.map((x) => x.id), i, -1)}>↑</button><button className="btn ghost sm" aria-label="Move down" disabled={busy || i === all.length - 1} onClick={() => move(all.map((x) => x.id), i, 1)}>↓</button>
              <button className="btn sm" onClick={() => setEd({ ...blank, ...l, url: l.url ?? '', body: l.body ?? '', minutes: l.minutes ?? '', questions: l.questions ?? [] })}>Edit</button>
              <button className="btn sm" disabled={busy} onClick={() => confirm(`Remove “${l.title}”?`) && run(async () => { await api.del(`/api/lms/lessons/${l.id}`); q.reload(); }, 'Removed.')}>Remove</button></div>))}
          {!c.lessons.length && <Empty icon="📄" title="No lessons yet" />}
          <div><button className="btn primary" onClick={() => setEd({ ...blank })}>＋ Add a lesson</button></div></div>)}</Async>
      )}
    {pick && ed && <BankPicker onClose={() => setPick(false)} onAdd={(qs2) => { setEd({ ...ed, questions: [...ed.questions, ...qs2] }); setPick(false); }} />}
    </Modal>
  );
}

export function BankPicker({ onClose, onAdd }: { onClose: () => void; onAdd: (q: any[]) => void }) {
  const topics = useFetch(() => api.get('/api/bank/topics').then((r) => r.data as any[]), []); const [topic, setTopic] = useState(''); const [sel, setSel] = useState<Record<string, any>>({}); const [n, setN] = useState(5); const { busy, run } = useAction();
  const list = useFetch(() => api.get(`/api/bank?page_size=100${topic ? `&topic=${encodeURIComponent(topic)}` : ''}`).then((r) => r.data as any[]), [topic]); const picked = Object.values(sel);
  const strip = (x: any) => ({ q: x.q, options: x.options, answer: x.answer });
  return (
    <Modal wide title="Add from the question bank" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!picked.length} onClick={() => onAdd(picked.map(strip))}>Add {picked.length || ''} selected</button></>}>
      <div className="stack"><div className="row wrap"><select className="select" style={{ width: 220 }} aria-label="Topic" value={topic} onChange={(e) => setTopic(e.target.value)}><option value="">All topics</option>{(topics.data ?? []).map((t: any) => <option key={t.topic} value={t.topic}>{t.topic} ({t.questions})</option>)}</select>
        <input className="input" type="number" min={1} max={30} style={{ width: 80 }} aria-label="How many" value={n} onChange={(e) => setN(Number(e.target.value))} /><button className="btn sm" disabled={busy} onClick={() => run(async () => { const r = (await api.post('/api/bank/pick', { topic: topic || undefined, count: n })).data as any[]; setSel(Object.fromEntries(r.map((x) => [x.id, x]))); }, 'Random questions chosen.')}>🎲 Pick {n} at random</button></div>
        <Async q={list as any}>{(rows: any[]) => !rows.length ? <Empty icon="❓" title="The bank is empty">Add questions under Question bank first.</Empty> : <>{rows.map((x) => <label key={x.id} className="m-card" style={{ alignItems: 'flex-start', cursor: 'pointer' }}><input type="checkbox" checked={!!sel[x.id]} onChange={(e) => setSel((c) => { const d = { ...c }; if (e.target.checked) d[x.id] = x; else delete d[x.id]; return d; })} /><div className="grow"><b>{x.q}</b><div className="muted small">{x.topic} · {x.difficulty}</div></div></label>)}</>}</Async></div>
    </Modal>
  );
}

export function AssignModal({ course, onClose, onDone }: { course: any; onClose: () => void; onDone: () => void }) {
  const toStaff = course.audience !== 'learners'; const toLearners = course.audience !== 'staff'; const [batches, setBatches] = useState<string[]>([]); const [sum, setSum] = useState<AudienceSummary | null>(null);
  const [allStaff, setAllStaff] = useState(false); const [due, setDue] = useState(''); const [preview, setPreview] = useState<any>(null); const { busy, run } = useAction(); const toast = useToast();
  const body = (x: object) => ({ selector: batches.length ? { batch_ids: batches } : undefined, all_staff: allStaff, due_at: due ? new Date(`${due}T23:59:00`).toISOString() : undefined, ...x });
  const ready = (batches.length > 0 && !!sum?.unique_learners) || allStaff;
  return (
    <Modal wide title={`Assign “${course.title}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={busy || !ready} onClick={() => run(async () => setPreview((await api.post(`/api/lms/courses/${course.id}/assign`, body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !(preview.learners.to_assign + preview.staff.to_assign)} onClick={() => run(async () => { await api.post(`/api/lms/courses/${course.id}/assign`, body({ confirm: true })); toast('Course assigned. They have been told.'); onDone(); onClose(); })}>Confirm and assign</button>}</>}>
      <div className="stack">
        {toStaff && <label className="row gap-s"><input type="checkbox" checked={allStaff} onChange={(e) => { setAllStaff(e.target.checked); setPreview(null); }} /> All active staff (teachers, counsellors, admins) — for onboarding</label>}
        {toLearners && <><b>Learners, by batch</b><BatchSelector value={batches} onChange={(v) => { setBatches(v); setPreview(null); }} onSummary={setSum} /></>}
        <Field label="Finish by (optional)"><input className="input" type="date" style={{ width: 170 }} value={due} onChange={(e) => { setDue(e.target.value); setPreview(null); }} /></Field>
        {preview && <div className="card card-pad"><b>Ready to go</b><div className="small">{toLearners && <div>Learners: {preview.learners.to_assign} new{preview.learners.already ? `, ${preview.learners.already} already enrolled` : ''}</div>}{toStaff && <div>Staff: {preview.staff.to_assign} new{preview.staff.already ? `, ${preview.staff.already} already enrolled` : ''}</div>}</div></div>}
      </div>
    </Modal>
  );
}

function ProgressModal({ course, manage, onClose }: { course: any; manage: boolean; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/lms/courses/${course.id}/progress`).then((r) => r.data as any), [course.id]); const { busy, run } = useAction(); const [tab, setTab] = useState<'all' | 'late'>('all');
  return (
    <Modal wide title={`Progress · ${course.title}`} onClose={onClose} footer={<><button className="btn" onClick={() => api.getFile(`/api/lms/courses/${course.id}/progress.csv`, 'course-progress.csv')}>⬇ CSV</button><button className="btn" onClick={onClose}>Close</button></>}>
      <Async q={q}>{(d: any) => { const rows = d.rows.filter((r: any) => tab === 'all' || r.overdue || (r.status !== 'completed' && r.done === 0)); return (<div className="stack">
        <div className="grid cols-4"><Stat label="Enrolled" value={d.summary.enrolled} /><Stat label="Finished" value={d.summary.completed} /><Stat label="Not started" value={d.summary.not_started} /><Stat label="Overdue" value={d.summary.overdue} sub={`Average ${d.summary.average_percent}%`} /></div>
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'all', label: 'Everyone' }, { id: 'late', label: 'Needs a nudge' }]} />
        {!rows.length ? <Empty icon="🎉" title="Nobody here" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Name</th><th>Progress</th><th>Due</th><th>Last activity</th><th /></tr></thead><tbody>
          {rows.map((r: any) => <tr key={r.id}><td>{r.name}<br /><span className="muted small">{r.kind === 'staff' ? 'Staff' : 'Learner'} · {r.ref}</span></td><td style={{ minWidth: 140 }}><Progress value={r.percent} tone={r.status === 'completed' ? 'ok' : ''} /><span className="muted small">{r.done}/{r.total}{r.status === 'completed' ? ' · finished' : ''}</span></td>
            <td className="nowrap">{r.due_at ? fmtDate(r.due_at) : '—'} {r.overdue && <Badge tone="bad">Overdue</Badge>}</td><td className="nowrap">{r.last_activity_at ? fmtDateTime(r.last_activity_at) : '—'}</td>
            <td>{manage && <button className="btn ghost sm" disabled={busy} onClick={() => confirm(`Take ${r.name} off this course?`) && run(async () => { await api.del(`/api/lms/enrollments/${r.id}`); q.reload(); }, 'Removed.')}>Remove</button>}</td></tr>)}</tbody></table></div>}</div>); }}</Async>
    </Modal>
  );
}
