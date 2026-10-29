import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async, Badge, Empty, PageHead, Stat, useFetch } from '../components/ui';
import { fmtDate } from '../format';

/** Everything I have finished, with dates, grades and certificates. Print it or save it as a PDF from the browser. */
export default function LearningRecord() {
  const q = useFetch(() => api.get('/api/learn/record').then((r) => r.data as any), []);
  return (
    <>
      <PageHead title="My learning record" sub="Every course you have finished." actions={<button className="btn" onClick={() => window.print()}>🖨 Print or save as PDF</button>} />
      <Async q={q}>{(d: any) => (
        <div className="stack">
          <div className="grid cols-3"><Stat label="Courses finished" value={d.courses.length} /><Stat label="Time spent learning" value={d.minutes_learned >= 60 ? `${Math.floor(d.minutes_learned / 60)}h ${d.minutes_learned % 60}m` : `${d.minutes_learned} min`} sub="from lesson lengths" /><Stat label="Certificates" value={d.courses.filter((c: any) => c.certificate_code).length} /></div>
          {!d.courses.length ? <div className="card"><Empty icon="🏁" title="Nothing finished yet" action={<Link className="btn primary" to="/learn">Go to my courses</Link>}>Finish a course and it will be recorded here.</Empty></div> : <div className="card table-wrap"><table className="t"><thead><tr><th>Course</th><th>Finished</th><th>Grade</th><th>Certificate</th></tr></thead><tbody>{d.courses.map((c: any) => <tr key={c.course_id}><td><b>{c.title}</b><br /><span className="muted small">{[c.category, c.level].filter(Boolean).join(' · ')}</span></td><td className="nowrap">{fmtDate(c.completed_at)}</td><td>{c.grade != null ? `${c.grade}%` : '—'}</td><td>{c.certificate_code ? <Badge tone="ok"><code>{c.certificate_code}</code></Badge> : '—'}</td></tr>)}</tbody></table></div>}
        </div>)}</Async>
    </>
  );
}
