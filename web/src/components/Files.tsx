import { useRef, useState } from 'react';
import { api, friendly } from '../api';
import { useToast } from './ui';

export interface FileRef { id: string; name: string; size: number; mime: string }
const kb = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const INLINE = /\.(pdf|png|jpe?g|gif|webp)$/i;

/** Download links for files attached to something. Access is checked by the server on every click. */
export function FileLinks({ files }: { files: FileRef[] }) {
  const toast = useToast();
  if (!files?.length) return null;
  const open = (f: FileRef) => api.openFile(f.id, f.name, INLINE.test(f.name)).catch((e) => toast(friendly(e), 'err'));
  return <div className="chips" style={{ gap: 8 }}>{files.map((f) => (
    <button key={f.id} type="button" className="btn sm" onClick={() => open(f)} title="Open file">📎 {f.name} <span className="muted small">{kb(f.size)}</span></button>
  ))}</div>;
}

/** Pick, upload and list files before the parent form is saved. */
export function FilePicker({ value, onChange, max = 5 }: { value: FileRef[]; onChange: (f: FileRef[]) => void; max?: number }) {
  const ref = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setErr(''); setBusy(true);
    let cur = value;
    for (const f of Array.from(list)) {
      if (cur.length >= max) { setErr(`You can attach up to ${max} file${max === 1 ? '' : 's'}.`); break; }
      try { cur = [...cur, await api.upload(f)]; onChange(cur); } catch (e) { setErr(friendly(e)); }
    }
    setBusy(false);
    if (ref.current) ref.current.value = '';
  };
  return (
    <div>
      <input ref={ref} type="file" hidden multiple={max > 1} onChange={(e) => pick(e.target.files)} />
      <button type="button" className="btn sm" disabled={busy || value.length >= max} onClick={() => ref.current?.click()}>{busy ? 'Uploading…' : '📎 Attach file'}</button>
      {err && <div className="err" role="alert" style={{ marginTop: 6 }}>{err}</div>}
      {value.map((f) => (
        <div key={f.id} className="row small" style={{ marginTop: 6 }}>
          <span className="grow">{f.name} <span className="muted">{kb(f.size)}</span></span>
          <button type="button" className="btn ghost sm" onClick={() => onChange(value.filter((x) => x.id !== f.id))} aria-label={`Remove ${f.name}`}>✕</button>
        </div>
      ))}
    </div>
  );
}
