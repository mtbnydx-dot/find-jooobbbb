import { useMemo, useRef } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { api } from '../lib/api';
import { useOnline } from '../hooks/useOnline';
import { QuestionSource } from '../components/QuestionSource';
import { useAuth } from '../context/AuthContext';
import { useExamProgress } from '../hooks/useExamProgress';
import '../styles/prep-library.css';

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

export function ExamSessionPage() {
  const { sessionId } = useParams();
  const { user } = useAuth();
  return <ExamSession key={`${user.id}:${sessionId}`} userId={user.id} sessionId={sessionId} />;
}

function ExamSession({ userId, sessionId }) {
  const navigate = useNavigate();
  const online = useOnline();
  const { pack, questions, session, answers, flagged, currentIndex, elapsedSeconds, result, loading, error, setError, saveState, submitting, setSubmitting, setAnswers, setFlagged, setCurrentIndex, save, submitProgress, conflict, resolveConflict, load } = useExamProgress(userId, sessionId, online);
  const resultRef = useRef(null);

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
    if (await submitProgress()) window.setTimeout(() => resultRef.current?.focus(), 0);
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
  if (error && !session) return <div className="page"><ErrorState message={error} onRetry={() => load()} /></div>;
  if (!session || !pack || !question) return <div className="page"><ErrorState message="这套试卷暂时不可用" /></div>;

  const completed = session.status === 'submitted';

  return (
    <div className="exam-session-page">
      <header className="exam-session-bar">
        <Link to="/exams" className="exam-back-link"><Icon name="arrowLeft" size={18} />考试中心</Link>
        <div className="exam-session-title"><strong>{pack.title}</strong><span>{answeredCount}/{questions.length} 已答</span></div>
        <div className="exam-session-actions"><span className="exam-timer" title="本次打开期间按实际经过时间计时，切后台也计入"><Icon name="clock" size={16} />{formatDuration(elapsedSeconds)}</span>{!completed && <button type="button" onClick={() => save({ retry: true })} disabled={!online || submitting || Boolean(conflict)}>同步 / 重试</button>}<button className="exam-submit-button" type="button" onClick={completed ? restart : submit} disabled={submitting || !online || Boolean(conflict)}>{completed ? '再做一遍' : submitting ? '交卷中…' : '交卷'}</button></div>
        <span className="exam-session-progress" role="progressbar" aria-label="整套试卷完成度" aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress}><i style={{ width: `${progress}%` }} /></span>
      </header>

      {conflict && <section className="exam-session-error" role="alert"><strong>云端进度与本机不一致</strong><p>已暂停自动同步，不会悄悄覆盖其他设备。本机回答仍在，请选择保留哪份进度。</p><div className="workspace-actions"><button className="button secondary" disabled={!online || submitting} onClick={() => resolveConflict(false)}>载入云端进度</button><button className="button secondary" disabled={!online || submitting} onClick={() => resolveConflict(true)}>保留本机并同步</button></div></section>}

      <div className="exam-session-layout">
        <main className="exam-question-card">
          <header>
            <div><span>{question.type === 'multi' ? '多项选择' : question.type === 'short' ? '简答题' : '单项选择'}</span><small>{question.difficulty}</small></div>
            <button className={flagged.includes(question.id) ? 'flagged' : ''} type="button" aria-pressed={flagged.includes(question.id)} onClick={toggleFlag} disabled={completed || submitting}><Icon name="bookmark" size={16} />{flagged.includes(question.id) ? '已标记' : '稍后检查'}</button>
          </header>
          <h1><span>{currentIndex + 1}.</span>{question.prompt}</h1>
          <QuestionSource question={question} />

          {question.options?.length ? <fieldset className="exam-native-options" disabled={completed || submitting}>
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
          </fieldset> : <label className="exam-short-answer"><span>你的回答</span><textarea value={answers[question.id] || ''} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} placeholder="写下你的判断、依据和结论" disabled={completed || submitting} /></label>}

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
          {!completed && <button className="button primary full" type="button" onClick={submit} disabled={submitting || !online || Boolean(conflict)}>{submitting ? '正在交卷…' : '提交整套试卷'}</button>}
          <p className={`exam-save-state${saveState.startsWith('保存失败') ? ' error' : ''}`} role="status" aria-live="polite">{saveState || (online ? '修改后自动保存到云端' : '离线草稿保存在本机')}</p>
        </aside>
      </div>

      {error && <div className="exam-session-error" role="alert">{error}</div>}

      {(result || completed) && <section className="exam-submit-result" ref={resultRef} tabIndex="-1" aria-live="polite">
        <header><span><Icon name="checkCircle" size={30} /></span><div><small>本次成绩</small><h2>{result?.score ?? session.score} 分</h2><p>{result?.summary || `答对 ${session.correctCount} / ${session.totalQuestions} 题，成绩已保存到云端。`}</p></div><button className="button secondary" type="button" onClick={restart} disabled={submitting}>再做一遍</button></header>
        {result?.items?.length > 0 && <div className="exam-result-list">{result.items.map((item, index) => <article className={item.correct ? 'correct' : 'wrong'} key={item.questionId}><header><strong>{index + 1}. {item.correct ? '回答正确' : `得分 ${item.score}`}</strong><span>{item.correct ? '已掌握' : '已加入错题复习'}</span></header><p>{item.prompt}</p><QuestionSource question={item} /><div><span>你的回答：{displayAnswer(item.response, questionById.get(item.questionId)) || '未作答'}</span><span>参考答案：{displayAnswer(item.referenceAnswer)}</span></div><small>{item.explanation}</small></article>)}</div>}
      </section>}
    </div>
  );
}
