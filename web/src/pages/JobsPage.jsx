import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigationType, useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { JobListHeader, JobRow } from '../components/JobRow';
import { api, listPayload } from '../lib/api';
import { SaveSearch } from '../components/SaveSearch';
import { AiRecommendations } from '../components/AiRecommendations';
import { useAuth } from '../context/AuthContext';
import { JOB_FILTER_DEFAULTS, JOB_FILTER_OPTIONS, jobFilterParams, readJobFilters, validateJobFilters, jobFilterChips, matchesPersonalView, rememberJobPosition, readJobPosition } from '../lib/job-discovery';
import '../styles/job-discovery.css';

function CatalogFilter({ field, label, value, choices, onChange }) {
  const id = useId();
  return <label className="field"><span>{label}</span><input aria-label={label} list={id} value={value} onChange={event => onChange(field, event.target.value)} placeholder="不限，可输入或选择" /><datalist id={id}>{choices.map(item => <option key={item.value} value={item.value}>{item.label} · {item.count}</option>)}</datalist></label>;
}

export function JobsPage() {
  const { user } = useAuth();
  const location = useLocation(), navigationType = useNavigationType();
  const [searchParams, setSearchParams] = useSearchParams();
  const rawQuery = searchParams.toString();
  const aiView = searchParams.get('tab') === 'ai' || searchParams.get('view') === 'ai';
  const filters = useMemo(() => readJobFilters(new URLSearchParams(rawQuery)), [rawQuery]);
  const filterKey = jobFilterParams(filters).toString();
  const [draft, setDraft] = useState(filters);
  const [jobs, setJobs] = useState([]), [nextCursor, setNextCursor] = useState(''), [total, setTotal] = useState(0);
  const [facets, setFacets] = useState({}), [quality, setQuality] = useState(null);
  const [loading, setLoading] = useState(true), [refreshing, setRefreshing] = useState(false), [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(''), [filterError, setFilterError] = useState(''), [notice, setNotice] = useState('');
  const [filterOpen, setFilterOpen] = useState(false), [reloadKey, setReloadKey] = useState(0);
  const filterButtonRef = useRef(null), filterSheetRef = useRef(null), filterCloseRef = useRef(null);
  const generation = useRef(0), requestController = useRef(null), snapshot = useRef({}), restoreScroll = useRef(null), lastLoad = useRef({});
  const chips = jobFilterChips(filters);
  const dirty = jobFilterParams(draft).toString() !== filterKey;
  snapshot.current = { userId: user?.id, query: filterKey, count: jobs.length, view: filters.view, aiView };
  useEffect(() => { setDraft(readJobFilters(new URLSearchParams(filterKey))); setFilterError(''); }, [filterKey]);
  const remember = useCallback(() => { const current = snapshot.current; if (!current.aiView) rememberJobPosition(current.userId, current.query, current.count, window.scrollY); }, []);
  useEffect(() => { window.addEventListener('pagehide', remember); return () => window.removeEventListener('pagehide', remember); }, [remember]);

  useEffect(() => {
    if (aiView) return;
    const version = ++generation.current;
    const controller = new AbortController(); requestController.current = controller;
    const key = `${user?.id}:${filterKey}`;
    const background = lastLoad.current.key === key && lastLoad.current.reload !== reloadKey;
    lastLoad.current = { key, reload: reloadKey };
    const restore = navigationType === 'POP' || location.state?.restoreJobList ? readJobPosition(user?.id, filterKey) : null;
    const desired = Math.max(20, background ? snapshot.current.count : restore?.count || 0);
    restoreScroll.current = background ? window.scrollY : restore?.scroll ?? 0;
    setLoading(!background); setRefreshing(background); setLoadingMore(false); setError('');
    if (!background) { setJobs([]); setNotice(''); }
    const activeFilters = readJobFilters(new URLSearchParams(filterKey));
    const validation = validateJobFilters(activeFilters);
    if (validation) { setError(validation); setJobs([]); setLoading(false); setRefreshing(false); return () => controller.abort(); }
    (async () => {
      let items = [], cursor = '', last;
      do {
        last = await api.jobs.list({ ...activeFilters, cursor, limit: Math.min(100, desired - items.length) }, controller.signal);
        if (controller.signal.aborted || version !== generation.current) return;
        const result = listPayload(last, 'jobs'); items.push(...result.items); cursor = result.nextCursor;
      } while (cursor && items.length < desired);
      setJobs(items); setNextCursor(cursor); setTotal(last.total); setFacets(last.facets || {}); setQuality(last.dataQuality || null);
    })().catch(err => { if (err.name !== 'AbortError' && version === generation.current) setError(err.code === 'CURSOR_STALE' ? '恢复列表时岗位或个人状态已变化，请重新加载，从最新结果继续。' : err.message); }).finally(() => { if (!controller.signal.aborted && version === generation.current) { setLoading(false); setRefreshing(false); } });
    return () => { controller.abort(); generation.current += 1; };
  }, [filterKey, aiView, reloadKey, user?.id]);

  useEffect(() => {
    if (loading || refreshing || aiView || restoreScroll.current === null) return;
    const position = restoreScroll.current; restoreScroll.current = null;
    const frame = requestAnimationFrame(() => window.scrollTo({ top: position, behavior: 'instant' }));
    return () => cancelAnimationFrame(frame);
  }, [loading, refreshing, aiView]);
  useEffect(() => {
    if (!filterOpen) return;
    const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => filterCloseRef.current?.focus());
    const keydown = event => {
      if (event.key === 'Escape') { event.preventDefault(); setFilterOpen(false); return; }
      if (event.key !== 'Tab' || !filterSheetRef.current) return;
      const fields = [...filterSheetRef.current.querySelectorAll('button:not([disabled]),input:not([disabled]),select:not([disabled]),[href]')];
      if (event.shiftKey && document.activeElement === fields[0]) { event.preventDefault(); fields.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === fields.at(-1)) { event.preventDefault(); fields[0]?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.body.style.overflow = overflow; document.removeEventListener('keydown', keydown); requestAnimationFrame(() => filterButtonRef.current?.focus()); };
  }, [filterOpen]);

  const apply = event => { event?.preventDefault(); const validation = validateJobFilters(draft); if (validation) return setFilterError(validation); setFilterError(''); setSearchParams(jobFilterParams(draft), { replace: true }); setFilterOpen(false); };
  const update = (key, value) => setDraft(current => ({ ...current, [key]: value }));
  const clear = () => { setSearchParams({}); setDraft(JOB_FILTER_DEFAULTS); setFilterOpen(false); setFilterError(''); };
  const quick = values => {
    remember();
    const next = { ...filters, ...values };
    if (values.currency === '') { next.salaryMin = ''; next.salaryMax = ''; if (next.sort === 'salary') next.sort = 'match'; }
    setSearchParams(jobFilterParams(next));
  };
  const switchTab = ai => { remember(); setSearchParams(jobFilterParams(filters, ai)); };
  const stateChanged = useCallback((id, userState) => {
    setJobs(current => current.flatMap(job => String(job.id || job.jobId) !== String(id) ? [job] : matchesPersonalView(userState, snapshot.current.view) ? [{ ...job, userState }] : []));
    setNotice(userState.hidden ? '已移入“暂不考虑”，可在该视图恢复。' : '个人岗位状态已保存。');
    setReloadKey(value => value + 1);
  }, []);
  const more = async () => {
    if (!nextCursor || loadingMore || refreshing) return;
    const version = generation.current; setLoadingMore(true); setError('');
    try {
      const response = await api.jobs.list({ ...filters, cursor: nextCursor, limit: 20 }, requestController.current?.signal);
      if (version !== generation.current) return;
      const page = listPayload(response, 'jobs');
      setJobs(current => { const seen = new Set(current.map(job => String(job.id || job.jobId))); return [...current, ...page.items.filter(job => !seen.has(String(job.id || job.jobId)))]; });
      setTotal(page.total); setNextCursor(page.nextCursor);
    } catch (err) { if (err.name !== 'AbortError' && version === generation.current) setError(err.code === 'CURSOR_STALE' ? '岗位或个人状态已变化，请刷新列表后继续浏览。' : err.message); }
    finally { if (version === generation.current) setLoadingMore(false); }
  };
  const fieldSelect = (key, label, choices) => <label className="field" key={key}><span>{label}</span><select aria-label={label} value={draft[key]} onChange={event => update(key, event.target.value)}>{choices.map(([value, title]) => <option key={value} value={value}>{title}</option>)}</select></label>;
  const fields = <>
    {[['location','工作地点'],['role','岗位方向'],['industry','行业'],['nature','招聘性质'],['source','信息来源']].map(([field,label]) => <CatalogFilter key={field} field={field} label={label} value={draft[field]} choices={facets[field] || []} onChange={update} />)}
    <label className="field"><span>专业关键词</span><input value={draft.major} onChange={event => update('major', event.target.value)} placeholder="如计算机、财会，不限专业可留空" /></label>
    {fieldSelect('currency', '币种', [['', '不限币种'], ...['CNY','AUD','USD','HKD','SGD','GBP','EUR'].map(value => [value, value])])}{fieldSelect('salaryPeriod', '薪资周期', JOB_FILTER_OPTIONS.salaryPeriod)}
    {['salaryMin','salaryMax'].map((key, index) => <label className="field" key={key}><span>{index ? '最高薪资' : '最低薪资'}</span><input type="number" min="0" value={draft[key]} onChange={event => update(key, event.target.value)} placeholder={index ? '不限上限' : '不限下限'} /></label>)}
    {fieldSelect('qualification', '硬条件判断', JOB_FILTER_OPTIONS.qualification)}<label className="field"><span>最低规则分（非录用概率）</span><input type="number" min="0" max="100" value={draft.minMatch} onChange={event => update('minMatch', event.target.value)} placeholder="0–100，不限可留空" /></label>
    {fieldSelect('availability', '招聘期限', JOB_FILTER_OPTIONS.availability)}{fieldSelect('deadlineWithin', '截止范围', JOB_FILTER_OPTIONS.deadlineWithin)}{fieldSelect('view', '个人进度', JOB_FILTER_OPTIONS.view)}{fieldSelect('sort', '排序', JOB_FILTER_OPTIONS.sort)}
  </>;
  return <div className="page jobs-page job-discovery-page">
    <header className="page-header"><div><h1>找岗位</h1><p>先筛选适合的机会，再核对资格、来源和申请方式。</p></div>{!aiView && <span className="result-count" aria-live="polite">{loading ? '正在搜索' : `共 ${total} 个岗位`}</span>}</header>
    <nav className="commerce-admin-nav" aria-label="岗位推荐方式"><button className={!aiView ? 'active' : ''} aria-pressed={!aiView} onClick={() => switchTab(false)}>岗位与规则匹配</button><button className={aiView ? 'active' : ''} aria-pressed={aiView} onClick={() => switchTab(true)}>个人 AI 推荐</button></nav>
    {aiView ? <AiRecommendations /> : <>
      <div className="job-discovery-shortcuts" aria-label="常用岗位视图">{JOB_FILTER_OPTIONS.view.map(([value, label]) => <button key={value} type="button" aria-pressed={filters.view === value} onClick={() => quick({ view: value })}>{label}</button>)}<button type="button" aria-pressed={filters.deadlineWithin === '7'} onClick={() => quick({ deadlineWithin: filters.deadlineWithin === '7' ? '' : '7', availability: 'active' })}>7 天内截止</button></div>
      <form className="job-search-band" onSubmit={apply}><div className="job-search-input"><Icon name="search" size={20} /><input value={draft.q} onChange={event => update('q', event.target.value)} placeholder="公司、岗位或关键词，可组合搜索" aria-label="搜索岗位" /><button className="button primary" type="submit">搜索</button></div><button ref={filterButtonRef} className="button secondary mobile-filter-button" type="button" aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen(true)}><Icon name="filter" size={18} />筛选{chips.length ? ` · ${chips.length}` : ''}</button>
        <details className="job-desktop-filter-box"><summary>详细筛选{chips.length ? ` · 已应用 ${chips.length} 项` : ''}{dirty ? ' · 有未应用修改' : ''}</summary><div className="job-discovery-fields">{fields}</div><div className="job-filter-submit"><button className="button secondary" type="button" onClick={clear}>重置</button><button className="button primary" type="submit">应用筛选</button><small>候选展示目录常见值，也可直接输入；修改后应用。薪资未公开不等于低薪。</small></div></details>
      </form>
      {filterError && <p className="form-error" role="alert">{filterError}</p>}
      <div className="job-applied-filters" aria-label="已应用筛选">{chips.length ? <>{chips.map(chip => <button key={chip.key} type="button" onClick={() => quick({ [chip.key]: JOB_FILTER_DEFAULTS[chip.key] })} aria-label={`移除${chip.label}筛选：${chip.value}`}>{chip.label}：{chip.value}<Icon name="close" size={13} /></button>)}<button type="button" onClick={clear}>清除全部</button></> : <span>当前排除明确过期和暂不考虑的岗位；期限未知仍保留。</span>}</div>
      <div className="job-search-tools"><SaveSearch filters={filters} /><button className="button secondary" type="button" disabled={loading || loadingMore || refreshing} onClick={() => { remember(); setReloadKey(value => value + 1); }}><Icon name="refresh" size={15} />刷新列表</button></div>
      {quality && <details className="job-quality-note"><summary>数据说明：{quality.total} 条记录 · {quality.unknownDeadline} 条期限待核实</summary><p>明确过期 {quality.expired} 条，已注明薪资 {quality.salaryKnown} 条。长期招聘或期限未知不保证仍有名额。来源收录不等于官方认证，请核对原始公告。</p><p>规则分表示与所填画像的匹配信号，不是录用概率；“无明确冲突”包含资格待确认岗位。</p></details>}
      {notice && <p role="status" className="form-success">{notice}{refreshing ? ' 正在更新列表…' : ''}</p>}
      {error && jobs.length > 0 && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setReloadKey(value => value + 1)}>刷新列表</button></div>}
      {loading ? <LoadingState rows={6} label="正在筛选岗位" /> : error && !jobs.length ? <ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /> : jobs.length ? <section className="jobs-results" aria-label="岗位搜索结果"><JobListHeader />{jobs.map(job => <JobRow key={job.id || job.jobId} job={job} onStateChange={stateChanged} onNavigate={remember} />)}<p className="job-loaded-count">已显示 {jobs.length} / {total} 个岗位</p>{nextCursor && <button className="button secondary load-more" type="button" onClick={more} disabled={loadingMore || refreshing}>{loadingMore ? '正在加载…' : '加载更多岗位'}</button>}</section> : <EmptyState title={filters.view === 'hidden' ? '没有暂不考虑的岗位' : '没有找到符合条件的岗位'} description="可以移除一个条件，或换一组关键词。资格待确认不等于不符合。" action={<button className="button primary" type="button" onClick={clear}>清除筛选</button>} />}
      {filterOpen && <div className="sheet-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setFilterOpen(false); }}><form ref={filterSheetRef} className="filter-sheet" onSubmit={apply} role="dialog" aria-modal="true" aria-labelledby="filter-title"><header><h2 id="filter-title">筛选岗位</h2><button ref={filterCloseRef} className="icon-button" type="button" onClick={() => setFilterOpen(false)} aria-label="关闭筛选"><Icon name="close" /></button></header><div className="filter-sheet-content">{fields}</div>{filterError && <p className="form-error filter-sheet-error" role="alert">{filterError}</p>}<footer><button className="button secondary" type="button" onClick={clear}>重置</button><button className="button primary" type="submit">应用并查看结果</button></footer></form></div>}
    </>}
  </div>;
}
