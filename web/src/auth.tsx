import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, ApiError, getActiveOrg, setActiveOrg, setAuthLostHandler } from './api';

export interface Me {
  id: string; email: string; full_name: string; mobile: string | null;
  organization: { id: string; name: string; slug: string; code_prefix: string } | null;
  roles: string[]; branch_ids: string[]; permissions: string[]; active_org_id: string | null; must_change_password: boolean;
}
interface AuthCtx {
  me: Me | null; loading: boolean; offline: boolean;
  login(email: string, password: string): Promise<void>; logout(): Promise<void>; reload(): Promise<void>;
  can(...perms: string[]): boolean; hasRole(...roles: string[]): boolean;
  activeOrg: string | null; chooseOrg(id: string | null): void;
}
const Ctx = createContext<AuthCtx>(null as any);
export const useAuth = () => useContext(Ctx);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(!navigator.onLine);
  const [activeOrg, setOrgState] = useState<string | null>(getActiveOrg());

  const reload = useCallback(async () => {
    try { setMe((await api.get<Me>('/api/auth/me')).data); }
    catch (e) { if (!(e instanceof ApiError) || e.status === 401) setMe(null); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    setAuthLostHandler(() => setMe(null));
    reload();
    const on = () => setOffline(false), off = () => setOffline(true);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, [reload]);

  const value = useMemo<AuthCtx>(() => ({
    me, loading, offline, activeOrg, reload,
    async login(email, password) { await api.post('/api/auth/login', { email, password }); await reload(); },
    async logout() { try { await api.post('/api/auth/logout'); } finally { setMe(null); setActiveOrg(null); setOrgState(null); } },
    can: (...p) => !!me && (me.roles.includes('super_admin') || p.every((x) => me.permissions.includes(x))),
    hasRole: (...r) => !!me && r.some((x) => me.roles.includes(x)),
    chooseOrg(id) { setActiveOrg(id); setOrgState(id); },
  }), [me, loading, offline, activeOrg, reload]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
