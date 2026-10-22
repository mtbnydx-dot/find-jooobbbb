import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { request } from '../lib/api';
import { workspaceApi } from '../lib/workspace-api';
import { useOnline } from '../hooks/useOnline';
import '../styles/workspace.css';

export function SaveSearch({ filters }) {
  const location = useLocation();
  const online = useOnline();
  const [target, setTarget] = useState(() => {
    const value = location.state?.editSearch;
    return typeof value?.id === 'string' && typeof value?.name === 'string' ? { id: value.id, name: value.name } : null;
  });
  const [open, setOpen] = useState(Boolean(target));
  const [name, setName] = useState(target?.name || '');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const pending = useRef(false);
  const operation = useRef(0);
  const editId = location.state?.editSearch?.id;
  const editName = location.state?.editSearch?.name;
  useEffect(() => {
    if (typeof editId !== 'string' || typeof editName !== 'string') return;
    operation.current += 1; pending.current = false;
    setTarget({ id: editId, name: editName }); setName(editName); setOpen(true); setBusy(false); setMessage(''); setError('');
  }, [editId, editName]);
  useEffect(() => () => { operation.current += 1; }, []);
  const submit = async event => {
    event.preventDefault();
    if (pending.current || !online) return;
    const version = ++operation.current;
    pending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const result = target
        ? await request(`/me/saved-searches/${encodeURIComponent(target.id)}`, { method: 'PUT', body: { name, filters } })
        : await workspaceApi.saveSearch({ name, filters });
      if (version !== operation.current) return;
      setMessage(result.duplicate ? `已保存过相同条件：${result.item.name}。没有重复占用名额。` : target ? '搜索条件已更新；下次提醒将从新条件建立基线。' : '搜索已保存；新岗位提醒需在通知设置中主动开启。');
      setOpen(false); setTarget(null);
    } catch (requestError) { if (version === operation.current) setError(requestError.message); }
    finally { if (version === operation.current) { pending.current = false; setBusy(false); } }
  };
  return <div className="saved-search-control">
    <button className="button secondary" type="button" disabled={busy || !online} onClick={() => { setOpen(!open); setName(target?.name || [filters.location, filters.q, filters.major].filter(Boolean).join(' · ') || '我的岗位搜索'); setMessage(''); setError(''); }}>{target ? `更新搜索：${target.name}` : '保存当前搜索'}</button>
    <Link to="/workspace?tab=searches">我的搜索与求职工具</Link>
    {open && <form onSubmit={submit}>
      <input aria-label="搜索名称" value={name} onChange={event => setName(event.target.value)} maxLength={100} required disabled={busy} />
      <button className="button primary" disabled={busy || !online || !name.trim()}>{busy ? '保存中…' : target ? '更新这条搜索' : '确认保存'}</button>
      {target && <button className="button secondary" type="button" disabled={busy} onClick={() => { setTarget(null); setError(''); }}>另存为新搜索</button>}
    </form>}
    {message && <span role="status">{message}</span>}
    {error && <span className="form-error" role="alert">{error}</span>}
  </div>;
}
