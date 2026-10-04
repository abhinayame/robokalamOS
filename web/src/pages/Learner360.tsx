import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { FeeLedger } from '../components/Fees';
import { Async, Avatar, Badge, Empty, Field, Modal, PageHead, Pager, StatusBadge, Tabs, fieldErrors, useAction, useFetch, useToast } from '../components/ui';
import { AwardBadgeModal, AwardXpModal, BadgeWall, XpCard, XpHistory } from '../components/Gamify';
import LearnerCrm from '../components/LearnerCrm';
import { TagEditor } from '../components/Crm';
import { AttendanceSummary } from './Attendance';
import { LearnerAnalytics } from '../components/Analytics';
import { ScoreList } from './Grades';
import { AssignmentList } from './MyAssignments';
import { cap, fmtDate, fmtDateTime, fmtMobile, fmtSchedule } from '../format';

type Tab = 'overview' | 'personal' | 'parents' | 'batches' | 'courses' | 'assignments' | 'performance' | 'achievements' | 'attendance' | 'analytics' | 'crm' | 'messages' | 'fees' | 'timeline';

export default function Learner360() {
  const { id } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const { busy, run } = useAction();
  const [tab, setTab] = useState<Tab>('overview');
  const [modal, setModal] = useState<null | 'edit' | 'enroll' | 'parent' | 'transfer' | 'login'>(null);
  const q = useFetch(() => api.get(`/api/learners/${id}`).then((r) => r.data), [id]);
  const staff = can('learner:read');

  return (
    <Async q={q}>{(l: any) => {
      const active = l.memberships.filter((m: any) => m.membership_status === 'active');
      const courses = [...new Map(active.map((m: any) => [m.course_id, m])).values()] as any[];
      const archived = l.status === 'archived';
      return (
        <>
          <PageHead title={l.full_name} sub={<span className="mono">{l.learner_code}</span>}
            actions={staff && <>
              {can('batch:enroll') && !archived && <button className="btn" onClick={() => setModal('enroll')}>Add to batch</button>}
              {can('learner:update') && <button className="btn" onClick={() => setModal('edit')}>Edit profile</button>}
              {can('learner:login') && !l.has_login && !archived && <button className="btn" onClick={() => setModal('login')}>Create login</button>}
              {can('learner:delete') && (archived
                ? <button className="btn" disabled={busy} onClick={() => run(() => api.post(`/api/learners/${l.id}/restore`).then(q.reload), 'Learner restored')}>Restore</button>
                : <button className="btn danger" disabled={busy} onClick={() => { if (confirm(`Archive ${l.full_name}? Their history is kept and they leave all batches.`)) run(() => api.del(`/api/learners/${l.id}`).then(q.reload), 'Learner archived'); }}>Archive</button>)}
            </>} />
          <div className="card card-pad row wrap profile-head" style={{ marginBottom: 16 }}>
            <Avatar name={l.full_name} url={l.photo_url} lg />
            <div className="grow info" style={{ minWidth: 220 }}><div className="row wrap"><h2>{l.full_name}</h2><StatusBadge s={l.status} />{l.has_login && <Badge tone="info">Has login</Badge>}</div>
              <div className="muted">{fmtMobile(l.mobile)} · {l.email ?? 'No email'} · {l.school ?? 'School not set'}{l.location ? ` · ${l.location}` : ''}</div>
              <div className="muted small">Member since {fmtDate(l.enrolled_on)}{l.branch ? ` · ${l.branch.name}` : ''}</div></div>
            <div className="row stats" style={{ gap: 20 }}>
              <div><div className="muted small">Active batches</div><b style={{ fontSize: 22 }}>{l.stats.active_batches}</b></div>
              <div><div className="muted small">Courses</div><b style={{ fontSize: 22 }}>{l.stats.courses}</b></div>
              <div><div className="muted small">Programs</div><b style={{ fontSize: 22 }}>{l.stats.programs}</b></div>
            </div>
          </div>
          {l.tags && <div className="card card-pad"><TagEditor learnerId={l.id} tags={l.tags} onChange={q.reload} /></div>}
          <Tabs value={tab} onChange={setTab} tabs={[
            { id: 'overview', label: 'Overview' }, { id: 'personal', label: 'Personal information' }, { id: 'parents', label: 'Parents', badge: l.parents.length },
            { id: 'batches', label: 'Batches', badge: l.stats.total_batches }, { id: 'courses', label: 'Courses', badge: courses.length }, ...(can('classroom:read') ? [{ id: 'assignments' as Tab, label: 'Assignments' }, { id: 'performance' as Tab, label: 'Performance' }] : []), ...(can('gamification:read') ? [{ id: 'achievements' as Tab, label: 'Achievements' }] : []), ...(can('fee:read') ? [{ id: 'fees' as Tab, label: 'Fees' }] : []), ...(can('crm:read') ? [{ id: 'crm' as Tab, label: 'CRM' }] : []), ...(can('comms:read') ? [{ id: 'messages' as Tab, label: 'Messages' }] : []), ...(can('attendance:read') ? [{ id: 'attendance' as Tab, label: 'Attendance' }, { id: 'analytics' as Tab, label: 'Analytics' }] : []), { id: 'timeline', label: 'Activity timeline' },
          ]} />

          {tab === 'overview' && (
            <div className="grid cols-2">
              <div className="card"><div className="card-head"><h2>Currently learning</h2></div>
                {!active.length ? <Empty icon="🗂️" title="Not in any batch" action={can('batch:enroll') && !archived ? <button className="btn primary" onClick={() => setModal('enroll')}>Add to a batch</button> : undefined}>{archived ? 'Archived learners are removed from all batches.' : 'Add this learner to a batch to start their journey.'}</Empty>
                  : active.map((m: any) => <BatchRow key={m.membership_id} m={m} />)}</div>
              <div className="card"><div className="card-head"><h2>Recent activity</h2><button className="btn sm ghost" onClick={() => setTab('timeline')}>View all</button></div><div className="card-pad"><Timeline learnerId={l.id} pageSize={6} compact /></div></div>
            </div>)}

          {tab === 'personal' && <div className="card card-pad"><dl className="kv">
            <dt>Learner ID</dt><dd className="mono">{l.learner_code}</dd><dt>Full name</dt><dd>{l.full_name}</dd><dt>Mobile</dt><dd>{fmtMobile(l.mobile)}</dd><dt>Email</dt><dd>{l.email ?? '—'}</dd>
            <dt>Date of birth</dt><dd>{fmtDate(l.date_of_birth)}</dd><dt>Gender</dt><dd>{l.gender ? cap(l.gender) : '—'}</dd><dt>School</dt><dd>{l.school ?? '—'}</dd><dt>Location</dt><dd>{l.location ?? '—'}</dd>
            <dt>Branch</dt><dd>{l.branch?.name ?? '—'}</dd><dt>Enrolment date</dt><dd>{fmtDate(l.enrolled_on)}</dd><dt>Status</dt><dd><StatusBadge s={l.status} /></dd>
            {l.login && <><dt>Portal login</dt><dd>{l.login.email} · last seen {fmtDateTime(l.login.last_login_at)}</dd></>}
          </dl></div>}

          {tab === 'parents' && <div className="card"><div className="card-head"><h2>Parents & guardians</h2>{can('parent:manage') && !archived && <button className="btn sm" onClick={() => setModal('parent')}>＋ Link parent</button>}</div>
            {!l.parents.length ? <Empty icon="🧑‍🧒" title="No parent linked">Link a parent so they can follow progress and receive updates.</Empty> : l.parents.map((p: any) => (
              <div key={p.id} className="m-card" style={{ alignItems: 'center' }}><Avatar name={p.full_name} /><div className="grow"><b>{p.full_name}</b> {p.is_primary && <Badge tone="accent">Primary</Badge>} {p.has_login && <Badge tone="info">Has login</Badge>}<div className="muted small">{cap(p.relationship)} · {fmtMobile(p.mobile)} · {p.email ?? 'no email'}</div></div>
                {can('parent:manage') && <button className="btn sm danger" disabled={busy} onClick={() => confirm(`Unlink ${p.full_name}?`) && run(() => api.del(`/api/learners/${l.id}/parents/${p.id}`).then(q.reload), 'Parent unlinked')}>Unlink</button>}</div>))}</div>}

          {tab === 'batches' && <div className="card"><div className="card-head"><h2>Batch memberships</h2><span className="muted small">One profile · {l.stats.total_batches} membership{l.stats.total_batches === 1 ? '' : 's'}</span></div>
            {!l.memberships.length ? <Empty title="No batch history" /> : l.memberships.map((m: any) => (
              <div key={m.membership_id} className="m-card" style={{ alignItems: 'center' }}>
                <div className="grow">{staff ? <Link to={`/batches/${m.batch_id}`}><b>{m.batch_name}</b></Link> : <b>{m.batch_name}</b>} <span className="muted mono">{m.batch_code}</span>
                  <div className="muted small">{m.program_name} › {m.course_name} · {m.academic_year} · {fmtSchedule(m.schedule)}</div>
                  <div className="muted small">Joined {fmtDate(m.joined_at)}{m.left_at ? ` · ${cap(m.membership_status)} ${fmtDate(m.left_at)}${m.left_reason ? ` (${m.left_reason})` : ''}` : ''} · Teacher: {(m.teachers ?? []).map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div>
                <StatusBadge s={m.membership_status} />
                {can('batch:enroll') && m.membership_status === 'active' && <div className="row gap-s">
                  <button className="btn sm" onClick={() => setModal('transfer')}>Move</button>
                  <button className="btn sm danger" disabled={busy} onClick={() => { const reason = prompt(`Remove ${l.full_name} from ${m.batch_name}? Add an optional reason:`); if (reason !== null) run(() => api.del(`/api/learners/${l.id}/batches/${m.batch_id}`, { reason: reason || undefined }).then(q.reload), 'Removed from batch'); }}>Leave</button></div>}
              </div>))}</div>}

          {tab === 'courses' && <div className="card">{!courses.length ? <Empty icon="📚" title="No active courses">Courses appear when the learner is in an active batch.</Empty> : courses.map((c: any) => (
            <div key={c.course_id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{c.course_name}</b><div className="muted small">{c.program_name} · via {active.filter((m: any) => m.course_id === c.course_id).map((m: any) => m.batch_name).join(', ')}</div></div></div>))}</div>}

          {tab === 'messages' && <LearnerMessages learnerId={l.id} />}
          {tab === 'crm' && <LearnerCrm learnerId={l.id} />}
          {tab === 'fees' && <FeeLedger learnerId={l.id} learnerName={l.full_name} staff={{ record: can('payment:record'), manage: can('fee:manage'), refund: can('payment:refund') }} />}
          {tab === 'attendance' && <AttendanceSummary learnerId={l.id} />}
          {tab === 'analytics' && <LearnerAnalytics learnerId={l.id} />}
          {tab === 'achievements' && <Achv l={l} />}
          {tab === 'performance' && <ScoreList learnerId={l.id} />}
          {tab === 'assignments' && <AssignmentList learnerId={l.id} />}
          {tab === 'timeline' && <div className="card card-pad"><Timeline learnerId={l.id} /></div>}

          {modal === 'edit' && <EditLearner l={l} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); toast('Profile updated'); }} />}
          {modal === 'enroll' && <EnrollModal l={l} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); }} />}
          {modal === 'transfer' && <TransferModal l={l} active={active} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); toast('Learner moved'); }} />}
          {modal === 'parent' && <ParentModal l={l} onClose={() => setModal(null)} onDone={() => { setModal(null); q.reload(); toast('Parent linked'); }} />}
          {modal === 'login' && <LoginModal l={l} onClose={() => { setModal(null); q.reload(); }} />}
        </>
      );
    }}</Async>
  );
}

function BatchRow({ m }: { m: any }) {
  const { can } = useAuth();
  return <div className="m-card" style={{ alignItems: 'center' }}><div className="grow">{can('batch:read') ? <Link to={`/batches/${m.batch_id}`}><b>{m.batch_name}</b></Link> : <b>{m.batch_name}</b>}<div className="muted small">{m.course_name} · {fmtSchedule(m.schedule)}</div><div className="muted small">Teacher: {(m.teachers ?? []).map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div><StatusBadge s={m.batch_status} /></div>;
}

function Timeline({ learnerId, pageSize = 20, compact }: { learnerId: string; pageSize?: number; compact?: boolean }) {
  const [page, setPage] = useState(1);
  const q = useFetch(() => api.get(`/api/learners/${learnerId}/timeline${qs({ page, page_size: pageSize })}`), [learnerId, page, pageSize]);
  return <Async q={q} rows={4}>{(r: any) => !r.data.length ? <Empty icon="🕑" title="No activity yet" /> : (
    <>
      <ul className="timeline">{r.data.map((e: any) => <li key={e.id}><div className="when">{fmtDateTime(e.occurred_at)}{e.actor_name ? ` · ${e.actor_name}` : ''}</div><div><b>{e.title}</b></div>{e.description && <div className="muted small">{e.description}</div>}</li>)}</ul>
      {!compact && <Pager meta={r.meta} onPage={setPage} />}
    </>)}</Async>;
}

function EditLearner({ l, onClose, onDone }: { l: any; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const [v, setV] = useState({ full_name: l.full_name, mobile: l.mobile ?? '', email: l.email ?? '', school: l.school ?? '', location: l.location ?? '', date_of_birth: l.date_of_birth ?? '', gender: l.gender ?? '', status: l.status });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    try { await api.patch(`/api/learners/${l.id}`, { ...v, mobile: v.mobile || null, email: v.email || null, school: v.school || null, location: v.location || null, date_of_birth: v.date_of_birth || null, gender: v.gender || null }); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title="Edit profile" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="edit-l" disabled={busy}>Save changes</button></>}>
    <form id="edit-l" onSubmit={submit} className="form-grid" noValidate>
      <Field label="Full name" error={errs.full_name}><input className="input" value={v.full_name} onChange={set('full_name')} /></Field>
      <Field label="Mobile" error={errs.mobile}><input className="input" value={v.mobile} onChange={set('mobile')} /></Field>
      <Field label="Email" error={errs.email}><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>
      <Field label="Date of birth"><input className="input" type="date" value={v.date_of_birth} onChange={set('date_of_birth')} /></Field>
      <Field label="School"><input className="input" value={v.school} onChange={set('school')} /></Field>
      <Field label="Location"><input className="input" value={v.location} onChange={set('location')} /></Field>
      <Field label="Gender"><select className="select" value={v.gender} onChange={set('gender')}><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefer not to say</option></select></Field>
      {can('learner:update') && <Field label="Status"><select className="select" value={v.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>}
    </form>
  </Modal>;
}

function BatchPicker({ exclude, value, onChange, label = 'Batch' }: { exclude: string[]; value: string; onChange: (v: string) => void; label?: string }) {
  const q = useFetch(() => api.get('/api/batches?status=active,upcoming&page_size=100&sort=name').then((r) => r.data as any[]), []);
  const list = (q.data ?? []).filter((b: any) => !exclude.includes(b.id));
  return <Field label={label}><select className="select" value={value} onChange={(e) => onChange(e.target.value)}><option value="">Choose a batch…</option>{list.map((b: any) => <option key={b.id} value={b.id}>{b.name} — {b.course_name} ({b.active_learners}{b.capacity ? `/${b.capacity}` : ''})</option>)}</select></Field>;
}

function EnrollModal({ l, onClose, onDone }: { l: any; onClose: () => void; onDone: () => void }) {
  const [batch, setBatch] = useState('');
  const { busy, run } = useAction();
  const current = l.memberships.filter((m: any) => m.membership_status === 'active').map((m: any) => m.batch_id);
  return <Modal title="Add to batch" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!batch || busy} onClick={async () => { const r = await run(() => api.post(`/api/learners/${l.id}/batches`, { batch_id: batch }), 'Added to batch'); if (r) onDone(); }}>Add to batch</button></>}>
    <div className="stack"><BatchPicker exclude={current} value={batch} onChange={setBatch} /><p className="muted small" style={{ margin: 0 }}>{l.full_name} stays one profile — this simply adds another batch membership.</p></div></Modal>;
}

function TransferModal({ l, active, onClose, onDone }: { l: any; active: any[]; onClose: () => void; onDone: () => void }) {
  const [from, setFrom] = useState(active[0]?.batch_id ?? '');
  const [to, setTo] = useState('');
  const { busy, run } = useAction();
  return <Modal title="Move to another batch" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!from || !to || busy} onClick={async () => { const r = await run(() => api.post(`/api/learners/${l.id}/transfer`, { from_batch_id: from, to_batch_id: to })); if (r) onDone(); }}>Move learner</button></>}>
    <div className="stack"><Field label="Move out of"><select className="select" value={from} onChange={(e) => setFrom(e.target.value)}>{active.map((m: any) => <option key={m.batch_id} value={m.batch_id}>{m.batch_name}</option>)}</select></Field>
      <BatchPicker exclude={[from, ...active.map((m) => m.batch_id)]} value={to} onChange={setTo} label="Move into" /></div></Modal>;
}

function ParentModal({ l, onClose, onDone }: { l: any; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState({ full_name: '', mobile: '', email: '', relationship: 'mother' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    try { await api.post(`/api/learners/${l.id}/parents`, { parent: { ...v, mobile: v.mobile || null, email: v.email || null } }); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title="Link parent" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="link-p" disabled={busy || v.full_name.length < 2}>Link parent</button></>}>
    <form id="link-p" onSubmit={submit} className="form-grid" noValidate>
      <Field label="Name" error={errs['parent.full_name']}><input className="input" value={v.full_name} onChange={set('full_name')} autoFocus /></Field>
      <Field label="Relationship"><select className="select" value={v.relationship} onChange={set('relationship')}><option value="mother">Mother</option><option value="father">Father</option><option value="guardian">Guardian</option></select></Field>
      <Field label="Mobile" error={errs['parent.mobile']} hint="If this mobile already belongs to a parent, that record is reused."><input className="input" value={v.mobile} onChange={set('mobile')} /></Field>
      <Field label="Email"><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>
    </form></Modal>;
}

function LoginModal({ l, onClose }: { l: any; onClose: () => void }) {
  const [email, setEmail] = useState(l.email ?? '');
  const [pw, setPw] = useState<string | null>(null);
  const { busy, run } = useAction();
  return <Modal title="Create learner login" onClose={onClose} footer={pw ? <button className="btn primary" onClick={onClose}>Done</button> : <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!email || busy} onClick={async () => { const r = await run(() => api.post(`/api/learners/${l.id}/login`, { email })); if (r) setPw(r.data.temporary_password); }}>Create login</button></>}>
    {pw ? <div className="stack"><p style={{ margin: 0 }}>Share these details securely. The learner must change the password on first sign-in.</p><div className="card card-pad"><div>Email: <b>{email}</b></div><div>Temporary password: <b className="mono">{pw}</b></div></div><p className="muted small" style={{ margin: 0 }}>This password is shown only once.</p></div>
      : <Field label="Login email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>}</Modal>;
}

function Achv({ l }: { l: any }) {
  const { can } = useAuth();
  const [modal, setModal] = useState<null | 'xp' | 'badge'>(null);
  const [tick, setTick] = useState(0);
  const batches = (l.memberships ?? []).filter((m: any) => m.membership_status === 'active').map((m: any) => ({ id: m.batch_id, name: m.batch_name }));
  const me = { id: l.id, name: l.full_name };
  const done = () => { setModal(null); setTick(tick + 1); };
  return (
    <div className="stack">
      {can('gamification:award') && l.status === 'active' && <div className="row wrap"><button className="btn primary" onClick={() => setModal('xp')}>⚡ Award XP</button><button className="btn" onClick={() => setModal('badge')}>🏅 Award badge</button></div>}
      <XpCard key={`x${tick}`} learnerId={l.id} /><h3 style={{ margin: '4px 0' }}>Achievement wall</h3><BadgeWall key={`b${tick}`} learnerId={l.id} /><XpHistory key={`h${tick}`} learnerId={l.id} />
      {modal === 'xp' && <AwardXpModal batches={batches} fixedLearner={me} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'badge' && <AwardBadgeModal batches={batches} fixedLearner={me} onClose={() => setModal(null)} onDone={done} />}
    </div>
  );
}

function LearnerMessages({ learnerId }: { learnerId: string }) {
  const q = useFetch(() => api.get(`/api/whatsapp/learners/${learnerId}/messages`).then((r) => r.data as any[]), [learnerId]);
  return (
    <div className="card"><div className="card-head"><h2>WhatsApp messages</h2></div>
      <Async q={q} rows={3}>{(rows: any[]) => rows.length ? rows.map((m) => (
        <div key={m.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/communication/campaigns/${m.campaign_id}`}><b>{m.campaign}</b></Link><div className="muted small">{m.phone} · {m.sent_at ? fmtDateTime(m.sent_at) : 'not sent yet'}{m.last_error ? ` · ${m.last_error}` : ''}</div></div><Badge tone={m.status === 'failed' ? 'bad' : ['delivered', 'read'].includes(m.status) ? 'ok' : ''}>{cap(m.status)}</Badge></div>)) : <Empty icon="💬" title="No messages">Campaign messages sent to this learner's family appear here. Siblings sharing a number receive one message, shown on the first child.</Empty>}</Async></div>
  );
}
