import { useState } from 'react';
import { api } from '../api';
import { useAuth } from '../auth';
import { Async, Badge, Empty, Field, Modal, PageHead, Tabs, useAction, useFetch, useToast } from '../components/ui';
import { fmtMoney, fmtNum } from '../format';
import { todayStr } from '../components/Fees';

export default function Payroll() {
  const { can } = useAuth(); const manage = can('payroll:manage');
  const [tab, setTab] = useState<'month' | 'rates'>('month');
  const [month, setMonth] = useState(() => todayStr().slice(0, 7));
  const s = useFetch(() => api.get(`/api/payroll/summary?month=${month}`).then((r) => r.data), [month]);
  const rates = useFetch(() => api.get('/api/payroll/rates').then((r) => r.data as any[]), []);
  const [edit, setEdit] = useState<any>(null);
  return (
    <>
      <PageHead title="Teacher workload and pay" sub="Classes held and hours taught each month, with an estimate of what each teacher is owed. This is an estimate to help the accountant, not a payslip." />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'month', label: 'Monthly summary' }, { id: 'rates', label: 'Pay rates' }]} />
      {tab === 'month' && <>
        <div className="row wrap" style={{ margin: '12px 0' }}><Field label="Month"><input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field><button className="btn" style={{ alignSelf: 'end' }} onClick={() => api.getFile(`/api/payroll/summary.csv?month=${month}`, `teacher-workload-${month}.csv`)}>Download CSV</button></div>
        <Async q={s}>{(d: any) => !d.teachers.length ? <div className="card"><Empty icon="🎓" title="No classes this month">Teachers appear here when their batches had classes.</Empty></div> : (<>
          <div className="summary-grid" style={{ marginBottom: 12 }}><div><b>{fmtNum(d.totals.classes_held)}</b><span>Classes held</span></div><div><b>{d.totals.hours}</b><span>Hours taught</span></div><div className="hl"><b>{fmtMoney(d.totals.estimated_pay)}</b><span>Estimated pay</span></div>{d.totals.without_rate > 0 && <div><b>{d.totals.without_rate}</b><span>Teacher(s) with no rate set</span></div>}</div>
          <div className="card"><div className="table-wrap"><table className="t"><thead><tr><th>Teacher</th><th className="right">Batches</th><th className="right">Held</th><th className="right">Cancelled</th><th className="right">Hours</th><th className="right">Rate / hr</th><th className="right">Estimated pay</th></tr></thead><tbody>
            {d.teachers.map((t: any) => <tr key={t.teacher_id}><td>{t.full_name}{t.classes_not_closed > 0 && <><br /><Badge tone="warn">{t.classes_not_closed} class(es) not closed</Badge></>}{t.missing_end > 0 && <><br /><Badge tone="warn">{t.missing_end} without an end time</Badge></>}</td>
              <td className="right">{t.batches}</td><td className="right">{t.classes_held}</td><td className="right">{t.classes_cancelled}</td><td className="right">{t.hours}</td><td className="right">{t.rate_per_hour == null ? <Badge tone="warn">Not set</Badge> : fmtMoney(t.rate_per_hour)}</td><td className="right"><b>{t.estimated_pay == null ? '—' : fmtMoney(t.estimated_pay)}</b></td></tr>)}
          </tbody></table></div></div>
          <p className="muted small">Only classes marked completed count. A class counts for every teacher on the batch that day, lead or assistant, so set each person's rate with that in mind. Hours come from each class's start and end time ({d.timezone}).</p></>)}</Async></>}
      {tab === 'rates' && <div className="card" style={{ marginTop: 12 }}><Async q={rates}>{(list: any[]) => !list.length ? <Empty icon="🎓" title="No teachers yet" /> : (
        <div className="table-wrap"><table className="t"><thead><tr><th>Teacher</th><th className="right">Rate per hour</th><th /></tr></thead><tbody>
          {list.map((t) => <tr key={t.teacher_id}><td>{t.full_name}<br /><span className="muted small">{t.email}</span></td><td className="right">{t.rate_per_hour == null ? <Badge tone="warn">Not set</Badge> : <>{fmtMoney(t.rate_per_hour)}<br /><span className="muted small">from {String(t.effective_from).slice(0, 10)}</span></>}</td><td className="right">{manage && <button className="btn sm" onClick={() => setEdit(t)}>Set rate</button>}</td></tr>)}
        </tbody></table></div>)}</Async></div>}
      {edit && <RateModal t={edit} onClose={() => setEdit(null)} onDone={() => { rates.reload(); s.reload(); }} />}
    </>
  );
}

function RateModal({ t, onClose, onDone }: { t: any; onClose: () => void; onDone: () => void }) {
  const toast = useToast(); const { busy, run } = useAction();
  const [rate, setRate] = useState(t.rate_per_hour ? String(Number(t.rate_per_hour)) : ''); const [from, setFrom] = useState(`${todayStr().slice(0, 7)}-01`);
  return <Modal title={`Pay rate · ${t.full_name}`} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || rate === ''} onClick={() => run(async () => { await api.put(`/api/payroll/rates/${t.teacher_id}`, { rate_per_hour: Number(rate), effective_from: from }); toast('Rate saved.'); onDone(); onClose(); })}>Save</button></>}>
    <div className="stack"><Field label="Rate per hour (₹)"><input className="input" inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ''))} autoFocus /></Field>
      <Field label="Applies from" hint="A month uses the rate in force on its last day. Older months keep their old rate."><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field></div></Modal>;
}
