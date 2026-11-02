import { useState } from 'react';
import { Icon } from '../components/Icon';
import { Link } from 'react-router-dom';
import { api } from '../api';
import Player from '../components/Player';
import { coverStyle, MyCourseCard } from '../components/CourseCard';
import { ProgressRing } from '../components/kit';
import { Async, Badge, Empty, PageHead, Progress, Tabs, useFetch } from '../components/ui';
import { fmtDate } from '../format';


/** My courses: pick up where you left off, what is due, what is finished, and a way to find more. */
export function Learn() {
  const q = useFetch(() => api.get('/api/learn/my').then((r) => r.data as any[]), []); const [tab, setTab] = useState<'active' | 'new' | 'done'>('active');
  return (
    <>
      <PageHead title="My courses" sub="Courses your school or team has given you, and the ones you joined. Finish the lessons at your own pace."
        actions={<><Link className="btn" to="/catalog"><Icon name="search" size={15} /> Find courses</Link><Link className="btn" to="/learn/record">My learning record</Link></>} />
      <MyPaths />
      <Async q={q}>{(list: any[]) => {
        const started = list.filter((c) => c.status !== 'completed' && c.done > 0); const fresh = list.filter((c) => c.status !== 'completed' && c.done === 0); const finished = list.filter((c) => c.status === 'completed');
        const resume = [...started].sort((a, b) => +new Date(b.last_activity_at ?? 0) - +new Date(a.last_activity_at ?? 0))[0] ?? fresh[0];
        const rows = tab === 'active' ? started : tab === 'new' ? fresh : finished;
        if (!list.length) return <div className="card"><Empty icon="📚" title="No courses yet" action={<Link className="btn primary" to="/catalog">Browse the catalog</Link>}>When a course is shared with you it shows up here. You can also join open courses from the catalog.</Empty></div>;
        return (<>
          {resume && <Link to={`/learn/${resume.course_id}`} className="resume" style={coverStyle(resume.color)}>
            <i className="cc-glow" aria-hidden /><span className="resume-icon" aria-hidden>{resume.icon ?? '📘'}</span>
            <div className="grow" style={{ minWidth: 0, position: 'relative' }}><div className="resume-k">{resume.done ? 'Continue learning' : 'Start learning'}</div><div className="resume-t">{resume.title}</div><div className="resume-s">{resume.done}/{resume.total} lessons{resume.due_at ? ` · due ${fmtDate(resume.due_at)}` : ''}</div></div>
            <ProgressRing value={resume.percent ?? 0} size={64} stroke={7} label={`${Math.round(resume.percent ?? 0)}%`} />
            <span className="resume-go"><Icon name="play" size={15} /> {resume.done ? 'Resume' : 'Start'}</span></Link>}
          <Tabs value={tab} onChange={setTab} tabs={[{ id: 'active', label: 'In progress', badge: started.length || undefined }, { id: 'new', label: 'Not started', badge: fresh.length || undefined }, { id: 'done', label: 'Completed', badge: finished.length || undefined }]} />
          {!rows.length ? <div className="card"><Empty icon={tab === 'done' ? '🏁' : '📭'} title={tab === 'done' ? 'Nothing finished yet' : 'Nothing here'} /></div> : (
            <div className="course-grid">{rows.map((c) => <MyCourseCard key={c.enrollment_id} c={c} />)}</div>)}</>); }}</Async>
    </>
  );
}

function MyPaths() {
  const q = useFetch(() => api.get('/api/learn/paths').then((r) => r.data as any[]), []);
  if (!q.data?.length) return null;
  return (
    <div className="stack" style={{ marginBottom: 14 }}>{q.data.map((p) => (
      <div key={p.id} className="card card-pad stack"><div className="row between wrap"><div><b style={{ fontSize: 16 }}><Icon name="compass" size={15} /> {p.title}</b>{p.summary && <div className="muted small">{p.summary}</div>}</div>{p.finished ? <Badge tone="ok">Path finished 🎉</Badge> : <span className="muted small">{p.done}/{p.total} courses</span>}</div>
        <Progress value={Math.round((p.done / p.total) * 100)} tone={p.finished ? 'ok' : ''} />
        <div className="row wrap gap-s">{p.steps.map((s: any, i: number) => <span key={s.course_id} className="row gap-s">{i > 0 && <span className="muted">→</span>}
          {s.state === 'locked' ? <span className="badge" title="Finish the course before this one to unlock it"><Icon name="lock" size={15} /> {s.title}</span> : <Link className={`badge ${s.state === 'done' ? 'ok' : 'info'}`} to={`/learn/${s.course_id}`}><Icon name={s.state === 'done' ? 'check' : 'play'} size={13} /> {s.title}</Link>}</span>)}</div></div>))}</div>
  );
}

export function LearnCourse() { return <Player />; }
export function PreviewCourse() { return <Player preview />; }
