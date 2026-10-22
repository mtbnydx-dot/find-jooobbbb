import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from './api';
import { useMobile } from './runtime';

export function useJobAction() {
  const { user, authStatus, notify, bumpRefresh } = useMobile();
  const navigate = useNavigate(), location = useLocation();
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const active = useRef(true), lock = useRef(false), identity = useRef(user?.id);
  identity.current = user?.id;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { setError(''); }, [user?.id]);
  const run = async (id, patch, onSuccess) => {
    if (lock.current || authStatus === 'loading') return false;
    if (authStatus === 'error') { setError('暂时无法确认登录状态，请联网后重试。'); return false; }
    if (!user) { navigate(`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); return false; }
    const owner = user.id;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await api.jobs.updateState(id, patch);
      if (!active.current || identity.current !== owner) return false;
      onSuccess?.(result.state); bumpRefresh(); return true;
    } catch (failure) {
      if (active.current && identity.current === owner) {
        setError(failure.message || '保存未完成，请重试');
        if (failure.code === 'REQUEST_TIMEOUT' || failure.code === 'NETWORK_UNAVAILABLE') notify('未确认保存结果。请重试同一操作，或刷新查看服务器记录。');
      }
      return false;
    } finally { lock.current = false; if (active.current) setBusy(false); }
  };
  return { run, busy, error, confirming: authStatus === 'loading' };
}
