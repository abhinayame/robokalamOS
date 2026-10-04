import { useEffect, useMemo, useState } from 'react';
import { api, qs } from '../api';
import { fmtNum } from '../format';
import { Empty, ErrorState, SkeletonRows, StatusBadge, useDebounced, useFetch } from './ui';

export interface AudienceSummary { selected_batches: number; batch_memberships: number; unique_learners: number; duplicates_removed: number; sample?: { id: string; full_name: string; learner_code: string }[] }

/**
 * Reusable batch-selection component (the "Selection Engine" UI).
 * Pick any number of batches; the server de-duplicates by learner_id and tells you
 * how many UNIQUE learners the selection really contains. Every bulk feature embeds this.
 */
export function BatchSelector({ value, onChange, onSummary, extra }: {
  value: string[]; onChange: (ids: string[]) => void; onSummary?: (s: AudienceSummary | null) => void;
  /** Additional selector fields merged into the resolve call (e.g. filters). */
  extra?: Record<string, unknown>;
}) {
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const [status, setStatus] = useState('active,upcoming');
  const [course, setCourse] = useState('');
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState<Record<string, any>>({});

  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const list = useFetch(() => api.get(`/api/batches${qs({ q: dq, status, course_id: course, page, page_size: 50, sort: 'name' })}`), [dq, status, course, page]);
  useEffect(() => { setPage(1); }, [dq, status, course]);
  useEffect(() => { if (list.data) setPages((p) => ({ ...p, ...Object.fromEntries((list.data!.data as any[]).map((b) => [b.id, b])) })); }, [list.data]);

  const rows: any[] = list.data?.data ?? [];
  const total: number = list.data?.meta?.total ?? 0;
  const set = useMemo(() => new Set(value), [value]);
  const toggle = (id: string) => onChange(set.has(id) ? value.filter((x) => x !== id) : [...value, id]);

  // Live unique-learner calculation from the server (never computed in the browser).
  const key = JSON.stringify([value, extra]);
  const sum = useFetch(async () => (value.length || extra ? (await api.post('/api/selection/resolve', { batch_ids: value, ...extra })).data as AudienceSummary : null), [key]);
  useEffect(() => { onSummary?.(sum.data ?? null); }, [sum.data]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="stack">
      <div className="row wrap">
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Search batches…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search batches" />
        <select className="select" style={{ width: 150 }} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Batch status">
          <option value="active,upcoming">Active & upcoming</option><option value="active">Active</option><option value="upcoming">Upcoming</option><option value="completed">Completed</option><option value="active,upcoming,completed,archived">All</option>
        </select>
        <select className="select" style={{ width: 160 }} value={course} onChange={(e) => setCourse(e.target.value)} aria-label="Course">
          <option value="">All courses</option>{(courses.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      <div className="row between small">
        <span className="muted">{fmtNum(total)} batches</span>
        <span className="row gap-s">
          <button type="button" className="btn sm" disabled={!rows.length} onClick={() => onChange([...new Set([...value, ...rows.map((b) => b.id)])])}>Select shown</button>
          <button type="button" className="btn sm" disabled={!value.length} onClick={() => onChange([])}>Clear</button>
        </span>
      </div>
      <div className="pick-list" role="group" aria-label="Batches">
        {list.loading && !rows.length ? <SkeletonRows n={4} /> : list.error && !rows.length ? <ErrorState error={list.error} onRetry={list.reload} />
          : !rows.length ? <Empty icon="🗂️" title="No batches match">Try a different search or status.</Empty>
          : rows.map((b) => (
            <label key={b.id} className="pick">
              <input type="checkbox" checked={set.has(b.id)} onChange={() => toggle(b.id)} />
              <span className="grow"><b>{b.name}</b><br /><span className="muted small">{b.batch_code} · {b.course_name}{b.branch_name ? ` · ${b.branch_name}` : ''}</span></span>
              <span className="small muted nowrap">{fmtNum(b.active_learners)} learners</span><StatusBadge s={b.status} />
            </label>
          ))}
      </div>
      {total > page * 50 && <button type="button" className="btn sm" onClick={() => setPage(page + 1)}>Show next 50 batches</button>}
      {page > 1 && total <= page * 50 && <button type="button" className="btn sm" onClick={() => setPage(1)}>Back to first 50</button>}

      <div aria-live="polite">
        <div className="summary-grid">
          <div><b>{value.length}</b><span>Selected batches</span></div>
          <div><b>{sum.data ? fmtNum(sum.data.batch_memberships) : '—'}</b><span>Batch memberships</span></div>
          <div className="hl"><b>{sum.data ? fmtNum(sum.data.unique_learners) : '—'}</b><span>Unique learners</span></div>
          <div><b>{sum.data ? fmtNum(sum.data.duplicates_removed) : '—'}</b><span>Duplicates removed</span></div>
        </div>
        {value.length > 0 && Object.keys(pages).length > 0 && <p className="muted small" style={{ margin: '8px 0 0' }}>A learner who is in several selected batches is counted once.</p>}
      </div>
    </div>
  );
}
