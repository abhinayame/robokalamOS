import { useState } from 'react';
import { api } from '../api';
import { BankPicker } from '../pages/Courses';
import { FilePicker, type FileRef } from './Files';
import { Field, Modal, useAction, useToast } from './ui';

const KINDS: { id: string; label: string; note: string }[] = [
  { id: 'text', label: '📄 Reading', note: 'Write the lesson here. Headings, lists and links are supported.' }, { id: 'video', label: '▶️ Video', note: 'A YouTube or Vimeo link plays right inside the lesson.' },
  { id: 'file', label: '📎 Download', note: 'A worksheet, slides or PDF people can open.' }, { id: 'quiz', label: '❓ Quiz', note: 'Questions are graded for you. Answers stay hidden from learners.' },
  { id: 'assignment', label: '✍️ Assignment', note: 'People hand in text or a file; you review it.' }, { id: 'link', label: '🔗 Web link', note: 'Send people to a page or tool.' },
];
export interface Q { q: string; options: string[]; answer: number; explanation?: string | null }
const blank = { title: '', kind: 'text', body: '', url: '', minutes: '', required: true, pass_percent: 70, questions: [] as Q[], module_id: '', max_attempts: '', shuffle: false, show_answers: true, auto_accept: true };

/** The one place to write any kind of lesson. Everything is saved with Save lesson; file lessons upload first, then attach. */
export function LessonEditor({ courseId, modules, lesson, defaultModule, onClose, onSaved }: { courseId: string; modules: { id: string; title: string }[]; lesson?: any; defaultModule?: string | null; onClose: () => void; onSaved: () => void }) {
  const { busy, run } = useAction(); const toast = useToast(); const [err, setErr] = useState(''); const [pick, setPick] = useState(false);
  const [f, setF] = useState<any>(lesson ? { ...blank, ...lesson, body: lesson.body ?? '', url: lesson.url ?? '', minutes: lesson.minutes ?? '', module_id: lesson.module_id ?? '', max_attempts: lesson.max_attempts ?? '', questions: lesson.questions ?? [] } : { ...blank, module_id: defaultModule ?? '' });
  const [files, setFiles] = useState<FileRef[]>(lesson?.files ?? []); const set = (p: object) => setF({ ...f, ...p });
  const kind = KINDS.find((k) => k.id === f.kind)!;
  const ready = f.title.trim().length >= 2 && (f.kind !== 'text' || f.body.trim()) && (f.kind !== 'assignment' || f.body.trim()) && (!['video', 'link'].includes(f.kind) || f.url.trim()) && (f.kind !== 'quiz' || (f.questions.length && f.questions.every((q: Q) => q.q.trim() && q.options.filter((o) => o.trim()).length >= 2 && q.options[q.answer]?.trim())));
  const save = () => run(async () => {
    setErr('');
    const questions = f.kind === 'quiz' ? f.questions.map((q: Q) => { const keep = q.options.map((o, i) => [o.trim(), i] as const).filter(([o]) => o); return { q: q.q.trim(), options: keep.map(([o]) => o), answer: keep.findIndex(([, i]) => i === q.answer), explanation: q.explanation?.trim() || null }; }) : null;
    const body = { title: f.title.trim(), kind: f.kind, body: f.body.trim() || null, url: f.url.trim() || null, minutes: f.minutes ? Number(f.minutes) : null, required: f.required, pass_percent: Number(f.pass_percent), questions,
      module_id: f.module_id || null, max_attempts: f.max_attempts ? Number(f.max_attempts) : null, shuffle: !!f.shuffle, show_answers: !!f.show_answers, auto_accept: !!f.auto_accept };
    try {
      const id = lesson?.id ?? (await api.post(`/api/lms/courses/${courseId}/lessons`, body)).data.id; if (lesson?.id) await api.put(`/api/lms/lessons/${id}`, body);
      if (f.kind === 'file' || files.length) await api.put(`/api/lms/lessons/${id}/files`, { file_ids: f.kind === 'file' ? files.map((x) => x.id) : [] });
      toast('Lesson saved.'); onSaved(); onClose();
    } catch (e: any) { setErr(e?.message ?? 'Could not save.'); throw e; }
  });
  const setQ = (i: number, p: Partial<Q>) => set({ questions: f.questions.map((q: Q, j: number) => (j === i ? { ...q, ...p } : q)) });
  return (
    <Modal wide title={lesson ? `Edit lesson · ${lesson.title}` : 'Add a lesson'} onClose={onClose} footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" disabled={busy || !ready} onClick={save}>{busy ? 'Saving…' : 'Save lesson'}</button></>}>
      <div className="stack">
        <div className="chips" role="radiogroup" aria-label="Lesson type">{KINDS.map((k) => <button key={k.id} type="button" role="radio" aria-checked={f.kind === k.id} className={`btn sm ${f.kind === k.id ? 'primary' : ''}`} onClick={() => set({ kind: k.id })}>{k.label}</button>)}</div>
        <div className="muted small" style={{ marginTop: -4 }}>{kind.note}</div>
        <div className="row wrap"><Field label="Lesson name" className="grow"><input className="input" value={f.title} onChange={(e) => set({ title: e.target.value })} autoFocus /></Field>
          <Field label="Minutes (optional)"><input className="input" type="number" min={1} max={600} style={{ width: 110 }} value={f.minutes} onChange={(e) => set({ minutes: e.target.value })} /></Field></div>
        {(f.kind === 'text' || f.kind === 'assignment' || f.kind === 'video' || f.kind === 'link' || f.kind === 'file') && <Field label={f.kind === 'assignment' ? 'Instructions' : f.kind === 'text' ? 'Lesson text' : 'Notes (optional)'} hint="Tip: # Heading, **bold**, - list item, [link](https://…)"><textarea className="input" rows={f.kind === 'text' ? 10 : 4} value={f.body} onChange={(e) => set({ body: e.target.value })} /></Field>}
        {(f.kind === 'video' || f.kind === 'link') && <Field label={f.kind === 'video' ? 'Video link (YouTube, Vimeo or any https link)' : 'Link (https://…)'}><input className="input" value={f.url} onChange={(e) => set({ url: e.target.value })} placeholder="https://" /></Field>}
        {f.kind === 'file' && <Field label="Files to download" hint="Up to 5 files (PDF, images, Word, PowerPoint, Excel)."><FilePicker value={files} onChange={setFiles} max={5} /></Field>}
        {f.kind === 'assignment' && <label className="row gap-s"><input type="checkbox" checked={f.auto_accept} onChange={(e) => set({ auto_accept: e.target.checked })} /> Count a submission as done straight away (untick to review each one yourself)</label>}
        {f.kind === 'quiz' && <>
          <div className="row wrap"><Field label="Pass mark (%)"><input className="input" type="number" min={1} max={100} style={{ width: 100 }} value={f.pass_percent} onChange={(e) => set({ pass_percent: e.target.value })} /></Field>
            <Field label="Attempts allowed" hint="Empty = unlimited"><input className="input" type="number" min={1} max={20} style={{ width: 110 }} value={f.max_attempts} onChange={(e) => set({ max_attempts: e.target.value })} /></Field></div>
          <div className="row wrap gap-s"><label className="row gap-s"><input type="checkbox" checked={f.shuffle} onChange={(e) => set({ shuffle: e.target.checked })} /> Shuffle questions and options</label>
            <label className="row gap-s"><input type="checkbox" checked={f.show_answers} onChange={(e) => set({ show_answers: e.target.checked })} /> Show the right answers (with your explanations) after passing or using all attempts</label></div>
          {f.questions.map((q: Q, i: number) => (
            <div key={i} className="card card-pad stack-s"><div className="row"><input className="input grow" placeholder={`Question ${i + 1}`} value={q.q} onChange={(e) => setQ(i, { q: e.target.value })} /><button type="button" className="btn ghost sm" onClick={() => set({ questions: f.questions.filter((_: Q, j: number) => j !== i) })}>Remove</button></div>
              {q.options.map((o, j) => <div key={j} className="row"><input type="radio" name={`ans${i}`} checked={q.answer === j} onChange={() => setQ(i, { answer: j })} aria-label={`Option ${j + 1} is correct`} /><input className="input grow" placeholder={`Option ${j + 1}`} value={o} onChange={(e) => setQ(i, { options: q.options.map((x, k) => (k === j ? e.target.value : x)) })} /></div>)}
              {q.options.length < 6 && <button type="button" className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => setQ(i, { options: [...q.options, ''] })}>＋ Option</button>}
              <input className="input" placeholder="Why is it right? (shown after the quiz, optional)" value={q.explanation ?? ''} onChange={(e) => setQ(i, { explanation: e.target.value })} />
              <div className="muted small">Tick the circle next to the right answer. Learners never see which one it is until the quiz allows it.</div></div>))}
          <div className="row gap-s wrap"><button type="button" className="btn sm" onClick={() => set({ questions: [...f.questions, { q: '', options: ['', ''], answer: 0, explanation: '' }] })}>＋ Add a question</button><button type="button" className="btn sm" onClick={() => setPick(true)}>📚 Add from question bank</button></div></>}
        <div className="row wrap"><Field label="Module"><select className="select" value={f.module_id} onChange={(e) => set({ module_id: e.target.value })}><option value="">No module</option>{modules.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}</select></Field>
          <label className="row gap-s" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}><input type="checkbox" checked={f.required} onChange={(e) => set({ required: e.target.checked })} /> Required to finish the course</label></div>
        {err && <p className="err" role="alert">{err}</p>}
      </div>
      {pick && <BankPicker onClose={() => setPick(false)} onAdd={(qs2) => { set({ questions: [...f.questions, ...qs2.map((x: any) => ({ ...x, explanation: x.explanation ?? '' }))] }); setPick(false); }} />}
    </Modal>
  );
}
