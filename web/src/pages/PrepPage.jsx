import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';

function optionText(option) {
  return typeof option === 'string' ? option : option?.text || option?.label || '';
}

function referenceText(answer) {
  if (Array.isArray(answer)) return answer.join('、');
  if (answer && typeof answer === 'object') return answer.sample || (answer.keywords ? `关键词：${answer.keywords.join('、')}` : JSON.stringify(answer));
  return String(answer ?? '');
}

function isEntitlementLimit(error) {
  return [error?.details?.code, error?.details?.error?.code].includes('ENTITLEMENT_LIMIT');
}

export function PrepPage() {
  const online = useOnline();
  const [tracks, setTracks] = useState([]);
  const [selectedTrack, setSelectedTrack] = useState('');
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [error, setError] = useState('');
  const [quotaLimited, setQuotaLimited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setQuotaLimited(false);
    api.prep.tracks(controller.signal).then(data => {
      const list = listPayload(data, 'tracks').items;
      setTracks(list);
      setSelectedTrack(current => current || list[0]?.id || list[0]?.slug || 'general');
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [reloadKey]);

  const loadQuestions = useCallback((trackId, signal) => {
    setQuestionLoading(true); setQuestions([]); setResult(null); setAnswers({}); setError(''); setQuotaLimited(false);
    return api.prep.questions({ trackId, limit: 5, daily: 1 }, signal).then(data => setQuestions(listPayload(data, 'questions').items)).catch(requestError => {
      if (requestError.name !== 'AbortError') {
        setError(requestError.message);
        setQuotaLimited(isEntitlementLimit(requestError));
      }
    }).finally(() => setQuestionLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedTrack) return undefined;
    const controller = new AbortController();
    loadQuestions(selectedTrack, controller.signal);
    return () => controller.abort();
  }, [selectedTrack, loadQuestions]);

  const currentTrack = useMemo(() => tracks.find(track => (track.id || track.slug) === selectedTrack), [tracks, selectedTrack]);
  const completed = questions.filter((question, index) => {
    const answer = answers[String(question.id || index)];
    if (Array.isArray(answer)) return answer.length > 0;
    return answer !== undefined && answer !== null && String(answer).trim() !== '';
  }).length;

  const submit = async () => {
    if (completed < questions.length) return setError('请完成全部题目后再提交');
    setSubmitting(true); setError(''); setQuotaLimited(false);
    try {
      const payload = { trackId: selectedTrack, answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })) };
      const data = await api.prep.submit(payload);
      setResult(data?.result || data);
      try {
        const trackData = await api.prep.tracks();
        setTracks(listPayload(trackData, 'tracks').items);
      } catch (_) {
        // The submitted result stays visible even if the non-critical progress refresh fails.
      }
    } catch (requestError) {
      setError(requestError.message);
      setQuotaLimited(isEntitlementLimit(requestError));
    } finally { setSubmitting(false); }
  };

  if (loading) return <div className="page"><LoadingState rows={5} /></div>;
  if (error && !tracks.length) return <div className="page"><ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  return (
    <div className="page prep-page">
      <header className="page-header"><div><h1>备考中心</h1><p>按目标岗位和专业方向安排练习，逐步补齐知识与表达短板。</p></div><div className="practice-streak"><strong>{currentTrack?.streak || 0}</strong><span>连续练习天数</span></div></header>
      <div className="prep-layout">
        <aside className="prep-tracks">
          <h2>备考方向</h2>
          <nav>{tracks.map(track => {
            const id = track.id || track.slug;
            return <button key={id} className={selectedTrack === id ? 'active' : ''} type="button" aria-pressed={selectedTrack === id} onClick={() => setSelectedTrack(id)}><span><Icon name={track.icon || 'book'} size={19} />{track.name || track.title}</span>{track.locked ? <Icon name="lock" size={15} /> : <small>{track.recommended ? '推荐' : `${track.progress || 0}%`}</small>}</button>;
          })}</nav>
          <Link to="/pricing"><Icon name="crown" size={17} />解锁全部备考方向</Link>
        </aside>
        <section className="quiz-workspace">
          <header className="quiz-heading">
            <div><span>今日练习</span><h2>{currentTrack?.name || currentTrack?.title || '综合能力训练'}</h2><p>{questions.length} 题 · 预计 {currentTrack?.minutes || 8} 分钟</p></div>
            <div className="quiz-progress"><strong>{completed}/{questions.length}</strong><span role="progressbar" aria-label="答题进度" aria-valuemin="0" aria-valuemax={questions.length} aria-valuenow={completed}><i style={{ width: `${questions.length ? (completed / questions.length) * 100 : 0}%` }} /></span></div>
          </header>

          {currentTrack?.locked ? <div className="locked-content"><span><Icon name="lock" size={28} /></span><h2>该方向属于专业版题库</h2><p>升级后可使用完整题目、参考解析和答题进度。</p><Link className="button primary" to="/pricing">查看专业版权益</Link></div> : questionLoading ? <LoadingState rows={3} compact /> : questions.length ? <div className="question-list">
            {questions.map((question, index) => {
              const id = String(question.id || index);
              const options = question.options || question.choices || [];
              const isMulti = question.type === 'multi';
              return <article className="question-item" key={id}>
                <header><span>{index + 1}</span><div><h3>{question.title || question.question || question.prompt}</h3><p>{question.typeLabel || question.category || (isMulti ? '多项选择' : question.type === 'short' ? '简答题' : '单项选择')}</p></div></header>
                {options.length ? <fieldset className="question-options native-question-options" disabled={Boolean(result)}><legend className="sr-only">选择答案</legend>{options.map((option, optionIndex) => {
                  const value = typeof option === 'object' ? option.value ?? optionIndex : optionIndex;
                  const selected = isMulti
                    ? (Array.isArray(answers[id]) ? answers[id] : []).some(item => String(item) === String(value))
                    : String(answers[id]) === String(value);
                  const choose = () => {
                    if (result) return;
                    setAnswers(current => {
                    if (!isMulti) return { ...current, [id]: value };
                    const existing = Array.isArray(current[id]) ? current[id] : [];
                    const next = selected ? existing.filter(item => String(item) !== String(value)) : [...existing, value];
                    if (!next.length) {
                      const { [id]: removed, ...rest } = current;
                      void removed;
                      return rest;
                    }
                    return { ...current, [id]: next };
                    });
                  };
                  return <label className={selected ? 'selected' : ''} key={`${id}-${value}`}><input type={isMulti ? 'checkbox' : 'radio'} name={id} value={value} checked={selected} onChange={choose} /><i aria-hidden="true">{String.fromCharCode(65 + optionIndex)}</i><span>{optionText(option)}</span>{selected && <Icon name="check" size={16} />}</label>;
                })}</fieldset> : <label className="field"><span className="sr-only">你的回答</span><textarea value={answers[id] || ''} onChange={event => setAnswers(current => ({ ...current, [id]: event.target.value }))} placeholder="写下你的思路或答案" disabled={Boolean(result)} /></label>}
              </article>;
            })}
            {error && <div className={`form-error${quotaLimited ? ' quota-error' : ''}`} role="alert"><span>{error}</span>{quotaLimited && <Link to="/pricing">查看套餐与练习额度</Link>}</div>}
            {!result ? <button className="button primary quiz-submit" type="button" onClick={submit} disabled={submitting || !online}>{submitting ? '正在提交…' : '提交并查看解析'}</button> : <div className="quiz-result" role="status"><span><Icon name="checkCircle" size={28} /></span><div><h2>本次练习已完成</h2><p>{result.summary || `得分 ${result.score ?? 0} 分，正确 ${result.correctCount ?? 0} / ${questions.length} 题。`}</p></div><button className="button secondary" type="button" onClick={() => loadQuestions(selectedTrack)}>重新练习</button>{Array.isArray(result.items) && result.items.length > 0 && <div className="quiz-explanations">{result.items.map((item, index) => <article className="quiz-explanation" key={item.questionId || index}><h3>{index + 1}. {item.correct ? '回答正确' : `得分 ${item.score ?? 0}`}</h3><p>{item.explanation || '暂无补充解析。'}</p>{referenceText(item.referenceAnswer) && <small>参考答案：{referenceText(item.referenceAnswer)}</small>}</article>)}</div>}</div>}
          </div> : quotaLimited ? <div className="locked-content"><span><Icon name="lock" size={28} /></span><h2>今日练习额度已用完</h2><p>{error || '升级套餐可获得更高的每日练习额度。'}</p><Link className="button primary" to="/pricing">查看套餐与练习额度</Link></div> : <EmptyState title="这个方向暂时没有可用题目" description="内容团队正在补充题库，你可以先选择其他备考方向。" icon="book" />}
        </section>
      </div>
    </div>
  );
}
