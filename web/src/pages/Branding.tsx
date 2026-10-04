import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { useBrand } from '../brand';
import { Async, Field, PageHead, useAction, useFetch, useToast } from '../components/ui';

const PRESETS = ['#12263f', '#7a1f3d', '#0b6e4f', '#1d4f9c', '#5b2ea6', '#9c2a2a', '#0f6560', '#37474f'];
const ACCENTS = ['#f5a524', '#ffc107', '#26c6da', '#66bb6a', '#ef5350', '#ab47bc', '#ff7043', '#90a4ae'];
const lum = (hex: string) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!; };
const ratio = (a: string, b: string) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x! + 0.05) / (y! + 0.05); };
const HEX = /^#[0-9a-fA-F]{6}$/;

/** Logo, name, colors and domain: how this organization looks on the sign-in page, in the app and when installed. */
export default function Branding() {
  const q = useFetch(() => api.get('/api/branding/settings').then((r) => r.data), []);
  const { refresh } = useBrand();
  return (
    <>
      <PageHead title="Branding" sub="Make the app look like your school: your logo, name and colors appear on the sign-in page, in the menu and on learners’ phones when they install the app." />
      <Async q={q}>{(s: any) => <Form s={s} onSaved={() => { q.reload(); refresh(); }} />}</Async>
    </>
  );
}

function Form({ s, onSaved }: { s: any; onSaved: () => void }) {
  const toast = useToast(); const { busy, run } = useAction();
  const file = useRef<HTMLInputElement>(null);
  const [f, setF] = useState({ app_name: s.app_name ?? '', tagline: s.tagline ?? '', color: s.color ?? s.defaults.color, accent: s.accent ?? s.defaults.accent, custom_domain: s.custom_domain ?? '', support_email: s.support_email ?? '', support_phone: s.support_phone ?? '' });
  const [err, setErr] = useState<Record<string, string>>({});
  useEffect(() => setErr({}), [f]);
  const colorOk = HEX.test(f.color) && ratio(f.color, '#ffffff') >= 4.5;
  const save = () => run(async () => {
    try {
      await api.put('/api/branding/settings', { app_name: f.app_name, tagline: f.tagline, color: f.color, accent: f.accent, custom_domain: f.custom_domain, support_email: f.support_email, support_phone: f.support_phone });
      toast('Branding saved.'); onSaved();
    } catch (e) { if (e instanceof ApiError && Array.isArray(e.details)) setErr(Object.fromEntries(e.details.map((d: any) => [d.field, d.message]))); throw e; }
  });
  const pick = (x?: File) => x && run(async () => {
    if (x.size > 1024 * 1024) throw new Error('That file is larger than 1 MB.');
    await api.upload2('/api/branding/logo', x); toast('Logo updated.'); onSaved();
  });
  const name = f.app_name || s.name;
  return (
    <div className="grid cols-2">
      <div className="card card-pad stack">
        <Field label="App name" hint={`Shown in the menu and on the phone's home screen. Leave empty to use “${s.name}”.`} error={err.app_name}><input className="input" value={f.app_name} maxLength={40} onChange={(e) => setF({ ...f, app_name: e.target.value })} placeholder={s.name} /></Field>
        <Field label="Tagline" error={err.tagline}><input className="input" value={f.tagline} maxLength={160} onChange={(e) => setF({ ...f, tagline: e.target.value })} placeholder="Learn. Build. Grow." /></Field>
        <Field label="Main color" hint="Menu and buttons. White text sits on it, so it must be dark enough to read." error={err.color || (!colorOk && HEX.test(f.color) ? 'Too light: white text would be hard to read.' : undefined)}>
          <div className="row wrap gap-s">{PRESETS.map((c) => <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Use ${c}`} aria-pressed={f.color === c} onClick={() => setF({ ...f, color: c })} />)}
            <input className="input" style={{ width: 110 }} value={f.color} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label="Main color code" /><input type="color" value={HEX.test(f.color) ? f.color : '#12263f'} onChange={(e) => setF({ ...f, color: e.target.value })} aria-label="Pick main color" /></div></Field>
        <Field label="Accent color" hint="Highlights and the active menu marker." error={err.accent}>
          <div className="row wrap gap-s">{ACCENTS.map((c) => <button key={c} type="button" className="swatch" style={{ background: c }} aria-label={`Use ${c}`} aria-pressed={f.accent === c} onClick={() => setF({ ...f, accent: c })} />)}
            <input className="input" style={{ width: 110 }} value={f.accent} onChange={(e) => setF({ ...f, accent: e.target.value })} aria-label="Accent color code" /><input type="color" value={HEX.test(f.accent) ? f.accent : '#f5a524'} onChange={(e) => setF({ ...f, accent: e.target.value })} aria-label="Pick accent color" /></div></Field>
        <div className="row wrap"><Field label="Support e-mail" error={err.support_email}><input className="input" type="email" value={f.support_email} onChange={(e) => setF({ ...f, support_email: e.target.value })} /></Field><Field label="Support phone" error={err.support_phone}><input className="input" value={f.support_phone} onChange={(e) => setF({ ...f, support_phone: e.target.value })} /></Field></div>
        <Field label="Your own web address (optional)" hint="For example learn.myschool.in. Point the domain at this app in your hosting panel first; the app then shows your branding on the sign-in page of that address." error={err.custom_domain}><input className="input" value={f.custom_domain} onChange={(e) => setF({ ...f, custom_domain: e.target.value })} placeholder="learn.myschool.in" /></Field>
        <div><button className="btn primary" disabled={busy || !colorOk || !HEX.test(f.accent)} onClick={save}>{busy ? 'Saving…' : 'Save branding'}</button></div>
      </div>
      <div className="stack">
        <div className="card card-pad stack">
          <b>Logo</b>
          <div className="row gap-s">{s.logo_url ? <img src={s.logo_url} alt="Current logo" width={72} height={72} style={{ borderRadius: 12, border: '1px solid var(--line)' }} /> : <div className="brand-mark" style={{ width: 72, height: 72, fontSize: 30, background: f.accent, color: f.color }}>{name.slice(0, 1).toUpperCase()}</div>}
            <div className="stack-s"><input ref={file} type="file" accept="image/png" hidden onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} aria-label="Choose logo" />
              <button className="btn" disabled={busy} onClick={() => file.current?.click()}>{s.logo_url ? 'Replace logo' : 'Upload logo'}</button>
              {s.logo_url && <button className="btn ghost sm" disabled={busy} onClick={() => run(async () => { await api.del('/api/branding/logo'); toast('Logo removed.'); onSaved(); })}>Remove</button>}</div></div>
          <p className="muted small" style={{ margin: 0 }}>A <b>square PNG</b>, 512 to 2048 pixels, up to 1 MB. It is also the icon learners get when they install the app on their phone.</p>
        </div>
        <div className="card card-pad stack"><b>Preview</b>
          <div className="brand-preview"><div className="bp-side" style={{ background: f.color }}><div className="row gap-s">{s.logo_url ? <img src={s.logo_url} alt="" width={30} height={30} style={{ borderRadius: 8 }} /> : <div className="brand-mark" style={{ width: 30, height: 30, background: f.accent, color: f.color }}>{name.slice(0, 1).toUpperCase()}</div>}<b style={{ fontSize: 13 }}>{name}</b></div>
            <div style={{ marginTop: 14, borderLeft: `3px solid ${f.accent}`, padding: '6px 8px', background: 'rgba(255,255,255,.1)', borderRadius: 6, fontSize: 12 }}>Dashboard</div><div style={{ marginTop: 6, padding: '6px 8px', fontSize: 12, opacity: 0.8 }}>Classroom</div></div>
            <div className="bp-main"><b>{name}</b><p className="muted small" style={{ margin: '2px 0 10px' }}>{f.tagline || s.defaults.tagline}</p><span className="btn sm" style={{ background: f.color, color: '#fff', borderColor: f.color }}>Sign in</span></div></div>
        </div>
      </div>
    </div>
  );
}
