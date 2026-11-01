import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, Empty, Field, Modal, useAction, useFetch, useToast } from '../components/ui';
import { fmtMoney } from '../format';

const DESIGNS: { id: string; name: string; note: string }[] = [
  { id: 'classic', name: 'Classic', note: 'A formal bordered page. Good for printing and filing.' },
  { id: 'modern', name: 'Modern', note: 'A coloured header and a big amount. Looks great on a phone.' },
  { id: 'slip', name: 'Slip', note: 'A narrow strip for a till or thermal printer.' },
];
/** A tiny drawing of each design, so the choice is visible without opening a PDF. */
function Thumb({ id, color }: { id: string; color: string }) {
  const bar = (w: string, h = 4, c = '#cfd6e1') => <div style={{ height: h, width: w, background: c, borderRadius: 2 }} />;
  if (id === 'slip') return <div style={{ width: 54, height: 86, background: '#fff', border: '1px solid #cfd6e1', borderRadius: 3, padding: 5, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>{bar('70%', 5, '#333')}{bar('90%', 2)}{bar('90%', 2)}{bar('90%', 2)}<div style={{ borderTop: '1px dashed #999', width: '100%' }} />{bar('60%', 6, '#333')}{bar('90%', 2)}</div>;
  if (id === 'modern') return <div style={{ width: 66, height: 90, background: '#fff', border: '1px solid #cfd6e1', borderRadius: 4, overflow: 'hidden' }}><div style={{ height: 22, background: color }} /><div style={{ margin: 6, height: 16, background: '#eef3fa', borderRadius: 4, display: 'flex', alignItems: 'center', padding: '0 4px' }}>{bar('45%', 6, color)}</div><div style={{ padding: '0 6px', display: 'flex', flexDirection: 'column', gap: 4 }}>{bar('80%', 2)}{bar('60%', 2)}{bar('90%', 2)}</div></div>;
  return <div style={{ width: 66, height: 90, background: '#fff', border: `2px double ${color}`, borderRadius: 2, padding: 6, display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'center' }}>{bar('60%', 5, color)}{bar('85%', 2)}<div style={{ width: '100%', height: 7, background: color, borderRadius: 1, marginTop: 3 }} />{bar('90%', 2)}{bar('90%', 2)}{bar('50%', 4, '#333')}</div>;
}

/** Pick a receipt design, add the school's address, tax number and wording, see it as a real PDF; and manage named discounts and the accounts team's limit. */
export default function FeeSettings() {
  const { can } = useAuth();
  return (
    <div className="stack">
      <ReceiptDesigner canEdit={can('fee:manage')} />
      <Discounts canEdit={can('fee:manage')} owner={can('fee:discount_unlimited')} />
    </div>
  );
}

function ReceiptDesigner({ canEdit }: { canEdit: boolean }) {
  const q = useFetch(() => api.get('/api/fees/receipt-settings').then((r) => r.data as any), []);
  return <Async q={q}>{(s: any) => <DesignerForm s={s} canEdit={canEdit} onSaved={q.reload} />}</Async>;
}
function DesignerForm({ s, canEdit, onSaved }: { s: any; canEdit: boolean; onSaved: () => void }) {
  const { busy, run } = useAction(); const toast = useToast();
  const [f, setF] = useState({ template: s.template, address: s.address ?? '', tax_id: s.tax_id ?? '', header: s.header ?? '', footer: s.footer ?? '', signatory: s.signatory ?? '', signatory_title: s.signatory_title ?? '', accent: s.accent ?? '', show_logo: s.show_logo });
  const [state, setState] = useState<'' | 'revised' | 'void'>(''); const [url, setUrl] = useState<string | null>(null); const last = useRef<string | null>(null);
  const color = f.accent || s.brand_color;
  useEffect(() => {
    let dead = false; const t = setTimeout(() => {
      fetch(`/api/fees/receipt-preview.pdf?template=${f.template}${f.accent ? `&accent=${encodeURIComponent(f.accent)}` : ''}${state === 'revised' ? '&revised=true' : state === 'void' ? '&void=true' : ''}`, { credentials: 'include' }).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => { if (dead) return; if (last.current) URL.revokeObjectURL(last.current); const u = URL.createObjectURL(b); last.current = u; setUrl(u); }).catch(() => undefined);
    }, 250);
    return () => { dead = true; clearTimeout(t); };
  }, [f.template, f.accent, state]);
  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);
  const set = (p: object) => setF({ ...f, ...p }); const dirty = JSON.stringify(f) !== JSON.stringify({ template: s.template, address: s.address ?? '', tax_id: s.tax_id ?? '', header: s.header ?? '', footer: s.footer ?? '', signatory: s.signatory ?? '', signatory_title: s.signatory_title ?? '', accent: s.accent ?? '', show_logo: s.show_logo });
  return (
    <div className="card"><div className="card-head"><h2>Receipt design</h2>{canEdit && <button className="btn primary" disabled={busy || !dirty} onClick={() => run(async () => { await api.put('/api/fees/receipt-settings', { ...f, address: f.address || null, tax_id: f.tax_id || null, header: f.header || null, footer: f.footer || null, signatory: f.signatory || null, signatory_title: f.signatory_title || null, accent: f.accent || null }); onSaved(); toast('Receipt design saved. Every receipt now uses it.'); })}>Save design</button>}</div>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 18, padding: 16 }}>
        <div className="stack" style={{ flex: '1 1 380px', minWidth: 300 }}>
          <div className="row wrap" role="radiogroup" aria-label="Receipt design">{DESIGNS.map((d) => (
            <button key={d.id} type="button" role="radio" aria-checked={f.template === d.id} disabled={!canEdit} onClick={() => set({ template: d.id })} className="card hoverable" style={{ width: 150, padding: 10, textAlign: 'center', outline: f.template === d.id ? '2px solid var(--brand)' : 'none', background: f.template === d.id ? 'var(--brand-soft, #f4f7fb)' : undefined }}>
              <div style={{ display: 'grid', placeItems: 'center', height: 96 }}><Thumb id={d.id} color={color} /></div><b>{d.name}</b>{f.template === d.id && <> <Badge tone="ok">Chosen</Badge></>}<div className="muted" style={{ fontSize: 11 }}>{d.note}</div></button>))}</div>
          <div className="form-grid">
            <Field label="School address on the receipt" className="full"><input className="input" value={f.address} disabled={!canEdit} maxLength={300} onChange={(e) => set({ address: e.target.value })} placeholder="12 Park Road, Chennai 600001" /></Field>
            <Field label="GSTIN / registration number"><input className="input" value={f.tax_id} disabled={!canEdit} maxLength={40} onChange={(e) => set({ tax_id: e.target.value })} /></Field>
            <Field label="Line under the school name"><input className="input" value={f.header} disabled={!canEdit} maxLength={160} onChange={(e) => set({ header: e.target.value })} placeholder="Robotics for every child" /></Field>
            <Field label="Words at the bottom" className="full" hint="Terms, for example “Fees once paid are not refundable.”"><textarea className="input" rows={2} value={f.footer} disabled={!canEdit} maxLength={500} onChange={(e) => set({ footer: e.target.value })} /></Field>
            <Field label="Signed by"><input className="input" value={f.signatory} disabled={!canEdit} maxLength={80} onChange={(e) => set({ signatory: e.target.value })} /></Field><Field label="Their title"><input className="input" value={f.signatory_title} disabled={!canEdit} maxLength={80} onChange={(e) => set({ signatory_title: e.target.value })} /></Field>
            <Field label="Colour"><span className="row gap-s"><input type="color" aria-label="Receipt colour" value={f.accent || s.brand_color} disabled={!canEdit} onChange={(e) => set({ accent: e.target.value })} />{f.accent && <button type="button" className="btn ghost sm" onClick={() => set({ accent: '' })}>Use the school colour</button>}</span></Field>
            <label className="row gap-s" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}><input type="checkbox" checked={f.show_logo} disabled={!canEdit} onChange={(e) => set({ show_logo: e.target.checked })} /> Show the school logo (PNG or JPG)</label>
          </div>
        </div>
        <div style={{ flex: '0 1 340px', minWidth: 260 }}>
          <div className="row between" style={{ marginBottom: 6 }}><b>Preview</b><span className="chips">{([['', 'Normal'], ['revised', 'Corrected'], ['void', 'Cancelled']] as const).map(([k, l]) => <button key={k} type="button" className={`btn sm ${state === k ? 'primary' : ''}`} onClick={() => setState(k)}>{l}</button>)}</span></div>
          {url ? <iframe src={`${url}#toolbar=0&navpanes=0`} title="Receipt preview" style={{ width: '100%', height: 470, border: '1px solid var(--line)', borderRadius: 10, background: '#fff' }} /> : <div className="skeleton" style={{ height: 470, borderRadius: 10 }} />}
          <p className="muted small" style={{ margin: '6px 0 0' }}>A sample receipt in the design above. Save to use it for every receipt. Colour and wording show up after you save.</p>
        </div>
      </div>
    </div>
  );
}

function Discounts({ canEdit, owner }: { canEdit: boolean; owner: boolean }) {
  const q = useFetch(() => api.get('/api/fees/discount-presets').then((r) => r.data as any[]), []); const settings = useFetch(() => api.get('/api/fees/receipt-settings').then((r) => r.data as any), []); const [edit, setEdit] = useState<any>(null); const { busy, run } = useAction(); const [limit, setLimit] = useState<string | null>(null);
  const cur = settings.data?.discount_limit_percent as number | null | undefined; const shown = limit ?? (cur == null ? '' : String(cur));
  return (
    <div className="card"><div className="card-head"><h2>Discounts</h2>{canEdit && <button className="btn primary sm" onClick={() => setEdit({})}>＋ New saved discount</button>}</div>
      <div className="card-pad stack">
        <p className="muted small" style={{ margin: 0 }}>Save the discounts you give often (sibling, early bird, scholarship). The accounts team can then pick one when giving a fee or changing it later, and the reason is recorded.</p>
        <Async q={q} rows={2}>{(rows: any[]) => !rows.length ? <Empty icon="🏷️" title="No saved discounts yet" /> : <div>{rows.map((p) => <div key={p.id} className="m-card" style={{ alignItems: 'center', opacity: p.active ? 1 : 0.55 }}><span className="grow"><b>{p.name}</b> <span className="muted small">{p.kind === 'percent' ? `${Number(p.value)}% off` : `${fmtMoney(p.value)} off`}</span>{!p.active && <> <Badge>Off</Badge></>}</span>{canEdit && <><button className="btn sm" onClick={() => setEdit(p)}>Edit</button><button className="btn sm" disabled={busy} onClick={() => confirm(`Delete “${p.name}”? Fees that already used it keep their discount.`) && run(async () => { await api.del(`/api/fees/discount-presets/${p.id}`); q.reload(); }, 'Deleted.')}>Delete</button></>}</div>)}</div>}</Async>
        <div className="row wrap gap-s" style={{ paddingTop: 8, borderTop: '1px solid var(--line)' }}><b>Accounts team limit</b><input className="input" inputMode="numeric" style={{ width: 90 }} aria-label="Discount limit percent" disabled={!owner} placeholder="No limit" value={shown} onChange={(e) => setLimit(e.target.value.replace(/\D/g, '').slice(0, 3))} /><span className="muted">% of a fee</span>
          {owner && <button className="btn sm primary" disabled={busy || limit === null} onClick={() => run(async () => { await api.put('/api/fees/discount-limit', { percent: shown === '' ? null : Math.min(100, Number(shown)) }); setLimit(null); settings.reload(); }, 'Limit saved.')}>Save limit</button>}
          <span className="muted small">{cur == null ? 'Accountants have a free hand today.' : `Anything above ${cur}% needs an owner.`}{!owner && ' Only an owner can change this.'}</span></div>
      </div>
      {edit && <PresetModal p={edit} onClose={() => setEdit(null)} onDone={q.reload} />}
    </div>
  );
}
function PresetModal({ p, onClose, onDone }: { p: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [err, setErr] = useState(''); const [f, setF] = useState({ name: p.name ?? '', kind: p.kind ?? 'percent', value: p.value != null ? String(Number(p.value)) : '', active: p.active ?? true });
  return (
    <Modal title={p.id ? 'Edit saved discount' : 'New saved discount'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.name.trim().length < 2 || !Number(f.value)} onClick={() => run(async () => { setErr(''); const body = { name: f.name, kind: f.kind, value: Number(f.value), active: f.active }; try { if (p.id) await api.put(`/api/fees/discount-presets/${p.id}`, body); else await api.post('/api/fees/discount-presets', body); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } }, 'Saved.')}>Save</button></>}>
      <div className="stack"><Field label="Name"><input className="input" value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus placeholder="Sibling discount" /></Field>
        <div className="row"><Field label="Type"><select className="select" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="percent">Percent</option><option value="amount">₹ amount</option></select></Field><Field label={f.kind === 'percent' ? 'Percent off' : 'Rupees off'}><input className="input" inputMode="decimal" style={{ width: 120 }} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.replace(/[^\d.]/g, '') })} /></Field></div>
        <label className="row gap-s"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Available to pick</label>{err && <p className="err" role="alert">{err}</p>}</div>
    </Modal>
  );
}
