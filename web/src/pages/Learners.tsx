import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { BatchSelector, type AudienceSummary } from '../components/BatchSelector';
import { Avatar, Badge, Empty, ErrorState, Field, Modal, PageHead, Pager, Popover, SkeletonRows, StatusBadge, fieldErrors, useAction, useDebounced, useFetch, usePersistentState, useToast } from '../components/ui';
import { fmtDate, fmtMobile, fmtNum } from '../format';
import { ACTIVITY_TYPES, LEAD_STATUSES, TagChip, TagPicker } from '../components/Crm';

type Sel = { kind: 'ids'; ids: string[] } | { kind: 'filters' } | { kind: 'batches'; batch_ids: string[] } | null;
interface Filters { q: string; status: string[]; branch_id: string; course_id: string; program_id: string; teacher_id: string; batch_id: string[]; academic_year: string; enrolled_from: string; enrolled_to: string; no_batch: boolean; tag_id: string; lead_status: string; counsellor_id: string }
const EMPTY: Filters = { q: '', status: [], branch_id: '', course_id: '', program_id: '', teacher_id: '', batch_id: [], academic_year: '', enrolled_from: '', enrolled_to: '', no_batch: false, tag_id: '', lead_status: '', counsellor_id: '' };

const COLUMNS: { id: string; label: string; sort?: string; render: (l: any) => any }[] = [
  { id: 'mobile', label: 'Mobile', render: (l) => fmtMobile(l.mobile) },
  { id: 'email', label: 'Email', render: (l) => l.email ?? '—' },
  { id: 'parent', label: 'Parent', render: (l) => l.parent ? <>{l.parent.full_name}<div className="muted small">{fmtMobile(l.parent.mobile)}</div></> : '—' },
  { id: 'school', label: 'School', render: (l) => l.school ?? '—' },
  { id: 'location', label: 'Location', render: (l) => l.location ?? '—' },
  { id: 'courses', label: 'Courses', render: (l) => <div className="chips">{l.courses.length ? l.courses.map((c: string) => <Badge key={c} tone="info">{c}</Badge>) : '—'}</div> },
  { id: 'batches', label: 'Batches', sort: 'batches', render: (l) => <div className="chips">{l.batches.length ? l.batches.map((b: any) => <Link key={b.id} to={`/batches/${b.id}`}><Badge>{b.name}</Badge></Link>) : <span className="muted">None</span>}</div> },
  { id: 'teachers', label: 'Teachers', render: (l) => l.teachers.map((t: any) => t.full_name).join(', ') || '—' },
  { id: 'tags', label: 'Tags', render: (l) => <div className="chips">{l.tags?.length ? l.tags.map((t: any) => <TagChip key={t.id} t={t} />) : <span className="muted">—</span>}</div> },
  { id: 'lead', label: 'CRM', render: (l) => l.lead ? <Badge tone={l.lead.status === 'converted' ? 'ok' : ['lost', 'not_interested'].includes(l.lead.status) ? 'bad' : 'info'}>{l.lead.status.replace(/_/g, ' ')}</Badge> : <span className="muted">—</span> },
  { id: 'status', label: 'Status', sort: 'status', render: (l) => <StatusBadge s={l.status} /> },
  { id: 'last_activity', label: 'Last activity', sort: 'last_activity', render: (l) => fmtDate(l.last_activity) },
  { id: 'enrolled_on', label: 'Enrolled', sort: 'enrolled_on', render: (l) => fmtDate(l.enrolled_on) },
];
const DEFAULT_COLS = ['mobile', 'parent', 'courses', 'batches', 'status', 'last_activity'];

export default function Learners() {
  const { can, activeOrg } = useAuth();
  const [sp, setSp] = useSearchParams();
  const [f, setF] = useState<Filters>({ ...EMPTY, no_batch: sp.get('no_batch') === 'true' });
  const [showFilters, setShowFilters] = useState(f.no_batch);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = usePersistentState('rk_learners_ps', 25);
  const [sort, setSort] = useState('name');
  const [order, setOrder] = useState<'asc' | 'desc'>('asc');
  const [cols, setCols] = usePersistentState<string[]>('rk_learners_cols', DEFAULT_COLS);
  const [sel, setSel] = useState<Sel>(null);
  const [dialog, setDialog] = useState<null | 'add' | 'bulk' | 'byBatch'>(null);
  const dq = useDebounced(f.q);
  const toast = useToast();

  const apiFilters = { q: dq, status: f.status, branch_id: f.branch_id, course_id: f.course_id, program_id: f.program_id, teacher_id: f.teacher_id, batch_id: f.batch_id, academic_year: f.academic_year, enrolled_from: f.enrolled_from, enrolled_to: f.enrolled_to, tag_id: f.tag_id, lead_status: f.lead_status, counsellor_id: f.counsellor_id, no_batch: f.no_batch || undefined };
  const fkey = JSON.stringify(apiFilters);
  useEffect(() => { setPage(1); setSel(null); }, [fkey, pageSize]);
  const list = useFetch(() => api.get(`/api/learners${qs({ ...apiFilters, page, page_size: pageSize, sort, order })}`), [fkey, page, pageSize, sort, order, activeOrg]);

  const branches = useFetch(() => api.get('/api/branches').then((r) => r.data as any[]), []);
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const programs = useFetch(() => api.get('/api/programs').then((r) => r.data as any[]), []);
  const teachers = useFetch(() => (can('teacher:read') ? api.get('/api/teachers?page_size=100').then((r) => r.data as any[]) : Promise.resolve([] as any[])), []);

  const rows: any[] = list.data?.data ?? [];
  const meta = list.data?.meta;
  const pageIds = rows.map((r) => r.id);
  const selIds = sel?.kind === 'ids' ? sel.ids : [];
  const allOnPage = rows.length > 0 && pageIds.every((id) => selIds.includes(id));
  const toggle = (id: string) => setSel({ kind: 'ids', ids: selIds.includes(id) ? selIds.filter((x) => x !== id) : [...selIds, id] });
  const filtersBody = () => ({
    q: dq || undefined, status: f.status.length ? f.status : ['active', 'inactive'], branch_id: f.branch_id ? [f.branch_id] : undefined, course_id: f.course_id ? [f.course_id] : undefined,
    program_id: f.program_id ? [f.program_id] : undefined, teacher_id: f.teacher_id ? [f.teacher_id] : undefined, batch_id: f.batch_id.length ? f.batch_id : undefined,
    academic_year: f.academic_year ? [f.academic_year] : undefined, enrolled_from: f.enrolled_from || undefined, enrolled_to: f.enrolled_to || undefined, no_batch: f.no_batch || undefined,
    tag_id: f.tag_id ? [f.tag_id] : undefined, lead_status: f.lead_status ? [f.lead_status] : undefined, counsellor_id: f.counsellor_id ? [f.counsellor_id] : undefined,
  });
  const selector = useMemo(() => {
    if (!sel) return null;
    if (sel.kind === 'ids') return { learner_ids: sel.ids, learner_statuses: ['active', 'inactive', 'archived'] };
    if (sel.kind === 'batches') return { batch_ids: sel.batch_ids };
    return { filters: filtersBody() };
  }, [sel, fkey]); // eslint-disable-line

  const setCol = (id: string) => setCols(cols.includes(id) ? cols.filter((c) => c !== id) : COLUMNS.map((c) => c.id).filter((c) => cols.includes(c) || c === id));
  const shownCols = COLUMNS.filter((c) => cols.includes(c.id));
  const sortBy = (s?: string) => { if (!s) return; if (sort === s) setOrder(order === 'asc' ? 'desc' : 'asc'); else { setSort(s); setOrder('asc'); } };
  const activeFilters = Object.entries(f).filter(([k, v]) => k !== 'q' && (Array.isArray(v) ? v.length : v)).length;
  const noFilters = !f.q && !activeFilters;

  return (
    <>
      <PageHead title="All Learners" sub="The master learner database. One learner, one profile — however many batches they join."
        actions={<>
          <button className="btn" onClick={() => setDialog('byBatch')}>Select by batches</button>
          {can('learner:create') && <button className="btn primary" onClick={() => setDialog('add')}>＋ Add learner</button>}
        </>} />
      <div className="card">
        <div className="row wrap" style={{ padding: 12 }}>
          <input className="input grow" style={{ minWidth: 200 }} placeholder="Search name, ID, mobile, email or parent…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search learners" />
          <button className="btn" onClick={() => setShowFilters(!showFilters)} aria-expanded={showFilters}>Filters{activeFilters ? <Badge tone="accent">{activeFilters}</Badge> : null}</button>
          <Popover label="Columns">
            <div className="stack-s">{COLUMNS.map((c) => <label key={c.id} className="row gap-s"><input type="checkbox" checked={cols.includes(c.id)} onChange={() => setCol(c.id)} /> {c.label}</label>)}
              <button className="btn sm" onClick={() => setCols(DEFAULT_COLS)}>Reset</button></div>
          </Popover>
        </div>
        {showFilters && (
          <div className="filters">
            <Field label="Status"><select className="select" value={f.status[0] ?? ''} onChange={(e) => setF({ ...f, status: e.target.value ? [e.target.value] : [] })}><option value="">Active & inactive</option><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option></select></Field>
            <Field label="Program"><select className="select" value={f.program_id} onChange={(e) => setF({ ...f, program_id: e.target.value })}><option value="">Any</option>{(programs.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Course"><select className="select" value={f.course_id} onChange={(e) => setF({ ...f, course_id: e.target.value })}><option value="">Any</option>{(courses.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            <Field label="Branch"><select className="select" value={f.branch_id} onChange={(e) => setF({ ...f, branch_id: e.target.value })}><option value="">Any</option>{(branches.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>
            {can('teacher:read') && <Field label="Teacher"><select className="select" value={f.teacher_id} onChange={(e) => setF({ ...f, teacher_id: e.target.value })}><option value="">Any</option>{(teachers.data ?? []).map((p: any) => <option key={p.id} value={p.id}>{p.full_name}</option>)}</select></Field>}
            <Field label="Academic year"><input className="input" placeholder="2026-27" value={f.academic_year} onChange={(e) => setF({ ...f, academic_year: e.target.value })} /></Field>
            <Field label="Enrolled from"><input className="input" type="date" value={f.enrolled_from} onChange={(e) => setF({ ...f, enrolled_from: e.target.value })} /></Field>
            <Field label="Enrolled to"><input className="input" type="date" value={f.enrolled_to} onChange={(e) => setF({ ...f, enrolled_to: e.target.value })} /></Field>
            {can('tag:read') && <Field label="Tag"><TagPicker value={f.tag_id} onChange={(v) => setF({ ...f, tag_id: v })} /></Field>}
            {can('crm:read') && <Field label="CRM status"><select className="select" value={f.lead_status} onChange={(e) => setF({ ...f, lead_status: e.target.value })}><option value="">Any</option>{LEAD_STATUSES.map((x) => <option key={x} value={x}>{x.replace(/_/g, ' ')}</option>)}</select></Field>}
            <Field label="Batches"><BatchesFilter value={f.batch_id} onChange={(ids) => setF({ ...f, batch_id: ids })} /></Field>
            <Field label="Batch membership"><label className="row gap-s" style={{ minHeight: 38 }}><input type="checkbox" checked={f.no_batch} onChange={(e) => setF({ ...f, no_batch: e.target.checked })} /> Not in any batch</label></Field>
            <div className="row" style={{ alignItems: 'flex-end' }}><button className="btn" onClick={() => { setF(EMPTY); setSp({}); }} disabled={noFilters}>Clear all</button></div>
          </div>
        )}
        {meta && <div className="row between small" style={{ padding: '8px 14px', borderTop: '1px solid var(--line)' }}><b aria-live="polite">{fmtNum(meta.total)} unique learners match{noFilters ? '' : ' your filters'}.</b>{list.loading && <span className="muted">Updating…</span>}</div>}

        {sel && selector && <SelectionBar sel={sel} selector={selector} total={meta?.total ?? 0} count={selIds.length} onAllMatching={() => setSel({ kind: 'filters' })} pageSelected={sel.kind === 'ids' && allOnPage} onClear={() => setSel(null)} onBulk={() => setDialog('bulk')} canBulk={can('learner:bulk') || can('learner:export') || can('gamification:award') || can('tag:apply') || can('crm:manage')} />}

        {list.error && !list.data ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.data ? <SkeletonRows n={8} /> : !rows.length ? (
          <Empty icon="🔍" title={noFilters ? 'No learners yet' : 'No learners match'} action={noFilters && can('learner:create') ? <button className="btn primary" onClick={() => setDialog('add')}>Add the first learner</button> : <button className="btn" onClick={() => setF(EMPTY)}>Clear filters</button>}>
            {noFilters ? 'Add learners one by one or enrol them into batches.' : 'Try removing a filter or changing your search.'}</Empty>
        ) : (
          <>
            <div className="table-wrap hide-m"><table className="t">
              <thead><tr>
                <th className="chk"><input type="checkbox" aria-label="Select this page" checked={allOnPage} onChange={() => setSel(allOnPage ? null : { kind: 'ids', ids: pageIds })} /></th>
                <th className="sortable" onClick={() => sortBy('name')}>Learner {sort === 'name' && (order === 'asc' ? '↑' : '↓')}</th>
                {shownCols.map((c) => <th key={c.id} className={c.sort ? 'sortable' : ''} onClick={() => sortBy(c.sort)}>{c.label} {c.sort === sort && (order === 'asc' ? '↑' : '↓')}</th>)}
              </tr></thead>
              <tbody>{rows.map((l) => (
                <tr key={l.id} className={sel?.kind === 'filters' || selIds.includes(l.id) ? 'sel' : ''}>
                  <td className="chk"><input type="checkbox" aria-label={`Select ${l.full_name}`} checked={sel?.kind === 'filters' || selIds.includes(l.id)} disabled={sel?.kind === 'filters'} onChange={() => toggle(l.id)} /></td>
                  <td className="nm"><Link to={`/learners/${l.id}`} className="row" style={{ color: 'inherit' }}><Avatar name={l.full_name} url={l.photo_url} /><span><b>{l.full_name}</b><br /><span className="muted mono">{l.learner_code}</span></span></Link></td>
                  {shownCols.map((c) => <td key={c.id}>{c.render(l)}</td>)}
                </tr>))}</tbody></table></div>
            <div className="cards-m">{rows.map((l) => (
              <div key={l.id} className="m-card">
                <input type="checkbox" aria-label={`Select ${l.full_name}`} checked={sel?.kind === 'filters' || selIds.includes(l.id)} disabled={sel?.kind === 'filters'} onChange={() => toggle(l.id)} style={{ marginTop: 6 }} />
                <Avatar name={l.full_name} url={l.photo_url} />
                <div className="grow"><Link to={`/learners/${l.id}`}><b>{l.full_name}</b></Link> <StatusBadge s={l.status} /><div className="muted small mono">{l.learner_code} · {fmtMobile(l.mobile)}</div>
                  <div className="chips" style={{ marginTop: 4 }}>{l.batches.map((b: any) => <Badge key={b.id}>{b.name}</Badge>)}</div></div>
              </div>))}</div>
          </>
        )}
        {meta && rows.length > 0 && (
          <div className="pager" style={{ borderTop: 'none', paddingBottom: 0 }}><span className="muted small">Rows per page</span>
            <select className="select" style={{ width: 80 }} value={pageSize} onChange={(e) => setPageSize(Number(e.target.value))} aria-label="Rows per page">{[10, 25, 50, 100].map((n) => <option key={n}>{n}</option>)}</select></div>)}
        {meta && <Pager meta={meta} onPage={setPage} />}
      </div>

      {dialog === 'add' && <AddLearner onClose={() => setDialog(null)} onDone={() => { setDialog(null); list.reload(); toast('Learner added'); }} />}
      {dialog === 'byBatch' && <ByBatchDialog onClose={() => setDialog(null)} onUse={(ids) => { setSel({ kind: 'batches', batch_ids: ids }); setDialog('bulk'); }} />}
      {dialog === 'bulk' && selector && sel && <BulkDialog selector={selector} sel={sel} onClose={() => setDialog(null)} onDone={() => { setDialog(null); setSel(null); list.reload(); }} />}
    </>
  );
}

function BatchesFilter({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const [open, setOpen] = useState(false);
  return <>
    <button className="btn" style={{ justifyContent: 'space-between', width: '100%' }} onClick={() => setOpen(true)}>{value.length ? `${value.length} batch${value.length > 1 ? 'es' : ''} selected` : 'Any batch'} <span aria-hidden>▾</span></button>
    {open && <Modal title="Filter by batches" onClose={() => setOpen(false)} wide footer={<button className="btn primary" onClick={() => setOpen(false)}>Apply</button>}><BatchSelector value={value} onChange={onChange} /></Modal>}
  </>;
}

function SelectionBar({ sel, selector, total, count, pageSelected, onAllMatching, onClear, onBulk, canBulk }: { sel: NonNullable<Sel>; selector: any; total: number; count: number; pageSelected: boolean; onAllMatching: () => void; onClear: () => void; onBulk: () => void; canBulk: boolean }) {
  const sum = useFetch(() => api.post('/api/selection/resolve', selector).then((r) => r.data as AudienceSummary), [JSON.stringify(selector)]);
  return (
    <div className="banner" role="status">
      <b>{sum.data ? fmtNum(sum.data.unique_learners) : '…'} unique learner{sum.data?.unique_learners === 1 ? '' : 's'} selected</b>
      {sel.kind === 'ids' && <span className="muted">({count} ticked)</span>}
      {sel.kind === 'filters' && <span>— everything matching your filters</span>}
      {sel.kind === 'batches' && <span>— from {sel.batch_ids.length} batch{sel.batch_ids.length > 1 ? 'es' : ''}{sum.data && sum.data.duplicates_removed > 0 ? `, ${sum.data.duplicates_removed} duplicate${sum.data.duplicates_removed > 1 ? 's' : ''} removed` : ''}</span>}
      {sel.kind === 'ids' && pageSelected && total > count && <button className="btn sm" onClick={onAllMatching}>Select all {fmtNum(total)} matching</button>}
      <span className="grow" />
      {canBulk && <button className="btn primary sm" onClick={onBulk} disabled={!sum.data?.unique_learners}>Bulk actions</button>}
      <button className="btn sm" onClick={onClear}>Clear</button>
    </div>
  );
}

function ByBatchDialog({ onClose, onUse }: { onClose: () => void; onUse: (ids: string[]) => void }) {
  const [ids, setIds] = useState<string[]>([]);
  const [sum, setSum] = useState<AudienceSummary | null>(null);
  return <Modal wide title="Select learners by batches" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={!sum?.unique_learners} onClick={() => onUse(ids)}>Continue with {sum ? fmtNum(sum.unique_learners) : 0} learners</button></>}>
    <BatchSelector value={ids} onChange={setIds} onSummary={setSum} />
  </Modal>;
}

function BulkDialog({ selector, sel, onClose, onDone }: { selector: any; sel: NonNullable<Sel>; onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const toast = useToast();
  const { busy, run } = useAction();
  const actions = [
    can('learner:bulk', 'batch:enroll') && { id: 'assign_batch', label: 'Add to a batch' },
    can('learner:bulk', 'batch:enroll') && { id: 'remove_batch', label: 'Remove from a batch' },
    can('learner:bulk', 'learner:update') && { id: 'change_status', label: 'Change status' },
    can('tag:apply') && { id: 'add_tag', label: 'Add a tag' },
    can('tag:apply') && { id: 'remove_tag', label: 'Remove a tag' },
    can('crm:manage') && { id: 'assign_counsellor', label: 'Assign counsellor' },
    can('crm:manage') && { id: 'create_crm_activity', label: 'Log a CRM activity' },
    can('crm:manage') && { id: 'create_follow_up', label: 'Create a follow-up' },
    can('gamification:award') && { id: 'award_xp', label: 'Award XP' },
    can('gamification:award') && { id: 'award_badge', label: 'Award a badge' },
    can('learner:export') && { id: 'export', label: 'Export CSV' },
  ].filter(Boolean) as { id: string; label: string }[];
  const [action, setAction] = useState(actions[0]?.id ?? '');
  const [batchId, setBatchId] = useState('');
  const [status, setStatus] = useState('inactive');
  const [reason, setReason] = useState('');
  const [points, setPoints] = useState('10');
  const [badgeId, setBadgeId] = useState('');
  const [requestId] = useState(() => crypto.randomUUID());
  const [tagId, setTagId] = useState('');
  const [counsellor, setCounsellor] = useState('');
  const [actType, setActType] = useState('whatsapp_sent');
  const [due, setDue] = useState('');
  const counsellors = useFetch(() => (can('crm:manage') ? api.get('/api/crm/counsellors').then((r) => r.data as any[]) : Promise.resolve([] as any[])), []);
  const tagList = useFetch(() => (can('tag:apply') ? api.get('/api/tags').then((r) => r.data as any[]) : Promise.resolve([] as any[])), []);
  const [step, setStep] = useState<'choose' | 'review'>('choose');
  const [summary, setSummary] = useState<AudienceSummary | null>(null);
  const batches = useFetch(() => api.get('/api/batches?status=active,upcoming&page_size=100&sort=name').then((r) => r.data as any[]), []);
  const badges = useFetch(() => (can('gamification:award') ? api.get('/api/gamification/badges').then((r) => r.data as any[]) : Promise.resolve([])), []);
  const body = () => ({ action, selection: selector, ...(action === 'assign_batch' ? { batch_id: batchId } : action === 'remove_batch' ? { batch_id: batchId, reason: reason || undefined }
    : action === 'add_tag' || action === 'remove_tag' ? { tag_id: tagId }
    : action === 'assign_counsellor' ? { counsellor_id: counsellor }
    : action === 'create_crm_activity' ? { type: actType, description: reason || null }
    : action === 'create_follow_up' ? { due_at: due ? new Date(due).toISOString() : undefined, note: reason || null, assigned_to: counsellor }
    : action === 'award_xp' ? { points: Number(points), reason, batch_id: batchId || null, request_id: requestId }
    : action === 'award_badge' ? { badge_id: badgeId, reason: reason || null, batch_id: batchId || null } : { status }) });

  async function review() {
    if (action === 'export') { await run(() => api.download('/api/bulk/learners/export', { selection: selector }, `learners-${new Date().toISOString().slice(0, 10)}.csv`), 'Export downloaded'); return; }
    const r = await run(() => api.post('/api/bulk/learners', { ...body(), dry_run: true }));
    if (r) { setSummary(r.data); setStep('review'); }
  }
  async function confirm() {
    const r = await run(() => api.post('/api/bulk/learners', { ...body(), confirm: true }));
    if (r) { const d = r.data; toast(action === 'add_tag' ? `${d.added} learners tagged (${d.already} already had it)` : action === 'remove_tag' ? `${d.removed} tags removed` : action === 'assign_counsellor' ? `${d.assigned} learners assigned (${d.leads_created} new leads created)` : action === 'create_crm_activity' ? `Logged for ${d.logged} learners` : action === 'create_follow_up' ? `${d.created} follow-ups created` : action === 'award_xp' ? `${d.awarded} learners awarded ${points} XP` : action === 'award_badge' ? `${d.awarded} learners earned the badge (${d.already_has} already had it)` : action === 'assign_batch' ? `${d.joined + d.rejoined} learners added (${d.already_member} already in the batch)` : action === 'remove_batch' ? `${d.removed} learners removed` : `${d.changed} learners updated`); onDone(); }
  }
  const isAward = action === 'award_xp' || action === 'award_badge';
  const needsBatch = action === 'assign_batch' || action === 'remove_batch' || (isAward && !can('gamification:manage'));
  const crmReady = action === 'add_tag' || action === 'remove_tag' ? !!tagId : action === 'assign_counsellor' ? !!counsellor : action === 'create_follow_up' ? !!counsellor && !!due : true;
  const awardReady = crmReady && !isAward || (action === 'award_xp' ? Number.isInteger(Number(points)) && Number(points) !== 0 && reason.trim().length >= 2 : !!badgeId);
  return (
    <Modal title="Bulk action" onClose={onClose} footer={step === 'choose'
      ? <><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !action || (needsBatch && !batchId) || !awardReady} onClick={review}>{action === 'export' ? 'Download CSV' : 'Review'}</button></>
      : <><button className="btn" onClick={() => setStep('choose')}>Back</button><button className="btn primary" disabled={busy} onClick={confirm}>{busy ? 'Working…' : 'Confirm & apply'}</button></>}>
      {!actions.length ? <Empty title="No bulk actions available">Your role cannot run bulk actions.</Empty> : step === 'choose' ? (
        <div className="stack">
          <Field label="Action"><select className="select" value={action} onChange={(e) => setAction(e.target.value)}>{actions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}</select></Field>
          {(needsBatch || isAward) && <Field label={isAward && !needsBatch ? 'Batch (optional)' : 'Batch'} hint={isAward ? 'XP and badges are credited to this classroom and count on its leaderboard.' : undefined}><select className="select" value={batchId} onChange={(e) => setBatchId(e.target.value)}><option value="">Choose a batch…</option>{(batches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name} ({b.active_learners}{b.capacity ? `/${b.capacity}` : ''})</option>)}</select></Field>}
          {(action === 'add_tag' || action === 'remove_tag') && <Field label="Tag"><select className="select" value={tagId} onChange={(e) => setTagId(e.target.value)}><option value="">Choose a tag…</option>{(tagList.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></Field>}
          {(action === 'assign_counsellor' || action === 'create_follow_up') && <Field label={action === 'create_follow_up' ? 'Assign to' : 'Counsellor'}><select className="select" value={counsellor} onChange={(e) => setCounsellor(e.target.value)}><option value="">Choose…</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>}
          {action === 'create_follow_up' && <><Field label="Due"><input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} /></Field><Field label="Note (optional)"><input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}
          {action === 'create_crm_activity' && <><Field label="Activity"><select className="select" value={actType} onChange={(e) => setActType(e.target.value)}>{ACTIVITY_TYPES.filter((t) => !['status_changed', 'counsellor_assigned', 'batch_assigned'].includes(t)).map((t) => <option key={t} value={t}>{t.replace(/_/g, ' ')}</option>)}</select></Field><Field label="Details (optional)"><input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}
          {action === 'award_xp' && <><Field label="XP points" hint="Whole number; admins may enter a negative number to correct a mistake."><input className="input" type="number" value={points} onChange={(e) => setPoints(e.target.value)} /></Field><Field label="Reason"><input className="input" maxLength={255} placeholder="e.g. Hackathon participation" value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}
          {action === 'award_badge' && <><Field label="Badge"><select className="select" value={badgeId} onChange={(e) => setBadgeId(e.target.value)}><option value="">Choose a badge…</option>{(badges.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.icon} {b.name}{b.xp_reward ? ` (+${b.xp_reward} XP)` : ''}</option>)}</select></Field><Field label="Reason (optional)"><input className="input" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} /></Field></>}
          {action === 'remove_batch' && <Field label="Reason (optional)"><input className="input" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} /></Field>}
          {action === 'change_status' && <Field label="New status"><select className="select" value={status} onChange={(e) => setStatus(e.target.value)}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived (ends batch memberships)</option></select></Field>}
          <p className="muted small" style={{ margin: 0 }}>{sel.kind === 'filters' ? 'Applies to every learner matching your current filters.' : sel.kind === 'batches' ? 'Applies to the unique learners of the selected batches.' : 'Applies to the learners you ticked.'} Duplicates are always removed first.</p>
        </div>
      ) : (
        <div className="stack">
          <h3>Please review</h3>
          <div className="summary-grid">
            <div><b>{fmtNum(summary!.selected_batches)}</b><span>Selected batches</span></div><div><b>{fmtNum(summary!.batch_memberships)}</b><span>Batch memberships</span></div>
            <div className="hl"><b>{fmtNum(summary!.unique_learners)}</b><span>Unique learners</span></div><div><b>{fmtNum(summary!.duplicates_removed)}</b><span>Duplicates removed</span></div>
          </div>
          <p style={{ margin: 0 }}>{action === 'assign_batch' && <>Add <b>{fmtNum(summary!.unique_learners)}</b> learners to <b>{batches.data?.find((b: any) => b.id === batchId)?.name}</b>. Learners already in the batch are skipped.</>}
            {action === 'remove_batch' && <>Remove <b>{fmtNum(summary!.unique_learners)}</b> learners from <b>{batches.data?.find((b: any) => b.id === batchId)?.name}</b>. Their other batches are not affected.</>}
            {action === 'add_tag' && <>Add the tag “{tagList.data?.find((t: any) => t.id === tagId)?.name}” to <b>{fmtNum(summary!.unique_learners)}</b> unique learners. Anyone who already has it is skipped.</>}
            {action === 'remove_tag' && <>Remove the tag “{tagList.data?.find((t: any) => t.id === tagId)?.name}” from <b>{fmtNum(summary!.unique_learners)}</b> unique learners.</>}
            {action === 'assign_counsellor' && <>Assign <b>{counsellors.data?.find((c: any) => c.id === counsellor)?.full_name}</b> as counsellor for <b>{fmtNum(summary!.unique_learners)}</b> unique learners. Learners that are not in the CRM yet are added as new leads.</>}
            {action === 'create_crm_activity' && <>Log “{actType.replace(/_/g, ' ')}” on the CRM timeline of <b>{fmtNum(summary!.unique_learners)}</b> unique learners.</>}
            {action === 'create_follow_up' && <>Create a follow-up for <b>{fmtNum(summary!.unique_learners)}</b> unique learners, assigned to <b>{counsellors.data?.find((c: any) => c.id === counsellor)?.full_name}</b>. They get one summary notification.</>}
            {action === 'award_xp' && <>Award <b>{points} XP</b> to <b>{fmtNum(summary!.unique_learners)}</b> unique learners for “{reason}”. Each learner gets it once, even if they are in several selected batches.</>}
            {action === 'award_badge' && <>Award <b>{badges.data?.find((b: any) => b.id === badgeId)?.name}</b> to <b>{fmtNum(summary!.unique_learners)}</b> unique learners. Learners who already have it are skipped.</>}
            {action === 'change_status' && <>Change status to <b>{status}</b> for <b>{fmtNum(summary!.unique_learners)}</b> learners.</>}</p>
        </div>
      )}
    </Modal>
  );
}

function AddLearner({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const { busy, run } = useAction();
  const [v, setV] = useState<any>({ full_name: '', mobile: '', email: '', school: '', location: '', date_of_birth: '', gender: '', branch_id: '', parent_name: '', parent_mobile: '', parent_email: '', relationship: 'mother' });
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<any>(null);
  const branches = useFetch(() => api.get('/api/branches').then((r) => r.data as any[]), []);
  const batches = useFetch(() => api.get('/api/batches?status=active,upcoming&page_size=100&sort=name').then((r) => r.data as any[]), []);
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({}); setDup(null);
    const body: any = { full_name: v.full_name, mobile: v.mobile || null, email: v.email || null, school: v.school || null, location: v.location || null, date_of_birth: v.date_of_birth || null, gender: v.gender || null, branch_id: v.branch_id || null, batch_ids: batchIds };
    if (v.parent_name) body.parent = { full_name: v.parent_name, mobile: v.parent_mobile || null, email: v.parent_email || null, relationship: v.relationship };
    try { await api.post('/api/learners', body); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (err.code === 'DUPLICATE_LEARNER') setDup(err.details); else if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return (
    <Modal wide title="Add learner" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="add-learner" disabled={busy || v.full_name.trim().length < 2}>Save learner</button></>}>
      <form id="add-learner" onSubmit={submit} className="stack" noValidate>
        {dup && <div className="badge warn" role="alert" style={{ whiteSpace: 'normal', padding: '8px 12px' }}>A learner with this {dup.field} already exists: <Link to={`/learners/${dup.existing.id}`}>{dup.existing.full_name} ({dup.existing.learner_code})</Link>. Add them to more batches from their profile instead of creating a duplicate.</div>}
        <div className="form-grid">
          <Field label="Full name *" error={errs.full_name}><input className="input" value={v.full_name} onChange={set('full_name')} autoFocus /></Field>
          <Field label="Mobile" error={errs.mobile} hint="10 digit Indian mobile"><input className="input" inputMode="tel" value={v.mobile} onChange={set('mobile')} /></Field>
          <Field label="Email" error={errs.email}><input className="input" type="email" value={v.email} onChange={set('email')} /></Field>
          <Field label="Date of birth" error={errs.date_of_birth}><input className="input" type="date" value={v.date_of_birth} onChange={set('date_of_birth')} /></Field>
          <Field label="School"><input className="input" value={v.school} onChange={set('school')} /></Field>
          <Field label="Location"><input className="input" value={v.location} onChange={set('location')} /></Field>
          <Field label="Gender"><select className="select" value={v.gender} onChange={set('gender')}><option value="">Not specified</option><option value="female">Female</option><option value="male">Male</option><option value="other">Other</option><option value="undisclosed">Prefer not to say</option></select></Field>
          {can('branch:manage') || (branches.data ?? []).length ? <Field label="Branch"><select className="select" value={v.branch_id} onChange={set('branch_id')}><option value="">—</option>{(branches.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field> : null}
        </div>
        <h3>Parent / guardian</h3>
        <div className="form-grid">
          <Field label="Name" error={errs['parent.full_name']}><input className="input" value={v.parent_name} onChange={set('parent_name')} /></Field>
          <Field label="Relationship"><select className="select" value={v.relationship} onChange={set('relationship')}><option value="mother">Mother</option><option value="father">Father</option><option value="guardian">Guardian</option></select></Field>
          <Field label="Parent mobile" error={errs['parent.mobile']} hint="Siblings with the same parent mobile share one parent record."><input className="input" inputMode="tel" value={v.parent_mobile} onChange={set('parent_mobile')} /></Field>
          <Field label="Parent email" error={errs['parent.email']}><input className="input" type="email" value={v.parent_email} onChange={set('parent_email')} /></Field>
        </div>
        <Field label="Enrol in batches (optional)">
          <div className="pick-list">{(batches.data ?? []).length === 0 ? <Empty title="No open batches" /> : (batches.data ?? []).map((b: any) => <label key={b.id} className="pick"><input type="checkbox" checked={batchIds.includes(b.id)} onChange={() => setBatchIds(batchIds.includes(b.id) ? batchIds.filter((x) => x !== b.id) : [...batchIds, b.id])} /><span className="grow">{b.name}</span><span className="muted small">{b.course_name}</span></label>)}</div>
        </Field>
      </form>
    </Modal>
  );
}
