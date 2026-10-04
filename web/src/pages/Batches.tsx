import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorState, Field, Modal, PageHead, Pager, Progress, SkeletonRows, StatusBadge, Tabs, fieldErrors, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { DAYS, fmtDate, fmtSchedule } from '../format';

export default function Batches() {
  const { can, activeOrg } = useAuth();
  const [sp, setSp] = useSearchParams();
  const status = sp.get('status') ?? '';
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [page, setPage] = useState(1);
  const [create, setCreate] = useState(false);
  useEffect(() => setPage(1), [status, dq]);
  const list = useFetch(() => api.get(`/api/batches${qs({ q: dq, status, page, page_size: 20, sort: 'name' })}`), [status, dq, page, activeOrg]);
  const rows: any[] = list.data?.data ?? [];
  return (
    <>
      <PageHead title="Batches" sub="Every batch is also a classroom. Learners can belong to as many batches as they need."
        actions={can('batch:create') && <button className="btn primary" onClick={() => setCreate(true)}>＋ New batch</button>} />
      <Tabs value={status || 'all'} onChange={(t) => setSp(t === 'all' ? {} : { status: t })} tabs={[{ id: 'all', label: 'All' }, { id: 'active', label: 'Active' }, { id: 'upcoming', label: 'Upcoming' }, { id: 'completed', label: 'Completed' }, { id: 'archived', label: 'Archived' }]} />
      <div className="card">
        <div className="row" style={{ padding: 12 }}><input className="input" placeholder="Search by name, code or course…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search batches" /></div>
        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonRows n={6} /> : !rows.length ? (
          <Empty icon="🗂️" title={q || status ? 'No batches match' : 'No batches yet'} action={can('batch:create') && !q && !status ? <button className="btn primary" onClick={() => setCreate(true)}>Create the first batch</button> : undefined}>{can('batch:create') ? 'A batch needs a program and course — set those up under Settings first.' : 'You have not been assigned to any batch yet.'}</Empty>
        ) : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Batch</th><th>Course</th><th>Schedule</th><th>Teacher</th><th>Learners</th><th>Dates</th><th>Status</th></tr></thead>
            <tbody>{rows.map((b) => (
              <tr key={b.id}><td><Link to={`/batches/${b.id}`}><b>{b.name}</b></Link><div className="muted mono">{b.batch_code}{b.branch_name ? ` · ${b.branch_name}` : ''}</div></td>
                <td>{b.course_name}<div className="muted small">{b.program_name}</div></td><td className="small">{fmtSchedule(b.schedule)}</td>
                <td>{b.teachers.map((t: any) => t.full_name).join(', ') || <span className="muted">Unassigned</span>}</td>
                <td style={{ minWidth: 110 }}>{b.active_learners}{b.capacity ? ` / ${b.capacity}` : ''}{b.capacity ? <Progress value={(b.active_learners / b.capacity) * 100} tone={b.active_learners >= b.capacity ? 'bad' : ''} /> : null}</td>
                <td className="small nowrap">{fmtDate(b.start_date)} → {fmtDate(b.end_date)}</td><td><StatusBadge s={b.status} /></td></tr>))}</tbody></table></div>)}
        {list.data && <Pager meta={list.data.meta} onPage={setPage} />}
      </div>
      {create && <BatchForm onClose={() => setCreate(false)} onDone={() => { setCreate(false); list.reload(); }} />}
    </>
  );
}

export function BatchForm({ batch, onClose, onDone }: { batch?: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const programs = useFetch(() => api.get('/api/programs').then((r) => r.data as any[]), []);
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const branches = useFetch(() => api.get('/api/branches').then((r) => r.data as any[]), []);
  const teachers = useFetch(() => api.get('/api/teachers?page_size=100').then((r) => r.data as any[]).catch(() => [] as any[]), []);
  const yr = new Date().getFullYear();
  const s = batch?.schedule ?? {};
  const [v, setV] = useState({ name: batch?.name ?? '', program_id: batch?.program_id ?? '', course_id: batch?.course_id ?? '', branch_id: batch?.branch_id ?? '', academic_year: batch?.academic_year ?? `${yr}-${String(yr + 1).slice(2)}`, start_date: batch?.start_date ?? '', end_date: batch?.end_date ?? '', capacity: batch?.capacity ?? '', status: batch?.status ?? 'upcoming', teacher_id: '', days: (s.days ?? []) as number[], start: s.start ?? '', end: s.end ?? '', mode: s.mode ?? 'offline', venue: s.venue ?? '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  const courseList = (courses.data ?? []).filter((c: any) => !v.program_id || c.program_id === v.program_id);

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    const body: any = { name: v.name, program_id: v.program_id, course_id: v.course_id, branch_id: v.branch_id || null, academic_year: v.academic_year, start_date: v.start_date || null, end_date: v.end_date || null, capacity: v.capacity ? Number(v.capacity) : null, status: v.status,
      schedule: { days: v.days, start: v.start || undefined, end: v.end || undefined, mode: v.mode, venue: v.venue || undefined } };
    if (!batch && v.teacher_id) body.teacher_id = v.teacher_id;
    try { batch ? await api.patch(`/api/batches/${batch.id}`, body) : await api.post('/api/batches', body); toast(batch ? 'Batch updated' : 'Batch created'); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return (
    <Modal wide title={batch ? 'Edit batch' : 'New batch'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="batch-form" disabled={busy || !v.name || !v.course_id}>{batch ? 'Save changes' : 'Create batch'}</button></>}>
      <form id="batch-form" onSubmit={submit} className="stack" noValidate>
        <div className="form-grid">
          <Field label="Batch name *" error={errs.name} className="full"><input className="input" value={v.name} onChange={set('name')} placeholder="Robotics Beginner Batch A" autoFocus /></Field>
          <Field label="Program *"><select className="select" value={v.program_id} onChange={(e) => setV({ ...v, program_id: e.target.value, course_id: '' })}><option value="">Choose…</option>{(programs.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
          <Field label="Course *" error={errs.course_id}><select className="select" value={v.course_id} onChange={(e) => { const c = (courses.data ?? []).find((x: any) => x.id === e.target.value); setV({ ...v, course_id: e.target.value, program_id: c?.program_id ?? v.program_id }); }}><option value="">Choose…</option>{courseList.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Branch"><select className="select" value={v.branch_id} onChange={set('branch_id')}><option value="">—</option>{(branches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
          <Field label="Academic year" error={errs.academic_year}><input className="input" value={v.academic_year} onChange={set('academic_year')} /></Field>
          <Field label="Start date"><input className="input" type="date" value={v.start_date} onChange={set('start_date')} /></Field>
          <Field label="End date" error={errs.end_date}><input className="input" type="date" value={v.end_date} onChange={set('end_date')} /></Field>
          <Field label="Capacity" hint="Leave empty for no limit"><input className="input" type="number" min={1} value={v.capacity} onChange={set('capacity')} /></Field>
          <Field label="Status"><select className="select" value={v.status} onChange={set('status')}><option value="upcoming">Upcoming</option><option value="active">Active</option><option value="completed">Completed</option><option value="archived">Archived</option></select></Field>
          {!batch && <Field label="Lead teacher"><select className="select" value={v.teacher_id} onChange={set('teacher_id')}><option value="">Assign later</option>{(teachers.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.full_name}</option>)}</select></Field>}
        </div>
        <h3>Weekly schedule</h3>
        <div className="row wrap" role="group" aria-label="Class days">{DAYS.map((d, i) => <label key={d} className={`btn sm ${v.days.includes(i) ? 'primary' : ''}`}><input type="checkbox" hidden checked={v.days.includes(i)} onChange={() => setV({ ...v, days: v.days.includes(i) ? v.days.filter((x) => x !== i) : [...v.days, i] })} />{d}</label>)}</div>
        <div className="form-grid">
          <Field label="Starts"><input className="input" type="time" value={v.start} onChange={set('start')} /></Field>
          <Field label="Ends" error={errs.schedule}><input className="input" type="time" value={v.end} onChange={set('end')} /></Field>
          <Field label="Mode"><select className="select" value={v.mode} onChange={set('mode')}><option value="offline">Offline</option><option value="online">Online</option><option value="hybrid">Hybrid</option></select></Field>
          <Field label="Venue / notes"><input className="input" value={v.venue} onChange={set('venue')} /></Field>
        </div>
      </form>
    </Modal>
  );
}
