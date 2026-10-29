import { useState } from 'react';
import { api, qs } from '../api';
import { Badge, useDebounced, useFetch } from './ui';

export interface StaffPick { all: boolean; roles: string[]; ids: string[] }
export const noStaff: StaffPick = { all: false, roles: [], ids: [] };
export const hasStaff = (p: StaffPick) => p.all || p.roles.length > 0 || p.ids.length > 0;
/** The three ways to say who: everyone, a whole role, or named people. Sent to the assign endpoints as all_staff, roles and user_ids. */
export const staffBody = (p: StaffPick) => ({ all_staff: p.all, roles: p.roles, user_ids: p.ids });
const ROLE: Record<string, string> = { org_admin: 'Admins', branch_admin: 'Branch admins', teacher: 'Teachers', counsellor: 'Counsellors', accountant: 'Accountants' };

export function StaffPicker({ value, onChange }: { value: StaffPick; onChange: (p: StaffPick) => void }) {
  const [text, setText] = useState(''); const term = useDebounced(text);
  const q = useFetch(() => api.get(`/api/lms/people${qs({ q: term })}`), [term]); const counts: Record<string, number> = (q.data as any)?.meta?.role_counts ?? {}; const people: any[] = (q.data as any)?.data ?? [];
  const toggleRole = (r: string) => onChange({ ...value, roles: value.roles.includes(r) ? value.roles.filter((x) => x !== r) : [...value.roles, r] });
  const toggleId = (id: string) => onChange({ ...value, ids: value.ids.includes(id) ? value.ids.filter((x) => x !== id) : [...value.ids, id] });
  return (
    <div className="card card-pad stack" aria-label="Choose staff">
      <b>Staff and team members</b>
      <label className="row gap-s"><input type="checkbox" checked={value.all} onChange={(e) => onChange({ ...value, all: e.target.checked })} /> Everyone on the team (all active staff)</label>
      {!value.all && <>
        <div><div className="muted small" style={{ marginBottom: 4 }}>Everyone with a role</div><div className="chips">{Object.keys(ROLE).map((r) => <button key={r} type="button" aria-pressed={value.roles.includes(r)} className={`btn sm ${value.roles.includes(r) ? 'primary' : ''}`} onClick={() => toggleRole(r)}>{ROLE[r]}{counts[r] != null ? ` (${counts[r]})` : ''}</button>)}</div></div>
        <div><div className="muted small" style={{ marginBottom: 4 }}>Or pick people</div>
          <input className="input" placeholder="Search by name or e-mail" aria-label="Search staff" value={text} onChange={(e) => setText(e.target.value)} style={{ maxWidth: 320 }} />
          <div style={{ maxHeight: 190, overflowY: 'auto', marginTop: 6 }}>{people.map((p) => (
            <label key={p.id} className="m-card" style={{ cursor: 'pointer' }}><input type="checkbox" checked={value.ids.includes(p.id)} onChange={() => toggleId(p.id)} /><span className="grow">{p.full_name}<span className="muted small"> · {p.email}</span></span>{p.roles.map((r: string) => <Badge key={r}>{ROLE[r] ?? r}</Badge>)}</label>))}
            {!people.length && <div className="muted small" style={{ padding: 8 }}>No one found.</div>}</div></div></>}
      {hasStaff(value) && <div className="muted small">{value.all ? 'Everyone on the team' : [value.roles.length ? `${value.roles.map((r) => ROLE[r]).join(', ')}` : '', value.ids.length ? `${value.ids.length} chosen ${value.ids.length === 1 ? 'person' : 'people'}` : ''].filter(Boolean).join(' + ')} will get this. Anyone who already has it is skipped.</div>}
    </div>
  );
}
