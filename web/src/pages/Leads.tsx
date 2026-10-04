import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, qs } from '../api';
import { useAuth } from '../auth';
import { fmtDateTime, fmtMobile, fmtNum } from '../format';
import { LEAD_STATUSES, TEMPERATURE, TagChip, TagPicker, statusLabel, statusTone } from '../components/Crm';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, Stat, fieldErrors, useAction, useDebounced, useFetch } from '../components/ui';

export default function Leads() {
  const { can } = useAuth();
  const [f, setF] = useState({ status: '', counsellor_id: '', temperature: '', source: '', q: '', tag_id: '', follow_up: '', sort: 'follow_up' });
  const [page, setPage] = useState(1);
  const [add, setAdd] = useState(false);
  const dq = useDebounced(f.q);
  const key = JSON.stringify({ ...f, q: dq });
  useEffect(() => setPage(1), [key]);
  const q = useFetch(() => api.get(`/api/crm/leads${qs({ ...f, q: dq, page })}`), [key, page]);
  const sum = useFetch(() => api.get('/api/crm/summary').then((r) => r.data), []);
  const counsellors = useFetch(() => api.get('/api/crm/counsellors').then((r) => r.data as any[]), []);
  const counts: Record<string, number> = q.data?.meta?.status_counts ?? {};
  const totalCount = Object.values(counts).reduce((a, b) => a + b, 0);
  return (
    <>
      <PageHead title="Leads" sub="A lead is a learner profile in the CRM: converting never copies data." actions={can('crm:manage') ? <button className="btn primary" onClick={() => setAdd(true)}>＋ Add lead</button> : undefined} />
      <Async q={sum} rows={1}>{(s: any) => (
        <div className="grid cols-4" style={{ marginBottom: 14 }}>
          <Stat label="Leads" value={fmtNum(s.total)} sub={`${s.converted} converted`} />
          <Stat label="Conversion" value={s.conversion_rate == null ? '—' : `${s.conversion_rate}%`} />
          <Stat label="Follow-ups overdue" value={s.follow_ups.overdue} sub={`${s.follow_ups.today} due today`} />
          <Stat label="My follow-ups" value={s.follow_ups.mine_open} sub={<Link to="/crm/follow-ups">{s.follow_ups.mine_overdue} overdue</Link>} />
        </div>)}</Async>
      <div className="card">
        <div className="tabs" role="tablist" aria-label="Pipeline stage" style={{ padding: '0 8px', marginBottom: 0 }}>
          <button role="tab" aria-selected={!f.status} className={`tab ${!f.status ? 'active' : ''}`} onClick={() => setF({ ...f, status: '' })}>All <Badge>{totalCount}</Badge></button>
          {LEAD_STATUSES.map((s) => <button key={s} role="tab" aria-selected={f.status === s} className={`tab ${f.status === s ? 'active' : ''}`} onClick={() => setF({ ...f, status: s })}>{statusLabel(s)} <Badge>{counts[s] ?? 0}</Badge></button>)}
        </div>
        <div className="row wrap" style={{ padding: 12 }}>
          <input className="input grow" style={{ minWidth: 180 }} placeholder="Search name, mobile, parent…" aria-label="Search leads" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
          <select className="select" style={{ width: 170 }} aria-label="Counsellor" value={f.counsellor_id} onChange={(e) => setF({ ...f, counsellor_id: e.target.value })}><option value="">Any counsellor</option><option value="me">Mine</option><option value="none">Unassigned</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select>
          <select className="select" style={{ width: 140 }} aria-label="Temperature" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })}><option value="">Any temperature</option>{Object.entries(TEMPERATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <select className="select" style={{ width: 150 }} aria-label="Follow-up" value={f.follow_up} onChange={(e) => setF({ ...f, follow_up: e.target.value })}><option value="">Any follow-up</option><option value="overdue">Overdue</option><option value="today">Due today</option><option value="week">Next 7 days</option><option value="none">None scheduled</option></select>
          <div style={{ width: 160 }}><TagPicker value={f.tag_id} onChange={(v) => setF({ ...f, tag_id: v })} /></div>
          <select className="select" style={{ width: 150 }} aria-label="Sort" value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })}><option value="follow_up">Next follow-up</option><option value="newest">Newest</option><option value="updated">Recently updated</option><option value="name">Name</option></select>
        </div>
        <Async q={q as any}>{(d: any) => d.data.length ? <>
          <div className="table-wrap hide-m"><table className="t"><thead><tr><th>Learner</th><th>Stage</th><th>Interest</th><th>Counsellor</th><th>Next follow-up</th><th>Tags</th></tr></thead>
            <tbody>{d.data.map((l: any) => (
              <tr key={l.learner_id}>
                <td><Link to={`/learners/${l.learner_id}`}><b>{l.full_name}</b></Link><div className="muted small">{fmtMobile(l.mobile)}{l.parent_name ? ` · ${l.parent_name}` : ''}</div></td>
                <td><Badge tone={statusTone(l.lead_status)}>{statusLabel(l.lead_status)}</Badge> {l.temperature && <span title={l.temperature}>{TEMPERATURE[l.temperature as keyof typeof TEMPERATURE].split(' ')[0]}</span>}</td>
                <td>{l.interested_course ?? l.interested_program ?? '—'}<div className="muted small">{l.lead_source ?? ''}</div></td>
                <td>{l.counsellor_name ?? <span className="muted">Unassigned</span>}</td>
                <td>{l.next_follow_up_at ? <span style={{ color: l.overdue ? 'var(--bad)' : undefined, fontWeight: l.overdue ? 700 : 400 }}>{l.overdue ? 'Overdue · ' : ''}{fmtDateTime(l.next_follow_up_at)}</span> : <span className="muted">—</span>}</td>
                <td><div className="chips">{l.tags.map((t: any) => <TagChip key={t.id} t={t} />)}</div></td>
              </tr>))}</tbody></table></div>
          <div className="cards-m">{d.data.map((l: any) => (
            <Link key={l.learner_id} to={`/learners/${l.learner_id}`} className="m-card" style={{ color: 'inherit', display: 'block' }}>
              <div className="row between"><b>{l.full_name}</b><Badge tone={statusTone(l.lead_status)}>{statusLabel(l.lead_status)}</Badge></div>
              <div className="muted small">{fmtMobile(l.mobile)} · {l.counsellor_name ?? 'Unassigned'}</div>
              {l.next_follow_up_at && <div className="small" style={{ color: l.overdue ? 'var(--bad)' : undefined }}>{l.overdue ? 'Overdue · ' : 'Follow-up '}{fmtDateTime(l.next_follow_up_at)}</div>}
            </Link>))}</div>
          <Pager meta={d.meta} onPage={setPage} />
        </> : <Empty icon="🎯" title={totalCount || f.q || f.status ? 'No leads match' : 'No leads yet'}>{can('crm:manage') ? 'Add a lead, or open any learner and add them to the CRM.' : 'Leads appear here once counsellors add them.'}</Empty>}</Async>
      </div>
      {add && <AddLeadModal onClose={() => setAdd(false)} onDone={() => { setAdd(false); q.reload(); sum.reload(); }} />}
    </>
  );
}

/** New learner + lead in one go, or pick an existing learner. A duplicate is offered, never silently created. */
function AddLeadModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction();
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [f, setF] = useState({ full_name: '', mobile: '', email: '', parent_name: '', parent_mobile: '', lead_source: '', temperature: '', counsellor: '', course: '', notes: '' });
  const [search, setSearch] = useState(''); const ds = useDebounced(search);
  const [pick, setPick] = useState<any>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [dup, setDup] = useState<any>(null);
  const found = useFetch(() => (mode === 'existing' && ds.length >= 2 ? api.get(`/api/learners${qs({ q: ds, page_size: 8 })}`).then((r) => r.data as any[]) : Promise.resolve([] as any[])), [mode, ds]);
  const counsellors = useFetch(() => api.get('/api/crm/counsellors').then((r) => r.data as any[]), []);
  const courses = useFetch(() => api.get('/api/courses').then((r) => r.data as any[]), []);
  const leadBody = (learner_id: string) => ({ learner_id, lead_source: f.lead_source || null, temperature: f.temperature || null, counsellor_user_id: f.counsellor || null, interested_course_id: f.course || null, notes: f.notes || null });
  const save = async () => {
    setErrs({}); setDup(null);
    await run(async () => {
      try {
        let id = pick?.id as string | undefined;
        if (mode === 'new') {
          const body: any = { full_name: f.full_name, mobile: f.mobile || null, email: f.email || null };
          if (f.parent_name) body.parent = { full_name: f.parent_name, mobile: f.parent_mobile || null, relationship: 'guardian' };
          id = (await api.post('/api/learners', body)).data.id;
        }
        await api.post('/api/crm/leads', leadBody(id!)); onDone();
      } catch (e: any) { setErrs(fieldErrors(e)); if (e.code === 'DUPLICATE_LEARNER') setDup(e.details); throw e; }
    }, 'Lead added').catch(() => {});
  };
  const canSave = mode === 'new' ? f.full_name.trim().length >= 2 : !!pick;
  return (
    <Modal wide title="Add lead" onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !canSave} onClick={save}>{busy ? 'Saving…' : 'Add lead'}</button></>}>
      <div className="stack">
        <div className="row"><button className={`btn sm ${mode === 'new' ? 'primary' : ''}`} onClick={() => setMode('new')}>New person</button><button className={`btn sm ${mode === 'existing' ? 'primary' : ''}`} onClick={() => setMode('existing')}>Existing learner</button></div>
        {mode === 'new' ? <div className="form-grid">
          <Field label="Learner name" error={errs.full_name} className="full"><input className="input" autoFocus value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
          <Field label="Mobile" error={errs.mobile}><input className="input" value={f.mobile} onChange={(e) => setF({ ...f, mobile: e.target.value })} /></Field>
          <Field label="Email" error={errs.email}><input className="input" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Parent name"><input className="input" value={f.parent_name} onChange={(e) => setF({ ...f, parent_name: e.target.value })} /></Field>
          <Field label="Parent mobile"><input className="input" value={f.parent_mobile} onChange={(e) => setF({ ...f, parent_mobile: e.target.value })} /></Field>
        </div> : <div className="stack">
          <Field label="Find a learner"><input className="input" autoFocus placeholder="Name, ID, mobile…" value={search} onChange={(e) => { setSearch(e.target.value); setPick(null); }} /></Field>
          {(found.data ?? []).map((l: any) => <button key={l.id} className={`btn ${pick?.id === l.id ? 'primary' : ''}`} style={{ justifyContent: 'space-between' }} onClick={() => setPick(l)}><span>{l.full_name}</span><span className="muted small">{l.learner_code}{l.lead ? ' · already a lead' : ''}</span></button>)}
        </div>}
        {dup && <div className="banner"><div><b>This looks like an existing learner.</b> {(dup.matches ?? dup ?? []).map?.((m: any) => m.full_name ?? m.learner_code).join(', ')}<br />Switch to “Existing learner” and pick them instead of creating a duplicate.</div></div>}
        <div className="form-grid">
          <Field label="Source"><input className="input" list="lead-src" placeholder="Instagram, Walk-in, Referral…" value={f.lead_source} onChange={(e) => setF({ ...f, lead_source: e.target.value })} /><datalist id="lead-src">{['Instagram', 'Facebook', 'Google', 'Walk-in', 'Referral', 'School visit', 'Event', 'WhatsApp'].map((s) => <option key={s} value={s} />)}</datalist></Field>
          <Field label="Temperature"><select className="select" value={f.temperature} onChange={(e) => setF({ ...f, temperature: e.target.value })}><option value="">Not set</option>{Object.entries(TEMPERATURE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></Field>
          <Field label="Counsellor"><select className="select" value={f.counsellor} onChange={(e) => setF({ ...f, counsellor: e.target.value })}><option value="">Unassigned</option>{(counsellors.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.full_name}</option>)}</select></Field>
          <Field label="Interested course"><select className="select" value={f.course} onChange={(e) => setF({ ...f, course: e.target.value })}><option value="">Not sure yet</option>{(courses.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
          <Field label="Notes" className="full"><textarea className="textarea" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        </div>
      </div>
    </Modal>
  );
}
