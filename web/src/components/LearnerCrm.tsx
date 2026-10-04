import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime } from '../format';
import { ACTIVITY_TYPES, LEAD_STATUSES, TEMPERATURE, statusLabel, statusTone } from './Crm';
import { Async, Badge, Empty, Field, Modal, fieldErrors, useAction, useFetch } from './ui';

const ICON: Record<string, string> = { called_parent: '📞', called_learner: '📞', whatsapp_sent: '💬', email_sent: '✉️', demo_scheduled: '🗓️', demo_attended: '✅', follow_up: '🔁', fee_discussion: '💰', admission_confirmed: '🎓', batch_assigned: '🗂️', counsellor_assigned: '🧑‍💼', status_changed: '🔀', note: '📝', other: '•' };

/** Learner 360 → CRM tab: pipeline details, follow-ups and the activity timeline. */
export default function LearnerCrm({ learnerId }: { learnerId: string }) {
  const { can } = useAuth();
  const q = useFetch(() => api.get(`/api/crm/learners/${learnerId}`).then((r) => r.data), [learnerId]);
  const [modal, setModal] = useState<null | 'lead' | 'edit' | 'activity' | 'followup'>(null);
  const { busy, run } = useAction();
  const manage = can('crm:manage');
  const done = () => { setModal(null); q.reload(); };
  return (
    <Async q={q}>{(d: any) => (
      <div className="stack">
        <div className="card card-pad stack">
          <div className="row between wrap"><h2 style={{ margin: 0 }}>CRM</h2>
            {manage && <div className="row wrap">{d.lead ? <>
              <button className="btn sm" onClick={() => setModal('activity')}>＋ Log activity</button><button className="btn sm" onClick={() => setModal('followup')}>＋ Follow-up</button><button className="btn sm" onClick={() => setModal('edit')}>Edit lead</button>
              <button className="btn ghost sm danger" disabled={busy} onClick={() => confirm('Remove from the CRM pipeline? The learner profile is not touched.') && run(async () => { await api.del(`/api/crm/leads/${learnerId}`); q.reload(); }, 'Removed from CRM')}>Remove</button></>
              : <><button className="btn sm" onClick={() => setModal('activity')}>＋ Log activity</button><button className="btn primary sm" onClick={() => setModal('lead')}>Add to CRM</button></>}</div>}</div>
          {d.lead ? (
            <dl className="kv">
              <dt>Stage</dt><dd><Badge tone={statusTone(d.lead.lead_status)}>{statusLabel(d.lead.lead_status)}</Badge>{d.lead.lost_reason && <span className="muted small"> · {d.lead.lost_reason}</span>}</dd>
              <dt>Temperature</dt><dd>{d.lead.temperature ? TEMPERATURE[d.lead.temperature as keyof typeof TEMPERATURE] : '—'}</dd>
              <dt>Source</dt><dd>{d.lead.lead_source ?? '—'}</dd>
              <dt>Counsellor</dt><dd>{d.lead.counsellor_name ?? 'Unassigned'}</dd>
              <dt>Interested in</dt><dd>{[d.lead.program_name, d.lead.course_name, d.lead.batch_name].filter(Boolean).join(' › ') || '—'}</dd>
              <dt>Next follow-up</dt><dd>{d.lead.next_follow_up_at ? fmtDateTime(d.lead.next_follow_up_at) : '—'}</dd>
              {d.lead.converted_at && <><dt>Converted</dt><dd>{fmtDateTime(d.lead.converted_at)}</dd></>}
              {d.lead.notes && <><dt>Notes</dt><dd style={{ whiteSpace: 'pre-wrap' }}>{d.lead.notes}</dd></>}
            </dl>) : <div className="muted">Not in the CRM pipeline. You can still log activities for this learner.</div>}
        </div>
        <div className="card"><div className="card-head"><h2>Follow-ups</h2></div>
          {d.follow_ups.length ? d.follow_ups.map((f: any) => (
            <div key={f.id} className="m-card" style={{ alignItems: 'center' }}>
              <div className="grow"><b>{f.note || 'Follow up'}</b><div className="muted small">{fmtDateTime(f.due_at)} · {f.assigned_name}</div></div>
              <Badge tone={f.status === 'open' ? (new Date(f.due_at) < new Date() ? 'bad' : 'info') : f.status === 'done' ? 'ok' : ''}>{f.status === 'open' && new Date(f.due_at) < new Date() ? 'overdue' : f.status}</Badge>
              {manage && f.status === 'open' && <button className="btn sm" disabled={busy} onClick={() => run(async () => { await api.post(`/api/crm/follow-ups/${f.id}/complete`, {}); q.reload(); }, 'Done')}>Done</button>}
            </div>)) : <Empty icon="🔁" title="No follow-ups">Schedule one so nobody falls through the cracks.</Empty>}</div>
        <div className="card"><div className="card-head"><h2>Activity</h2></div>
          {d.activities.length ? d.activities.map((a: any) => (
            <div key={a.id} className="m-card"><span aria-hidden style={{ fontSize: 20 }}>{ICON[a.type] ?? '•'}</span>
              <div className="grow"><b>{statusLabel(a.type)}</b>{a.description && <div style={{ whiteSpace: 'pre-wrap' }}>{a.description}</div>}<div className="muted small">{fmtDateTime(a.occurred_at)}{a.staff_name ? ` · ${a.staff_name}` : ''}{a.next_follow_up_at ? ` · next ${fmtDateTime(a.next_follow_up_at)}` : ''}</div></div></div>)) : <Empty icon="📝" title="No activity yet">Calls, messages and notes will show here.</Empty>}</div>
        {modal === 'lead' && <LeadModal learnerId={learnerId} onClose={() => setModal(null)} onDone={done} />}
        {modal === 'edit' && <LeadModal learnerId={learnerId} lead={d.lead} onClose={() => setModal(null)} onDone={done} />}
        {modal === 'activity' && <ActivityModal learnerId={learnerId} hasLead={!!d.lead} onClose={() => setModal(null)} onDone={done} />}
        {modal === 'followup' && <FollowUpModal learnerId={learnerId} defaultTo={d.lead?.counsellor_user_id} onClose={() => setModal(null)} onDone={done} />}
      </div>)}</Async>
  );
}

function useCounsellors() { return useFetch(() => api.get('/api/crm/counsellors').then((r) => r.data as any[]), []); }

function LeadModal({ learnerId, lead, onClose, onDone }: { learnerId: string; lead?: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const counsellors = useCounsellors();
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const [f, setF] = useState({ lead_status: lead?.lead_status ?? 'new', lost_reason: lead?.lost_reason ?? '', lead_source: lead?.lead_source ?? '', temperature: lead?.temperature ?? '', counsellor: lead?.counsellor_user_id ?? '', course: lead?.interested_course_id ?? '', notes: lead?.notes ?? '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); const body: any = { lead_source: f.lead_source || null, temperature: f.temperature || null, counsellor_user_id: f.counsellor || null, interested_course_id: f.course || null, notes: f.notes || null, lead_status: f.lead_status, lost_reason: f.lead_status === 'lost' ? f.lost_reason : null };
    return run(async () => { try { lead ? await api.patch(`/api/crm/leads/${learnerId}`, body) : await api.post('/api/crm/leads', { ...body, learner_id: learnerId }); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Saved').catch(() => {}); };
  return (
    <Modal wide title={lead ? 'Edit lead' : 'Add to CRM'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Stage"><select className="select" value={f.lead_status} onChange={(e) => setF({ ...f, lead_status: e.target.value })}>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></Field>
        <Field label="Temperature"><select className="select" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })}><option value="">Not set</option>{Object.entries(TEMPERATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
        {f.lead_status === 'lost' && <Field label="Why was it lost?" error={errs.lost_reason} className="full"><input className="input" maxLength={255} value={f.lost_reason} onChange={(e) => setF({ ...f, lost_reason: e.target.value })} /></Field>}
        <Field label="Source"><input className="input" maxLength={80} value={f.lead_source} onChange={(e) => setF({ ...f, lead_source: e.target.value })} /></Field>
        <Field label="Counsellor" error={errs.assigned_to}><select className="select" value={f.counsellor} onChange={(e) => setF({ ...f, counsellor: e.target.value })}><option value="">Unassigned</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>
        <Field label="Interested course" error={errs.interested_course_id}><select className="select" value={f.course} onChange={(e) => setF({ ...f, course: e.target.value })}><option value="">Not sure yet</option>{(courses.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}

function ActivityModal({ learnerId, hasLead, onClose, onDone }: { learnerId: string; hasLead: boolean; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const counsellors = useCounsellors();
  const [f, setF] = useState({ type: 'called_parent', description: '', status: '', next: '', to: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); return run(async () => { try { await api.post(`/api/crm/learners/${learnerId}/activities`, { type: f.type, description: f.description || null, lead_status: f.status || undefined, lost_reason: f.status === 'lost' ? f.description : undefined, next_follow_up_at: f.next ? new Date(f.next).toISOString() : null, assigned_to: f.to || undefined }); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Activity logged').catch(() => {}); };
  return (
    <Modal title="Log activity" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="What happened?"><select className="select" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{ACTIVITY_TYPES.filter((t) => !['status_changed', 'counsellor_assigned', 'batch_assigned'].includes(t)).map((t) => <option key={t} value={t}>{statusLabel(t)}</option>)}</select></Field>
        {hasLead && <Field label="Move to stage (optional)"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="">Keep as is</option>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></Field>}
        <Field label={f.status === 'lost' ? 'Details (also the reason it was lost)' : 'Details'} error={errs.description} className="full"><textarea className="textarea" autoFocus value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Next follow-up (optional)" error={errs.next_follow_up_at}><input className="input" type="datetime-local" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        {f.next && <Field label="Assign to"><select className="select" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">The lead's counsellor, or me</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>}
      </div>
    </Modal>
  );
}

function FollowUpModal({ learnerId, defaultTo, onClose, onDone }: { learnerId: string; defaultTo?: string; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const counsellors = useCounsellors();
  const [f, setF] = useState({ due: '', note: '', to: defaultTo ?? '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); return run(async () => { try { await api.post(`/api/crm/learners/${learnerId}/follow-ups`, { due_at: new Date(f.due).toISOString(), note: f.note || null, assigned_to: f.to || undefined }); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Follow-up scheduled').catch(() => {}); };
  return (
    <Modal title="Schedule a follow-up" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.due} onClick={save}>Schedule</button></>}>
      <div className="form-grid">
        <Field label="Due" error={errs.due_at}><input className="input" type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></Field>
        <Field label="Assign to"><select className="select" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}><option value="">Me</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>
        <Field label="Note" className="full"><input className="input" maxLength={500} placeholder="e.g. Call about demo class" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></Field>
      </div>
    </Modal>
  );
}
