import { useState } from 'react';
import { Icon } from './Icon';
import { api } from '../api';
import { Badge3D } from './Badge3D';
import { Confetti } from './Celebrate';
import { ShareModal } from './ShareModal';
import { Async, Badge, Empty, Field, Modal, Stat, useAction, useFetch, useToast } from './ui';
import { cap, fmtDate, fmtMoney } from '../format';

const tenure = (m: number) => (m < 1 ? 'Just started' : m < 12 ? `${m} month${m === 1 ? '' : 's'}` : `${Math.floor(m / 12)} year${Math.floor(m / 12) === 1 ? '' : 's'}${m % 12 ? ` ${m % 12} month${m % 12 === 1 ? '' : 's'}` : ''}`);

/** A learner's whole time with the school in one place: every level and batch in order, what was paid at each, badges earned along the way. */
export function Journey({ learnerId, learnerName, canPromote, canShare = true }: { learnerId: string; learnerName: string; canPromote: boolean; canShare?: boolean }) {
  const q = useFetch(() => api.get(`/api/levels/learners/${learnerId}/journey`).then((r) => r.data as any), [learnerId]); const [promote, setPromote] = useState(false); const [done, setDone] = useState<any>(null); const [share, setShare] = useState<any>(null);
  return (
    <Async q={q}>{(j: any) => (
      <div className="stack">
        <div className="grid cols-4"><Stat label="With us for" value={tenure(j.months_with_us)} sub={`since ${fmtDate(j.since)}`} /><Stat label="Current level" value={j.current_level ? `Level ${j.current_level}` : '—'} sub={`${j.levels_finished} finished`} /><Stat label="Certificates" value={j.certificates} /><Stat label="Paid so far" value={fmtMoney(j.fees.paid)} sub={Number(j.fees.discount) > 0 ? `${fmtMoney(j.fees.discount)} given as discounts` : `of ${fmtMoney(j.fees.net)} billed`} /></div>
        {canPromote && <div><button className="btn primary" onClick={() => setPromote(true)}>⬆ Move up a level</button></div>}
        {j.level_badges.length > 0 && <div className="card card-pad"><h2 style={{ margin: '0 0 8px' }}>Level badges</h2><div className="row wrap" style={{ gap: 18 }}>{j.level_badges.map((b: any) => <div key={b.id} className="stack-s" style={{ alignItems: 'center', textAlign: 'center' }}><Badge3D name={b.name} size={76} glyph="trophy" animated /><b className="small">{b.name}</b>{canShare && <button className="btn sm" onClick={() => setShare({ id: b.id, title: b.name })}><Icon name="share" size={15} /> Share</button>}</div>)}</div></div>}
        <div className="card"><div className="card-head"><h2>Levels and batches</h2></div>
          {!j.steps.length ? <Empty icon="🧭" title="Not in a batch yet" /> : <ol className="timeline" style={{ padding: '16px 16px 4px 36px' }}>{j.steps.map((s: any) => (
            <li key={s.id}><div className="row between wrap"><div><b>{s.level_no ? `Level ${s.level_no} · ` : ''}{s.course_name}</b> <Badge tone={s.status === 'active' ? 'ok' : s.status === 'completed' ? 'info' : ''}>{s.status === 'active' ? 'Studying now' : cap(s.status)}</Badge><div className="muted small">{s.batch_name} · {s.program_name}</div></div>
              <div className="right small"><div>{fmtDate(s.joined_at)}{s.left_at ? ` → ${fmtDate(s.left_at)}` : ' → now'}</div>{Number(s.fee_net) > 0 && <div className="muted">{fmtMoney(s.fee_paid)} of {fmtMoney(s.fee_net)} paid{Number(s.fee_discount) > 0 ? ` · ${fmtMoney(s.fee_discount)} off` : ''}</div>}</div></div></li>))}</ol>}</div>
        {promote && <PromoteModal learnerId={learnerId} learnerName={learnerName} onClose={() => setPromote(false)} onDone={(r) => { setPromote(false); setDone(r); q.reload(); }} />}
        {done && <LevelUp r={done} onShare={() => done.badge?.learner_badge_id && setShare({ id: done.badge.learner_badge_id, title: done.badge.name })} onClose={() => setDone(null)} />}
        {share && <ShareModal kind="badge" id={share.id} title={share.title} onClose={() => setShare(null)} />}
      </div>)}</Async>
  );
}

function PromoteModal({ learnerId, learnerName, onClose, onDone }: { learnerId: string; learnerName: string; onClose: () => void; onDone: (r: any) => void }) {
  const { busy, run } = useAction(); const toast = useToast(); const [err, setErr] = useState('');
  const next = useFetch(() => api.get(`/api/levels/learners/${learnerId}/next-batches`).then((r) => r.data as any[]), [learnerId]);
  const plans = useFetch(() => api.get('/api/fees/plans').then((r) => (r.data as any[]).filter((p) => p.status === 'active')).catch(() => [] as any[]), []);
  const presets = useFetch(() => api.get('/api/fees/discount-presets').then((r) => (r.data as any[]).filter((p) => p.active)).catch(() => [] as any[]), []);
  const [to, setTo] = useState(''); const [plan, setPlan] = useState(''); const [preset, setPreset] = useState(''); const [d, setD] = useState({ type: 'percent', value: '', reason: '' });
  const chosen = (next.data ?? []).find((b) => b.id === to);
  const go = () => run(async () => {
    setErr('');
    try { const r = (await api.post(`/api/levels/learners/${learnerId}/promote`, { to_batch_id: to, plan_id: plan || null, discount: plan && Number(d.value) > 0 ? { type: d.type, value: Number(d.value), reason: d.reason || null } : null })).data; toast('Moved up!'); onDone(r); }
    catch (e: any) { setErr(e?.message ?? 'Could not move up.'); throw e; }
  });
  return (
    <Modal wide title={`Move ${learnerName} up a level`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !to} onClick={go}>{busy ? 'Moving…' : 'Move up'}</button></>}>
      <div className="stack">
        <p className="muted small" style={{ margin: 0 }}>This finishes their current batch, puts them in the one you choose, can bill the next level (with a discount), and gives them a “Level complete” badge they can share.</p>
        <Async q={next} rows={2}>{(rows: any[]) => !rows.length ? <Empty icon="📭" title="No open batches to move to">Create the next level's batch first.</Empty> : <div className="pick-list" role="radiogroup" aria-label="Move up to">{rows.map((b) => (
          <label key={b.id} className="pick"><input type="radio" name="to" checked={to === b.id} onChange={() => setTo(b.id)} /><span className="grow"><b>{b.level_no ? `Level ${b.level_no} · ` : ''}{b.course_name}</b> {b.suggested && <Badge tone="ok">Next level</Badge>}<br /><span className="muted small">{b.name} · {b.program_name}</span></span><span className="muted small">{b.seats_left == null ? 'No seat limit' : `${b.seats_left} seat${b.seats_left === 1 ? '' : 's'} left`}</span></label>))}</div>}</Async>
        {(plans.data ?? []).length > 0 && <div className="card card-pad stack"><b>Bill the next level (optional)</b>
          <div className="row wrap"><Field label="Fee plan"><select className="select" value={plan} onChange={(e) => setPlan(e.target.value)}><option value="">Do not bill now</option>{(plans.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.total_amount)}</option>)}</select></Field>
            {plan && (presets.data ?? []).length > 0 && <Field label="Saved discount"><select className="select" value={preset} onChange={(e) => { setPreset(e.target.value); const p = (presets.data ?? []).find((x: any) => x.id === e.target.value); if (p) setD({ type: p.kind, value: String(Number(p.value)), reason: p.name }); }}><option value="">None / custom</option>{(presets.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}</div>
          {plan && <div className="row wrap"><Field label="Discount"><span className="row gap-s"><select className="select" style={{ width: 110 }} value={d.type} onChange={(e) => setD({ ...d, type: e.target.value })}><option value="percent">Percent</option><option value="amount">₹ amount</option></select><input className="input" style={{ width: 100 }} inputMode="decimal" value={d.value} placeholder="0" onChange={(e) => setD({ ...d, value: e.target.value.replace(/[^\d.]/g, '') })} /></span></Field>
            {Number(d.value) > 0 && <Field label="Why?"><input className="input" value={d.reason} maxLength={200} onChange={(e) => setD({ ...d, reason: e.target.value })} placeholder="Loyal learner, sibling…" /></Field>}</div>}</div>}
        {chosen && <p className="muted small" style={{ margin: 0 }}>{learnerName} will join <b>{chosen.name}</b>{plan ? ' and the fee is added to their account' : ''}.</p>}
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

/** The celebration after a learner moves up: confetti, the new badge, and a button to share it as a picture. */
export function LevelUp({ r, onShare, onClose }: { r: any; onShare: () => void; onClose: () => void }) {
  return (
    <Modal title="🎉 Level up!" onClose={onClose} footer={<>{r.badge?.learner_badge_id && <button className="btn" onClick={onShare}><Icon name="share" size={15} /> Share the badge</button>}<button className="btn primary" onClick={onClose}>Done</button></>}>
      <div className="celebrate" style={{ textAlign: 'center' }}><Confetti />
        {r.badge && <div className="pop-in" style={{ display: 'grid', placeItems: 'center' }}><Badge3D name={r.badge.name} size={140} glyph="trophy" animated /></div>}
        <h2 style={{ margin: '8px 0 2px' }}>{r.to.level_no ? `Welcome to Level ${r.to.level_no}!` : `Welcome to ${r.to.course_name}!`}</h2>
        <p className="muted" style={{ margin: 0 }}>{r.badge ? <>They earned <b>{r.badge.name}</b> (+100 XP). </> : null}Now in <b>{r.to.name}</b>.</p>
        {r.fee?.created ? <p className="muted small">Fee added: {fmtMoney(r.fee.net_each)} in instalments.</p> : null}</div>
    </Modal>
  );
}
