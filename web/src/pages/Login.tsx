import { BrandMark, useBrand } from '../brand';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useEffect } from 'react';
import { api } from '../api';
import { friendly } from '../api';
import { useAuth } from '../auth';
import { Field } from '../components/ui';

export default function Login() {
  const { login, offline } = useAuth();
  const { brand } = useBrand();
  const nav = useNavigate();
  const loc = useLocation() as any;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [canReset, setCanReset] = useState(false);
  useEffect(() => { api.get('/api/auth/capabilities').then((r) => setCanReset(!!r.data.password_reset)).catch(() => undefined); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try { await login(email.trim(), password); nav(loc.state?.from ?? '/', { replace: true }); }
    catch (err) { setError(friendly(err)); }
    finally { setBusy(false); }
  }
  return (
    <div className="login-wrap">
      <form className="card login-card stack" onSubmit={submit} noValidate>
        <div className="login-brand"><BrandMark size={brand.logo_url ? 72 : undefined} /><h1>{brand.name}</h1>{brand.tagline && <p className="muted" style={{ margin: '4px 0 0' }}>{brand.tagline}</p>}</div>
        {offline && <div className="badge warn">You’re offline</div>}
        {error && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>{error}</div>}
        <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn primary" disabled={busy || !email || !password} type="submit" style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>{canReset ? <>Forgot your password? <Link to="/forgot-password">Reset it by e-mail</Link></> : 'Forgot your password? Ask your organization administrator to reset it.'}</p>
      </form>
    </div>
  );
}
