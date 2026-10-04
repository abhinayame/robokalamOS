import { useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { friendly } from '../api';
import { useAuth } from '../auth';
import { Field } from '../components/ui';

export default function Login() {
  const { login, offline } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as any;
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
        <div className="login-brand"><div className="brand-mark">R</div><h1>Robokalam Learner OS</h1><p className="muted" style={{ margin: '4px 0 0' }}>One Operating System for Every Learner.</p></div>
        {offline && <div className="badge warn">You’re offline</div>}
        {error && <div className="badge bad" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>{error}</div>}
        <Field label="Email"><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn primary" disabled={busy || !email || !password} type="submit" style={{ justifyContent: 'center' }}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted small" style={{ margin: 0, textAlign: 'center' }}>Forgot your password? Ask your organization administrator to reset it.</p>
      </form>
    </div>
  );
}
