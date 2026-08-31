import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../lib/api';

const AuthContext = createContext(null);

function authUser(payload) {
  return payload?.user || payload?.account || payload || null;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async signal => {
    try {
      const data = await api.auth.me(signal);
      setUser(authUser(data));
    } catch (error) {
      if (error.name === 'AbortError') return;
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) setUser(null);
      else throw error;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    refresh(controller.signal).catch(() => setLoading(false));
    return () => controller.abort();
  }, [refresh]);

  const login = useCallback(async credentials => {
    const data = await api.auth.login(credentials);
    const next = authUser(data);
    setUser(next);
    return next;
  }, []);

  const register = useCallback(async account => {
    const data = await api.auth.register(account);
    const next = authUser(data);
    setUser(next);
    return next;
  }, []);

  const logout = useCallback(async () => {
    try { await api.auth.logout(); } finally { setUser(null); }
  }, []);

  const value = useMemo(() => ({ user, loading, login, register, logout, refresh, setUser }), [user, loading, login, register, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth 必须在 AuthProvider 中使用');
  return context;
}
