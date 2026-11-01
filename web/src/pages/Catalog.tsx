import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Empty, ErrorState, Field, Modal, PageHead, SkeletonRows, StatusBadge, Tabs, fieldErrors, useAction, useFetch, useToast } from '../components/ui';

type Kind = 'programs' | 'courses' | 'branches';
const LABEL: Record<Kind, string> = { programs: 'Program', courses: 'Course', branches: 'Branch' };

export default function Catalog() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Kind>('programs');
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const [showAll, setShowAll] = useState(false);
  const q = useFetch(() => api.get(`/api/${tab}${showAll ? '?include_archived=true' : ''}`).then((r) => r.data as any[]), [tab, showAll]);
  const programs = useFetch(() => api.get('/api/programs').then((r) => r.data as any[]), []);
  const manage = can(tab === 'branches' ? 'branch:manage' : 'catalog:manage');
  return (
    <>
      <PageHead title="Programs, courses & branches" sub="The structure every batch hangs from: Organization → Branch → Program → Course → Batch." actions={manage && <button className="btn primary" onClick={() => setEdit('new')}>＋ New {LABEL[tab].toLowerCase()}</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'programs', label: 'Programs' }, { id: 'courses', label: 'Courses' }, { id: 'branches', label: 'Branches' }]} />
      <div className="card">
        <div className="row between" style={{ padding: 12 }}><span className="muted small">{q.data?.length ?? 0} {tab}</span><label className="row gap-s small"><input type="checkbox" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} /> Show archived</label></div>
        {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <SkeletonRows n={4} /> : !q.data.length ? <Empty icon="📚" title={`No ${tab} yet`} action={manage ? <button className="btn primary" onClick={() => setEdit('new')}>Create one</button> : undefined}>{tab === 'courses' ? 'Create a program first, then add courses to it.' : 'Add your first one to get started.'}</Empty> : (
          <div className="table-wrap"><table className="t"><thead><tr><th>Name</th><th>Code</th>{tab === 'courses' && <th>Program</th>}{tab === 'branches' && <th>City</th>}{tab !== 'branches' && <th>Description</th>}<th>Status</th>{manage && <th />}</tr></thead><tbody>
            {q.data.map((r) => <tr key={r.id}><td><b>{r.name}</b></td><td className="mono">{r.code}</td>{tab === 'courses' && <td>{r.program_name}</td>}{tab === 'branches' && <td>{r.city ?? '—'}</td>}{tab !== 'branches' && <td className="muted">{r.description ?? '—'}</td>}<td><StatusBadge s={r.status} /></td>{manage && <td className="right"><button className="btn sm" onClick={() => setEdit(r)}>Edit</button></td>}</tr>)}</tbody></table></div>)}
      </div>
      {edit && <Form kind={tab} row={edit === 'new' ? null : edit} programs={programs.data ?? []} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.reload(); programs.reload(); }} />}
    </>
  );
}

function Form({ kind, row, programs, onClose, onDone }: { kind: Kind; row: any | null; programs: any[]; onClose: () => void; onDone: () => void }) {
  const [v, setV] = useState<any>({ name: row?.name ?? '', code: row?.code ?? '', description: row?.description ?? '', city: row?.city ?? '', address: row?.address ?? '', program_id: row?.program_id ?? '', status: row?.status ?? 'active' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const { busy, run } = useAction();
  const toast = useToast();
  const set = (k: string) => (e: any) => setV({ ...v, [k]: e.target.value });
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setErrs({});
    const base: any = { name: v.name };
    if (kind === 'branches') Object.assign(base, { city: v.city || undefined, address: v.address || undefined }); else base.description = v.description || undefined;
    if (!row) { base.code = v.code; if (kind === 'courses') base.program_id = v.program_id; } else base.status = v.status;
    try { row ? await api.patch(`/api/${kind}/${row.id}`, base) : await api.post(`/api/${kind}`, base); toast(`${LABEL[kind]} saved`); onDone(); }
    catch (err: any) { const fe = fieldErrors(err); setErrs(fe); if (!Object.keys(fe).length) run(() => Promise.reject(err)); }
  }
  return <Modal title={`${row ? 'Edit' : 'New'} ${LABEL[kind].toLowerCase()}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" form="cat-form" disabled={busy || v.name.length < 2 || (!row && !v.code) || (kind === 'courses' && !row && !v.program_id)}>Save</button></>}>
    <form id="cat-form" onSubmit={submit} className="stack" noValidate>
      {kind === 'courses' && !row && <Field label="Program" error={errs.program_id}><select className="select" value={v.program_id} onChange={set('program_id')}><option value="">Choose…</option>{programs.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></Field>}
      <Field label="Name" error={errs.name}><input className="input" value={v.name} onChange={set('name')} autoFocus /></Field>
      {!row && <Field label="Code" error={errs.code} hint="Short and unique, e.g. ROBO. Cannot be changed later."><input className="input" value={v.code} onChange={(e) => setV({ ...v, code: e.target.value.toUpperCase() })} maxLength={20} /></Field>}
      {kind === 'branches' ? <><Field label="City"><input className="input" value={v.city} onChange={set('city')} /></Field><Field label="Address"><input className="input" value={v.address} onChange={set('address')} /></Field></> : <Field label="Description"><textarea className="textarea" value={v.description} onChange={set('description')} /></Field>}
      {row && <Field label="Status"><select className="select" value={v.status} onChange={set('status')}><option value="active">Active</option><option value="inactive">Inactive</option><option value="archived">Archived</option></select></Field>}
    </form></Modal>;
}
