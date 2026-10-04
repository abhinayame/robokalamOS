import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Async, Avatar, Badge, Empty, Field, Modal, PageHead, Pager, Progress, Stat, StatusBadge, Tabs, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { cap, fmtDate, fmtDateTime, fmtMobile, fmtSchedule } from '../format';
import { BatchForm } from './Batches';

export default function BatchDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [tab, setTab] = useState<'overview' | 'people'>('overview');
  const [edit, setEdit] = useState(false);
  const q = useFetch(() => api.get(`/api/batches/${id}`).then((r) => r.data), [id]);
  const staff = can('batch:read');
  return <Async q={q}>{(b: any) => (
    <>
      <PageHead title={b.name} sub={<><span className="mono">{b.batch_code}</span> · {b.program_name} › {b.course_name}{b.branch_name ? ` · ${b.branch_name}` : ''}</>} actions={<><StatusBadge s={b.status} />{can('batch:update') && <button className="btn" onClick={() => setEdit(true)}>Edit batch</button>}</>} />
      {staff && <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'people', label: 'People', badge: b.active_learners }]} />}
      {tab === 'overview' && (
        <div className="stack">
          <div className="grid cols-4">
            <Stat label="Active learners" value={b.active_learners} sub={b.capacity ? `of ${b.capacity} seats` : 'No capacity limit'} />
            <Stat label="Left / moved" value={(b.membership_stats?.left ?? 0) + (b.membership_stats?.transferred ?? 0)} sub="Kept in history" />
            <Stat label="Academic year" value={b.academic_year} />
            <Stat label="Teachers" value={b.teachers.length} />
          </div>
          {b.capacity ? <div className="card card-pad"><div className="row between small"><b>Seats</b><span>{b.active_learners} / {b.capacity}</span></div><Progress value={(b.active_learners / b.capacity) * 100} tone={b.active_learners >= b.capacity ? 'bad' : ''} /></div> : null}
          <div className="card card-pad"><dl className="kv"><dt>Schedule</dt><dd>{fmtSchedule(b.schedule)} {b.schedule?.mode && <Badge>{cap(b.schedule.mode)}</Badge>}</dd><dt>Venue</dt><dd>{b.schedule?.venue ?? '—'}</dd><dt>Dates</dt><dd>{fmtDate(b.start_date)} → {fmtDate(b.end_date)}</dd><dt>Teachers</dt><dd>{b.teachers.length ? b.teachers.map((t: any) => `${t.full_name} (${t.role === 'lead' ? 'lead' : 'co-teacher'})`).join(', ') : 'Not assigned'}</dd></dl></div>
          <p className="muted small" style={{ margin: 0 }}>Stream, classwork, attendance, grades and achievements for this batch arrive in the next releases.</p>
        </div>)}
      {tab === 'people' && <People batch={b} onChange={q.reload} />}
      {edit && <BatchForm batch={b} onClose={() => setEdit(false)} onDone={() => { setEdit(false); q.reload(); }} />}
    </>)}</Async>;
}

function People({ batch, onChange }: { batch: any; onChange: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  const toast = useToast();
  const [status, setStatus] = useState('active');
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(false);
  const [addT, setAddT] = useState(false);
  useEffect(() => setPage(1), [dq, status]);
  const list = useFetch(() => api.get(`/api/batches/${batch.id}/learners${qs({ q: dq, status, page, page_size: 25 })}`), [batch.id, dq, status, page]);
  const canEnroll = can('batch:enroll') && !['archived', 'completed'].includes(batch.status);
  return (
    <div className="stack">
      <div className="card"><div className="card-head"><h2>Teachers</h2>{can('batch:assign_teacher') && <button className="btn sm" onClick={() => setAddT(true)}>＋ Assign teacher</button>}</div>
        {!batch.teachers.length ? <Empty icon="🎓" title="No teacher assigned" /> : batch.teachers.map((t: any) => (
          <div key={t.id} className="m-card" style={{ alignItems: 'center' }}><Avatar name={t.full_name} /><div className="grow"><b>{t.full_name}</b></div><Badge tone={t.role === 'lead' ? 'accent' : ''}>{t.role === 'lead' ? 'Lead' : 'Co-teacher'}</Badge>
            {can('batch:assign_teacher') && <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Remove ${t.full_name} from this batch? They will lose access to its learners.`) && run(() => api.del(`/api/batches/${batch.id}/teachers/${t.id}`).then(onChange), 'Teacher removed')}>Remove</button>}</div>))}</div>
      <div className="card">
        <div className="card-head"><h2>Learners</h2><div className="row">{canEnroll && <button className="btn primary sm" onClick={() => setAdd(true)}>＋ Add learners</button>}</div></div>
        <div className="row wrap" style={{ padding: 12 }}><input className="input grow" placeholder="Search learners in this batch…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search learners" />
          <select className="select" style={{ width: 160 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Membership status"><option value="active">Active</option><option value="left">Left</option><option value="transferred">Moved out</option><option value="completed">Completed</option></select></div>
        <Async q={list} rows={5}>{(r: any) => !r.data.length ? <Empty icon="👥" title={dq ? 'No learners match' : `No ${status} learners`} action={canEnroll && status === 'active' && !dq ? <button className="btn primary" onClick={() => setAdd(true)}>Add learners</button> : undefined} /> : (
          <>
            <div className="table-wrap"><table className="t"><thead><tr><th>Learner</th><th>Mobile</th><th>Other batches</th><th>Joined</th><th>Status</th>{canEnroll && <th />}</tr></thead>
              <tbody>{r.data.map((l: any) => (
                <tr key={l.id}><td className="nm"><Link to={`/learners/${l.id}`} className="row" style={{ color: 'inherit' }}><Avatar name={l.full_name} /><span><b>{l.full_name}</b><br /><span className="muted mono">{l.learner_code}</span></span></Link></td>
                  <td>{fmtMobile(l.mobile)}</td><td>{Math.max(0, l.total_active_batches - (l.membership_status === 'active' ? 1 : 0))}</td><td className="small">{fmtDateTime(l.joined_at)}{l.left_at ? <div className="muted">Ended {fmtDate(l.left_at)}</div> : null}</td>
                  <td><StatusBadge s={l.membership_status} /></td>
                  {canEnroll && <td className="right">{l.membership_status === 'active' && <button className="btn sm danger" disabled={busy} onClick={() => { const reason = prompt(`Remove ${l.full_name} from this batch? Optional reason:`); if (reason !== null) run(() => api.del(`/api/batches/${batch.id}/learners`, { learner_ids: [l.id], reason: reason || undefined }).then(() => { list.reload(); onChange(); }), 'Removed from batch'); }}>Remove</button>}</td>}</tr>))}</tbody></table></div>
            <Pager meta={r.meta} onPage={setPage} />
          </>)}</Async>
      </div>
      {add && <AddLearners batch={batch} onClose={() => setAdd(false)} onDone={(msg) => { setAdd(false); toast(msg); list.reload(); onChange(); }} />}
      {addT && <AssignTeacher batch={batch} onClose={() => setAddT(false)} onDone={() => { setAddT(false); onChange(); toast('Teacher assigned'); }} />}
    </div>
  );
}

function AddLearners({ batch, onClose, onDone }: { batch: any; onClose: () => void; onDone: (m: string) => void }) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [picked, setPicked] = useState<Map<string, any>>(new Map());
  const { busy, run } = useAction();
  const res = useFetch(() => api.get(`/api/learners${qs({ q: dq, status: 'active', page_size: 30, sort: 'name' })}`).then((r) => r.data as any[]), [dq]);
  const inBatch = (l: any) => l.batches.some((b: any) => b.id === batch.id);
  const toggle = (l: any) => { const m = new Map(picked); m.has(l.id) ? m.delete(l.id) : m.set(l.id, l); setPicked(m); };
  return <Modal wide title={`Add learners to ${batch.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!picked.size || busy} onClick={async () => { const r = await run(() => api.post(`/api/batches/${batch.id}/learners`, { learner_ids: [...picked.keys()] })); if (r) onDone(`${r.data.joined + r.data.rejoined} learner(s) added${r.data.already_member ? `, ${r.data.already_member} already in the batch` : ''}`); }}>Add {picked.size || ''} learner{picked.size === 1 ? '' : 's'}</button></>}>
    <div className="stack"><input className="input" placeholder="Search by name, ID, mobile or parent…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus aria-label="Search learners" />
      <div className="pick-list"><Async q={res} rows={4}>{(rows: any[]) => !rows.length ? <Empty title="No learners found" /> : <>{rows.map((l) => (
        <label key={l.id} className="pick" style={{ opacity: inBatch(l) ? 0.5 : 1 }}><input type="checkbox" disabled={inBatch(l)} checked={picked.has(l.id)} onChange={() => toggle(l)} /><Avatar name={l.full_name} /><span className="grow"><b>{l.full_name}</b><br /><span className="muted small mono">{l.learner_code} · {fmtMobile(l.mobile)}</span></span>{inBatch(l) ? <Badge tone="ok">Already in batch</Badge> : <span className="muted small">{l.batches.length} batch{l.batches.length === 1 ? '' : 'es'}</span>}</label>))}</>}</Async></div>
      <p className="muted small" style={{ margin: 0 }}>Learners are never duplicated — this adds a membership to their existing profile.{batch.capacity ? ` ${Math.max(batch.capacity - batch.active_learners, 0)} seats left.` : ''}</p></div></Modal>;
}

function AssignTeacher({ batch, onClose, onDone }: { batch: any; onClose: () => void; onDone: () => void }) {
  const teachers = useFetch(() => api.get('/api/teachers?page_size=100&status=active').then((r) => r.data as any[]), []);
  const [t, setT] = useState('');
  const [role, setRole] = useState('co');
  const { busy, run } = useAction();
  const taken = batch.teachers.map((x: any) => x.id);
  return <Modal title="Assign teacher" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!t || busy} onClick={async () => { const r = await run(() => api.post(`/api/batches/${batch.id}/teachers`, { teacher_id: t, role })); if (r) onDone(); }}>Assign</button></>}>
    <div className="stack"><Field label="Teacher"><select className="select" value={t} onChange={(e) => setT(e.target.value)}><option value="">Choose…</option>{(teachers.data ?? []).filter((x: any) => !taken.includes(x.id)).map((x: any) => <option key={x.id} value={x.id}>{x.full_name}</option>)}</select></Field>
      <Field label="Role" hint={role === 'lead' && batch.teachers.some((x: any) => x.role === 'lead') ? 'The current lead becomes a co-teacher.' : undefined}><select className="select" value={role} onChange={(e) => setRole(e.target.value)}><option value="co">Co-teacher</option><option value="lead">Lead teacher</option></select></Field></div></Modal>;
}
