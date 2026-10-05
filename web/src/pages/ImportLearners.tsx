import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Badge, Empty, PageHead, Progress, Tabs, useAction, useToast } from '../components/ui';
import { cap, fmtNum } from '../format';

/** Upload a CSV: check every row first, then import. Duplicates are never created; existing learners are skipped or topped up. */
export default function ImportLearners() {
  const [job, setJob] = useState<any>(null); const [status, setStatus] = useState<any>(null);
  const [dup, setDup] = useState<'skip' | 'merge'>('skip'); const [fileName, setFileName] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const { busy, run } = useAction(); const toast = useToast();
  const [view, setView] = useState<'problems' | 'sample'>('problems');

  const pick = (file?: File) => file && run(async () => {
    if (file.size > 4 * 1024 * 1024) throw new Error('That file is larger than 4 MB. Split it into several files.');
    setFileName(file.name); setStatus(null);
    setJob((await api.postText(`/api/import/learners/preview?file_name=${encodeURIComponent(file.name)}`, await file.text())).data);
  });
  const reset = () => { setJob(null); setStatus(null); setFileName(''); if (input.current) input.current.value = ''; };
  const go = () => run(async () => {
    await api.post(`/api/import/${job.id}/confirm`, { confirm: true, on_duplicate: dup, expected_valid: job.counts.valid });
    setStatus({ status: 'running', counts: job.counts, progress_pct: 0 });
  });

  useEffect(() => {
    if (status?.status !== 'running') return;
    const t = setInterval(async () => { try { const s = (await api.get(`/api/import/${job.id}`)).data; setStatus(s); if (s.status !== 'running') { clearInterval(t); toast(s.status === 'completed' ? 'Import finished.' : 'Import stopped.'); } } catch { /* keep polling */ } }, 1200);
    return () => clearInterval(t);
  }, [status?.status, job?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const c = job?.counts;
  return (
    <>
      <PageHead title="Import learners" sub="Bring an existing list in from a spreadsheet. We check every row before anything is saved, and never create the same learner twice."
        actions={<><button className="btn" onClick={() => run(() => api.getFile('/api/import/learners/template.csv', 'learners-import-template.csv'))}>Download template</button><Link className="btn" to="/learners">Back to learners</Link></>} />
      {!job && (
        <div className="card card-pad stack">
          <ol className="stack-s" style={{ margin: 0, paddingLeft: 20 }}>
            <li>Download the template and fill one learner per row (only <b>full_name</b> and a <b>mobile or email</b> are required).</li>
            <li>Put batch codes (or exact batch names) in <b>batches</b>, separated by <code>|</code>. Add the parent’s name and mobile to link a parent; siblings sharing a parent mobile share one parent.</li>
            <li>Save as <b>CSV</b> and upload it here. You will see every problem before anything is imported.</li>
          </ol>
          <div className="drop" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); pick(e.dataTransfer.files[0]); }} style={{ border: '2px dashed var(--line)', borderRadius: 12, padding: 28, textAlign: 'center' }}>
            <p style={{ margin: '0 0 10px' }}>Drop a .csv file here, or</p>
            <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => pick(e.target.files?.[0])} aria-label="Choose CSV file" />
            <button className="btn primary" disabled={busy} onClick={() => input.current?.click()}>{busy ? 'Checking…' : 'Choose a file'}</button>
            <p className="muted small" style={{ margin: '10px 0 0' }}>Up to 5,000 rows per file.</p>
          </div>
        </div>)}

      {job && !status && (
        <div className="stack">
          <div className="card card-pad stack">
            <div className="row between wrap"><b>{fileName || job.file_name}</b><button className="btn sm" onClick={reset}>Choose another file</button></div>
            <div className="summary-grid">
              <div><b>{fmtNum(job.total_rows)}</b><span>Rows in the file</span></div>
              <div className="hl"><b>{fmtNum(c.valid)}</b><span>New learners ready</span></div>
              <div><b>{fmtNum(c.duplicate)}</b><span>Duplicates</span></div>
              <div><b className={c.error ? 'err' : ''}>{fmtNum(c.error)}</b><span>Rows with problems</span></div>
            </div>
            {job.unknown_columns?.length > 0 && <p className="muted small" style={{ margin: 0 }}>Ignored columns: {job.unknown_columns.join(', ')}.</p>}
            {job.warnings.map((w: string, i: number) => <p key={i} className="err small" style={{ margin: 0 }}>⚠ {w}</p>)}
            {c.duplicate > 0 && (
              <fieldset className="stack-s" style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12 }}>
                <legend className="small"><b>{c.duplicate} duplicate row(s)</b>{job.existing_duplicates ? ` (${job.existing_duplicates} already in the system)` : ''}: what should happen?</legend>
                <label className="row gap-s"><input type="radio" checked={dup === 'skip'} onChange={() => setDup('skip')} /> Skip them (recommended)</label>
                <label className="row gap-s"><input type="radio" checked={dup === 'merge'} onChange={() => setDup('merge')} /> Add what is missing to the existing learner (new batches, a parent). Their profile is never overwritten.</label>
              </fieldset>)}
            <div className="row wrap">
              <button className="btn primary" disabled={busy || (!c.valid && !(dup === 'merge' && job.existing_duplicates))} onClick={go}>{busy ? 'Starting…' : `Import ${fmtNum(c.valid)} new learner(s)${dup === 'merge' && job.existing_duplicates ? ` + update ${job.existing_duplicates}` : ''}`}</button>
              {(c.error > 0 || c.duplicate > 0) && <button className="btn" onClick={() => run(() => api.getFile(`/api/import/${job.id}/problems.csv`, 'import-problems.csv'))}>Download problem rows</button>}
            </div>
          </div>
          <Tabs value={view} onChange={setView} tabs={[{ id: 'problems', label: 'Problems', badge: c.error + c.duplicate }, { id: 'sample', label: 'Preview of new learners' }]} />
          <div className="card">
            {view === 'problems' ? (!job.problems.length ? <Empty icon="✅" title="No problems found" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Row</th><th>Name</th><th>Mobile</th><th>What to fix</th></tr></thead><tbody>
              {job.problems.map((p: any) => <tr key={p.row_no}><td>{p.row_no}</td><td>{p.raw.full_name || '—'}</td><td>{p.raw.mobile || '—'}</td><td>{p.status === 'duplicate' ? <Badge tone="warn">Duplicate</Badge> : <Badge tone="bad">Fix</Badge>} {p.message}</td></tr>)}
            </tbody></table>{c.error + c.duplicate > job.problems.length && <p className="muted small card-pad">Showing the first {job.problems.length}. Download the problem rows for the full list.</p>}</div>)
              : (!job.sample.length ? <Empty icon="📄" title="No new learners in this file" /> : <div className="table-wrap"><table className="t"><thead><tr><th>Row</th><th>Learner</th><th>Mobile</th><th>Batches</th><th>Parent</th></tr></thead><tbody>
                {job.sample.map((s: any) => <tr key={s.row_no}><td>{s.row_no}</td><td>{s.full_name}</td><td>{s.mobile ?? '—'}</td><td>{s.batch_labels?.join(', ') || '—'}</td><td>{s.parent?.full_name ?? '—'}</td></tr>)}
              </tbody></table></div>)}
          </div>
        </div>)}

      {job && status && (
        <div className="card card-pad stack">
          <div className="row between wrap"><b>{status.status === 'running' ? 'Importing…' : status.status === 'completed' ? 'Import finished' : 'Import stopped'}</b>{status.status === 'running' && <button className="btn sm" onClick={() => run(async () => { await api.post(`/api/import/${job.id}/cancel`); })}>Stop</button>}</div>
          <Progress value={status.status === 'running' ? status.progress_pct ?? 0 : 100} tone={status.status === 'completed' ? 'ok' : ''} />
          <div className="summary-grid">
            <div className="hl"><b>{fmtNum(status.counts.created)}</b><span>Created</span></div><div><b>{fmtNum(status.counts.merged)}</b><span>Existing updated</span></div><div><b>{fmtNum(status.counts.skipped)}</b><span>Skipped</span></div><div><b className={status.counts.failed ? 'err' : ''}>{fmtNum(status.counts.failed)}</b><span>Failed</span></div>
          </div>
          {status.status !== 'running' && (
            <div className="row wrap">
              <Link className="btn primary" to="/learners">View learners</Link>
              {(status.counts.failed + status.counts.skipped + status.counts.error + status.counts.duplicate) > 0 && <button className="btn" onClick={() => run(() => api.getFile(`/api/import/${job.id}/problems.csv`, 'import-problems.csv'))}>Download rows that were not imported</button>}
              <button className="btn" onClick={reset}>Import another file</button>
            </div>)}
          {status.status !== 'running' && status.counts.failed > 0 && <p className="muted small" style={{ margin: 0 }}>{cap('failed')} rows were rolled back as a whole (no half-created learners). The problem file says why each one failed (for example a full batch); fix those rows and upload only them.</p>}
        </div>)}
    </>
  );
}
