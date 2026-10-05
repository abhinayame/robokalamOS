import { useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { BrandMark, useBrand } from '../brand';
import { Field, useFetch } from '../components/ui';
import { fmtDate } from '../format';

/** Public page: anyone with a certificate's code can check that it is real. Shows only what is printed on it. */
export default function VerifyCertificate() {
  const { code } = useParams(); const nav = useNavigate(); const { brand } = useBrand(); const [typed, setTyped] = useState('');
  const q = useFetch(() => (code ? api.get(`/api/public/verify/${encodeURIComponent(code)}`).then((r) => r.data) : Promise.resolve(null)), [code]);
  return (
    <div className="login-wrap"><div className="card login-card stack" style={{ maxWidth: 520 }}>
      <div className="login-brand"><BrandMark size={brand.logo_url ? 72 : undefined} /><h1>Verify a certificate</h1></div>
      {!code && <form className="stack" onSubmit={(e) => { e.preventDefault(); nav(`/verify/${typed.trim().toUpperCase()}`); }}>
        <Field label="Certificate code" hint="Printed under the QR code, like RKC-7K3P-9QXM."><input className="input" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="RKC-XXXX-XXXX" autoFocus /></Field>
        <button className="btn primary" disabled={typed.trim().length < 8} style={{ justifyContent: 'center' }}>Check</button></form>}
      {code && q.loading && !q.data && !q.error && <p className="muted">Checking…</p>}
      {code && q.error && !q.data ? <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '10px 14px' }}>No certificate with that code was found. Check the code and try again.</div> : null}
      {code && q.data && (
        <div className="stack">
          <div className={`badge ${q.data.valid ? 'ok' : 'bad'}`} style={{ whiteSpace: 'normal', padding: '10px 14px', fontSize: 15 }} role="status">{q.data.valid ? '✔ This certificate is genuine.' : '✖ This certificate has been revoked and is no longer valid.'}</div>
          <dl className="kv"><dt>Awarded to</dt><dd><b>{q.data.recipient_name}</b></dd><dt>Certificate</dt><dd>{q.data.title}</dd>{q.data.course_name && <><dt>Course</dt><dd>{q.data.course_name}</dd></>}{q.data.batch_name && <><dt>Batch</dt><dd>{q.data.batch_name}</dd></>}<dt>Issued by</dt><dd>{q.data.organization}</dd><dt>Issued on</dt><dd>{fmtDate(q.data.issued_on)}</dd></dl>
        </div>)}
      {code && <button className="btn" onClick={() => nav('/verify')}>Check another</button>}
    </div></div>
  );
}
