import { useState } from 'react';
import { api } from '../api';
import { fmtDate, fmtDateTime, fmtSchedule } from '../format';
import { LearnerAnalytics } from '../components/Analytics';
import { BadgeWall, Leaderboard, XpCard, XpHistory } from '../components/Gamify';
import { Async, Avatar, Badge, Empty, PageHead, Tabs, useFetch } from '../components/ui';
import { AssignmentList } from './MyAssignments';
import { AttendanceSummary, UpcomingClasses } from './Attendance';
import { ScoreList } from './Grades';

type Tab = 'overview' | 'classes' | 'assignments' | 'scores' | 'attendance' | 'achievements' | 'feedback' | 'announcements' | 'progress';

/** Family portal: one place for children, batches, classes, work, scores, attendance, XP, badges, feedback and announcements. */
export default function Portal() {
  const kids = useFetch(() => api.get('/api/dashboard').then((r) => (r.data.children ?? []) as any[]), []);
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  return (
    <>
      <PageHead title="Family portal" sub="Everything about learning in one place." />
      <Async q={kids}>{(list: any[]) => {
        if (!list.length) return <div className="card"><Empty icon="👨‍👩‍👧" title="No children linked">Ask the academy to link your child to your account.</Empty></div>;
        const kid = list.find((k) => k.id === sel) ?? list[0];
        return (
          <div className="stack">
            {list.length > 1 && <div className="row wrap" role="tablist" aria-label="Choose child">{list.map((k) => (
              <button key={k.id} role="tab" aria-selected={k.id === kid.id} className={`btn ${k.id === kid.id ? 'primary' : ''}`} onClick={() => setSel(k.id)}><Avatar name={k.full_name} /> {k.full_name}</button>))}</div>}
            <div className="card card-pad row"><Avatar name={kid.full_name} lg /><div className="grow"><h2 style={{ margin: 0 }}>{kid.full_name}</h2><div className="muted small">{kid.learner_code} · {kid.batches.length} batch{kid.batches.length === 1 ? '' : 'es'}</div></div></div>
            <Tabs value={tab} onChange={setTab} tabs={[{ id: 'overview', label: 'Overview' }, { id: 'classes', label: 'Classes' }, { id: 'assignments', label: 'Assignments' }, { id: 'scores', label: 'Scores' }, { id: 'attendance', label: 'Attendance' }, { id: 'achievements', label: 'XP & badges' }, { id: 'feedback', label: 'Feedback' }, { id: 'announcements', label: 'Announcements' }, { id: 'progress', label: 'Progress' }]} />
            {tab === 'overview' && <Overview kid={kid} />}
            {tab === 'classes' && <><UpcomingClasses learnerId={kid.id} /><Batches kid={kid} /></>}
            {tab === 'assignments' && <AssignmentList learnerId={kid.id} />}
            {tab === 'scores' && <ScoreList learnerId={kid.id} />}
            {tab === 'attendance' && <AttendanceSummary learnerId={kid.id} />}
            {tab === 'achievements' && <div className="stack"><XpCard learnerId={kid.id} /><BadgeWall learnerId={kid.id} /><XpHistory learnerId={kid.id} />{kid.batches.map((b: any) => <Leaderboard key={b.id} scope="batch" id={b.id} />)}</div>}
            {tab === 'feedback' && <Feedback learnerId={kid.id} />}
            {tab === 'announcements' && <Announcements learnerId={kid.id} />}
            {tab === 'progress' && <LearnerAnalytics learnerId={kid.id} />}
          </div>);
      }}</Async>
    </>
  );
}

function Overview({ kid }: { kid: any }) {
  const sum = useFetch(() => api.get(`/api/attendance/summary?learner_id=${kid.id}`).then((r) => r.data), [kid.id]);
  return (
    <div className="stack">
      <XpCard learnerId={kid.id} />
      <div className="grid cols-2">
        <UpcomingClasses learnerId={kid.id} />
        <div className="card"><div className="card-head"><h2>Attendance</h2></div>
          <Async q={sum} rows={2}>{(d: any) => d.batches.length ? d.batches.map((b: any) => <div className="m-card" key={b.batch_id} style={{ alignItems: 'center' }}><span className="grow">{b.batch_name}</span><Badge tone={b.pct == null ? '' : b.pct < 75 ? 'bad' : 'ok'}>{b.pct == null ? '—' : `${b.pct}%`}</Badge></div>) : <Empty icon="🗓️" title="Nothing marked yet" />}</Async></div>
      </div>
      <Batches kid={kid} />
    </div>
  );
}

function Batches({ kid }: { kid: any }) {
  return (
    <div className="card"><div className="card-head"><h2>Batches</h2></div>
      {kid.batches.length ? kid.batches.map((b: any) => <div key={b.id} className="m-card"><div className="grow"><b>{b.name}</b><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)} · Teacher: {(b.teachers ?? []).map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div></div>) : <Empty icon="🗂️" title="Not in a batch yet" />}</div>
  );
}

function Feedback({ learnerId }: { learnerId: string }) {
  const q = useFetch(() => api.get(`/api/portal/feedback?learner_id=${learnerId}`).then((r) => r.data as any[]), [learnerId]);
  return (
    <div className="card"><div className="card-head"><h2>Teacher feedback</h2></div>
      <Async q={q} rows={3}>{(rows: any[]) => rows.length ? rows.map((f, i) => (
        <div key={i} className="m-card"><div className="grow"><b>{f.title}</b> {f.score != null && <Badge tone="ok">{f.score}/{f.max_score}</Badge>} {f.kind === 'returned' && <Badge tone="warn">Returned for changes</Badge>}
          <div style={{ whiteSpace: 'pre-wrap' }}>💬 {f.feedback}</div><div className="muted small">{f.by_teacher ?? 'Teacher'} · {f.batch_name} · {fmtDate(f.at)}</div></div></div>)) : <Empty icon="💬" title="No feedback yet">Feedback from teachers will appear here.</Empty>}</Async></div>
  );
}

function Announcements({ learnerId }: { learnerId: string }) {
  const q = useFetch(() => api.get(`/api/portal/announcements?learner_id=${learnerId}`).then((r) => r.data as any[]), [learnerId]);
  return (
    <div className="card"><div className="card-head"><h2>Announcements</h2></div>
      <Async q={q} rows={3}>{(rows: any[]) => rows.length ? rows.map((a) => (
        <div key={a.id} className="m-card"><div className="grow"><div className="row wrap"><b>{a.title || a.batch_name}</b>{a.pinned && <Badge tone="info">Pinned</Badge>}</div>
          {a.body && <div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>}{a.url && <a href={a.url} target="_blank" rel="noopener noreferrer nofollow">{a.url}</a>}
          <div className="muted small">{a.author} · {a.batch_name} · {fmtDateTime(a.created_at)}</div></div></div>)) : <Empty icon="📣" title="No announcements">Class announcements will appear here.</Empty>}</Async></div>
  );
}
