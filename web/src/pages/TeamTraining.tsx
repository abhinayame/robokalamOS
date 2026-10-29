import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Async, Empty, PageHead, Stat, useDebounced, useFetch } from '../components/ui';
import { fmtDate } from '../format';

const ROLE: Record<string, string> = { org_admin: 'Admin', branch_admin: 'Branch admin', teacher: 'Teacher', counsellor: 'Counsellor', accountant: 'Accountant' };
const TONE: Record<string, { bg: string; fg: string; label: string }> = { done: { bg: '#dcfce7', fg: '#166534', label: 'Done' }, started: { bg: '#fef9c3', fg: '#854d0e', label: '' }, assigned: { bg: '#e2e8f0', fg: '#334155', label: 'Not started' } };

/** Who on the team has taken which training: one row per person, one column per staff course. */
export default function TeamTraining() {
  const [role, setRole] = useState(''); const [text, setText] = useState(''); const term = useDebounced(text);
  const q = useFetch(() => api.get(`/api/lms/team${qs({ role, q: term })}`).then((r) => r.data as any), [role, term]);
  return (
    <>
      <PageHead title="Team training" sub="Who has done which course. Overdue people are marked in red." actions={<><Link className="btn" to="/courses">← Courses</Link><button className="btn" onClick={() => api.getFile(`/api/lms/team.csv${qs({ role, q: term })}`, 'team-training.csv')}>⬇ CSV</button></>} />
      <div className="row wrap" style={{ marginBottom: 12 }}><select className="select" style={{ width: 190 }} aria-label="Role" value={role} onChange={(e) => setRole(e.target.value)}><option value="">Everyone</option>{Object.entries(ROLE).map(([k, v]) => <option key={k} value={k}>{v}s</option>)}</select>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search by name or e-mail" aria-label="Search people" value={text} onChange={(e) => setText(e.target.value)} /></div>
      <Async q={q}>{(m: any) => (
        <div className="stack">
          <div className="grid cols-4"><Stat label="People" value={m.summary.people} /><Stat label="Courses given" value={m.summary.assigned} /><Stat label="Finished" value={m.summary.done} /><Stat label="Overdue" value={m.summary.overdue} /></div>
          {!m.courses.length ? <div className="card"><Empty icon="🎓" title="No staff courses yet" action={<Link className="btn primary" to="/courses">Create one</Link>}>Create a course for staff or for everyone, publish it, then assign it to roles or people.</Empty></div> : (
            <div className="card table-wrap"><table className="t"><thead><tr><th>Person</th>{m.courses.map((c: any) => <th key={c.id} style={{ minWidth: 120 }}><Link to={`/courses/${c.id}`}>{c.title}</Link></th>)}</tr></thead><tbody>
              {m.rows.map((r: any) => <tr key={r.user_id}><td><b>{r.name}</b><br /><span className="muted small">{r.roles.map((x: string) => ROLE[x] ?? x).join(', ')}</span></td>{m.courses.map((c: any) => { const x = r.cells[c.id]; if (!x) return <td key={c.id} className="muted small">—</td>; const t = TONE[x.status]!; return (
                <td key={c.id} title={x.due_at ? `Due ${fmtDate(x.due_at)}` : undefined}><span style={{ background: x.overdue ? '#fee2e2' : t.bg, color: x.overdue ? '#991b1b' : t.fg, padding: '2px 8px', borderRadius: 999, fontSize: 12, fontWeight: 600 }}>{x.status === 'started' ? `${x.percent}%` : t.label}{x.overdue ? ' · overdue' : ''}</span></td>); })}</tr>)}
              {!m.rows.length && <tr><td colSpan={m.courses.length + 1}><Empty icon="🔎" title="Nobody matches" /></td></tr>}</tbody></table></div>)}
          <p className="muted small">Showing up to 12 published staff courses. “—” means the course was not given to that person.</p>
        </div>)}</Async>
    </>
  );
}
