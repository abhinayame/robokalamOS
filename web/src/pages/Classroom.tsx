import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { fmtDateTime } from '../format';
import { FileLinks, FilePicker, type FileRef } from '../components/Files';
import Grades from './Grades';
import { Async, Avatar, Badge, Empty, Field, Modal, PageHead, StatusBadge, Tabs, fieldErrors, useAction, useFetch } from '../components/ui';

type Tab = 'stream' | 'classwork' | 'grades' | 'people';
const STATE_TONE: Record<string, string> = { upcoming: '', due: 'warn', completed: 'ok', late: 'bad', returned: 'warn' };

export default function Classroom() {
  const { batchId } = useParams();
  const [tab, setTab] = useState<Tab>('stream');
  const q = useFetch(() => api.get(`/api/classrooms/${batchId}`).then((r) => r.data), [batchId]);
  return (
    <Async q={q}>{(r: any) => (
      <>
        <PageHead title={r.name} sub={<>{r.course_name} · {r.program_name} · Teacher: {r.teachers.map((t: any) => t.full_name).join(', ') || 'Not assigned'}</>}
          actions={<><StatusBadge s={r.status} /><Link className="btn sm" to="/classroom">All classrooms</Link></>} />
        {!r.writable && <div className="banner warn" role="status" style={{ marginBottom: 12 }}>This batch is {r.status}, so its classroom is read-only.</div>}
        <Tabs value={tab} onChange={setTab} tabs={[{ id: 'stream', label: 'Stream' }, { id: 'classwork', label: 'Classwork', badge: r.counts.assignments + r.counts.materials }, { id: 'grades', label: 'Grades' }, { id: 'people', label: 'People', badge: r.counts.learners }]} />
        {tab === 'stream' && <Stream room={r} />}
        {tab === 'classwork' && <Classwork room={r} />}
        {tab === 'grades' && <Grades room={r} />}
        {tab === 'people' && <People room={r} />}
      </>
    )}</Async>
  );
}

/* ------------------------------------------------------------------ Stream */
function Stream({ room }: { room: any }) {
  const [page, setPage] = useState(1);
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/stream${qs({ page })}`), [room.id, page]);
  const [compose, setCompose] = useState(false);
  const canPost = room.can_manage && room.writable;
  return (
    <div className="stack">
      {canPost && <div className="card card-pad"><button className="btn" onClick={() => setCompose(true)}>✏️ Announce something to your class</button></div>}
      {compose && <PostModal batchId={room.id} onClose={() => setCompose(false)} onDone={() => { setCompose(false); q.reload(); }} />}
      <Async q={q as any} empty={(d: any) => !d.data.length}>{(d: any) => d.data.length ? <>
        {d.data.map((p: any) => <PostCard key={p.id} p={p} room={room} onChange={q.reload} />)}
        {d.meta.total > page * d.meta.page_size && <button className="btn" onClick={() => setPage(page + 1)}>Next page →</button>}
        {page > 1 && <button className="btn ghost" onClick={() => setPage(page - 1)}>← Previous page</button>}
      </> : <div className="card"><Empty icon="💬" title="Nothing here yet">{canPost ? 'Post an announcement or share classwork to get started.' : 'Your teacher has not posted anything yet.'}</Empty></div>}</Async>
    </div>
  );
}

function PostModal({ batchId, onClose, onDone }: { batchId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ kind: 'announcement', title: '', body: '', url: '', pinned: false, comments_enabled: true });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = async () => {
    setErrs({});
    try { await run(async () => { try { await api.post(`/api/classrooms/${batchId}/posts`, { kind: f.kind, title: f.title || undefined, body: f.body || undefined, url: f.kind === 'link' ? f.url || undefined : undefined, pinned: f.pinned, comments_enabled: f.comments_enabled }); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Posted'); } catch { /* shown */ }
  };
  return (
    <Modal title="New post" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Posting…' : 'Post'}</button></>}>
      <div className="form-grid">
        <Field label="Type"><select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="announcement">Announcement</option><option value="link">Link</option></select></Field>
        <Field label="Title (optional)"><input className="input" maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label={f.kind === 'link' ? 'Note (optional)' : 'Message'} error={errs.body} className="full"><textarea className="textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
        {f.kind === 'link' && <Field label="Link" error={errs.url} className="full"><input className="input" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>}
        <label className="row small"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Pin to top</label>
        <label className="row small"><input type="checkbox" checked={f.comments_enabled} onChange={(e) => setF({ ...f, comments_enabled: e.target.checked })} /> Allow comments</label>
      </div>
    </Modal>
  );
}

function PostCard({ p, room, onChange }: { p: any; room: any; onChange: () => void }) {
  const { busy, run } = useAction();
  const [open, setOpen] = useState(false);
  const del = () => confirm('Delete this post?') && run(async () => { await api.del(`/api/classrooms/${room.id}/posts/${p.id}`); onChange(); }, 'Deleted');
  const pin = () => run(async () => { await api.patch(`/api/classrooms/${room.id}/posts/${p.id}`, { pinned: !p.pinned }); onChange(); });
  const r = p.ref;
  return (
    <div className="card card-pad">
      <div className="row"><Avatar name={p.author.name} /><div className="grow"><b>{p.author.name}</b> {p.author.is_staff && <Badge>Teacher</Badge>} {p.pinned && <Badge tone="info">Pinned</Badge>}<div className="muted small">{fmtDateTime(p.created_at)}</div></div>
        {room.can_manage && room.writable && <><button className="btn ghost sm" disabled={busy} onClick={pin}>{p.pinned ? 'Unpin' : 'Pin'}</button><button className="btn ghost sm danger" disabled={busy} onClick={del}>Delete</button></>}</div>
      {p.title && p.kind !== 'assignment' && p.kind !== 'material' && <h3 style={{ margin: '10px 0 0' }}>{p.title}</h3>}
      {p.body && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0' }}>{p.body}</p>}
      {p.url && <p><a href={p.url} target="_blank" rel="noopener noreferrer nofollow">{p.url}</a></p>}
      {r?.type === 'assignment' && <Link to={`/assignments/${r.id}`} className="m-card" style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 8, color: 'inherit' }}>
        <div className="grow"><b>📝 New assignment: {r.title}</b><div className="muted small">{r.due_at ? `Due ${fmtDateTime(r.due_at)}` : 'No due date'} · {r.max_marks} marks</div></div>{r.state && <Badge tone={STATE_TONE[r.state]}>{r.state}</Badge>}</Link>}
      {r?.type === 'material' && <div className="m-card" style={{ border: '1px solid var(--line)', borderRadius: 8, marginTop: 8 }}><div className="grow"><b>📚 New material: {r.title}</b>
        <div style={{ marginTop: 6 }}>{r.external_url && <a href={r.external_url} target="_blank" rel="noopener noreferrer nofollow">Open link</a>}{r.file && <FileLinks files={[r.file]} />}</div></div></div>}
      {p.comments_enabled && <><button className="btn ghost sm" style={{ marginTop: 6 }} onClick={() => setOpen(!open)}>💬 {p.comment_count} comment{p.comment_count === 1 ? '' : 's'}</button>{open && <Comments room={room} postId={p.id} onChange={onChange} />}</>}
    </div>
  );
}

function Comments({ room, postId, onChange }: { room: any; postId: string; onChange: () => void }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/posts/${postId}/comments`).then((r) => r.data), [postId]);
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const can = (room.can_manage || room.can_interact) && room.writable;
  const send = () => text.trim() && run(async () => { await api.post(`/api/classrooms/${room.id}/posts/${postId}/comments`, { body: text }); setText(''); q.reload(); onChange(); });
  return (
    <div style={{ marginTop: 8 }}>
      <Async q={q} rows={2}>{(rows: any[]) => <>{rows.map((c) => (
        <div key={c.id} className="row small" style={{ alignItems: 'flex-start', padding: '6px 0' }}>
          <Avatar name={c.author.name} /><div className="grow"><b>{c.author.name}</b> {c.author.is_staff && <Badge>Teacher</Badge>} <span className="muted">{fmtDateTime(c.created_at)}</span><div style={{ whiteSpace: 'pre-wrap' }}>{c.body}</div></div>
          {c.can_delete && <button className="btn ghost sm" onClick={() => run(async () => { await api.del(`/api/classrooms/${room.id}/comments/${c.id}`); q.reload(); onChange(); })}>✕</button>}
        </div>))}{!rows.length && <div className="muted small">No comments yet.</div>}</>}</Async>
      {can && <div className="row" style={{ marginTop: 6 }}><input className="input" placeholder="Add a class comment…" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && send()} /><button className="btn primary" disabled={busy || !text.trim()} onClick={send}>Send</button></div>}
    </div>
  );
}

/* ------------------------------------------------------------------ Classwork */
function Classwork({ room }: { room: any }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/classwork`).then((r) => r.data), [room.id]);
  const [modal, setModal] = useState<null | 'material' | 'assignment' | 'topic' | 'quiz'>(null);
  const quizzes = useFetch(() => api.get(`/api/quizzes?batch_id=${room.id}`).then((r) => r.data), [room.id]);
  const { run } = useAction();
  const canEdit = room.can_manage && room.writable;
  return (
    <Async q={q}>{(d: any) => {
      const groups = [...d.topics.map((t: any) => ({ ...t })), { id: null, title: 'No topic' }];
      const done = () => { setModal(null); q.reload(); quizzes.reload(); };
      const delTopic = (id: string) => confirm('Delete this topic? Its items are kept under "No topic".') && run(async () => { await api.del(`/api/classrooms/${room.id}/topics/${id}`); q.reload(); }, 'Topic deleted');
      const move = (type: 'material' | 'assignment', id: string, topic_id: string | null) => run(async () => { await api.post(`/api/classrooms/${room.id}/classwork/reorder`, { items: [{ type, id, topic_id, position: 9999 }] }); q.reload(); }, 'Moved');
      const delItem = (type: 'materials' | 'assignments', id: string) => confirm('Delete this item?') && run(async () => { await api.del(`/api/classrooms/${room.id}/${type}/${id}`); q.reload(); }, 'Deleted');
      const total = d.materials.length + d.assignments.length;
      return (
        <div className="stack">
          {canEdit && <div className="row wrap"><button className="btn primary" onClick={() => setModal('assignment')}>＋ Assignment</button><button className="btn" onClick={() => setModal('quiz')}>＋ Quiz</button><button className="btn" onClick={() => setModal('material')}>＋ Material</button><button className="btn" onClick={() => setModal('topic')}>＋ Topic</button></div>}
          {!total && !d.topics.length && <div className="card"><Empty icon="📚" title="No classwork yet">{canEdit ? 'Add materials and assignments for your class.' : 'Your teacher has not added classwork yet.'}</Empty></div>}
          {groups.map((g: any) => {
            const mats = d.materials.filter((m: any) => (m.topic_id ?? null) === g.id);
            const asg = d.assignments.filter((a: any) => (a.topic_id ?? null) === g.id);
            if (g.id === null && !mats.length && !asg.length) return null;
            return (
              <div className="card" key={g.id ?? 'none'}>
                <div className="card-head"><h2>{g.title}</h2>{canEdit && g.id && <button className="btn ghost sm danger" onClick={() => delTopic(g.id)}>Delete topic</button>}</div>
                {!mats.length && !asg.length && <div className="m-card muted small">Nothing in this topic yet.</div>}
                {asg.map((a: any) => (
                  <div className="m-card" key={a.id} style={{ alignItems: 'center' }}>
                    <Link to={`/assignments/${a.id}`} className="grow" style={{ color: 'inherit' }}><b>📝 {a.title}</b><div className="muted small">{a.due_at ? `Due ${fmtDateTime(a.due_at)}` : 'No due date'} · {a.max_marks} marks</div></Link>
                    {room.can_manage ? <Badge tone={a.to_review ? 'warn' : ''}>{a.submitted_count}/{a.learners_total} handed in{a.to_review ? ` · ${a.to_review} to review` : ''}</Badge> : a.state && <Badge tone={STATE_TONE[a.state]}>{a.state}</Badge>}
                    {canEdit && <><MoveSelect topics={d.topics} value={a.topic_id} onChange={(t) => move('assignment', a.id, t)} /><button className="btn ghost sm danger" onClick={() => delItem('assignments', a.id)}>Delete</button></>}
                  </div>))}
                {mats.map((m: any) => (
                  <div className="m-card" key={m.id} style={{ alignItems: 'center' }}>
                    <div className="grow"><b>📚 {m.title}</b>{m.description && <div className="muted small">{m.description}</div>}
                      <div style={{ marginTop: 4 }}>{m.external_url && <a href={m.external_url} target="_blank" rel="noopener noreferrer nofollow">Open {m.kind === 'video' ? 'video' : 'link'}</a>} <FileLinks files={m.files} /></div></div>
                    {canEdit && <><MoveSelect topics={d.topics} value={m.topic_id} onChange={(t) => move('material', m.id, t)} /><button className="btn ghost sm danger" onClick={() => delItem('materials', m.id)}>Delete</button></>}
                  </div>))}
              </div>);
          })}
          {(quizzes.data?.length ?? 0) > 0 && <div className="card"><div className="card-head"><h2>Quizzes</h2></div>{quizzes.data.map((z: any) => (
            <Link key={z.id} to={`/quizzes/${z.id}`} className="m-card" style={{ alignItems: 'center', color: 'inherit' }}>
              <div className="grow"><b>❓ {z.title}</b><div className="muted small">{z.question_count} questions · {z.total_marks} marks{z.time_limit_minutes ? ` · ${z.time_limit_minutes} min` : ''}{z.closes_at ? ` · closes ${fmtDateTime(z.closes_at)}` : ''}</div></div>
              {room.can_manage ? <><Badge tone={z.published ? 'ok' : 'warn'}>{z.published ? 'Published' : 'Draft'}</Badge><Badge>{z.taken} taken</Badge></> : z.my?.attempts ? <Badge tone="ok">Best {z.my.best}/{z.my.max}</Badge> : <Badge>Not taken</Badge>}
            </Link>))}</div>}
          {modal === 'quiz' && <QuizModal batchId={room.id} topics={d.topics} onClose={() => setModal(null)} />}
          {modal === 'topic' && <TopicModal batchId={room.id} onClose={() => setModal(null)} onDone={done} />}
          {modal === 'material' && <MaterialModal batchId={room.id} topics={d.topics} onClose={() => setModal(null)} onDone={done} />}
          {modal === 'assignment' && <AssignmentModal batchId={room.id} topics={d.topics} onClose={() => setModal(null)} onDone={done} />}
        </div>);
    }}</Async>
  );
}

function QuizModal({ batchId, topics, onClose }: { batchId: string; topics: any[]; onClose: () => void }) {
  const nav = useNavigate();
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', instructions: '', time: '', attempts: '1', opens: '', closes: '', reveal: false, topic_id: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); return run(async () => {
    try { const r = await api.post('/api/quizzes', { batch_id: batchId, title: f.title, instructions: f.instructions || null, time_limit_minutes: f.time ? Number(f.time) : null, max_attempts: Number(f.attempts) || 1, opens_at: f.opens ? new Date(f.opens).toISOString() : null, closes_at: f.closes ? new Date(f.closes).toISOString() : null, reveal_answers: f.reveal, topic_id: f.topic_id || null }); nav(`/quizzes/${r.data.id}`); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }).catch(() => {}); };
  return (
    <Modal wide title="New quiz" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Create & add questions</button></>}>
      <div className="form-grid">
        <Field label="Title" error={errs.title} className="full"><input className="input" autoFocus maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Instructions" className="full"><textarea className="textarea" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
        <Field label="Time limit (minutes, optional)"><input className="input" type="number" min={1} value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} /></Field>
        <Field label="Attempts allowed"><input className="input" type="number" min={1} max={20} value={f.attempts} onChange={(e) => setF({ ...f, attempts: e.target.value })} /></Field>
        <Field label="Opens (optional)"><input className="input" type="datetime-local" value={f.opens} onChange={(e) => setF({ ...f, opens: e.target.value })} /></Field>
        <Field label="Closes (optional)" error={errs.closes_at}><input className="input" type="datetime-local" value={f.closes} onChange={(e) => setF({ ...f, closes: e.target.value })} /></Field>
        <Field label="Topic"><select className="select" value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}><option value="">No topic</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={f.reveal} onChange={(e) => setF({ ...f, reveal: e.target.checked })} /> Show correct answers after submitting</label>
      </div>
    </Modal>
  );
}

const MoveSelect = ({ topics, value, onChange }: { topics: any[]; value: string | null; onChange: (t: string | null) => void }) => (
  <select className="select" style={{ width: 130 }} aria-label="Move to topic" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
    <option value="">No topic</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select>
);

function TopicModal({ batchId, onClose, onDone }: { batchId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [title, setTitle] = useState('');
  return (
    <Modal title="New topic" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !title.trim()} onClick={() => run(async () => { await api.post(`/api/classrooms/${batchId}/topics`, { title }); onDone(); }, 'Topic added')}>Add</button></>}>
      <Field label="Topic name"><input className="input" autoFocus maxLength={200} value={title} onChange={(e) => setTitle(e.target.value)} /></Field>
    </Modal>
  );
}

function MaterialModal({ batchId, topics, onClose, onDone }: { batchId: string; topics: any[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', description: '', kind: 'pdf', external_url: '', topic_id: '' });
  const [files, setFiles] = useState<FileRef[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const isLink = f.kind === 'link' || f.kind === 'video';
  const save = () => { setErrs({}); return run(async () => {
    try { await api.post(`/api/classrooms/${batchId}/materials`, { title: f.title, description: f.description || null, kind: f.kind, external_url: isLink ? f.external_url || null : null, file_ids: isLink ? [] : files.map((x) => x.id), topic_id: f.topic_id || null }); onDone(); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Material added'); };
  return (
    <Modal title="Add material" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => save().catch(() => {})}>{busy ? 'Saving…' : 'Add'}</button></>}>
      <div className="form-grid">
        <Field label="Title" error={errs.title} className="full"><input className="input" maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Type"><select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{['pdf', 'ppt', 'doc', 'image', 'link', 'video', 'other'].map((k) => <option key={k} value={k}>{k === 'ppt' ? 'Presentation' : k === 'doc' ? 'Document' : k.charAt(0).toUpperCase() + k.slice(1)}</option>)}</select></Field>
        <Field label="Topic"><select className="select" value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}><option value="">No topic</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        {isLink ? <Field label={f.kind === 'video' ? 'Video link (YouTube, Vimeo …)' : 'Link'} error={errs.external_url} className="full"><input className="input" placeholder="https://" value={f.external_url} onChange={(e) => setF({ ...f, external_url: e.target.value })} /></Field>
          : <Field label="File" hint="PDF, Office documents, images, text. Up to the size limit." className="full"><FilePicker value={files} onChange={setFiles} max={1} /></Field>}
        <Field label="Description (optional)" className="full"><textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function AssignmentModal({ batchId, topics, onClose, onDone }: { batchId: string; topics: any[]; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', description: '', instructions: '', due: '', max_marks: '100', allow_resubmit: false, topic_id: '' });
  const [files, setFiles] = useState<FileRef[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); return run(async () => {
    try { await api.post(`/api/classrooms/${batchId}/assignments`, { title: f.title, description: f.description || null, instructions: f.instructions || null, due_at: f.due ? new Date(f.due).toISOString() : null, max_marks: Number(f.max_marks), allow_resubmit: f.allow_resubmit, topic_id: f.topic_id || null, file_ids: files.map((x) => x.id) }); onDone(); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Assignment posted to the class'); };
  return (
    <Modal wide title="New assignment" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => save().catch(() => {})}>{busy ? 'Posting…' : 'Assign'}</button></>}>
      <div className="form-grid">
        <Field label="Title" error={errs.title} className="full"><input className="input" maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Description" className="full"><textarea className="textarea" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Instructions" className="full"><textarea className="textarea" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></Field>
        <Field label="Due date & time (optional)"><input className="input" type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
        <Field label="Max marks" error={errs.max_marks}><input className="input" type="number" min={1} value={f.max_marks} onChange={(e) => setF({ ...f, max_marks: e.target.value })} /></Field>
        <Field label="Topic"><select className="select" value={f.topic_id} onChange={(e) => setF({ ...f, topic_id: e.target.value })}><option value="">No topic</option>{topics.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field>
        <label className="row small"><input type="checkbox" checked={f.allow_resubmit} onChange={(e) => setF({ ...f, allow_resubmit: e.target.checked })} /> Allow learners to resubmit</label>
        <Field label="Attachments" className="full"><FilePicker value={files} onChange={setFiles} max={10} /></Field>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ People */
function People({ room }: { room: any }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/people`).then((r) => r.data), [room.id]);
  return (
    <Async q={q}>{(d: any) => (
      <div className="stack">
        <div className="card"><div className="card-head"><h2>Teachers</h2></div>{d.teachers.length ? d.teachers.map((t: any) => <div className="m-card" key={t.id} style={{ alignItems: 'center' }}><Avatar name={t.full_name} /><b className="grow">{t.full_name}</b><Badge>{t.role}</Badge></div>) : <div className="m-card muted">No teacher assigned yet.</div>}</div>
        <div className="card"><div className="card-head"><h2>Classmates</h2><span className="muted small">{d.learners.length}</span></div>{d.learners.length ? d.learners.map((l: any) => <div className="m-card" key={l.id} style={{ alignItems: 'center' }}><Avatar name={l.full_name} /><span className="grow">{d.can_manage ? <Link to={`/learners/${l.id}`}>{l.full_name}</Link> : l.full_name}</span>{l.learner_code && <span className="muted small">{l.learner_code}</span>}</div>) : <div className="m-card muted">No learners yet.</div>}</div>
      </div>)}</Async>
  );
}
