/** Builds the share-card pictures as SVG (rendered to PNG by the route). Every value from a person is escaped before it goes in. */
export const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
export type Glyph = 'star' | 'bolt' | 'check' | 'trophy' | 'scroll';
interface Pal { light: string; mid: string; dark: string; rim1: string; rim2: string }
const PALS: Pal[] = [
  { light: '#ffe58a', mid: '#f5a524', dark: '#b36b00', rim1: '#fff2b8', rim2: '#a8670a' },
  { light: '#7ff0e8', mid: '#0e9aa7', dark: '#06545c', rim1: '#c9fbf6', rim2: '#04464d' },
  { light: '#c9b8ff', mid: '#6c63ff', dark: '#2e2a9c', rim1: '#e6dfff', rim2: '#24217f' },
  { light: '#ffb3c8', mid: '#e8579a', dark: '#8f1b5a', rim1: '#ffd9e6', rim2: '#701547' },
  { light: '#9fd0ff', mid: '#3b6fd4', dark: '#173a85', rim1: '#d3e8ff', rim2: '#102c68' },
  { light: '#a8f0b8', mid: '#2e9e6b', dark: '#116040', rim1: '#d6fbe0', rim2: '#0b4a30' },
];
export const palette = (key: string) => { let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALS[h % PALS.length]!; };

const star = (cx: number, cy: number, r: number) => Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`; }).join(' ');
function glyph(g: Glyph, cx: number, cy: number, s: number, fill: string) {
  const r = s * 0.5;
  switch (g) {
    case 'bolt': return `<polygon points="${cx + r * 0.1},${cy - r} ${cx - r * 0.6},${cy + r * 0.1} ${cx - r * 0.05},${cy + r * 0.1} ${cx - r * 0.2},${cy + r} ${cx + r * 0.6},${cy - r * 0.15} ${cx + r * 0.05},${cy - r * 0.15}" fill="${fill}"/>`;
    case 'check': return `<path d="M ${cx - r * 0.7} ${cy} L ${cx - r * 0.2} ${cy + r * 0.5} L ${cx + r * 0.75} ${cy - r * 0.5}" fill="none" stroke="${fill}" stroke-width="${s * 0.16}" stroke-linecap="round" stroke-linejoin="round"/>`;
    case 'trophy': return `<path d="M ${cx - r * 0.55} ${cy - r * 0.75} H ${cx + r * 0.55} V ${cy - r * 0.1} C ${cx + r * 0.55} ${cy + r * 0.4} ${cx - r * 0.55} ${cy + r * 0.4} ${cx - r * 0.55} ${cy - r * 0.1} Z M ${cx - r * 0.12} ${cy + r * 0.3} H ${cx + r * 0.12} V ${cy + r * 0.62} H ${cx + r * 0.42} V ${cy + r * 0.85} H ${cx - r * 0.42} V ${cy + r * 0.62} H ${cx - r * 0.12} Z" fill="${fill}"/><path d="M ${cx - r * 0.55} ${cy - r * 0.55} H ${cx - r * 0.9} C ${cx - r * 0.9} ${cy + r * 0.1} ${cx - r * 0.7} ${cy + r * 0.1} ${cx - r * 0.5} ${cy + r * 0.05} M ${cx + r * 0.55} ${cy - r * 0.55} H ${cx + r * 0.9} C ${cx + r * 0.9} ${cy + r * 0.1} ${cx + r * 0.7} ${cy + r * 0.1} ${cx + r * 0.5} ${cy + r * 0.05}" fill="none" stroke="${fill}" stroke-width="${s * 0.07}"/>`;
    case 'scroll': return `<rect x="${cx - r * 0.7}" y="${cy - r * 0.55}" width="${r * 1.4}" height="${r * 1.1}" rx="${r * 0.12}" fill="${fill}"/><path d="M ${cx - r * 0.4} ${cy - r * 0.2} H ${cx + r * 0.4} M ${cx - r * 0.4} ${cy + r * 0.05} H ${cx + r * 0.4} M ${cx - r * 0.4} ${cy + r * 0.3} H ${cx + r * 0.1}" stroke="rgba(0,0,0,.35)" stroke-width="${s * 0.05}" stroke-linecap="round"/>`;
    default: return `<polygon points="${star(cx, cy, r)}" fill="${fill}"/>`;
  }
}

/** A medal with a metallic rim, a lit face, a soft highlight, a ribbon and a shadow, so it looks like a 3D object. */
export function badge3d(id: string, cx: number, cy: number, size: number, key: string, g: Glyph, label?: string) {
  const p = palette(key); const r = size / 2; const u = (n: string) => `${n}-${id}`;
  return `<defs>
  <linearGradient id="${u('rim')}" x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stop-color="${p.rim1}"/><stop offset=".5" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.rim2}"/></linearGradient>
  <radialGradient id="${u('face')}" cx="0.35" cy="0.3" r="0.9"><stop offset="0" stop-color="${p.light}"/><stop offset=".55" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/></radialGradient>
  <linearGradient id="${u('rib')}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${p.mid}"/><stop offset="1" stop-color="${p.dark}"/></linearGradient>
  <linearGradient id="${u('shine')}" x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".85"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
  <filter id="${u('blur')}" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${size * 0.035}"/></filter>
  <filter id="${u('drop')}" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="${size * 0.02}" stdDeviation="${size * 0.012}" flood-color="#000" flood-opacity=".45"/></filter></defs>
  <ellipse cx="${cx}" cy="${cy + r * 1.12}" rx="${r * 0.85}" ry="${r * 0.16}" fill="#000" opacity=".5" filter="url(#${u('blur')})"/>
  <polygon points="${cx - r * 0.55},${cy + r * 0.6} ${cx - r * 0.18},${cy + r * 0.85} ${cx - r * 0.5},${cy + r * 1.45} ${cx - r * 0.7},${cy + r * 1.2} ${cx - r * 0.95},${cy + r * 1.3}" fill="url(#${u('rib')})"/>
  <polygon points="${cx + r * 0.55},${cy + r * 0.6} ${cx + r * 0.18},${cy + r * 0.85} ${cx + r * 0.5},${cy + r * 1.45} ${cx + r * 0.7},${cy + r * 1.2} ${cx + r * 0.95},${cy + r * 1.3}" fill="url(#${u('rib')})" opacity=".92"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#${u('rim')})" filter="url(#${u('drop')})"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.9}" fill="${p.dark}" opacity=".55"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.84}" fill="url(#${u('face')})"/>
  <circle cx="${cx}" cy="${cy}" r="${r * 0.84}" fill="none" stroke="#fff" stroke-opacity=".35" stroke-width="${size * 0.008}"/>
  <path d="M ${cx - r * 0.74} ${cy - r * 0.1} A ${r * 0.8} ${r * 0.8} 0 0 1 ${cx + r * 0.2} ${cy - r * 0.78} A ${r * 0.95} ${r * 0.7} 0 0 0 ${cx - r * 0.74} ${cy - r * 0.1} Z" fill="url(#${u('shine')})"/>
  <g filter="url(#${u('drop')})">${glyph(g, cx, cy - (label ? r * 0.08 : 0), r * 0.95, '#ffffff')}</g>
  <ellipse cx="${cx - r * 0.42}" cy="${cy - r * 0.55}" rx="${r * 0.1}" ry="${r * 0.06}" fill="#fff" opacity=".9" transform="rotate(-35 ${cx - r * 0.42} ${cy - r * 0.55})"/>
  ${label ? `<text x="${cx}" y="${cy + r * 0.58}" text-anchor="middle" font-size="${r * 0.3}" font-weight="700" fill="#fff" stroke="rgba(0,0,0,.35)" stroke-width="${r * 0.02}">${esc(label)}</text>` : ''}`;
}

export function wrap(text: string, max: number, maxLines: number): string[] {
  const words = String(text).split(/\s+/).filter(Boolean); const lines: string[] = []; let cur = '';
  for (const w of words) { if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) { const k = lines.slice(0, maxLines); k[maxLines - 1] = k[maxLines - 1]!.replace(/.{0,2}$/, '') + '…'; return k; }
  return lines;
}
const tspans = (lines: string[], x: number, lh: number) => lines.map((l, i) => `<tspan x="${x}" dy="${i ? lh : 0}">${esc(l)}</tspan>`).join('');

export interface Card {
  kind: 'badge' | 'xp' | 'certificate' | 'project'; format: 'story' | 'square'; orgName: string; logoDataUri: string | null; color: string; accent: string;
  who: string; headline: string; title: string; sub?: string; stat?: { big: string; small: string }; bar?: { pct: number; label: string };
  glyph: Glyph; badgeKey: string; badgeLabel?: string; pictureDataUri?: string | null; qrDataUri: string; cta: string; ctaSmall: string; footnote?: string;
}
/** 1080 x 1920 (status/story) or 1080 x 1080 (square). */
export function cardSvg(c: Card): string {
  const W = 1080, H = c.format === 'story' ? 1920 : 1080; const story = c.format === 'story';
  const bgA = c.color, bgB = '#0b1730';
  const top = 70; const logo = c.logoDataUri ? `<image href="${c.logoDataUri}" x="64" y="${top}" width="96" height="96" preserveAspectRatio="xMidYMid meet"/>` : `<rect x="64" y="${top}" width="96" height="96" rx="24" fill="${c.accent}"/><text x="112" y="${top + 70}" text-anchor="middle" font-size="64" font-weight="700" fill="#0b1730">${esc(c.orgName.charAt(0).toUpperCase())}</text>`;
  const dense = !story && !!(c.stat || c.bar); const step = dense ? 62 : 76;
  const badgeSize = c.pictureDataUri ? 0 : story ? 520 : dense ? 220 : 340; const badgeY = story ? 640 : dense ? 372 : 430;
  const picture = c.pictureDataUri ? `<g filter="url(#shadowP)"><clipPath id="clipP"><rect x="90" y="${story ? 300 : 210}" width="900" height="${story ? 700 : 520}" rx="40"/></clipPath><rect x="84" y="${(story ? 300 : 210) - 6}" width="912" height="${(story ? 700 : 520) + 12}" rx="46" fill="${c.accent}"/><image href="${c.pictureDataUri}" x="90" y="${story ? 300 : 210}" width="900" height="${story ? 700 : 520}" preserveAspectRatio="xMidYMid slice" clip-path="url(#clipP)"/></g>` : '';
  const textY = c.pictureDataUri ? (story ? 1090 : 790) : story ? 1120 : dense ? 565 : 790;
  const titleLines = wrap(c.title, story ? 20 : 26, 3); const headLines = wrap(c.headline, 28, 2);
  const stat = c.stat ? `<text x="540" y="${textY + (dense ? 0 : 60) + titleLines.length * step + (dense ? 60 : 0)}" text-anchor="middle" font-size="${story ? 150 : dense ? 88 : 110}" font-weight="700" fill="${c.accent}">${esc(c.stat.big)}</text><text x="540" y="${textY + titleLines.length * step + (dense ? 108 : 130 + (story ? 30 : 0))}" text-anchor="middle" font-size="${dense ? 30 : 34}" fill="#cfd9e8">${esc(c.stat.small)}</text>` : '';
  const barY = textY + titleLines.length * step + (dense ? 144 : story ? 320 : 250);
  const bar = c.bar ? `<rect x="190" y="${barY}" width="700" height="26" rx="13" fill="rgba(255,255,255,.16)"/><rect x="190" y="${barY}" width="${Math.max(26, 700 * c.bar.pct / 100)}" height="26" rx="13" fill="${c.accent}"/><text x="540" y="${barY + (dense ? 58 : 70)}" text-anchor="middle" font-size="30" fill="#cfd9e8">${esc(c.bar.label)}</text>` : '';
  const footY = story ? H - 250 : H - 235;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">
<defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${bgA}"/><stop offset=".6" stop-color="${bgB}"/><stop offset="1" stop-color="#050b1a"/></linearGradient>
<radialGradient id="glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="${c.accent}" stop-opacity=".55"/><stop offset="1" stop-color="${c.accent}" stop-opacity="0"/></radialGradient>
<filter id="shadowP" x="-10%" y="-10%" width="120%" height="125%"><feDropShadow dx="0" dy="24" stdDeviation="22" flood-color="#000" flood-opacity=".5"/></filter></defs>
<rect width="${W}" height="${H}" fill="url(#bg)"/>
<circle cx="900" cy="170" r="420" fill="url(#glow)" opacity=".5"/><circle cx="120" cy="${H - 300}" r="360" fill="url(#glow)" opacity=".28"/>
${Array.from({ length: 14 }, (_, i) => `<circle cx="${(i * 197 + 80) % 1000 + 40}" cy="${(i * 311 + 120) % (H - 400) + 120}" r="${4 + (i % 4) * 3}" fill="#fff" opacity="${0.12 + (i % 3) * 0.08}"/>`).join('')}
${logo}<text x="180" y="${top + 42}" font-size="40" font-weight="700" fill="#fff">${esc(c.orgName)}</text><text x="180" y="${top + 82}" font-size="28" fill="#f5a524" letter-spacing="3">${esc(c.who.toUpperCase())}</text>
<text x="540" y="${story ? 250 : 240}" text-anchor="middle" font-size="${story ? 64 : 54}" font-weight="700" fill="#fff">${tspans(headLines, 540, story ? 76 : 64)}</text>
${picture}${badgeSize ? badge3d('b', 540, badgeY, badgeSize, c.badgeKey, c.glyph, c.badgeLabel) : ''}
<text x="540" y="${textY}" text-anchor="middle" font-size="${story ? 68 : dense ? 52 : 60}" font-weight="700" fill="#fff">${tspans(titleLines, 540, step)}</text>
${c.sub ? `<text x="540" y="${textY + 20 + titleLines.length * step}" text-anchor="middle" font-size="34" fill="#cfd9e8">${esc(c.sub)}</text>` : ''}${stat}${bar}
<rect x="48" y="${footY}" width="984" height="190" rx="36" fill="rgba(255,255,255,.1)" stroke="rgba(255,255,255,.2)"/>
<rect x="76" y="${footY + 24}" width="142" height="142" rx="18" fill="#fff"/><image href="${c.qrDataUri}" x="84" y="${footY + 32}" width="126" height="126"/>
<text x="250" y="${footY + 84}" font-size="44" font-weight="700" fill="#fff">${esc(c.cta)}</text><text x="250" y="${footY + 132}" font-size="30" fill="#cfd9e8">${esc(c.ctaSmall)}</text>
${c.footnote ? `<text x="540" y="${H - 28}" text-anchor="middle" font-size="22" fill="#8da0bd">${esc(c.footnote)}</text>` : ''}
</svg>`;
}
