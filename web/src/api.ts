/** Thin fetch client: cookie session + CSRF double-submit + one silent refresh on 401. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
}

const csrf = () => document.cookie.split('; ').find((c) => c.startsWith('rk_csrf='))?.split('=')[1] ?? '';
const orgKey = 'rk_active_org';
export const getActiveOrg = () => { try { return localStorage.getItem(orgKey); } catch { return null; } };
export const setActiveOrg = (id: string | null) => { try { id ? localStorage.setItem(orgKey, id) : localStorage.removeItem(orgKey); } catch { /* storage unavailable */ } };

let refreshing: Promise<boolean> | null = null;
async function refresh(): Promise<boolean> {
  refreshing ??= fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-CSRF-Token': csrf() } })
    .then((r) => r.ok).catch(() => false).finally(() => { setTimeout(() => (refreshing = null), 0); });
  return refreshing;
}

let onAuthLost: () => void = () => {};
export const setAuthLostHandler = (fn: () => void) => { onAuthLost = fn; };

export interface Page<T> { data: T[]; meta: { page: number; page_size: number; total: number; total_pages?: number } }

async function raw(method: string, url: string, body?: unknown, retry = true): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET') headers['X-CSRF-Token'] = csrf();
  const org = getActiveOrg();
  if (org) headers['X-Org-Id'] = org;
  let res: Response;
  try {
    res = await fetch(url, { method, credentials: 'include', headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError(0, 'NETWORK', 'You appear to be offline or the server is unreachable. Check your connection and try again.');
  }
  if (res.status === 401 && retry && !url.startsWith('/api/auth/')) {
    if (await refresh()) return raw(method, url, body, false);
    onAuthLost();
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  const text = await res.text();
  let payload: any = null;
  try { payload = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
  if (!res.ok || payload?.ok === false) {
    const e = payload?.error;
    throw new ApiError(res.status, e?.code ?? 'ERROR', e?.message ?? 'Something went wrong. Please try again.', e?.details);
  }
  return payload as T;
}

export const api = {
  get: <T = any>(url: string) => raw('GET', url).then((r) => json<{ data: T; meta?: any }>(r)),
  post: <T = any>(url: string, body?: unknown) => raw('POST', url, body ?? {}).then((r) => json<{ data: T; meta?: any }>(r)),
  patch: <T = any>(url: string, body?: unknown) => raw('PATCH', url, body ?? {}).then((r) => json<{ data: T; meta?: any }>(r)),
  put: <T = any>(url: string, body?: unknown) => raw('PUT', url, body ?? {}).then((r) => json<{ data: T; meta?: any }>(r)),
  del: <T = any>(url: string, body?: unknown) => raw('DELETE', url, body ?? {}).then((r) => json<{ data: T; meta?: any }>(r)),
  /** Upload raw file bytes; the server verifies type and size. */
  async upload(file: File): Promise<{ id: string; name: string; size: number; mime: string }> {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/octet-stream', 'X-CSRF-Token': csrf() };
    const org = getActiveOrg(); if (org) headers['X-Org-Id'] = org;
    let res: Response;
    try { res = await fetch(`/api/files?name=${encodeURIComponent(file.name)}`, { method: 'POST', credentials: 'include', headers, body: file }); }
    catch { throw new ApiError(0, 'NETWORK', 'Upload failed. Check your connection and try again.'); }
    return (await json<{ data: any }>(res)).data;
  },
  /** Fetch a protected file with the session and save it (or open inline for pdf/images). */
  async openFile(id: string, name: string, inline = false) {
    const res = await raw('GET', `/api/files/${id}${inline ? '?inline=1' : ''}`);
    if (!res.ok) await json(res);
    const url = URL.createObjectURL(await res.blob());
    if (inline) window.open(url, '_blank', 'noopener');
    else { const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
  /** POST raw text (a CSV file) and read the JSON answer. */
  async postText<T = any>(url: string, text: string, type = 'text/csv') {
    const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': type, 'X-CSRF-Token': csrf() };
    const org = getActiveOrg(); if (org) headers['X-Org-Id'] = org;
    let res: Response;
    try { res = await fetch(url, { method: 'POST', credentials: 'include', headers, body: text }); }
    catch { throw new ApiError(0, 'NETWORK', 'Upload failed. Check your connection and try again.'); }
    return json<{ data: T; meta?: any }>(res);
  },
  /** GET a protected file (PDF receipt, CSV) with the session; open it in a tab or save it. */
  async getFile(url: string, filename: string, inline = false) {
    const res = await raw('GET', url);
    if (!res.ok) await json(res);
    const href = URL.createObjectURL(await res.blob());
    if (inline) window.open(href, '_blank', 'noopener');
    else { const a = document.createElement('a'); a.href = href; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); }
    setTimeout(() => URL.revokeObjectURL(href), 60_000);
  },
  async download(url: string, body: unknown, filename: string) {
    const res = await raw('POST', url, body);
    if (!res.ok) await json(res);
    const blob = await res.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

export const qs = (o: Record<string, unknown>) => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    p.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  const s = p.toString();
  return s ? `?${s}` : '';
};

/** Map any thrown error to a message that is safe to show. */
export const friendly = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
