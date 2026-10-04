import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, Tabs, useAction, useDebounced, useFetch, useToast } from '../components/ui';
import { fmtDate, fmtNum } from '../format';

const TOKENS = ['name', 'course_name', 'batch_name', 'date', 'org_name'];

export default function Certificates() {
  const { can } = useAuth(); const manage = can('cert:manage');
  const [tab, setTab] = useState<'issued' | 'designs'>('issued');
  const designs = useFetch(() => api.get('/api/certificates/designs').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any>(null); const [issue, setIssue] = useState<any>(null);
  return (
    <>
      <PageHead title="Certificates" sub="Design a certificate once, then give it to a whole batch. Each one gets a code and QR that anyone can check on the public verify page."
        actions={manage ? <button className="btn primary" onClick={() => setEdit({})}>＋ New design</button> : undefined} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'issued', label: 'Issued' }, { id: 'designs', label: 'Designs', badge: designs.data?.length }]} />
      {tab === 'designs' && <Async q={designs}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="🎓" title="No designs yet" action={manage ? <button className="btn primary" onClick={() => setEdit({})}>Create the first design</button> : undefined}>Say what the certificate says, who signs it, then issue it to a batch.</Empty></div> : (
        <div className="stack">{list.map((d) => (
          <div className="card card-pad" key={d.id}><div className="row between wrap">
            <div><b style={{ fontSize: 16 }}>{d.name}</b> {d.status === 'archived' && <Badge>Archived</Badge>}<br /><span className="muted small">“{d.title_text}” · {fmtNum(d.issued)} issued{d.signatory_name ? ` · signed by ${d.signatory_name}` : ''}</span><p className="small" style={{ margin: '6px 0 0' }}>{d.body_text}</p></div>
            {manage && <div className="row gap-s"><button className="btn sm primary" disabled={d.status !== 'active'} onClick={() => setIssue(d)}>Issue to learners</button><button className="btn sm" onClick={() => setEdit(d)}>Edit</button></div>}
          </div></div>))}</div>)}</Async>}
      {tab === 'issued' && <Issued manage={manage} />}
      {edit && <DesignModal design={edit} onClose={() => setEdit(null)} onDone={designs.reload} />}
      {issue && <IssueModal design={issue} onClose={() => setIssue(null)} onDone={designs.reload} />}
    </>
  );
}

function Issued({ manage }: { manage: boolean }) {
  const [page, setPage] = useState(1); const [text, setText] = useState(''); const term = useDebounced(text);
  const q = useFetch(() => api.get(`/api/certificates${qs({ page, page_size: 25, q: term })}`), [page, term]);
  const { busy, run } = useAction();
  return (
    <div className="card">
      <div className="row wrap" style={{ padding: 12 }}><input className="input" style={{ maxWidth: 280 }} placeholder="Search name or code" aria-label="Search certificates" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} /></div>
      <Async q={q}>{(r: any) => !r.data.length ? <Empty icon="🎓" title="No certificates yet" /> : (<>
        <div className="table-wrap"><table className="t"><thead><tr><th>Learner</th><th>Certificate</th><th>Code</th><th>Issued</th><th /></tr></thead><tbody>
          {r.data.map((c: any) => <tr key={c.id}><td><Link to={`/learners/${c.learner_id}`}>{c.recipient_name}</Link><br /><span className="muted small">{c.learner_code}</span></td>
            <td>{c.title}<br /><span className="muted small">{[c.course_name, c.batch_name].filter(Boolean).join(' · ')}</span></td>
            <td className="nowrap"><code>{c.code}</code> {c.revoked_at && <Badge tone="bad">Revoked</Badge>}</td><td className="nowrap">{fmtDate(c.issued_on)}</td>
            <td className="nowrap"><button className="btn sm" onClick={() => api.getFile(`/api/certificates/${c.id}/pdf`, `${c.code}.pdf`, true)}>PDF</button>{' '}
              {manage && !c.revoked_at && <button className="btn sm" disabled={busy} onClick={() => { const reason = prompt('Why is this certificate being revoked?'); if (reason && reason.trim().length >= 3) run(async () => { await api.post(`/api/certificates/${c.id}/revoke`, { reason }); q.reload(); }, 'Certificate revoked.'); }}>Revoke</button>}</td></tr>)}
        </tbody></table></div><Pager meta={r.meta} onPage={setPage} /></>)}</Async>
    </div>
  );
}

function DesignModal({ design, onClose, onDone }: { design: any; onClose: () => void; onDone: () => void }) {
  const isNew = !design.id; const { busy, run } = useAction(); const toast = useToast(); const [err, setErr] = useState('');
  const [f, setF] = useState({ name: design.name ?? '', title_text: design.title_text ?? 'Certificate of Completion', body_text: design.body_text ?? 'has successfully completed {course_name} ({batch_name}) on {date}.', signatory_name: design.signatory_name ?? '', signatory_title: design.signatory_title ?? '', show_logo: design.show_logo === undefined ? true : !!design.show_logo, status: design.status ?? 'active' });
  const body = { ...f, signatory_name: f.signatory_name || null, signatory_title: f.signatory_title || null };
  return (
    <Modal wide title={isNew ? 'New certificate design' : `Edit · ${design.name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || f.name.trim().length < 2 || f.body_text.trim().length < 5} onClick={() => run(async () => { setErr(''); try { if (isNew) await api.post('/api/certificates/designs', body); else await api.put(`/api/certificates/designs/${design.id}`, body); toast('Saved.'); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } })}>{busy ? 'Saving…' : 'Save'}</button></>}>
      <div className="stack">
        <Field label="Design name (for you)"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
        <Field label="Title on the certificate"><input className="input" value={f.title_text} onChange={(e) => setF({ ...f, title_text: e.target.value })} /></Field>
        <Field label="Wording" hint={`After “This is to certify that <name>”. You can use ${TOKENS.map((t) => `{${t}}`).join(' ')}.`}><textarea className="input" rows={3} value={f.body_text} onChange={(e) => setF({ ...f, body_text: e.target.value })} /></Field>
        <div className="row wrap"><Field label="Signed by"><input className="input" value={f.signatory_name} onChange={(e) => setF({ ...f, signatory_name: e.target.value })} /></Field><Field label="Their title"><input className="input" value={f.signatory_title} onChange={(e) => setF({ ...f, signatory_title: e.target.value })} /></Field></div>
        <label className="row gap-s"><input type="checkbox" checked={f.show_logo} onChange={(e) => setF({ ...f, show_logo: e.target.checked })} /> Show the organization logo (set under Branding)</label>
        {!isNew && <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="archived">Archived (cannot be issued)</option></select></Field>}
        {!isNew && <p className="muted small" style={{ margin: 0 }}>Certificates already issued keep the wording they were issued with.</p>}
        {err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}

function IssueModal({ design, onClose, onDone }: { design: any; onClose: () => void; onDone: () => void }) {
  const [batches, setBatches] = useState<string[]>([]); const [sum, setSum] = useState<AudienceSummary | null>(null);
  const [date, setDate] = useState(''); const [preview, setPreview] = useState<any>(null);
  const { busy, run } = useAction(); const toast = useToast();
  const body = (extra: object) => ({ design_id: design.id, selector: { batch_ids: batches }, batch_id: batches.length === 1 ? batches[0] : undefined, issued_on: date || undefined, ...extra });
  return (
    <Modal wide title={`Issue “${design.name}”`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      {!preview ? <button className="btn primary" disabled={busy || !batches.length || !sum?.unique_learners} onClick={() => run(async () => setPreview((await api.post('/api/certificates/issue', body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !preview.to_issue} onClick={() => run(async () => { const r = await api.post('/api/certificates/issue', body({ confirm: true })); toast(`${r.data.issued} certificate(s) issued.`); onDone(); onClose(); })}>{busy ? 'Issuing…' : `Issue ${preview.to_issue} certificate(s)`}</button>}</>}>
      <div className="stack">
        <BatchSelector value={batches} onChange={(v) => { setBatches(v); setPreview(null); }} onSummary={setSum} />
        <Field label="Issue date (optional)" hint="Defaults to today."><input className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setPreview(null); }} /></Field>
        {batches.length === 1 && <p className="muted small" style={{ margin: 0 }}>The batch and its course names are written on each certificate.</p>}
        {batches.length > 1 && <p className="muted small" style={{ margin: 0 }}>With several batches selected, batch and course names are left off the certificates.</p>}
        {preview && <div className="summary-grid"><div className="hl"><b>{fmtNum(preview.to_issue)}</b><span>Certificates to issue</span></div><div><b>{fmtNum(preview.already_have)}</b><span>Already have it (skipped)</span></div><div><b>{fmtNum(preview.selected)}</b><span>Learners selected</span></div></div>}
        {preview?.sample?.length > 0 && <p className="small" style={{ margin: 0 }}>e.g. {preview.sample.join(', ')}</p>}
        <p className="muted small" style={{ margin: 0 }}>A learner in several selected batches gets one. Nothing is issued until you confirm.</p>
      </div>
    </Modal>
  );
}
