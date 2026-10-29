import { Fragment, type ReactNode } from 'react';

/**
 * A small, safe Markdown renderer for lesson text: headings, bold, italic, code, lists, quotes, links and paragraphs.
 * It builds React elements (never raw HTML), and only https links are made clickable.
 */
const inline = (text: string, key: string): ReactNode[] => {
  const out: ReactNode[] = []; const re = /(\*\*([^*]+)\*\*|\*([^*]+)\*|`([^`]+)`|\[([^\]]+)\]\((https:\/\/[^\s)]+)\))/g; let last = 0; let m: RegExpExecArray | null; let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[2]) out.push(<strong key={`${key}b${i}`}>{m[2]}</strong>); else if (m[3]) out.push(<em key={`${key}i${i}`}>{m[3]}</em>); else if (m[4]) out.push(<code key={`${key}c${i}`}>{m[4]}</code>);
    else out.push(<a key={`${key}a${i}`} href={m[6]} target="_blank" rel="noreferrer noopener">{m[5]}</a>);
    last = m.index + m[0].length; i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
};

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n'); const blocks: ReactNode[] = []; let i = 0; let k = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) { const L = h[1]!.length; const Tag = (`h${L + 1}`) as 'h2' | 'h3' | 'h4'; blocks.push(<Tag key={k++} style={{ margin: '14px 0 6px' }}>{inline(h[2]!, `h${k}`)}</Tag>); i++; continue; }
    if (/^\s*[-*]\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*[-*]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*[-*]\s+/, '')); blocks.push(<ul key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `u${k}${j}`)}</li>)}</ul>); continue; }
    if (/^\s*\d+[.)]\s+/.test(line)) { const items: string[] = []; while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i]!)) items.push(lines[i++]!.replace(/^\s*\d+[.)]\s+/, '')); blocks.push(<ol key={k++}>{items.map((t, j) => <li key={j}>{inline(t, `o${k}${j}`)}</li>)}</ol>); continue; }
    if (/^>\s?/.test(line)) { const q: string[] = []; while (i < lines.length && /^>\s?/.test(lines[i]!)) q.push(lines[i++]!.replace(/^>\s?/, '')); blocks.push(<blockquote key={k++} style={{ margin: '8px 0', paddingLeft: 12, borderLeft: '3px solid var(--line, #cbd5e1)', color: 'var(--muted, #64748b)' }}>{inline(q.join(' '), `q${k}`)}</blockquote>); continue; }
    const para: string[] = []; while (i < lines.length && lines[i]!.trim() && !/^(#{1,3}\s|\s*[-*]\s|\s*\d+[.)]\s|>)/.test(lines[i]!)) para.push(lines[i++]!);
    blocks.push(<p key={k++} style={{ margin: '8px 0', lineHeight: 1.6 }}>{para.map((t, j) => <Fragment key={j}>{j > 0 && <br />}{inline(t, `p${k}${j}`)}</Fragment>)}</p>);
  }
  return <div className="markdown">{blocks}</div>;
}

/** A video link as an embedded player when it is YouTube or Vimeo, otherwise a plain button. */
export function embedUrl(url: string): string | null {
  try {
    const u = new URL(url); const h = u.hostname.replace(/^www\./, '');
    if (h === 'youtu.be') return `https://www.youtube-nocookie.com/embed/${u.pathname.slice(1)}`;
    if (h === 'youtube.com' || h === 'm.youtube.com') { const id = u.searchParams.get('v') ?? (u.pathname.startsWith('/embed/') ? u.pathname.slice(7) : null); return id ? `https://www.youtube-nocookie.com/embed/${id}` : null; }
    if (h === 'vimeo.com' && /^\/\d+/.test(u.pathname)) return `https://player.vimeo.com/video/${u.pathname.split('/')[1]}`;
  } catch { /* not a URL */ }
  return null;
}
export function VideoEmbed({ url, title }: { url: string; title: string }) {
  const src = embedUrl(url);
  return src ? (
    <div style={{ position: 'relative', paddingTop: '56.25%', borderRadius: 12, overflow: 'hidden', background: '#000' }}>
      <iframe src={src} title={title} loading="lazy" allow="accelerometer; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin" style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', border: 0 }} />
    </div>
  ) : <a className="btn" href={url} target="_blank" rel="noreferrer noopener">▶ Watch the video</a>;
}
