import { useState } from 'react';
import { api } from '../api';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { Async, Badge, Empty, Field, Modal, Progress, useAction, useFetch, useToast } from '../components/ui';

/** Learning paths: courses in a set order; the next one unlocks when the previous one is finished. */
export default function Paths({ manage }: { manage: boolean }) {
  const q = useFetch(() => api.get('/api/lms/paths').then((r) => r.data as any[]), []); const [edit, setEdit] = useState<any>(null); const [assign, setAssign] = useState<any>(null); const [prog, setProg] = useState<any>(null);
  return (
    <>
      <div className="row between wrap" style={{ marginBottom: 10 }}><p className="muted small" style={{ margin: 0, maxWidth: 640 }}>A path is a journey of several courses in order, for example “Week 1 onboarding → Safety → Teaching basics”. Give it to people once; each course unlocks when they finish the one before.</p>
        {manage && <button className="btn primary" onClick={() => setEdit({})}>＋ New path</button>}</div>
      <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="🧭" title="No learning paths yet" action={manage ? <button className="btn primary" onClick={() => setEdit({})}>Create the first path</button> : undefined} /></div> : (
        <div className="grid cols-3">{list.map((p) => (
          <div key={p.id} className="card card-pad stack"><div className="row between"><b style={{ fontSize: 16 }}>{p.title}</b><Badge tone={p.status === 'published' ? 'ok' : ''}>{p.status}</Badge></div>
            {p.summary && <div className="small muted">{p.summary}</div>}<div className="muted small">{p.courses} course{p.courses == 1 ? '' : 's'} · {p.members} on it · {p.finished} finished</div>
            <div className="row gap-s wrap"><button className="btn sm" onClick={() => setProg(p)}>Progress</button>{manage && <><button className="btn sm" onClick={() => setEdit(p)}>Edit</button><button className="btn sm primary" disabled={p.status !== 'published'} onClick={() => setAssign(p)}>Assign</button></>}</div></div>))}</div>)}</Async>
      {edit && <PathModal path={edit} onClose={() => setEdit(null)} onDone={q.reload} />}
      {assign && <AssignPath path={assign} onClose={() => setAssign(null)} onDone={q.reload} />}
      {prog && <PathProgress path={prog} onClose={() => setProg(null)} />}
    </>
  );
}

function PathModal({ path, onClose, onDone }: { path: any; onClose: () => void; onDone: () => void }) {
  const isNew = !path.id; const { busy, run } = useAction(); const [err, setErr] = useState('');
  const courses = useFetch(() => api.get('/api/lms/courses').then((r) => r.data as any[]), []);
  const detail = useFetch(() => (isNew ? Promise.resolve(null) : api.get(`/api/lms/paths/${path.id}`).then((r) => r.data)), [path.id]);
  const [f, setF] = useState<{ title: string; summary: string; status: string; ids: string[] | null }>({ title: path.title ?? '', summary: path.summary ?? '', status: path.status ?? 'draft', ids: isNew ? [] : null });
  const ids = f.ids ?? (detail.data?.steps ?? []).map((s: any) => s.id) as string[]; const name = (id: string) => (courses.data ?? []).find((c: any) => c.id === id)?.title ?? '…';
  const move = (i: number, d: number) => { const a = [...ids]; const j = i + d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j]!, a[i]!]; setF({ ...f, ids: a }); };
  return (
    <Modal wide title={isNew ? 'New learning path' : `Edit · ${path.title}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.title.trim().length < 2 || !ids.length} onClick={() => run(async () => { setErr(''); try {
      if (isNew) await api.post('/api/lms/paths', { title: f.title, summary: f.summary || null, course_ids: ids }); else await api.patch(`/api/lms/paths/${path.id}`, { title: f.title, summary: f.summary || null, status: f.status, course_ids: ids }); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } }, 'Saved.')}>Save</button></>}>
      <div className="stack">
        <Field label="Path name"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <Field label="Short description"><input className="input" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} /></Field>
        {!isNew && <Field label="Status"><select className="select" style={{ width: 180 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></Field>}
        <b>Courses, in order</b>
        <Async q={detail as any} rows={2}>{() => <div className="stack-s">{ids.map((id, i) => <div key={id} className="m-card" style={{ alignItems: 'center' }}><span className="grow">{i + 1}. {name(id)}</span>
          <button className="btn ghost sm" aria-label="Move up" onClick={() => move(i, -1)} disabled={i === 0}>↑</button><button className="btn ghost sm" aria-label="Move down" onClick={() => move(i, 1)} disabled={i === ids.length - 1}>↓</button><button className="btn ghost sm" onClick={() => setF({ ...f, ids: ids.filter((x) => x !== id) })}>Remove</button></div>)}
          <select className="select" aria-label="Add a course" value="" onChange={(e) => e.target.value && setF({ ...f, ids: [...ids, e.target.value] })}><option value="">＋ Add a course…</option>{(courses.data ?? []).filter((c: any) => !ids.includes(c.id)).map((c: any) => <option key={c.id} value={c.id}>{c.title} ({c.status})</option>)}</select></div>}</Async>
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

function AssignPath({ path, onClose, onDone }: { path: any; onClose: () => void; onDone: () => void }) {
  const [batches, setBatches] = useState<string[]>([]); const [sum, setSum] = useState<AudienceSummary | null>(null); const [allStaff, setAllStaff] = useState(false); const [days, setDays] = useState(''); const [preview, setPreview] = useState<any>(null); const { busy, run } = useAction(); const toast = useToast();
  const body = (x: object) => ({ selector: batches.length ? { batch_ids: batches } : undefined, all_staff: allStaff, due_days: days ? Number(days) : undefined, ...x }); const ready = (batches.length > 0 && !!sum?.unique_learners) || allStaff;
  return (
    <Modal wide title={`Assign “${path.title}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={busy || !ready} onClick={() => run(async () => setPreview((await api.post(`/api/lms/paths/${path.id}/assign`, body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !(preview.learners.to_assign + preview.staff.to_assign)} onClick={() => run(async () => { await api.post(`/api/lms/paths/${path.id}/assign`, body({ confirm: true })); toast('Path assigned. They start with the first course.'); onDone(); onClose(); })}>Confirm and assign</button>}</>}>
      <div className="stack">
        <label className="row gap-s"><input type="checkbox" checked={allStaff} onChange={(e) => { setAllStaff(e.target.checked); setPreview(null); }} /> All active staff (only if every course on the path allows staff)</label>
        <b>Learners, by batch</b><BatchSelector value={batches} onChange={(v) => { setBatches(v); setPreview(null); }} onSummary={setSum} />
        <Field label="Days to finish each course after it unlocks (optional)"><input className="input" type="number" min={1} max={365} style={{ width: 120 }} value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); }} /></Field>
        {preview && <div className="card card-pad"><b>Ready to go</b><div className="small"><div>Learners: {preview.learners.to_assign} new{preview.learners.already ? `, ${preview.learners.already} already on it` : ''}</div><div>Staff: {preview.staff.to_assign} new{preview.staff.already ? `, ${preview.staff.already} already on it` : ''}</div></div></div>}
      </div>
    </Modal>
  );
}

function PathProgress({ path, onClose }: { path: any; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/lms/paths/${path.id}/progress`).then((r) => r.data as any), [path.id]);
  return (
    <Modal wide title={`Progress · ${path.title}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <Async q={q}>{(d: any) => !d.rows.length ? <Empty icon="🧭" title="Nobody is on this path yet" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Name</th><th>Courses finished</th></tr></thead><tbody>{d.rows.map((r: any) => <tr key={r.id}><td>{r.name}<br /><span className="muted small">{r.kind === 'staff' ? 'Staff' : 'Learner'}</span></td><td style={{ minWidth: 160 }}><Progress value={Math.round((r.done / r.total) * 100)} tone={r.finished ? 'ok' : ''} /><span className="muted small">{r.done}/{r.total}{r.finished ? ' · finished' : ''}</span></td></tr>)}</tbody></table></div>}</Async>
    </Modal>
  );
}
