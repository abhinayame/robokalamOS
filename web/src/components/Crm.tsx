import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { cap } from '../format';
import { useAction, useFetch } from './ui';

export const LEAD_STATUSES = ['new', 'contacted', 'interested', 'demo_scheduled', 'demo_attended', 'follow_up', 'converted', 'not_interested', 'lost'] as const;
export const ACTIVITY_TYPES = ['called_parent', 'called_learner', 'whatsapp_sent', 'email_sent', 'demo_scheduled', 'demo_attended', 'follow_up', 'fee_discussion', 'admission_confirmed', 'batch_assigned', 'counsellor_assigned', 'status_changed', 'note', 'other'] as const;
export const statusLabel = (s: string) => cap(s.replace(/_/g, ' '));
export const statusTone = (s: string) => (s === 'converted' ? 'ok' : s === 'lost' || s === 'not_interested' ? 'bad' : s === 'new' ? '' : s === 'follow_up' ? 'warn' : 'info');
export const TEMPERATURE = { cold: '🧊 Cold', warm: '🌤 Warm', hot: '🔥 Hot' } as const;

const COLORS: Record<string, { bg: string; fg: string }> = {
  gray: { bg: '#eceff3', fg: '#3b4452' }, red: { bg: '#fde4e1', fg: '#9b2c22' }, orange: { bg: '#ffe9d2', fg: '#8a4b0b' }, yellow: { bg: '#fff3c4', fg: '#7a5b00' },
  green: { bg: '#d9f2e4', fg: '#146c43' }, teal: { bg: '#d3f0ee', fg: '#0f6560' }, blue: { bg: '#dbe9ff', fg: '#1d4f9c' }, purple: { bg: '#eadcff', fg: '#5b2ea6' }, pink: { bg: '#ffdcec', fg: '#9c1f5b' },
};
export const TAG_COLORS = Object.keys(COLORS);
export const TagChip = ({ t, onRemove }: { t: { name: string; color?: string }; onRemove?: () => void }) => {
  const c = COLORS[t.color ?? 'gray'] ?? COLORS.gray;
  return <span className="badge" style={{ background: c.bg, color: c.fg }}>{t.name}{onRemove && <button type="button" onClick={onRemove} aria-label={`Remove tag ${t.name}`} style={{ border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer', marginLeft: 4, padding: 0 }}>×</button>}</span>;
};

/** Single-tag filter dropdown. */
export function TagPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const q = useFetch(() => api.get('/api/tags').then((r) => r.data as any[]), []);
  return <select className="select" value={value} aria-label="Tag" onChange={(e) => onChange(e.target.value)}><option value="">Any</option>{(q.data ?? []).map((t: any) => <option key={t.id} value={t.id}>{t.name} ({t.learners})</option>)}</select>;
}

/** Tags on one learner: chips with ✕ and an add menu (tag:apply), refreshed after each change. */
export function TagEditor({ learnerId, tags, onChange }: { learnerId: string; tags: { id: string; name: string; color?: string }[]; onChange: () => void }) {
  const { can } = useAuth();
  const all = useFetch(() => api.get('/api/tags').then((r) => r.data as any[]), []);
  const { busy, run } = useAction();
  const [adding, setAdding] = useState(false);
  const apply = (body: object) => run(async () => { await api.post('/api/tags/apply', { learner_ids: [learnerId], ...body }); setAdding(false); onChange(); });
  const free = (all.data ?? []).filter((t: any) => !tags.some((x) => x.id === t.id));
  return (
    <div className="chips" style={{ alignItems: 'center' }}>
      {tags.map((t) => <TagChip key={t.id} t={t} onRemove={can('tag:apply') ? () => apply({ remove: [t.id] }) : undefined} />)}
      {!tags.length && <span className="muted small">No tags</span>}
      {can('tag:apply') && (adding
        ? <select className="select" style={{ width: 170 }} autoFocus disabled={busy} aria-label="Add tag" onChange={(e) => e.target.value && apply({ add: [e.target.value] })} onBlur={() => setAdding(false)} defaultValue=""><option value="">Choose a tag…</option>{free.map((t: any) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        : <button className="btn ghost sm" onClick={() => setAdding(true)} disabled={!free.length && !!all.data} title={!free.length && all.data ? 'No more tags to add. Create tags under Settings.' : ''}>＋ Tag</button>)}
    </div>
  );
}
