import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { JobListHeader, JobRow } from '../components/JobRow';
import { api, listPayload } from '../lib/api';

const defaultFilters = {
  q: '', location: '', major: '', currency: '', salaryPeriod: 'month', salaryMin: '', sort: 'match',
};

export function JobsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initial = useMemo(() => ({ ...defaultFilters, ...Object.fromEntries(searchParams.entries()) }), [searchParams]);
  const [draft, setDraft] = useState(initial);
  const [filters, setFilters] = useState(initial);
  const [jobs, setJobs] = useState([]);
  const [nextCursor, setNextCursor] = useState('');
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const filterButtonRef = useRef(null);
  const filterSheetRef = useRef(null);
  const filterCloseRef = useRef(null);

  useEffect(() => {
    setDraft(initial);
    setFilters(initial);
  }, [initial]);

  const load = useCallback(async (cursor = '', signal) => {
    const data = await api.jobs.list({ ...filters, cursor, limit: 20 }, signal);
    const page = listPayload(data, 'jobs');
    setJobs(current => cursor ? [...current, ...page.items] : page.items);
    setNextCursor(page.nextCursor);
    setTotal(page.total);
  }, [filters]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setJobs([]);
    load('', controller.signal).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [load, reloadKey]);

  useEffect(() => {
    if (!filterOpen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => filterCloseRef.current?.focus());
    const keydown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFilterOpen(false);
        return;
      }
      if (event.key !== 'Tab' || !filterSheetRef.current) return;
      const focusable = [...filterSheetRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), [href]')];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    document.addEventListener('keydown', keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', keydown);
      requestAnimationFrame(() => filterButtonRef.current?.focus());
    };
  }, [filterOpen]);

  const applyFilters = event => {
    event?.preventDefault();
    if ((draft.salaryMin !== '' || draft.sort === 'salary') && !draft.currency) {
      setError(draft.sort === 'salary' ? '按薪资排序前，请先选择币种' : '设置最低薪资前，请先选择币种');
      return;
    }
    setError('');
    const next = Object.fromEntries(Object.entries(draft).filter(([, value]) => value !== ''));
    setFilters({ ...defaultFilters, ...next });
    setSearchParams(next, { replace: true });
    setFilterOpen(false);
  };

  const clearFilters = () => {
    setDraft(defaultFilters);
    setFilters(defaultFilters);
    setSearchParams({}, { replace: true });
    setFilterOpen(false);
  };

  const more = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try { await load(nextCursor); } catch (requestError) { setError(requestError.message); } finally { setLoadingMore(false); }
  };

  const filterFields = <>
    <label className="field"><span>工作地点</span><input value={draft.location} onChange={event => setDraft(current => ({ ...current, location: event.target.value }))} placeholder="城市或远程" /></label>
    <label className="field"><span>专业方向</span><input value={draft.major} onChange={event => setDraft(current => ({ ...current, major: event.target.value }))} placeholder="不限专业" /></label>
    <label className="field"><span>币种</span><select value={draft.currency} onChange={event => setDraft(current => ({ ...current, currency: event.target.value }))}><option value="">不限币种</option><option value="CNY">人民币 CNY</option><option value="AUD">澳元 AUD</option><option value="USD">美元 USD</option><option value="HKD">港币 HKD</option><option value="SGD">新币 SGD</option><option value="GBP">英镑 GBP</option><option value="EUR">欧元 EUR</option></select></label>
    <label className="field"><span>薪资周期</span><select value={draft.salaryPeriod} onChange={event => setDraft(current => ({ ...current, salaryPeriod: event.target.value }))}><option value="month">月薪</option><option value="year">年薪</option><option value="hour">时薪</option></select></label>
    <label className="field"><span>最低薪资</span><input type="number" min="0" value={draft.salaryMin} onChange={event => setDraft(current => ({ ...current, salaryMin: event.target.value }))} placeholder={draft.salaryPeriod === 'year' ? '例如 120000' : draft.salaryPeriod === 'hour' ? '例如 30' : '例如 15000'} /></label>
    <label className="field"><span>排序</span><select value={draft.sort} onChange={event => setDraft(current => ({ ...current, sort: event.target.value }))}><option value="match">匹配度优先</option><option value="deadline">截止日期优先</option><option value="salary">薪资优先</option><option value="latest">最新发布</option></select></label>
  </>;

  return (
    <div className="page jobs-page">
      <header className="page-header">
        <div><h1>找岗位</h1><p>从多个可靠来源中，发现与你的专业、技能和目标真正匹配的机会。</p></div>
        <span className="result-count">{loading ? '正在搜索' : `共 ${total} 个岗位`}</span>
      </header>
      <form className="job-search-band" onSubmit={applyFilters}>
        <div className="job-search-input"><Icon name="search" size={20} /><input value={draft.q} onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} placeholder="搜索公司、岗位或关键词" aria-label="搜索岗位" /><button className="button primary" type="submit">搜索</button></div>
        <button ref={filterButtonRef} className="button secondary mobile-filter-button" type="button" aria-haspopup="dialog" aria-expanded={filterOpen} onClick={() => setFilterOpen(true)}><Icon name="filter" size={18} />筛选</button>
        <div className="desktop-job-filters">{filterFields}<button className="button secondary" type="button" onClick={clearFilters}>重置</button></div>
      </form>

      {error && jobs.length > 0 && <div className="inline-error" role="alert">{error}<button type="button" onClick={() => setReloadKey(value => value + 1)}>重试</button></div>}
      {loading ? <LoadingState rows={6} /> : error && !jobs.length ? <ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /> : jobs.length ? (
        <section className="jobs-results" aria-label="岗位搜索结果">
          <JobListHeader />
          {jobs.map(job => <JobRow key={job.id || job.jobId} job={job} />)}
          {nextCursor && <button className="button secondary load-more" type="button" onClick={more} disabled={loadingMore}>{loadingMore ? '正在加载…' : '加载更多岗位'}</button>}
        </section>
      ) : <EmptyState title="没有找到符合条件的岗位" description="试着减少筛选条件，或换一个关键词继续寻找。" action={<button className="button primary" type="button" onClick={clearFilters}>清除筛选</button>} />}

      {filterOpen && <div className="sheet-mask" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setFilterOpen(false); }}>
        <form ref={filterSheetRef} className="filter-sheet" onSubmit={applyFilters} role="dialog" aria-modal="true" aria-labelledby="filter-title">
          <header><h2 id="filter-title">筛选岗位</h2><button ref={filterCloseRef} className="icon-button" type="button" onClick={() => setFilterOpen(false)} aria-label="关闭筛选"><Icon name="close" /></button></header>
          <div className="filter-sheet-content">{filterFields}</div>
          {error && <div className="form-error filter-sheet-error" role="alert">{error}</div>}
          <footer><button className="button secondary" type="button" onClick={clearFilters}>重置</button><button className="button primary" type="submit">查看结果</button></footer>
        </form>
      </div>}
    </div>
  );
}
