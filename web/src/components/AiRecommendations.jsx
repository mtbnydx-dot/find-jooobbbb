import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { request, newRequestKey } from '../lib/api';
import { EmptyState, ErrorState, LoadingState } from './StatusViews';
import { JobRow } from './JobRow';
import { useOnline } from '../hooks/useOnline';

const statuses = { queued: '等待评估', running: '评估中', complete: '已完成', partial: '部分完成', paused: '已暂停', cancelled: '已取消', stale: '画像已变化' };
export function AiRecommendations() {
  const online = useOnline();
  const [data, setData] = useState(null);
  const [page, setPage] = useState({ jobs: [], total: 0, nextCursor: '' });
  const [scope, setScope] = useState('top');
  const [limit, setLimit] = useState(20);
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const createKey = useRef({});
  const load = useCallback(async signal => {
    const [status, recommendations] = await Promise.all([request('/me/ai', { signal }), request('/me/ai/recommendations?limit=20', { signal })]);
    if (!signal?.aborted) { setData(status); setPage(recommendations); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal).catch(err => { if (err.name !== 'AbortError') setError(err.message); });
    const refresh = () => { if (document.visibilityState === 'visible' && navigator.onLine) request('/me/ai', { signal: controller.signal }).then(setData).catch(err => { if (err.name !== 'AbortError') setError(err.message); }); };
    const timer = setInterval(refresh, 10000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [load]);
  const action = async (id, command) => {
    setBusy(true); setError('');
    try { await request(`/me/ai/runs/${encodeURIComponent(id)}/${command}`, { method: 'POST', body: {} }); await load(); } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  const create = async event => {
    event.preventDefault(); setBusy(true); setError('');
    const signature = JSON.stringify({ scope, limit: scope === 'top' ? Number(limit) : undefined });
    if (createKey.current.signature !== signature) createKey.current = { signature, key: newRequestKey() };
    try {
      await request('/me/ai/runs', { method: 'POST', body: { scope, ...(scope === 'top' ? { limit: Number(limit) } : {}), consent, idempotencyKey: createKey.current.key } });
      createKey.current = {}; setConsent(false); await load();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  if (!data) return error ? <ErrorState message={error} onRetry={() => { setError(''); load().catch(err => setError(err.message)); }} /> : <LoadingState rows={4} label="正在读取个人 AI 评估" />;
  const active = data.runs?.some(run => ['queued', 'running'].includes(run.status));
  return <section className="ai-recommendations">
    <div className="commerce-panel"><h2>个人 AI 岗位评估</h2><p>与规则匹配并列，结果仅供参考，不代表招聘方判断。画像或岗位变化后需重新评估。</p><p>当前模型：{data.model || '未配置'} · 有效结果 {data.coverage?.current ?? 0}/{data.coverage?.total ?? 0} · 待更新 {data.coverage?.stale ?? 0}</p><p>今日新评估额度：已用 {data.quota?.used ?? 0}，剩余 {data.quota?.remaining ?? 0}（总计 {data.quota?.limit ?? 0}）</p>
      {!data.configured && <div className="inline-notice">平台尚未配置个人 AI 服务，规则匹配和岗位查询不受影响。</div>}{!data.profileReady && <p><Link to="/profile">请先填写专业、技能或目标岗位</Link></p>}
      <form onSubmit={create}><div className="field-grid two"><label className="field"><span>评估范围</span><select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="top">规则优先的一批岗位</option><option value="all">全部可见岗位</option><option value="saved">已收藏岗位</option></select></label>{scope === 'top' && <label className="field"><span>本批最多岗位数</span><input type="number" min="1" max="500" required value={limit} disabled={busy} onChange={event => setLimit(event.target.value)} /></label>}</div><label className="commerce-check"><input type="checkbox" required checked={consent} disabled={busy} onChange={event => setConsent(event.target.checked)} /><span>{data.privacy || '同意将本人的求职画像和岗位公开信息发送给平台配置的 AI 服务进行评估。'}</span></label><button className="button primary" disabled={busy || !online || !consent || !data.configured || !data.profileReady || active}>{busy ? '处理中…' : active ? '已有任务进行中' : '开始评估'}</button></form>
    </div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {Boolean(data.runs?.length) && <section className="commerce-panel"><h3>最近评估任务</h3>{data.runs.map(run => <article className="ai-run" key={run.id}><div><strong>{statuses[run.status] || run.status}</strong><p>完成 {run.completed ?? 0} · 复用 {run.cached ?? 0} · 失败 {run.failed ?? 0} / 共 {run.total ?? 0}</p>{run.error && <small>{run.error}</small>}</div>{['queued', 'running'].includes(run.status) && <button className="button secondary" disabled={busy || !online} onClick={() => action(run.id, 'cancel')}>取消任务</button>}{['partial', 'paused'].includes(run.status) && <button className="button secondary" disabled={busy || !online || active} onClick={() => action(run.id, 'resume')}>恢复评估</button>}</article>)}</section>}
    <div className="section-title-row"><h2>AI 推荐结果 · {page.total} 个岗位</h2><button className="button secondary" disabled={busy || !online} onClick={() => load().catch(err => setError(err.message))}>刷新推荐结果</button></div>
    {page.jobs?.length ? page.jobs.map(job => <article className="ai-job" key={job.id}><JobRow job={job} /><div className="ai-assessment"><strong>AI 评估 {job.aiAssessment?.score ?? '—'} 分 · {job.aiAssessment?.recommendation || '参考建议'}</strong><p>{job.aiAssessment?.reason}</p>{job.aiAssessment?.risks?.length > 0 && <p>需核实：{job.aiAssessment.risks.join('；')}</p>}<small>{job.aiAssessment?.model} · {job.aiAssessment?.assessedAt ? new Date(job.aiAssessment.assessedAt).toLocaleString('zh-CN') : ''} · 规则匹配分数仍独立展示</small></div></article>) : <EmptyState title="还没有当前画像的 AI 推荐" description="先发起评估，任务和已完成结果会保留在云端；关闭页面不会取消任务。" icon="target" />}
    {page.nextCursor && <button className="button secondary" disabled={busy} onClick={async () => { setBusy(true); try { const next = await request(`/me/ai/recommendations?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`); setPage(current => ({ ...next, jobs: [...current.jobs, ...next.jobs] })); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>加载更多推荐</button>}
  </section>;
}
