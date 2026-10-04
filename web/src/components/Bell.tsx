import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';

/** Unread count, refreshed every minute and when the tab regains focus. */
export function Bell() {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => api.get('/api/notifications/unread-count').then((r) => live && setN(r.data.unread)).catch(() => {});
    load();
    const t = setInterval(load, 60_000); const f = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', f); window.addEventListener('rk:notifications', load);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', f); window.removeEventListener('rk:notifications', load); };
  }, []);
  return <Link to="/notifications" className="btn sm" aria-label={n ? `${n} unread notifications` : 'Notifications'} style={{ position: 'relative' }}>🔔{n > 0 && <span className="badge bad" style={{ position: 'absolute', top: -6, right: -6, minWidth: 18, textAlign: 'center' }}>{n > 99 ? '99+' : n}</span>}</Link>;
}
