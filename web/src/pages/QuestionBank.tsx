import { useState } from 'react';
import { api, qs } from '../api';
import { Async, Badge, Empty, Field, Modal, PageHead, Pager, useAction, useDebounced, useFetch } from '../components/ui';

export default function QuestionBank() {
  const [topic, setTopic] = useState(''); const [diff, setDiff] = useState(''); const [text, setText] = useState(''); const term = useDebounced(text); const [page, setPage] = useState(1); const [edit, setEdit] = useState<any>(null); const { busy, run } = useAction();
  const topics = useFetch(() => api.get('/api/bank/topics').then((r) => r.data as any[]), []);
  const q = useFetch(() => api.get(`/api/bank${qs({ topic, difficulty: diff, q: term, page })}`), [topic, diff, term, page]);
  return (
    <>
      <PageHead title="Question bank" sub="Write a question once and use it in any quiz. A quiz gets its own copy, so changing a question here never changes a quiz people are already taking." actions={<button className="btn primary" onClick={() => setEdit({})}>＋ New question</button>} />
      <div className="card"><div className="row wrap" style={{ padding: 12 }}>
        <select className="select" style={{ width: 200 }} aria-label="Topic" value={topic} onChange={(e) => { setTopic(e.target.value); setPage(1); }}><option value="">All topics</option>{(topics.data ?? []).map((t: any) => <option key={t.topic} value={t.topic}>{t.topic} ({t.questions})</option>)}</select>
        <select className="select" style={{ width: 150 }} aria-label="Difficulty" value={diff} onChange={(e) => { setDiff(e.target.value); setPage(1); }}><option value="">Any level</option><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select>
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search questions" aria-label="Search questions" value={text} onChange={(e) => { setText(e.target.value); setPage(1); }} /></div>
        <Async q={q as any}>{(r: any) => !r.data.length ? <Empty icon="❓" title="No questions yet" action={<button className="btn primary" onClick={() => setEdit({})}>Write the first one</button>} /> : (<>
          {r.data.map((x: any) => (
            <div key={x.id} className="m-card" style={{ alignItems: 'flex-start' }}><div className="grow"><b>{x.q}</b><div className="muted small">{x.options.map((o: string, i: number) => <span key={i}>{i === x.answer ? '✔ ' : ''}{o}{i < x.options.length - 1 ? ' · ' : ''}</span>)}</div></div>
              <Badge>{x.topic}</Badge><Badge tone={x.difficulty === 'hard' ? 'bad' : x.difficulty === 'medium' ? 'warn' : 'ok'}>{x.difficulty}</Badge>
              <button className="btn sm" onClick={() => setEdit(x)}>Edit</button><button className="btn sm" disabled={busy} onClick={() => confirm('Remove this question from the bank? Quizzes that already use it are not affected.') && run(async () => { await api.del(`/api/bank/${x.id}`); q.reload(); topics.reload(); }, 'Removed.')}>Remove</button></div>))}
          <Pager meta={r.meta} onPage={setPage} /></>)}</Async></div>
      {edit && <QModal q={edit} onClose={() => setEdit(null)} onDone={() => { q.reload(); topics.reload(); }} />}
    </>
  );
}

function QModal({ q, onClose, onDone }: { q: any; onClose: () => void; onDone: () => void }) {
  const { busy, run } = useAction(); const [err, setErr] = useState(''); const [f, setF] = useState({ topic: q.topic ?? '', difficulty: q.difficulty ?? 'medium', q: q.q ?? '', options: (q.options as string[]) ?? ['', ''], answer: q.answer ?? 0 });
  const ready = f.topic.trim().length >= 2 && f.q.trim().length >= 2 && f.options.filter((o) => o.trim()).length >= 2 && f.options[f.answer]?.trim();
  return (
    <Modal title={q.id ? 'Edit question' : 'New question'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ready} onClick={() => run(async () => { setErr(''); const opts = f.options.map((o) => o.trim()); const keep = opts.map((o, i) => [o, i] as const).filter(([o]) => o); const body = { ...f, options: keep.map(([o]) => o), answer: keep.findIndex(([, i]) => i === f.answer) };
      try { if (q.id) await api.put(`/api/bank/${q.id}`, body); else await api.post('/api/bank', body); onDone(); onClose(); } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; } }, 'Saved.')}>Save</button></>}>
      <div className="stack">
        <div className="row wrap"><Field label="Topic" className="grow"><input className="input" value={f.topic} onChange={(e) => setF({ ...f, topic: e.target.value })} placeholder="e.g. Sensors" /></Field>
          <Field label="Level"><select className="select" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}><option value="easy">Easy</option><option value="medium">Medium</option><option value="hard">Hard</option></select></Field></div>
        <Field label="Question"><textarea className="input" rows={2} value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} /></Field>
        {f.options.map((o, i) => <div key={i} className="row"><input type="radio" name="ans" checked={f.answer === i} onChange={() => setF({ ...f, answer: i })} aria-label={`Option ${i + 1} is correct`} /><input className="input grow" placeholder={`Option ${i + 1}`} value={o} onChange={(e) => setF({ ...f, options: f.options.map((x, j) => (j === i ? e.target.value : x)) })} /></div>)}
        {f.options.length < 6 && <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setF({ ...f, options: [...f.options, ''] })}>＋ Option</button>}
        <div className="muted small">Tick the circle next to the right answer.</div>{err && <p className="err" role="alert">{err}</p>}
      </div>
    </Modal>
  );
}
