import { useMemo } from 'react';

const COLORS = ['#f5a524', '#12263f', '#0e8f6e', '#e8579a', '#3b6fd4', '#6c63ff', '#ffd27a'];
/** A short burst of confetti behind a celebration. Pure CSS (see premium.css); it stays out of the way and is off for reduced motion. */
export function Confetti({ count = 46 }: { count?: number }) {
  const bits = useMemo(() => Array.from({ length: count }, (_, i) => ({ left: (i * 37 + (i % 7) * 11) % 100, delay: (i % 12) * 0.07, dur: 1.6 + (i % 5) * 0.28, size: 6 + (i % 4) * 3, color: COLORS[i % COLORS.length]!, drift: ((i * 53) % 90) - 45, spin: (i % 2 ? 1 : -1) * (180 + (i % 5) * 90), round: i % 3 === 0 })), [count]);
  return (
    <div className="confetti" aria-hidden>{bits.map((b, i) => <i key={i} style={{ left: `${b.left}%`, width: b.size, height: b.round ? b.size : b.size * 0.5, background: b.color, borderRadius: b.round ? '50%' : 2, animationDelay: `${b.delay}s`, animationDuration: `${b.dur}s`, ['--drift' as any]: `${b.drift}px`, ['--spin' as any]: `${b.spin}deg` }} />)}</div>
  );
}
