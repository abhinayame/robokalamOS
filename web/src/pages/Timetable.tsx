import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, PageHead, useFetch } from '../components/ui';

const addDays = (d: string, n: number) => { const t = new Date(`${d}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const hm = (iso: string, tz: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz });
const dayKey = (iso: string, tz: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: tz });

export default function Timetable() {
  const { can } = useAuth(); const [start, setStart] = useState<string | undefined>(undefined);
  const q = useFetch(() => api.get(`/api/timetable/week${qs({ start })}`).then((r) => r.data as any), [start]);
  return (
    <>
      <PageHead title="Timetable" sub="Every class this week, in your school's time." actions={<><button className="btn" onClick={() => q.data && setStart(addDays(q.data.start, -7))}>← Last week</button><button className="btn" onClick={() => setStart(undefined)}>This week</button><button className="btn" onClick={() => q.data && setStart(addDays(q.data.start, 7))}>Next week →</button></>} />
      <Async q={q}>{(d: any) => (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit,minmax(150px,1fr))', gap: 10 }}>{Array.from({ length: 7 }, (_, i) => addDays(d.start, i)).map((day) => {
          const list = d.sessions.filter((s: any) => dayKey(s.starts_at, d.timezone) === day);
          return (
            <div key={day} className="card" style={{ outline: day === d.today ? '2px solid var(--brand, #12263f)' : 'none' }}>
              <div className="card-pad" style={{ borderBottom: '1px solid var(--line, #e3e8ef)' }}><b>{new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })}</b>{day === d.today && <> <Badge tone="info">Today</Badge></>}</div>
              <div className="card-pad stack-s">{list.length ? list.map((s: any) => (
                <Link key={s.id} to={can('classroom:read') ? `/classroom/${s.batch_id}` : '#'} style={{ textDecoration: 'none', color: 'inherit', opacity: s.status === 'cancelled' ? 0.55 : 1 }}>
                  <div className="small"><b>{hm(s.starts_at, d.timezone)}</b> – {hm(s.ends_at, d.timezone)}</div><div>{s.title || s.batch_name}</div>
                  <div className="muted small">{s.batch_name}{s.has_link ? ' · 🎥 online' : ''}{s.status === 'cancelled' ? ' · cancelled' : ''}</div></Link>)) : <span className="muted small">No classes</span>}</div>
            </div>);
        })}</div>)}</Async>
    </>
  );
}
