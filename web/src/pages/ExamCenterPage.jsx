import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';
import { useOnline } from '../hooks/useOnline';

const emptyFilters = { q: '', company: '', role: '', major: '', year: '', type: '', difficulty: '' };

function answerText(value, question = null) {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) return '';
  const renderOption = item => {
    const index = Number(item);
    if (question?.options?.length && Number.isInteger(index) && index >= 0 && index < question.options.length) {
      const option = question.options[index];
      return typeof option === 'string' ? option : option?.text || option?.label || String(item ?? '');
    }
    return String(item ?? '');
  };
  if (Array.isArray(value)) return value.map(renderOption).join('、');
  if (question?.options?.length) return renderOption(value);
  if (value && typeof value === 'object') return value.sample || JSON.stringify(value);
  return String(value ?? '');
}

function PackCard({ pack, starting, onStart }) {
  const progress = pack.progress;
  const latest = pack.latestResult;
  return (
    <article className={`exam-pack-card${pack.featured ? ' featured' : ''}${pack.locked ? ' locked' : ''}`}>
      <header>
        <div className="exam-pack-badges">
          <span>{pack.type}</span><span>{pack.year}</span><span>{pack.difficulty}</span>
          {pack.recommended && <strong><Icon name="target" size={13} />推荐</strong>}
        </div>
        <h2>{pack.title}</h2>
        <p>{pack.subtitle}</p>
      </header>
      <p className="exam-pack-description">{pack.description}</p>
      <dl className="exam-pack-meta">
        <div><dt>题量</dt><dd>{pack.questionCount} 题</dd></div>
        <div><dt>建议用时</dt><dd>{pack.durationMinutes} 分钟</dd></div>
        <div><dt>适合岗位</dt><dd>{(pack.roles || []).slice(0, 2).join('、') || '通用'}</dd></div>
      </dl>
      {(pack.jobRecommendationReason || pack.recommendationReason) && <p className="exam-recommendation"><Icon name="target" size={15} />{pack.jobRecommendationReason || pack.recommendationReason}</p>}
      {progress && <div className="exam-pack-progress">
        <span><strong>已答 {progress.answeredCount}/{progress.totalQuestions}</strong><small>云端草稿已保存</small></span>
        <span role="progressbar" aria-label={`${pack.title}作答进度`} aria-valuemin="0" aria-valuemax="100" aria-valuenow={progress.percent}><i style={{ width: `${progress.percent}%` }} /></span>
      </div>}
      {latest && !progress && <p className="exam-latest-result"><Icon name="checkCircle" size={16} />最近得分 {latest.score} · {latest.correctCount}/{latest.totalQuestions} 题正确</p>}
      <footer>
        {pack.locked ? <Link className="button secondary" to="/pricing"><Icon name="lock" size={16} />升级解锁</Link> : <button className="button primary" type="button" onClick={() => onStart(pack)} disabled={starting === pack.id}>{starting === pack.id ? '正在进入…' : progress ? '继续答题' : latest ? '再做一遍' : '开始做题'}</button>}
        {pack.legacyUrl && <a className="exam-legacy-link" href={pack.legacyUrl} target="_blank" rel="noopener noreferrer">打开完整旧版 <Icon name="external" size={14} /></a>}
      </footer>
    </article>
  );
}

export function ExamCenterPage() {
  const navigate = useNavigate();
  const online = useOnline();
  const [searchParams, setSearchParams] = useSearchParams();
  const [filters, setFilters] = useState(() => ({ ...emptyFilters, ...Object.fromEntries([...searchParams.entries()].filter(([key]) => key in emptyFilters)) }));
  const [packs, setPacks] = useState([]);
  const [facets, setFacets] = useState({ companies: [], years: [], types: [], difficulties: [] });
  const [summary, setSummary] = useState(null);
  const [wrong, setWrong] = useState([]);
  const [jobContext, setJobContext] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState('');
  const jobId = searchParams.get('jobId') || '';
  const queryKey = searchParams.toString();

  useEffect(() => {
    const controller = new AbortController();
    const query = Object.fromEntries([...searchParams.entries()].filter(([key]) => key in emptyFilters));
    setFilters(current => ({ ...current, ...emptyFilters, ...query }));
    setLoading(true); setError(''); setJobContext(null);
    const packRequest = jobId
      ? api.exams.forJob(jobId, controller.signal).then(data => {
        setJobContext(data.job || null);
        setPacks(listPayload(data, 'items').items);
        return api.exams.packs({}, controller.signal).then(all => setFacets(all.facets || {}));
      })
      : api.exams.packs(query, controller.signal).then(data => {
        setPacks(listPayload(data, 'packs').items);
        setFacets(data.facets || {});
      });
    Promise.all([
      packRequest,
      api.exams.summary(controller.signal).then(data => setSummary(data.summary || data)),
      api.exams.wrong({ limit: 4 }, controller.signal).then(data => setWrong(listPayload(data, 'items').items)),
    ]).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [queryKey, jobId]);

  const activeFilterCount = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);

  const applyFilters = event => {
    event.preventDefault();
    const next = {};
    for (const [key, value] of Object.entries(filters)) if (String(value).trim()) next[key] = String(value).trim();
    setSearchParams(next);
  };

  const clearFilters = () => {
    setFilters(emptyFilters);
    setSearchParams({});
  };

  const start = async pack => {
    setStarting(pack.id); setError('');
    try {
      const data = await api.exams.start(pack.id);
      const session = data.session || data;
      navigate(`/exams/session/${encodeURIComponent(session.id)}`);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setStarting('');
    }
  };

  return (
    <div className="page exam-center-page">
      <header className="page-header exam-center-header">
        <div><span className="eyebrow">从岗位到上岸</span><h1>考试中心</h1><p>按公司、岗位、专业和年份找题；进度、得分和错题跟随账号同步。</p></div>
        <div className="exam-header-actions"><Link className="button secondary" to="/prep">每日练习</Link><a className="button primary" href="/exam/" target="_blank" rel="noopener noreferrer">湖州城投专项 <Icon name="external" size={16} /></a></div>
      </header>

      <section className="exam-summary-grid" aria-label="考试进度概览">
        <article><span>进行中</span><strong>{summary?.inProgress || 0}</strong><small>跨设备继续</small></article>
        <article><span>已交卷</span><strong>{summary?.submitted || 0}</strong><small>保留历史成绩</small></article>
        <article><span>平均分</span><strong>{summary?.averageScore ?? '—'}</strong><small>仅统计已交卷</small></article>
        <article><span>待复习错题</span><strong>{summary?.wrongCount || 0}</strong><small>答对后自动掌握</small></article>
      </section>

      {jobContext && <section className="job-exam-context" role="status"><Icon name="briefcase" size={24} /><div><strong>正在为 {jobContext.company} · {jobContext.title} 推荐试卷</strong><p>{jobContext.status === 'assessment' ? '该岗位已进入在线测评阶段，建议优先完成第一套推荐卷。' : '推荐结合岗位名称、公司和公开专业要求生成。'}</p></div><button type="button" onClick={clearFilters}>查看全部试卷</button></section>}

      {!jobId && <form className="exam-filter-panel" onSubmit={applyFilters}>
        <label className="field exam-search-field"><span>关键词</span><input value={filters.q} onChange={event => setFilters(current => ({ ...current, q: event.target.value }))} placeholder="公司、岗位或试卷名称" /></label>
        <label className="field"><span>公司</span><select value={filters.company} onChange={event => setFilters(current => ({ ...current, company: event.target.value }))}><option value="">全部公司</option>{(facets.companies || []).map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>岗位</span><input value={filters.role} onChange={event => setFilters(current => ({ ...current, role: event.target.value }))} placeholder="如 数据分析师" /></label>
        <label className="field"><span>专业</span><input value={filters.major} onChange={event => setFilters(current => ({ ...current, major: event.target.value }))} placeholder="如 统计学" /></label>
        <label className="field"><span>年份</span><select value={filters.year} onChange={event => setFilters(current => ({ ...current, year: event.target.value }))}><option value="">全部年份</option>{(facets.years || []).map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>类型</span><select value={filters.type} onChange={event => setFilters(current => ({ ...current, type: event.target.value }))}><option value="">全部类型</option>{(facets.types || []).map(item => <option key={item}>{item}</option>)}</select></label>
        <label className="field"><span>难度</span><select value={filters.difficulty} onChange={event => setFilters(current => ({ ...current, difficulty: event.target.value }))}><option value="">全部难度</option>{(facets.difficulties || []).map(item => <option key={item}>{item}</option>)}</select></label>
        <div className="exam-filter-actions"><button className="button primary" type="submit">筛选试卷</button>{activeFilterCount > 0 && <button className="button ghost" type="button" onClick={clearFilters}>清空 {activeFilterCount} 项</button>}</div>
      </form>}

      {error && <div className="form-error" role="alert">{error}</div>}
      {loading ? <LoadingState rows={6} /> : <div className="exam-center-layout">
        <main>
          <div className="section-title-row"><div><h2>{jobId ? '岗位推荐试卷' : '可用试卷'}</h2><p>{packs.length} 套 · 客观题自动评分，主观题按参考要点评分</p></div></div>
          {packs.length ? <div className="exam-pack-grid">{packs.map(pack => <PackCard key={pack.id} pack={pack} starting={starting} onStart={start} />)}</div> : <EmptyState title="没有找到符合条件的试卷" description="换一个岗位、专业或难度试试；也可以进入每日练习。" action={<button className="button primary" type="button" onClick={clearFilters}>查看全部试卷</button>} />}
        </main>
        <aside className="exam-review-rail">
          <section>
            <header><div><span>错题复习</span><h2>{summary?.wrongCount || 0} 题待巩固</h2></div><Icon name="refresh" size={22} /></header>
            {wrong.length ? <ol>{wrong.map(item => <li key={item.questionId}><strong>{item.question?.prompt}</strong><span>{item.packTitle}</span><small>上次回答：{answerText(item.latestResponse, item.question) || '未作答'}</small></li>)}</ol> : <p>完成一套试卷后，错题会自动汇总到这里。</p>}
          </section>
          <section className="exam-cloud-note"><Icon name={online ? 'checkCircle' : 'wifiOff'} size={22} /><div><strong>{online ? '云端同步已开启' : '当前离线'}</strong><p>{online ? '草稿、交卷和错题都绑定当前账号。' : '可继续作答，联网后请手动保存。'}</p></div></section>
        </aside>
      </div>}
    </div>
  );
}
