import { useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from './ui';

const b64 = (s: string) => { const p = '='.repeat((4 - (s.length % 4)) % 4); const r = atob((s + p).replace(/-/g, '+').replace(/_/g, '/')); return Uint8Array.from([...r].map((c) => c.charCodeAt(0))); };

/** Lets a person allow notifications on THIS device. Hidden when the school has not switched push on or the browser cannot do it. */
export function PushToggle() {
  const toast = useToast(); const [cfg, setCfg] = useState<{ enabled: boolean; public_key: string | null } | null>(null); const [on, setOn] = useState(false); const [busy, setBusy] = useState(false);
  const supported = typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  useEffect(() => {
    if (!supported) return; api.get('/api/push/config').then((r) => setCfg(r.data)).catch(() => undefined);
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => undefined);
  }, [supported]);
  if (!supported || !cfg?.enabled) return null;
  const turnOn = async () => {
    setBusy(true);
    try {
      if ((await Notification.requestPermission()) !== 'granted') { toast('Notifications are blocked. Allow them in your browser settings first.', 'err'); return; }
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(cfg.public_key!) });
      await api.post('/api/push/subscribe', sub.toJSON()); setOn(true); toast('Notifications are on for this device.');
    } catch (e: any) { toast(e?.message ?? 'Could not turn notifications on.', 'err'); } finally { setBusy(false); }
  };
  const turnOff = async () => {
    setBusy(true);
    try { const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.getSubscription(); if (sub) { await api.post('/api/push/unsubscribe', { endpoint: sub.endpoint }); await sub.unsubscribe(); } setOn(false); toast('Notifications are off for this device.'); }
    catch (e: any) { toast(e?.message ?? 'Could not turn notifications off.', 'err'); } finally { setBusy(false); }
  };
  return (
    <div className="card card-pad stack"><h2>Notifications on this device</h2>
      <p className="muted small" style={{ margin: 0 }}>Get a ping for new messages, classes, badges and fee reminders, even when the app is closed. You can turn this off any time.</p>
      <div>{on ? <button className="btn" disabled={busy} onClick={turnOff}>Turn off notifications</button> : <button className="btn primary" disabled={busy} onClick={turnOn}>Turn on notifications</button>}</div>
    </div>
  );
}
