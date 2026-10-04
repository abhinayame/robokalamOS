import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { friendly, ApiError } from '../api';
import { cap, initials, statusTone } from '../format';

/* ---------- data fetching with explicit states ---------- */
export function useFetch<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, set] = useState<{ data: T | null; error: unknown; loading: boolean }>({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(() => {
    const id = ++seq.current;
    set((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => id === seq.current && set({ data, error: null, loading: false }))
        .catch((error) => id === seq.current && set((s) => ({ data: s.data, error, loading: false })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run };
}

/* ---------- states ---------- */
export const Skeleton = ({ h = 14, w = '100%' }: { h?: number; w?: number | string }) => <div className="skeleton" style={{ height: h, width: w }} aria-hidden />;
export const SkeletonRows = ({ n = 6 }: { n?: number }) => (
  <div className="stack-s" style={{ padding: 16 }} role="status" aria-label="Loading">
    {Array.from({ length: n }, (_, i) => <Skeleton key={i} h={34} />)}
  </div>
);
export const Empty = ({ icon = '📭', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) => (
  <div className="state"><div className="ico" aria-hidden>{icon}</div><h3>{title}</h3>{children && <p style={{ margin: '0 0 12px' }}>{children}</p>}{action}</div>
);
export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const denied = error instanceof ApiError && error.status === 403;
  const net = error instanceof ApiError && error.status === 0;
  const missing = error instanceof ApiError && error.status === 404;
  return (
    <div className="state" role="alert">
      <div className="ico" aria-hidden>{denied ? '🔒' : net ? '📡' : missing ? '🔎' : '⚠️'}</div>
      <h3>{denied ? 'You don’t have access to this' : net ? 'You’re offline' : missing ? 'We couldn’t find that' : 'We couldn’t load this'}</h3>
      <p style={{ margin: '0 0 12px' }}>{friendly(error)}</p>
      {onRetry && !denied && <button className="btn" onClick={onRetry}>Try again</button>}
    </div>
  );
}
/** Render the right state for a fetch: loading skeleton → error → empty → content. */
export function Async<T>({ q, empty, children, rows = 6 }: { q: { data: T | null; loading: boolean; error: unknown; reload: () => void }; empty?: (d: T) => boolean; children: (d: T) => ReactNode; rows?: number }) {
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  if (!q.data) return <SkeletonRows n={rows} />;
  if (empty?.(q.data)) return null;   // opt-in: render nothing (the caller shows its own empty state elsewhere)
  return <>{children(q.data)}</>;
}

/* ---------- small components ---------- */
export const Badge = ({ children, tone = '' }: { children: ReactNode; tone?: string }) => <span className={`badge ${tone}`}>{children}</span>;
export const StatusBadge = ({ s }: { s: string }) => <Badge tone={statusTone(s)}>{cap(s)}</Badge>;
export const Avatar = ({ name, url, lg }: { name: string; url?: string | null; lg?: boolean }) => (
  <span className={`avatar ${lg ? 'lg' : ''}`} aria-hidden>{url ? <img src={url} alt="" referrerPolicy="no-referrer" /> : initials(name)}</span>
);
export const Progress = ({ value, tone = '' }: { value: number; tone?: string }) => (
  <div className={`progress ${tone}`} role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={100}><i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} /></div>
);
export const Stat = ({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) => (
  <div className="card stat"><div className="v">{value}</div><div className="l">{label}</div>{sub && <div className="s">{sub}</div>}</div>
);
export const PageHead = ({ title, sub, actions }: { title: string; sub?: ReactNode; actions?: ReactNode }) => (
  <div className="page-head"><div><h1>{title}</h1>{sub && <p>{sub}</p>}</div><div className="row wrap">{actions}</div></div>
);
export const Field = ({ label, error, hint, children, className = '' }: { label: string; error?: string; hint?: string; children: ReactNode; className?: string }) => (
  <div className={`field ${className}`}><label>{label}</label>{children}{hint && !error && <span className="hint">{hint}</span>}{error && <span className="err" role="alert">{error}</span>}</div>
);

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; badge?: ReactNode }[]; value: T; onChange: (t: T) => void }) {
  return <div className="tabs" role="tablist">{tabs.map((t) => (
    <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab ${value === t.id ? 'active' : ''}`} onClick={() => onChange(t.id)}>{t.label}{t.badge != null && <> <Badge>{t.badge}</Badge></>}</button>
  ))}</div>;
}

export function Pager({ meta, onPage }: { meta: { page: number; page_size: number; total: number }; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(meta.total / meta.page_size));
  const from = meta.total ? (meta.page - 1) * meta.page_size + 1 : 0;
  return (
    <div className="pager">
      <span className="muted small">{from}–{Math.min(meta.page * meta.page_size, meta.total)} of {meta.total.toLocaleString('en-IN')}</span>
      <div className="row gap-s">
        <button className="btn sm" disabled={meta.page <= 1} onClick={() => onPage(1)} aria-label="First page">«</button>
        <button className="btn sm" disabled={meta.page <= 1} onClick={() => onPage(meta.page - 1)}>Previous</button>
        <span className="small">Page {meta.page} of {pages}</span>
        <button className="btn sm" disabled={meta.page >= pages} onClick={() => onPage(meta.page + 1)}>Next</button>
      </div>
    </div>
  );
}

/* ---------- modal ---------- */
export function Modal({ title, onClose, children, footer, wide }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', k);
    const prev = document.body.style.overflow; document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', k); document.body.style.overflow = prev; };
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head"><h2>{title}</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close">✕</button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

/* ---------- toasts ---------- */
const ToastCtx = createContext<(msg: string, tone?: 'ok' | 'err') => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; tone: string }[]>([]);
  const push = useCallback((msg: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, msg, tone }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), 4500);
  }, []);
  return <ToastCtx.Provider value={push}>{children}<div className="toasts" aria-live="polite">{items.map((i) => <div key={i.id} className={`toast ${i.tone}`}>{i.msg}</div>)}</div></ToastCtx.Provider>;
}

/** Run an async action with busy + error handling; errors become toasts or field errors. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
    setBusy(true);
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast(friendly(e), 'err'); }
    finally { setBusy(false); }
  }, [toast]);
  return { busy, run };
}

export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && Array.isArray(e.details)) for (const d of e.details) if (d?.field) out[d.field] = d.message;
  return out;
}

export function Popover({ label, children }: { label: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  return <div ref={ref} style={{ position: 'relative' }}><button className="btn" aria-haspopup="true" aria-expanded={open} onClick={() => setOpen(!open)}>{label}</button>{open && <div className="popover">{children}</div>}</div>;
}

export function useDebounced<T>(value: T, ms = 300) {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

export function usePersistentState<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : initial; } catch { return initial; } });
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem(key, JSON.stringify(x)); } catch { /* ignore */ } }, [key]);
  return [v, set] as const;
}
