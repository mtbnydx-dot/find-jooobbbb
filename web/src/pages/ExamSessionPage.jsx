import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { api } from '../lib/api';
import { useOnline } from '../hooks/useOnline';

function optionText(option) {
  return typeof option === 'string' ? option : option?.text || option?.label || '';
}

function hasAnswer(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== undefined && value !== null && String(value).trim() !== '';
}

function displayAnswer(value, question = null) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return '';
  const renderOption = item => {
    const index = Number(item);
    if (question?.options?.length && Number.isInteger(index) && index >= 0 && index < question.options.length) {
      return optionText(question.options[index]);
    }
    return String(item ?? '');
  };
  if (Array.isArray(value)) return value.map(renderOption).join('、');
  if (question?.options?.length) return renderOption(value);
  if (value && typeof value === 'object') return value.sample || (Array.isArray(value.keywords) ? `关键词：${value.keywords.join('、')}` : JSON.stringify(value));
  return String(value ?? '');
}

function formatDuration(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor(value % 3600 / 60);
  const rest = value % 60;
  return hours ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}` : `${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

function localDraftKey(sessionId) {
  return `zlkjob-exam-draft:${sessionId}`;
}

function readLocalDraft(sessionId) {
  try { return JSON.parse(localStorage.getItem(localDraftKey(sessionId)) || 'null'); } catch (_) { return null; }
}

export function ExamSessionPage() {
  const { sessionId } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const [pack, setPack] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [session, setSession] = useState(null);
  const [answers, setAnswers] = useState({});
  const [flagged, setFlagged] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saveState, setSaveState] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const elapsedRef = useRef(0);
  const resultRef = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setHydrated(false);
    api.exams.session(sessionId, controller.signal).then(data => {
      const nextSession = data.session;
      const local = nextSession?.status === 'in_progress' ? readLocalDraft(sessionId) : null;
      const useLocal = local?.savedAt && Date.parse(local.savedAt) > Date.parse(nextSession.updatedAt || 0);
      setPack(data.pack);
      setQuestions(data.questions || []);
      setSession(nextSession);
      setAnswers(useLocal ? local.answers || {} : nextSession.answers || {});
      setFlagged(useLocal ? local.flagged || [] : nextSession.flagged || []);
      setCurrentIndex(useLocal ? Number(local.currentIndex) || 0 : nextSession.currentIndex || 0);
      const seconds = useLocal ? Number(local.elapsedSeconds) || 0 : nextSession.elapsedSeconds || 0;
      elapsedRef.current = seconds;
      setElapsedSeconds(seconds);
      if (useLocal) setSaveState('已恢复本机离线草稿，联网后会同步');
      setHydrated(true);
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [sessionId]);

  useEffect(() => {
    if (!hydrated || session?.status !== 'in_progress') return undefined;
    const timer = window.setInterval(() => {
      setElapsedSeconds(value => {
        elapsedRef.current = value + 1;
        return value + 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hydrated, session?.status]);

  useEffect(() => {
    if (!hydrated || session?.status !== 'in_progress') return;
    try {
      localStorage.setItem(localDraftKey(sessionId), JSON.stringify({
        answers, flagged, currentIndex, elapsedSeconds: elapsedRef.current, savedAt: new Date().toISOString(),
      }));
    } catch (_) {
      // Local fallback is best-effort; the server remains the source of truth.
    }
  }, [answers, flagged, currentIndex, hydrated, session?.status, sessionId]);

  const progressPayload = useCallback(() => ({
    answers,
    flagged,
    currentIndex,
    elapsedSeconds: elapsedRef.current,
  }), [answers, flagged, currentIndex]);

  const sessionStatus = session?.status;

  const save = useCallback(async ({ silent = false } = {}) => {
    if (sessionStatus !== 'in_progress') return;
    if (!online) {
      if (!silent) setSaveState('当前离线，草稿暂存在本机');
      return;
    }
    if (!silent) setSaveState('正在保存…');
    try {
      const saved = await api.exams.save(sessionId, progressPayload());
      setSession(current => ({ ...current, ...(saved.session || saved) }));
      setSaveState(`云端已保存 · ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`);
    } catch (requestError) {
      setSaveState(`保存失败：${requestError.message}`);
    }
  }, [online, progressPayload, sessionId, sessionStatus]);

  useEffect(() => {
    if (!hydrated || sessionStatus !== 'in_progress') return undefined;
    const timer = window.setTimeout(() => save({ silent: true }), 800);
    return () => window.clearTimeout(timer);
  }, [answers, flagged, currentIndex, hydrated, save, sessionStatus]);

  const answeredCount = useMemo(() => questions.filter(question => hasAnswer(answers[question.id])).length, [answers, questions]);
  const questionById = useMemo(() => new Map(questions.map(item => [item.id, item])), [questions]);
  const question = questions[currentIndex] || null;
  const progress = questions.length ? Math.round(answeredCount / questions.length * 100) : 0;

  const chooseSingle = value => setAnswers(current => ({ ...current, [question.id]: String(value) }));
  const chooseMulti = value => setAnswers(current => {
    const existing = Array.isArray(current[question.id]) ? current[question.id] : [];
    const selected = existing.includes(String(value));
    const next = selected ? existing.filter(item => item !== String(value)) : [...existing, String(value)];
    if (!next.length) {
      const { [question.id]: removed, ...rest } = current;
      void removed;
      return rest;
    }
    return { ...current, [question.id]: next };
  });

  const go = index => setCurrentIndex(Math.max(0, Math.min(questions.length - 1, index)));
  const toggleFlag = () => setFlagged(current => current.includes(question.id) ? current.filter(id => id !== question.id) : [...current, question.id]);

  const submit = async () => {
    if (!online) return setError('联网后才能交卷；当前答案已保存在本机草稿。');
    const unanswered = questions.length - answeredCount;
    if (!window.confirm(unanswered ? `还有 ${unanswered} 题未作答，仍要交卷吗？` : '确认交卷并查看解析吗？')) return;
    setSubmitting(true); setError('');
    try {
      const data = await api.exams.submit(sessionId, progressPayload());
      setSession(data.session);
      setResult(data.result);
      localStorage.removeItem(localDraftKey(sessionId));
      window.setTimeout(() => resultRef.current?.focus(), 0);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSubmitting(false);
    }
  };

  const restart = async () => {
    setSubmitting(true); setError('');
    try {
      const data = await api.exams.start(pack.id);
      navigate(`/exams/session/${encodeURIComponent(data.session.id)}`, { replace: true });
    } catch (requestError) {
      setError(requestError.message);
    } finally { setSubmitting(false); }
  };

  if (loading) return <div className="page"><LoadingState rows={6} /></div>;
  if (error && !session) return <div className="page"><ErrorState message={error} onRetry={() => window.location.reload()} /></div>;
  if (!session || !pack || !question) return <div className="page"><ErrorState message="这套试卷暂时不可用" /></div>;

  const completed = session.status === 'submitted';

  return (
    <div className="exam-session-page">
      <header className="exam-session-bar">
        <Link to="/exams" className="exam-back-link"><Icon name="arrowLeft" size={18} />考试中心</Link>
        <div className="exam-session-title"><strong>{pack.title}</strong><span>{answeredCount}/{questions.length} 已答</span></div>
        <div className="exam-session-actions"><span className="exam-timer"><Icon name="clock" size={16} />{formatDuration(elapsedSeconds)}</span>{!completed && <button type="button" onClick={() => save()} disabled={!online}>保存</button>}<button className="exam-submit-button" type="button" onClick={completed ? restart : submit} disabled={submitting}>{completed ? '再做一遍' : submitting ? '交卷中…' : '交卷'}</button></div>
        <span className="exam-session-progress" role="progressbar" aria-label="整套试卷完成度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></span>
      </header>

      <div className="exam-session-layout">
        <main className="exam-question-card">
          <header>
            <div><span>{question.type === 'multi' ? '多项选择' : question.type === 'short' ? '简答题' : '单项选择'}</span><small>{question.difficulty}</small></div>
            <button className={flagged.includes(question.id) ? 'flagged' : ''} type="button" aria-pressed={flagged.includes(question.id)} onClick={toggleFlag} disabled={completed}><Icon name="bookmark" size={16} />{flagged.includes(question.id) ? '已标记' : '稍后检查'}</button>
          </header>
          <h1><span>{currentIndex + 1}.</span>{question.prompt}</h1>

          {question.options?.length ? <fieldset className="exam-native-options" disabled={completed}>
            <legend className="sr-only">选择答案</legend>
            {question.options.map((option, optionIndex) => {
              const value = String(optionIndex);
              const selected = question.type === 'multi'
                ? (Array.isArray(answers[question.id]) ? answers[question.id] : []).includes(value)
                : String(answers[question.id]) === value;
              return <label className={selected ? 'selected' : ''} key={`${question.id}-${value}`}>
                <input type={question.type === 'multi' ? 'checkbox' : 'radio'} name={question.id} value={value} checked={selected} onChange={() => question.type === 'multi' ? chooseMulti(value) : chooseSingle(value)} />
                <i aria-hidden="true">{String.fromCharCode(65 + optionIndex)}</i><span>{optionText(option)}</span>{selected && <Icon name="check" size={18} />}
              </label>;
            })}
          </fieldset> : <label className="exam-short-answer"><span>你的回答</span><textarea value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} placeholder="写下你的判断、依据和结论" disabled={completed} /></label>}

          <footer className="exam-question-nav">
            <button className="button secondary" type="button" onClick={() => go(currentIndex - 1)} disabled={currentIndex === 0}><Icon name="arrowLeft" size={17} />上一题</button>
            <span aria-live="polite">第 {currentIndex + 1} / {questions.length} 题</span>
            <button className="button primary" type="button" onClick={() => go(currentIndex + 1)} disabled={currentIndex === questions.length - 1}>下一题 <Icon name="chevronRight" size={17} /></button>
          </footer>
        </main>

        <aside className="exam-answer-panel">
          <header><div><h2>答题卡</h2><p>点击题号快速跳转</p></div><strong>{progress}%</strong></header>
          <nav aria-label="答题卡">{questions.map((item, index) => <button key={item.id} className={`${hasAnswer(answers[item.id]) ? 'answered' : ''}${flagged.includes(item.id) ? ' flagged' : ''}`} type="button" aria-current={index === currentIndex ? 'step' : undefined} aria-label={`第 ${index + 1} 题${hasAnswer(answers[item.id]) ? '，已作答' : '，未作答'}${flagged.includes(item.id) ? '，已标记' : ''}`} onClick={() => go(index)}>{index + 1}</button>)}</nav>
          <div className="exam-answer-legend"><span><i className="answered" />已答</span><span><i />未答</span><span><i className="flagged" />标记</span></div>
          {!completed && <button className="button primary full" type="button" onClick={submit} disabled={submitting || !online}>{submitting ? '正在交卷…' : '提交整套试卷'}</button>}
          <p className={`exam-save-state${saveState.startsWith('保存失败') ? ' error' : ''}`} role="status" aria-live="polite">{saveState || (online ? '修改后自动保存到云端' : '离线草稿保存在本机')}</p>
        </aside>
      </div>

      {error && <div className="exam-session-error" role="alert">{error}</div>}

      {(result || completed) && <section className="exam-submit-result" ref={resultRef} tabIndex="-1" aria-live="polite">
        <header><span><Icon name="checkCircle" size={30} /></span><div><small>本次成绩</small><h2>{result?.score ?? session.score} 分</h2><p>{result?.summary || `答对 ${session.correctCount} / ${session.totalQuestions} 题，成绩已保存到云端。`}</p></div><button className="button secondary" type="button" onClick={restart} disabled={submitting}>再做一遍</button></header>
        {result?.items?.length > 0 && <div className="exam-result-list">{result.items.map((item, index) => <article className={item.correct ? 'correct' : 'wrong'} key={item.questionId}><header><strong>{index + 1}. {item.correct ? '回答正确' : `得分 ${item.score}`}</strong><span>{item.correct ? '已掌握' : '已加入错题复习'}</span></header><p>{item.prompt}</p><div><span>你的回答：{displayAnswer(item.response, questionById.get(item.questionId)) || '未作答'}</span><span>参考答案：{displayAnswer(item.referenceAnswer)}</span></div><small>{item.explanation}</small></article>)}</div>}
      </section>}
    </div>
  );
}
