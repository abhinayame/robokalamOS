import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { monthBefore } from '../components/Progress';
import { Async, Badge, Empty, Field, Modal, PageHead, useAction, useFetch, useToast } from '../components/ui';
import { fmtNum } from '../format';

/** Teachers write a short note per learner for the month; admins and teachers can then e-mail the reports to parents. */
export default function ProgressNotes() {
  const { can } = useAuth(); const batches = useFetch(() => api.get('/api/batches?status=active,upcoming,completed&page_size=100&sort=name').then((r) => r.data as any[]), []);
  const [batch, setBatch] = useState(''); const [month, setMonth] = useState(monthBefore()); const [send, setSend] = useState(false);
  const sheet = useFetch(() => (batch ? api.get(`/api/progress/batches/${batch}/notes?month=${month}`).then((r) => r.data) : Promise.resolve(null)), [batch, month]);
  return (
    <>
      <PageHead title="Progress reports" sub="Write a short note about each learner, then send the monthly report to parents. The report itself fills in automatically from attendance and scores."
        actions={batch && can('comms:announce') ? <button className="btn primary" onClick={() => setSend(true)}>Send reports to parents</button> : undefined} />
      <div className="row wrap" style={{ marginBottom: 12 }}>
        <Field label="Batch"><select className="select" value={batch} onChange={(e) => setBatch(e.target.value)}><option value="">Choose a batch…</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Month"><input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
      </div>
      {!batch ? <div className="card"><Empty icon="📝" title="Choose a batch">You will see each learner with a box for your note.</Empty></div> : (
        <Async q={sheet}>{(d: any) => !d?.learners.length ? <div className="card"><Empty icon="👥" title="No learners in this batch" /></div> : (
          <div className="card"><div className="table-wrap"><table className="t"><thead><tr><th style={{ width: 220 }}>Learner</th><th>Your note for this month</th></tr></thead><tbody>
            {d.learners.map((l: any) => <NoteRow key={`${l.learner_id}-${month}`} batchId={batch} month={month} l={l} />)}
          </tbody></table></div></div>)}</Async>)}
      {send && <SendModal batchId={batch} month={month} onClose={() => setSend(false)} />}
    </>
  );
}

function NoteRow({ batchId, month, l }: { batchId: string; month: string; l: any }) {
  const [v, setV] = useState<string>(l.my_note ?? ''); const [saved, setSaved] = useState(l.my_note ?? ''); const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  async function save() {
    if (v.trim() === saved.trim()) return; setState('saving');
    try { await api.put('/api/progress/notes', { learner_id: l.learner_id, batch_id: batchId, month, body: v.trim() }); setSaved(v.trim()); setState('saved'); } catch { setState('error'); }
  }
  return <tr><td>{l.full_name}<br /><span className="muted small mono">{l.learner_code}</span>{l.others > 0 && <><br /><span className="muted small">{l.others} other teacher note(s)</span></>}</td>
    <td><textarea className="input" rows={2} maxLength={1000} value={v} aria-label={`Note for ${l.full_name}`} placeholder="What went well, what to work on…" onChange={(e) => { setV(e.target.value); setState('idle'); }} onBlur={save} />
      <span className="small muted">{state === 'saving' ? 'Saving…' : state === 'saved' ? 'Saved ✓' : state === 'error' ? <span className="err">Could not save, try again</span> : ''}</span></td></tr>;
}

function SendModal({ batchId, month, onClose }: { batchId: string; month: string; onClose: () => void }) {
  const toast = useToast(); const { busy, run } = useAction(); const [p, setP] = useState<any>(null);
  const body = (extra: object) => ({ month, selector: { batch_ids: [batchId] }, ...extra });
  return (
    <Modal title="Send monthly reports to parents" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button>
      {!p ? <button className="btn primary" disabled={busy} onClick={() => run(async () => setP((await api.post('/api/progress/send', body({ dry_run: true }))).data))}>Preview</button>
        : <button className="btn primary" disabled={busy || !p.to_send || !p.emailing} onClick={() => run(async () => { const r = await api.post('/api/progress/send', body({ confirm: true })); toast(`${r.data.sent} report(s) queued.`); onClose(); })}>{busy ? 'Sending…' : `Send ${p.to_send} report(s)`}</button>}</>}>
      <div className="stack">
        <p style={{ margin: 0 }}>Each parent gets an e-mail with the month's highlights and a link to the full report. A learner is never sent the same month twice.</p>
        {p && <div className="summary-grid"><div className="hl"><b>{fmtNum(p.to_send)}</b><span>Will receive it</span></div><div><b>{fmtNum(p.no_activity)}</b><span>Nothing recorded (skipped)</span></div><div><b>{fmtNum(p.no_email)}</b><span>No e-mail address</span></div><div><b>{fmtNum(p.already_sent)}</b><span>Already sent</span></div></div>}
        {p && !p.emailing && <Badge tone="warn">E-mail is not connected, so nothing can be sent yet.</Badge>}
      </div>
    </Modal>
  );
}
