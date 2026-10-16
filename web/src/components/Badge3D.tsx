import { useId } from 'react';

const PALS = [
  ['#ffe58a', '#f5a524', '#b36b00', '#fff2b8', '#a8670a'], ['#7ff0e8', '#0e9aa7', '#06545c', '#c9fbf6', '#04464d'], ['#c9b8ff', '#6c63ff', '#2e2a9c', '#e6dfff', '#24217f'],
  ['#ffb3c8', '#e8579a', '#8f1b5a', '#ffd9e6', '#701547'], ['#9fd0ff', '#3b6fd4', '#173a85', '#d3e8ff', '#102c68'], ['#a8f0b8', '#2e9e6b', '#116040', '#d6fbe0', '#0b4a30'],
];
const pal = (key: string) => { let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) >>> 0; return PALS[h % PALS.length]!; };
const starPts = (cx: number, cy: number, r: number) => Array.from({ length: 10 }, (_, i) => { const a = -Math.PI / 2 + (i * Math.PI) / 5; const rr = i % 2 ? r * 0.42 : r; return `${(cx + rr * Math.cos(a)).toFixed(1)},${(cy + rr * Math.sin(a)).toFixed(1)}`; }).join(' ');

/** A medal with a metallic rim, a lit face, a highlight and a soft shadow, drawn as SVG so it stays sharp at any size. The color follows the badge name. */
export function Badge3D({ name, size = 72, glyph = 'star', label }: { name: string; size?: number; glyph?: 'star' | 'bolt' | 'check' | 'trophy'; label?: string }) {
  const id = useId().replace(/:/g, ''); const [light, mid, dark, rim1, rim2] = pal(name); const s = 100; const c = 50; const r = 34;
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`${name} badge`} style={{ flex: 'none', overflow: 'visible' }}>
      <defs>
        <linearGradient id={`rim${id}`} x1="0.1" y1="0" x2="0.9" y2="1"><stop offset="0" stopColor={rim1} /><stop offset=".5" stopColor={mid} /><stop offset="1" stopColor={rim2} /></linearGradient>
        <radialGradient id={`face${id}`} cx="0.35" cy="0.3" r="0.9"><stop offset="0" stopColor={light} /><stop offset=".55" stopColor={mid} /><stop offset="1" stopColor={dark} /></radialGradient>
        <linearGradient id={`rib${id}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor={mid} /><stop offset="1" stopColor={dark} /></linearGradient>
        <linearGradient id={`shine${id}`} x1="0" y1="0" x2="0.6" y2="1"><stop offset="0" stopColor="#fff" stopOpacity=".85" /><stop offset="1" stopColor="#fff" stopOpacity="0" /></linearGradient>
        <filter id={`blur${id}`}><feGaussianBlur stdDeviation="2" /></filter>
        <filter id={`drop${id}`} x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.1" floodColor="#000" floodOpacity=".4" /></filter>
      </defs>
      <ellipse cx={c} cy={c + r * 1.18} rx={r * 0.8} ry={r * 0.14} fill="#000" opacity=".4" filter={`url(#blur${id})`} />
      <polygon points={`${c - r * 0.55},${c + r * 0.6} ${c - r * 0.18},${c + r * 0.85} ${c - r * 0.5},${c + r * 1.4} ${c - r * 0.7},${c + r * 1.18} ${c - r * 0.95},${c + r * 1.26}`} fill={`url(#rib${id})`} />
      <polygon points={`${c + r * 0.55},${c + r * 0.6} ${c + r * 0.18},${c + r * 0.85} ${c + r * 0.5},${c + r * 1.4} ${c + r * 0.7},${c + r * 1.18} ${c + r * 0.95},${c + r * 1.26}`} fill={`url(#rib${id})`} opacity=".92" />
      <circle cx={c} cy={c} r={r} fill={`url(#rim${id})`} filter={`url(#drop${id})`} />
      <circle cx={c} cy={c} r={r * 0.9} fill={dark} opacity=".55" />
      <circle cx={c} cy={c} r={r * 0.84} fill={`url(#face${id})`} />
      <circle cx={c} cy={c} r={r * 0.84} fill="none" stroke="#fff" strokeOpacity=".35" strokeWidth=".5" />
      <path d={`M ${c - r * 0.74} ${c - r * 0.1} A ${r * 0.8} ${r * 0.8} 0 0 1 ${c + r * 0.2} ${c - r * 0.78} A ${r * 0.95} ${r * 0.7} 0 0 0 ${c - r * 0.74} ${c - r * 0.1} Z`} fill={`url(#shine${id})`} />
      <g filter={`url(#drop${id})`}>
        {glyph === 'bolt' ? <polygon points={`${c + 2},${c - 16} ${c - 11},${c + 2} ${c - 1},${c + 2} ${c - 4},${c + 17} ${c + 11},${c - 3} ${c + 1},${c - 3}`} fill="#fff" />
          : glyph === 'check' ? <path d={`M ${c - 12} ${c} L ${c - 3} ${c + 9} L ${c + 13} ${c - 9}`} fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          : glyph === 'trophy' ? <path d={`M ${c - 10} ${c - 13} H ${c + 10} V ${c - 2} C ${c + 10} ${c + 7} ${c - 10} ${c + 7} ${c - 10} ${c - 2} Z M ${c - 2} ${c + 5} H ${c + 2} V ${c + 10} H ${c + 8} V ${c + 15} H ${c - 8} V ${c + 10} H ${c - 2} Z`} fill="#fff" />
          : <polygon points={starPts(c, c - (label ? 2 : 0), 17)} fill="#fff" />}
      </g>
      <ellipse cx={c - r * 0.42} cy={c - r * 0.55} rx={r * 0.1} ry={r * 0.06} fill="#fff" opacity=".9" transform={`rotate(-35 ${c - r * 0.42} ${c - r * 0.55})`} />
      {label && <text x={c} y={c + r * 0.58} textAnchor="middle" fontSize={r * 0.3} fontWeight="700" fill="#fff" stroke="rgba(0,0,0,.35)" strokeWidth=".6">{label}</text>}
      <rect width={s} height={s} fill="none" />
    </svg>
  );
}
