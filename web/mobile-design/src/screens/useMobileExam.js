import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { elapsedAt, progressOf, readPrepDraft, removePrepDraft, sameProgress, writePrepDraft } from './prep-helpers';

// Only the user's answers and navigation are retained in this tab; never question answers or session tokens.
export function useMobileExam(userId, sessionId) {
  const [data, setData] = useState(null);
  const [progress, setProgress] = useState(progressOf(null));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const state = useRef(null);
  const [reload, setReload] = useState(0);

  const persist = useCallback(value => {
    if (!value?.alive || value.status !== 'in_progress') return;
    if (!writePrepDraft(userId, sessionId, { ...value.progress, expectedVersion: value.version, dirty: value.dirty, elapsedSeconds: elapsedAt(value.seconds, value.anchor) })) {
      setMessage('本机暂存不可用，请保持联网并确认云端保存成功后离开。');
    }
  }, [userId, sessionId]);
  const apply = useCallback((value, response, draft = null) => {
    const session = response.session;
    const local = session.status === 'in_progress' ? draft : null;
    const chosen = local?.dirty ? local : session;
    const blocked = Boolean(local?.dirty && local.expectedVersion !== session.version);
    const sameLocalVersion = local && local.expectedVersion === session.version;
    const seconds = local?.dirty || sameLocalVersion
      ? Math.max(session.elapsedSeconds || 0, elapsedAt(local.elapsedSeconds || 0, local.savedAt || Date.now()))
      : session.elapsedSeconds || 0;
    Object.assign(value, { progress: progressOf(chosen), version: session.version, revision: 0, dirty: Boolean(local?.dirty), blocked, conflict: blocked, status: session.status, seconds, anchor: Date.now(), response });
    setData(response); setProgress(value.progress); setElapsedSeconds(seconds); setConflict(blocked); setError('');
    setMessage(blocked ? '云端进度已变化，已暂停自动保存。本机回答保留。' : local?.dirty ? '已恢复本标签页未同步回答。' : '已加载云端记录');
    if (session.status === 'submitted') removePrepDraft(userId, sessionId);
  }, [userId, sessionId]);

  useEffect(() => {
    const controller = new AbortController();
    const value = { alive: true, controller, progress: progressOf(null), version: 0, dirty: false, blocked: false, flight: null, submitting: false, status: '', revision: 0, seconds: 0, anchor: Date.now() };
    state.current = value; setData(null); setLoading(true); setError(''); setConflict(false); setBusy(false);
    if (!userId || !sessionId) { setLoading(false); return () => { value.alive = false; controller.abort(); }; }
    api.exams.session(sessionId, controller.signal).then(response => { if (value.alive) apply(value, response, readPrepDraft(userId, sessionId)); })
      .catch(err => { if (value.alive && err.name !== 'AbortError') setError(err.message); })
      .finally(() => { if (value.alive) setLoading(false); });
    return () => { value.alive = false; controller.abort(); };
  }, [userId, sessionId, reload, apply]);

  const save = useCallback(async (retry = false) => {
    const value = state.current;
    if (!value?.alive || value.status !== 'in_progress' || value.conflict) return false;
    if (value.flight) return value.flight;
    if (retry) value.blocked = false;
    if (value.blocked) return false;
    if (!navigator.onLine) { persist(value); setMessage('当前离线，回答仅暂存于此标签页；请联网后重试保存。'); return false; }
    value.flight = (async () => {
      while (value.alive && value.dirty && !value.blocked) {
        const revision = value.revision;
        const payload = { ...value.progress, elapsedSeconds: elapsedAt(value.seconds, value.anchor), expectedVersion: value.version };
        setMessage('正在保存…');
        try {
          const response = await api.exams.save(sessionId, payload);
          if (!value.alive) return false;
          value.version = response.session.version; value.dirty = value.revision !== revision;
          value.response = { ...value.response, session: response.session }; setData(value.response); persist(value);
          setMessage(value.dirty ? '正在保存最新回答…' : '云端已保存');
        } catch (err) {
          if (!value.alive) return false;
          if (err.code === 'VERSION_CONFLICT') {
            // A response may have been lost after the server saved it. Read back before calling it a conflict.
            try {
              const latest = await api.exams.session(sessionId, value.controller.signal);
              if (!value.alive) return false;
              if (latest.session.status === 'in_progress' && sameProgress(latest.session, payload)) {
                value.version = latest.session.version; value.dirty = revision !== value.revision;
                value.response = latest; setData(latest); persist(value); setMessage('已核对云端保存结果'); continue;
              }
            } catch { /* Keep local work and let the user explicitly reconcile. */ }
          }
          value.blocked = true;
          value.conflict = ['VERSION_CONFLICT', 'EXAM_ALREADY_SUBMITTED'].includes(err.code);
          setConflict(value.conflict); persist(value);
          setMessage(value.conflict ? '另一设备已更新或交卷，自动同步已暂停。' : `保存失败：${err.message}。本机回答保留。`);
          return false;
        }
      }
      return value.alive && !value.blocked;
    })();
    try { return await value.flight; } finally { value.flight = null; }
  }, [sessionId, persist]);

  const update = useCallback((key, input) => {
    const value = state.current;
    if (!value?.alive || value.submitting || value.status !== 'in_progress') return;
    value.progress = { ...value.progress, [key]: typeof input === 'function' ? input(value.progress[key]) : input };
    value.revision++; value.dirty = true; setProgress(value.progress); persist(value);
  }, [persist]);
  useEffect(() => {
    if (loading || !state.current?.dirty || state.current.blocked) return;
    const timer = setTimeout(() => { void save(); }, 650);
    return () => clearTimeout(timer);
  }, [loading, progress, save]);
  useEffect(() => {
    if (loading || data?.session?.status !== 'in_progress') return;
    const tick = () => { const value = state.current; if (value?.alive) setElapsedSeconds(elapsedAt(value.seconds, value.anchor)); };
    const stash = () => { const value = state.current; if (value?.alive && !value.submitting) { value.dirty = true; value.revision++; persist(value); tick(); } };
    const visible = () => { stash(); if (document.visibilityState === 'visible') void save(); };
    const reconnect = () => { if (!state.current?.conflict) void save(true); };
    const timer = setInterval(tick, 1000);
    document.addEventListener('visibilitychange', visible); window.addEventListener('pagehide', stash); window.addEventListener('online', reconnect);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('pagehide', stash); window.removeEventListener('online', reconnect); };
  }, [loading, data?.session?.status, persist, save]);

  const resolve = async keepLocal => {
    const value = state.current;
    if (!value?.alive || value.submitting) return;
    value.submitting = true; setBusy(true); setError('');
    try {
      const response = await api.exams.session(sessionId, value.controller.signal);
      if (!value.alive) return;
      if (!keepLocal) { apply(value, response); persist(value); }
      else if (response.session.status !== 'in_progress') setError('云端已交卷，不能覆盖。请载入云端记录查看成绩。');
      else { value.version = response.session.version; value.blocked = false; value.conflict = false; value.dirty = true; setConflict(false); persist(value); await save(); }
    } catch (err) { if (value.alive) setError(err.message); }
    finally { value.submitting = false; if (value.alive) setBusy(false); }
  };
  const submit = async () => {
    const value = state.current;
    if (!value?.alive || value.submitting) return false;
    value.submitting = true; setBusy(true); setError('');
    try {
      if (!await save(true)) { if (value.alive) setError('请先同步进度或处理冲突，再交卷。'); return false; }
      const response = await api.exams.submit(sessionId, { ...value.progress, elapsedSeconds: elapsedAt(value.seconds, value.anchor), expectedVersion: value.version });
      if (!value.alive) return false;
      apply(value, { ...value.response, ...response }); return true;
    } catch (err) {
      if (value.alive) {
        if (err.code === 'VERSION_CONFLICT') { value.blocked = true; value.conflict = true; setConflict(true); }
        setError(`${err.message}。交卷可安全重试；服务器不会重复生成成绩。`);
      }
      return false;
    } finally { value.submitting = false; if (value.alive) setBusy(false); }
  };
  return { data, progress, loading, error, message, conflict, busy, elapsedSeconds, update, save, submit, resolve, reload: () => setReload(n => n + 1) };
}
