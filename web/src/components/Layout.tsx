import { useEffect, useState, type ReactNode } from 'react';
import { Bell } from './Bell';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { Avatar } from './ui';

interface Item { to: string; label: string; icon: string; perm?: string; roles?: string[]; end?: boolean }
interface Group { label: string; items: Item[] }

const STAFF = ['super_admin', 'org_admin', 'branch_admin', 'counsellor', 'accountant', 'teacher'];
const GROUPS: Group[] = [
  { label: 'Overview', items: [{ to: '/', label: 'Dashboard', icon: '▦', end: true }] },
  { label: 'Learners', items: [
    { to: '/learners', label: 'All Learners', icon: '👥', perm: 'learner:read' },
    { to: '/parents', label: 'Parents', icon: '🧑‍🧒', perm: 'parent:read' },
    { to: '/learners/import', label: 'Import learners', icon: '📥', perm: 'learner:create' },
  ] },
  { label: 'Batches', items: [
    { to: '/batches', label: 'All Batches', icon: '🗂️', perm: 'batch:read', end: true },
    { to: '/batches?status=active', label: 'Active', icon: '●', perm: 'batch:read' },
    { to: '/batches?status=upcoming', label: 'Upcoming', icon: '◐', perm: 'batch:read' },
    { to: '/batches?status=completed', label: 'Completed', icon: '○', perm: 'batch:read' },
  ] },
  { label: 'Classroom', items: [{ to: '/classroom', label: 'Classroom', icon: '🏫', perm: 'classroom:read' }, { to: '/assignments', label: 'Assignments', icon: '📝', roles: ['learner', 'parent'] }, { to: '/portal', label: 'Family portal', icon: '👨‍👩‍👧', roles: ['parent'] }, { to: '/achievements', label: 'Achievements', icon: '🏅', roles: ['learner', 'parent'] }, { to: '/gamification', label: 'Gamification', icon: '🏅', perm: 'gamification:award' }] },
  { label: 'My learning', items: [{ to: '/classes', label: 'My Classes', icon: '📅', roles: ['learner', 'parent'] }] },
  { label: 'Finance', items: [{ to: '/fees', label: 'Fees', icon: '💰', perm: 'fee:read' }, { to: '/my-fees', label: 'My fees', icon: '🧾', roles: ['learner', 'parent'] }] },
  { label: 'CRM', items: [{ to: '/crm', label: 'Leads', icon: '🎯', perm: 'crm:read', end: true }, { to: '/crm/follow-ups', label: 'Follow-ups', icon: '🔁', perm: 'crm:read' }] },
  { label: 'Communication', items: [{ to: '/communication', label: 'Communication', icon: '💬', perm: 'comms:announce' }] },
  { label: 'Insights', items: [{ to: '/analytics', label: 'Compare batches', icon: '📈', perm: 'report:read' }, { to: '/reports', label: 'Reports', icon: '🧾', perm: 'report:read' }] },
  { label: 'People', items: [{ to: '/teachers', label: 'Teachers', icon: '🎓', perm: 'teacher:read' }] },
  { label: 'Settings', items: [
    { to: '/settings/catalog', label: 'Programs & Courses', icon: '📚', perm: 'catalog:read', roles: STAFF },
    { to: '/settings/tags', label: 'Tags', icon: '🏷️', perm: 'tag:read', roles: STAFF },
    { to: '/settings/users', label: 'Staff & Roles', icon: '🔑', perm: 'user:manage' },
    { to: '/settings/reminders', label: 'Auto reminders', icon: '⏰', perm: 'comms:read' },
    { to: '/settings/audit', label: 'Audit Log', icon: '🧾', perm: 'audit:read' },
    { to: '/settings/system', label: 'System Status', icon: '🩺', perm: 'system:read' },
  ] },
  { label: 'Platform', items: [{ to: '/organizations', label: 'Organizations', icon: '🏢', roles: ['super_admin'] }] },
];

export default function Layout(): ReactNode {
  const { me, can, hasRole, logout, offline, activeOrg, chooseOrg } = useAuth();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  const nav = useNavigate();
  const [orgs, setOrgs] = useState<any[]>([]);
  useEffect(() => { setOpen(false); }, [loc.pathname, loc.search]);
  useEffect(() => { if (hasRole('super_admin')) api.get('/api/organizations?page_size=100').then((r) => setOrgs(r.data)).catch(() => {}); }, []); // eslint-disable-line

  const visible = (i: Item) => (i.perm ? can(i.perm) : true) && (i.roles ? hasRole(...i.roles) : true) && !(i.to === '/settings/catalog' && !can('catalog:read'));
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter(visible) })).filter((g) => g.items.length);

  const isStaff = hasRole('super_admin', 'org_admin', 'branch_admin', 'counsellor', 'accountant');
  const isTeacher = hasRole('teacher');
  const bottom: Item[] = isStaff
    ? [{ to: '/', label: 'Dashboard', icon: '▦', end: true }, { to: '/learners', label: 'Learners', icon: '👥' }, { to: '/batches', label: 'Batches', icon: '🗂️' }, ...(can('crm:read') ? [{ to: '/crm', label: 'CRM', icon: '🎯' }] : [])]
    : isTeacher
      ? [{ to: '/', label: 'Home', icon: '▦', end: true }, { to: '/classroom', label: 'Classroom', icon: '🏫' }, { to: '/learners', label: 'Learners', icon: '👥' }]
      : [{ to: '/', label: 'Home', icon: '▦', end: true }, { to: '/classroom', label: 'Classroom', icon: '🏫' }, { to: '/assignments', label: 'Work', icon: '📝' }, { to: '/account', label: 'Profile', icon: '🙂' }];
  const cols = bottom.length + 1;

  return (
    <div className="app">
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`} aria-label="Main navigation">
        <div className="brand"><div className="brand-mark">R</div><div><b>Robokalam</b><span>Learner OS</span></div></div>
        {groups.map((g) => (
          <nav key={g.label} className="nav-group" aria-label={g.label}>
            <div className="nav-label">{g.label}</div>
            {g.items.map((i) => {
              const [path, search] = i.to.split('?');
              const active = i.end ? loc.pathname === path && (loc.search === (search ? `?${search}` : '')) : search ? loc.pathname === path && loc.search === `?${search}` : loc.pathname.startsWith(path) && !(path === '/batches' && loc.search);
              return <NavLink key={i.to} to={i.to} className={`nav-link ${active ? 'active' : ''}`}><span className="nav-ico" aria-hidden>{i.icon}</span>{i.label}</NavLink>;
            })}
          </nav>
        ))}
        <div className="nav-group"><NavLink to="/account" className="nav-link"><span className="nav-ico" aria-hidden>⚙️</span>My account</NavLink></div>
      </aside>
      <div className="main">
        {offline && <div className="offline-bar" role="status">You’re offline. Changes can’t be saved until your connection returns.</div>}
        <header className="topbar">
          <button className="btn menu-btn" onClick={() => setOpen(true)} aria-label="Open menu">☰</button>
          <div className="grow" style={{ fontWeight: 700 }}>{me?.organization?.name ?? (hasRole('super_admin') ? 'Platform' : '')}</div>
          {hasRole('super_admin') && (
            <select className="select" style={{ width: 200 }} value={activeOrg ?? ''} aria-label="Active organization" onChange={(e) => { chooseOrg(e.target.value || null); nav('/'); setTimeout(() => location.reload(), 0); }}>
              <option value="">Select organization…</option>{orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <Bell />
          <div className="row gap-s"><Avatar name={me?.full_name ?? '?'} /><div className="small user-meta" style={{ lineHeight: 1.2 }}><b>{me?.full_name}</b><br /><span className="muted">{me?.roles.map((r) => r.replace('_', ' ')).join(', ')}</span></div></div>
          <button className="btn sm" onClick={() => logout().then(() => nav('/login'))}>Sign out</button>
        </header>
        <main className="content" id="main"><Outlet /></main>
      </div>
      <nav className="bottom-nav" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }} aria-label="Quick navigation">
        {bottom.map((b) => <NavLink key={b.to} to={b.to} end={b.end} className={({ isActive }) => (isActive ? 'active' : '')}><span className="ico" aria-hidden>{b.icon}</span>{b.label}</NavLink>)}
        <button onClick={() => setOpen(true)}><span className="ico" aria-hidden>☰</span>More</button>
      </nav>
    </div>
  );
}
