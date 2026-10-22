import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, AUTH_REQUIRED_EVENT, clearNativeSession } from './api';
import { clearPrepDrafts } from '../screens/prep-helpers';

const MobileContext = createContext(null);
export function MobileProvider({ children }) {
  const [user, setUser] = useState(null);
  const [authStatus, setAuthStatus] = useState('loading');
  const [authError, setAuthError] = useState('');
  const [authChecking, setAuthChecking] = useState(true);
  const [revision, setRevision] = useState(0);
  const [toast, setToast] = useState('');
  const [online, setOnline] = useState(() => navigator.onLine);
  const authEpoch = useRef(0), refreshSequence = useRef(0), refreshController = useRef(null);
  const mutation = useRef(null), transportCleanup = useRef(Promise.resolve());
  const toastTimer = useRef(null), mounted = useRef(true);
  const currentUser = useRef(user); currentUser.current = user;
  const notify = useCallback(message => {
    setToast(String(message || '')); clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 4500);
  }, []);
  const bumpRefresh = useCallback(() => setRevision(value => value + 1), []);
  const commitIdentity = useCallback(nextUser => {
    const previousId = currentUser.current?.id;
    if (previousId && previousId !== nextUser?.id) clearPrepDrafts(previousId);
    currentUser.current = nextUser || null;
    setUser(nextUser || null); setAuthStatus(nextUser ? 'authenticated' : 'anonymous'); setAuthError('');
  }, []);
  const clearTransport = useCallback(() => {
    // Finish an earlier Keychain/Keystore cleanup before a later login saves its token.
    transportCleanup.current = transportCleanup.current.catch(() => {}).then(() => clearNativeSession()).catch(() => {});
    return transportCleanup.current;
  }, []);
  const cancelRefresh = useCallback(() => {
    refreshSequence.current += 1;
    refreshController.current?.abort(); refreshController.current = null;
  }, []);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = () => {
      const editable = document.activeElement?.matches('input,textarea,select,[contenteditable="true"]');
      document.documentElement.style.setProperty('--visual-height', `${Math.round(viewport.height)}px`);
      document.documentElement.classList.toggle('keyboard-open', Boolean(editable && innerHeight - viewport.height > 120));
    };
    update(); viewport.addEventListener('resize', update);
    document.addEventListener('focusin', update); document.addEventListener('focusout', update);
    return () => { viewport.removeEventListener('resize', update); document.removeEventListener('focusin', update); document.removeEventListener('focusout', update); document.documentElement.classList.remove('keyboard-open'); };
  }, []);
  const refreshUser = useCallback(async signal => {
    // Passive visibility/online checks never supersede a login, registration or logout.
    if (mutation.current || signal?.aborted || !mounted.current) return null;
    cancelRefresh();
    const sequence = refreshSequence.current, epoch = authEpoch.current;
    const controller = new AbortController(); refreshController.current = controller;
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    setAuthChecking(true);
    try {
      const data = await api.auth.me(controller.signal);
      if (!mounted.current || controller.signal.aborted || sequence !== refreshSequence.current || epoch !== authEpoch.current || mutation.current) return null;
      commitIdentity(data.user);
      return data.user;
    } catch (error) {
      if (!mounted.current || controller.signal.aborted || sequence !== refreshSequence.current || epoch !== authEpoch.current || mutation.current || error.name === 'AbortError') return null;
      if ([401, 403].includes(error.status)) { commitIdentity(null); void clearTransport(); }
      else { setAuthStatus('error'); setAuthError(error.message || '暂时无法确认登录状态，请联网后重试'); }
      return null;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (mounted.current && sequence === refreshSequence.current && !mutation.current) {
        refreshController.current = null; setAuthChecking(false);
      }
    }
  }, [cancelRefresh, clearTransport, commitIdentity]);
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    void refreshUser(controller.signal);
    const expired = () => {
      // A pre-login request may report 401 before the new login response arrives.
      // The active mutation owns its outcome and verifies /me if that outcome is uncertain.
      if (mutation.current) return;
      authEpoch.current += 1; cancelRefresh(); commitIdentity(null); setAuthChecking(false);
      void clearTransport();
    };
    const connected = () => { setOnline(true); void refreshUser(); };
    const disconnected = () => setOnline(false);
    const visible = () => { if (document.visibilityState === 'visible') void refreshUser(); };
    window.addEventListener(AUTH_REQUIRED_EVENT, expired);
    window.addEventListener('online', connected); window.addEventListener('offline', disconnected);
    document.addEventListener('visibilitychange', visible);
    return () => {
      mounted.current = false; controller.abort(); cancelRefresh(); clearTimeout(toastTimer.current);
      window.removeEventListener(AUTH_REQUIRED_EVENT, expired);
      window.removeEventListener('online', connected); window.removeEventListener('offline', disconnected);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [refreshUser, cancelRefresh, clearTransport, commitIdentity]);
  const beginMutation = useCallback(kind => {
    if (mutation.current) throw new Error('正在处理账号操作，请稍候再试');
    const transaction = { kind, epoch: ++authEpoch.current };
    mutation.current = transaction; cancelRefresh(); setAuthChecking(true); setAuthError('');
    return transaction;
  }, [cancelRefresh]);
  const finishMutation = useCallback(transaction => {
    if (mutation.current !== transaction) return;
    mutation.current = null;
    if (mounted.current) setAuthChecking(false);
  }, []);
  const verifyMutation = useCallback(async transaction => {
    try {
      const result = await api.auth.me();
      if (!mounted.current || mutation.current !== transaction) return { confirmed: false };
      commitIdentity(result.user);
      return { confirmed: true, user: result.user };
    } catch (error) {
      if (!mounted.current || mutation.current !== transaction) return { confirmed: false };
      if ([401, 403].includes(error.status)) {
        commitIdentity(null); await clearTransport();
        return { confirmed: true, user: null };
      }
      setAuthStatus('error'); setAuthError('操作结果尚未确认，请联网后重新核验登录状态。');
      return { confirmed: false };
    }
  }, [clearTransport, commitIdentity]);
  const authenticate = useCallback(async (method, body) => {
    const transaction = beginMutation(method);
    try {
      await transportCleanup.current;
      const result = await api.auth[method](body);
      if (!mounted.current || mutation.current !== transaction) throw new Error('登录状态已变化，请重试');
      commitIdentity(result.user); bumpRefresh();
      return result.user;
    } catch (error) {
      const verified = await verifyMutation(transaction);
      const uncertain = !error.status || ['REQUEST_TIMEOUT', 'NETWORK_UNAVAILABLE'].includes(error.code);
      const sameAccount = verified.user?.email?.toLowerCase() === String(body.email || '').trim().toLowerCase();
      if (uncertain && verified.confirmed && verified.user && sameAccount) {
        bumpRefresh(); return verified.user;
      }
      throw error;
    } finally { finishMutation(transaction); }
  }, [beginMutation, bumpRefresh, commitIdentity, finishMutation, verifyMutation]);
  const login = useCallback(body => authenticate('login', body), [authenticate]);
  const register = useCallback(body => authenticate('register', body), [authenticate]);
  const logout = useCallback(async () => {
    const transaction = beginMutation('logout');
    try {
      await transportCleanup.current;
      try { await api.auth.logout(); }
      catch (error) {
        if (![401, 403].includes(error.status)) {
          const verified = await verifyMutation(transaction);
          if (!verified.confirmed || verified.user) { notify('退出结果尚未确认，请联网后重试'); throw error; }
        }
      }
      if (!mounted.current || mutation.current !== transaction) return false;
      commitIdentity(null); await clearTransport();
      // Clear only this site's legacy drafts; preserve the main site and other apps.
      try { for (const key of Object.keys(sessionStorage)) if (key.startsWith('zhilu-mobile:')) sessionStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
      bumpRefresh(); return true;
    } finally { finishMutation(transaction); }
  }, [beginMutation, bumpRefresh, clearTransport, commitIdentity, finishMutation, notify, verifyMutation]);
  const value = useMemo(() => ({ user, authStatus, authError, authChecking, online, login, register, logout, refreshUser, notify, revision, bumpRefresh }),
    [user, authStatus, authError, authChecking, online, login, register, logout, refreshUser, notify, revision, bumpRefresh]);
  return <MobileContext.Provider value={value}>{children}<div className={`toast ${toast ? 'show' : ''}`} role="status" aria-live="polite">{toast}</div></MobileContext.Provider>;
}

export function useMobile() {
  const value = useContext(MobileContext);
  if (!value) throw new Error('MobileProvider is required');
  return value;
}

// Cancel superseded requests and never render a previous account's loaded data.
// reload resolves null on error; successful writes must not be described as failed reloads.
export function useResource(loader, dependencies = []) {
  const { user, revision } = useMobile();
  const key = useMemo(() => ({}), [user?.id, revision, ...dependencies]);
  const loaderRef = useRef(loader); loaderRef.current = loader;
  const active = useRef(null), sequence = useRef(0);
  const [state, setState] = useState({ key, data: null, loading: true, error: null });
  const reload = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const version = ++sequence.current;
    setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: true, error: null }));
    try {
      const data = await loaderRef.current(controller.signal);
      if (controller.signal.aborted || sequence.current !== version) return null;
      setState({ key, data, loading: false, error: null });
      return data;
    } catch (error) {
      if (!controller.signal.aborted && sequence.current === version && error.name !== 'AbortError') {
        setState(previous => ({ key, data: previous.key === key ? previous.data : null, loading: false, error }));
      }
      return null;
    }
  }, [key]);
  useEffect(() => { void reload(); return () => { active.current?.abort(); sequence.current += 1; }; }, [reload]);
  const setData = useCallback(value => setState(previous => ({ key, loading: false, error: null,
    data: typeof value === 'function' ? value(previous.key === key ? previous.data : null) : value })), [key]);
  return { data: state.key === key ? state.data : null, loading: state.key !== key || state.loading,
    error: state.key === key ? state.error : null, reload, setData };
}
