import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, Tabs, useAction, useFetch, useToast } from '../components/ui';
import { cap, fmtDateTime, fmtNum } from '../format';

const hourLabel = (h: number) => (h === 0 || h === 24 ? '12 am' : h === 12 ? '12 pm' : h < 12 ? `${h} am` : `${h - 12} pm`);

export default function Reminders() {
  const { can } = useAuth();
  const manage = can('comms:manage');
  const [tab, setTab] = useState<'rules' | 'log'>('rules');
  const meta = useFetch(() => api.get('/api/reminders/meta').then((r) => r.data), []);
  const rules = useFetch(() => api.get('/api/reminders/rules').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any>(null); const [prev, setPrev] = useState<any>(null);
  const { busy, run } = useAction(); const toast = useToast();
  const kinds: any[] = meta.data?.kinds ?? [];
  const when = (r: any) => { const k = kinds.find((x) => x.kind === r.kind); return k ? `${r.offset_value} ${k.offset_label}${r.kind === 'fee_overdue' && r.repeat_days ? `, then every ${r.repeat_days} days (max ${r.max_sends})` : ''}` : ''; };
  return (
    <>
      <PageHead title="Automatic reminders" sub="Tell parents about fees and classes without anyone remembering to. Each reminder is sent once, only in your sending hours, through the same WhatsApp pipeline as campaigns."
        actions={manage ? <button className="btn primary" onClick={() => setEdit({})}>＋ New reminder</button> : undefined} />
      {meta.data && !meta.data.whatsapp_configured && <div className="card card-pad" style={{ marginBottom: 12, borderColor: 'var(--warn)' }}><b>WhatsApp is not connected.</b> Rules can be prepared, but nothing is sent until an admin sets the AiSensy details on the server.</div>}
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'rules', label: 'Rules' }, { id: 'log', label: 'What was sent' }]} />
      {tab === 'rules' && (
        <Async q={rules}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="⏰" title="No reminders yet" action={manage ? <button className="btn primary" onClick={() => setEdit({})}>Create the first reminder</button> : undefined}>For example: “3 days before a fee is due, WhatsApp the parent.”</Empty></div> : (
          <div className="stack">{list.map((r) => (
            <div className="card card-pad" key={r.id}>
              <div className="row between wrap">
                <div><b style={{ fontSize: 16 }}>{r.name}</b> {r.enabled ? <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}<br />
                  <span className="muted small">{kinds.find((k) => k.kind === r.kind)?.label} · {when(r)} · template “{r.template_name}” · to {r.audience} · {hourLabel(r.send_from_hour)}–{hourLabel(r.send_to_hour)}</span></div>
                <div className="row wrap gap-s">
                  <span className="small muted">{fmtNum(r.sent_7d)} sent in 7 days · {fmtNum(r.sent_total)} total{r.skipped_total ? ` · ${fmtNum(r.skipped_total)} skipped` : ''}</span>
                  {manage && <>
                    <label className="row gap-s small"><input type="checkbox" checked={r.enabled} disabled={busy} onChange={(e) => run(async () => { await api.patch(`/api/reminders/rules/${r.id}`, { enabled: e.target.checked }); rules.reload(); }, e.target.checked ? 'Reminder switched on.' : 'Reminder switched off.')} /> On</label>
                    <button className="btn sm" disabled={busy} onClick={() => run(async () => setPrev({ rule: r, kind: 'preview', r: (await api.post(`/api/reminders/rules/${r.id}/preview`)).data }))}>Preview</button>
                    <button className="btn sm" disabled={busy} onClick={() => run(async () => { const x = (await api.post(`/api/reminders/rules/${r.id}/run`)).data; setPrev({ rule: r, kind: 'run', r: x }); rules.reload(); })}>Run now</button>
                    <button className="btn sm" onClick={() => setEdit(r)}>Edit</button>
                    <button className="btn sm" disabled={busy} onClick={() => { if (confirm(`Delete “${r.name}”? Its history is deleted too.`)) run(async () => { await api.del(`/api/reminders/rules/${r.id}`); rules.reload(); }, 'Reminder deleted.'); }}>Delete</button></>}
                </div>
              </div>
            </div>))}</div>)}</Async>)}
      {tab === 'log' && <Log rules={rules.data ?? []} />}
      {edit && meta.data && <RuleModal rule={edit} meta={meta.data} onClose={() => setEdit(null)} onDone={() => { rules.reload(); toast('Saved.'); }} />}
      {prev && (
        <Modal title={prev.kind === 'run' ? `Ran “${prev.rule.name}”` : `Preview · ${prev.rule.name}`} onClose={() => setPrev(null)} footer={<button className="btn primary" onClick={() => setPrev(null)}>Close</button>}>
          <div className="stack">
            {prev.r.skipped_reason && <p className="err"><b>Nothing was sent:</b> {prev.r.skipped_reason}.</p>}
            <div className="summary-grid"><div><b>{fmtNum(prev.r.candidates)}</b><span>Matching now</span></div><div><b>{fmtNum(prev.r.fresh)}</b><span>Not reminded before</span></div><div className="hl"><b>{fmtNum(prev.r.queued)}</b><span>{prev.kind === 'run' ? 'Queued to send' : 'Would be sent'}</span></div><div><b>{fmtNum(prev.r.skipped.no_phone + prev.r.skipped.opted_out)}</b><span>Skipped (no number / opted out)</span></div></div>
            {prev.kind === 'preview' && !prev.r.window_open && <p className="muted small">Outside this rule’s sending hours right now, so the scheduler would wait. “Run now” ignores the hours.</p>}
            {prev.r.sample.length > 0 && <div><b className="small">Examples</b>{prev.r.sample.map((s: any, i: number) => <div key={i} className="small" style={{ marginTop: 4 }}><b>{s.learner}</b> ({s.phone}): {s.params.join(' · ')}</div>)}</div>}
            {prev.kind === 'run' && prev.r.campaigns > 0 && <p className="small">Created {prev.r.campaigns} campaign(s); see them under <Link to="/communication">Communication</Link>.</p>}
          </div>
        </Modal>)}
    </>
  );
}

function Log({ rules }: { rules: any[] }) {
  const [page, setPage] = useState(1); const [rule, setRule] = useState(''); const [outcome, setOutcome] = useState('');
  const q = useFetch(() => api.get(`/api/reminders/log${qs({ page, page_size: 25, rule_id: rule, outcome })}`), [page, rule, outcome]);
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12 }}>
        <select className="select" style={{ width: 220 }} value={rule} onChange={(e) => { setRule(e.target.value); setPage(1); }} aria-label="Rule"><option value="">All reminders</option>{rules.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
        <select className="select" style={{ width: 150 }} value={outcome} onChange={(e) => { setOutcome(e.target.value); setPage(1); }} aria-label="Outcome"><option value="">Sent & skipped</option><option value="queued">Sent</option><option value="skipped">Skipped</option></select>
      </div>
      <Async q={q}>{(r: any) => !r.data.length ? <Empty icon="📭" title="Nothing here yet" /> : (<>
        <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Reminder</th><th>Learner</th><th>Result</th></tr></thead><tbody>
          {r.data.map((g: any) => <tr key={g.id}><td className="nowrap">{fmtDateTime(g.created_at)}</td><td>{g.rule_name}<br /><span className="muted small">{cap(g.kind)}</span></td><td><Link to={`/learners/${g.learner_id}`}>{g.full_name}</Link><br /><span className="muted small">{g.learner_code}</span></td>
            <td>{g.outcome === 'queued' ? (g.campaign_id ? <Link to={`/communication/campaigns/${g.campaign_id}`}><Badge tone="ok">Queued</Badge></Link> : <Badge tone="ok">Queued</Badge>) : <Badge tone="warn">Skipped: {cap(g.reason ?? '')}</Badge>}</td></tr>)}
        </tbody></table></div><Pager meta={r.meta} onPage={setPage} /></>)}</Async>
    </div>
  );
}

function RuleModal({ rule, meta, onClose, onDone }: { rule: any; meta: any; onClose: () => void; onDone: () => void }) {
  const isNew = !rule.id;
  const templates = useFetch(() => api.get('/api/whatsapp/templates').then((r) => (r.data as any[]).filter((t) => t.status === 'active')), []);
  const [f, setF] = useState<any>({ name: rule.name ?? '', kind: rule.kind ?? 'fee_due', template_id: rule.template_id ?? '', audience: rule.audience ?? 'parents', variables: rule.variables ?? [], offset_value: rule.offset_value ?? 3, repeat_days: rule.repeat_days ?? '', max_sends: rule.max_sends ?? 1, send_from_hour: rule.send_from_hour ?? 9, send_to_hour: rule.send_to_hour ?? 20 });
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAction();
  const kind = meta.kinds.find((k: any) => k.kind === f.kind);
  const tpl = (templates.data ?? []).find((t: any) => t.id === f.template_id);
  const names: string[] = tpl?.variable_names ?? [];
  const vars = names.map((_, i) => f.variables[i] ?? '');
  const valid = f.name.trim().length >= 2 && f.template_id && vars.every((v: string) => v.trim());
  const save = () => run(async () => {
    setErr(null);
    const body = { name: f.name, kind: f.kind, template_id: f.template_id, audience: f.audience, variables: vars, offset_value: Number(f.offset_value), repeat_days: f.kind === 'fee_overdue' && f.repeat_days ? Number(f.repeat_days) : null, max_sends: f.kind === 'fee_overdue' ? Number(f.max_sends) : 1, send_from_hour: Number(f.send_from_hour), send_to_hour: Number(f.send_to_hour) };
    try { if (isNew) await api.post('/api/reminders/rules', body); else await api.patch(`/api/reminders/rules/${rule.id}`, body); onDone(); onClose(); }
    catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; }
  });
  return (
    <Modal wide title={isNew ? 'New reminder' : `Edit · ${rule.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !valid} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="stack">
        <Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Fee due in 3 days" autoFocus /></Field>
        <div className="row wrap">
          <Field label="What triggers it"><select className="select" value={f.kind} onChange={(e) => { const k = meta.kinds.find((x: any) => x.kind === e.target.value); setF({ ...f, kind: e.target.value, offset_value: k.default_offset, repeat_days: '', max_sends: 1, variables: [] }); }}>{meta.kinds.map((k: any) => <option key={k.kind} value={k.kind}>{k.label}</option>)}</select></Field>
          <Field label={`How long (${kind?.offset_label})`}><input className="input" style={{ width: 90 }} inputMode="numeric" value={f.offset_value} onChange={(e) => setF({ ...f, offset_value: e.target.value.replace(/\D/g, '') })} /></Field>
          <Field label="Send to"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="parents">Parents</option><option value="learners">Learners</option></select></Field>
        </div>
        <p className="muted small" style={{ margin: 0 }}>{kind?.description}</p>
        {f.kind === 'fee_overdue' && <div className="row wrap"><Field label="Repeat every (days, optional)"><input className="input" style={{ width: 90 }} inputMode="numeric" value={f.repeat_days} onChange={(e) => setF({ ...f, repeat_days: e.target.value.replace(/\D/g, '') })} /></Field><Field label="At most (times)"><input className="input" style={{ width: 90 }} inputMode="numeric" value={f.max_sends} onChange={(e) => setF({ ...f, max_sends: e.target.value.replace(/\D/g, '') || '1' })} /></Field></div>}
        <div className="row wrap"><Field label="Send only from"><select className="select" value={f.send_from_hour} onChange={(e) => setF({ ...f, send_from_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}</select></Field><Field label="until"><select className="select" value={f.send_to_hour} onChange={(e) => setF({ ...f, send_to_hour: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, h) => <option key={h + 1} value={h + 1}>{hourLabel(h + 1)}</option>)}</select></Field></div>
        <Field label="WhatsApp template"><select className="select" value={f.template_id} onChange={(e) => setF({ ...f, template_id: e.target.value, variables: [] })}><option value="">Choose…</option>{(templates.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
        {tpl && (
          <div className="stack-s">
            <b className="small">What each template value says</b>
            {names.map((n, i) => <Field key={i} label={`{{${i + 1}}} · ${n}`}><input className="input" value={vars[i]} onChange={(e) => setF({ ...f, variables: vars.map((v: string, j: number) => (j === i ? e.target.value : v)) })} placeholder="e.g. {parent_name}" /></Field>)}
            <div className="small muted">Placeholders you can use: {kind.tokens.map((t: string) => <code key={t} style={{ marginRight: 6 }}>{`{${t}}`}</code>)}</div>
            {f.variables.some((v: string) => /\{pay_link\}/.test(v)) && !meta.online_payments && <p className="err small">{'{pay_link}'} needs online payments, which are not connected yet; reminders using it will wait.</p>}
          </div>)}
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
