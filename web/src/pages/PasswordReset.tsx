import { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { api, friendly } from '../api';
import { BrandMark, useBrand } from '../brand';
import { Field } from '../components/ui';

function Shell({ children }: { children: React.ReactNode }) {
  const { brand } = useBrand();
  return <div className="login-wrap"><div className="card login-card stack"><div className="login-brand"><BrandMark size={brand.logo_url ? 72 : undefined} /><h1>{brand.name}</h1></div>{children}</div></div>;
}

export function ForgotPassword() {
  const [email, setEmail] = useState(''); const [busy, setBusy] = useState(false); const [sent, setSent] = useState(false); const [error, setError] = useState('');
  return (
    <Shell>
      <h2 style={{ margin: 0 }}>Reset your password</h2>
      {sent ? <>
        <div className="badge ok" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>If that e-mail belongs to an account, a reset link is on its way. It works once and expires in 30 minutes.</div>
        <Link to="/login" className="btn" style={{ justifyContent: 'center' }}>Back to sign in</Link></> : (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { await api.post('/api/auth/forgot-password', { email: email.trim() }); setSent(true); } catch (err) { setError(friendly(err)); } finally { setBusy(false); } }} noValidate>
          <p className="muted" style={{ margin: 0 }}>Enter the e-mail you sign in with. We will send you a link to choose a new password.</p>
          {error && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>{error}</div>}
          <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
          <button className="btn primary" disabled={busy || !email.includes('@')} style={{ justifyContent: 'center' }}>{busy ? 'Sending…' : 'Send reset link'}</button>
          <Link to="/login" className="muted small" style={{ textAlign: 'center' }}>Back to sign in</Link>
        </form>)}
    </Shell>
  );
}

export function ResetPassword() {
  const [params] = useSearchParams(); const token = params.get('token') ?? ''; const nav = useNavigate();
  const [valid, setValid] = useState<boolean | null>(null); const [pw, setPw] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [done, setDone] = useState(false);
  useEffect(() => { api.get(`/api/auth/reset-password/check?token=${encodeURIComponent(token)}`).then((r) => setValid(!!r.data.valid)).catch(() => setValid(false)); }, [token]);
  const weak = pw.length > 0 && (pw.length < 10 || !/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw));
  return (
    <Shell>
      <h2 style={{ margin: 0 }}>Choose a new password</h2>
      {valid === null && <p className="muted">Checking your link…</p>}
      {valid === false && !done && <><div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>This link has expired or was already used.</div><Link to="/forgot-password" className="btn primary" style={{ justifyContent: 'center' }}>Get a new link</Link></>}
      {done && <><div className="badge ok" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>Your password was changed. You were signed out everywhere.</div><button className="btn primary" style={{ justifyContent: 'center' }} onClick={() => nav('/login', { replace: true })}>Sign in</button></>}
      {valid && !done && (
        <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(''); try { await api.post('/api/auth/reset-password', { token, new_password: pw }); setDone(true); } catch (err) { setError(friendly(err)); } finally { setBusy(false); } }}>
          {error && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>{error}</div>}
          <Field label="New password" error={weak ? 'At least 10 characters with upper case, lower case and a number.' : undefined}><input className="input" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></Field>
          <button className="btn primary" disabled={busy || !pw || weak} style={{ justifyContent: 'center' }}>{busy ? 'Saving…' : 'Change password'}</button>
        </form>)}
    </Shell>
  );
}
