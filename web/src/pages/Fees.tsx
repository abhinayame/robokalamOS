import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { RecordPaymentModal, todayStr } from '../components/Fees';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, Stat, Tabs, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { cap, fmtDate, fmtDateTime, fmtMobile, fmtMoney, fmtNum } from '../format';

type Tab = 'dues' | 'payments' | 'plans';

export default function Fees() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('dues');
  const summary = useFetch(() => api.get('/api/fees/summary').then((r) => r.data), []);
  return (
    <>
      <PageHead title="Fees" sub="What is owed, what has been collected, and who needs a nudge. Every rupee is tied to an installment and a receipt." />
      <Async q={summary}>{(s: any) => (
        <div className="grid cols-4" style={{ marginBottom: 16 }}>
          <Stat label="Collected this month" value={fmtMoney(s.collected_this_month)} sub={`${fmtNum(s.payments_this_month)} payment(s)`} />
          <Stat label="Outstanding" value={fmtMoney(s.outstanding)} sub={`of ${fmtMoney(s.billed)} billed`} />
          <Stat label="Overdue" value={<span className={Number(s.overdue) > 0 ? 'err' : ''}>{fmtMoney(s.overdue)}</span>} sub={`${fmtNum(s.overdue_learners)} learner(s) · ${fmtNum(s.overdue_installments)} installment(s)`} />
          <Stat label="Collection rate" value={s.collection_rate_pct == null ? '—' : `${s.collection_rate_pct}%`} sub="Collected ÷ billed" />
        </div>)}</Async>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'dues', label: 'Dues' }, { id: 'payments', label: 'Payments' }, ...(can('fee:read') ? [{ id: 'plans' as Tab, label: 'Plans' }] : [])]} />
      {tab === 'dues' && <Dues onChanged={summary.reload} />}
      {tab === 'payments' && <Payments />}
      {tab === 'plans' && <Plans onChanged={summary.reload} />}
    </>
  );
}

function Dues({ onChanged }: { onChanged: () => void }) {
  const { can } = useAuth();
  const [f, setF] = useState({ status: 'overdue', search: '', batch_id: '' });
  const [page, setPage] = useState(1);
  const dq = useDebounced(f.search);
  useEffect(() => setPage(1), [f.status, dq, f.batch_id]);
  const batches = useFetch(() => api.get('/api/batches?page_size=100&sort=name').then((r) => r.data as any[]), []);
  const q = useFetch(() => api.get(`/api/fees/dues${qs({ status: f.status, search: dq, batch_id: f.batch_id, page, page_size: 25 })}`), [f.status, dq, f.batch_id, page]);
  const [pay, setPay] = useState<any>(null);
  const toast = useToast(); const { busy, run } = useAction();
  const link = (d: any) => run(async () => { const r = await api.post('/api/fees/pay-links', { learner_id: d.learner_id, installment_ids: [d.id] }); await navigator.clipboard?.writeText(r.data.short_url).catch(() => undefined); toast('Payment link copied. Paste it into WhatsApp.'); });
  const openFor = async (d: any) => { const l = (await api.get(`/api/fees/learners/${d.learner_id}`)).data; setPay({ d, open: l.fees.filter((x: any) => x.status === 'active').flatMap((x: any) => x.installments.filter((i: any) => i.status === 'pending' || i.status === 'partial')) }); };
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12 }}>
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Search learner name or ID…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} aria-label="Search dues" />
        <select className="select" style={{ width: 160 }} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })} aria-label="Which dues"><option value="overdue">Overdue</option><option value="upcoming">Not yet due</option><option value="all">All unpaid</option></select>
        <select className="select" style={{ width: 200 }} value={f.batch_id} onChange={(e) => setF({ ...f, batch_id: e.target.value })} aria-label="Batch"><option value="">All batches</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
        {can('report:read') && <Link className="btn" to="/reports">Export in Reports</Link>}
      </div>
      <Async q={q}>{(r: any) => !r.data.length ? <Empty icon="🎉" title={f.status === 'overdue' ? 'Nothing overdue' : 'No dues match'}>Great: there is nothing to chase with these filters.</Empty> : (<>
        <div className="table-wrap"><table className="t"><thead><tr><th>Learner</th><th>Installment</th><th>Due</th><th className="right">Balance</th><th>Parent</th><th /></tr></thead><tbody>
          {r.data.map((d: any) => <tr key={d.id}>
            <td><Link to={`/learners/${d.learner_id}`}><b>{d.full_name}</b></Link><br /><span className="muted small">{d.learner_code}{d.batch_name ? ` · ${d.batch_name}` : ''}</span></td>
            <td>{d.label}<br /><span className="muted small">{d.fee_title}</span></td>
            <td className="nowrap">{fmtDate(d.due_date)}<br />{d.days_overdue > 0 ? <Badge tone="bad">{d.days_overdue} day(s) late</Badge> : <span className="muted small">in {Math.abs(d.days_overdue)} day(s)</span>}</td>
            <td className="right"><b>{fmtMoney(d.balance)}</b>{d.status === 'partial' && <div className="muted small">of {fmtMoney(d.amount)}</div>}</td>
            <td className="nowrap small">{fmtMobile(d.parent_mobile)}</td>
            <td className="right nowrap">{can('payment:record') && <><button className="btn sm primary" onClick={() => openFor(d)}>Record payment</button> <button className="btn sm" disabled={busy} onClick={() => link(d)}>Link</button></>}</td></tr>)}
        </tbody></table></div>
        <div className="card-pad small muted">{fmtNum(r.meta.learners)} learner(s) · {fmtMoney(r.meta.balance)} outstanding in this list</div>
        <Pager meta={r.meta} onPage={setPage} /></>)}</Async>
      {pay && <RecordPaymentModal learnerId={pay.d.learner_id} learnerName={pay.d.full_name} open={pay.open.map((i: any) => ({ ...i, balance: Number(i.amount) - Number(i.paid_amount), overdue: String(i.due_date).slice(0, 10) < todayStr() }))} onClose={() => setPay(null)} onDone={() => { q.reload(); onChanged(); }} />}
    </div>
  );
}

function Payments() {
  const { can } = useAuth();
  const [f, setF] = useState({ search: '', method: '', from: '', to: '' });
  const [page, setPage] = useState(1); const dq = useDebounced(f.search);
  useEffect(() => setPage(1), [dq, f.method, f.from, f.to]);
  const q = useFetch(() => api.get(`/api/fees/payments${qs({ search: dq, method: f.method, from: f.from, to: f.to, page, page_size: 25 })}`), [dq, f.method, f.from, f.to, page]);
  const { run } = useAction();
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12 }}>
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Search learner, receipt or reference…" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} aria-label="Search payments" />
        <select className="select" style={{ width: 150 }} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })} aria-label="Method"><option value="">Any method</option>{['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'online', 'other'].map((m) => <option key={m} value={m}>{cap(m)}</option>)}</select>
        <input className="input" type="date" style={{ width: 150 }} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} aria-label="From date" />
        <input className="input" type="date" style={{ width: 150 }} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} aria-label="To date" />
      </div>
      <Async q={q}>{(r: any) => !r.data.length ? <Empty icon="💳" title="No payments found" /> : (<>
        <div className="table-wrap"><table className="t"><thead><tr><th>Receipt</th><th>Date</th><th>Learner</th><th>Method</th><th className="right">Amount</th><th /></tr></thead><tbody>
          {r.data.map((p: any) => <tr key={p.id}><td className="mono">{p.receipt_no}</td><td className="nowrap">{fmtDateTime(p.paid_at)}</td><td><Link to={`/learners/${p.learner_id}`}>{p.full_name}</Link><br /><span className="muted small">{p.learner_code}</span></td>
            <td>{cap(p.method)}{p.provider === 'razorpay' && <> <Badge tone="info">online</Badge></>}{p.reference && <div className="muted small">{p.reference}</div>}</td>
            <td className="right"><b>{fmtMoney(p.amount)}</b>{Number(p.refunded_amount) > 0 && <div className="small err">−{fmtMoney(p.refunded_amount)}</div>}</td>
            <td className="right"><button className="btn sm" onClick={() => run(() => api.getFile(`/api/fees/payments/${p.id}/receipt.pdf`, `${p.receipt_no}.pdf`, true))}>Receipt</button></td></tr>)}
        </tbody></table></div>
        <div className="card-pad small muted">{fmtNum(r.meta.total)} payment(s) · net {fmtMoney(r.meta.net_collected)}{!can('fee:manage') ? '' : ''}</div>
        <Pager meta={r.meta} onPage={setPage} /></>)}</Async>
    </div>
  );
}

function Plans({ onChanged }: { onChanged: () => void }) {
  const { can } = useAuth();
  const q = useFetch(() => api.get('/api/fees/plans').then((r) => r.data as any[]), []);
  const [modal, setModal] = useState<null | 'new' | { assign: any }>(null);
  const { run } = useAction();
  return (
    <div className="card">
      <div className="card-head"><h2>Fee plans</h2>{can('fee:manage') && <button className="btn primary sm" onClick={() => setModal('new')}>＋ New plan</button>}</div>
      <Async q={q}>{(plans: any[]) => !plans.length ? <Empty icon="🧾" title="No fee plans yet" action={can('fee:manage') ? <button className="btn primary" onClick={() => setModal('new')}>Create the first plan</button> : undefined}>A plan is a price split into installments, for example “Robotics term fee: ₹4,000 now, ₹3,000 after 30 days”. Give it to a whole batch in one step.</Empty> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Plan</th><th>Installments</th><th className="right">Total</th><th>Given to</th><th /></tr></thead><tbody>
          {plans.map((p) => <tr key={p.id} style={p.status === 'archived' ? { opacity: 0.6 } : undefined}><td><b>{p.name}</b>{p.status === 'archived' && <> <Badge>Archived</Badge></>}<br /><span className="muted small">{p.description}</span></td>
            <td className="small">{p.items.map((i: any) => <div key={i.id}>{i.label}: {fmtMoney(i.amount)} · day {i.due_days}</div>)}</td><td className="right"><b>{fmtMoney(p.total_amount)}</b></td><td>{fmtNum(p.learners)} learner(s)</td>
            <td className="right nowrap">{can('fee:manage') && p.status === 'active' && <><button className="btn sm primary" onClick={() => setModal({ assign: p })}>Give to batches</button> <button className="btn sm" onClick={() => run(async () => { await api.patch(`/api/fees/plans/${p.id}`, { status: 'archived' }); q.reload(); }, 'Plan archived.')}>Archive</button></>}
              {can('fee:manage') && p.status === 'archived' && <button className="btn sm" onClick={() => run(async () => { await api.patch(`/api/fees/plans/${p.id}`, { status: 'active' }); q.reload(); }, 'Plan restored.')}>Restore</button>}</td></tr>)}
        </tbody></table></div>)}</Async>
      {modal === 'new' && <PlanModal onClose={() => setModal(null)} onDone={q.reload} />}
      {modal && typeof modal === 'object' && <AssignModal plan={modal.assign} onClose={() => setModal(null)} onDone={() => { q.reload(); onChanged(); }} />}
    </div>
  );
}

function PlanModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState(''); const [description, setDescription] = useState('');
  const [items, setItems] = useState([{ label: 'Admission', amount: '', due_days: '0' }]);
  const { busy, run } = useAction(); const toast = useToast();
  const total = items.reduce((s, i) => s + (Number(i.amount) || 0), 0);
  const valid = name.trim().length >= 2 && items.length > 0 && items.every((i) => i.label.trim() && Number(i.amount) > 0);
  return (
    <Modal wide title="New fee plan" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !valid} onClick={() => run(async () => { await api.post('/api/fees/plans', { name, description: description || null, items: items.map((i) => ({ label: i.label, amount: Number(i.amount), due_days: Number(i.due_days) || 0 })) }); toast('Plan created.'); onDone(); onClose(); })}>{busy ? 'Saving…' : `Create plan · ${fmtMoney(total)}`}</button></>}>
      <div className="stack">
        <Field label="Plan name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Robotics term fee" autoFocus /></Field>
        <Field label="Description (optional)"><input className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
        <div><b>Installments</b><p className="muted small" style={{ margin: '2px 0 8px' }}>“Due after” counts days from the start date you choose when giving the plan to learners (0 = on the start date).</p>
          {items.map((it, k) => (
            <div className="row wrap" key={k} style={{ marginBottom: 8 }}>
              <input className="input grow" style={{ minWidth: 140 }} value={it.label} placeholder="Label" aria-label="Installment label" onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, label: e.target.value } : x)))} />
              <input className="input" style={{ width: 120 }} inputMode="decimal" value={it.amount} placeholder="₹ amount" aria-label="Amount" onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, amount: e.target.value.replace(/[^\d.]/g, '') } : x)))} />
              <input className="input" style={{ width: 110 }} inputMode="numeric" value={it.due_days} aria-label="Due after days" title="Due after (days)" onChange={(e) => setItems(items.map((x, j) => (j === k ? { ...x, due_days: e.target.value.replace(/\D/g, '') } : x)))} /><span className="muted small">days</span>
              {items.length > 1 && <button className="btn sm ghost" onClick={() => setItems(items.filter((_, j) => j !== k))} aria-label="Remove installment">✕</button>}
            </div>))}
          <button className="btn sm" onClick={() => setItems([...items, { label: `Installment ${items.length + 1}`, amount: '', due_days: String(items.length * 30) }])}>＋ Add installment</button></div>
      </div>
    </Modal>
  );
}

function AssignModal({ plan, onClose, onDone }: { plan: any; onClose: () => void; onDone: () => void }) {
  const [batches, setBatches] = useState<string[]>([]); const [sum, setSum] = useState<AudienceSummary | null>(null);
  const [start, setStart] = useState(todayStr());
  const [disc, setDisc] = useState({ type: 'percent', value: '' });
  const [tie, setTie] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction(); const toast = useToast();
  const body = (extra: object) => ({ plan_id: plan.id, selector: { batch_ids: batches }, start_date: start, batch_id: tie && batches.length === 1 ? batches[0] : undefined, discount: Number(disc.value) > 0 ? { type: disc.type, value: Number(disc.value) } : undefined, ...extra });
  useEffect(() => setPreview(null), [batches, start, disc.type, disc.value, tie]);
  return (
    <Modal wide title={`Give “${plan.name}” to learners`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={busy || !batches.length || !sum?.unique_learners} onClick={() => run(async () => setPreview((await api.post('/api/fees/assign', body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !preview.to_create} onClick={() => run(async () => { const r = await api.post('/api/fees/assign', body({ confirm: true })); toast(`Fee given to ${r.data.created} learner(s).`); onDone(); onClose(); })}>{busy ? 'Assigning…' : `Assign to ${preview.to_create} learner(s)`}</button>}</>}>
      <div className="stack">
        <BatchSelector value={batches} onChange={setBatches} onSummary={setSum} />
        <div className="row wrap">
          <Field label="Start date" hint="Installments fall due this many days after it."><input className="input" type="date" value={start} onChange={(e) => setStart(e.target.value)} /></Field>
          <Field label="Discount (optional)"><span className="row gap-s"><select className="select" style={{ width: 110 }} value={disc.type} onChange={(e) => setDisc({ ...disc, type: e.target.value })}><option value="percent">Percent</option><option value="amount">₹ amount</option></select><input className="input" style={{ width: 100 }} inputMode="decimal" value={disc.value} onChange={(e) => setDisc({ ...disc, value: e.target.value.replace(/[^\d.]/g, '') })} /></span></Field>
        </div>
        {batches.length === 1 && <label className="row gap-s"><input type="checkbox" checked={tie} onChange={(e) => setTie(e.target.checked)} /> Tie this fee to the selected batch (lets a learner pay the same plan for another batch too)</label>}
        {preview && (
          <div className="summary-grid">
            <div className="hl"><b>{fmtNum(preview.to_create)}</b><span>Learners to bill</span></div>
            <div><b>{fmtMoney(preview.net_each)}</b><span>Each (after discount)</span></div>
            <div><b>{fmtMoney(preview.total_billed)}</b><span>Total billed</span></div>
            <div><b>{fmtNum(preview.already_assigned)}</b><span>Already have it (skipped)</span></div>
          </div>)}
        <p className="muted small" style={{ margin: 0 }}>A learner in several selected batches is billed once. Nothing is created until you confirm.</p>
      </div>
    </Modal>
  );
}
