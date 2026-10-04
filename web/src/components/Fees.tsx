import { useState } from 'react';
import { api } from '../api';
import { cap, fmtDate, fmtDateTime, fmtMoney } from '../format';
import { Badge, Empty, Field, Modal, Stat, fieldErrors, useAction, useFetch, useToast } from './ui';
import { ApiError } from '../api';

const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']] as const;
/** Today as the person sees it (their own timezone), not the UTC date. */
export const todayStr = () => new Intl.DateTimeFormat('en-CA').format(new Date());
const errText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** Record money received (cash, UPI, cheque…) against what a learner owes. Retrying the same form never records twice. */
export function RecordPaymentModal({ learnerId, learnerName, open, onClose, onDone }: { learnerId: string; learnerName: string; open: any[]; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [requestId] = useState(() => crypto.randomUUID());
  const total = open.reduce((s, i) => s + Number(i.balance), 0);
  const [f, setF] = useState({ amount: total ? String(total) : '', method: 'cash', paid_on: todayStr(), reference: '', note: '' });
  const [picked, setPicked] = useState<string[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const pickedSum = open.filter((i) => picked.includes(i.id)).reduce((s, i) => s + Number(i.balance), 0);
  const submit = () => run(async () => {
    setErrs({});
    try {
      const r = await api.post('/api/fees/payments', { learner_id: learnerId, amount: Number(f.amount), method: f.method, reference: f.reference || null, note: f.note || null, installment_ids: picked.length ? picked : undefined, request_id: requestId, paid_at: f.paid_on !== todayStr() ? new Date(`${f.paid_on}T12:00:00`).toISOString() : undefined });
      toast(`Recorded ${fmtMoney(f.amount)}. Receipt ${r.data.payment.receipt_no}.`); onDone(); onClose();
    } catch (e) { setErrs(fieldErrors(e)); throw e; }
  });
  return (
    <Modal title={`Record payment · ${learnerName}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !Number(f.amount)} onClick={submit}>{busy ? 'Saving…' : `Record ${f.amount ? fmtMoney(f.amount) : ''}`}</button></>}>
      <div className="stack">
        <div className="row wrap">
          <Field label="Amount received (₹)" error={errs.amount}><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} autoFocus /></Field>
          <Field label="How was it paid?" error={errs.method}><select className="select" value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
          <Field label="Paid on" error={errs.paid_at}><input className="input" type="date" max={todayStr()} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
        </div>
        <Field label="Reference (UPI id, cheque no.)"><input className="input" value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        {open.length > 0 && (
          <div>
            <b className="small">Apply to</b>
            <p className="muted small" style={{ margin: '2px 0 6px' }}>{picked.length ? `Only the ${picked.length} installment(s) ticked below (${fmtMoney(pickedSum)} due).` : 'Nothing ticked: the money goes to the oldest dues first.'}</p>
            <div className="pick-list">{open.map((i) => (
              <label key={i.id} className="pick"><input type="checkbox" checked={picked.includes(i.id)} onChange={() => setPicked(picked.includes(i.id) ? picked.filter((x) => x !== i.id) : [...picked, i.id])} />
                <span className="grow"><b>{i.label}</b><br /><span className="muted small">Due {fmtDate(i.due_date)}{i.overdue ? ' · overdue' : ''}</span></span><span className="nowrap">{fmtMoney(i.balance)}</span></label>))}</div>
          </div>)}
        {errs.installment_ids && <p className="err">{errs.installment_ids}</p>}
      </div>
    </Modal>
  );
}

function SimpleForm({ title, onClose, onSubmit, cta, children, valid = true }: { title: string; onClose: () => void; onSubmit: () => Promise<unknown>; cta: string; children: React.ReactNode; valid?: boolean }) {
  const { busy, run } = useAction();
  return <Modal title={title} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !valid} onClick={() => run(async () => { await onSubmit(); onClose(); })}>{busy ? 'Saving…' : cta}</button></>}><div className="stack">{children}</div></Modal>;
}

/** Everything one learner owes and has paid. Staff get actions; the learner/parent gets Pay now and receipts. */
export function FeeLedger({ learnerId, learnerName, staff }: { learnerId: string; learnerName: string; staff: { record: boolean; manage: boolean; refund: boolean } | null }) {
  const toast = useToast();
  const q = useFetch(() => api.get(`/api/fees/learners/${learnerId}`).then((r) => r.data), [learnerId]);
  const { busy, run } = useAction();
  const [modal, setModal] = useState<null | { kind: 'pay' } | { kind: 'charge' } | { kind: 'refund'; p: any } | { kind: 'adjust'; i: any } | { kind: 'cancel'; f: any }>(null);
  const [f, setF] = useState<any>({});
  const done = () => q.reload();
  const payNow = (ids?: string[]) => run(async () => {
    const r = await api.post('/api/fees/pay-links', { learner_id: learnerId, installment_ids: ids });
    if (staff) { await navigator.clipboard?.writeText(r.data.short_url).catch(() => undefined); toast('Payment link copied. Send it to the parent.'); } else window.location.href = r.data.short_url;
    done();
  });

  if (q.error && !q.data) return <div className="card card-pad"><p className="err">{errText(q.error)}</p><button className="btn" onClick={q.reload}>Try again</button></div>;
  if (!q.data) return <div className="card card-pad muted">Loading fees…</div>;
  const d: any = q.data;
  const open = d.fees.filter((x: any) => x.status === 'active').flatMap((x: any) => x.installments.filter((i: any) => i.status === 'pending' || i.status === 'partial').map((i: any) => ({ ...i, fee: x.title })));
  return (
    <div className="stack">
      <div className="grid cols-4">
        <Stat label="Billed" value={fmtMoney(d.totals.billed)} /><Stat label="Paid" value={fmtMoney(d.totals.paid)} />
        <Stat label="Outstanding" value={fmtMoney(d.totals.outstanding)} sub={Number(d.totals.overdue) > 0 ? <span className="err">{fmtMoney(d.totals.overdue)} overdue</span> : 'Nothing overdue'} />
        <Stat label="Credit" value={fmtMoney(d.totals.credit)} sub="Paid ahead / extra" />
      </div>
      <div className="row wrap">
        {staff?.record && open.length > 0 && <button className="btn primary" onClick={() => setModal({ kind: 'pay' })}>＋ Record payment</button>}
        {open.length > 0 && <button className="btn" disabled={busy} onClick={() => payNow()}>{staff ? 'Copy payment link' : `Pay ${fmtMoney(d.totals.outstanding)} now`}</button>}
        {staff?.manage && <button className="btn" onClick={() => { setF({ title: '', amount: '', due: todayStr() }); setModal({ kind: 'charge' }); }}>＋ Add charge</button>}
      </div>
      {!d.fees.length ? <div className="card"><Empty icon="🧾" title="No fees yet">{staff?.manage ? 'Assign a fee plan from Fees → Plans, or add a one-off charge.' : 'Nothing has been billed yet.'}</Empty></div> : d.fees.map((fe: any) => (
        <div className="card" key={fe.id}>
          <div className="card-head"><h2>{fe.title}</h2><span className="row gap-s">{fe.batch_name && <span className="muted small">{fe.batch_name}</span>}{fe.status === 'cancelled' ? <Badge tone="bad">Cancelled</Badge> : <span className="muted small">{fmtMoney(fe.net_amount)}{Number(fe.discount_amount) > 0 ? ` after ${fmtMoney(fe.discount_amount)} discount` : ''}</span>}
            {staff?.manage && fe.status === 'active' && <button className="btn sm" onClick={() => { setF({ reason: '' }); setModal({ kind: 'cancel', f: fe }); }}>Cancel fee</button>}</span></div>
          <div className="table-wrap"><table className="t"><thead><tr><th>Installment</th><th>Due</th><th className="right">Amount</th><th className="right">Paid</th><th>Status</th><th /></tr></thead><tbody>
            {fe.installments.map((i: any) => <tr key={i.id}><td>{i.label}</td><td className="nowrap">{fmtDate(i.due_date)}</td><td className="right">{fmtMoney(i.amount)}</td><td className="right">{fmtMoney(i.paid_amount)}</td>
              <td>{i.status === 'paid' ? <Badge tone="ok">Paid</Badge> : i.status === 'cancelled' ? <Badge tone="bad">Cancelled</Badge> : i.overdue ? <Badge tone="bad">Overdue</Badge> : i.status === 'partial' ? <Badge tone="warn">Part paid</Badge> : <Badge>Due</Badge>}</td>
              <td className="right">{staff?.manage && fe.status === 'active' && i.status !== 'cancelled' && <button className="btn sm" onClick={() => { setF({ amount: String(Number(i.amount)), due: String(i.due_date).slice(0, 10), reason: '' }); setModal({ kind: 'adjust', i }); }}>Adjust</button>}
                {!staff && (i.status === 'pending' || i.status === 'partial') && <button className="btn sm" disabled={busy} onClick={() => payNow([i.id])}>Pay</button>}</td></tr>)}
          </tbody></table></div>
        </div>))}
      <div className="card">
        <div className="card-head"><h2>Payments & receipts</h2></div>
        {!d.payments.length ? <Empty icon="💳" title="No payments yet" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Receipt</th><th>Date</th><th>Method</th><th className="right">Amount</th><th /></tr></thead><tbody>
          {d.payments.map((p: any) => <tr key={p.id}><td className="mono">{p.receipt_no}</td><td className="nowrap">{fmtDateTime(p.paid_at)}</td><td>{cap(p.method)}{p.provider === 'razorpay' && <> <Badge tone="info">online</Badge></>}</td>
            <td className="right">{fmtMoney(p.amount)}{Number(p.refunded_amount) > 0 && <div className="small err">−{fmtMoney(p.refunded_amount)} refunded</div>}</td>
            <td className="right nowrap"><button className="btn sm" onClick={() => run(() => api.getFile(`/api/fees/payments/${p.id}/receipt.pdf`, `${p.receipt_no}.pdf`, true))}>Receipt</button>
              {staff?.refund && p.status !== 'refunded' && <> <button className="btn sm" onClick={() => { setF({ amount: String(Number(p.amount) - Number(p.refunded_amount)), reason: '' }); setModal({ kind: 'refund', p }); }}>Refund</button></>}</td></tr>)}
        </tbody></table></div>}
      </div>

      {modal?.kind === 'pay' && <RecordPaymentModal learnerId={learnerId} learnerName={learnerName} open={open} onClose={() => setModal(null)} onDone={done} />}
      {modal?.kind === 'charge' && <SimpleForm title="Add a one-off charge" cta="Add charge" valid={f.title?.trim().length >= 2 && Number(f.amount) > 0} onClose={() => setModal(null)} onSubmit={async () => { await api.post(`/api/fees/learners/${learnerId}/fees`, { title: f.title, amount: Number(f.amount), due_date: f.due }); toast('Charge added.'); done(); }}>
        <Field label="What is it for?"><input className="input" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} placeholder="Exam fee, robotics kit…" autoFocus /></Field>
        <div className="row"><Field label="Amount (₹)"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field><Field label="Due date"><input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field></div></SimpleForm>}
      {modal?.kind === 'adjust' && <SimpleForm title={`Adjust ${modal.i.label}`} cta="Save" valid={Number(f.amount) > 0 && f.reason?.trim().length >= 2} onClose={() => setModal(null)} onSubmit={async () => { await api.patch(`/api/fees/installments/${modal.i.id}`, { amount: Number(f.amount), due_date: f.due, reason: f.reason }); toast('Installment updated.'); done(); }}>
        <p className="muted small" style={{ margin: 0 }}>Lowering an unpaid amount records a concession. It cannot go below the {fmtMoney(modal.i.paid_amount)} already paid.</p>
        <div className="row"><Field label="Amount (₹)"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field><Field label="Due date"><input className="input" type="date" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field></div>
        <Field label="Reason"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Sibling concession, scholarship…" /></Field></SimpleForm>}
      {modal?.kind === 'cancel' && <SimpleForm title={`Cancel “${modal.f.title}”`} cta="Cancel this fee" valid={f.reason?.trim().length >= 2} onClose={() => setModal(null)} onSubmit={async () => { await api.post(`/api/fees/fees/${modal.f.id}/cancel`, { reason: f.reason }); toast('Fee cancelled.'); done(); }}>
        <p className="muted small" style={{ margin: 0 }}>Only possible while nothing has been paid on it. If money was taken, refund it first.</p>
        <Field label="Reason"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus /></Field></SimpleForm>}
      {modal?.kind === 'refund' && <SimpleForm title={`Refund · ${modal.p.receipt_no}`} cta="Record refund" valid={Number(f.amount) > 0 && f.reason?.trim().length >= 2} onClose={() => setModal(null)} onSubmit={async () => { const r = await api.post(`/api/fees/payments/${modal.p.id}/refund`, { amount: Number(f.amount), reason: f.reason }); toast(r.data.provider_note ?? 'Refund recorded.'); done(); }}>
        <p className="muted small" style={{ margin: 0 }}>The money is taken back from the latest installments first.{modal.p.provider === 'razorpay' ? ' For an online payment, also issue the refund from the Razorpay dashboard.' : ''}</p>
        <div className="row"><Field label="Amount (₹)"><input className="input" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} /></Field></div>
        <Field label="Reason"><input className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} autoFocus /></Field></SimpleForm>}
    </div>
  );
}
