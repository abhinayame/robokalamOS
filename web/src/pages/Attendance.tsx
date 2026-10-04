import { useState } from 'react';
import { api, qs } from '../api';
import { cap, fmtDateTime } from '../format';
import { Async, Badge, Empty, Field, Modal, Stat, useAction, useFetch } from '../components/ui';
import { BarRow } from '../components/Charts';

const TONE: Record<string, string> = { present: 'ok', late: 'warn', absent: 'bad', excused: 'info', scheduled: '', started: 'info', completed: 'ok', cancelled: 'bad' };
const STATUSES = ['present', 'late', 'absent', 'excused'] as const;
const pctText = (p: number | null) => (p == null ? '—' : `${p}%`);

export function JoinButton({ s }: { s: any }) {
  if (!s.has_meeting || s.status === 'cancelled' || s.status === 'completed') return null;
  return s.can_join && s.meeting_url
    ? <a className="btn primary sm" href={s.meeting_url} target="_blank" rel="noopener noreferrer nofollow">▶ Join class</a>
    : <button className="btn sm" disabled title="The link opens 15 minutes before the class">Join class</button>;
}

/** Upcoming classes across a learner's batches. */
export function UpcomingClasses({ learnerId }: { learnerId?: string }) {
  const q = useFetch(() => api.get(`/api/attendance/classes${qs({ learner_id: learnerId })}`).then((r) => r.data as any[]), [learnerId]);
  return (
    <div className="card"><div className="card-head"><h2>Classes</h2></div>
      <Async q={q} rows={3}>{(rows: any[]) => rows.length ? rows.map((s) => (
        <div key={s.id} className="m-card" style={{ alignItems: 'center' }}>
          <div className="grow"><b>{s.title || s.batch_name}</b><div className="muted small">{s.batch_name} · {fmtDateTime(s.starts_at)}{s.cancel_reason ? ` · ${s.cancel_reason}` : ''}</div></div>
          {s.my_status && <Badge tone={TONE[s.my_status]}>{cap(s.my_status)}</Badge>}<Badge tone={TONE[s.status]}>{cap(s.status)}</Badge><JoinButton s={s} />
        </div>)) : <Empty icon="📅" title="No classes scheduled">Scheduled classes appear here with a Join button.</Empty>}</Async></div>
  );
}

/** Per-batch attendance first, then the combined figure, then month by month. */
export function AttendanceSummary({ learnerId }: { learnerId?: string }) {
  const q = useFetch(() => api.get(`/api/attendance/summary${qs({ learner_id: learnerId })}`).then((r) => r.data), [learnerId]);
  return (
    <Async q={q}>{(d: any) => !d.batches.length ? <div className="card"><Empty icon="🗓️" title="No attendance yet">Attendance appears once classes have been marked.</Empty></div> : (
      <div className="stack">
        <div className="grid cols-3">
          <Stat label="Overall attendance" value={pctText(d.overall.pct)} sub="All listed batches combined" />
          <Stat label="Attended" value={d.overall.present + d.overall.late} sub={`${d.overall.late} late`} />
          <Stat label="Absent" value={d.overall.absent} sub={`${d.overall.excused} excused`} />
        </div>
        <div className="card card-pad"><h3 style={{ marginTop: 0 }}>By batch</h3>
          {d.batches.map((b: any) => <BarRow key={b.batch_id} label={b.batch_name} value={b.present + b.late} total={b.present + b.late + b.absent} sub={`${b.present} present · ${b.late} late · ${b.absent} absent · ${b.excused} excused`} />)}</div>
        <div className="card"><div className="card-head"><h2>Month by month</h2></div>
          <div className="table-wrap"><table className="t"><thead><tr><th>Month</th><th>Batch</th><th>Present</th><th>Late</th><th>Absent</th><th>Excused</th><th>%</th></tr></thead>
            <tbody>{[...d.monthly].reverse().map((m: any) => <tr key={m.month + m.batch_id}><td>{m.month}</td><td>{m.batch_name}</td><td>{m.present}</td><td>{m.late}</td><td>{m.absent}</td><td>{m.excused}</td><td><b>{pctText(m.pct)}</b></td></tr>)}</tbody></table></div></div>
      </div>)}</Async>
  );
}

/** Classroom → Attendance tab. */
export default function RoomAttendance({ room }: { room: any }) {
  const [sheet, setSheet] = useState<string | null>(null);
  const [form, setForm] = useState<null | 'one' | 'gen'>(null);
  const [report, setReport] = useState(false);
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/sessions`), [room.id]);
  const { run } = useAction();
  const canEdit = room.can_manage && room.writable;
  const setStatus = (id: string, status: string) => { const cancel_reason = status === 'cancelled' ? prompt('Reason for cancelling (shown to learners and parents):') : undefined; if (status === 'cancelled' && cancel_reason === null) return;
    run(async () => { await api.patch(`/api/classrooms/${room.id}/sessions/${id}`, { status, ...(cancel_reason ? { cancel_reason } : {}) }); q.reload(); }, 'Class updated'); };
  return (
    <div className="stack">
      {room.can_manage && <div className="row wrap">
        {canEdit && <><button className="btn primary" onClick={() => setForm('one')}>＋ Schedule a class</button><button className="btn" onClick={() => setForm('gen')}>Generate from batch schedule</button></>}
        <button className="btn" onClick={() => setReport(true)}>Attendance report</button></div>}
      {!room.can_manage && <AttendanceSummary />}
      <Async q={q as any}>{(d: any) => d.data.length ? (
        <div className="card"><div className="card-head"><h2>Classes</h2></div>{d.data.map((s: any) => (
          <div key={s.id} className="m-card" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="grow"><b>{s.title || 'Class'}</b><div className="muted small">{fmtDateTime(s.starts_at)}{s.ends_at ? ` – ${new Date(s.ends_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}` : ''}{s.cancel_reason ? ` · ${s.cancel_reason}` : ''}</div></div>
            <Badge tone={TONE[s.status]}>{cap(s.status)}</Badge>
            {!room.can_manage && s.my_status && <Badge tone={TONE[s.my_status]}>{cap(s.my_status)}</Badge>}
            {room.can_manage ? <>
              {s.meeting_url && <a className="btn ghost sm" href={s.meeting_url} target="_blank" rel="noopener noreferrer nofollow">Open link</a>}
              {s.status !== 'cancelled' && <button className="btn sm" onClick={() => setSheet(s.id)}>{s.marked ? `Attendance (${s.marked})` : 'Mark attendance'}</button>}
              {canEdit && s.status === 'scheduled' && <button className="btn ghost sm" onClick={() => setStatus(s.id, 'started')}>Start</button>}
              {canEdit && ['scheduled', 'started'].includes(s.status) && <button className="btn ghost sm danger" onClick={() => setStatus(s.id, 'cancelled')}>Cancel</button>}
              {canEdit && s.status === 'cancelled' && <button className="btn ghost sm" onClick={() => setStatus(s.id, 'scheduled')}>Reinstate</button>}
            </> : <JoinButton s={s} />}
          </div>))}</div>
      ) : <div className="card"><Empty icon="📅" title="No classes yet">{canEdit ? 'Schedule a class or generate them from the batch schedule.' : 'Your teacher has not scheduled classes yet.'}</Empty></div>}</Async>
      {form === 'one' && <SessionModal batchId={room.id} onClose={() => setForm(null)} onDone={() => { setForm(null); q.reload(); }} />}
      {form === 'gen' && <GenerateModal batchId={room.id} onClose={() => setForm(null)} onDone={() => { setForm(null); q.reload(); }} />}
      {sheet && <SheetModal room={room} id={sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); q.reload(); }} />}
      {report && <ReportModal room={room} onClose={() => setReport(false)} />}
    </div>
  );
}

function SessionModal({ batchId, onClose, onDone }: { batchId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', start: '', end: '', url: '' });
  const ready = !!f.start;
  return (
    <Modal title="Schedule a class" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ready} onClick={() => run(async () => { await api.post(`/api/classrooms/${batchId}/sessions`, { title: f.title || null, starts_at: new Date(f.start).toISOString(), ends_at: f.end ? new Date(f.end).toISOString() : null, meeting_url: f.url || null }); onDone(); }, 'Class scheduled').catch(() => {})}>Schedule</button></>}>
      <div className="form-grid">
        <Field label="Title (optional)" className="full"><input className="input" maxLength={255} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
        <Field label="Starts"><input className="input" type="datetime-local" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} /></Field>
        <Field label="Ends (optional)"><input className="input" type="datetime-local" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} /></Field>
        <Field label="Meeting link (Google Meet, Zoom …)" hint="Learners can open it from 15 minutes before the start." className="full"><input className="input" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function GenerateModal({ batchId, onClose, onDone }: { batchId: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const today = new Date().toISOString().slice(0, 10);
  const [f, setF] = useState({ from: today, to: new Date(Date.now() + 28 * 86400000).toISOString().slice(0, 10), url: '' });
  return (
    <Modal title="Generate classes from the batch schedule" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(async () => { const r = (await api.post(`/api/classrooms/${batchId}/sessions/generate`, { from: f.from, to: f.to, meeting_url: f.url || null })).data; alert(`${r.created} class(es) created, ${r.skipped} already existed.`); onDone(); }).catch(() => {})}>Generate</button></>}>
      <div className="form-grid">
        <Field label="From"><input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
        <Field label="To"><input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        <Field label="Same meeting link for all (optional)" className="full"><input className="input" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></Field>
      </div>
      <p className="muted small">Uses the days and times set on the batch, in your organization's timezone. Running it again never creates duplicates.</p>
    </Modal>
  );
}

function SheetModal({ room, id, onClose, onDone }: { room: any; id: string; onClose: () => void; onDone: () => void }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/sessions/${id}/attendance`).then((r) => r.data), [id]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const d = q.data;
  const rowsAll: any[] = d?.rows ?? [];
  const status = (r: any) => marks[r.learner_id] ?? r.status ?? '';
  const markAll = (s: string) => setMarks(Object.fromEntries(rowsAll.map((r) => [r.learner_id, s])));
  const entries = rowsAll.filter((r) => marks[r.learner_id] || notes[r.learner_id] !== undefined).map((r) => ({ learner_id: r.learner_id, status: status(r), ...(notes[r.learner_id] !== undefined ? { note: notes[r.learner_id] } : {}) })).filter((e) => e.status);
  const save = () => run(async () => { const r = (await api.put(`/api/classrooms/${room.id}/sessions/${id}/attendance`, { entries })).data; if (r.notified_absent) alert(`Saved. ${r.notified_absent} absence notification(s) sent to learners and parents.`); onDone(); }, 'Attendance saved').catch(() => {});
  return (
    <Modal wide title={d ? `Attendance · ${d.session.title || 'Class'} · ${fmtDateTime(d.session.starts_at)}` : 'Attendance'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !entries.length} onClick={save}>{busy ? 'Saving…' : `Save ${entries.length} mark${entries.length === 1 ? '' : 's'}`}</button></>}>
      <Async q={q}>{() => rowsAll.length ? (
        <div className="stack">
          <div className="row wrap"><span className="muted small">Mark everyone:</span>{STATUSES.map((s) => <button key={s} className="btn sm" onClick={() => markAll(s)}>{cap(s)}</button>)}</div>
          {rowsAll.map((r) => (
            <div key={r.learner_id} className="row wrap" style={{ alignItems: 'center' }}>
              <div style={{ width: 170 }}><b>{r.full_name}</b><div className="muted small">{r.learner_code}</div></div>
              <div className="row gap-s" role="group" aria-label={`Attendance for ${r.full_name}`}>{STATUSES.map((s) => <button key={s} type="button" aria-pressed={status(r) === s} className={`btn sm ${status(r) === s ? 'primary' : ''}`} onClick={() => setMarks({ ...marks, [r.learner_id]: s })}>{cap(s)}</button>)}</div>
              <input className="input grow" style={{ minWidth: 120 }} placeholder="Note (optional)" aria-label={`Note for ${r.full_name}`} defaultValue={r.note ?? ''} onChange={(e) => setNotes({ ...notes, [r.learner_id]: e.target.value })} />
            </div>))}
        </div>) : <Empty icon="👥" title="No learners">Add learners to this batch first.</Empty>}</Async>
    </Modal>
  );
}

function ReportModal({ room, onClose }: { room: any; onClose: () => void }) {
  const [f, setF] = useState({ from: '', to: '' });
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/attendance/report${qs(f)}`).then((r) => r.data), [room.id, f.from, f.to]);
  return (
    <Modal wide title="Attendance report" onClose={onClose}>
      <div className="row wrap" style={{ marginBottom: 10 }}><label className="row small">From <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label><label className="row small">To <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label></div>
      <Async q={q}>{(d: any) => (
        <div className="stack">
          <div className="grid cols-3"><Stat label="Batch attendance" value={pctText(d.batch_pct)} sub="This batch only" /><Stat label="Learners below 75%" value={d.low_count} /><Stat label="Classes counted" value={d.sessions?.filter((s: any) => s.present + s.late + s.absent > 0).length ?? 0} /></div>
          <div className="table-wrap"><table className="t"><thead><tr><th>Learner</th><th>Present</th><th>Late</th><th>Absent</th><th>Excused</th><th>%</th></tr></thead>
            <tbody>{d.learners.map((l: any) => <tr key={l.learner_id}><td>{l.full_name}</td><td>{l.present}</td><td>{l.late}</td><td>{l.absent}</td><td>{l.excused}</td><td><Badge tone={l.low ? 'bad' : 'ok'}>{pctText(l.pct)}</Badge></td></tr>)}
              {!d.learners.length && <tr><td colSpan={6} className="muted">Nothing marked in this period.</td></tr>}</tbody></table></div>
          <p className="muted small" style={{ margin: 0 }}>% = (present + late) ÷ (present + late + absent). Excused classes and unmarked classes are not counted.</p>
        </div>)}</Async>
    </Modal>
  );
}
