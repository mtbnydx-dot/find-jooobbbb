import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { request, newRequestKey } from '../lib/api';
import { EmptyState, ErrorState, LoadingState } from './StatusViews';
import { JobRow } from './JobRow';
import { useOnline } from '../hooks/useOnline';

const statuses = { queued: '等待评估', running: '评估中', complete: '已完成', partial: '部分完成', paused: '已暂停', cancelled: '已取消', stale: '画像已变化' };
const progressKey = data => JSON.stringify([data?.coverage, data?.model, data?.runs?.map(run => [run.id, run.status, run.completed, run.failed, run.skipped, run.updatedAt])]);

export function AiRecommendations() {
  const online = useOnline();
  const [data, setData] = useState(null);
  const [page, setPage] = useState({ jobs: [], total: 0, nextCursor: '' });
  const [scope, setScope] = useState('top');
  const [limit, setLimit] = useState(20);
  const [minScore, setMinScore] = useState('0');
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const createKey = useRef({});
  const generation = useRef(0);
  const life = useRef(null);
  const progress = useRef('');
  const busyRef = useRef(false);

  const load = useCallback(async (signal, announce = false) => {
    const version = ++generation.current;
    setRefreshing(true);
    try {
      const [status, recommendations] = await Promise.all([
        request('/me/ai', { signal }),
        request('/me/ai/recommendations?limit=20&minScore=' + minScore, { signal }),
      ]);
      if (!signal?.aborted && version === generation.current) {
        progress.current = progressKey(status);
        setData(status); setPage(recommendations); setError('');
        if (announce) setNotice('推荐结果已更新，已按 AI 评分重新排列。');
      }
    } finally { if (!signal?.aborted && version === generation.current) setRefreshing(false); }
  }, [minScore]);

  useEffect(() => {
    const controller = new AbortController(); life.current = controller;
    const report = err => { if (!controller.signal.aborted && err.name !== 'AbortError') setError(err.message); };
    load(controller.signal).catch(report);
    let polling = false;
    const refresh = async () => {
      if (polling || busyRef.current || document.visibilityState !== 'visible' || !navigator.onLine) return;
      polling = true;
      try {
        const status = await request('/me/ai', { signal: controller.signal });
        if (controller.signal.aborted) return;
        if (progress.current !== progressKey(status)) await load(controller.signal, true);
        else setData(status);
      } catch (err) { report(err); } finally { polling = false; }
    };
    const timer = setInterval(refresh, 10000);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); generation.current++; clearInterval(timer); window.removeEventListener('online', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [load]);

  const perform = async operation => {
    if (busyRef.current) return;
    const signal = life.current?.signal;
    busyRef.current = true; setBusy(true); setError('');
    try { await operation(signal); }
    catch (err) { if (!signal?.aborted && err.name !== 'AbortError') setError(err.message); }
    finally { busyRef.current = false; if (!signal?.aborted) setBusy(false); }
  };
  const action = (id, command) => perform(async signal => {
    await request('/me/ai/runs/' + encodeURIComponent(id) + '/' + command, { method: 'POST', body: {}, signal });
    await load(signal);
  });
  const create = event => {
    event.preventDefault();
    const body = { scope, ...(scope !== 'all' ? { limit: Number(limit) } : {}) };
    const signature = JSON.stringify(body);
    if (createKey.current.signature !== signature) createKey.current = { signature, key: newRequestKey() };
    void perform(async signal => {
      await request('/me/ai/runs', { method: 'POST', body: { ...body, consent, idempotencyKey: createKey.current.key }, signal });
      createKey.current = {}; setConsent(false); await load(signal);
    });
  };
  const refreshResults = () => perform(signal => load(signal, true));
  const stateChanged = (id, state) => {
    setPage(current => ({ ...current, nextCursor: '', jobs: current.jobs.map(job => job.id === id ? { ...job, userState: state } : job).filter(job => !job.userState?.hidden), total: Math.max(0, current.total - (state.hidden ? 1 : 0)) }));
    // A row mutation can finish while pagination is in flight. Start a newer
    // read even in that case so the old cursor cannot revive a hidden result.
    const signal = life.current?.signal;
    void load(signal).catch(err => { if (!signal?.aborted && err.name !== 'AbortError') setError(err.message); });
  };
  const loadMore = () => perform(async signal => {
    const version = generation.current;
    try {
      const next = await request('/me/ai/recommendations?limit=20&minScore=' + minScore + '&cursor=' + encodeURIComponent(page.nextCursor), { signal });
      if (!signal?.aborted && version === generation.current) setPage(current => ({ ...next, jobs: [...new Map([...current.jobs, ...next.jobs].map(job => [job.id, job])).values()] }));
    } catch (err) {
      if (err.code !== 'CURSOR_STALE') throw err;
      await load(signal, true);
    }
  });

  if (!data) return error ? <ErrorState message={error} onRetry={refreshResults} /> : <LoadingState rows={4} label="正在读取个人 AI 评估" />;
  const active = data.runs?.some(run => ['queued', 'running'].includes(run.status));
  return <section className="ai-recommendations">
    <div className="commerce-panel"><h2>个人 AI 岗位评估</h2><p>与规则匹配并列，评分不是录用概率，也不能替代招聘方的资格审核。画像或岗位变化后需重新评估。</p><p>当前模型：{data.model || '未配置'} · 有效结果 {data.coverage?.current ?? 0}/{data.coverage?.total ?? 0} · 待更新 {data.coverage?.stale ?? 0}</p><p>今日新评估额度：已用 {data.quota?.used ?? 0}，剩余 {data.quota?.remaining ?? 0}（总计 {data.quota?.limit ?? 0}）</p>
      {!data.configured && <div className="inline-notice">平台尚未配置个人 AI 服务，规则匹配和岗位查询不受影响。</div>}{!data.profileReady && <p><Link to="/profile">请先填写专业、技能或目标岗位</Link></p>}
      <p className="muted">评估范围独立于规则列表的搜索条件，排除已截止及你设为“不感兴趣”的岗位；不会自动发起收费评估。</p>
      <form onSubmit={create}><div className="field-grid two"><label className="field"><span>评估范围</span><select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="top">规则优先的一批岗位</option><option value="all">全部可见岗位</option><option value="saved">已收藏岗位</option></select></label>{scope !== 'all' && <label className="field"><span>本批最多岗位数</span><input type="number" min="1" max="500" required value={limit} disabled={busy} onChange={event => setLimit(event.target.value)} /></label>}</div><label className="commerce-check"><input type="checkbox" required checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{data.privacy || '同意将本人的求职画像和岗位公开信息发送给平台配置的 AI 服务进行评估。'}</span></label><button className="button primary" disabled={busy || !online || !consent || !data.configured || !data.profileReady || active}>{busy ? '处理中…' : active ? '已有任务进行中' : '开始评估'}</button></form>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {Boolean(data.runs?.length) && <section className="commerce-panel"><h3>最近评估任务</h3>{data.runs.map(run => <article className="ai-run" key={run.id}><div><strong>{statuses[run.status] || run.status}</strong><p>有效完成 {run.completed ?? 0}（其中复用 {run.cached ?? 0}） · 失败 {run.failed ?? 0} · 跳过 {run.skipped ?? 0} / 共 {run.total ?? 0}</p>{run.error && <small>{run.error}</small>}</div>{['queued', 'running'].includes(run.status) && <button className="button secondary" disabled={busy || !online} onClick={() => action(run.id, 'cancel')}>取消任务</button>}{['partial', 'paused'].includes(run.status) && <button className="button secondary" disabled={busy || !online || active} onClick={() => action(run.id, 'resume')}>恢复评估</button>}</article>)}</section>}
    <div className="section-title-row"><h2>AI 推荐结果 · {page.total} 个岗位</h2><button className="button secondary" disabled={busy || refreshing || !online} onClick={refreshResults}>{refreshing ? '正在更新…' : '刷新推荐结果'}</button></div>
    <label className="field"><span>AI 最低评分</span><select value={minScore} disabled={busy || refreshing} onChange={event => { setNotice(''); setMinScore(event.target.value); }}><option value="0">显示全部已评估结果</option><option value="60">60 分及以上</option><option value="75">75 分及以上</option><option value="90">90 分及以上</option></select></label>
    {notice && <p className="inline-notice" role="status">{notice}</p>}
    {page.jobs?.length ? page.jobs.map(job => <article className="ai-job" key={job.id}><JobRow job={job} onStateChange={stateChanged} /><div className="ai-assessment"><strong>AI 评估 {job.aiAssessment?.score ?? '—'} 分 · {job.aiAssessment?.recommendation || '参考建议'}</strong><p>{job.aiAssessment?.reason}</p>{job.aiAssessment?.risks?.length > 0 && <p>需核实：{job.aiAssessment.risks.join('；')}</p>}<small>{job.aiAssessment?.model} · {job.aiAssessment?.assessedAt ? new Date(job.aiAssessment.assessedAt).toLocaleString('zh-CN') : ''} · 规则匹配分数仍独立展示</small></div></article>) : <EmptyState title={minScore !== '0' ? '暂无达到这个分数的结果' : '还没有当前画像的 AI 推荐'} description={minScore !== '0' ? '可以降低最低分，查看其他已评估岗位。' : '先发起评估，任务和已完成结果会保留在云端；关闭页面不会取消任务。'} icon="target" />}
    {page.nextCursor && <button className="button secondary" disabled={busy || refreshing || !online} onClick={loadMore}>加载更多推荐</button>}
  </section>;
}
