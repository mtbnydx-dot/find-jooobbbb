import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError, AUTH_REQUIRED_EVENT, clearNativeSession } from '../lib/api';
import { clearExamDrafts, enableExamDrafts } from '../lib/exam-drafts';

const AuthContext = createContext(null);

function authUser(payload) {
  return payload?.user || payload?.account || payload || null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [sessionExpired, setSessionExpired] = useState(false);

  const refresh = useCallback(async signal => {
    try {
      const data = await api.auth.me(signal);
      enableExamDrafts(authUser(data)?.id);
      setUser(authUser(data));
      setConnectionError(''); setSessionExpired(false);
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (error instanceof ApiError && [401, 403].includes(error.status)) { setUser(null); setConnectionError(''); }
      else setConnectionError(error.message || '暂时无法确认登录，请联网后重试。');
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => setLoading(false));
    return () => controller.abort();
  }, [refresh]);

  useEffect(() => {
    const expired = () => { setUser(null); setSessionExpired(true); setConnectionError(''); void clearNativeSession(); };
    const reconnect = () => { void refresh(); };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    window.addEventListener('online', reconnect);
    return () => { window.removeEventListener(AUTH_REQUIRED_EVENT, expired); window.removeEventListener('online', reconnect); };
  }, [refresh]);

  const login = useCallback(async credentials => {
    const data = await api.auth.login(credentials);
    const next = authUser(data);
    enableExamDrafts(next?.id);
    setUser(next);
    setConnectionError(''); setSessionExpired(false);
    return next;
  }, []);

  const register = useCallback(async account => {
    const data = await api.auth.register(account);
    const next = authUser(data);
    enableExamDrafts(next?.id);
    setUser(next);
    setConnectionError(''); setSessionExpired(false);
    return next;
  }, []);

  const logout = useCallback(async () => {
    try { await api.auth.logout(); } catch (error) { if (![401, 403].includes(error.status)) { setConnectionError('退出尚未完成，请联网后重试退出登录。'); return false; } }
    if (user?.id) clearExamDrafts(user.id); await clearNativeSession(); setUser(null); setConnectionError(''); return true;
  }, [user?.id]);

  const renew = useCallback(async () => {
    const data = await api.auth.renew(); setUser(authUser(data)); setSessionExpired(false); setConnectionError(''); return data;
  }, []);

  const value = useMemo(() => ({ user, loading, connectionError, sessionExpired, login, register, logout, refresh, renew, setUser }), [user, loading, connectionError, sessionExpired, login, register, logout, refresh, renew]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 中使用');
  return context;
}
