import { useState } from 'react';
import { Icon, IconTile, type Hue } from '../components/Icon';
import { CatalogCard } from '../components/CourseCard';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { Async, Empty, PageHead, useDebounced, useFetch } from '../components/ui';

export const Stars = ({ v }: { v: number }) => <span aria-label={`${v} out of 5`} style={{ color: '#f5a524' }}>{'★'.repeat(Math.round(v))}<span style={{ color: '#cbd5e1' }}>{'★'.repeat(5 - Math.round(v))}</span></span>;
export { duration } from '../components/CourseCard';

const CAT_ICON: [RegExp, string, Hue][] = [[/robot/i, 'robot', 'violet'], [/cod|program|python|scratch|web/i, 'grid', 'sky'], [/\bai\b|machine|intellig/i, 'sparkle', 'rose'], [/electr|circuit/i, 'bolt', 'butter'], [/art|design|anim/i, 'palette', 'peach'], [/math/i, 'bars', 'mint'], [/science|stem/i, 'compass', 'mint']];
const catIcon = (c: string): [string, Hue] => { const m = CAT_ICON.find(([re]) => re.test(c)); return m ? [m[1], m[2]] : ['book', 'slate']; };

/** The course catalog: open courses anyone in the audience can join. */
export default function Catalog() {
  const [text, setText] = useState(''); const term = useDebounced(text); const [cat, setCat] = useState('');
  const q = useFetch(() => api.get(`/api/learn/catalog${qs({ q: term, category: cat })}`), [term, cat]);
  const cats: string[] = (q.data as any)?.meta?.categories ?? [];
  return (
    <>
      <PageHead title="Course catalog" sub="Courses you can join right now. Pick one that interests you." actions={<Link className="btn" to="/learn"><Icon name="book" size={15} /> My courses</Link>} />
      <div className="stack" style={{ marginBottom: 14 }}>
        <div className="search-input"><Icon name="search" size={16} /><input className="input" type="search" placeholder="Search courses" aria-label="Search courses" value={text} onChange={(e) => setText(e.target.value)} /></div>
        {cats.length > 0 && <div className="cat-chooser" role="radiogroup" aria-label="Category">{['', ...cats].map((c) => { const [ic, hue] = c ? catIcon(c) : ['grid', 'violet'] as [string, Hue]; return (
          <button key={c || 'all'} type="button" role="radio" aria-checked={cat === c} className={`cat-choice ${cat === c ? 'on' : ''}`} onClick={() => setCat(c)}><IconTile name={ic} hue={hue} size="md" />{c || 'All'}</button>); })}</div>}
      </div>
      <Async q={q as any}>{(r: any) => !r.data.length ? <div className="card"><Empty icon="search" title="No courses found">{term || cat ? 'Try a different search.' : 'There are no open courses yet. Your school can add some.'}</Empty></div> : (
        <div className="course-grid">{r.data.map((c: any) => <CatalogCard key={c.id} c={c} />)}</div>)}</Async>
    </>
  );
}
