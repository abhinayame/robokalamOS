import { api } from '../api';
import { FeeLedger } from '../components/Fees';
import { Async, Empty, PageHead, useFetch } from '../components/ui';

/** A learner's or parent's own fees: what is due, Pay now, and every receipt. */
export default function MyFees() {
  const kids = useFetch(() => api.get('/api/fees/me').then((r) => r.data as any[]), []);
  return (
    <>
      <PageHead title="My fees" sub="What is due, what you have paid, and your receipts. Payments are made on a secure Razorpay page." />
      <Async q={kids}>{(list: any[]) => !list.length ? <Empty icon="🧾" title="Nothing to show" /> : (
        <div className="stack">{list.map((l) => <div key={l.learner.id} className="stack">{list.length > 1 && <h2 style={{ margin: '8px 0 0' }}>{l.learner.full_name}</h2>}<FeeLedger learnerId={l.learner.id} learnerName={l.learner.full_name} staff={null} /></div>)}</div>)}</Async>
    </>
  );
}
