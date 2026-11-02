import type { CSSProperties, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { ProgressRing } from './kit';

export const LEVEL: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const duration = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60 ? `${m % 60}m` : ''}`.trim() : `${m} min`);

/** Course colour as a cover gradient (the course's own colour, deepened toward the school's accent). */
export const coverStyle = (color?: string | null): CSSProperties => ({ ['--cc' as any]: color || 'var(--brand)' });

/** Green rating pill ("★ 4.6 · 12"), or a "New" pill when nobody has rated yet. */
export function RatingPill({ rating, reviews }: { rating?: number | null; reviews?: number | null }) {
  return rating ? <span className="rating-pill" aria-label={`Rated ${rating} out of 5 by ${reviews ?? 0} people`}><Icon name="star" size={12} /> {rating}{reviews ? <span className="rp-n"> · {reviews}</span> : null}</span>
    : <span className="rating-pill new">New</span>;
}

/** Gradient cover with the course icon floating on it; `children` sit in the cover's corner (chips). */
export function CourseCover({ color, icon, children, size = 'md' }: { color?: string | null; icon?: string | null; children?: ReactNode; size?: 'md' | 'lg' }) {
  return <div className={`course-cover cc-${size}`} style={coverStyle(color)}><i className="cc-glow" aria-hidden /><span className="cc-icon" aria-hidden>{icon ?? '📘'}</span>{children && <div className="cc-chips">{children}</div>}</div>;
}

/** A course in the catalog. */
export function CatalogCard({ c }: { c: any }) {
  return (
    <Link to={`/catalog/${c.id}`} className="course-card">
      <CourseCover color={c.color} icon={c.icon}>{c.level && <span className="cc-chip">{LEVEL[c.level]}</span>}{c.enrolled && <span className="cc-chip on"><Icon name="check" size={12} /> Joined</span>}</CourseCover>
      <div className="course-body">
        <div className="course-meta">{c.category && <span className="course-cat">{c.category}</span>}<RatingPill rating={c.rating} reviews={c.reviews} /></div>
        <h3 className="course-title">{c.title}</h3>
        {c.instructor_name && <div className="muted small">by {c.instructor_name}</div>}
        {c.summary && <p className="course-sum">{c.summary}</p>}
        <div className="course-facts"><span><Icon name="book" size={14} /> {c.lessons} lessons</span>{c.minutes ? <span><Icon name="clock" size={14} /> {duration(c.minutes)}</span> : null}{c.gives_certificate && <span><Icon name="certificate" size={14} /> Certificate</span>}</div>
      </div>
    </Link>
  );
}

/** A course I am taking: progress ring, lessons done, due date. */
export function MyCourseCard({ c }: { c: any }) {
  const done = c.status === 'completed';
  return (
    <Link to={`/learn/${c.course_id}`} className="course-card mine">
      <CourseCover color={c.color} icon={c.icon}>{done ? <span className="cc-chip on"><Icon name="check" size={12} /> Done</span> : c.overdue ? <span className="cc-chip bad">Overdue</span> : c.level ? <span className="cc-chip">{LEVEL[c.level]}</span> : null}</CourseCover>
      <div className="course-body">
        <div className="row" style={{ gap: 12, alignItems: 'center' }}>
          <ProgressRing value={c.percent ?? 0} size={56} stroke={6} label={`${Math.round(c.percent ?? 0)}%`} />
          <div className="grow" style={{ minWidth: 0 }}><h3 className="course-title">{c.title}</h3><div className="muted small">{c.done}/{c.total} lessons{c.grade != null ? ` · ${c.grade}%` : ''}</div></div>
        </div>
        <div className="course-facts">{c.category && <span><Icon name="tag" size={14} /> {c.category}</span>}{c.due_at && !done ? <span className={c.overdue ? 'bad' : ''}><Icon name="clock" size={14} /> Due {new Date(c.due_at).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span> : c.gives_certificate ? <span><Icon name="certificate" size={14} /> Certificate</span> : null}</div>
      </div>
    </Link>
  );
}
