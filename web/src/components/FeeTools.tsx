import { useState } from 'react';
import { api } from '../api';
import { cap, fmtDate, fmtDateTime, fmtMoney } from '../format';
import { Async, Badge, Field, Modal, fieldErrors, useAction, useFetch, useToast } from './ui';
import { todayStr } from './Fees';

const METHODS = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['bank_transfer', 'Bank transfer'], ['cheque', 'Cheque'], ['other', 'Other']] as const;
const num = (v: unknown) => Number(v) || 0;

/** Give, change or remove the discount on one fee, by percent or rupees, with a live preview of what the learner will owe. */
export function DiscountModal({ fee, onClose, onDone }: { fee: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const { busy, run } = useAction(); const [err, setErr] = useState<Record<string, string>>({});
  const presets = useFetch(() => api.get('/api/fees/discount-presets').then((r) => (r.data as any[]).filter((p) => p.active)).catch(() => [] as any[]), []);
  const settings = useFetch(() => api.get('/api/fees/receipt-settings').then((r) => r.data as any).catch(() => null), []);
  const gross = num(fee.gross_amount); const paid = fee.installments.reduce((s: number, i: any) => s + num(i.paid_amount), 0);
  const [type, setType] = useState<'percent' | 'amount' | 'none'>(fee.discount_type ?? 'percent'); const [value, setValue] = useState(fee.discount_value != null ? String(num(fee.discount_value)) : ''); const [reason, setReason] = useState(fee.discount_reason ?? ''); const [preset, setPreset] = useState('');
  const v = num(value); const d = type === 'none' ? 0 : type === 'percent' ? Math.round(gross * Math.min(v, 100)) / 100 : v; const netNew = Math.max(0, gross - d); const pct = gross ? (d / gross) * 100 : 0;
  const limit = settings.data?.discount_limit_percent as number | null | undefined; const over = d > gross || netNew < paid;
  const pick = (id: string) => { setPreset(id); const p = (presets.data ?? []).find((x: any) => x.id === id); if (p) { setType(p.kind); setValue(String(num(p.value))); if (!reason.trim()) setReason(p.name); } };
  const save = () => run(async () => {
    setErr({});
    try { await api.post(`/api/fees/fees/${fee.id}/discount`, { type, value: type === 'none' ? 0 : v, reason: reason || (type === 'none' ? 'Discount removed' : ''), preset_id: preset || null }); toast(type === 'none' ? 'Discount removed.' : `Discount saved: ${fmtMoney(d)} off.`); onDone(); onClose(); }
    catch (e) { setErr(fieldErrors(e)); throw e; }
  });
  return (
    <Modal title={`Discount · ${fee.title}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || over || (type !== 'none' && (v <= 0 || reason.trim().length < 2))} onClick={save}>{busy ? 'Saving…' : type === 'none' ? 'Remove discount' : 'Save discount'}</button></>}>
      <div className="stack">
        {(presets.data ?? []).length > 0 && <Field label="Use a saved discount"><select className="select" value={preset} onChange={(e) => pick(e.target.value)}><option value="">Custom…</option>{(presets.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} ({p.kind === 'percent' ? `${num(p.value)}%` : fmtMoney(p.value)})</option>)}</select></Field>}
        <div className="chips" role="radiogroup" aria-label="Discount type">{([['percent', '% Percentage'], ['amount', '₹ Amount'], ['none', 'No discount']] as const).map(([k, l]) => <button key={k} type="button" role="radio" aria-checked={type === k} className={`btn sm ${type === k ? 'primary' : ''}`} onClick={() => { setType(k); setPreset(''); }}>{l}</button>)}</div>
        {type !== 'none' && <div className="row wrap"><Field label={type === 'percent' ? 'Percentage off' : 'Rupees off'} error={err.value}><input className="input" inputMode="decimal" value={value} autoFocus onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ''))} style={{ width: 150 }} /></Field>
          <Field label="Why?" error={err.reason} hint="Sibling, early bird, scholarship, staff child…"><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} style={{ minWidth: 240 }} /></Field></div>}
        {type === 'none' && <Field label="Note (optional)"><input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
        <div className="card card-pad" style={{ background: 'var(--brand-soft, #f4f7fb)' }}>
          <div className="row between"><span>Fee</span><b>{fmtMoney(gross)}</b></div><div className="row between"><span>Discount{type === 'percent' && v > 0 ? ` (${v}%)` : pct > 0 ? ` (${Math.round(pct * 10) / 10}%)` : ''}</span><b style={{ color: 'var(--ok)' }}>− {fmtMoney(d)}</b></div>
          <div className="row between" style={{ fontSize: 16 }}><span>Learner will pay</span><b>{fmtMoney(netNew)}</b></div>{paid > 0 && <div className="row between small muted"><span>Already paid</span><span>{fmtMoney(paid)}</span></div>}
          {paid > 0 && !over && <div className="row between small"><span>Still to pay</span><b>{fmtMoney(netNew - paid)}</b></div>}</div>
        {over && <p className="err" role="alert">{netNew < paid ? `${fmtMoney(paid)} is already paid, which is more than ${fmtMoney(netNew)}. Choose a smaller discount (or refund first).` : 'The discount cannot be more than the fee.'}</p>}
        {limit != null && <p className="muted small" style={{ margin: 0 }}>Discounts above {limit}% need an owner to approve.</p>}
        {err.__ && <p className="err">{err.__}</p>}
      </div>
    </Modal>
  );
}

/** Every discount change on a fee: who, when, why, and what it did to the amount. */
export function DiscountHistory({ fee, onClose }: { fee: any; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/fees/fees/${fee.id}/history`).then((r) => r.data as any[]), [fee.id]);
  return (
    <Modal wide title={`Discount history · ${fee.title}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <Async q={q} rows={2}>{(rows: any[]) => !rows.length ? <p className="muted">No changes yet. The fee was given as it is.</p> : <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Who</th><th className="right">Discount</th><th className="right">Fee after</th><th>Why</th></tr></thead><tbody>{rows.map((r, i) => (
        <tr key={i}><td className="nowrap">{fmtDateTime(r.created_at)}</td><td>{r.by_name ?? '—'}</td><td className="right">{fmtMoney(r.before_discount)} → <b>{fmtMoney(r.after_discount)}</b>{r.discount_type === 'percent' ? <div className="muted small">{num(r.discount_value)}%</div> : null}</td><td className="right">{fmtMoney(r.after_net)}</td><td>{r.reason}</td></tr>))}</tbody></table></div>}</Async>
    </Modal>
  );
}

/** Fix a payment that was recorded wrongly: date, method, reference, note, even the amount. The old values stay in its history. */
export function EditPaymentModal({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const { busy, run } = useAction(); const [err, setErr] = useState<Record<string, string>>({});
  const online = payment.provider === 'razorpay'; const refunded = num(payment.refunded_amount) > 0;
  const [f, setF] = useState({ paid_on: String(payment.paid_at).slice(0, 10), method: payment.method, amount: String(num(payment.amount)), reference: payment.reference ?? '', note: payment.note ?? '', reason: '', send: true });
  const dateChanged = f.paid_on !== String(payment.paid_at).slice(0, 10); const changed = dateChanged || f.method !== payment.method || num(f.amount) !== num(payment.amount) || (f.reference || '') !== (payment.reference ?? '') || (f.note || '') !== (payment.note ?? '');
  const save = () => run(async () => {
    setErr({});
    const body: any = { reason: f.reason, send_receipt: f.send };
    if (dateChanged) body.paid_at = f.paid_on === todayStr() ? new Date().toISOString() : new Date(`${f.paid_on}T12:00:00`).toISOString();
    if (f.method !== payment.method) body.method = f.method; if (num(f.amount) !== num(payment.amount)) body.amount = num(f.amount);
    if ((f.reference || '') !== (payment.reference ?? '')) body.reference = f.reference || null; if ((f.note || '') !== (payment.note ?? '')) body.note = f.note || null;
    try { await api.patch(`/api/fees/payments/${payment.id}`, body); toast('Payment corrected. The receipt now shows the new details.'); onDone(); onClose(); } catch (e) { setErr(fieldErrors(e)); throw e; }
  });
  return (
    <Modal title={`Edit payment · ${payment.receipt_no}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !changed || f.reason.trim().length < 2 || !num(f.amount)} onClick={save}>{busy ? 'Saving…' : 'Save correction'}</button></>}>
      <div className="stack">
        {online && <div className="banner warn">This was paid online through Razorpay, so only the note can be changed.</div>}
        {refunded && <div className="banner warn">This payment has a refund on it, so its amount cannot be changed.</div>}
        <div className="row wrap">
          <Field label="Amount received (₹)" error={err.amount}><input className="input" inputMode="decimal" disabled={online || refunded} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value.replace(/[^\d.]/g, '') })} style={{ width: 150 }} /></Field>
          <Field label="Paid on" error={err.paid_at}><input className="input" type="date" max={todayStr()} disabled={online} value={f.paid_on} onChange={(e) => setF({ ...f, paid_on: e.target.value })} /></Field>
          <Field label="Method"><select className="select" disabled={online} value={f.method} onChange={(e) => setF({ ...f, method: e.target.value })}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}{online && <option value="online">Online</option>}</select></Field>
        </div>
        <Field label="Reference"><input className="input" value={f.reference} maxLength={100} onChange={(e) => setF({ ...f, reference: e.target.value })} /></Field>
        <Field label="Note"><input className="input" value={f.note} maxLength={300} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
        <Field label="What was wrong?" error={err.reason} hint="Kept in the payment's history with your name and the time."><input className="input" value={f.reason} maxLength={200} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Date entered wrongly, wrong amount…" /></Field>
        <label className="row gap-s"><input type="checkbox" checked={f.send} onChange={(e) => setF({ ...f, send: e.target.checked })} /> E-mail the corrected receipt to the parent (if e-mail is set up)</label>
        <p className="muted small" style={{ margin: 0 }}>Totals, dues and the dashboard update straight away. The receipt keeps its number and is marked “corrected”.</p>
      </div>
    </Modal>
  );
}

export function VoidPaymentModal({ payment, onClose, onDone }: { payment: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const { busy, run } = useAction(); const [reason, setReason] = useState('');
  return (
    <Modal title={`Cancel payment · ${payment.receipt_no}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Keep it</button><button className="btn danger solid" disabled={busy || reason.trim().length < 2} onClick={() => run(async () => { await api.post(`/api/fees/payments/${payment.id}/void`, { reason }); toast('Payment cancelled.'); onDone(); onClose(); })}>{busy ? 'Cancelling…' : 'Cancel this payment'}</button></>}>
      <div className="stack"><p style={{ margin: 0 }}>Use this when a payment was recorded by mistake (for example twice). {fmtMoney(payment.amount)} is taken off what the learner has paid and the dues open again. The receipt is kept and stamped CANCELLED.</p>
        <p className="muted small" style={{ margin: 0 }}>If the money really was received and you are giving it back, use Refund instead.</p>
        <Field label="Why is it being cancelled?"><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} autoFocus placeholder="Recorded twice, wrong learner…" /></Field></div>
    </Modal>
  );
}

/** Who changed this payment, when and what it was before. */
export function PaymentHistory({ payment, onClose }: { payment: any; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/fees/payments/${payment.id}`).then((r) => r.data as any), [payment.id]);
  const show = (j: any) => { const o = typeof j === 'string' ? JSON.parse(j) : j; return `${fmtMoney(o.amount)} · ${cap(String(o.method ?? ''))} · ${o.paid_at ? fmtDate(o.paid_at) : ''}${o.reference ? ` · ${o.reference}` : ''}`; };
  return (
    <Modal title={`History · ${payment.receipt_no}`} onClose={onClose} footer={<button className="btn" onClick={onClose}>Close</button>}>
      <Async q={q} rows={2}>{(d: any) => !d.revisions.length ? <p className="muted">This payment has not been changed.</p> : <div className="stack">{d.revisions.map((r: any) => (
        <div key={r.revision} className="card card-pad"><div className="row between"><b>{r.kind === 'void' ? 'Cancelled' : `Correction ${r.revision}`}</b><span className="muted small">{fmtDateTime(r.created_at)} · {r.changed_by_name ?? '—'}</span></div>
          <div className="small">“{r.reason}”</div>{r.kind === 'edit' && <div className="small muted" style={{ marginTop: 4 }}>Before: {show(r.before_json)}<br />After: {show(r.after_json)}</div>}</div>))}</div>}</Async>
    </Modal>
  );
}
export const PayBadge = ({ p }: { p: any }) => p.status === 'voided' ? <Badge tone="bad">Cancelled</Badge> : p.revision > 0 ? <Badge tone="warn">Corrected</Badge> : null;
