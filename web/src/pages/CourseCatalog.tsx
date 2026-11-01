import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Async, Badge, Empty, PageHead, useDebounced, useFetch } from '../components/ui';

const LEVEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const Stars = ({ v }: { v: number }) => <span aria-label={`${v} out of 5`} style={{ color: '#f5a524' }}>{'★'.repeat(Math.round(v))}<span style={{ color: '#cbd5e1' }}>{'★'.repeat(5 - Math.round(v))}</span></span>;
export const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m} min`);

/** The course catalog: open courses anyone in the audience can join. */
export default function Catalog() {
  const [text, setText] = useState(''); const term = useDebounced(text); const [cat, setCat] = useState('');
  const q = useFetch(() => api.get(`/api/learn/catalog${qs({ q: term, category: cat })}`), [term, cat]);
  return (
    <>
      <PageHead title="Course catalog" sub="Courses you can join right now. Pick one that interests you." actions={<Link className="btn" to="/learn">My courses</Link>} />
      <div className="row wrap" style={{ marginBottom: 12 }}><input className="input" style={{ maxWidth: 320 }} placeholder="Search courses" aria-label="Search courses" value={text} onChange={(e) => setText(e.target.value)} />
        <div className="chips">{['', ...((q.data as any)?.meta?.categories ?? [])].map((c: string) => <button key={c || 'all'} className={`btn sm ${cat === c ? 'primary' : ''}`} onClick={() => setCat(c)}>{c || 'All'}</button>)}</div></div>
      <Async q={q as any}>{(r: any) => !r.data.length ? <div className="card"><Empty icon="🔎" title="No courses found">{term || cat ? 'Try a different search.' : 'There are no open courses yet. Your school can add some.'}</Empty></div> : (
        <div className="grid cols-3">{r.data.map((c: any) => (
          <Link key={c.id} to={`/catalog/${c.id}`} className="card stack" style={{ textDecoration: 'none', color: 'inherit', overflow: 'hidden' }}>
            <div style={{ background: c.color, color: '#fff', padding: '18px 16px', display: 'flex', gap: 12, alignItems: 'center' }}><span style={{ fontSize: 38 }} aria-hidden>{c.icon ?? '📘'}</span><div><div style={{ fontWeight: 700, fontSize: 16 }}>{c.title}</div>{c.instructor_name && <div style={{ opacity: 0.85, fontSize: 12 }}>by {c.instructor_name}</div>}</div></div>
            <div className="card-pad stack-s">{c.summary && <div className="small">{c.summary}</div>}
              <div className="row gap-s wrap">{c.category && <Badge>{c.category}</Badge>}{c.level && <Badge>{LEVEL[c.level]}</Badge>}{c.gives_certificate && <Badge tone="ok">🎓 Certificate</Badge>}{c.enrolled && <Badge tone="info">Joined</Badge>}</div>
              <div className="row between small muted"><span>{c.rating ? <><Stars v={c.rating} /> {c.rating} ({c.reviews})</> : 'New'}</span><span>{c.lessons} lessons{c.minutes ? ` · ${duration(c.minutes)}` : ''}</span></div></div>
          </Link>))}</div>)}</Async>
    </>
  );
}
