import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtSchedule } from '../format';
import { BarRow } from '../components/Charts';
import { Async, Avatar, Badge, Empty, PageHead, Progress, Stat, StatusBadge, Tabs, useFetch } from '../components/ui';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

export default function Dashboard() {
  const { me, hasRole, activeOrg } = useAuth();
  const [view, setView] = useState<string | undefined>();
  const q = useFetch(() => api.get(`/api/dashboard${view ? `?view=${view}` : ''}`).then((r) => r.data), [view, activeOrg]);
  if (hasRole('super_admin') && !me?.organization && !activeOrg) {
    return <><PageHead title="Platform" sub="Choose an organization from the top bar to work inside it, or manage organizations." /><Empty icon="🏢" title="No organization selected" action={<Link className="btn primary" to="/organizations">Manage organizations</Link>}>You are signed in as the platform owner.</Empty></>;
  }
  return (
    <>
      <PageHead title={`Welcome, ${me?.full_name.split(' ')[0] ?? ''}`} sub={me?.organization?.name} />
      <Async q={q}>{(d: any) => (
        <div className="stack">
          {d.available_views.length > 1 && <Tabs tabs={d.available_views.map((v: string) => ({ id: v, label: v[0].toUpperCase() + v.slice(1) }))} value={d.view} onChange={setView} />}
          {d.view === 'admin' && <AdminView d={d} />}
          {d.view === 'teacher' && <TeacherView d={d} />}
          {(d.view === 'learner' || d.view === 'parent') && <ChildrenView d={d} parent={d.view === 'parent'} />}
        </div>
      )}</Async>
    </>
  );
}

function Classes({ items, title }: { items: any[]; title: string }) {
  return (
    <div className="card"><div className="card-head"><h2>{title}</h2></div>
      {!items.length ? <Empty icon="🗓️" title="No classes scheduled">Classes appear here once batches have a weekly schedule.</Empty> : (
        <div>{items.map((c, i) => (
          <div key={i} className="m-card" style={{ alignItems: 'center' }}>
            <div className="badge info nowrap">{fmtDate(c.date)}</div>
            <div className="grow"><Link to={`/batches/${c.batch_id}`}><b>{c.batch_name}</b></Link><div className="muted small">{c.start ? `${c.start}–${c.end}` : 'Time not set'}{c.mode ? ` · ${c.mode}` : ''}{c.venue ? ` · ${c.venue}` : ''}</div></div>
          </div>))}</div>)}
    </div>
  );
}

function AdminView({ d }: { d: any }) {
  const max = Math.max(1, ...d.enrollment_trend.map((t: any) => t.learners));
  return (
    <>
      <div className="grid cols-4">
        <Stat label="Total learners" value={fmtNum(d.learners.total)} sub={<>{fmtNum(d.learners.active)} active · {fmtNum(d.learners.inactive)} inactive</>} />
        <Stat label="Batches" value={fmtNum(d.batches.total)} sub={<>{d.batches.active} active · {d.batches.upcoming} upcoming</>} />
        <Stat label="Teachers" value={fmtNum(d.teachers)} />
        <Stat label="Active batch memberships" value={fmtNum(d.active_memberships)} sub={<>{fmtNum(d.learners.multi_batch)} learners in 2+ batches</>} />
      </div>
      {d.kpis && <>
        <div className="grid cols-4">
          <Stat label="Attendance" value={pct(d.kpis.attendance_pct)} sub="Present or late, of marked classes" />
          <Stat label="Average score" value={pct(d.kpis.avg_score_pct)} sub={`${fmtNum(d.kpis.scores_recorded)} scores recorded`} />
          <Stat label="Waiting for evaluation" value={fmtNum(d.kpis.pending_evaluations)} />
          <Stat label="Classes in the next 7 days" value={fmtNum(d.kpis.upcoming_classes_7d)} />
          <Stat label="Total XP" value={fmtNum(d.kpis.total_xp)} />
          <Stat label="Badges awarded" value={fmtNum(d.kpis.badges_awarded)} />
          {d.kpis.crm && <Stat label="CRM leads" value={fmtNum(d.kpis.crm.leads)} sub={<Link to="/crm">{d.kpis.crm.open} open · {d.kpis.crm.converted} converted</Link>} />}
          {d.kpis.fees && <Stat label="Fees outstanding" value={fmtMoney(d.kpis.fees.outstanding)} sub={<Link to="/fees">{fmtMoney(d.kpis.fees.overdue)} overdue · {fmtMoney(d.kpis.fees.collected_this_month)} collected this month</Link>} />}
          {d.kpis.campaigns && <Stat label="WhatsApp campaigns" value={fmtNum(d.kpis.campaigns.total)} sub={<Link to="/communication">{d.kpis.campaigns.active} running</Link>} />}
        </div>
        <div className="row wrap"><Link className="btn sm" to="/analytics">Compare batches</Link><Link className="btn sm" to="/reports">Reports</Link></div>
      </>}
      {d.learners.without_batch > 0 && <div className="banner" style={{ borderRadius: 10, border: '1px solid var(--line)' }}>⚠️ {fmtNum(d.learners.without_batch)} active learners are not in any batch. <Link to="/learners?no_batch=true">Review them</Link></div>}
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Fullest batches</h2><Link to="/batches" className="small">All batches</Link></div>
          {!d.top_batches.length ? <Empty title="No batches yet">Create a batch to start enrolling learners.</Empty> : d.top_batches.map((b: any) => (
            <div key={b.id} className="m-card" style={{ display: 'block' }}>
              <div className="row between"><Link to={`/batches/${b.id}`}><b>{b.name}</b></Link><span className="small">{b.active_learners}{b.capacity ? ` / ${b.capacity}` : ''}</span></div>
              {b.capacity ? <Progress value={(b.active_learners / b.capacity) * 100} tone={b.active_learners >= b.capacity ? 'bad' : ''} /> : <span className="muted small">No capacity limit</span>}
            </div>))}
        </div>
        <div className="card"><div className="card-head"><h2>New learners · last 6 months</h2></div>
          <div className="card-pad">{!d.enrollment_trend.length ? <span className="muted">No enrolments yet.</span> : d.enrollment_trend.map((t: any) => (
            <div key={t.month} className="bar-row"><span className="muted">{t.month}</span><div className="bar"><i style={{ width: `${(t.learners / max) * 100}%` }} /></div><b>{t.learners}</b></div>))}</div>
        </div>
      </div>
      <div className="grid cols-2">
        <Classes items={d.upcoming_classes} title="Upcoming classes" />
        <div className="card"><div className="card-head"><h2>Recent learner activity</h2></div>
          {!d.recent_activity.length ? <Empty title="No activity yet" /> : d.recent_activity.map((a: any) => (
            <div key={a.id} className="m-card"><Avatar name={a.full_name} /><div className="grow"><Link to={`/learners/${a.learner_id}`}><b>{a.full_name}</b></Link> <span className="muted small">{a.learner_code}</span><div>{a.title}</div><div className="muted small">{fmtDateTime(a.occurred_at)}</div></div></div>))}
        </div>
      </div>
    </>
  );
}

function TeacherView({ d }: { d: any }) {
  return (
    <>
      <div className="grid cols-4">
        <Stat label="My batches" value={d.my_batches.length} />
        <Stat label="My learners (unique)" value={fmtNum(d.unique_learners)} sub={<>{fmtNum(d.batch_memberships)} batch memberships</>} />
        <Stat label="Waiting for evaluation" value={fmtNum(d.pending_evaluations_total)} />
        <Stat label="Classes today" value={d.today_sessions.length || d.today_classes.length} />
        <Stat label="Attendance" value={pct(d.attendance_pct)} />
        <Stat label="Average score" value={pct(d.avg_score_pct)} />
        <Stat label="Assignments" value={fmtNum(d.assignments_total)} />
        <Stat label="Badges awarded (30 days)" value={fmtNum(d.badges_awarded_30d)} />
      </div>
      <div className="card card-pad"><b>Quick actions</b><div className="row wrap" style={{ marginTop: 8 }}>
        {d.my_batches.length > 0 && <>
          <Link className="btn sm" to={`/classroom/${d.my_batches[0].id}`}>＋ Assignment or material</Link><Link className="btn sm" to="/communication">Post announcement</Link>
          <Link className="btn sm" to={`/classroom/${d.my_batches[0].id}`}>Mark attendance</Link><Link className="btn sm" to={`/classroom/${d.my_batches[0].id}`}>Give score</Link><Link className="btn sm" to={`/classroom/${d.my_batches[0].id}`}>Award badge</Link></>}
        {!d.my_batches.length && <span className="muted small">Quick actions appear once you are assigned to a batch.</span>}</div></div>
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Today’s classes</h2></div>
          {d.today_sessions.length ? d.today_sessions.map((c: any) => (
            <div key={c.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/classroom/${c.batch_id}`}><b>{c.batch_name}</b></Link><div className="muted small">{c.title ?? 'Class'} · {fmtDateTime(c.starts_at)}</div></div>
              <Badge tone={c.marked ? 'ok' : 'warn'}>{c.marked ? `${c.marked} marked` : 'Attendance not marked'}</Badge>{c.meeting_url !== undefined || c.has_meeting ? <Badge>link set</Badge> : null}</div>))
            : <Classes items={d.today_classes} title="Scheduled from batch timetable" />}</div>
        <div className="card"><div className="card-head"><h2>Waiting for evaluation</h2></div>
          {d.pending_evaluations.length ? d.pending_evaluations.map((a: any) => (
            <Link key={a.assignment_id} to={`/assignments/${a.assignment_id}`} className="m-card" style={{ color: 'inherit', alignItems: 'center' }}><div className="grow"><b>{a.title}</b><div className="muted small">{a.batch_name} · oldest {fmtDateTime(a.oldest)}</div></div><Badge tone="warn">{a.n}</Badge></Link>))
            : <Empty icon="✅" title="Nothing to evaluate">New hand-ins will appear here.</Empty>}</div>
      </div>
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Recent submissions</h2></div>
          {d.recent_submissions.length ? d.recent_submissions.map((r: any) => (
            <Link key={r.id} to={`/assignments/${r.assignment_id}`} className="m-card" style={{ color: 'inherit' }}><Avatar name={r.full_name} /><div className="grow"><b>{r.full_name}</b><div className="small">{r.title}</div><div className="muted small">{r.batch_name} · {fmtDateTime(r.submitted_at)}</div></div><StatusBadge s={r.status} /></Link>))
            : <Empty icon="📥" title="No submissions yet" />}</div>
        <Classes items={d.upcoming_classes} title="Coming up" />
      </div>
      <div className="card"><div className="card-head"><h2>My batches</h2></div>
        {!d.my_batches.length ? <Empty icon="🗂️" title="No batches assigned yet">Your administrator will assign you to batches.</Empty> : d.my_batches.map((b: any) => (
          <div key={b.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/classroom/${b.id}`}><b>{b.name}</b></Link><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div></div><Badge>{b.active_learners} learners</Badge><StatusBadge s={b.status} /></div>))}
      </div>
    </>
  );
}

function ChildrenView({ d, parent }: { d: any; parent: boolean }) {
  const [sel, setSel] = useState<string | null>(null);
  const kids: any[] = d.children;
  if (!kids.length) return <Empty icon="🧒" title="No learner profile linked yet">Please contact your organization to link your account.</Empty>;
  const kid = kids.find((k) => k.id === sel) ?? kids[0];
  return (
    <>
      {kids.length > 1 && <div className="row wrap" role="tablist" aria-label="Switch child">{kids.map((k) => <button key={k.id} role="tab" aria-selected={k.id === kid.id} className={`btn ${k.id === kid.id ? 'primary' : ''}`} onClick={() => setSel(k.id)}><Avatar name={k.full_name} /> {k.full_name}</button>)}</div>}
      <div className="progress-card">
        <div className="row"><Avatar name={kid.full_name} lg /><div><div className="l">{parent ? 'Your child' : 'My profile'}</div><div className="v">{kid.full_name}</div><div className="l">{kid.learner_code ?? ''}</div></div></div>
        <div className="grid cols-3" style={{ marginTop: 14 }}>
          <div><div className="l">Active batches</div><div className="v">{kid.batches.length}</div></div>
          <div><div className="l">Classes today</div><div className="v">{kid.today_classes.length}</div></div>
          <div><div className="l">Member since</div><div className="v" style={{ fontSize: 18 }}>{fmtDate(kid.enrolled_on)}</div></div>
        </div>
      </div>
      {kid.progress && <div className="progress-card"><div className="l" style={{ marginBottom: 6 }}>MY PROGRESS</div>
        <div className="grid cols-4">
          <div><div className="l">XP</div><div className="v">{fmtNum(kid.progress.xp)}</div></div>
          <div><div className="l">Level</div><div className="v" style={{ fontSize: 20 }}>{kid.progress.level}</div></div>
          <div><div className="l">Badges</div><div className="v">{kid.progress.badges}</div></div>
          <div><div className="l">Average score</div><div className="v">{pct(kid.progress.avg_score_pct)}</div></div>
          <div><div className="l">Attendance</div><div className="v">{pct(kid.progress.attendance_pct)}</div></div>
          <div><div className="l">Assignments</div><div className="v">{kid.progress.assignments.done}/{kid.progress.assignments.total}</div></div>
          <div className="full" style={{ gridColumn: 'span 2' }}><BarRow label="Assignments completed" value={kid.progress.assignments.done} total={kid.progress.assignments.total} /></div></div>
        <div className="muted small" style={{ marginTop: 6 }}>{kid.progress.next_level ? `${kid.progress.xp_to_next} XP to ${kid.progress.next_level}` : 'Top level reached'} · <Link to={parent ? '/portal' : '/achievements'}>{parent ? 'Open family portal' : 'My achievements'}</Link></div></div>}
      {kid.progress && <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Pending assignments</h2><Link className="small" to="/assignments">All</Link></div>
          {kid.progress.pending_assignments.length ? kid.progress.pending_assignments.map((a: any) => <Link key={a.id} to={`/assignments/${a.id}`} className="m-card" style={{ color: 'inherit' }}><div className="grow"><b>{a.title}</b><div className="muted small">{a.batch_name} · {a.due_at ? `due ${fmtDateTime(a.due_at)}` : 'no due date'}</div></div></Link>) : <Empty icon="🎉" title="All caught up" />}</div>
        <div className="card"><div className="card-head"><h2>Recent scores</h2></div>
          {kid.progress.recent_scores.length ? kid.progress.recent_scores.map((r: any, i: number) => <div key={i} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{r.activity_name}</b><div className="muted small">{r.batch_name}</div></div><b>{r.score}/{r.max_score}</b></div>) : <Empty icon="📊" title="No scores yet" />}</div>
        <div className="card"><div className="card-head"><h2>Upcoming classes</h2></div>
          {kid.progress.upcoming_classes.length ? kid.progress.upcoming_classes.map((c: any) => <div key={c.id} className="m-card"><div className="grow"><b>{c.batch_name}</b><div className="muted small">{c.title ?? 'Class'} · {fmtDateTime(c.starts_at)}</div></div>{c.has_meeting && <Badge>Join link</Badge>}</div>) : <Empty icon="🗓️" title="No classes scheduled" />}</div>
        <div className="card"><div className="card-head"><h2>Teacher feedback</h2></div>
          {kid.progress.feedback.length ? kid.progress.feedback.map((f: any, i: number) => <div key={i} className="m-card"><div className="grow"><b>{f.title}</b><div>💬 {f.feedback}</div><div className="muted small">{f.by_teacher} · {fmtDate(f.at)}</div></div></div>) : <Empty icon="💬" title="No feedback yet" />}</div>
      </div>}
      <div className="grid cols-2">
        <Classes items={kid.today_classes.length ? kid.today_classes : kid.upcoming_classes} title={kid.today_classes.length ? 'Today’s classes' : 'Upcoming classes'} />
        <div className="card"><div className="card-head"><h2>Batches</h2><Link className="small" to={`/learners/${kid.id}`}>Full profile</Link></div>
          {kid.batches.map((b: any) => (
            <div key={b.id} className="m-card" style={{ display: 'block' }}><b>{b.name}</b><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div>
              <div className="muted small">Teacher: {b.teachers.map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div>))}
        </div>
      </div>
    </>
  );
}
