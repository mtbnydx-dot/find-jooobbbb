import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';
import { QuestionSource } from '../components/QuestionSource';
import '../styles/prep-library.css';

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
  const [params, setParams] = useSearchParams();
  const examType = params.get('examType') || 'job_general';
  const section = params.get('section') || '';
  const contentKind = params.get('contentKind') || '';
  const [library, setLibrary] = useState({ examTypes: [], contentKinds: [], sources: [] });
  const [tracks, setTracks] = useState([]);
  const [selectedTrack, setSelectedTrack] = useState('');
  const [questions, setQuestions] = useState([]);
  const [answers, setAnswers] = useState({});
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(true);
  const [questionLoading, setQuestionLoading] = useState(false);
  const [cursorTrail, setCursorTrail] = useState(['']);
  const [pageIndex, setPageIndex] = useState(0);
  const [questionPage, setQuestionPage] = useState({ total: 0, nextCursor: '' });
  const [error, setError] = useState('');
  const [quotaLimited, setQuotaLimited] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setQuotaLimited(false);
    Promise.all([api.prep.tracks(controller.signal), api.prep.library(controller.signal)]).then(([data, inventory]) => {
      const list = listPayload(data, 'tracks').items;
      setTracks(list); setLibrary(inventory);
      setSelectedTrack(current => current || list[0]?.id || list[0]?.slug || 'general');
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [reloadKey]);

  const loadQuestions = useCallback((trackId, signal, cursor = '') => {
    setQuestionLoading(true); setQuestions([]); setResult(null); setAnswers({}); setError(''); setQuotaLimited(false);
    return api.prep.questions({ trackId: examType === 'job_general' ? trackId : '', examType, section, contentKind, limit: 5, cursor }, signal).then(data => {
      if (signal?.aborted) return;
      setQuestions(listPayload(data, 'questions').items);
      setQuestionPage({ total: Number(data.total) || 0, nextCursor: data.nextCursor || '' });
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') {
        setError(requestError.message);
        setQuotaLimited(isEntitlementLimit(requestError));
      }
    }).finally(() => { if (!signal?.aborted) setQuestionLoading(false); });
  }, [examType, section, contentKind]);

  useEffect(() => { setCursorTrail(['']); setPageIndex(0); setQuestionPage({ total: 0, nextCursor: '' }); }, [examType, section, contentKind]);

  const cursor = cursorTrail[pageIndex] || '';
  useEffect(() => {
    if (!selectedTrack) return undefined;
    const controller = new AbortController();
    loadQuestions(selectedTrack, controller.signal, cursor);
    return () => controller.abort();
  }, [selectedTrack, cursor, loadQuestions]);

  const currentTrack = useMemo(() => examType === 'job_general' ? tracks.find(track => (track.id || track.slug) === selectedTrack) : null, [tracks, selectedTrack, examType]);
  const currentGroup = library.examTypes?.find(group => group.value === examType);
  const currentSection = currentGroup?.sections?.find(item => item.value === section);
  const completed = questions.filter((question, index) => {
    const answer = answers[String(question.id || index)];
    if (Array.isArray(answer)) return answer.length > 0;
    return answer !== undefined && answer !== null && String(answer).trim() !== '';
  }).length;

  const changeTrack = id => {
    if (submitting || questionLoading || id === selectedTrack) return;
    if (completed && !result && !window.confirm('当前这组回答还未提交，切换方向会清空回答。确定继续吗？')) return;
    setCursorTrail(['']); setPageIndex(0); setQuestionPage({ total: 0, nextCursor: '' }); setSelectedTrack(id);
  };
  const changePage = direction => {
    if (submitting || questionLoading || (direction > 0 && !questionPage.nextCursor) || (direction < 0 && pageIndex === 0)) return;
    if (completed && !result && !window.confirm('当前这组回答还未提交，翻组会清空回答。确定继续吗？')) return;
    if (direction > 0) setCursorTrail(current => [...current.slice(0, pageIndex + 1), questionPage.nextCursor]);
    setPageIndex(current => current + direction);
  };
  const changeFilters = values => {
    if (submitting || questionLoading) return;
    if (completed && !result && !window.confirm('当前回答还未提交，更改筛选会清空回答。确定继续吗？')) return;
    const next = { examType, section, contentKind, ...values };
    setCursorTrail(['']); setPageIndex(0);
    setParams(Object.fromEntries(Object.entries(next).filter(([, value]) => value)));
  };

  const submit = async () => {
    if (completed < questions.length) return setError('请完成全部题目后再提交');
    setSubmitting(true); setError(''); setQuotaLimited(false);
    try {
      const payload = { ...(examType === 'job_general' ? { trackId: selectedTrack } : {}), answers: Object.entries(answers).map(([questionId, answer]) => ({ questionId, answer })) };
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
      <header className="page-header"><div><h1>{examType === 'xingce' ? '行测专项练习' : examType === 'job_general' ? '原创求职练习' : currentGroup?.label || '专项练习'}</h1><p>题源、知识板块和真实题量分别展示；求职面试练习不计入行测题库。</p></div><Link className="button secondary" to="/exams">考试中心</Link></header>
      <nav className="prep-category-tabs" aria-label="考试类型">{(library.examTypes || []).map(group => <Link key={group.value} to={`/prep?examType=${encodeURIComponent(group.value)}`} aria-current={group.value === examType ? 'page' : undefined} onClick={event => { event.preventDefault(); changeFilters({ examType: group.value, section: '', contentKind: '' }); }}>{group.label}<small>{group.count} 题</small></Link>)}</nav>
      <section className="prep-library-intro"><div><strong>{currentGroup?.label || '当前分类'} · 已发布 {currentGroup?.count ?? 0} 题</strong><p>{examType === 'job_general' ? '现有内容为原创求职与专业基础练习，不是公务员考试真题或行测题库。' : examType === 'xingce' ? '按行测六个知识板块组织。真题、官方样题、原创模拟分别标注；未入库的板块如实显示 0 题。' : '仅展示实际发布的练习与官方资料入口，不用其他考试题目填充题量。'}</p>{currentGroup?.availableCount !== undefined && <p>当前套餐可练习 {currentGroup.availableCount} 题；下方题量随筛选更新。</p>}{tracks.some(track => track.examType === examType && track.freeAccess) && <p>免费体验路径：不占原有路径名额，答题仍计入每日练习额度。</p>}</div><label className="field"><span>题目来源</span><select value={contentKind} disabled={submitting || questionLoading} onChange={event => changeFilters({ contentKind: event.target.value })}><option value="">全部来源</option>{(library.contentKinds || []).map(kind => <option key={kind.value} value={kind.value}>{kind.label}</option>)}</select></label></section>
      <div className="prep-layout">
        <aside className="prep-tracks">
          <h2>{examType === 'job_general' ? '求职方向' : '知识板块'}</h2>
          {examType === 'job_general' ? <nav>{tracks.filter(track => !track.examType || track.examType === 'job_general').map(track => {
            const id = track.id || track.slug;
            return <button key={id} className={selectedTrack === id ? 'active' : ''} type="button" disabled={submitting || questionLoading} aria-pressed={selectedTrack === id} onClick={() => changeTrack(id)}><span><Icon name={track.icon || 'book'} size={19} />{track.name || track.title}</span>{track.locked ? <Icon name="lock" size={15} /> : <small>{track.totalQuestions || 0} 题</small>}</button>;
          })}</nav> : <nav><button type="button" className={!section ? 'active' : ''} disabled={submitting || questionLoading} onClick={() => changeFilters({ section: '' })}><span>全部板块</span><small>{currentGroup?.count ?? 0} 题</small></button>{(currentGroup?.sections || []).map(item => <button type="button" key={item.value} className={section === item.value ? 'active' : ''} disabled={submitting || questionLoading} onClick={() => changeFilters({ section: item.value })}><span>{item.label}</span><small>{item.count} 题</small></button>)}</nav>}
          <Link to="/pricing"><Icon name="crown" size={17} />查看练习权限与额度</Link>
        </aside>
        <section className="quiz-workspace">
          <header className="quiz-heading">
            <div><span>分组练习 · 第 {pageIndex + 1} 组</span><h2>{currentTrack?.name || currentTrack?.title || currentSection?.label || currentGroup?.label || '专项练习'}</h2><p>本组 {questions.length} 题 · 当前筛选共 {questionPage.total} 题</p></div>
            <div className="quiz-progress"><strong>{completed}/{questions.length}</strong><span role="progressbar" aria-label="答题进度" aria-valuemin="0" aria-valuemax={questions.length} aria-valuenow={completed}><i style={{ width: `${questions.length ? (completed / questions.length) * 100 : 0}%` }} /></span></div>
          </header>

          {currentTrack?.locked ? <div className="locked-content"><span><Icon name="lock" size={28} /></span><h2>该方向属于专业版题库</h2><p>升级后可使用完整题目、参考解析和答题进度。</p><Link className="button primary" to="/pricing">查看专业版权益</Link></div> : questionLoading ? <LoadingState rows={3} compact /> : questions.length ? <div className="question-list">
            {questions.map((question, index) => {
              const id = String(question.id || index);
              const options = question.options || question.choices || [];
              const isMulti = question.type === 'multi';
              return <article className="question-item" key={id}>
                <header><span>{index + 1}</span><div><h3>{question.title || question.question || question.prompt}</h3><p>{question.typeLabel || question.category || (isMulti ? '多项选择' : question.type === 'short' ? '简答题' : '单项选择')}</p></div></header>
                <QuestionSource question={question} />
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
            {!result ? <button className="button primary quiz-submit" type="button" onClick={submit} disabled={submitting || !online}>{submitting ? '正在提交…' : '提交并查看解析'}</button> : <div className="quiz-result" role="status"><span><Icon name="checkCircle" size={28} /></span><div><h2>本次练习已完成</h2><p>{result.summary || `得分 ${result.score ?? 0} 分，正确 ${result.correctCount ?? 0} / ${questions.length} 题。`}</p></div><button className="button secondary" type="button" onClick={() => loadQuestions(selectedTrack, undefined, cursor)}>重做本组</button>{Array.isArray(result.items) && result.items.length > 0 && <div className="quiz-explanations">{result.items.map((item, index) => <article className="quiz-explanation" key={item.questionId || index}><h3>{index + 1}. {item.correct ? '回答正确' : `得分 ${item.score ?? 0}`}</h3><QuestionSource question={item} /><p>{item.explanation || '暂无补充解析。'}</p>{referenceText(item.referenceAnswer) && <small>参考答案：{referenceText(item.referenceAnswer)}</small>}</article>)}</div>}</div>}
          </div> : quotaLimited ? <div className="locked-content"><span><Icon name="lock" size={28} /></span><h2>当前练习权限或额度不足</h2><p>{error || '请查看当前套餐的练习范围与剩余额度。'}</p><Link className="button primary" to="/pricing">查看套餐与练习额度</Link></div> : error ? <ErrorState message={error} onRetry={() => loadQuestions(selectedTrack, undefined, cursor)} /> : <EmptyState title="当前筛选下暂无已发布题目" description={examType === 'xingce' ? '行测题目尚未按此条件入库。下方可直接查看官方大纲与例题，不会把通用求职题当成行测题。' : '可以调整题源或方向筛选。题量只统计已发布内容，不包含外部资料链接。'} icon="book" />}
          {!currentTrack?.locked && (questionPage.total > 5 || pageIndex > 0) && <nav className="commerce-pagination" aria-label="练习分组"><button className="button secondary" type="button" disabled={submitting || questionLoading || pageIndex === 0} onClick={() => changePage(-1)}>上一组</button><span className="commerce-caption">第 {pageIndex + 1} 组 · 共 {questionPage.total} 题</span><button className="button secondary" type="button" disabled={submitting || questionLoading || !questionPage.nextCursor} onClick={() => changePage(1)}>下一组</button></nav>}
        </section>
      </div>
      {(library.sources || []).some(source => source.examType === examType) && <section className="prep-official-sources"><h2>官方大纲与例题</h2><p>以下为官方站点的外部资料，可直接学习与核对考试范围；尚未复制入本站题库，不计入题量，也不代表已获得转载授权。</p><div className="prep-source-links">{library.sources.filter(source => source.examType === examType && /^https?:\/\//i.test(source.url || '')).map(source => <a key={source.id} href={source.url} target="_blank" rel="noopener noreferrer"><strong>{source.title} ↗</strong><small>{source.publisher} · {source.year} 年</small><small>{source.description}</small><small>外部参考资料 · 官方大纲与例题</small></a>)}</div></section>}
    </div>
  );
}
