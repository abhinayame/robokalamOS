import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, Empty, Field, Modal, PageHead, Tabs, useAction, useFetch, useToast } from '../components/ui';
import { cap, fmtDateTime } from '../format';

const TONE: Record<string, string> = { booked: 'info', attended: 'ok', no_show: 'warn', cancelled: '' };
const localInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export default function Demo() {
  const { can } = useAuth(); const manage = can('crm:manage'); const toast = useToast(); const { busy, run } = useAction();
  const [tab, setTab] = useState<'slots' | 'bookings'>('slots'); const [modal, setModal] = useState(false);
  const settings = useFetch(() => api.get('/api/demo/settings').then((r) => r.data), []);
  const slots = useFetch(() => api.get('/api/demo/slots').then((r) => r.data as any[]), []);
  const bookings = useFetch(() => api.get('/api/demo/bookings').then((r) => r.data as any[]), []);
  const reload = () => { slots.reload(); bookings.reload(); };
  return (
    <>
      <PageHead title="Demo classes" sub="Offer free trial classes. Parents book a seat on a public page, and every booking becomes a lead in the CRM." actions={manage ? <button className="btn primary" onClick={() => setModal(true)}>＋ New demo slot</button> : undefined} />
      <Async q={settings}>{(s: any) => (
        <div className="card card-pad stack" style={{ marginBottom: 16 }}>
          <div className="row between wrap">
            <div><b>Public booking page</b> {s.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}<br /><span className="muted small">{s.enabled ? 'Anyone with the link can book a free seat.' : 'Switched off: the page shows nothing until you turn it on.'}</span></div>
            {manage && <label className="row gap-s small"><input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => run(async () => { await api.put('/api/demo/settings', { enabled: e.target.checked }); settings.reload(); }, e.target.checked ? 'Booking page is on.' : 'Booking page is off.')} /> Accept online bookings</label>}
          </div>
          {s.enabled && <div className="row gap-s wrap"><input className="input grow" readOnly value={s.public_url} aria-label="Booking page link" onFocus={(e) => e.currentTarget.select()} /><button className="btn sm" onClick={() => { navigator.clipboard?.writeText(s.public_url); toast('Link copied.'); }}>Copy link</button></div>}
        </div>)}</Async>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'slots', label: 'Upcoming slots' }, { id: 'bookings', label: 'Bookings' }]} />
      {tab === 'slots' && <Async q={slots}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="🎈" title="No demo slots yet">Create a slot, switch the booking page on, and share the link on social media or WhatsApp.</Empty></div> : (
        <div className="stack">{list.map((s) => (
          <div className="card card-pad" key={s.id}><div className="row between wrap">
            <div><b style={{ fontSize: 16 }}>{s.title}</b> {s.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}<br /><span className="muted small">{fmtDateTime(s.starts_at)} · {s.meeting_url ? 'online' : s.location || 'at the centre'} · {s.booked} of {s.capacity} seats booked</span></div>
            {manage && s.status === 'open' && <button className="btn sm" disabled={busy} onClick={() => { if (confirm(`Cancel “${s.title}”? Everyone booked on it is released and a note is added to their lead.`)) run(async () => { await api.patch(`/api/demo/slots/${s.id}`, { status: 'cancelled' }); reload(); }, 'Slot cancelled.'); }}>Cancel slot</button>}
          </div></div>))}</div>)}</Async>}
      {tab === 'bookings' && <div className="card"><Async q={bookings}>{(list: any[]) => !list.length ? <Empty icon="📭" title="No bookings yet" /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Child</th><th>Parent</th><th>Demo</th><th>Status</th><th /></tr></thead><tbody>
          {list.map((b) => <tr key={b.id}><td><Link to={`/learners/${b.learner_id}`}>{b.full_name}</Link><br /><span className="muted small">{b.booked_via === 'public' ? 'Booked online' : 'Booked by staff'}</span></td>
            <td>{b.parent_name ?? '—'}<br /><span className="muted small">{b.parent_mobile ?? ''}</span></td><td>{b.slot_title}<br /><span className="muted small">{fmtDateTime(b.starts_at)}</span></td><td><Badge tone={TONE[b.status]}>{cap(b.status)}</Badge></td>
            <td className="nowrap">{manage && b.status === 'booked' && <><button className="btn sm" disabled={busy} onClick={() => run(async () => { await api.post(`/api/demo/bookings/${b.id}/status`, { status: 'attended' }); reload(); }, 'Marked as attended.')}>Attended</button>{' '}<button className="btn sm" disabled={busy} onClick={() => run(async () => { await api.post(`/api/demo/bookings/${b.id}/status`, { status: 'no_show' }); reload(); }, 'Marked as no-show.')}>No-show</button>{' '}<button className="btn sm" disabled={busy} onClick={() => run(async () => { await api.post(`/api/demo/bookings/${b.id}/status`, { status: 'cancelled' }); reload(); }, 'Booking cancelled.')}>Cancel</button></>}</td></tr>)}
        </tbody></table></div>)}</Async></div>}
      {modal && <SlotModal onClose={() => setModal(false)} onDone={reload} />}
    </>
  );
}

function SlotModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const { busy, run } = useAction(); const [err, setErr] = useState('');
  const tomorrow = new Date(Date.now() + 24 * 3600_000); tomorrow.setHours(11, 0, 0, 0);
  const [f, setF] = useState({ title: 'Free robotics demo class', starts: localInput(tomorrow), minutes: '60', capacity: '10', meeting_url: '', location: '' });
  const valid = f.title.trim().length >= 2 && Number(f.minutes) >= 15 && Number(f.capacity) >= 1;
  return (
    <Modal wide title="New demo slot" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !valid} onClick={() => run(async () => {
      setErr(''); const start = new Date(f.starts);
      try { await api.post('/api/demo/slots', { title: f.title, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + Number(f.minutes) * 60_000).toISOString(), capacity: Number(f.capacity), meeting_url: f.meeting_url || null, location: f.location || null }); toast('Slot created.'); onDone(); onClose(); }
      catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } })}>{busy ? 'Saving…' : 'Create slot'}</button></>}>
      <div className="stack">
        <Field label="Title"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} autoFocus /></Field>
        <div className="row wrap"><Field label="Starts"><input className="input" type="datetime-local" value={f.starts} onChange={(e) => setF({ ...f, starts: e.target.value })} /></Field><Field label="Minutes"><input className="input" style={{ width: 90 }} inputMode="numeric" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value.replace(/\D/g, '') })} /></Field><Field label="Seats"><input className="input" style={{ width: 90 }} inputMode="numeric" value={f.capacity} onChange={(e) => setF({ ...f, capacity: e.target.value.replace(/\D/g, '') })} /></Field></div>
        <Field label="Online link (optional)" hint="Shown only to people who booked."><input className="input" value={f.meeting_url} onChange={(e) => setF({ ...f, meeting_url: e.target.value })} placeholder="https://meet.google.com/…" /></Field>
        <Field label="Or the place (optional)"><input className="input" value={f.location} onChange={(e) => setF({ ...f, location: e.target.value })} placeholder="Robokalam centre, Anna Nagar" /></Field>
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
