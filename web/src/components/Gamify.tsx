import { useState } from 'react';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime } from '../format';
import { Async, Badge, Empty, Field, Modal, Progress, fieldErrors, useAction, useFetch, useToast } from './ui';

export interface Target { id: string; name: string }

/** XP, level, progress to the next level. */
export function XpCard({ learnerId }: { learnerId?: string }) {
  const q = useFetch(() => api.get(`/api/gamification/overview${qs({ learner_id: learnerId })}`).then((r) => r.data), [learnerId]);
  return (
    <Async q={q} rows={2}>{(o: any) => (
      <div className="card card-pad stack">
        <div className="row wrap between">
          <div><div className="muted small">Level {o.level.level_no}</div><div style={{ fontSize: 24, fontWeight: 700 }}>{o.level.name}</div></div>
          <div style={{ textAlign: 'right' }}><div style={{ fontSize: 28, fontWeight: 800 }}>{o.xp} XP</div><div className="muted small">{o.xp_last_7_days >= 0 ? '+' : ''}{o.xp_last_7_days} this week · {o.badges} badge{o.badges === 1 ? '' : 's'}</div></div>
        </div>
        <Progress value={o.progress_pct} tone="ok" />
        <div className="muted small">{o.next ? `${o.xp_to_next} XP to ${o.next.name}` : 'Top level reached 🎉'}</div>
      </div>)}</Async>
  );
}

/** The achievement wall: badge, description, date, teacher, reason, XP. */
export function BadgeWall({ learnerId, onRevoked }: { learnerId?: string; onRevoked?: () => void }) {
  const { can } = useAuth();
  const q = useFetch(() => api.get(`/api/gamification/achievements${qs({ learner_id: learnerId })}`).then((r) => r.data), [learnerId]);
  const { run } = useAction();
  const revoke = (id: string) => { const reason = prompt('Why is this badge being taken back?'); if (reason && reason.trim().length >= 2) run(async () => { await api.post(`/api/gamification/learner-badges/${id}/revoke`, { reason }); q.reload(); onRevoked?.(); }, 'Badge revoked'); };
  return (
    <Async q={q} rows={2}>{(rows: any[]) => rows.length ? (
      <div className="grid cols-3">{rows.map((b) => (
        <div key={b.id} className="card card-pad stack" style={{ gap: 6 }}>
          <div className="row"><span style={{ fontSize: 34 }} aria-hidden>{b.icon}</span><div className="grow"><b>{b.name}</b>{b.category && <div className="muted small">{b.category}</div>}</div>{b.xp_awarded > 0 && <Badge tone="ok">+{b.xp_awarded} XP</Badge>}</div>
          {b.description && <div className="small">{b.description}</div>}
          {b.reason && <div className="small">“{b.reason}”</div>}
          <div className="muted small">{fmtDate(b.awarded_at)} · by {b.awarded_by}{b.batch_name ? ` · ${b.batch_name}` : ''}</div>
          {can('gamification:award') && <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => revoke(b.id)}>Revoke</button>}
        </div>))}</div>
    ) : <div className="card"><Empty icon="🏅" title="No badges yet">Badges your teachers award will appear here.</Empty></div>}</Async>
  );
}

export function XpHistory({ learnerId }: { learnerId?: string }) {
  const [page, setPage] = useState(1);
  const q = useFetch(() => api.get(`/api/gamification/xp${qs({ learner_id: learnerId, page })}`), [learnerId, page]);
  return (
    <div className="card"><div className="card-head"><h2>XP history</h2>{q.data && <span className="muted small">Balance {q.data.meta.balance}</span>}</div>
      <Async q={q as any} rows={3}>{(d: any) => d.data.length ? <>{d.data.map((x: any) => (
        <div key={x.id} className="m-card" style={{ alignItems: 'center' }}>
          <div className="grow"><b>{x.reason}</b><div className="muted small">{fmtDateTime(x.created_at)}{x.awarded_by ? ` · ${x.awarded_by}` : ''}{x.batch_name ? ` · ${x.batch_name}` : ''}</div></div>
          <b style={{ color: x.points > 0 ? 'var(--ok)' : 'var(--bad)' }}>{x.points > 0 ? '+' : ''}{x.points}</b></div>))}
        {d.meta.total > page * d.meta.page_size && <div className="m-card"><button className="btn sm" onClick={() => setPage(page + 1)}>Show older</button></div>}
        {page > 1 && <div className="m-card"><button className="btn ghost sm" onClick={() => setPage(page - 1)}>Newer</button></div>}</>
        : <Empty icon="⚡" title="No XP yet">XP is earned for participation, projects and badges.</Empty>}</Async></div>
  );
}

/** Optional leaderboard; explains itself when an admin has it switched off. */
export function Leaderboard({ scope = 'batch', id }: { scope?: 'batch' | 'course' | 'program' | 'all'; id?: string }) {
  const [period, setPeriod] = useState('all');
  const q = useFetch(() => api.get(`/api/gamification/leaderboard${qs({ scope, id, period })}`), [scope, id, period]);
  const off = (q.error as any)?.code === 'LEADERBOARD_DISABLED';
  return (
    <div className="card"><div className="card-head"><h2>Leaderboard</h2>
      {!off && <select className="select" style={{ width: 150 }} aria-label="Period" value={period} onChange={(e) => setPeriod(e.target.value)}><option value="all">All time</option><option value="month">Last 30 days</option><option value="week">Last 7 days</option></select>}</div>
      {off ? <Empty icon="🎯" title="Leaderboard is off">Your organization has not turned the leaderboard on. Keep learning at your own pace.</Empty> :
        <Async q={q as any} rows={4}>{(d: any) => <>
          {d.data.map((r: any) => <Row key={r.learner_id} r={r} />)}
          {d.meta.me.length > 0 && <><div className="m-card muted small">Your position</div>{d.meta.me.map((r: any) => <Row key={r.learner_id} r={r} />)}</>}</>}</Async>}
    </div>
  );
}
const Row = ({ r }: { r: any }) => (
  <div className="m-card" style={{ alignItems: 'center', background: r.is_me ? 'var(--info-soft)' : undefined }}>
    <b style={{ width: 34 }}>{r.rank <= 3 ? ['🥇', '🥈', '🥉'][r.rank - 1] : `#${r.rank}`}</b><span className="grow">{r.full_name}{r.is_me && <> <Badge tone="info">You</Badge></>}</span>
    {r.badges > 0 && <span className="muted small">🏅 {r.badges}</span>}<b>{r.xp} XP</b></div>
);

/** Award XP to one or many learners. Teachers must pick a classroom; admins may leave it blank. */
export function AwardXpModal({ batches, learners, fixedLearner, onClose, onDone }: { batches: Target[]; learners?: Target[]; fixedLearner?: Target; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [batch, setBatch] = useState(batches.length === 1 ? batches[0].id : '');
  const [picked, setPicked] = useState<string[]>(fixedLearner ? [fixedLearner.id] : []);
  const [f, setF] = useState({ points: '10', reason: '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [requestId] = useState(() => crypto.randomUUID());
  const admin = can('gamification:manage');
  const submit = () => { setErrs({}); return run(async () => {
    try { await api.post('/api/gamification/xp', { batch_id: batch || null, learner_ids: picked, points: Number(f.points), reason: f.reason, request_id: requestId }); onDone(); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }, `${f.points} XP awarded`).catch(() => {}); };
  return (
    <Modal title={fixedLearner ? `Award XP · ${fixedLearner.name}` : 'Award XP'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !picked.length || (!batch && !admin) || f.reason.trim().length < 2 || !Number(f.points)} onClick={submit}>{busy ? 'Awarding…' : `Award to ${picked.length} learner${picked.length === 1 ? '' : 's'}`}</button></>}>
      <div className="form-grid">
        {(batches.length > 1 || admin) && <Field label={admin ? 'Classroom (optional)' : 'Classroom'} className="full"><select className="select" value={batch} onChange={(e) => setBatch(e.target.value)}>{admin && <option value="">No classroom</option>}{!admin && <option value="">Choose…</option>}{batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
        <Field label="XP" error={errs.points} hint={admin ? 'Negative numbers correct a mistake.' : undefined}><input className="input" type="number" value={f.points} onChange={(e) => setF({ ...f, points: e.target.value })} /></Field>
        <Field label="Reason" error={errs.reason}><input className="input" autoFocus maxLength={255} placeholder="e.g. Class participation" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        {!fixedLearner && learners && <div className="full"><LearnerPicker learners={learners} value={picked} onChange={setPicked} /></div>}
      </div>
      <div className="row wrap" style={{ marginTop: 8 }}>{[10, 20, 25, 50, 100].map((n) => <button key={n} type="button" className="btn sm" onClick={() => setF({ ...f, points: String(n) })}>+{n}</button>)}</div>
    </Modal>
  );
}

export function AwardBadgeModal({ batches, learners, fixedLearner, onClose, onDone }: { batches: Target[]; learners?: Target[]; fixedLearner?: Target; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  const toast = useToast();
  const badges = useFetch(() => api.get('/api/gamification/badges').then((r) => (r.data as any[]).filter((b) => b.status === 'active')), []);
  const [batch, setBatch] = useState(batches.length === 1 ? batches[0].id : '');
  const [badgeId, setBadgeId] = useState('');
  const [reason, setReason] = useState('');
  const [picked, setPicked] = useState<string[]>(fixedLearner ? [fixedLearner.id] : []);
  const admin = can('gamification:manage');
  const chosen = badges.data?.find((b: any) => b.id === badgeId);
  const submit = () => run(async () => { const r = (await api.post(`/api/gamification/badges/${badgeId}/award`, { batch_id: batch || null, learner_ids: picked, reason: reason || null })).data;
    if (!r.awarded) { toast('Everyone selected already has this badge.', 'err'); return; } onDone(); }, 'Badge awarded').catch(() => {});
  return (
    <Modal title={fixedLearner ? `Award a badge · ${fixedLearner.name}` : 'Award a badge'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !badgeId || !picked.length || (!batch && !admin)} onClick={submit}>{busy ? 'Awarding…' : 'Award badge'}</button></>}>
      <Async q={badges} rows={2}>{(list: any[]) => list.length ? (
        <div className="form-grid">
          {(batches.length > 1 || admin) && <Field label={admin ? 'Classroom (optional)' : 'Classroom'} className="full"><select className="select" value={batch} onChange={(e) => setBatch(e.target.value)}>{admin ? <option value="">No classroom</option> : <option value="">Choose…</option>}{batches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>}
          <Field label="Badge" className="full"><select className="select" value={badgeId} onChange={(e) => setBadgeId(e.target.value)}><option value="">Choose a badge…</option>{list.map((b) => <option key={b.id} value={b.id}>{b.icon} {b.name}{b.xp_reward ? ` (+${b.xp_reward} XP)` : ''}</option>)}</select></Field>
          {chosen?.description && <div className="full muted small">{chosen.description}</div>}
          <Field label="Reason (shown on the achievement wall)" className="full"><input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
          {!fixedLearner && learners && <div className="full"><LearnerPicker learners={learners} value={picked} onChange={setPicked} /></div>}
        </div>) : <Empty icon="🏅" title="No badges yet">{admin ? 'Create badges under Gamification first.' : 'Ask an admin to create badges.'}</Empty>}</Async>
    </Modal>
  );
}

function LearnerPicker({ learners, value, onChange }: { learners: Target[]; value: string[]; onChange: (v: string[]) => void }) {
  const all = value.length === learners.length;
  return (
    <div><div className="row between"><b>Learners</b><button type="button" className="btn ghost sm" onClick={() => onChange(all ? [] : learners.map((l) => l.id))}>{all ? 'Clear' : 'Select all'}</button></div>
      <div style={{ maxHeight: 200, overflow: 'auto', border: '1px solid var(--line)', borderRadius: 8, padding: 6 }}>
        {learners.map((l) => <label key={l.id} className="row small" style={{ padding: '4px 2px' }}><input type="checkbox" checked={value.includes(l.id)} onChange={() => onChange(value.includes(l.id) ? value.filter((x) => x !== l.id) : [...value, l.id])} />{l.name}</label>)}
        {!learners.length && <span className="muted small">No learners.</span>}
      </div></div>
  );
}
