import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { cap, fmtDateTime, fmtNum } from '../format';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, Tabs, fieldErrors, useAction, useFetch } from '../components/ui';

type Tab = 'campaigns' | 'announcements' | 'templates' | 'optouts';
export const CAMPAIGN_TONE: Record<string, string> = { draft: '', scheduled: 'info', processing: 'info', completed: 'ok', partially_failed: 'warn', failed: 'bad', cancelled: '' };

export default function Communication() {
  const { can } = useAuth();
  const canCampaign = can('comms:read');
  const [tab, setTab] = useState<Tab>(canCampaign ? 'campaigns' : 'announcements');
  const tabs: { id: Tab; label: string }[] = [
    ...(canCampaign ? [{ id: 'campaigns' as Tab, label: 'WhatsApp campaigns' }] : []),
    ...(can('comms:announce') ? [{ id: 'announcements' as Tab, label: 'Announcements' }] : []),
    ...(canCampaign ? [{ id: 'templates' as Tab, label: 'Templates' }] : []),
    ...(can('comms:manage') ? [{ id: 'optouts' as Tab, label: 'Opt-outs' }] : []),
  ];
  return (
    <>
      <PageHead title="Communication center" sub="Reach learners and parents. Every send shows exactly who will receive it before anything goes out." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'campaigns' && <Campaigns />}
      {tab === 'announcements' && <Announcements />}
      {tab === 'templates' && <Templates />}
      {tab === 'optouts' && <OptOuts />}
    </>
  );
}

function StatusBanner() {
  const q = useFetch(() => api.get('/api/whatsapp/status').then((r) => r.data), []);
  const s = q.data;
  if (!s) return null;
  const problems = [!s.configured && 'WhatsApp is not connected: AISENSY_API_KEY is not set on the server, so nothing can be sent.', s.configured && !s.webhook_configured && 'Delivery tracking is off: AISENSY_WEBHOOK_SECRET is not set, so messages will stay “sent” and never show delivered or read.', !s.worker_enabled && 'The sender is switched off (COMMS_WORKER=false) on this server.'].filter(Boolean) as string[];
  if (!problems.length) return <div className="banner" role="status" style={{ marginBottom: 12 }}><div>✅ WhatsApp is connected · sending up to {s.rate_per_second} messages per second{s.webhook_path ? <> · webhook <code>{s.webhook_path}</code></> : ''}</div></div>;
  return <div className="banner" role="alert" style={{ marginBottom: 12, background: 'var(--warn-soft, #fff4d6)', color: 'var(--warn, #7a5b00)' }}><div>{problems.map((p) => <div key={p}>⚠️ {p}</div>)}<div className="small">An admin sets these in the hosting dashboard (Environment variables). They are never shown here.</div></div></div>;
}

/* ------------------------------------------------------------------ campaigns */
function Campaigns() {
  const { can } = useAuth();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [wizard, setWizard] = useState<null | 'new' | any>(null);
  const q = useFetch(() => api.get(`/api/whatsapp/campaigns${qs({ status, page })}`), [status, page]);
  return (
    <div className="stack">
      <StatusBanner />
      <div className="row wrap">
        {can('comms:campaign') && <button className="btn primary" onClick={() => setWizard('new')}>＋ New campaign</button>}
        <select className="select" style={{ width: 170 }} aria-label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}><option value="">All statuses</option>{['draft', 'scheduled', 'processing', 'completed', 'partially_failed', 'failed', 'cancelled'].map((s) => <option key={s} value={s}>{cap(s.replace('_', ' '))}</option>)}</select>
      </div>
      <Async q={q as any}>{(d: any) => d.data.length ? <div className="card">{d.data.map((c: any) => (
        <Link key={c.id} to={`/communication/campaigns/${c.id}`} className="m-card" style={{ color: 'inherit', alignItems: 'center' }}>
          <div className="grow"><b>{c.name}</b><div className="muted small">{c.template_name} · {c.audience} · {c.created_by_name} · {fmtDateTime(c.created_at)}{c.scheduled_at ? ` · scheduled ${fmtDateTime(c.scheduled_at)}` : ''}</div>
            {c.counts && <div className="small">{c.counts.successful}/{c.counts.total} sent{c.counts.delivered + c.counts.read ? ` · ${c.counts.delivered + c.counts.read} delivered` : ''}{c.counts.failed ? ` · ${c.counts.failed} failed` : ''}{c.counts.in_progress ? ` · ${c.counts.in_progress} waiting` : ''}</div>}</div>
          <Badge tone={CAMPAIGN_TONE[c.status]}>{cap(c.status.replace('_', ' '))}</Badge></Link>))}
        <Pager meta={d.meta} onPage={setPage} /></div> : <div className="card"><Empty icon="💬" title="No campaigns yet">{can('comms:campaign') ? 'Create a campaign: choose a template, pick batches, review the audience, then send.' : 'Campaigns will appear here.'}</Empty></div>}</Async>
      {wizard && <Wizard onClose={() => setWizard(null)} />}
    </div>
  );
}

const TOKEN_HELP = '{learner_name}  {learner_first_name}  {parent_name}  {org_name}  {batch_name}';

/** Choose → audience → values → save draft → review (the confirmation screen). */
function Wizard({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const { busy, run } = useAction();
  const templates = useFetch(() => api.get('/api/whatsapp/templates').then((r) => (r.data as any[]).filter((t) => t.status === 'active')), []);
  const [f, setF] = useState({ name: '', template_id: '', audience: 'parents', scheduled: '' });
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [sum, setSum] = useState<AudienceSummary | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const tpl = templates.data?.find((t: any) => t.id === f.template_id);
  const pickTemplate = (id: string) => { setF({ ...f, template_id: id }); const t = templates.data?.find((x: any) => x.id === id); setVars((t?.variable_names ?? []).map((n: string) => (/name/i.test(n) ? (/parent/i.test(n) ? '{parent_name}' : '{learner_name}') : ''))); };
  const ready = f.name.trim().length >= 2 && !!tpl && batchIds.length > 0 && vars.every((v) => v.trim());
  const save = () => { setErrs({}); return run(async () => {
    try {
      const id = (await api.post('/api/whatsapp/campaigns', { name: f.name, template_id: f.template_id, audience: f.audience, selector: { batch_ids: batchIds }, variables: vars, scheduled_at: f.scheduled ? new Date(f.scheduled).toISOString() : null })).data.id;
      nav(`/communication/campaigns/${id}?review=1`);
    } catch (e) { setErrs(fieldErrors(e)); throw e; } }).catch(() => {}); };
  return (
    <Modal wide title="New WhatsApp campaign" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ready} onClick={save}>Save and review audience</button></>}>
      <div className="stack">
        <div className="form-grid">
          <Field label="Campaign name" className="full"><input className="input" autoFocus maxLength={160} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Template" error={errs.template_id}><select className="select" value={f.template_id} onChange={(e) => pickTemplate(e.target.value)}><option value="">Choose a template…</option>{(templates.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>
          <Field label="Send to"><select className="select" value={f.audience} onChange={(e) => setF({ ...f, audience: e.target.value })}><option value="parents">Parents (primary parent's mobile)</option><option value="learners">Learners (their own mobile)</option></select></Field>
          <Field label="Schedule (optional)" hint="Leave empty to start sending as soon as you confirm." error={errs.scheduled_at}><input className="input" type="datetime-local" value={f.scheduled} onChange={(e) => setF({ ...f, scheduled: e.target.value })} /></Field>
        </div>
        {templates.data && !templates.data.length && <div className="banner">No active templates yet. An admin adds them under the Templates tab.</div>}
        {tpl && <div className="card card-pad stack" style={{ gap: 8 }}>
          <b>Message</b>{tpl.body_preview && <div className="muted small" style={{ whiteSpace: 'pre-wrap' }}>{tpl.body_preview}</div>}
          {(tpl.variable_names ?? []).map((n: string, i: number) => <Field key={i} label={`{{${i + 1}}} ${n}`} error={i === 0 ? errs.variables : undefined}><input className="input" value={vars[i] ?? ''} onChange={(e) => setVars(vars.map((v, j) => (j === i ? e.target.value : v)))} /></Field>)}
          <div className="muted small">You can use: <code>{TOKEN_HELP}</code>. They are filled in for each person.</div></div>}
        <div><b>Audience</b><div className="muted small" style={{ margin: '2px 0 8px' }}>Pick batches. Learners in several of them are counted once.</div><BatchSelector value={batchIds} onChange={setBatchIds} onSummary={setSum} /></div>
        {sum && <div className="summary-grid"><div><b>{fmtNum(sum.selected_batches)}</b><span>Batches</span></div><div><b>{fmtNum(sum.batch_memberships)}</b><span>Memberships</span></div><div className="hl"><b>{fmtNum(sum.unique_learners)}</b><span>Unique learners</span></div><div><b>{fmtNum(sum.duplicates_removed)}</b><span>Duplicates removed</span></div></div>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ announcements */
function Announcements() {
  const q = useFetch(() => api.get('/api/announcements').then((r) => r.data as any[]), []);
  const [open, setOpen] = useState(false);
  return (
    <div className="stack">
      <div><button className="btn primary" onClick={() => setOpen(true)}>＋ New announcement</button></div>
      <Async q={q}>{(rows: any[]) => rows.length ? <div className="card">{rows.map((a) => (
        <div key={a.id} className="m-card"><div className="grow"><b>{a.title}</b><div className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div><div className="muted small">{a.created_by_name} · {fmtDateTime(a.created_at)} · {a.notified_users} people notified from {a.unique_learners} learners{a.streams_posted ? ` · posted to ${a.streams_posted} stream${a.streams_posted === 1 ? '' : 's'}` : ''}</div></div></div>))}</div>
        : <div className="card"><Empty icon="📣" title="No announcements yet">Send an in-app announcement to the learners and parents of your batches.</Empty></div>}</Async>
      {open && <AnnounceModal onClose={() => setOpen(false)} onDone={() => { setOpen(false); q.reload(); }} />}
    </div>
  );
}

function AnnounceModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ title: '', body: '', stream: true });
  const [ids, setIds] = useState<string[]>([]);
  const [sum, setSum] = useState<AudienceSummary | null>(null);
  const [people, setPeople] = useState<number | null>(null);
  const [step, setStep] = useState<'write' | 'review'>('write');
  const [errs, setErrs] = useState<Record<string, string>>({});
  const review = () => run(async () => { setPeople((await api.post('/api/announcements/preview', { selector: { batch_ids: ids } })).data.people); setStep('review'); });
  const send = () => { setErrs({}); return run(async () => { try { await api.post('/api/announcements', { title: f.title, body: f.body, selector: { batch_ids: ids }, post_to_stream: f.stream, confirm: true }); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Announcement sent').catch(() => {}); };
  return (
    <Modal wide title="New announcement" onClose={onClose} footer={step === 'write'
      ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.title.trim().length < 2 || f.body.trim().length < 2 || !ids.length} onClick={review}>Review</button></>
      : <><button className="btn" onClick={() => setStep('write')}>Back</button><button className="btn primary" disabled={busy} onClick={send}>{busy ? 'Sending…' : 'Confirm & send'}</button></>}>
      {step === 'write' ? (
        <div className="stack">
          <Field label="Title" error={errs.title}><input className="input" autoFocus maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></Field>
          <Field label="Message" error={errs.body}><textarea className="textarea" value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
          <label className="row small"><input type="checkbox" checked={f.stream} onChange={(e) => setF({ ...f, stream: e.target.checked })} /> Also post to the Stream of each selected batch</label>
          <BatchSelector value={ids} onChange={setIds} onSummary={setSum} />
          {sum && <div className="muted small">{fmtNum(sum.unique_learners)} unique learners ({fmtNum(sum.duplicates_removed)} duplicates removed)</div>}
        </div>) : (
        <div className="stack"><h3>Please review</h3>
          <div className="summary-grid"><div><b>{sum?.selected_batches}</b><span>Batches</span></div><div><b>{sum?.batch_memberships}</b><span>Memberships</span></div><div className="hl"><b>{sum?.unique_learners}</b><span>Unique learners</span></div><div><b>{people}</b><span>People notified</span></div></div>
          <p style={{ margin: 0 }}>“{f.title}” will be sent to <b>{people}</b> people (learners and parents who can sign in), once each.{f.stream ? ' It will also appear in each batch’s Stream.' : ''}</p>{errs.post_to_stream && <div className="err">{errs.post_to_stream}</div>}</div>)}
    </Modal>
  );
}

/* ------------------------------------------------------------------ templates */
function Templates() {
  const { can } = useAuth();
  const q = useFetch(() => api.get('/api/whatsapp/templates').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  return (
    <div className="stack">
      <div className="banner"><div>Templates must already be approved in AiSensy. Enter the <b>API campaign name</b> exactly as it appears there; the variable names below map to {'{{1}}'}, {'{{2}}'}… in order.</div></div>
      {can('comms:manage') && <div><button className="btn primary" onClick={() => setEdit('new')}>＋ New template</button></div>}
      <Async q={q}>{(rows: any[]) => rows.length ? <div className="card">{rows.map((t) => (
        <div key={t.id} className="m-card" style={{ alignItems: 'center' }}>
          <div className="grow"><b>{t.name}</b> <Badge>{cap(t.use_case.replace(/_/g, ' '))}</Badge> {t.status !== 'active' && <Badge tone="warn">inactive</Badge>}
            <div className="muted small">AiSensy: <code>{t.aisensy_campaign_name}</code> · {(t.variable_names ?? []).length} variable(s): {(t.variable_names ?? []).join(', ') || 'none'}</div>{t.body_preview && <div className="small" style={{ whiteSpace: 'pre-wrap' }}>{t.body_preview}</div>}</div>
          {can('comms:manage') && <button className="btn sm" onClick={() => setEdit(t)}>Edit</button>}</div>))}</div>
        : <div className="card"><Empty icon="🧩" title="No templates yet">{can('comms:manage') ? 'Add the templates you have approved in AiSensy.' : 'An admin has not added templates yet.'}</Empty></div>}</Async>
      {edit && <TemplateModal tpl={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.reload(); }} />}
    </div>
  );
}

function TemplateModal({ tpl, onClose, onDone }: { tpl: any | null; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const meta = useFetch(() => api.get('/api/whatsapp/status').then((r) => r.data), []);
  const [f, setF] = useState({ name: tpl?.name ?? '', aisensy_campaign_name: tpl?.aisensy_campaign_name ?? '', use_case: tpl?.use_case ?? 'announcement', body_preview: tpl?.body_preview ?? '', vars: (tpl?.variable_names ?? []).join('\n'), status: tpl?.status ?? 'active' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); const body = { name: f.name, aisensy_campaign_name: f.aisensy_campaign_name, use_case: f.use_case, body_preview: f.body_preview || null, variable_names: f.vars.split('\n').map((s: string) => s.trim()).filter(Boolean), status: f.status };
    return run(async () => { try { tpl ? await api.patch(`/api/whatsapp/templates/${tpl.id}`, body) : await api.post('/api/whatsapp/templates', body); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Template saved').catch(() => {}); };
  return (
    <Modal wide title={tpl ? 'Edit template' : 'New template'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name" error={errs.name}><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Use case"><select className="select" value={f.use_case} onChange={(e) => setF({ ...f, use_case: e.target.value })}>{(meta.data?.use_cases ?? [f.use_case]).map((u: string) => <option key={u} value={u}>{cap(u.replace(/_/g, ' '))}</option>)}</select></Field>
        <Field label="AiSensy API campaign name" error={errs.aisensy_campaign_name} className="full"><input className="input" value={f.aisensy_campaign_name} onChange={(e) => setF({ ...f, aisensy_campaign_name: e.target.value })} /></Field>
        <Field label="Message text (for reference)" className="full"><textarea className="textarea" placeholder="Hi {{1}}, your class for {{2}} is tomorrow." value={f.body_preview} onChange={(e) => setF({ ...f, body_preview: e.target.value })} /></Field>
        <Field label="Variables, one per line, in order ({{1}}, {{2}} …)" className="full"><textarea className="textarea" value={f.vars} onChange={(e) => setF({ ...f, vars: e.target.value })} /></Field>
        {tpl && <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive</option></select></Field>}
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ opt-outs */
function OptOuts() {
  const q = useFetch(() => api.get('/api/whatsapp/optouts').then((r) => r.data as any[]), []);
  const { busy, run } = useAction();
  const [phone, setPhone] = useState(''); const [reason, setReason] = useState('');
  return (
    <div className="stack">
      <div className="banner"><div>Numbers listed here are never messaged, and anything still waiting to go to them is cancelled.</div></div>
      <div className="card card-pad row wrap"><input className="input" style={{ maxWidth: 200 }} placeholder="Mobile number" aria-label="Mobile number" value={phone} onChange={(e) => setPhone(e.target.value)} /><input className="input grow" placeholder="Reason (optional)" aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        <button className="btn primary" disabled={busy || phone.trim().length < 5} onClick={() => run(async () => { await api.post('/api/whatsapp/optouts', { phone, reason: reason || null }); setPhone(''); setReason(''); q.reload(); }, 'Number added')}>Add</button></div>
      <Async q={q}>{(rows: any[]) => rows.length ? <div className="card">{rows.map((o) => <div key={o.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{o.phone}</b><div className="muted small">{o.reason ?? 'No reason given'} · {fmtDateTime(o.created_at)}</div></div><button className="btn ghost sm" onClick={() => confirm('Allow messages to this number again?') && run(async () => { await api.del(`/api/whatsapp/optouts/${o.id}`); q.reload(); }, 'Removed')}>Remove</button></div>)}</div> : <div className="card"><Empty icon="🔕" title="No opt-outs">Nobody has asked to stop.</Empty></div>}</Async>
    </div>
  );
}
