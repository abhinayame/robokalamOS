import { Link } from 'react-router-dom';
import { api } from '../api';
import { useAuth } from '../auth';
import { BadgeWall, Leaderboard, XpCard, XpHistory } from '../components/Gamify';
import { Async, Empty, PageHead, useFetch } from '../components/ui';

/** A learner's (or a parent's child's) XP, level, badges and — when the organization enables it — leaderboard. */
export default function Achievements() {
  const { me } = useAuth();
  const kids = useFetch(() => api.get('/api/dashboard').then((r) => (r.data.children ?? []) as any[]), []);
  return (
    <>
      <PageHead title="My achievements" sub="XP, levels and badges you have earned." />
      <Async q={kids}>{(list: any[]) => list.length ? <div className="stack">{list.map((k) => (
        <div className="stack" key={k.id}>
          {list.length > 1 && <h2 style={{ margin: 0 }}>{k.full_name}</h2>}
          <XpCard learnerId={k.id} />
          <h3 style={{ margin: '4px 0' }}>Badges</h3><BadgeWall learnerId={k.id} />
          <XpHistory learnerId={k.id} />
          {k.batches.slice(0, 3).map((b: any) => <div key={b.id}><div className="muted small" style={{ margin: '4px 0' }}>{b.name}</div><Leaderboard scope="batch" id={b.id} /></div>)}
        </div>))}</div> : <div className="card"><Empty icon="🏅" title="Nothing yet">{me?.full_name}, your achievements will appear here once you are in a batch.</Empty></div>}</Async>
      <p className="muted small">Looking for your classes? <Link to="/classroom">Open Classroom</Link>.</p>
    </>
  );
}
