import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { cap, fmtDateTime, fmtNum } from '../format';
import { Async, Badge, Empty, Modal, PageHead, Pager, Stat, useAction, useFetch } from '../components/ui';
import { CAMPAIGN_TONE } from './Communication';

const R_TONE: Record<string, string> = { pending: '', queued: 'info', sent: 'info', delivered: 'ok', read: 'ok', failed: 'bad', cancelled: '' };

export default function CampaignDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const [sp] = useSearchParams();
  const q = useFetch(() => api.get(`/api/whatsapp/campaigns/${id}`).then((r) => r.data), [id]);
  const [review, setReview] = useState(sp.get('review') === '1');
  const { busy, run } = useAction();
  const c = q.data;
  // Progress refreshes by itself while messages are going out.
  useEffect(() => { if (!c || !['processing', 'scheduled'].includes(c.status)) return; const t = setInterval(q.reload, 4000); return () => clearInterval(t); }, [c?.status]); // eslint-disable-line
  const act = (path: string, ok: string, ask?: string) => (!ask || confirm(ask)) && run(async () => { await api.post(`/api/whatsapp/campaigns/${id}/${path}`); q.reload(); }, ok);
  return (
    <Async q={q}>{(c: any) => (
      <>
        <PageHead title={c.name} sub={<>{c.template_name} · {c.audience === 'parents' ? 'to parents' : 'to learners'} · created by {c.created_by_name}</>}
          actions={<><Link className="btn sm" to="/communication">All campaigns</Link><Badge tone={CAMPAIGN_TONE[c.status]}>{cap(c.status.replace('_', ' '))}</Badge></>} />
        <div className="stack">
          {c.status === 'draft' && <div className="card card-pad row wrap between"><span>This is a draft. Nothing has been sent.</span>{can('comms:campaign') && <div className="row"><button className="btn primary" onClick={() => setReview(true)}>Review audience & send</button><button className="btn ghost danger" disabled={busy} onClick={() => confirm('Delete this draft?') && run(async () => { await api.del(`/api/whatsapp/campaigns/${id}`); history.back(); }, 'Draft deleted')}>Delete</button></div>}</div>}
          {c.status !== 'draft' && <>
            <div className="grid cols-4"><Stat label="Total recipients" value={fmtNum(c.counts.total)} sub={`${fmtNum(c.unique_learners)} unique learners`} /><Stat label="Successful" value={fmtNum(c.counts.successful)} sub={`${c.counts.delivered + c.counts.read} delivered · ${c.counts.read} read`} /><Stat label="Failed" value={fmtNum(c.counts.failed)} /><Stat label="Pending" value={fmtNum(c.counts.in_progress)} sub={c.counts.cancelled ? `${c.counts.cancelled} cancelled` : undefined} /></div>
            <div className="card card-pad">{c.counts.total > 0 && <div style={{ background: 'var(--line)', borderRadius: 8, height: 10, overflow: 'hidden', display: 'flex' }} role="progressbar" aria-label="Delivery progress" aria-valuenow={Math.round(((c.counts.successful + c.counts.failed + c.counts.cancelled) / c.counts.total) * 100)} aria-valuemin={0} aria-valuemax={100}>
              <div style={{ width: `${(c.counts.successful / c.counts.total) * 100}%`, background: 'var(--ok, #168a5c)' }} /><div style={{ width: `${(c.counts.failed / c.counts.total) * 100}%`, background: 'var(--bad, #c0392b)' }} /></div>}
              <div className="muted small" style={{ marginTop: 6 }}>{c.confirmed_at ? `Confirmed ${fmtDateTime(c.confirmed_at)}` : ''}{c.scheduled_at ? ` · scheduled ${fmtDateTime(c.scheduled_at)}` : ''}{c.finished_at ? ` · finished ${fmtDateTime(c.finished_at)}` : ''} · {fmtNum(c.selected_batches)} batches, {fmtNum(c.batch_memberships)} memberships, {fmtNum(c.duplicates_removed)} duplicate learners removed, {fmtNum(c.skipped)} skipped (no number, opted out or shared number)</div></div>
            {can('comms:campaign') && <div className="row wrap">
              {['scheduled', 'processing'].includes(c.status) && <button className="btn danger" disabled={busy} onClick={() => act('cancel', 'Campaign cancelled', 'Cancel this campaign? Messages not yet sent will not be sent.')}>Cancel campaign</button>}
              {['completed', 'partially_failed', 'failed'].includes(c.status) && c.counts.failed > 0 && <button className="btn" disabled={busy} onClick={() => act('retry-failed', 'Failed messages queued again')}>Retry {c.counts.failed} failed</button>}</div>}
            <Recipients id={c.id} active={['processing', 'scheduled'].includes(c.status)} />
          </>}
        </div>
        {review && <ReviewModal c={c} onClose={() => setReview(false)} onDone={() => { setReview(false); q.reload(); }} />}
      </>)}</Async>
  );
}

/** CAMPAIGN REVIEW: who gets it, who does not and why. Sending needs an explicit confirm. */
function ReviewModal({ c, onClose, onDone }: { c: any; onClose: () => void; onDone: () => void }) {
  const q = useFetch(() => api.post(`/api/whatsapp/campaigns/${c.id}/preview`).then((r) => r.data), [c.id]);
  const { busy, run } = useAction();
  const p = q.data;
  return (
    <Modal wide title="Campaign review" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      <button className="btn primary" disabled={busy || !p?.ready} onClick={() => run(async () => { await api.post(`/api/whatsapp/campaigns/${c.id}/confirm`, { confirm: true, expected_recipients: p.recipients }); onDone(); }, c.scheduled_at ? 'Campaign scheduled' : 'Sending started').catch(() => q.reload())}>{busy ? 'Starting…' : c.scheduled_at ? 'Confirm & schedule' : 'Confirm & send'}</button></>}>
      <Async q={q}>{(p: any) => (
        <div className="stack">
          <div className="summary-grid"><div><b>{fmtNum(p.selected_batches)}</b><span>Selected batches</span></div><div><b>{fmtNum(p.batch_memberships)}</b><span>Batch memberships</span></div><div className="hl"><b>{fmtNum(p.unique_learners)}</b><span>Unique learners</span></div><div><b>{fmtNum(p.duplicates_removed)}</b><span>Duplicates removed</span></div></div>
          <div className="summary-grid"><div><b>{fmtNum(p.with_phone)}</b><span>With a number</span></div><div><b>{fmtNum(p.shared_phone_merged)}</b><span>Shared numbers merged</span></div><div><b>{fmtNum(p.no_phone + p.opted_out)}</b><span>Skipped</span></div><div className="hl"><b>{fmtNum(p.recipients)}</b><span>WhatsApp recipients</span></div></div>
          <div><b>Template:</b> {p.template}</div>
          {p.sample.length > 0 && <div><b>Sample</b>{p.sample.map((s: any, i: number) => <div key={i} className="small muted">{s.learner} · {s.phone} · {s.params.map((x: string) => `“${x}”`).join(', ')}</div>)}</div>}
          {p.warnings.map((w: string) => <div key={w} className="banner">{w}</div>)}
          {!p.configured && <div className="banner" role="alert">WhatsApp is not connected on the server yet, so this cannot be sent.</div>}
          {p.configured && !p.recipients && <div className="banner" role="alert">Nobody can receive this message.</div>}
          <div className="muted small">Nothing is sent until you confirm.</div>
        </div>)}</Async>
    </Modal>
  );
}

function Recipients({ id, active }: { id: string; active: boolean }) {
  const [status, setStatus] = useState(''); const [page, setPage] = useState(1);
  const q = useFetch(() => api.get(`/api/whatsapp/campaigns/${id}/recipients${qs({ status, page })}`), [id, status, page]);
  const [log, setLog] = useState<any>(null);
  useEffect(() => { if (!active) return; const t = setInterval(q.reload, 5000); return () => clearInterval(t); }, [active]); // eslint-disable-line
  return (
    <div className="card"><div className="card-head"><h2>Recipients</h2>
      <select className="select" style={{ width: 150 }} aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All</option>{Object.keys(R_TONE).map((s) => <option key={s} value={s}>{cap(s)}</option>)}</select></div>
      <Async q={q as any}>{(d: any) => d.data.length ? <>
        <div className="table-wrap"><table className="t"><thead><tr><th>Learner</th><th>Number</th><th>Status</th><th>Sent</th><th>Delivered</th><th></th></tr></thead>
          <tbody>{d.data.map((r: any) => <tr key={r.id}><td><Link to={`/learners/${r.learner_id}`}>{r.full_name}</Link></td><td>{r.phone}</td>
            <td><Badge tone={R_TONE[r.status]}>{cap(r.status)}</Badge>{r.last_error && <div className="small" style={{ color: 'var(--bad)' }}>{r.last_error}</div>}{r.status === 'pending' && r.attempts > 0 && <div className="muted small">retry {r.attempts}</div>}</td>
            <td>{r.sent_at ? fmtDateTime(r.sent_at) : '—'}</td><td>{r.delivered_at ? fmtDateTime(r.delivered_at) : '—'}{r.read_at ? ' · read' : ''}</td>
            <td><button className="btn ghost sm" onClick={() => api.get(`/api/whatsapp/recipients/${r.id}/log`).then((x) => setLog({ r, rows: x.data }))}>Log</button></td></tr>)}</tbody></table></div>
        <Pager meta={d.meta} onPage={setPage} /></> : <Empty icon="📭" title="No recipients here">Try another status.</Empty>}</Async>
      {log && <Modal title={`Message log · ${log.r.full_name}`} onClose={() => setLog(null)}>{log.rows.length ? log.rows.map((x: any, i: number) => <div key={i} className="m-card" style={{ padding: '6px 0' }}><div className="grow"><b>{cap(x.event)}</b>{x.error_message && <div className="small" style={{ color: 'var(--bad)' }}>{x.error_code}: {x.error_message}</div>}<div className="muted small">{fmtDateTime(x.created_at)}</div></div></div>) : <Empty icon="📜" title="Nothing logged yet" />}</Modal>}
    </div>
  );
}
