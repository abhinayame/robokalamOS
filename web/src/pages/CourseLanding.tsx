import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Async, Badge, Empty, PageHead, useAction, useFetch } from '../components/ui';
import { fmtDate } from '../format';
import { Stars, duration } from './Catalog';

const KIND: Record<string, string> = { text: '📄', video: '▶️', link: '🔗', quiz: '❓', file: '📎', assignment: '✍️' };
const LEVEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };

/** A course's page: what you will learn, the syllabus, who teaches it, what others said, and the Join button. */
export default function CourseLanding() {
  const { id } = useParams(); const nav = useNavigate(); const { busy, run } = useAction(); const q = useFetch(() => api.get(`/api/learn/catalog/${id}`).then((r) => r.data as any), [id]); const [openMod, setOpenMod] = useState<string | null>('all');
  return (
    <Async q={q}>{(d: any) => { const c = d.course; const mins = d.lessons.reduce((s: number, l: any) => s + (l.minutes ?? 0), 0);
      const chapters = d.modules.filter((m: any) => !m.parent_id); const groups: any[] = [{ id: null as string | null, title: d.modules.length ? 'Introduction' : 'Syllabus', depth: 0 }];
      for (const m of chapters) { groups.push({ ...m, depth: 0 }); for (const x of d.modules.filter((y: any) => y.parent_id === m.id)) groups.push({ ...x, depth: 1 }); }
      return (
        <>
          <div style={{ background: c.color, color: '#fff', borderRadius: 16, padding: '28px 24px', marginBottom: 16 }}>
            <Link to="/catalog" style={{ color: '#fff', opacity: 0.85 }}>← Catalog</Link>
            <div className="row wrap" style={{ gap: 20, alignItems: 'center', marginTop: 8 }}><span style={{ fontSize: 64 }} aria-hidden>{c.icon ?? '📘'}</span>
              <div className="grow" style={{ minWidth: 260 }}><h1 style={{ margin: 0, color: '#fff' }}>{c.title}</h1>{c.summary && <p style={{ margin: '6px 0 0', opacity: 0.92 }}>{c.summary}</p>}
                <div className="row gap-s wrap" style={{ marginTop: 10 }}>{d.rating && <span><Stars v={d.rating.avg} /> {d.rating.avg} ({d.rating.count})</span>}<span>{d.learners} learner{d.learners === 1 ? '' : 's'}</span>{c.level && <span>· {LEVEL[c.level]}</span>}{mins ? <span>· about {duration(mins)}</span> : null}<span>· {d.lessons.length} lessons</span>{c.language && <span>· {c.language}</span>}</div></div>
              <div style={{ minWidth: 200 }}>{d.enrollment ? <Link className="btn" style={{ background: '#fff', color: '#12263f' }} to={`/learn/${c.id}`}>{d.enrollment.status === 'completed' ? 'Review the course' : 'Go to course ▶'}</Link>
                : d.can_enrol ? <button className="btn" style={{ background: '#fff', color: '#12263f' }} disabled={busy} onClick={() => run(async () => { await api.post(`/api/learn/catalog/${c.id}/enrol`); nav(`/learn/${c.id}`); })}>Join for free</button>
                : <Badge>Not open for joining</Badge>}</div></div>
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-start', gap: 16 }}>
            <div className="grow stack" style={{ minWidth: 300 }}>
              {c.outcomes.length > 0 && <div className="card card-pad"><h2>What you will learn</h2><ul className="two-col" style={{ margin: 0, paddingLeft: 20 }}>{c.outcomes.map((o: string, i: number) => <li key={i} style={{ margin: '4px 0' }}>{o}</li>)}</ul></div>}
              {c.description && <div className="card card-pad"><h2>About this course</h2><p style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{c.description}</p></div>}
              <div className="card"><div className="card-head"><h2>Syllabus</h2><button className="btn ghost sm" onClick={() => setOpenMod(openMod === 'all' ? null : 'all')}>{openMod === 'all' ? 'Collapse all' : 'Expand all'}</button></div>
                {groups.map((g) => { const ls = d.lessons.filter((l: any) => (l.module_id ?? null) === g.id); if (!ls.length) return null; const open = openMod === 'all' || openMod === (g.id ?? 'none'); return (
                  <div key={g.id ?? 'none'}><button className="m-card" style={{ width: '100%', textAlign: 'left', border: 0, background: 'var(--bg-soft, #f4f7fb)', cursor: 'pointer', paddingLeft: 16 + g.depth * 16 }} onClick={() => setOpenMod(open && openMod !== 'all' ? null : (g.id ?? 'none'))}><div className="grow"><b>{g.depth ? '↳ ' : ''}{g.title}</b><div className="muted small">{ls.length} lessons{g.summary ? ` · ${g.summary}` : ''}</div></div><span aria-hidden>{open ? '▾' : '▸'}</span></button>
                    {open && ls.map((l: any) => <div key={l.id} className="m-card"><span aria-hidden>{KIND[l.kind]}</span><span className="grow">{l.title}{!l.required && <span className="muted small"> (optional)</span>}</span><span className="muted small">{l.minutes ? `${l.minutes} min` : l.kind}</span></div>)}</div>); })}</div>
              <div className="card card-pad stack"><h2>Reviews</h2>{!d.reviews.length ? <Empty icon="⭐" title="No reviews yet">Be the first to finish and review it.</Empty> : d.reviews.map((r: any, i: number) => <div key={i}><Stars v={r.rating} /> <b>{r.name}</b> <span className="muted small">· {fmtDate(r.created_at)}</span><div>{r.comment}</div></div>)}</div>
            </div>
            <div className="card card-pad stack" style={{ width: 280, flex: 'none', maxWidth: '100%' }}><h3 style={{ margin: 0 }}>This course</h3>
              <div className="small stack-s">{c.instructor_name && <div>👩‍🏫 Taught by <b>{c.instructor_name}</b></div>}{c.category && <div>🏷️ {c.category}</div>}{c.gives_certificate && <div>🎓 Certificate when you finish</div>}{c.xp_reward > 0 && <div>⚡ {c.xp_reward} XP for finishing</div>}{c.sequential && <div>🔓 Lessons unlock one by one</div>}{c.min_grade && <div>📝 Quiz grade of {c.min_grade}% to finish</div>}{c.requirements && <div>📋 Before you start: {c.requirements}</div>}</div></div>
          </div>
        </>); }}</Async>
  );
}
