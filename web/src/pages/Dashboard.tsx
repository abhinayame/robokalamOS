import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, fmtNum, fmtSchedule } from '../format';
import { Async, Avatar, Badge, Empty, PageHead, Progress, Stat, StatusBadge, Tabs, useFetch } from '../components/ui';

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
        <Stat label="Classes today" value={d.today_classes.length} />
        <Stat label="Next 7 days" value={d.today_classes.length + d.upcoming_classes.length} />
      </div>
      <div className="grid cols-2">
        <Classes items={d.today_classes} title="Today’s classes" />
        <Classes items={d.upcoming_classes} title="Coming up" />
      </div>
      <div className="card"><div className="card-head"><h2>My batches</h2></div>
        {!d.my_batches.length ? <Empty icon="🗂️" title="No batches assigned yet">Your administrator will assign you to batches.</Empty> : d.my_batches.map((b: any) => (
          <div key={b.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/batches/${b.id}`}><b>{b.name}</b></Link><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div></div><Badge>{b.active_learners} learners</Badge><StatusBadge s={b.status} /></div>))}
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
      <p className="muted small" style={{ margin: 0 }}>Scores, attendance, XP and badges will appear here as those features are switched on for your organization.</p>
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
