import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, fmtMobile } from '../format';
import { statusLabel, statusTone } from '../components/Crm';
import { Async, Badge, Empty, Field, Modal, PageHead, Tabs, useAction, useFetch } from '../components/ui';

type Bucket = 'overdue' | 'today' | 'upcoming' | 'done';

export default function FollowUps() {
  const { can } = useAuth();
  const [bucket, setBucket] = useState<Bucket>('overdue');
  const [who, setWho] = useState<'mine' | 'all'>('mine');
  const [done, setDone] = useState<any>(null);
  const q = useFetch(() => api.get(`/api/crm/follow-ups${qs({ who, bucket })}`), [bucket, who]);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Follow-ups" sub="Calls and messages that are due." actions={<select className="select" style={{ width: 160 }} aria-label="Whose" value={who} onChange={(e) => setWho(e.target.value as any)}><option value="mine">Assigned to me</option><option value="all">Everyone's</option></select>} />
      <Tabs value={bucket} onChange={setBucket} tabs={[{ id: 'overdue', label: 'Overdue' }, { id: 'today', label: 'Today' }, { id: 'upcoming', label: 'Upcoming' }, { id: 'done', label: 'Done' }]} />
      <Async q={q as any}>{(d: any) => d.data.length ? <div className="card">{d.data.map((f: any) => (
        <div key={f.id} className="m-card" style={{ alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="grow"><Link to={`/learners/${f.learner_id}`}><b>{f.full_name}</b></Link> {f.lead_status && <Badge tone={statusTone(f.lead_status)}>{statusLabel(f.lead_status)}</Badge>}
            <div className="small">{f.note || 'Follow up'}</div>
            <div className="muted small" style={{ color: f.overdue ? 'var(--bad)' : undefined }}>{f.status === 'done' ? `Done ${fmtDateTime(f.completed_at)}` : `${f.overdue ? 'Overdue · ' : ''}${fmtDateTime(f.due_at)}`} · {f.assigned_name} · {fmtMobile(f.mobile)}</div></div>
          {f.mobile && f.status === 'open' && <a className="btn sm" href={`tel:${f.mobile}`}>📞 Call</a>}
          {can('crm:manage') && f.status === 'open' && <><button className="btn primary sm" onClick={() => setDone(f)}>Done</button><button className="btn ghost sm danger" onClick={() => confirm('Cancel this follow-up?') && run(async () => { await api.post(`/api/crm/follow-ups/${f.id}/cancel`); q.reload(); }, 'Cancelled')}>Cancel</button></>}
        </div>))}</div> : <div className="card"><Empty icon={bucket === 'done' ? '📋' : '🎉'} title={bucket === 'overdue' ? 'Nothing overdue' : bucket === 'today' ? 'Nothing due today' : bucket === 'upcoming' ? 'Nothing scheduled' : 'Nothing completed yet'}>{bucket === 'upcoming' ? 'Schedule follow-ups from a lead or learner profile.' : 'You are all caught up.'}</Empty></div>}</Async>
      {done && <DoneModal f={done} onClose={() => setDone(null)} onDone={() => { setDone(null); q.reload(); }} />}
    </>
  );
}

function DoneModal({ f, onClose, onDone }: { f: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [outcome, setOutcome] = useState(''); const [next, setNext] = useState('');
  return (
    <Modal title={`Follow-up done · ${f.full_name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => run(async () => { await api.post(`/api/crm/follow-ups/${f.id}/complete`, { outcome: outcome || null, next_follow_up_at: next ? new Date(next).toISOString() : null }); onDone(); }, 'Follow-up completed').catch(() => {})}>Mark done</button></>}>
      <div className="stack">
        <Field label="What happened?"><textarea className="textarea" autoFocus value={outcome} onChange={(e) => setOutcome(e.target.value)} /></Field>
        <Field label="Next follow-up (optional)" hint="Leave empty if nothing more is needed."><input className="input" type="datetime-local" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}
