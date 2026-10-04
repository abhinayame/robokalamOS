import { useInstall } from '../brand';
import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Badge, Field, PageHead, useAction } from '../components/ui';

export default function Account() {
  const { me, reload } = useAuth();
  const inst = useInstall();
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [done, setDone] = useState(false);
  const { busy, run } = useAction();
  const weak = next.length > 0 && (next.length < 10 || !/[a-z]/.test(next) || !/[A-Z]/.test(next) || !/\d/.test(next));
  return (
    <>
      <PageHead title="My account" />
      <div className="grid cols-2">
        <div className="card card-pad"><dl className="kv"><dt>Name</dt><dd>{me?.full_name}</dd><dt>Email</dt><dd>{me?.email}</dd><dt>Organization</dt><dd>{me?.organization?.name ?? 'Platform'}</dd><dt>Roles</dt><dd className="chips">{me?.roles.map((r) => <Badge key={r} tone="info">{r.replace('_', ' ')}</Badge>)}</dd></dl></div>
        <form className="card card-pad stack" onSubmit={async (e) => { e.preventDefault(); const r = await run(() => api.post('/api/auth/change-password', { current_password: cur, new_password: next }), 'Password changed'); if (r) { setCur(''); setNext(''); setDone(true); reload(); } }}>
          <h2>Change password</h2>{me?.must_change_password && !done && <Badge tone="warn">Please change your temporary password</Badge>}
          <Field label="Current password"><input className="input" type="password" autoComplete="current-password" value={cur} onChange={(e) => setCur(e.target.value)} /></Field>
          <Field label="New password" error={weak ? 'At least 10 characters with upper case, lower case and a number.' : undefined}><input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
          <button className="btn primary" disabled={busy || !cur || !next || weak}>Update password</button>
        </form>
      </div>
      {!inst.standalone && (inst.canInstall || inst.ios) && (
        <div className="card card-pad stack" style={{ marginTop: 16 }}>
          <h2 style={{ margin: 0 }}>Install the app</h2>
          <p className="muted" style={{ margin: 0 }}>Open it from your home screen like any other app: full screen, quick to start.</p>
          {inst.canInstall ? <div><button className="btn primary" onClick={inst.install}>⬇ Install app</button></div> : <p style={{ margin: 0 }}>On iPhone or iPad: tap the <b>Share</b> button in Safari, then <b>Add to Home Screen</b>.</p>}
        </div>)}
    </>
  );
}
