import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useAuth } from './auth';

export interface Brand { default: boolean; slug: string | null; name: string; app_name: string; tagline: string | null; color: string; accent: string; logo_url: string | null; manifest_url: string; support_email: string | null; support_phone: string | null }
const FALLBACK: Brand = { default: true, slug: null, name: 'Robokalam Learner OS', app_name: 'Robokalam', tagline: 'One Operating System for Every Learner.', color: '#12263f', accent: '#f5a524', logo_url: null, manifest_url: '/manifest.webmanifest', support_email: null, support_phone: null };
const KEY = 'rk_brand'; const ORG = 'rk_org';
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } } };

const Ctx = createContext<{ brand: Brand; refresh: () => void }>({ brand: FALLBACK, refresh: () => {} });
export const useBrand = () => useContext(Ctx);

function setLink(rel: string, href: string, extra: Record<string, string> = {}) {
  let el = document.head.querySelector<HTMLLinkElement>(`link[rel="${rel}"]`);
  if (!el) { el = document.createElement('link'); el.rel = rel; document.head.appendChild(el); }
  el.href = href; for (const [k, v] of Object.entries(extra)) el.setAttribute(k, v);
}

/** Put the organization's look on the page: colors, title, icon, installable-app manifest. */
function apply(b: Brand) {
  const r = document.documentElement.style;
  r.setProperty('--brand', b.color); r.setProperty('--accent', b.accent); r.setProperty('--accent-soft', `color-mix(in srgb, ${b.accent} 16%, white)`);
  document.title = b.default ? b.name : b.app_name;
  document.head.querySelector('meta[name="theme-color"]')?.setAttribute('content', b.color);
  if (b.logo_url) { setLink('icon', b.logo_url, { type: 'image/png' }); setLink('apple-touch-icon', b.logo_url); } else { setLink('icon', '/favicon.svg', { type: 'image/svg+xml' }); setLink('apple-touch-icon', '/icons/apple-touch-icon.png'); }
  setLink('manifest', b.manifest_url);
}

/** The organization is known from ?org=slug (remembered), from the signed-in user, or from the domain the app is opened on. */
export function BrandProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const [brand, setBrand] = useState<Brand>(() => { try { return { ...FALLBACK, ...JSON.parse(store.get(KEY) ?? 'null') }; } catch { return FALLBACK; } });
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const slug = me?.organization?.slug ?? new URLSearchParams(window.location.search).get('org') ?? store.get(ORG) ?? undefined;
  useEffect(() => { apply(brand); }, [brand]);
  useEffect(() => {
    let live = true;
    fetch(`/api/public/branding${slug ? `?org=${encodeURIComponent(slug)}` : ''}`, { cache: 'no-cache' }).then((r) => r.json()).then((j) => {
      if (!live || !j?.data) return;
      setBrand(j.data); store.set(KEY, JSON.stringify(j.data)); if (j.data.slug) store.set(ORG, j.data.slug);
    }).catch(() => { /* offline: keep what we had */ });
    return () => { live = false; };
  }, [slug, tick]);
  const value = useMemo(() => ({ brand, refresh }), [brand, refresh]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Logo (or the first letter) for the sidebar and sign-in page. */
export function BrandMark({ size }: { size?: number }) {
  const { brand } = useBrand();
  const style = size ? { width: size, height: size } : undefined;
  return brand.logo_url ? <img className="brand-mark logo" src={brand.logo_url} alt="" style={style} /> : <div className="brand-mark" style={style} aria-hidden>{brand.app_name.slice(0, 1).toUpperCase()}</div>;
}

/* ---------- installable app ---------- */
interface InstallEvent extends Event { prompt: () => Promise<void>; userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }> }
let deferred: InstallEvent | null = null; const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e as InstallEvent; listeners.forEach((l) => l()); });
  window.addEventListener('appinstalled', () => { deferred = null; listeners.forEach((l) => l()); });
}
export function useInstall() {
  const [, force] = useState(0);
  useEffect(() => { const l = () => force((n) => n + 1); listeners.add(l); return () => { listeners.delete(l); }; }, []);
  const standalone = typeof window !== 'undefined' && (window.matchMedia?.('(display-mode: standalone)').matches || (navigator as any).standalone === true);
  const ios = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone;
  return { standalone, canInstall: !!deferred, ios, install: async () => { if (!deferred) return; await deferred.prompt(); await deferred.userChoice; deferred = null; listeners.forEach((l) => l()); } };
}

/** Register the service worker (production only). A new version takes over on the next visit without breaking an open page. */
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js').catch(() => { /* not available (private mode, http): the site works without it */ }); });
}
