import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Cell, Empty, Notice, Page, Sheet, TopBar } from '../components/UI';
import Icon from '../components/Icon';
import { api, newRequestKey, request } from '../lib/api';
import { useMobile, useResource } from '../lib/runtime';
import { answerText, chooseAnswer, hasAnswer, optionText, optionValue, sourceLabels } from './prep-helpers';
import { useMobileExam } from './useMobileExam';
import './prep.css';

const linkTo = (path, values) => `${path}?${new URLSearchParams(Object.entries(values).filter(([, value]) => value !== '' && value != null))}`;
const dateText = value => value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '';
function ErrorNotice({ error, retry }) {
  if (!error) return null;
  const limited = error?.code === 'ENTITLEMENT_LIMIT' || error?.status === 403;
  return <div className="mobile-prep-error" role="alert"><p>{error.message || error}</p>{limited ? <Link to="/membership">查看套餐与练习额度</Link> : null}{retry ? <Button variant="outline" onClick={retry}>重试</Button> : null}</div>;
}
function ResourceStatus({ resource, title = '备考' }) {
  return <Page title={title}>{resource.loading ? <p className="loading-text" role="status">正在加载真实题库与记录…</p> : <ErrorNotice error={resource.error} retry={resource.reload}/>}</Page>;
}
function Source({ question }) {
  const source = question?.provenance;
  return <div className="mobile-question-source"><span className="tag">{sourceLabels[source?.contentKind] || source?.label || '来源待核验'}</span>{source?.sourceTitle ? <small>{source.sourceTitle}</small> : null}{source?.year ? <small>{source.year} 年{source.region ? ` · ${source.region}` : ''}{source.questionNumber ? ` · 第 ${source.questionNumber} 题` : ''}</small> : null}{/^https?:\/\//i.test(source?.sourceUrl || '') ? <a href={source.sourceUrl} target="_blank" rel="noopener noreferrer">查看原始题源 ↗</a> : null}</div>;
}
function Bookmark({ question }) {
  const resource = useResource(signal => request(`/me/prep/bookmarks/${encodeURIComponent(question.id)}`, { signal }), [question.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const flight = useRef(false);
  const saved = resource.data?.saved;
  const change = async () => {
    if (flight.current || saved === undefined) return;
    flight.current = true; setBusy(true); setError(null);
    try { const result = await request(`/me/prep/bookmarks/${encodeURIComponent(question.id)}`, { method: 'PUT', body: { saved: !saved } }); resource.setData(result); }
    catch (err) { setError(err); }
    finally { flight.current = false; setBusy(false); }
  };
  return <div className="mobile-bookmark"><button className="text-link" onClick={change} disabled={busy || saved === undefined}><Icon name="bookmark" size={16}/>{busy ? '正在保存…' : resource.loading ? '读取收藏状态…' : saved ? '已收藏 · 取消' : '收藏本题'}</button><ErrorNotice error={error || resource.error} retry={resource.error ? resource.reload : undefined}/></div>;
}
function QuestionOptions({ question, answer, onChange, disabled = false }) {
  if (!question.options?.length) return <label className="field"><span>你的回答</span><textarea rows={6} maxLength={5000} value={answer || ''} disabled={disabled} onChange={event => onChange(event.target.value)} placeholder="写下你的思路或答案"/></label>;
  const multi = question.type === 'multi';
  return <div className="answer-options" role={multi ? 'group' : 'radiogroup'} aria-label={multi ? '选择所有正确选项' : '选择答案'}>{question.options.map((option, index) => {
    const value = optionValue(option, index);
    const selected = multi ? (Array.isArray(answer) ? answer : []).map(String).includes(value) : hasAnswer(answer) && String(answer) === value;
    return <button role={multi ? 'checkbox' : 'radio'} aria-checked={selected} className={`answer-option ${selected ? 'selected' : ''}`} key={`${question.id}-${value}`} onClick={() => onChange(chooseAnswer(question, answer, value))} disabled={disabled}><span>{String.fromCharCode(65 + index)}</span><strong>{optionText(option)}</strong>{selected ? <Icon name="check"/> : null}</button>;
  })}</div>;
}
function Analysis({ item, question }) {
  return <section className="answer-analysis" aria-live="polite"><h2>{item.correct ? '回答正确' : `本题得分 ${item.score ?? 0}`}</h2><p>你的答案：{answerText(question, item.response)}</p><p>参考答案：{answerText(question, item.referenceAnswer)}</p><p>{item.explanation || '暂无补充解析'}</p><small>由服务器评分；简答题采用当前题库评分规则，不等同人工阅卷。</small></section>;
}

export function PrepHome() {
  const navigate = useNavigate();
  const resource = useResource(async signal => {
    const [library, tracks, summary, wrong] = await Promise.all([api.prep.library(signal), api.prep.tracks(signal), api.exams.summary(signal), request('/me/prep/wrong?limit=1', { signal })]);
    return { library, tracks: tracks.tracks || [], summary: summary.summary, wrongCount: wrong.total };
  }, []);
  if (!resource.data) return <ResourceStatus resource={resource}/>;
  const { library, tracks, summary, wrongCount } = resource.data;
  const xingce = library.examTypes.find(item => item.value === 'xingce');
  return <><TopBar/><main className="page prep-home mobile-prep"><h1>每天一点，更近一步</h1><p className="page-subtitle">有方向地练习，把薄弱项练扎实。</p><button className="prep-feature" onClick={() => navigate('/prep/sections?examType=xingce')}><div><span className="tag">已发布题库 · 题源逐题标注</span><h2>行测 · 分科练习</h2><p>{xingce?.count || 0} 道已发布 · 当前套餐可练 {xingce?.availableCount || 0} 道</p></div><Icon name="chevron"/></button><div className="prep-actions"><Link to="/wrongbook"><Icon name="refresh"/><strong>我的错题</strong><small>{wrongCount} 道待复习</small></Link><Link to="/bookmarks"><Icon name="bookmark"/><strong>收藏题目</strong><small>你的云端收藏</small></Link></div><section className="plain-section"><div className="section-title"><h2>专项练习</h2><span className="caption">已发布共 {library.total} 题</span></div><div className="cell-group">{library.examTypes.map(group => <Cell key={group.value} icon="file" label={group.label} detail={`${group.count} 道已发布 · 可练 ${group.availableCount} 道`} to={linkTo('/prep/sections', { examType: group.value })}/>)}</div></section><section className="plain-section"><div className="section-title"><h2>适合你的求职方向</h2></div><div className="cell-group">{tracks.filter(track => track.examType !== 'xingce').map(track => <Cell key={track.id} icon="file" label={track.title} detail={`${track.totalQuestions} 题 · 已练 ${track.completedQuestions} 题${track.locked ? ' · 当前套餐未解锁' : ''}`} to={linkTo('/practice', { trackId: track.id })}/>)}</div></section><div className="cell-group"><Cell icon="clock" label="模拟考试与进度" detail={`${summary.inProgress} 场待完成 · ${summary.submitted} 场已交卷`} to="/exam"/></div>{summary.recent?.length ? <section className="plain-section"><h2>最近考试</h2>{summary.recent.map(session => <Cell key={session.id} icon="clipboard" label={session.packTitle} detail={session.status === 'submitted' ? `${session.score} 分 · ${dateText(session.submittedAt)}` : '云端进度可继续'} to={linkTo(session.status === 'submitted' ? '/exam/result' : '/exam/session', { id: session.id })}/>)}</section> : null}<Notice>题量只统计已发布题目。原创模拟不是真题，外部大纲不计入题库；成绩与个人记录来自当前账户。</Notice><ErrorNotice error={resource.error} retry={resource.reload}/></main></>;
}

export function SectionPage() {
  const [params] = useSearchParams();
  const examType = params.get('examType') || 'xingce';
  const [kind, setKind] = useState('');
  const resource = useResource(signal => api.prep.library(signal), []);
  if (!resource.data) return <ResourceStatus resource={resource} title="专项练习"/>;
  const group = resource.data.examTypes.find(item => item.value === examType);
  return <Page title={group?.label || '专项练习'} className="mobile-prep"><h1>选择练习方向</h1><p className="muted">{group?.count || 0} 道已发布 · 套餐可练 {group?.availableCount || 0} 道</p><label className="field"><span>题目来源</span><select value={kind} onChange={event => setKind(event.target.value)}><option value="">全部来源</option>{resource.data.contentKinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><div className="cell-group"><Cell icon="file" label="全部板块" detail="每组 5 题，可继续下一组" to={linkTo('/practice', { examType, contentKind: kind })}/>{(group?.sections || []).map(section => <Cell key={section.value} icon="file" label={section.label} detail={`${section.count} 道已发布 · 可练 ${section.availableCount} 道`} to={linkTo('/practice', { examType, section: section.value, contentKind: kind })}/>)}</div><Notice>板块数量为全部题源合计；进入练习后按选定题源筛选。零题板块不会用其他方向的题目补数。</Notice>{resource.data.sources.filter(source => source.examType === examType && /^https?:\/\//i.test(source.url)).map(source => <a className="mobile-official-source" key={source.id} href={source.url} target="_blank" rel="noopener noreferrer"><strong>{source.title} ↗</strong><small>{source.publisher} · 外部官方资料，不计题量</small></a>)}</Page>;
}

export function Practice() {
  const { user } = useMobile();
  const [params] = useSearchParams();
  return <PracticeGroup key={`${user.id}:${params.toString()}`} params={params}/>;
}
function PracticeGroup({ params }) {
  const { user } = useMobile();
  const navigate = useNavigate();
  const trackId = params.get('trackId') || '';
  const examType = params.get('examType') || (trackId ? '' : 'xingce');
  const questionId = params.get('questionId');
  const [cursor, setCursor] = useState('');
  const [groupIndex, setGroupIndex] = useState(1);
  const [index, setIndex] = useState(0);
  const [answer, setAnswer] = useState(null);
  const [results, setResults] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const flight = useRef(false);
  const attempt = useRef(null);
  const resource = useResource(async signal => {
    if (questionId) {
      const data = await request(`/me/prep/questions/${encodeURIComponent(questionId)}`, { signal });
      return { questions: [{ ...data.question, bookmarked: data.bookmarked }], total: 1, nextCursor: '' };
    }
    return api.prep.questions({ trackId, examType, section: params.get('section') || '', contentKind: params.get('contentKind') || '', cursor, limit: 5 }, signal);
  }, [trackId, examType, params.get('section'), params.get('contentKind'), questionId, cursor]);
  const questions = resource.data?.questions || [];
  const question = questions[index];
  const result = question && results[question.id];
  const submit = async () => {
    if (flight.current || !question || !hasAnswer(answer)) return;
    flight.current = true; setBusy(true); setError(null);
    const payload = { questionId: question.id, answer };
    const signature = JSON.stringify(payload);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newRequestKey() };
    try {
      const response = await api.prep.submit({ ...payload, idempotencyKey: attempt.current.key });
      setResults(previous => ({ ...previous, [question.id]: { ...response.attempt, referenceAnswer: response.referenceAnswer, explanation: response.explanation, provenance: response.provenance } }));
    } catch (err) { setError(err); }
    finally { flight.current = false; setBusy(false); }
  };
  const next = () => { setIndex(value => value + 1); setAnswer(null); setError(null); attempt.current = null; };
  const summary = () => navigate('/practice/result', { state: { userId: user.id, results: questions.filter(q => results[q.id]).map(q => ({ ...results[q.id], question: q })), returnTo: `/practice?${params}` } });
  const nextGroup = () => { setCursor(resource.data.nextCursor); setGroupIndex(n => n + 1); setIndex(0); setAnswer(null); setResults({}); setError(null); attempt.current = null; };
  if (!resource.data || resource.loading) return <ResourceStatus resource={resource} title="专项练习"/>;
  if (!question) return <Page title="专项练习"><ErrorNotice error={resource.error} retry={resource.reload}/><Empty title="当前条件没有可练题目" message="题目可能未发布、已撤回或不在当前套餐内。不会使用示例题替代。" label="重新选择方向" action={() => navigate('/prep/sections')}/></Page>;
  return <div className="quiz-screen mobile-prep"><TopBar title="专项练习" back action={null}/><main className="page practice-page"><div className="quiz-progress"><span>第 {groupIndex} 组 · <strong>{index + 1}</strong> / {questions.length} <small>筛选共 {resource.data.total} 题</small></span><div><i style={{ width: `${(index + 1) / questions.length * 100}%` }}/></div></div><Source question={question}/><h1 className="question-prompt">{question.prompt}</h1><p className="muted">{question.type === 'multi' ? '多选题 · 可选择多个选项' : question.type === 'short' ? '简答题' : '单选题'}</p><QuestionOptions question={question} answer={answer} onChange={setAnswer} disabled={busy || Boolean(result)}/><Bookmark key={question.id} question={question}/>{result ? <Analysis item={result} question={question}/> : null}<ErrorNotice error={error}/></main><footer className="practice-footer">{result ? index < questions.length - 1 ? <Button className="full" onClick={next}>下一题</Button> : <><Button className="full" onClick={summary}>查看练习小结</Button>{resource.data.nextCursor ? <Button className="full" variant="outline" onClick={nextGroup}>继续下一组</Button> : null}</> : <Button className="full" disabled={busy || !hasAnswer(answer)} onClick={submit}>{busy ? '正在提交…' : error ? '重试提交答案' : '提交答案'}</Button>}<p>{result ? '成绩与练习进度已保存到云端' : '每题单独计入每日练习额度；相同回答重试不重复扣额'}</p>{!result && Object.keys(results).length ? <button className="text-link" onClick={summary}>查看已提交的小结</button> : null}</footer></div>;
}

export function PracticeResult() {
  const { user } = useMobile();
  const { state } = useLocation();
  const items = state?.userId === user.id ? state.results || [] : [];
  return <Page title="练习小结" className="mobile-prep">{items.length ? <><div className="result-header"><Icon name="clipboard" size={52}/><h1>每一次练习，都有收获</h1><p className="result-number">{items.filter(item => item.correct).length}<small> / {items.length}</small></p><p className="muted">本组已提交 {items.length} 题 · 正确数来自服务器</p></div>{items.map(item => <article key={item.questionId}><h2>{item.question.prompt}</h2><Source question={item}/><Analysis item={item} question={item.question}/></article>)}<Link className="button outline full" to={state.returnTo || '/practice'}>重新练习（计入新的用量）</Link></> : <Notice>此页没有本组小结。云端练习进度仍保留，可返回备考查看；不会凭本地示例生成成绩。</Notice>}<Link className="button primary full" to="/prep">返回备考</Link></Page>;
}

export function QuestionCollection({ type = 'wrong' }) {
  const wrong = type === 'wrong';
  const navigate = useNavigate();
  const [cursor, setCursor] = useState('');
  const [mutationError, setMutationError] = useState(null);
  const [busyId, setBusyId] = useState('');
  const resource = useResource(signal => request(linkTo(wrong ? '/me/prep/wrong' : '/me/prep/bookmarks', { limit: 20, cursor }), { signal }), [wrong, cursor]);
  const title = wrong ? '我的错题' : '收藏题目';
  if (!resource.data) return <ResourceStatus resource={resource} title={title}/>;
  const items = resource.data.items || [];
  const remove = async id => {
    if (busyId) return;
    setBusyId(id); setMutationError(null);
    try { await request(`/me/prep/bookmarks/${encodeURIComponent(id)}`, { method: 'PUT', body: { saved: false } }); resource.reload(); }
    catch (err) { setMutationError(err); }
    finally { setBusyId(''); }
  };
  return <Page title={title} className="mobile-prep"><h1>{title}</h1><p className="muted">{wrong ? `普通练习与考试合计 ${resource.data.total || 0} 道待复习；最近一次未满分的题目。` : `云端收藏共 ${resource.data.total || 0} 题`}</p><ErrorNotice error={resource.error || mutationError} retry={resource.reload}/>{items.length ? items.map(item => <article className="collection-card" key={item.questionId}><Source question={item.question}/><h2>{item.question.prompt}</h2>{wrong ? <p className="muted">最近得分 {item.latestScore} · 已练 {item.attempts} 次 · {dateText(item.updatedAt)}</p> : null}<div className="two-actions"><Link className="button outline" to={linkTo('/practice', { questionId: item.questionId })}>重新练习</Link>{!wrong ? <button className="text-link" disabled={Boolean(busyId)} onClick={() => remove(item.questionId)}>{busyId === item.questionId ? '处理中…' : '取消收藏'}</button> : null}</div></article>) : <Empty icon={wrong ? 'check' : 'bookmark'} title={wrong ? '当前没有待复习的错题' : '还没有收藏题目'} message={wrong ? '练习或考试交卷后，服务器会记录需要再练的题目。' : '练习时可将题目加入云端收藏。'} label="开始练习" action={() => navigate('/practice')}/>}<div className="two-actions">{cursor ? <Button variant="outline" onClick={() => setCursor('')}>返回首页</Button> : null}{resource.data.nextCursor ? <Button onClick={() => setCursor(resource.data.nextCursor)}>下一页</Button> : null}</div>{wrong ? <Notice>重新答到满分后，该题会从当前错题列表移出；历史成绩仍保留，不伪造删除记录。</Notice> : null}</Page>;
}

export function ExamIntro() {
  const [params] = useSearchParams();
  const packId = params.get('packId') || '';
  const resource = useResource(signal => packId ? api.exams.pack(packId, signal) : api.exams.packs({}, signal), [packId]);
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const flight = useRef(false);
  const start = async id => {
    if (flight.current) return;
    flight.current = true; setBusy(true); setError(null);
    try { const response = await api.exams.start(id); navigate(linkTo('/exam/session', { id: response.session.id })); }
    catch (err) { setError(err); }
    finally { flight.current = false; setBusy(false); }
  };
  if (!resource.data) return <ResourceStatus resource={resource} title="模拟考试"/>;
  if (!packId) return <Page title="考试中心" className="mobile-prep"><h1>专注完成一次练习</h1><p className="muted">真实已发布试卷 · 云端进度 · 服务器评分</p>{resource.data.packs?.length ? resource.data.packs.map(pack => <article className="collection-card" key={pack.id}><span className="tag">{pack.sourceLabel || '题源详见试题'}</span><h2>{pack.title}</h2><p className="muted">{pack.questionCount} 题 · 建议 {pack.durationMinutes} 分钟{pack.locked ? ' · 当前套餐未解锁' : ''}</p><p>{pack.subtitle}</p><Link className="button outline full" to={linkTo('/exam', { packId: pack.id })}>{pack.progress ? `继续考试 · 已答 ${pack.progress.answeredCount} 题` : '查看试卷'}</Link>{pack.latestResult ? <Link className="text-link" to={linkTo('/exam/result', { id: pack.latestResult.sessionId })}>上次成绩 {pack.latestResult.score} 分</Link> : null}</article>) : <Notice>目前没有已发布试卷，不会以演示试卷代替。</Notice>}</Page>;
  const pack = resource.data.pack;
  return <Page title="模拟考试" className="mobile-prep"><span className="tag">{pack.sourceLabel || '题源逐题展示'}</span><h1>{pack.title}</h1><p className="muted">{pack.subtitle}</p><div className="exam-spec"><div><Icon name="file"/><strong>{pack.questionCount} 道</strong><span>按已发布题目组卷</span></div><div><Icon name="clock"/><strong>{pack.durationMinutes} 分钟</strong><span>建议用时</span></div></div><p>{pack.description}</p><Notice>回答保存到当前账户，其他设备可恢复。切至后台仍按实际时间计时；建议用时不等于服务器强制截止，不会自动伪造交卷。最终成绩由服务器返回。</Notice><ErrorNotice error={error}/>{pack.locked ? <Link className="button primary full" to="/membership">查看套餐与解锁范围</Link> : <Button className="full" disabled={busy || !pack.questionCount} onClick={() => start(pack.id)}>{busy ? '正在连接…' : pack.progress ? '继续云端考试' : '开始考试'}</Button>}{pack.latestResult ? <Link className="button outline full" to={linkTo('/exam/result', { id: pack.latestResult.sessionId })}>查看上次真实成绩</Link> : null}<Link className="button outline full" to="/exam">选择其他试卷</Link></Page>;
}

export function ExamSession() {
  const { user } = useMobile();
  const [params] = useSearchParams();
  const id = params.get('id') || '';
  return <ExamSessionView key={`${user.id}:${id}`} userId={user.id} sessionId={id}/>;
}
function ExamSessionView({ userId, sessionId }) {
  const exam = useMobileExam(userId, sessionId);
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  useEffect(() => { if (exam.data?.session.status === 'submitted') navigate(linkTo('/exam/result', { id: sessionId }), { replace: true }); }, [exam.data?.session.status, sessionId, navigate]);
  if (!sessionId) return <Page title="考试"><Empty title="请选择一套试卷" label="进入考试中心" action={() => navigate('/exam')}/></Page>;
  if (exam.loading || !exam.data) return <ResourceStatus title="考试" resource={{ loading: exam.loading, error: exam.error, reload: exam.reload }}/>;
  const { pack, questions } = exam.data;
  const index = Math.min(exam.progress.currentIndex, questions.length - 1);
  const question = questions[index];
  if (!question) return <Page title="考试"><Notice>此考试没有可显示的题目，请返回考试中心核查。</Notice></Page>;
  const answered = questions.filter(item => hasAnswer(exam.progress.answers[item.id])).length;
  const submit = async () => { if (await exam.submit()) { setConfirm(false); navigate(linkTo('/exam/result', { id: sessionId }), { replace: true }); } };
  return <div className="quiz-screen mobile-prep"><TopBar title="模拟考试" back action={null}/><main className="page practice-page"><p className="muted">{pack.title}</p><div className="exam-clock"><span>第 {index + 1} / {questions.length} 题</span><strong><Icon name="clock" size={18}/>已用 {Math.floor(exam.elapsedSeconds / 60)}:{String(exam.elapsedSeconds % 60).padStart(2, '0')}</strong></div><p className="mobile-exam-save" role="status">{exam.message}</p>{exam.conflict ? <Notice><p>云端进度与本机不同，请明确选择；不会自动覆盖。</p><div className="two-actions"><Button variant="outline" disabled={exam.busy} onClick={() => { if (window.confirm('载入云端进度并舍弃本机未同步回答？')) void exam.resolve(false); }}>载入云端</Button><Button disabled={exam.busy} onClick={() => { if (window.confirm('确认以本机回答替换刚读取的云端进度？其他设备再次更新仍会阻止覆盖。')) void exam.resolve(true); }}>保留本机回答</Button></div></Notice> : <button className="text-link" disabled={exam.busy} onClick={() => void exam.save(true)}>立即保存 / 重试同步</button>}<ErrorNotice error={exam.error}/><Source question={question}/><h1 className="question-prompt">{question.prompt}</h1><QuestionOptions question={question} answer={exam.progress.answers[question.id]} disabled={exam.busy} onChange={answer => exam.update('answers', current => ({ ...current, [question.id]: answer }))}/><button className="text-link mobile-exam-flag" disabled={exam.busy} onClick={() => exam.update('flagged', current => current.includes(question.id) ? current.filter(item => item !== question.id) : [...current, question.id])}>{exam.progress.flagged.includes(question.id) ? '已标记 · 取消待检查' : '标记为待检查（仅本场）'}</button><div className="question-map" aria-label="切换试题">{questions.map((item, position) => <button key={item.id} disabled={exam.busy} className={`${position === index ? 'current' : ''} ${hasAnswer(exam.progress.answers[item.id]) ? 'answered' : ''}`} aria-label={`第 ${position + 1} 题${exam.progress.flagged.includes(item.id) ? '，待检查' : ''}`} onClick={() => exam.update('currentIndex', position)}>{position + 1}{exam.progress.flagged.includes(item.id) ? '·' : ''}</button>)}</div></main><footer className="practice-footer"><div className="two-actions"><Button variant="outline" disabled={index === 0 || exam.busy} onClick={() => exam.update('currentIndex', index - 1)}>上一题</Button><Button disabled={exam.busy} onClick={() => index < questions.length - 1 ? exam.update('currentIndex', index + 1) : setConfirm(true)}>{index < questions.length - 1 ? '下一题' : '交卷'}</Button></div><button className="text-link" disabled={exam.busy || exam.conflict} onClick={() => setConfirm(true)}>结束并交卷</button><p>建议 {pack.durationMinutes} 分钟 · 已答 {answered} / {questions.length} 题</p></footer>{confirm ? <Sheet title="确认提交真实成绩？" onClose={() => { if (!exam.busy) setConfirm(false); }} footer={<><Button variant="outline" disabled={exam.busy} onClick={() => setConfirm(false)}>继续答题</Button><Button disabled={exam.busy || exam.conflict} onClick={submit}>{exam.busy ? '正在交卷…' : '确认交卷'}</Button></>}><p className="muted">已答 {answered} / {questions.length} 题。未答题计零分。交卷后不能修改，网络失败可重试。</p><ErrorNotice error={exam.error}/></Sheet> : null}</div>;
}

export function ExamResult() {
  const [params] = useSearchParams();
  const id = params.get('id') || '';
  const resource = useResource(signal => id ? api.exams.session(id, signal) : Promise.resolve(null), [id]);
  if (!id) return <Page title="考试成绩"><Link className="button primary full" to="/exam">从考试中心选择成绩记录</Link></Page>;
  if (!resource.data) return <ResourceStatus title="考试成绩" resource={resource}/>;
  const { session, result, questions, pack } = resource.data;
  if (session.status !== 'submitted' || !result) return <Page title="考试成绩"><Notice>此考试尚未交卷，没有最终成绩。</Notice><Link className="button primary full" to={linkTo('/exam/session', { id })}>继续作答</Link></Page>;
  return <Page title="考试成绩" className="mobile-prep"><div className="result-header"><h1>这次完成了，下一步更明确</h1><p>{pack.title}</p><p className="result-number">{result.score}<small> 分</small></p><p className="muted">服务器记录 · 正确 {result.correctCount} / {result.total} 题</p><p className="muted">{dateText(session.submittedAt)}</p></div>{result.items.map((item, index) => <article key={item.questionId}><h2>{index + 1}. {item.prompt}</h2><Source question={item}/><Analysis item={item} question={questions.find(question => question.id === item.questionId)}/></article>)}<Link className="button primary full" to="/wrongbook">复习错题</Link><Link className="button outline full" to={linkTo('/exam', { packId: session.packId })}>返回试卷</Link><Link className="button outline full" to="/prep">返回备考</Link></Page>;
}
