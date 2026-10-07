import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ReportView, monthBefore } from '../components/Progress';
import { Async, Field, PageHead, useFetch } from '../components/ui';

/** A learner's or parent's monthly progress report. */
export default function MyReport() {
  const [params] = useSearchParams(); const kids = useFetch(() => api.get('/api/progress/me').then((r) => r.data as any[]), []);
  const [month, setMonth] = useState(params.get('month') ?? monthBefore()); const [kid, setKid] = useState(params.get('learner') ?? '');
  return (
    <>
      <PageHead title="Progress report" sub="How the month went: attendance, scores, badges and your teachers' notes." />
      <Async q={kids}>{(list: any[]) => { const id = kid || list[0]?.id; return !id ? null : (
        <div className="stack">
          <div className="row wrap">
            {list.length > 1 && <Field label="Child"><select className="select" value={id} onChange={(e) => setKid(e.target.value)}>{list.map((k) => <option key={k.id} value={k.id}>{k.full_name}</option>)}</select></Field>}
            <Field label="Month"><input className="input" type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} /></Field>
          </div>
          <ReportView learnerId={id} month={month} />
        </div>); }}</Async>
    </>
  );
}
