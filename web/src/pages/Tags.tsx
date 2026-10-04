import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { TAG_COLORS, TagChip } from '../components/Crm';
import { Async, Empty, Field, Modal, PageHead, fieldErrors, useAction, useFetch } from '../components/ui';

export default function Tags() {
  const { can } = useAuth();
  const q = useFetch(() => api.get('/api/tags').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any | 'new' | null>(null);
  const { run } = useAction();
  return (
    <>
      <PageHead title="Tags" sub="Reusable labels for learners: High Performer, Needs Attention, Scholarship …" actions={can('tag:manage') ? <button className="btn primary" onClick={() => setEdit('new')}>＋ New tag</button> : undefined} />
      <Async q={q}>{(rows: any[]) => rows.length ? <div className="card">{rows.map((t) => (
        <div key={t.id} className="m-card" style={{ alignItems: 'center' }}>
          <div className="grow"><TagChip t={t} />{t.description && <div className="muted small">{t.description}</div>}</div>
          <span className="muted small">{t.learners} learner{t.learners === 1 ? '' : 's'}</span>
          {can('tag:manage') && <><button className="btn sm" onClick={() => setEdit(t)}>Edit</button>
            <button className="btn ghost sm danger" onClick={() => confirm(`Delete “${t.name}”? It will be removed from ${t.learners} learner(s).`) && run(async () => { await api.del(`/api/tags/${t.id}`); q.reload(); }, 'Tag deleted')}>Delete</button></>}
        </div>))}</div> : <div className="card"><Empty icon="🏷️" title="No tags yet">{can('tag:manage') ? 'Create your first tag, then apply it from a learner profile or in bulk.' : 'An admin has not created tags yet.'}</Empty></div>}</Async>
      {edit && <TagModal tag={edit === 'new' ? null : edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); q.reload(); }} />}
    </>
  );
}

function TagModal({ tag, onClose, onDone }: { tag: any | null; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [f, setF] = useState({ name: tag?.name ?? '', color: tag?.color ?? 'gray', description: tag?.description ?? '' });
  const [errs, setErrs] = useState<Record<string, string>>({});
  const save = () => { setErrs({}); return run(async () => { try { const b = { ...f, description: f.description || null }; tag ? await api.patch(`/api/tags/${tag.id}`, b) : await api.post('/api/tags', b); onDone(); } catch (e) { setErrs(fieldErrors(e)); throw e; } }, 'Tag saved').catch(() => {}); };
  return (
    <Modal title={tag ? 'Edit tag' : 'New tag'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !f.name.trim()} onClick={save}>Save</button></>}>
      <div className="stack">
        <Field label="Name" error={errs.name}><input className="input" autoFocus maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Colour"><div className="chips">{TAG_COLORS.map((c) => <button key={c} type="button" aria-pressed={f.color === c} aria-label={c} className={`btn sm ${f.color === c ? 'primary' : ''}`} onClick={() => setF({ ...f, color: c })}><TagChip t={{ name: c, color: c }} /></button>)}</div></Field>
        <Field label="Description (optional)"><input className="input" maxLength={200} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <div>Preview: <TagChip t={{ name: f.name || 'Tag name', color: f.color }} /></div>
      </div>
    </Modal>
  );
}
