import { useState } from 'react';
import { api } from '../api';
import { Async, Field, PageHead, useFetch } from '../components/ui';
import { PortfolioGrid, ReviewQueue } from '../components/Portfolio';

export function MyPortfolio() {
  const kids = useFetch(() => api.get('/api/progress/me').then((r) => r.data as any[]), []); const [kid, setKid] = useState('');
  return (
    <>
      <PageHead title="My projects" sub="Things built in class and at home. A teacher checks each new project before your family can see it." />
      <Async q={kids}>{(list: any[]) => { const id = kid || list[0]?.id; return !id ? null : <div className="stack">
        {list.length > 1 && <Field label="Child"><select className="select" value={id} onChange={(e) => setKid(e.target.value)}>{list.map((k) => <option key={k.id} value={k.id}>{k.full_name}</option>)}</select></Field>}
        <PortfolioGrid learnerId={id} /></div>; }}</Async>
    </>
  );
}
export function PortfolioReview() {
  return <><PageHead title="Portfolio review" sub="Check new projects before they appear to parents. Approve, or send back with a reason." /><ReviewQueue /></>;
}
