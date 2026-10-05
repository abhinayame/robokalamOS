import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { api, friendly } from '../api';
import { BrandMark, useBrand } from '../brand';
import { Field, useFetch } from '../components/ui';
import { fmtDateTime } from '../format';

/** Public page, no sign-in: a parent picks a free demo seat. */
export default function DemoBooking() {
  const { slug = '' } = useParams(); const { brand } = useBrand();
  const q = useFetch(() => api.get(`/api/public/demo/${encodeURIComponent(slug)}/slots`).then((r) => r.data), [slug]);
  const [slot, setSlot] = useState(''); const [f, setF] = useState({ child_name: '', parent_name: '', mobile: '', email: '', website: '' });
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState<any>(null);
  const valid = slot && f.child_name.trim().length >= 2 && f.parent_name.trim().length >= 2 && f.mobile.replace(/\D/g, '').length >= 10;
  return (
    <div className="login-wrap"><div className="card login-card stack" style={{ maxWidth: 560 }}>
      <div className="login-brand"><BrandMark size={brand.logo_url ? 72 : undefined} /><h1>Book a free demo class</h1>{q.data && <p className="muted" style={{ margin: '4px 0 0' }}>{q.data.organization}</p>}</div>
      {q.error && !q.data && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '10px 14px' }}>Online booking is not available right now. Please contact us directly.</div>}
      {q.loading && !q.data && !q.error && <p className="muted">Loading the available slots…</p>}
      {done && <div className="stack"><div className="badge ok" style={{ whiteSpace: 'normal', padding: '10px 14px', fontSize: 15 }} role="status">✔ Your seat is booked!</div>
        <dl className="kv"><dt>Demo</dt><dd>{done.title}</dd><dt>When</dt><dd>{fmtDateTime(done.starts_at)}</dd>{done.join_url ? <><dt>Join online</dt><dd><a href={done.join_url} target="_blank" rel="noreferrer noopener">{done.join_url}</a></dd></> : done.location ? <><dt>Where</dt><dd>{done.location}</dd></> : null}</dl>
        <p className="muted small" style={{ margin: 0 }}>We will remind you before the class. If you gave an e-mail address, a confirmation is on its way.</p></div>}
      {q.data && !done && (q.data.slots.length === 0 ? <p className="muted">There are no open demo slots right now. Please check back soon.</p> : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { setDone((await api.post(`/api/public/demo/${encodeURIComponent(slug)}/book`, { slot_id: slot, child_name: f.child_name, parent_name: f.parent_name, mobile: f.mobile, email: f.email || null, website: f.website })).data); } catch (err) { setError(friendly(err)); q.reload(); } finally { setBusy(false); } }}>
          <Field label="Choose a time"><div className="stack-s">{q.data.slots.map((s: any) => <label key={s.id} className="card card-pad row gap-s" style={{ cursor: 'pointer', borderColor: slot === s.id ? 'var(--brand)' : undefined }}><input type="radio" name="slot" checked={slot === s.id} onChange={() => setSlot(s.id)} /><span><b>{s.title}</b><br /><span className="muted small">{fmtDateTime(s.starts_at)} · {s.online ? 'online' : s.location || 'at our centre'} · {s.seats_left} seat(s) left</span></span></label>)}</div></Field>
          <Field label="Child's name"><input className="input" value={f.child_name} onChange={(e) => setF({ ...f, child_name: e.target.value })} autoComplete="off" /></Field>
          <Field label="Parent's name"><input className="input" value={f.parent_name} onChange={(e) => setF({ ...f, parent_name: e.target.value })} autoComplete="name" /></Field>
          <Field label="Parent's mobile number"><input className="input" type="tel" inputMode="numeric" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} autoComplete="tel" /></Field>
          <Field label="E-mail (optional)" hint="For the confirmation."><input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" /></Field>
          <div aria-hidden style={{ position: 'absolute', left: -9999, width: 1, height: 1, overflow: 'hidden' }}><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label></div>
          {error && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>{error}</div>}
          <button className="btn primary" disabled={busy || !valid} style={{ justifyContent: 'center' }}>{busy ? 'Booking…' : 'Book my seat'}</button>
          <p className="muted small" style={{ margin: 0 }}>We use these details only to reach you about this class.</p>
        </form>))}
    </div></div>
  );
}
