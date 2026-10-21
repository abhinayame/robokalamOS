import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api';
import { useBrand } from '../brand';
import { Modal, useToast } from './ui';

type Kind = 'badge' | 'xp' | 'certificate' | 'project';
const CAPTION: Record<Kind, (t: string, org: string) => string> = {
  badge: (t, o) => `I just unlocked the "${t}" badge at ${o}! 🏅`, xp: (_t, o) => `Levelling up at ${o}! ⚡ Come and learn with us.`,
  certificate: (t, o) => `I earned my certificate in ${t} at ${o}! 🎓`, project: (t, o) => `Look what I built at ${o}: ${t}! 🤖`,
};

/** Make a picture of an achievement and share it: straight to a phone's share sheet when the device supports it, or download it for a status or post. */
export function ShareModal({ kind, id, title, onClose }: { kind: Kind; id: string; title: string; onClose: () => void }) {
  const { brand } = useBrand(); const toast = useToast();
  const [format, setFormat] = useState<'story' | 'square'>('story'); const [name, setName] = useState<'first' | 'short'>('first');
  const [url, setUrl] = useState<string | null>(null); const [blob, setBlob] = useState<Blob | null>(null); const [err, setErr] = useState(''); const [busy, setBusy] = useState(true); const last = useRef<string | null>(null);
  useEffect(() => {
    let dead = false; setBusy(true); setErr('');
    fetch(`/api/share/cards/${kind}/${id}.png?format=${format}&name=${name}`, { credentials: 'include' }).then(async (r) => {
      if (!r.ok) { let m = 'Could not make the picture.'; try { m = (await r.json())?.error?.message ?? m; } catch { /* not JSON */ } throw new ApiError(r.status, 'ERR', m); }
      return r.blob();
    }).then((b) => { if (dead) return; if (last.current) URL.revokeObjectURL(last.current); const u = URL.createObjectURL(b); last.current = u; setBlob(b); setUrl(u); }).catch((e) => !dead && setErr(e?.message ?? 'Could not make the picture.')).finally(() => !dead && setBusy(false));
    return () => { dead = true; };
  }, [kind, id, format, name]);
  useEffect(() => () => { if (last.current) URL.revokeObjectURL(last.current); }, []);
  const caption = CAPTION[kind](title, brand.name); const file = blob ? new File([blob], `${brand.name.replace(/\W+/g, '-').toLowerCase()}-${kind}.png`, { type: 'image/png' }) : null;
  const canShare = !!file && typeof navigator !== 'undefined' && !!(navigator as any).canShare?.({ files: [file] });
  return (
    <Modal wide title="Share your achievement" onClose={onClose} footer={<>
      <button className="btn" onClick={onClose}>Close</button>
      {file && <a className="btn" href={url ?? '#'} download={file.name}>⬇ Download image</a>}
      {canShare && <button className="btn primary" onClick={() => (navigator as any).share({ files: [file], text: caption, title: brand.name }).catch(() => undefined)}>Share…</button>}</>}>
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <div style={{ width: format === 'story' ? 220 : 300, flex: 'none' }}>
          {busy && <div className="skeleton" style={{ height: format === 'story' ? 391 : 300, borderRadius: 14 }} />}
          {url && !busy && !err && <img src={url} alt={`Share picture: ${title}`} style={{ width: '100%', borderRadius: 14, boxShadow: '0 10px 30px rgba(0,0,0,.25)' }} />}
          {err && <p className="err" role="alert">{err}</p>}
        </div>
        <div className="stack grow" style={{ minWidth: 220 }}>
          <div><div className="small muted" style={{ marginBottom: 4 }}>Shape</div><div className="row gap-s"><button className={`btn sm ${format === 'story' ? 'primary' : ''}`} onClick={() => setFormat('story')}>Status / story</button><button className={`btn sm ${format === 'square' ? 'primary' : ''}`} onClick={() => setFormat('square')}>Square post</button></div></div>
          <div><div className="small muted" style={{ marginBottom: 4 }}>Name on the picture</div><div className="row gap-s"><button className={`btn sm ${name === 'first' ? 'primary' : ''}`} onClick={() => setName('first')}>First name</button><button className={`btn sm ${name === 'short' ? 'primary' : ''}`} onClick={() => setName('short')}>First name + initial</button></div></div>
          <div><div className="small muted" style={{ marginBottom: 4 }}>Message to go with it</div><textarea className="input" rows={3} readOnly value={caption} onFocus={(e) => e.currentTarget.select()} /></div>
          <div className="row gap-s wrap"><button className="btn sm" onClick={() => { navigator.clipboard?.writeText(caption); toast('Message copied.'); }}>Copy message</button>
            <a className="btn sm" target="_blank" rel="noreferrer noopener" href={`https://wa.me/?text=${encodeURIComponent(caption)}`}>WhatsApp</a></div>
          <p className="muted small" style={{ margin: 0 }}>The picture shows only a first name, never a school, address or phone number. Anyone who scans the code on it can find out how to join.{!canShare && ' On a computer, download the image and post it from your phone.'}</p>
        </div>
      </div>
    </Modal>
  );
}
export const ShareButton = ({ kind, id, title, onOpen }: { kind: Kind; id: string; title: string; onOpen: (s: { kind: Kind; id: string; title: string }) => void }) => <button className="btn sm" onClick={() => onOpen({ kind, id, title })}>📤 Share</button>;
