import type { CSSProperties, ReactNode } from 'react';

/**
 * The app's one icon set: duotone line icons on a 24-px grid. `s` strokes the outline, `f` is a soft tinted shape behind it
 * (drawn in the icon's colour at low opacity), so icons look friendly and consistent in every theme and device.
 */
type Def = { s: string[]; f?: string[]; c?: [number, number, number][] };
const D: Record<string, Def> = {
  home: { f: ['M4 11l8-7 8 7v8a1 1 0 0 1-1 1h-4v-6h-6v6H5a1 1 0 0 1-1-1z'], s: ['M3 12l9-8 9 8', 'M5 10.5V20h14v-9.5', 'M10 20v-5h4v5'] },
  grid: { f: ['M4 4h7v7H4zM13 13h7v7h-7z'], s: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z'] },
  users: { f: ['M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20z'], s: ['M3 20v-1.5A4.5 4.5 0 0 1 7.5 14h3a4.5 4.5 0 0 1 4.5 4.5V20', 'M16 4.3a3.5 3.5 0 0 1 0 6.4', 'M18 14.4a4.5 4.5 0 0 1 3 4.1V20'], c: [[9, 8, 3.5]] },
  user: { f: ['M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1z'], s: ['M5 20v-1a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v1'], c: [[12, 8, 4]] },
  family: { f: ['M4 21v-3a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v3z'], s: ['M4 21v-3a4 4 0 0 1 4-4h2a4 4 0 0 1 4 4v3', 'M16 21v-2a3 3 0 0 1 3-3h0a3 3 0 0 1 2 .8'], c: [[9, 8, 3.2], [18, 11.5, 2.2]] },
  inbox: { f: ['M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'], s: ['M3 13l3-8h12l3 8v6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M3 13h5l1 3h6l1-3h5'] },
  layers: { f: ['M12 3l9 5-9 5-9-5z'], s: ['M12 3l9 5-9 5-9-5z', 'M3 12.5l9 5 9-5', 'M3 16.5l9 5 9-5'] },
  dot: { f: [], s: [], c: [[12, 12, 4.5]] },
  'dot-half': { f: ['M12 7.5a4.5 4.5 0 0 0 0 9z'], s: [], c: [[12, 12, 5]] },
  ring: { f: [], s: [], c: [[12, 12, 5]] },
  chat: { f: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H6a2 2 0 0 1-2-2z'], s: ['M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-7l-5 4v-4H6a2 2 0 0 1-2-2z', 'M8 9h8', 'M8 12.5h5'] },
  school: { f: ['M5 10h14v10H5z'], s: ['M2.5 9.5L12 4l9.5 5.5', 'M5 10v10h14V10', 'M9 20v-5h6v5', 'M12 4V2'] },
  clipboard: { f: ['M6 5h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z'], s: ['M6 5h12a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z', 'M9 3h6v4H9z', 'M8.5 12.5l2 2 4-4'] },
  medal: { f: [], s: ['M8 3l4 6 4-6', 'M9 3h-1M16 3h-1'], c: [[12, 15, 5.5]] },
  trophy: { f: ['M7 4h10v5a5 5 0 0 1-10 0z'], s: ['M7 4h10v5a5 5 0 0 1-10 0z', 'M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11', 'M17 6h3v1.5A3.5 3.5 0 0 1 16.5 11', 'M12 14v4', 'M8 21h8', 'M9.5 18h5'] },
  bars: { f: ['M5 13h3v7H5zM10.5 8h3v12h-3zM16 4h3v16h-3z'], s: ['M5 13h3v7H5z', 'M10.5 8h3v12h-3z', 'M16 4h3v16h-3z'] },
  trending: { f: [], s: ['M3 17l6-6 4 4 8-8', 'M15 7h6v6'] },
  portfolio: { f: ['M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z'], s: ['M4 7h16v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1z', 'M9 7V5h6v2', 'M4 12h16'] },
  book: { f: ['M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2z'], s: ['M12 6c-2-1.5-5-2-8-2v14c3 0 6 .5 8 2', 'M12 6c2-1.5 5-2 8-2v14c-3 0-6 .5-8 2', 'M12 6v14'] },
  search: { f: [], s: ['M16.5 16.5L21 21'], c: [[11, 11, 6.5]] },
  calendar: { f: ['M4 6h16v14H4z'], s: ['M4 6h16v14H4z', 'M4 10.5h16', 'M8 3v4', 'M16 3v4'] },
  certificate: { f: ['M3 5h18v11H3z'], s: ['M3 5h18v11H3z', 'M7 9h10', 'M7 12h5', 'M16 16l1.5 5 2-1.5 2 1.5', 'M17.5 21l-1-5'], c: [[17, 13, 0.1]] },
  help: { f: [], s: ['M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7', 'M12 17.2v.1'], c: [[12, 12, 9]] },
  library: { f: ['M4 5h4v15H4zM10 5h4v15h-4z'], s: ['M4 5h4v15H4z', 'M10 5h4v15h-4z', 'M16 7l3.5-1 3.5 13-3.5 1z'] },
  receipt: { f: ['M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z'], s: ['M5 3h14v18l-3-2-2 2-2-2-2 2-2-2-3 2z', 'M8.5 8h7', 'M8.5 12h7'] },
  wallet: { f: ['M3 7h17a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'], s: ['M3 7a2 2 0 0 1 2-2h12v2', 'M3 7v12a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1v-3', 'M21 11h-4a2 2 0 0 0 0 4h4z'] },
  target: { f: [], s: ['M12 3v2M12 19v2M3 12h2M19 12h2'], c: [[12, 12, 8], [12, 12, 4], [12, 12, 0.6]] },
  repeat: { f: [], s: ['M4 11V9a3 3 0 0 1 3-3h12', 'M16 3l3 3-3 3', 'M20 13v2a3 3 0 0 1-3 3H5', 'M8 21l-3-3 3-3'] },
  party: { f: ['M4 21l4-11 7 7z'], s: ['M4 21l4-11 7 7z', 'M12 4v2M17 6l-1.2 1.2M20 11h-2M15 3.5l.5 1.5'] },
  megaphone: { f: ['M4 10v4h3l8 4V6L7 10z'], s: ['M4 10v4h3l8 4V6L7 10z', 'M18 9.5a3.5 3.5 0 0 1 0 5', 'M7 14l1.5 5h3L10 15'] },
  file: { f: ['M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z'], s: ['M6 3h8l5 5v12a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z', 'M14 3v5h5', 'M8.5 13h7', 'M8.5 16.5h5'] },
  cap: { f: ['M12 5l10 5-10 5-10-5z'], s: ['M12 5l10 5-10 5-10-5z', 'M6 12.5V17c2 2 10 2 12 0v-4.5', 'M22 10v5'] },
  briefcase: { f: ['M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z'], s: ['M3 8h18v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z', 'M9 8V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V8', 'M3 13h18'] },
  tag: { f: ['M3 12V4h8l10 10-8 8z'], s: ['M3 12V4h8l10 10-8 8z'], c: [[7.5, 8.5, 1.3]] },
  key: { f: [], s: ['M14 11l7.5 7.5', 'M18 15.5l2-2', 'M16 13.5l2-2'], c: [[8.5, 8.5, 4.5]] },
  palette: { f: ['M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2.2-.6-1.3.3-2.8 1.8-2.8H18a3 3 0 0 0 3-3C21 7 17 3 12 3z'], s: ['M12 3a9 9 0 1 0 0 18c1.5 0 2-1 1.5-2.2-.6-1.3.3-2.8 1.8-2.8H18a3 3 0 0 0 3-3C21 7 17 3 12 3z'], c: [[7.5, 11, 1], [10, 7, 1], [15, 7.5, 1]] },
  clock: { f: [], s: ['M12 7v5l3 2'], c: [[12, 12, 9]] },
  alarm: { f: [], s: ['M12 8v4.5l2.5 1.5', 'M4 5l3-2M20 5l-3-2'], c: [[12, 13, 7.5]] },
  shield: { f: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'], s: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z', 'M8.5 12l2.5 2.5L16 9.5'] },
  pulse: { f: [], s: ['M3 12h4l2.5-6 4 12 2.5-6H21'] },
  building: { f: ['M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16z'], s: ['M5 21V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v16', 'M15 10h4a1 1 0 0 1 1 1v10', 'M3 21h18', 'M8.5 8h2M8.5 12h2M8.5 16h2'] },
  gear: { f: [], s: ['M12 2.5l1.6 2.6 3-.6.9 3 2.9 1-1 2.9 1.9 2.4-2.3 2-.3 3-3.1.2-1.7 2.6-2.9-1.2-2.9 1.2-1.7-2.6-3.1-.2-.3-3L1.6 14l1.9-2.4-1-2.9 2.9-1 .9-3 3 .6z'], c: [[12, 12, 3]] },
  bell: { f: ['M6 17V11a6 6 0 0 1 12 0v6z'], s: ['M6 17V11a6 6 0 0 1 12 0v6l1.5 2h-15z', 'M10 21h4'] },
  menu: { f: [], s: ['M4 6h16M4 12h16M4 18h10'] },
  logout: { f: [], s: ['M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4', 'M16 8l4 4-4 4', 'M20 12H9'] },
  plus: { f: [], s: ['M12 5v14M5 12h14'] },
  check: { f: [], s: ['M5 12.5l4.5 4.5L19 7.5'] },
  x: { f: [], s: ['M6 6l12 12M18 6L6 18'] },
  chevron: { f: [], s: ['M9 6l6 6-6 6'] },
  'arrow-up': { f: [], s: ['M12 20V5', 'M6 11l6-6 6 6'] },
  'arrow-right': { f: [], s: ['M4 12h16', 'M14 6l6 6-6 6'] },
  star: { f: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'], s: ['M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z'] },
  flame: { f: ['M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 1-3 0-6 1-9z'], s: ['M12 3c1 4 5 5 5 10a5 5 0 0 1-10 0c0-2 1-3 2-4 0 2 1 3 2 3 1-3 0-6 1-9z'] },
  bolt: { f: ['M13 3L5 13.5h6L10 21l9-11h-6.5z'], s: ['M13 3L5 13.5h6L10 21l9-11h-6.5z'] },
  gift: { f: ['M4 11h16v9H4z'], s: ['M4 11h16v9H4z', 'M3 7h18v4H3z', 'M12 7v13', 'M12 7S10 3.5 8 4.5s-.5 2.5 4 2.5zM12 7s2-3.5 4-2.5.5 2.5-4 2.5z'] },
  share: { f: [], s: ['M8.6 13.4l6.8 3.7M15.4 6.9L8.6 10.6'], c: [[6.5, 12, 2.5], [17.5, 6, 2.5], [17.5, 18, 2.5]] },
  download: { f: [], s: ['M12 4v11', 'M7 11l5 5 5-5', 'M5 20h14'] },
  upload: { f: [], s: ['M12 16V5', 'M7 9l5-5 5 5', 'M5 20h14'] },
  edit: { f: ['M4 20l1-4L16 5l3 3L8 19z'], s: ['M4 20l1-4L16 5l3 3L8 19z', 'M14 7l3 3'] },
  trash: { f: ['M6 7h12l-1 13H7z'], s: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13', 'M10 11v6M14 11v6'] },
  eye: { f: [], s: ['M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z'], c: [[12, 12, 3]] },
  lock: { f: ['M5 11h14v9H5z'], s: ['M5 11h14v9H5z', 'M8 11V8a4 4 0 0 1 8 0v3'] },
  link: { f: [], s: ['M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1', 'M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1'] },
  video: { f: ['M3 6h12v12H3z'], s: ['M3 6h12v12H3z', 'M15 10l6-3v10l-6-3'] },
  play: { f: ['M7 4l13 8-13 8z'], s: ['M7 4l13 8-13 8z'] },
  folder: { f: ['M3 6h6l2 2h10v11H3z'], s: ['M3 6h6l2 2h10v11H3z'] },
  paperclip: { f: [], s: ['M20 11.5l-8.5 8.5a5 5 0 0 1-7-7L13 4.5a3.3 3.3 0 0 1 4.7 4.7L9.2 17.7a1.7 1.7 0 0 1-2.4-2.4L14.5 7.5'] },
  camera: { f: ['M3 8h4l2-3h6l2 3h4v12H3z'], s: ['M3 8h4l2-3h6l2 3h4v12H3z'], c: [[12, 13.5, 3.5]] },
  phone: { f: ['M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z'], s: ['M5 3h4l2 5-2.5 1.5a11 11 0 0 0 6 6L16 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 5a2 2 0 0 1 2-2z'] },
  mail: { f: ['M3 6h18v13H3z'], s: ['M3 6h18v13H3z', 'M3 7l9 7 9-7'] },
  qr: { f: [], s: ['M3 3h7v7H3z', 'M14 3h7v7h-7z', 'M3 14h7v7H3z', 'M14 14h3v3h-3zM20 14v1M14 20h1M18 18h3v3h-3z'] },
  poll: { f: ['M4 4h16v16H4z'], s: ['M4 4h16v16H4z', 'M8 16v-4M12 16V8M16 16v-6'] },
  compass: { f: ['M15.5 8.5l-2 5-5 2 2-5z'], s: ['M15.5 8.5l-2 5-5 2 2-5z'], c: [[12, 12, 9]] },
  flag: { f: ['M5 4h13l-2 4 2 4H5z'], s: ['M5 21V4', 'M5 4h13l-2 4 2 4H5'] },
  heart: { f: ['M12 20S3.5 14.5 3.5 8.8A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 8.5 1.8C20.5 14.5 12 20 12 20z'], s: ['M12 20S3.5 14.5 3.5 8.8A4.3 4.3 0 0 1 12 7a4.3 4.3 0 0 1 8.5 1.8C20.5 14.5 12 20 12 20z'] },
  sparkle: { f: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'], s: ['M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z'] },
  rocket: { f: ['M12 2c4 2 6 6 6 10l-3 3H9l-3-3c0-4 2-8 6-10z'], s: ['M12 2c4 2 6 6 6 10l-3 3H9l-3-3c0-4 2-8 6-10z', 'M9 15l-2.5 4 4-1', 'M15 15l2.5 4-4-1'], c: [[12, 9, 1.8]] },
  percent: { f: [], s: ['M19 5L5 19'], c: [[7, 7, 2.2], [17, 17, 2.2]] },
  card: { f: ['M3 6h18v12H3z'], s: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4'] },
  bank: { f: ['M4 10h16v10H4z'], s: ['M2.5 9.5L12 4l9.5 5.5', 'M5 10v8M9.5 10v8M14.5 10v8M19 10v8', 'M3 20h18'] },
  filter: { f: ['M4 5h16l-6 8v6l-4-2v-4z'], s: ['M4 5h16l-6 8v6l-4-2v-4z'] },
  refresh: { f: [], s: ['M20 8a8 8 0 0 0-14-2L4 8', 'M4 4v4h4', 'M4 16a8 8 0 0 0 14 2l2-2', 'M20 20v-4h-4'] },
  info: { f: [], s: ['M12 11v5.5', 'M12 7.8v.1'], c: [[12, 12, 9]] },
  alert: { f: ['M12 3l10 18H2z'], s: ['M12 3l10 18H2z', 'M12 10v5', 'M12 17.8v.1'] },
  ban: { f: [], s: ['M5.6 5.6l12.8 12.8'], c: [[12, 12, 9]] },
  history: { f: [], s: ['M3.5 12a8.5 8.5 0 1 0 2.5-6', 'M3 4v4h4', 'M12 7.5V12l3 2'] },
  globe: { f: [], s: ['M3 12h18', 'M12 3c3 3 3 15 0 18-3-3-3-15 0-18z'], c: [[12, 12, 9]] },
  mortar: { f: ['M12 5l10 5-10 5-10-5z'], s: ['M12 5l10 5-10 5-10-5z', 'M6 12.5V17c2 2 10 2 12 0v-4.5'] },
  robot: { f: ['M5 8h14v11H5z'], s: ['M5 8h14v11H5z', 'M12 8V4', 'M3 13v3M21 13v3', 'M9 15.5h6'], c: [[12, 3.5, 1], [9, 12, 1], [15, 12, 1]] },
  coin: { f: [], s: ['M12 7v10M9.5 9.5C9.5 8.4 10.6 8 12 8s2.5.5 2.5 1.6S13 11 12 11.3 9.5 12.5 9.5 14c0 1.1 1.1 1.6 2.5 1.6s2.5-.5 2.5-1.6'], c: [[12, 12, 9]] },
};
const toneClass = (t?: string) => (t ? ` ic-${t}` : '');

export type IconName = keyof typeof D | string;
export function Icon({ name, size = 20, className = '', style, title }: { name: IconName; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  const d = D[name] ?? D.sparkle!;
  return (
    <svg className={`ic ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} style={style}>
      {d.f?.map((p, i) => <path key={`f${i}`} d={p} fill="currentColor" fillOpacity={0.16} stroke="none" />)}
      {d.c?.map(([cx, cy, r], i) => <circle key={`c${i}`} cx={cx} cy={cy} r={r} fill={r > 3 ? 'currentColor' : 'none'} fillOpacity={0.14} />)}
      {d.s.map((p, i) => <path key={`s${i}`} d={p} />)}
    </svg>
  );
}

export type Hue = 'violet' | 'peach' | 'mint' | 'butter' | 'sky' | 'rose' | 'slate';
/** An icon on a soft pastel rounded square, the Zepto-style tile used for navigation, stats, categories and empty states. */
export function IconTile({ name, hue = 'violet', size = 'md', children, className = '' }: { name?: IconName; hue?: Hue; size?: 'sm' | 'md' | 'lg' | 'xl'; children?: ReactNode; className?: string }) {
  const px = { sm: 16, md: 22, lg: 30, xl: 44 }[size];
  return <span className={`icon-tile it-${hue} it-${size} ${className}`} aria-hidden>{name ? <Icon name={name} size={px} /> : children}</span>;
}
export const iconNames = Object.keys(D);
export { toneClass };

/** The emoji used all over the old screens, mapped to an icon and a tile colour, so they render as one consistent set. */
export const EMOJI_ICON: Record<string, [string, Hue]> = {
  '📭': ['inbox', 'slate'], '📚': ['library', 'violet'], '🎓': ['cap', 'violet'], '🏆': ['trophy', 'butter'], '🏅': ['medal', 'butter'], '💬': ['chat', 'sky'], '🧾': ['receipt', 'mint'], '💳': ['card', 'mint'], '💰': ['wallet', 'mint'],
  '📝': ['clipboard', 'peach'], '📅': ['calendar', 'sky'], '🗓️': ['calendar', 'sky'], '👥': ['users', 'violet'], '👨‍👩‍👧': ['family', 'rose'], '🧑‍🧒': ['family', 'rose'], '🔎': ['search', 'sky'], '🔒': ['lock', 'slate'], '⭐': ['star', 'butter'],
  '🤖': ['robot', 'violet'], '🎯': ['target', 'rose'], '🎉': ['party', 'butter'], '📊': ['bars', 'sky'], '⚡': ['bolt', 'butter'], '🧭': ['compass', 'mint'], '🏁': ['flag', 'mint'], '✅': ['check', 'mint'], '⚠️': ['alert', 'butter'],
  '❓': ['help', 'slate'], '🖼️': ['portfolio', 'peach'], '🏫': ['school', 'violet'], '🔁': ['repeat', 'sky'], '🎈': ['party', 'rose'], '📈': ['trending', 'mint'], '👩‍🏫': ['cap', 'violet'], '🏷️': ['tag', 'peach'], '🔑': ['key', 'slate'],
  '🎨': ['palette', 'rose'], '⏰': ['alarm', 'peach'], '🩺': ['pulse', 'mint'], '🏢': ['building', 'slate'], '💼': ['briefcase', 'slate'], '📥': ['download', 'sky'], '📤': ['share', 'sky'], '🧱': ['layers', 'violet'], '📄': ['file', 'slate'], '🗂️': ['layers', 'violet'], '⚙️': ['gear', 'slate'], '▦': ['grid', 'violet'], '●': ['dot', 'mint'], '◐': ['dot-half', 'butter'], '○': ['ring', 'slate'], '☰': ['menu', 'slate'],
  '🙂': ['user', 'violet'], '🔔': ['bell', 'butter'], '🎁': ['gift', 'rose'], '👋': ['sparkle', 'butter'], '📣': ['megaphone', 'rose'], '🌱': ['sparkle', 'mint'], '🚀': ['rocket', 'violet'], '🔗': ['link', 'sky'], '📎': ['paperclip', 'slate'],
};

/** Lesson kinds → icon + tile colour (course player, landing page, studio). */
export const LESSON_ICON: Record<string, [string, Hue]> = { text: ['file', 'sky'], video: ['play', 'rose'], link: ['link', 'sky'], quiz: ['help', 'butter'], file: ['paperclip', 'slate'], assignment: ['edit', 'peach'] };
export function LessonIcon({ kind, done, locked }: { kind: string; done?: boolean; locked?: boolean }) {
  const [n, h] = locked ? ['lock', 'slate'] as [string, Hue] : done ? ['check', 'mint'] as [string, Hue] : LESSON_ICON[kind] ?? ['file', 'slate'];
  return <IconTile name={n} hue={h} size="sm" className="lesson-ic" />;
}

/** Resolve an old emoji/glyph or an icon name to an icon name. */
export const iconFor = (k: string): string => EMOJI_ICON[k]?.[0] ?? k;
