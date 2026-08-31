import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { CompanyLogo } from '../components/JobRow';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { api, listPayload } from '../lib/api';
import { companyName, formatDateTime, jobLocation, jobTitle } from '../lib/format';
import { useOnline } from '../hooks/useOnline';

const statuses = [
  ['all', '全部'], ['saved', '已收藏'], ['preparing', '准备投递'], ['applied', '已投递'],
  ['assessment', '在线测评'], ['interview', '面试中'], ['offer', 'Offer'], ['rejected', '未通过'], ['withdrawn', '已撤回'],
];

function flattenPipeline(data) {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.jobs) || Array.isArray(data?.items)) return listPayload(data, 'jobs').items;
  const groups = data?.groups || data?.pipeline || {};
  return Object.entries(groups).flatMap(([status, items]) => Array.isArray(items) ? items.map(item => ({ ...item, userState: { ...item.userState, status: item.userState?.status || status } })) : []);
}

function followUpPresentation(value) {
  if (!value) return { text: '待安排', tone: '' };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { text: String(value), tone: '' };
  const now = new Date();
  const day = current => new Date(current.getFullYear(), current.getMonth(), current.getDate()).getTime();
  const difference = Math.round((day(date) - day(now)) / 86_400_000);
  const prefix = difference < 0 ? '已逾期' : difference === 0 ? '今天' : difference === 1 ? '明天' : '';
  return {
    text: prefix ? `${prefix} · ${formatDateTime(value)}` : formatDateTime(value),
    tone: difference < 0 ? 'overdue' : difference === 0 ? 'today' : '',
  };
}

export function PipelinePage() {
  const online = useOnline();
  const [data, setData] = useState(null);
  const [active, setActive] = useState('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const load = useCallback(signal => api.pipeline.get(signal).then(setData), []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    load(controller.signal).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [load, reloadKey]);

  const jobs = useMemo(() => flattenPipeline(data), [data]);
  const visible = active === 'all' ? jobs : jobs.filter(job => (job.userState?.status || job.status) === active);
  const count = status => status === 'all' ? jobs.length : jobs.filter(job => (job.userState?.status || job.status) === status).length;

  const changeStatus = async (job, status) => {
    const id = job.id || job.jobId;
    setUpdating(id);
    try {
      await api.jobs.updateState(id, { status, saved: status !== 'ignored' });
      setData(current => {
        const list = flattenPipeline(current).map(item => (item.id || item.jobId) === id ? { ...item, userState: { ...item.userState, status } } : item);
        return { jobs: list };
      });
    } catch (requestError) { setError(requestError.message); } finally { setUpdating(''); }
  };

  if (loading) return <div className="page"><LoadingState rows={6} /></div>;
  if (error && !data) return <div className="page"><ErrorState message={error} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  return (
    <div className="page pipeline-page">
      <header className="page-header"><div><h1>求职进度</h1><p>把每个机会的下一步安排清楚，不错过重要节点。</p></div><Link className="button primary" to="/jobs">发现更多岗位</Link></header>
      <nav className="status-tabs" aria-label="按状态筛选">
        {statuses.map(([key, label]) => <button key={key} className={active === key ? 'active' : ''} type="button" aria-pressed={active === key} onClick={() => setActive(key)}>{label}<span>{count(key)}</span></button>)}
      </nav>
      {error && <div className="inline-error" role="alert">{error}</div>}
      {visible.length ? <section className="pipeline-list">
        <div className="pipeline-list-head"><span>公司与岗位</span><span>当前阶段</span><span>下一步</span><span>更新时间</span><span>操作</span></div>
        {visible.map(job => {
          const id = job.id || job.jobId;
          const state = job.userState || {};
          const followUp = followUpPresentation(state.followUpAt || job.followUpAt);
          return <article className="pipeline-row" key={id}>
            <CompanyLogo job={job} />
            <div className="pipeline-job"><h2>{companyName(job)} · {jobTitle(job)}</h2><p>{jobLocation(job)}</p></div>
            <label className="stage-select"><span className="sr-only">更新状态</span><select value={state.status || job.status || 'saved'} onChange={event => changeStatus(job, event.target.value)} disabled={updating === id || !online}>{statuses.slice(1).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
            <div className="pipeline-next"><strong>{state.nextAction || job.nextAction || '补充下一步计划'}</strong><span className={followUp.tone}>{followUp.text}</span></div>
            <time>{formatDateTime(state.updatedAt || job.userUpdatedAt || job.updatedAt)}</time>
            {job.available === false ? <span className="row-arrow disabled" aria-label="岗位已下线"><Icon name="close" /></span> : <Link className="row-arrow" to={`/jobs/${encodeURIComponent(id)}`} aria-label={`查看 ${companyName(job)} 详情`}><Icon name="chevronRight" /></Link>}
          </article>;
        })}
      </section> : <EmptyState title={active === 'all' ? '还没有跟踪中的岗位' : `“${statuses.find(item => item[0] === active)?.[1]}”阶段暂无岗位`} description="收藏感兴趣的岗位后，就可以在这里管理完整进度。" icon="progress" action={<Link className="button primary" to="/jobs">去找岗位</Link>} />}
    </div>
  );
}
