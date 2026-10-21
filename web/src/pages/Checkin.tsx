import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../api';
import { Empty } from '../components/ui';

/** The page a learner lands on after scanning the class QR code (they are signed in by now). It checks them in straight away. */
export default function Checkin() {
  const { token } = useParams(); const [r, setR] = useState<{ ok: boolean; status?: string; already?: boolean; title?: string; msg?: string } | null>(null);
  useEffect(() => { api.post('/api/checkin', { token }).then((x) => setR({ ok: true, ...x.data })).catch((e) => setR({ ok: false, msg: e?.message ?? 'Could not check you in.' })); }, [token]);
  if (!r) return <div className="card card-pad">Checking you in…</div>;
  return (
    <div className="card" style={{ maxWidth: 480, margin: '40px auto' }}>
      {r.ok ? <Empty icon={r.status === 'present' ? '✅' : r.status === 'late' ? '⏰' : 'ℹ️'} title={r.already ? `Already marked ${r.status}` : r.status === 'late' ? 'You are checked in (late)' : 'You are checked in!'}>{r.title ? `${r.title}. ` : ''}Have a great class.</Empty>
        : <Empty icon="⚠️" title="Could not check you in">{r.msg}</Empty>}
      <div className="card-pad" style={{ textAlign: 'center' }}><Link className="btn primary" to="/classes">My classes</Link></div>
    </div>
  );
}
