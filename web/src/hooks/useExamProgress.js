import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { readExamDraft, removeExamDraft, writeExamDraft } from '../lib/exam-drafts';

export function useExamProgress(userId, sessionId, online) {
  const [data, setData] = useState({ pack: null, questions: [], session: null, result: null });
  const [progress, setProgress] = useState({ answers: {}, flagged: [], currentIndex: 0 });
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('');
  const [conflict, setConflict] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const live = useRef({ progress, version: 0, revision: 0, dirty: false, blocked: false, status: '', anchor: Date.now(), seconds: 0, online, mounted: true });
  const flight = useRef(null);
  live.current.online = online;
  const elapsed = useCallback(() => {
    const value = live.current;
    return value.seconds + (value.status === 'in_progress' ? Math.max(0, Math.floor((Date.now() - value.anchor) / 1000)) : 0);
  }, []);
  const persist = useCallback(() => {
    const value = live.current;
    if (!value.mounted || value.status !== 'in_progress') return;
    if (!writeExamDraft(userId, sessionId, { ...value.progress, elapsedSeconds: elapsed(), expectedVersion: value.version, dirty: value.dirty })) setSaveState('本机草稿存储不可用，请保持联网并确认云端保存成功后离开。');
  }, [userId, sessionId, elapsed]);

  const apply = useCallback((response, useDraft = false) => {
    const session = response.session;
    const local = useDraft && session.status === 'in_progress' ? readExamDraft(userId, sessionId) : null;
    const chosen = local?.dirty ? local : session;
    const next = { answers: chosen.answers || {}, flagged: chosen.flagged || [], currentIndex: chosen.currentIndex || 0 };
    const collided = Boolean(local?.dirty && local.expectedVersion !== session.version);
    Object.assign(live.current, { progress: next, version: session.version, revision: 0, dirty: Boolean(local?.dirty), blocked: collided, status: session.status, seconds: chosen.elapsedSeconds || 0, anchor: Date.now() });
    setData(response); setProgress(next); setElapsedSeconds(chosen.elapsedSeconds || 0);
    setConflict(collided ? { session } : null);
    setSaveState(collided ? '云端进度已经变化。本机回答仍保留，请选择如何继续。' : local?.dirty ? '已恢复本机未同步回答，将按版本校验同步。' : '已加载云端记录');
    if (session.status === 'submitted') removeExamDraft(userId, sessionId);
  }, [userId, sessionId]);

  const load = useCallback(async signal => {
    setLoading(true); setError('');
    try { const response = await api.exams.session(sessionId, signal); if (!signal?.aborted) apply(response, true); }
    catch (err) { if (err.name !== 'AbortError') setError(err.message); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, [apply, sessionId]);
  useEffect(() => {
    live.current.mounted = true;
    const controller = new AbortController(); void load(controller.signal);
    return () => { persist(); live.current.mounted = false; controller.abort(); };
  }, [load, persist]);

  const update = useCallback((key, action) => {
    const value = live.current;
    const previous = value.progress[key];
    value.progress = { ...value.progress, [key]: typeof action === 'function' ? action(previous) : action };
    value.revision += 1; value.dirty = true;
    setProgress(value.progress); persist();
  }, [persist]);

  const save = useCallback(async ({ retry = false } = {}) => {
    const state = live.current;
    if (state.status !== 'in_progress') return true;
    if (retry && !conflict) state.blocked = false;
    if (!state.online) { persist(); setSaveState('当前离线：本机回答已暂存，联网后请确认同步状态。'); return false; }
    if (state.blocked) return false;
    if (flight.current) return flight.current;
    flight.current = (async () => {
      while (state.dirty && state.mounted && !state.blocked) {
        const revision = state.revision;
        const payload = { ...state.progress, elapsedSeconds: elapsed(), expectedVersion: state.version };
        setSaveState('正在保存…');
        try {
          const response = await api.exams.save(sessionId, payload);
          if (!state.mounted) return false;
          state.version = response.session.version;
          state.dirty = revision !== state.revision;
          setData(current => ({ ...current, session: response.session }));
          persist();
          setSaveState(state.dirty ? '正在同步最新回答…' : '云端已保存');
        } catch (err) {
          if (!state.mounted) return false;
          state.blocked = true; persist();
          if (err.code === 'VERSION_CONFLICT' || err.code === 'EXAM_ALREADY_SUBMITTED') {
            setConflict({ pending: true });
            setSaveState('其他设备已更新此试卷，已暂停自动保存。本机回答没有被覆盖。');
          } else setSaveState(`保存失败：${err.message} 本机回答保留，请重试同步。`);
          return false;
        }
      }
      return !state.blocked;
    })();
    try { return await flight.current; } finally { flight.current = null; }
  }, [sessionId, persist, elapsed, conflict]);

  useEffect(() => {
    if (loading || !live.current.dirty || live.current.blocked) return;
    const timer = setTimeout(() => { void save(); }, 800);
    return () => clearTimeout(timer);
  }, [progress, loading, online, save]);

  useEffect(() => {
    if (loading || data.session?.status !== 'in_progress') return;
    const tick = () => setElapsedSeconds(elapsed());
    const stash = () => { live.current.dirty = true; live.current.revision += 1; tick(); persist(); };
    const visible = () => { stash(); if (document.visibilityState === 'visible' && live.current.online && !live.current.blocked) void save(); };
    const timer = setInterval(tick, 1000);
    window.addEventListener('pagehide', stash); document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); window.removeEventListener('pagehide', stash); document.removeEventListener('visibilitychange', visible); };
  }, [data.session?.status, loading, elapsed, persist, save]);

  const resolveConflict = async keepLocal => {
    setSubmitting(true); setError('');
    try {
      const response = await api.exams.session(sessionId);
      if (!keepLocal) {
        if (!window.confirm('载入云端进度会舍弃本机尚未同步的回答，确定继续吗？')) return;
        apply(response); persist();
      } else if (response.session.status !== 'in_progress') {
        setError('云端已交卷，不能再覆盖。请载入云端记录查看结果。');
      } else {
        if (!window.confirm('用本机回答替换刚读取的云端进度？如果其他设备再次更新，仍会阻止覆盖。')) return;
        live.current.version = response.session.version; live.current.blocked = false; live.current.dirty = true;
        setConflict(null); persist(); await save();
      }
    } catch (err) { setError(err.message); } finally { setSubmitting(false); }
  };

  const submitProgress = async () => {
    setSubmitting(true); setError('');
    try {
      if (!await save({ retry: true })) { setError('请先完成进度同步或处理云端冲突，再交卷。'); return false; }
      const state = live.current;
      const response = await api.exams.submit(sessionId, { ...state.progress, elapsedSeconds: elapsed(), expectedVersion: state.version });
      apply({ ...data, ...response }); removeExamDraft(userId, sessionId); return true;
    } catch (err) {
      if (err.code === 'VERSION_CONFLICT') { live.current.blocked = true; setConflict({ pending: true }); }
      setError(err.message); return false;
    } finally { setSubmitting(false); }
  };

  return { ...data, ...progress, elapsedSeconds, loading, error, setError, saveState, conflict, resolveConflict, submitting, setSubmitting, save, submitProgress, load, setAnswers: action => update('answers', action), setFlagged: action => update('flagged', action), setCurrentIndex: action => update('currentIndex', action) };
}
