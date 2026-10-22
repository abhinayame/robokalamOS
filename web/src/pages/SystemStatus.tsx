import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, PageHead, Stat, useFetch } from '../components/ui';
import { fmtDateTime } from '../format';

const dur = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h` : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : `${Math.floor(s / 60)}m`);

export default function SystemStatus() {
  const q = useFetch(() => api.get('/api/system/status'), []);
  return (
    <>
      <PageHead title="System status" sub="Live health of this deployment: database, traffic, WhatsApp queue, data integrity and configuration. Nothing here shows secrets."
        actions={<button className="btn" onClick={q.reload}>Refresh</button>} />
      <Async q={q}>{(r: any) => {
        const s = r.data; const bad = s.integrity.filter((c: any) => !c.ok);
        const errs = Object.entries(s.traffic.by_status ?? {});
        return (
          <>
            <LiveTests />
            <div className="grid cols-4">
              <Stat label="Database" value={<Badge tone="ok">Reachable</Badge>} sub={`${s.database.latency_ms} ms · pool ${s.database.pool_connections ?? '?'} · waiting ${s.database.pool_waiting ?? 0}`} />
              <Stat label="Migrations" value={s.migrations.pending.length ? <Badge tone="bad">{s.migrations.pending.length} pending</Badge> : <Badge tone="ok">Up to date</Badge>} sub={`${s.migrations.applied}/${s.migrations.available} · ${s.migrations.latest ?? '—'}`} />
              <Stat label="Data integrity" value={s.integrity_ok ? <Badge tone="ok">All clear</Badge> : <Badge tone="bad">{bad.length} problem{bad.length > 1 ? 's' : ''}</Badge>} sub={`${s.integrity.length} checks`} />
              <Stat label="Uptime" value={dur(s.process.uptime_seconds)} sub={`v${s.app.version} · Node ${s.app.node} · ${s.app.environment}`} />
            </div>

            <div className="card" style={{ marginTop: 16 }}>
              <h3>Data integrity checks</h3>
              <div className="table-wrap"><table className="t"><tbody>
                {s.integrity.map((c: any) => <tr key={c.id}><td>{c.label}</td><td className="right">{c.ok ? <Badge tone="ok">0</Badge> : <Badge tone="bad">{c.count}</Badge>}</td></tr>)}
              </tbody></table></div>
              <p className="small muted" style={{ padding: '0 12px 12px' }}>Every count should be zero. A non-zero count means data disagrees with a rule the app promises to keep; check the audit log and contact support before editing data by hand.</p>
            </div>

            <div className="grid cols-2" style={{ marginTop: 16 }}>
              <div className="card">
                <h3>Traffic since start</h3>
                <div className="table-wrap"><table className="t"><tbody>
                  <tr><td>Requests</td><td className="right">{s.traffic.requests.toLocaleString('en-IN')}</td></tr>
                  <tr><td>Responses by class</td><td className="right">{errs.map(([k, v]) => `${k}: ${v}`).join(' · ') || '—'}</td></tr>
                  <tr><td>Latency (p50 / p95 / p99, upper bound)</td><td className="right">{[s.traffic.latency_ms.p50_le, s.traffic.latency_ms.p95_le, s.traffic.latency_ms.p99_le].map((x) => (x == null ? '>5000' : x)).join(' / ')} ms</td></tr>
                  <tr><td>Requests slower than 2 s</td><td className="right">{s.traffic.slow_over_2s}</td></tr>
                  <tr><td>Memory (rss / heap)</td><td className="right">{s.process.memory_mb.rss} / {s.process.memory_mb.heap_used} MB</td></tr>
                </tbody></table></div>
                {s.traffic.last_server_error && <p className="small" style={{ padding: '0 12px 12px' }}>Last server error: <span className="mono">{fmtDateTime(s.traffic.last_server_error.at)} {s.traffic.last_server_error.route}</span>. Quote the request id from the error message to find it in the server log.</p>}
              </div>
              <div className="card">
                <h3>Slowest routes</h3>
                <div className="table-wrap"><table className="t"><thead><tr><th>Route</th><th className="right">Calls</th><th className="right">Avg</th><th className="right">Max</th></tr></thead><tbody>
                  {s.traffic.slowest_routes.map((x: any) => <tr key={x.route}><td className="mono small">{x.route}</td><td className="right">{x.requests}</td><td className="right">{x.avg_ms} ms</td><td className="right">{x.max_ms} ms</td></tr>)}
                  {!s.traffic.slowest_routes.length && <tr><td colSpan={4} className="muted">No traffic recorded yet.</td></tr>}
                </tbody></table></div>
              </div>
            </div>

            <div className="grid cols-2" style={{ marginTop: 16 }}>
              <div className="card">
                <h3>WhatsApp</h3>
                <div className="table-wrap"><table className="t"><tbody>
                  <tr><td>{s.whatsapp.provider === 'meta' ? 'WhatsApp Cloud API (Meta) token' : 'AiSensy API key'}</td><td className="right">{s.whatsapp.configured ? <Badge tone="ok">Set</Badge> : <Badge tone="warn">Not set</Badge>}</td></tr>
                  <tr><td>Webhook secret</td><td className="right">{s.whatsapp.webhook_configured ? <Badge tone="ok">Set</Badge> : <Badge tone="warn">Not set</Badge>}</td></tr>
                  <tr><td>Sending worker</td><td className="right">{s.whatsapp.worker_enabled ? <Badge tone="ok">Running</Badge> : <Badge tone="warn">Off</Badge>}</td></tr>
                  <tr><td>Waiting / in flight / failed unsent</td><td className="right">{s.whatsapp.waiting} / {s.whatsapp.in_flight} / {s.whatsapp.failed_unsent}</td></tr>
                  <tr><td>Last delivery callback</td><td className="right">{s.whatsapp.last_webhook_at ? fmtDateTime(s.whatsapp.last_webhook_at) : 'None yet'}</td></tr>
                </tbody></table></div>
              </div>
              <div className="card">
                <h3>Security &amp; configuration</h3>
                <div className="table-wrap"><table className="t"><tbody>
                  <tr><td>Active sign-in sessions</td><td className="right">{s.security.active_sessions}</td></tr>
                  <tr><td>Failed sign-ins (24 h)</td><td className="right">{s.security.failed_logins_24h}</td></tr>
                </tbody></table></div>
                {s.security.config_findings.length === 0
                  ? <p className="small muted" style={{ padding: '0 12px 12px' }}>No configuration warnings.</p>
                  : <ul className="small" style={{ margin: 0, padding: '0 12px 12px 28px' }}>{s.security.config_findings.map((f: any) => <li key={f.code}><Badge tone={f.level === 'error' ? 'bad' : 'warn'}>{f.code}</Badge> {f.message}</li>)}</ul>}
              </div>
            </div>
            <p className="small muted" style={{ marginTop: 12 }}>Server time {fmtDateTime(s.app.server_time)}. Traffic counters reset when the app restarts.</p>
          </>
        );
      }}</Async>
    </>
  );
}

function LiveTests() {
  const { can } = useAuth(); const [res, setRes] = useState<Record<string, any>>({}); const [busy, setBusy] = useState(''); const [wa, setWa] = useState({ phone: '', campaign_name: '' });
  if (!can('system:test')) return null;
  const run = async (id: string, body?: object) => { setBusy(id); try { setRes((r) => ({ ...r, [id]: (null as any) })); const d = (await api.post(`/api/system/selftest/${id}`, body ?? {})).data; setRes((r) => ({ ...r, [id]: d })); } catch (e: any) { setRes((r) => ({ ...r, [id]: { ok: false, step: 'error', detail: e?.message ?? 'Failed' } })); } finally { setBusy(''); } };
  const row = (id: string, label: string, note: string, extra?: React.ReactNode) => (
    <div className="m-card" style={{ alignItems: 'flex-start' }}><div className="grow"><b>{label}</b><div className="muted small">{note}</div>{extra}
      {res[id] && <div className={res[id].ok ? 'small' : 'err small'} role="status" style={{ marginTop: 6 }}>{res[id].ok ? '✅' : '❌'} {res[id].detail}</div>}</div>
      <button className="btn sm" disabled={!!busy || (id === 'whatsapp' && (wa.phone.length < 8 || wa.campaign_name.length < 2))} onClick={() => run(id, id === 'whatsapp' ? wa : undefined)}>{busy === id ? 'Testing…' : 'Run test'}</button></div>);
  return (
    <div className="card" style={{ marginBottom: 14 }}><div className="card-head"><h2>Live provider tests</h2></div>
      <div className="card-pad muted small">Once the keys are set in Hostinger, press a button to check each provider really works. Each test is harmless and cleans up after itself.</div>
      {row('email', 'E-mail (SMTP)', 'Sends a short test e-mail to your own address.')}
      {row('razorpay', 'Razorpay', 'Creates a Rs 1 payment link, then cancels it. Nobody is charged.')}
      {row('zoom', 'Zoom', 'Creates a meeting for tomorrow, then deletes it.')}
      {row('push', 'Push notifications', 'Sends a test notification to your own devices that allowed them (Account → Turn on notifications).')}
      {row('whatsapp', 'WhatsApp', 'Sends ONE approved template message to the number below. Templates can cost money, so this is never automatic.',
        <div className="row wrap gap-s" style={{ marginTop: 6 }}><input className="input" style={{ maxWidth: 170 }} placeholder="Your mobile" aria-label="Test mobile number" value={wa.phone} onChange={(e) => setWa({ ...wa, phone: e.target.value })} /><input className="input" style={{ maxWidth: 240 }} placeholder="Approved campaign/template name" aria-label="Template name" value={wa.campaign_name} onChange={(e) => setWa({ ...wa, campaign_name: e.target.value })} /></div>)}
    </div>
  );
}
