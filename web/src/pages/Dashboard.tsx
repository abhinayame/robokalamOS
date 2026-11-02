import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { fmtDate, fmtDateTime, fmtMoney, fmtNum, fmtSchedule } from '../format';
import { BarRow } from '../components/Charts';
import { AttentionCard, CategoryTile, HeroBanner, HeroKpi, ProgressRing, Pill, Section } from '../components/kit';
import { Icon, IconTile } from '../components/Icon';
import { Async, Avatar, Badge, CountUp, Empty, PageHead, Progress, Stat, StatusBadge, Tabs, useFetch } from '../components/ui';

const pct = (v: number | null | undefined) => (v == null ? '—' : `${v}%`);

export default function Dashboard() {
  const { me, hasRole, activeOrg, can } = useAuth();
  const [view, setView] = useState<string | undefined>();
  const q = useFetch(() => api.get(`/api/dashboard${view ? `?view=${view}` : ''}`).then((r) => r.data), [view, activeOrg]);
  if (hasRole('super_admin') && !me?.organization && !activeOrg) {
    return <><PageHead title="Platform" sub="Choose an organization from the top bar to work inside it, or manage organizations." /><Empty icon="building" title="No organization selected" action={<Link className="btn primary" to="/organizations">Manage organizations</Link>}>You are signed in as the platform owner.</Empty></>;
  }
  const d: any = q.data;
  const learnerish = hasRole('learner', 'parent');
  return (
    <>
      <HeroBanner kicker={me?.roles.map((r) => r.replace('_', ' ')).join(' · ')} title={`Welcome, ${me?.full_name.split(' ')[0] ?? ''}`} sub={me?.organization?.name}
        art={learnerish ? 'rocket' : 'sparkle'}
        actions={learnerish ? <><Link className="btn primary" to="/classroom"><Icon name="school" size={16} /> Classroom</Link><Link className="btn" to="/learn"><Icon name="book" size={16} /> My courses</Link><Link className="btn" to="/assignments"><Icon name="clipboard" size={16} /> Work</Link></>
          : <>{can('learner:read') && <Link className="btn primary" to="/learners"><Icon name="users" size={16} /> Learners</Link>}{can('fee:read') && <Link className="btn" to="/fees"><Icon name="wallet" size={16} /> Fees</Link>}{can('classroom:read') && <Link className="btn" to="/classroom"><Icon name="school" size={16} /> Classroom</Link>}{can('report:read') && <Link className="btn" to="/reports"><Icon name="bars" size={16} /> Reports</Link>}</>}>
        {d?.view === 'admin' && <AdminKpis d={d} />}
        {d?.view === 'teacher' && <TeacherKpis d={d} />}
      </HeroBanner>
      <Async q={q}>{(d: any) => (
        <div className="stack dash">
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
      {!items.length ? <Empty compact icon="calendar" title="No classes scheduled">Classes appear here once batches have a weekly schedule.</Empty> : (
        <div>{items.map((c, i) => (
          <div key={i} className="m-card" style={{ alignItems: 'center' }}>
            <div className="badge info nowrap">{fmtDate(c.date)}</div>
            <div className="grow"><Link to={`/batches/${c.batch_id}`}><b>{c.batch_name}</b></Link><div className="muted small">{c.start ? `${c.start}–${c.end}` : 'Time not set'}{c.mode ? ` · ${c.mode}` : ''}{c.venue ? ` · ${c.venue}` : ''}</div></div>
          </div>))}</div>)}
    </div>
  );
}

function AdminKpis({ d }: { d: any }) {
  const k = d.kpis;
  return (
    <div className="hero-kpis" role="group" aria-label="Key numbers">
      <HeroKpi label="Total learners" value={<CountUp value={d.learners.total} />} sub={<>{fmtNum(d.learners.active)} active · {fmtNum(d.learners.inactive)} inactive</>} trend={d.enrollment_trend.map((t: any) => t.learners)} to="/learners" />
      {k?.fees && <HeroKpi label="Collected this month" value={fmtMoney(k.fees.collected_this_month)} sub="Payments recorded" to="/fees" />}
      {k?.fees && <HeroKpi label="Fees outstanding" value={fmtMoney(k.fees.outstanding)} sub={<>{fmtMoney(k.fees.overdue)} overdue</>} to="/fees" />}
      {k && <HeroKpi label="Attendance" value={pct(k.attendance_pct)} sub="Present or late, of marked classes" />}
    </div>
  );
}

function AdminView({ d }: { d: any }) {
  const { can } = useAuth();
  const max = Math.max(1, ...d.enrollment_trend.map((t: any) => t.learners));
  const k = d.kpis;
  const attention = [
    k?.fees && k.fees.overdue > 0 && <AttentionCard key="fees" icon="wallet" hue="rose" count={fmtMoney(k.fees.overdue)} title="Fees overdue" sub={`${fmtMoney(k.fees.outstanding)} outstanding in total`} cta="Collect fees" to="/fees" />,
    d.learners.without_batch > 0 && <AttentionCard key="nobatch" icon="alert" hue="butter" count={fmtNum(d.learners.without_batch)} title="Learners not in any batch" sub={<>{fmtNum(d.learners.without_batch)} active learners are not in any batch.</>} cta="Review them" to="/learners?no_batch=true" />,
    k && k.pending_evaluations > 0 && <AttentionCard key="eval" icon="clipboard" hue="peach" count={fmtNum(k.pending_evaluations)} title="Submissions to review" sub="Waiting for a teacher’s evaluation" cta="Open classroom" to="/classroom" />,
    k?.crm && k.crm.open > 0 && <AttentionCard key="crm" icon="target" hue="violet" count={fmtNum(k.crm.open)} title="Open leads" sub={`${fmtNum(k.crm.converted)} converted so far`} cta="Follow up" to="/crm/follow-ups" />,
  ].filter(Boolean);
  const tiles: [string, string, any, string, boolean][] = [
    ['user', 'Add learner', 'violet', '/learners', can('learner:create')], ['upload', 'Import learners', 'sky', '/learners/import', can('learner:create')],
    ['wallet', 'Record payment', 'mint', '/fees', can('fee:manage')], ['layers', 'New batch', 'peach', '/batches', can('batch:create')],
    ['megaphone', 'Announcement', 'rose', '/communication', can('comms:announce')], ['target', 'Leads', 'butter', '/crm', can('crm:read')],
    ['trending', 'Compare batches', 'sky', '/analytics', can('report:read')], ['bars', 'Reports', 'violet', '/reports', can('report:read')],
  ];
  return (
    <>
      <Section title="Needs attention" scroll>
        {attention.length ? <div className="attn-row">{attention}</div>
          : <div className="attn-clear"><IconTile name="check" hue="mint" size="md" /><div><b>All clear</b><div className="muted small">No overdue fees, unassigned learners or work waiting for review.</div></div></div>}
      </Section>
      {tiles.some((t) => t[4]) && <Section title="Quick actions"><div className="cat-grid">{tiles.filter((t) => t[4]).map(([ic, label, hue, to]) => <CategoryTile key={label} icon={ic} label={label} hue={hue} to={to} />)}</div></Section>}
      <Section title="At a glance">
        <div className="grid cols-4 glance">
          <Stat label="Batches" value={fmtNum(d.batches.total)} sub={<>{d.batches.active} active · {d.batches.upcoming} upcoming</>} />
          <Stat label="Teachers" value={fmtNum(d.teachers)} />
          <Stat label="Active batch memberships" value={fmtNum(d.active_memberships)} sub={<>{fmtNum(d.learners.multi_batch)} learners in 2+ batches</>} />
          {k && <>
            <Stat label="Average score" value={pct(k.avg_score_pct)} sub={`${fmtNum(k.scores_recorded)} scores recorded`} />
            <Stat label="Waiting for evaluation" value={fmtNum(k.pending_evaluations)} />
            <Stat label="Classes in the next 7 days" value={fmtNum(k.upcoming_classes_7d)} />
            <Stat label="Total XP" value={fmtNum(k.total_xp)} />
            <Stat label="Badges awarded" value={fmtNum(k.badges_awarded)} />
            {k.crm && <Stat label="CRM leads" value={fmtNum(k.crm.leads)} sub={<Link to="/crm">{k.crm.open} open · {k.crm.converted} converted</Link>} />}
            {k.campaigns && <Stat label="WhatsApp campaigns" value={fmtNum(k.campaigns.total)} sub={<Link to="/communication">{k.campaigns.active} running</Link>} />}
          </>}
        </div>
      </Section>
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Fullest batches</h2><Link to="/batches" className="small">All batches</Link></div>
          {!d.top_batches.length ? <Empty compact icon="layers" title="No batches yet">Create a batch to start enrolling learners.</Empty> : d.top_batches.map((b: any) => (
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
          {!d.recent_activity.length ? <Empty compact icon="pulse" title="No activity yet" /> : <div className="feed">{d.recent_activity.map((a: any) => (
            <div key={a.id} className="m-card"><Avatar name={a.full_name} /><div className="grow"><Link to={`/learners/${a.learner_id}`}><b>{a.full_name}</b></Link> <span className="muted small">{a.learner_code}</span><div>{a.title}</div><div className="muted small">{fmtDateTime(a.occurred_at)}</div></div></div>))}</div>}
        </div>
      </div>
    </>
  );
}

function TeacherKpis({ d }: { d: any }) {
  return (
    <div className="hero-kpis" role="group" aria-label="Key numbers">
      <HeroKpi label="My learners (unique)" value={<CountUp value={d.unique_learners} />} sub={<>{fmtNum(d.batch_memberships)} batch memberships</>} />
      <HeroKpi label="Classes today" value={d.today_sessions.length || d.today_classes.length} sub={`${d.my_batches.length} batches`} />
      <HeroKpi label="Attendance" value={pct(d.attendance_pct)} />
      <HeroKpi label="Average score" value={pct(d.avg_score_pct)} />
    </div>
  );
}

function TeacherView({ d }: { d: any }) {
  const first = d.my_batches[0]?.id; const cls = first ? `/classroom/${first}` : '/classroom';
  const unmarked = d.today_sessions.filter((c: any) => !c.marked).length;
  const attention = [
    d.pending_evaluations_total > 0 && <AttentionCard key="eval" icon="clipboard" hue="peach" count={fmtNum(d.pending_evaluations_total)} title="Waiting for evaluation" sub={d.pending_evaluations[0] ? `Oldest: ${d.pending_evaluations[0].title}` : undefined} cta="Review work" to={d.pending_evaluations[0] ? `/assignments/${d.pending_evaluations[0].assignment_id}` : '/classroom'} />,
    unmarked > 0 && <AttentionCard key="att" icon="check" hue="butter" count={unmarked} title="Attendance not marked" sub="Classes today without attendance" cta="Mark attendance" to={`/classroom/${d.today_sessions.find((c: any) => !c.marked).batch_id}`} />,
  ].filter(Boolean);
  return (
    <>
      {attention.length > 0 && <Section title="Needs attention" scroll><div className="attn-row">{attention}</div></Section>}
      <Section title="Quick actions">
        {d.my_batches.length > 0 ? <div className="cat-grid">
          <CategoryTile icon="plus" hue="violet" label="Assignment or material" to={cls} /><CategoryTile icon="megaphone" hue="rose" label="Post announcement" to="/communication" />
          <CategoryTile icon="check" hue="mint" label="Mark attendance" to={cls} /><CategoryTile icon="star" hue="butter" label="Give score" to={cls} /><CategoryTile icon="medal" hue="peach" label="Award badge" to={cls} /></div>
          : <span className="muted small">Quick actions appear once you are assigned to a batch.</span>}
      </Section>
      <Section title="At a glance">
        <div className="grid cols-4 glance">
          <Stat label="My batches" value={d.my_batches.length} />
          <Stat label="Waiting for evaluation" value={fmtNum(d.pending_evaluations_total)} />
          <Stat label="Assignments" value={fmtNum(d.assignments_total)} />
          <Stat label="Badges awarded (30 days)" value={fmtNum(d.badges_awarded_30d)} />
        </div>
      </Section>
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Today’s classes</h2></div>
          {d.today_sessions.length ? d.today_sessions.map((c: any) => (
            <div key={c.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/classroom/${c.batch_id}`}><b>{c.batch_name}</b></Link><div className="muted small">{c.title ?? 'Class'} · {fmtDateTime(c.starts_at)}</div></div>
              <Badge tone={c.marked ? 'ok' : 'warn'}>{c.marked ? `${c.marked} marked` : 'Attendance not marked'}</Badge>{c.meeting_url !== undefined || c.has_meeting ? <Badge>link set</Badge> : null}</div>))
            : <Classes items={d.today_classes} title="Scheduled from batch timetable" />}</div>
        <div className="card"><div className="card-head"><h2>Waiting for evaluation</h2></div>
          {d.pending_evaluations.length ? d.pending_evaluations.map((a: any) => (
            <Link key={a.assignment_id} to={`/assignments/${a.assignment_id}`} className="m-card" style={{ color: 'inherit', alignItems: 'center' }}><div className="grow"><b>{a.title}</b><div className="muted small">{a.batch_name} · oldest {fmtDateTime(a.oldest)}</div></div><Badge tone="warn">{a.n}</Badge></Link>))
            : <Empty compact icon="check" title="Nothing to evaluate">New hand-ins will appear here.</Empty>}</div>
      </div>
      <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Recent submissions</h2></div>
          {d.recent_submissions.length ? d.recent_submissions.map((r: any) => (
            <Link key={r.id} to={`/assignments/${r.assignment_id}`} className="m-card" style={{ color: 'inherit' }}><Avatar name={r.full_name} /><div className="grow"><b>{r.full_name}</b><div className="small">{r.title}</div><div className="muted small">{r.batch_name} · {fmtDateTime(r.submitted_at)}</div></div><StatusBadge s={r.status} /></Link>))
            : <Empty compact icon="inbox" title="No submissions yet" />}</div>
        <Classes items={d.upcoming_classes} title="Coming up" />
      </div>
      <div className="card"><div className="card-head"><h2>My batches</h2></div>
        {!d.my_batches.length ? <Empty compact icon="layers" title="No batches assigned yet">Your administrator will assign you to batches.</Empty> : d.my_batches.map((b: any) => (
          <div key={b.id} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><Link to={`/classroom/${b.id}`}><b>{b.name}</b></Link><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div></div><Badge>{b.active_learners} learners</Badge><StatusBadge s={b.status} /></div>))}
      </div>
    </>
  );
}

function ChildrenView({ d, parent }: { d: any; parent: boolean }) {
  const [sel, setSel] = useState<string | null>(null);
  const kids: any[] = d.children;
  if (!kids.length) return <Empty icon="family" title="No learner profile linked yet">Please contact your organization to link your account.</Empty>;
  const kid = kids.find((k) => k.id === sel) ?? kids[0];
  const p = kid.progress;
  const levelPct = p ? (p.next_level ? (p.xp / Math.max(1, p.xp + p.xp_to_next)) * 100 : 100) : 0;
  const today: any[] = kid.today_classes;
  return (
    <>
      {kids.length > 1 && <div className="chip-tabs" role="tablist" aria-label="Switch child">{kids.map((k) => <button key={k.id} role="tab" aria-selected={k.id === kid.id} className={`chip-tab ${k.id === kid.id ? 'on' : ''}`} onClick={() => setSel(k.id)}><Avatar name={k.full_name} /> {k.full_name}</button>)}</div>}
      <div className="card kid-card">
        <Avatar name={kid.full_name} lg />
        <div className="grow"><div className="l">{parent ? 'Your child' : 'My profile'}</div><div className="kid-name">{kid.full_name}</div><div className="muted small">{kid.learner_code ?? ''}</div></div>
        <div className="kid-facts">
          <div><b>{kid.batches.length}</b><span>Active batches</span></div>
          <div><b>{today.length}</b><span>Classes today</span></div>
          <div><b>{fmtDate(kid.enrolled_on)}</b><span>Member since</span></div>
        </div>
      </div>
      {today.length > 0 && <Section title="Today" scroll><div className="today-row">{today.map((c: any, i: number) => (
        <Link key={i} to={`/batches/${c.batch_id}`} className="today-card"><Pill hue="mint" icon="dot">Today</Pill><b>{c.batch_name}</b><span className="muted small">{c.start ? `${c.start}–${c.end}` : 'Time not set'}{c.mode ? ` · ${c.mode}` : ''}</span></Link>))}</div></Section>}
      {p && <div className="card level-card">
        <div className="level-head">
          <IconTile name="medal" hue="butter" size="lg" />
          <div className="grow"><div className="l">MY PROGRESS</div><div className="level-name">{p.level}</div>
            <div className="level-bar" role="progressbar" aria-valuenow={Math.round(levelPct)} aria-valuemin={0} aria-valuemax={100} aria-label="Progress to next level"><i style={{ width: `${levelPct}%` }} /></div>
            <div className="muted small">{p.next_level ? `${p.xp_to_next} XP to ${p.next_level}` : 'Top level reached'} · <Link to={parent ? '/portal' : '/achievements'}>{parent ? 'Open family portal' : 'My achievements'}</Link></div></div>
          <div className="ring-meta"><Pill hue="butter" icon="bolt">{fmtNum(p.xp)} XP</Pill><Pill hue="rose" icon="star">{p.badges} badges</Pill></div>
        </div>
        <div className="ring-row">
          <ProgressRing size={96} value={p.attendance_pct ?? 0} label={pct(p.attendance_pct)} sub="Attendance" />
          <ProgressRing size={96} value={p.avg_score_pct ?? 0} label={pct(p.avg_score_pct)} sub="Average score" />
          <ProgressRing size={96} value={p.assignments.total ? (p.assignments.done / p.assignments.total) * 100 : 0} label={`${p.assignments.done}/${p.assignments.total}`} sub="Assignments" />
          <div className="grow" style={{ minWidth: 200 }}><BarRow label="Assignments completed" value={p.assignments.done} total={p.assignments.total} /></div>
        </div>
      </div>}
      <Section title={parent ? 'For your family' : 'Jump back in'}>
        <div className="cat-grid">
          <CategoryTile icon="school" hue="violet" label="Classroom" to="/classroom" /><CategoryTile icon="book" hue="sky" label="My courses" to="/learn" />
          <CategoryTile icon="clipboard" hue="peach" label="Work" to="/assignments" />
          {parent ? <CategoryTile icon="family" hue="rose" label="Family portal" to="/portal" /> : <CategoryTile icon="trophy" hue="butter" label="Achievements" to="/achievements" />}
          <CategoryTile icon="receipt" hue="mint" label="My fees" to="/my-fees" /><CategoryTile icon="certificate" hue="violet" label="Certificates" to="/my-certificates" />
          <CategoryTile icon="calendar" hue="sky" label="Timetable" to="/timetable" /><CategoryTile icon="bars" hue="rose" label="Progress report" to="/my-report" />
        </div>
      </Section>
      {p && <div className="grid cols-2">
        <div className="card"><div className="card-head"><h2>Pending assignments</h2><Link className="small" to="/assignments">All</Link></div>
          {p.pending_assignments.length ? p.pending_assignments.map((a: any) => <Link key={a.id} to={`/assignments/${a.id}`} className="m-card" style={{ color: 'inherit' }}><div className="grow"><b>{a.title}</b><div className="muted small">{a.batch_name} · {a.due_at ? `due ${fmtDateTime(a.due_at)}` : 'no due date'}</div></div></Link>) : <Empty compact icon="party" title="All caught up" />}</div>
        <div className="card"><div className="card-head"><h2>Recent scores</h2></div>
          {p.recent_scores.length ? p.recent_scores.map((r: any, i: number) => <div key={i} className="m-card" style={{ alignItems: 'center' }}><div className="grow"><b>{r.activity_name}</b><div className="muted small">{r.batch_name}</div></div><b>{r.score}/{r.max_score}</b></div>) : <Empty compact icon="bars" title="No scores yet" />}</div>
        {(p.upcoming_classes.length > 0 || !(today.length || kid.upcoming_classes.length)) && <div className="card"><div className="card-head"><h2>Upcoming classes</h2></div>
          {p.upcoming_classes.length ? p.upcoming_classes.map((c: any) => <div key={c.id} className="m-card"><div className="grow"><b>{c.batch_name}</b><div className="muted small">{c.title ?? 'Class'} · {fmtDateTime(c.starts_at)}</div></div>{c.has_meeting && <Badge>Join link</Badge>}</div>) : <Empty compact icon="calendar" title="No classes scheduled" />}</div>}
        <div className="card"><div className="card-head"><h2>Teacher feedback</h2></div>
          {p.feedback.length ? p.feedback.map((f: any, i: number) => <div key={i} className="m-card"><div className="grow"><b>{f.title}</b><div><Icon name="chat" size={15} /> {f.feedback}</div><div className="muted small">{f.by_teacher} · {fmtDate(f.at)}</div></div></div>) : <Empty compact icon="chat" title="No feedback yet" />}</div>
      </div>}
      <div className="grid cols-2">
        <Classes items={today.length ? today : kid.upcoming_classes} title={today.length ? 'Today’s classes' : 'Upcoming classes'} />
        <div className="card"><div className="card-head"><h2>Batches</h2><Link className="small" to={`/learners/${kid.id}`}>Full profile</Link></div>
          {kid.batches.map((b: any) => (
            <div key={b.id} className="m-card" style={{ display: 'block' }}><b>{b.name}</b><div className="muted small">{b.course_name} · {fmtSchedule(b.schedule)}</div>
              <div className="muted small">Teacher: {b.teachers.map((t: any) => t.full_name).join(', ') || 'Not assigned'}</div></div>))}
        </div>
      </div>
    </>
  );
}
