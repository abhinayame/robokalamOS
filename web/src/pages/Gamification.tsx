import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Leaderboard } from '../components/Gamify';
import { Async, Badge, Empty, Field, Modal, PageHead, Tabs, fieldErrors, useAction, useFetch } from '../components/ui';

type Tab = 'badges' | 'levels' | 'leaderboard';

/** Admin hub: badge catalogue, level thresholds, and the on/off switch for competition. */
export default function Gamification() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('badges');
  return (
    <>
      <PageHead title="Gamification" sub="Badges, levels and the optional leaderboard. XP itself is a ledger: every point has a reason and an author." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'badges', label: 'Badges' }, { id: 'levels', label: 'Levels' }, { id: 'leaderboard', label: 'Leaderboard' }]} />
      {tab === 'badges' && <Badges canManage={can('gamification:manage')} />}
      {tab === 'levels' && <Levels canManage={can('gamification:manage')} />}
      {tab === 'leaderboard' && <Board canManage={can('gamification:manage')} />}
    </>
  );
}

function Badges({ canManage }: { canManage: boolean }) {
  const q = useFetch(() => api.get('/api/gamification/badges').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  return (
    <div className="stack">
      {canManage && <div><button className="btn primary" onClick={() => setEdit('new')}>＋ New badge</button></div>}
      <Async q={q}>{(rows: any[]) => rows.length ? <div className="grid cols-3">{rows.map((b) => (
        <div key={b.id} className="card card-pad stack" style={{ gap: 6, opacity: b.status === 'active' ? 1 : 0.6 }}>
          <div className="row"><span style={{ fontSize: 32 }} aria-hidden>{b.icon}</span><div className="grow"><b>{b.name}</b><div className="muted small">{b.category || 'General'}</div></div>{b.status !== 'active' && <Badge>{b.status}</Badge>}</div>
          {b.description && <div className="small">{b.description}</div>}
          {b.criteria && <div className="muted small">Criteria: {b.criteria}</div>}
          <div className="row between small"><span>{b.xp_reward ? `+${b.xp_reward} XP` : 'No XP'}</span><span className="muted">{b.awarded} awarded</span></div>
          {canManage && <button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setEdit(b)}>Edit</button>}
        </div>))}</div> : <div className="card"><Empty icon="🏅" title="No badges yet">{canManage ? 'Create the badges your teachers can award.' : 'An admin has not created badges yet.'}</Empty></div>}</Async>
      {edit && <BadgeModal badge={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.reload(); }} />}
    </div>
  );
}

const ICONS = ['🏆', '💡', '💻', '🤖', '🌟', '🎯', '🔥', '🤝', '🧠', '🚀', '🎨', '📚'];
function BadgeModal({ badge, onClose, onDone }: { badge: any | null; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: badge?.name ?? '', description: badge?.description ?? '', icon: badge?.icon ?? '🏆', category: badge?.category ?? '', xp_reward: String(badge?.xp_reward ?? 0), criteria: badge?.criteria ?? '', status: badge?.status ?? 'active' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); const body = { ...f, description: f.description || null, category: f.category || null, criteria: f.criteria || null, xp_reward: Number(f.xp_reward) || 0 };
    return run(async () => { try { badge ? await api.patch(`/api/gamification/badges/${badge.id}`, body) : await api.post('/api/gamification/badges', body); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Badge saved').catch(() => {}); };
  return (
    <Modal title={badge ? 'Edit badge' : 'New badge'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>Save</button></>}>
      <div className="form-grid">
        <Field label="Name" error={errs.name} className="full"><input className="input" maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Icon" className="full"><div className="chips">{ICONS.map((i) => <button key={i} type="button" className={`btn sm ${f.icon === i ? 'primary' : ''}`} aria-label={`Icon ${i}`} onClick={() => setF({ ...f, icon: i })}>{i}</button>)}</div></Field>
        <Field label="Category"><input className="input" maxLength={60} value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /></Field>
        <Field label="XP reward" error={errs.xp_reward}><input className="input" type="number" min={0} max={10000} value={f.xp_reward} onChange={(e) => setF({ ...f, xp_reward: e.target.value })} /></Field>
        <Field label="Description" className="full"><input className="input" maxLength={500} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label="Criteria (what earns it)" className="full"><input className="input" maxLength={500} value={f.criteria} onChange={(e) => setF({ ...f, criteria: e.target.value })} /></Field>
        {badge && <Field label="Status"><select className="select" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}><option value="active">Active</option><option value="inactive">Inactive (cannot be awarded)</option><option value="archived">Archived (hidden)</option></select></Field>}
      </div>
    </Modal>
  );
}

function Levels({ canManage }: { canManage: boolean }) {
  const q = useFetch(() => api.get('/api/gamification/levels'), []);
  const [rows, setRows] = useState<{ name: string; min_xp: string }[] | null>(null);
  const { busy, run } = useAction();
  const [err, setErr] = useState('');
  const save = () => { setErr(''); return run(async () => { try { await api.put('/api/gamification/levels', { levels: rows!.map((r) => ({ name: r.name, min_xp: Number(r.min_xp) })) }); setRows(null); q.reload(); } catch (e: any) { setErr(e.message); throw e; } }, 'Levels saved').catch(() => {}); };
  const reset = () => confirm('Go back to the default levels?') && run(async () => { await api.put('/api/gamification/levels', { reset: true }); setRows(null); q.reload(); }, 'Levels reset');
  return (
    <Async q={q as any}>{(d: any) => {
      const view = rows ?? d.data.map((l: any) => ({ name: l.name, min_xp: String(l.min_xp) }));
      return (
        <div className="card card-pad stack">
          <div className="muted small">{d.meta.custom ? 'Custom levels' : 'Default levels'}. A learner is at the highest level whose XP they have reached.</div>
          {view.map((l: any, i: number) => (
            <div className="row wrap" key={i}><b style={{ width: 70 }}>Level {i + 1}</b>
              <input className="input grow" aria-label={`Level ${i + 1} name`} disabled={!canManage} value={l.name} onChange={(e) => setRows(view.map((x: any, j: number) => (j === i ? { ...x, name: e.target.value } : x)))} />
              <label className="row small">from <input className="input" style={{ width: 100 }} type="number" min={0} aria-label={`Level ${i + 1} minimum XP`} disabled={!canManage || i === 0} value={l.min_xp} onChange={(e) => setRows(view.map((x: any, j: number) => (j === i ? { ...x, min_xp: e.target.value } : x)))} /> XP</label>
              {canManage && view.length > 1 && i > 0 && <button className="btn ghost sm" aria-label="Remove level" onClick={() => setRows(view.filter((_: any, j: number) => j !== i))}>✕</button>}
            </div>))}
          {err && <div className="err" role="alert">{err}</div>}
          {canManage && <div className="row wrap">
            {view.length < 20 && <button className="btn sm" onClick={() => setRows([...view, { name: `Level ${view.length + 1}`, min_xp: String((Number(view[view.length - 1].min_xp) || 0) + 500) }])}>＋ Add level</button>}
            <button className="btn primary" disabled={busy || !rows} onClick={save}>Save levels</button>
            {d.meta.custom && <button className="btn" disabled={busy} onClick={reset}>Reset to defaults</button>}
          </div>}
        </div>);
    }}</Async>
  );
}

function Board({ canManage }: { canManage: boolean }) {
  const s = useFetch(() => api.get('/api/gamification/settings').then((r) => r.data), []);
  const { busy, run } = useAction();
  const [scope, setScope] = useState<'batch' | 'course' | 'program' | 'all'>('all');
  const [pick, setPick] = useState('');
  const batches = useFetch(() => api.get('/api/batches?page_size=100&sort=name').then((r) => r.data as any[]), []);
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const programs = useFetch(() => api.get('/api/programs').then((r) => r.data as any[]), []);
  const toggle = (v: boolean) => run(async () => { await api.put('/api/gamification/settings', { leaderboard_enabled: v }); s.reload(); }, v ? 'Leaderboard is on' : 'Leaderboard is off');
  const options = scope === 'batch' ? batches.data : scope === 'course' ? courses.data : scope === 'program' ? programs.data : [];
  return (
    <div className="stack">
      <div className="card card-pad row wrap between">
        <div><b>Leaderboard {s.data?.leaderboard_enabled ? 'is on' : 'is off'}</b><div className="muted small">Competition is optional. When off, nobody sees rankings; XP and badges still work.</div></div>
        {canManage && s.data && <button className={`btn ${s.data.leaderboard_enabled ? '' : 'primary'}`} disabled={busy} onClick={() => toggle(!s.data.leaderboard_enabled)}>{s.data.leaderboard_enabled ? 'Turn off' : 'Turn on'}</button>}
      </div>
      {s.data?.leaderboard_enabled && <>
        <div className="row wrap">
          <select className="select" style={{ width: 160 }} aria-label="Scope" value={scope} onChange={(e) => { setScope(e.target.value as any); setPick(''); }}><option value="all">All my batches</option><option value="program">Program</option><option value="course">Course</option><option value="batch">Batch</option></select>
          {scope !== 'all' && <select className="select" style={{ width: 240 }} aria-label="Choose" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Choose…</option>{(options ?? []).map((o: any) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>}
        </div>
        {(scope === 'all' || pick) ? <Leaderboard key={`${scope}${pick}`} scope={scope} id={pick || undefined} /> : <div className="card"><Empty icon="🎯" title="Choose what to rank">Pick a {scope} above.</Empty></div>}
      </>}
    </div>
  );
}
