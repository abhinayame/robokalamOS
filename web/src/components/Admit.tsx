import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Field, Modal, useAction, useFetch, useToast } from './ui';
import { fmtMoney } from '../format';
import { todayStr } from './Fees';

/** Admission in one step: a seat in a batch, a fee plan, the first payment, and the lead marked converted. Nothing happens until the preview is confirmed. */
export function AdmitModal({ learner, onClose, onDone }: { learner: { id: string; full_name: string }; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth(); const toast = useToast(); const { busy, run } = useAction();
  const batches = useFetch(() => api.get('/api/batches?status=active,upcoming&page_size=100&sort=name').then((r) => r.data as any[]), []);
  const plans = useFetch(() => (can('fee:manage') ? api.get('/api/fees/plans').then((r) => (r.data as any[]).filter((p) => p.status === 'active')) : Promise.resolve([])), []);
  const [f, setF] = useState({ batch_id: '', plan_id: '', start_date: todayStr(), disc_type: 'percent', disc_value: '', pay: '', method: 'cash', ref: '' });
  const [preview, setPreview] = useState<any>(null); const [rid] = useState(() => crypto.randomUUID());
  const set = (patch: Partial<typeof f>) => { setF({ ...f, ...patch }); setPreview(null); };
  const body = (extra: object) => ({
    batch_id: f.batch_id, plan_id: f.plan_id || null, start_date: f.start_date,
    discount: f.plan_id && Number(f.disc_value) > 0 ? { type: f.disc_type, value: Number(f.disc_value) } : undefined,
    payment: f.plan_id && Number(f.pay) > 0 ? { amount: Number(f.pay), method: f.method, reference: f.ref || null, request_id: rid } : undefined, ...extra });
  return (
    <Modal wide title={`Admit ${learner.full_name}`} onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={busy || !f.batch_id} onClick={() => run(async () => setPreview((await api.post(`/api/admissions/enrol/${learner.id}`, body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !!preview.would_block} onClick={() => run(async () => { await api.post(`/api/admissions/enrol/${learner.id}`, body({ confirm: true })); toast('Admission confirmed.'); onDone(); onClose(); })}>{busy ? 'Admitting…' : 'Confirm admission'}</button>}</>}>
      <div className="stack">
        <Field label="Batch"><select className="select" value={f.batch_id} onChange={(e) => set({ batch_id: e.target.value })}><option value="">Choose a batch…</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}{b.course_name ? ` — ${b.course_name}` : ''}</option>)}</select></Field>
        {can('fee:manage') && <>
          <Field label="Fee plan (optional)"><select className="select" value={f.plan_id} onChange={(e) => set({ plan_id: e.target.value })}><option value="">No fee plan now</option>{(plans.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name} · {fmtMoney(p.total_amount)}</option>)}</select></Field>
          {f.plan_id && <div className="row wrap">
            <Field label="Fees start on"><input className="input" type="date" value={f.start_date} onChange={(e) => set({ start_date: e.target.value })} /></Field>
            <Field label="Discount (optional)"><span className="row gap-s"><select className="select" style={{ width: 110 }} value={f.disc_type} onChange={(e) => set({ disc_type: e.target.value })}><option value="percent">Percent</option><option value="amount">₹ amount</option></select><input className="input" style={{ width: 100 }} inputMode="decimal" value={f.disc_value} onChange={(e) => set({ disc_value: e.target.value.replace(/[^\d.]/g, '') })} /></span></Field>
            {can('payment:record') && <Field label="First payment received (₹, optional)"><span className="row gap-s"><input className="input" style={{ width: 110 }} inputMode="decimal" value={f.pay} onChange={(e) => set({ pay: e.target.value.replace(/[^\d.]/g, '') })} /><select className="select" style={{ width: 130 }} value={f.method} onChange={(e) => set({ method: e.target.value })}>{['cash', 'upi', 'card', 'bank_transfer', 'cheque', 'other'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}</select></span></Field>}
          </div>}
        </>}
        {preview && <div className="summary-grid">
          <div className="hl"><b>{preview.batch.name}</b><span>{preview.already_member ? 'Already a member' : preview.batch.seats_left == null ? 'Seat available' : `${preview.batch.seats_left} seat(s) left`}</span></div>
          {preview.fee && <div><b>{fmtMoney(preview.fee.net_each)}</b><span>{preview.fee.to_create ? 'Fee to assign' : 'Fee already assigned'}</span></div>}
          {Number(f.pay) > 0 && <div><b>{fmtMoney(f.pay)}</b><span>First payment</span></div>}
        </div>}
        {preview?.would_block && <p className="err" role="alert">{preview.would_block} Pick another batch or ask an admin to raise its capacity.</p>}
        <p className="muted small" style={{ margin: 0 }}>This puts {learner.full_name} in the batch, gives the fee plan, records any payment and marks the lead as converted, all together. If any step is refused, nothing is saved. Doing it twice never doubles the fee or the payment.</p>
      </div>
    </Modal>
  );
}
