import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { cap, fmtDateTime } from '../format';
import { Async, Badge, Empty, Field, Modal, Stat, fieldErrors, useAction, useFetch } from '../components/ui';

const BAND_TONE: Record<string, string> = { excellent: 'ok', good: 'info', average: 'warn', needs_attention: 'bad' };
const TREND = { up: '▲ Improving', down: '▼ Declining', steady: '● Steady' } as const;
export const PerfBadge = ({ band }: { band: string | null }) => (band ? <Badge tone={BAND_TONE[band]}>{cap(band)}</Badge> : <span className="muted">—</span>);
const fmt = (n: number | null | undefined) => (n == null ? '—' : String(Math.round(n * 100) / 100));

export function SummaryStats({ s }: { s: any }) {
  return (
    <div className="grid cols-4">
      <Stat label="Average" value={s.average_pct == null ? '—' : `${fmt(s.average_pct)}%`} sub={<PerfBadge band={s.performance} />} />
      <Stat label="Total" value={`${fmt(s.total)}/${fmt(s.max_total)}`} sub={s.overall_pct == null ? undefined : `${fmt(s.overall_pct)}% overall`} />
      <Stat label="Completion" value={s.completion_pct == null ? '—' : `${fmt(s.completion_pct)}%`} sub={`${s.scored} of ${s.items} scored`} />
      <Stat label="Trend" value={s.trend ? TREND[s.trend as keyof typeof TREND] : '—'} sub={s.trend ? undefined : 'Needs 4+ scores'} />
    </div>
  );
}

/** Every change to one score: who, when, previous and new values. */
export function HistoryModal({ scoreId, onClose }: { scoreId: string; onClose: () => void }) {
  const q = useFetch(() => api.get(`/api/scores/${scoreId}/history`), [scoreId]);
  return (
    <Modal title={`Score history${q.data?.meta?.activity_name ? ` · ${q.data.meta.activity_name}` : ''}`} onClose={onClose}>
      <Async q={q as any}>{(d: any) => <div className="stack">{d.data.map((h: any) => (
        <div key={h.id} className="m-card" style={{ padding: '8px 0' }}>
          <div className="grow"><b>{cap(h.action)}</b> by {h.changed_by}
            <div>{h.action === 'created' && <>Score {h.new_score}/{h.new_max}</>}{h.action === 'updated' && <>Score {h.previous_score} → <b>{h.new_score}</b> (max {h.new_max})</>}{h.action === 'deleted' && <>Removed score {h.previous_score}/{h.previous_max}</>}</div>
            {(h.new_feedback || h.previous_feedback) && <div className="muted small">{h.action === 'deleted' ? h.previous_feedback : h.new_feedback}</div>}
            <div className="muted small">{fmtDateTime(h.changed_at)}</div></div>
        </div>))}</div>}</Async>
    </Modal>
  );
}

/** Classroom → Grades tab. Managers get the gradebook; learners and parents get their own results. */
export default function Grades({ room }: { room: any }) {
  const [f, setF] = useState({ type: '', category: '', from: '', to: '', search: '' });
  const [sheet, setSheet] = useState<null | 'new' | string>(null);
  const [hist, setHist] = useState<string | null>(null);
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/gradebook${qs(f)}`).then((r) => r.data), [room.id, f.type, f.category, f.from, f.to, f.search]);
  return (
    <div className="stack">
      {room.can_manage && <div className="row wrap">
        <button className="btn primary" onClick={() => setSheet('new')} disabled={!room.writable}>＋ Score an activity</button>
        {!room.writable && <span className="muted small">Closed batches cannot get new activities, but existing scores can be corrected below.</span>}
      </div>}
      <div className="card card-pad"><div className="row wrap">
        <select className="select" style={{ width: 150 }} aria-label="Type" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}><option value="">All types</option><option value="assignment">Assignments</option><option value="quiz">Quizzes</option><option value="activity">Activities</option></select>
        <input className="input" style={{ width: 150 }} placeholder="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} />
        <label className="row small">From <input className="input" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="row small">To <input className="input" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        {room.can_manage && <input className="input" style={{ width: 170 }} placeholder="Search learner" value={f.search} onChange={(e) => setF({ ...f, search: e.target.value })} />}
      </div></div>
      <Async q={q}>{(d: any) => {
        if (!d.columns.length) return <div className="card"><Empty icon="📊" title="Nothing graded yet">{room.can_manage ? 'Assignments, quizzes and activities appear here once they exist.' : 'Your results will show here once your teacher grades something.'}</Empty></div>;
        if (!d.rows.length) return <div className="card"><Empty icon="🔍" title="No learners match">Try clearing the search.</Empty></div>;
        const own = !d.can_manage ? d.rows[0] : null;
        return (<>
          {own && <SummaryStats s={own.summary} />}
          <div className="card table-wrap">
            <table className="t" style={{ minWidth: 520 }}>
              <thead><tr><th style={{ position: 'sticky', left: 0, background: 'var(--card)' }}>Learner</th>
                {d.columns.map((c: any) => <th key={c.key} title={`${cap(c.type)} · ${c.category}`}>{c.name}<div className="muted small">/{fmt(c.max)}</div></th>)}
                <th>Total</th><th>Avg %</th><th>Done</th><th>Level</th><th>Trend</th></tr></thead>
              <tbody>{d.rows.map((r: any) => (
                <tr key={r.learner_id}>
                  <td style={{ position: 'sticky', left: 0, background: 'var(--card)' }}>{d.can_manage ? <Link to={`/learners/${r.learner_id}`}>{r.full_name}</Link> : r.full_name}</td>
                  {d.columns.map((c: any) => { const cell = r.cells[c.key]; return (
                    <td key={c.key}>{cell ? <button className="btn ghost sm" title={cell.feedback || 'View history'} onClick={() => setHist(cell.score_id)}>{fmt(cell.score)} <span className="muted small">{fmt(cell.pct)}%</span></button> : <span className="muted">—</span>}</td>); })}
                  <td>{fmt(r.summary.total)}/{fmt(r.summary.max_total)}</td><td>{r.summary.average_pct == null ? '—' : `${fmt(r.summary.average_pct)}%`}</td>
                  <td>{r.summary.completion_pct == null ? '—' : `${fmt(r.summary.completion_pct)}%`}</td><td><PerfBadge band={r.summary.performance} /></td>
                  <td>{r.summary.trend ? TREND[r.summary.trend as keyof typeof TREND] : '—'}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </>);
      }}</Async>
      {room.can_manage && <Activities key={sheet === null ? "idle" : "open"} room={room} onScore={(id) => setSheet(id)} />}
      {sheet && <SheetModal room={room} activityId={sheet === 'new' ? null : sheet} onClose={() => setSheet(null)} onDone={() => { setSheet(null); q.reload(); }} />}
      {hist && <HistoryModal scoreId={hist} onClose={() => setHist(null)} />}
    </div>
  );
}

function Activities({ room, onScore }: { room: any; onScore: (id: string) => void }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/activities`).then((r) => r.data), [room.id]);
  const { run } = useAction();
  return (
    <div className="card"><div className="card-head"><h2>Manual activities</h2></div>
      <Async q={q} rows={2} empty={(d: any[]) => !d.length}>{(rows: any[]) => rows.length ? rows.map((a) => (
        <div className="m-card" key={a.id} style={{ alignItems: 'center' }}>
          <div className="grow"><b>{a.name}</b><div className="muted small">{a.category || 'Activity'} · max {a.max_score} · {a.scored} scored</div></div>
          <button className="btn sm" onClick={() => onScore(a.id)}>Score</button>
          {room.writable && <button className="btn ghost sm danger" onClick={() => confirm('Delete this activity and its scores? The score history is kept.') && run(async () => { await api.del(`/api/classrooms/${room.id}/activities/${a.id}`); q.reload(); }, 'Activity deleted')}>Delete</button>}
        </div>)) : <div className="m-card muted small">No manual activities yet.</div>}</Async></div>
  );
}

/** Create-or-pick an activity, then score every learner in one sheet. */
function SheetModal({ room, activityId, onClose, onDone }: { room: any; activityId: string | null; onClose: () => void; onDone: () => void }) {
  const [id, setId] = useState<string | null>(activityId);
  const [f, setF] = useState({ name: '', category: 'Project', max_score: '100' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const create = () => { setErrs({}); return run(async () => {
    try { setId((await api.post(`/api/classrooms/${room.id}/activities`, { name: f.name, category: f.category || null, max_score: Number(f.max_score) })).data.id); }
    catch (e) { setErrs(fieldErrors(e)); throw e; } }).catch(() => {}); };
  if (!id) return (
    <Modal title="New activity" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={create}>Next: score learners</button></>}>
      <div className="form-grid">
        <Field label="Activity" error={errs.name} className="full"><input className="input" autoFocus placeholder="e.g. Robotics Project" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Category"><input className="input" list="cats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="cats">{['Project', 'Class participation', 'Competition', 'Practical', 'Test'].map((c) => <option key={c} value={c} />)}</datalist></Field>
        <Field label="Maximum score" error={errs.max_score}><input className="input" type="number" min={1} value={f.max_score} onChange={(e) => setF({ ...f, max_score: e.target.value })} /></Field>
      </div>
    </Modal>);
  return <Sheet room={room} id={id} onClose={onClose} onDone={onDone} />;
}

function Sheet({ room, id, onClose, onDone }: { room: any; id: string; onClose: () => void; onDone: () => void }) {
  const q = useFetch(() => api.get(`/api/classrooms/${room.id}/activities/${id}/scores`).then((r) => r.data), [id]);
  const [edits, setEdits] = useState<Record<string, { score?: string; feedback?: string }>>({});
  const { busy, run } = useAction();
  const d = q.data;
  const save = () => {
    const entries = Object.entries(edits).map(([learner_id, e]) => {
      const row = d.rows.find((r: any) => r.learner_id === learner_id);
      const sc = e.score ?? (row.score == null ? '' : String(row.score));
      return { learner_id, score: sc === '' ? null : Number(sc), feedback: e.feedback ?? row.feedback ?? null };
    });
    if (!entries.length) return onClose();
    return run(async () => { await api.put(`/api/classrooms/${room.id}/activities/${id}/scores`, { entries }); onDone(); }, 'Scores saved').catch(() => {});
  };
  return (
    <Modal wide title={d ? `${d.activity.name} · out of ${d.activity.max_score}` : 'Score learners'} onClose={onClose}
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !Object.keys(edits).length} onClick={save}>{busy ? 'Saving…' : `Save ${Object.keys(edits).length || ''} change${Object.keys(edits).length === 1 ? '' : 's'}`}</button></>}>
      <Async q={q} >{(d: any) => d.rows.length ? <div className="stack">{d.rows.map((r: any) => {
        const e = edits[r.learner_id] ?? {}; const v = e.score ?? (r.score ?? '');
        const bad = v !== '' && (Number(v) < 0 || Number(v) > d.activity.max_score || Number.isNaN(Number(v)));
        return (
          <div key={r.learner_id} className="row wrap" style={{ alignItems: 'flex-start' }}>
            <div style={{ width: 180 }}><b>{r.full_name}</b><div className="muted small">{r.learner_code}</div></div>
            <input className="input" style={{ width: 90, borderColor: bad ? 'var(--bad)' : undefined }} type="number" min={0} max={d.activity.max_score} aria-label={`Score for ${r.full_name}`} placeholder={`/${d.activity.max_score}`} value={v} onChange={(ev) => setEdits({ ...edits, [r.learner_id]: { ...e, score: ev.target.value } })} />
            <input className="input grow" style={{ minWidth: 160 }} aria-label={`Feedback for ${r.full_name}`} placeholder="Feedback (optional)" defaultValue={r.feedback ?? ''} onChange={(ev) => setEdits({ ...edits, [r.learner_id]: { ...(edits[r.learner_id] ?? {}), feedback: ev.target.value } })} />
            {bad && <span className="err small">0 to {d.activity.max_score}</span>}
          </div>); })}</div> : <Empty icon="👥" title="No learners in this batch">Add learners to the batch first.</Empty>}</Async>
    </Modal>
  );
}

/** Scores across every batch: Learner 360 "Performance" tab and a learner's own view. */
export function ScoreList({ learnerId }: { learnerId?: string }) {
  const [type, setType] = useState('');
  const q = useFetch(() => api.get(`/api/scores${qs({ learner_id: learnerId, type })}`), [learnerId, type]);
  const [hist, setHist] = useState<string | null>(null);
  return (
    <div className="stack">
      {q.data?.meta?.summary && <SummaryStats s={q.data.meta.summary} />}
      <div className="card">
        <div className="card-head"><h2>Scores</h2><select className="select" style={{ width: 150 }} aria-label="Type" value={type} onChange={(e) => setType(e.target.value)}><option value="">All types</option><option value="assignment">Assignments</option><option value="quiz">Quizzes</option><option value="activity">Activities</option></select></div>
        <Async q={q as any} empty={(d: any) => !d.data.length}>{(d: any) => d.data.length ? d.data.map((s: any) => (
          <div key={s.id} className="m-card" style={{ alignItems: 'center' }}>
            <div className="grow"><b>{s.activity_name}</b><div className="muted small">{s.batch_name} · {s.category || cap(s.source_type)} · {fmtDateTime(s.updated_at)}</div>{s.feedback && <div className="small" style={{ marginTop: 2 }}>💬 {s.feedback}</div>}</div>
            <div style={{ textAlign: 'right' }}><b>{fmt(s.score)}/{fmt(s.max_score)}</b><div><PerfBadge band={s.band} /></div></div>
            <button className="btn ghost sm" onClick={() => setHist(s.id)}>History</button>
          </div>)) : <Empty icon="📊" title="No scores yet">Scores appear once work is graded.</Empty>}</Async>
      </div>
      {hist && <HistoryModal scoreId={hist} onClose={() => setHist(null)} />}
    </div>
  );
}
