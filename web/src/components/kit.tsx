import type { ReactNode } from 'react';
import { Icon, IconTile, type Hue } from './Icon';

/** Gradient welcome banner: greeting, one line of context, and quick-action chips. Uses the school's colours. */
export function HeroBanner({ title, sub, kicker, actions, art = 'sparkle', children }: { title: ReactNode; sub?: ReactNode; kicker?: ReactNode; actions?: ReactNode; art?: string; children?: ReactNode }) {
  return (
    <section className="hero" aria-label="Welcome">
      <div className="hero-copy">{kicker && <span className="hero-kicker">{kicker}</span>}<h1>{title}</h1>{sub && <p>{sub}</p>}{actions && <div className="hero-actions">{actions}</div>}</div>
      <div className="hero-art" aria-hidden><i className="blob b1" /><i className="blob b2" /><span className="hero-orb"><Icon name={art} size={54} /></span></div>
      {children}
    </section>
  );
}

/** A circular progress meter that draws itself in. */
export function ProgressRing({ value, size = 84, stroke = 9, label, sub }: { value: number; size?: number; stroke?: number; label?: ReactNode; sub?: ReactNode }) {
  const v = Math.min(100, Math.max(0, value)); const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={`${Math.round(v)} percent`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="color-mix(in srgb, var(--brand) 12%, #fff)" strokeWidth={stroke} />
        <circle className="ring-arc" cx={size / 2} cy={size / 2} r={r} fill="none" stroke="url(#ringg)" strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ ['--c' as any]: c }} />
        <defs><linearGradient id="ringg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="var(--brand)" /><stop offset="1" stopColor="var(--accent)" /></linearGradient></defs>
      </svg>
      <div className="ring-in"><b>{label ?? `${Math.round(v)}%`}</b>{sub && <span>{sub}</span>}</div>
    </div>
  );
}

export function StreakChip({ days, label = 'day streak' }: { days: number; label?: string }) {
  return <span className="streak"><Icon name="flame" size={16} /><b>{days}</b> {label}</span>;
}

/** Small rounded label. `hue` picks the pastel. */
export function Pill({ children, hue = 'violet', icon }: { children: ReactNode; hue?: Hue; icon?: string }) {
  return <span className={`pill it-${hue}`}>{icon && <Icon name={icon} size={13} />}{children}</span>;
}

/** Tiny trend line for stat tiles. */
export function Sparkline({ points, width = 84, height = 28 }: { points: number[]; width?: number; height?: number }) {
  if (points.length < 2) return null;
  const max = Math.max(...points), min = Math.min(...points), span = max - min || 1;
  const xy = points.map((p, i) => [(i / (points.length - 1)) * (width - 4) + 2, height - 3 - ((p - min) / span) * (height - 6)]);
  const d = xy.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  return <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden><path d={`${d} L${width - 2} ${height} L2 ${height} Z`} fill="currentColor" opacity=".12" /><path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

/** Big tappable category tile (icon on a pastel square + name), used for quick entry points. */
export function CategoryTile({ icon, hue = 'violet', label, to }: { icon: string; hue?: Hue; label: string; to: string }) {
  return <a className="cat-tile" href={to}><IconTile name={icon} hue={hue} size="lg" /><span>{label}</span></a>;
}

export { Icon, IconTile };
