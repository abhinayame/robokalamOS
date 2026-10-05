import { api } from '../api';
import { Async, Empty, PageHead, useFetch } from '../components/ui';
import { fmtDate } from '../format';
import { Badge } from '../components/ui';

export function CertificateList({ q }: { q: ReturnType<typeof useFetch<any[]>> }) {
  return (
    <Async q={q}>{(list: any[]) => !list.length ? <div className="card"><Empty icon="🎓" title="No certificates yet">Certificates appear here when a course is completed.</Empty></div> : (
      <div className="stack">{list.map((c) => (
        <div className="card card-pad" key={c.id}><div className="row between wrap">
          <div><b style={{ fontSize: 16 }}>{c.title}</b> {c.revoked_at && <Badge tone="bad">Revoked</Badge>}<br /><span className="muted small">{c.recipient_name} · {[c.course_name, c.batch_name].filter(Boolean).join(' · ')} · {fmtDate(c.issued_on)} · code <code>{c.code}</code></span></div>
          <button className="btn primary sm" onClick={() => api.getFile(`/api/certificates/${c.id}/pdf`, `${c.code}.pdf`, true)}>Open PDF</button>
        </div></div>))}</div>)}</Async>
  );
}

export default function MyCertificates() {
  const q = useFetch(() => api.get('/api/certificates/me').then((r) => r.data as any[]), []);
  return <><PageHead title="My certificates" sub="Anyone can check a certificate is real with its code or QR code on the verify page." /><CertificateList q={q} /></>;
}
