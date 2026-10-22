import React, { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Company, Empty, Field, Meta, Notice, Sheet, TopBar } from '../components/UI';
import Icon from '../components/Icon';
import { api, newRequestKey, request, workspaceApi } from '../lib/api';
import { useMobile, useResource } from '../lib/runtime';
import { useJobAction } from '../lib/use-job-action';
import { JOB_FILTER_DEFAULTS, JOB_FILTER_LABELS, JOB_FILTER_OPTIONS, jobDeadlineLabel, jobFilterChips, jobFilterParams, jobSourceText, jobTitle, matchScore, mergeJobs, readJobFilters, salaryText, stageLabel, validateJobFilters } from '../lib/job-tools';
import './jobs.css';

// A new query, account or first-page response invalidates every old cursor.
function useJobPages(loader, query) {
  const { notify } = useMobile();
  const resource = useResource(signal => loader('', signal), [query]);
  const [extra, setExtra] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const head = useRef(resource.data), active = useRef(null), lock = useRef(false);
  head.current = resource.data;
  useEffect(() => {
    active.current?.abort(); lock.current = false; setBusy(false); setError('');
    return () => { active.current?.abort(); };
  }, [resource.data, query]);
  const appended = extra?.head === resource.data ? extra : null;
  const jobs = mergeJobs(resource.data?.jobs || [], appended?.jobs || []);
  const nextCursor = appended ? appended.nextCursor : resource.data?.nextCursor;
  const more = async () => {
    if (lock.current || resource.loading || !nextCursor) return;
    const current = resource.data, controller = new AbortController(); active.current = controller;
    lock.current = true; setBusy(true); setError('');
    try {
      const result = await loader(nextCursor, controller.signal);
      if (controller.signal.aborted || head.current !== current) return;
      setExtra({ head: current, jobs: mergeJobs(appended?.jobs || [], result.jobs || []), nextCursor: result.nextCursor });
    } catch (failure) {
      if (controller.signal.aborted || head.current !== current) return;
      if (failure.code === 'CURSOR_STALE') { notify('目录或个人进度已更新，已重新读取第一页。'); void resource.reload(); }
      else setError(failure.message || '加载更多未完成');
    } finally { if (active.current === controller) { lock.current = false; setBusy(false); } }
  };
  return { ...resource, jobs, more, moreBusy: busy, moreError: error, nextCursor };
}

export function JobCard({ job }) {
  const location = useLocation(), { notify } = useMobile();
  const action = useJobAction();
  const saved = Boolean(job.userState?.saved), hidden = Boolean(job.userState?.hidden), score = matchScore(job);
  const state = { returnTo: location.pathname + location.search };
  return <article className="job-card live-job-card">
    <Company job={job}><button className={`save-control ${saved ? 'active' : ''}`} disabled={action.busy || action.confirming} onClick={() => action.run(job.id, { saved: !saved }, result => notify(result.saved ? '已收藏到你的账号' : '已取消收藏，投递进度保留'))} aria-label={`${saved ? '取消收藏' : '收藏'}${jobTitle(job)}`} aria-pressed={saved}><Icon name="star" size={20} filled={saved} /><span>{action.busy ? '保存中' : saved ? '已收藏' : '收藏'}</span></button></Company>
    <Link to={`/jobs/${encodeURIComponent(job.id)}`} state={state} className="job-title-row"><h2>{jobTitle(job)}</h2><strong>{salaryText(job)}</strong></Link><Meta job={job} />
    <div className="job-tags">{score !== null && <span className="tag">规则分 {score}</span>}{job.match?.qualification?.status === 'fail' && <span className="job-risk">硬条件存在冲突</span>}{job.match?.qualification?.status === 'unknown' && <span className="caption">资格待核实</span>}{job.userState?.status && !['not_applied', 'saved'].includes(job.userState.status) && <span className="tag">{stageLabel(job.userState)}</span>}</div>
    <p className="caption job-deadline">{jobDeadlineLabel(job)}</p><Link className="source-row" to={`/jobs/${encodeURIComponent(job.id)}/source`} state={state}><Icon name="file" size={19} /><span>{jobSourceText(job)}</span><Icon name="chevron" size={18} /></Link>
    <button className="text-link job-hide" disabled={action.busy || action.confirming} onClick={() => action.run(job.id, { hidden: !hidden }, () => notify(hidden ? '已恢复到岗位列表' : '已移入暂不考虑，可在筛选中恢复'))}>{hidden ? '恢复到岗位列表' : '暂不考虑'}</button>
    {action.error && <p className="job-error" role="alert">{action.error}</p>}
  </article>;
}

function SelectFilter({ name, draft, update }) {
  return <Field label={JOB_FILTER_LABELS[name]}><select value={draft[name]} onChange={event => update(name, event.target.value)}>{JOB_FILTER_OPTIONS[name].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>;
}

export default function Discovery() {
  const [params, setParams] = useSearchParams(), navigate = useNavigate(), location = useLocation();
  const { user, authStatus, notify, bumpRefresh } = useMobile();
  const filters = readJobFilters(params), query = jobFilterParams(filters).toString();
  const [search, setSearch] = useState(filters.q), [sheet, setSheet] = useState(''), [draft, setDraft] = useState(filters), [filterError, setFilterError] = useState('');
  const [saveName, setSaveName] = useState(''), [saveError, setSaveError] = useState(''), [saving, setSaving] = useState(false);
  const ownedEditSearch = user?.id && location.state?.editSearch?.userId === user.id ? location.state.editSearch : null;
  const [editSearch, setEditSearch] = useState(ownedEditSearch);
  const savingRef = useRef(false), currentUser = useRef(user?.id), live = useRef(true);
  currentUser.current = user?.id;
  const pages = useJobPages((cursor, signal) => {
    const invalid = validateJobFilters(filters); if (invalid) return Promise.reject(new Error(invalid));
    return api.jobs.list({ ...filters, cursor, limit: 20 }, signal);
  }, query);
  useEffect(() => { setSearch(filters.q); }, [filters.q]);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => { setSheet(''); setSaveError(''); setEditSearch(ownedEditSearch); }, [user?.id, ownedEditSearch]);
  const apply = next => {
    const invalid = validateJobFilters(next); if (invalid) { setFilterError(invalid); return; }
    const nextParams = jobFilterParams(next);
    if (!user && next.view !== 'all' && authStatus === 'anonymous') { navigate(`/auth/login?returnTo=${encodeURIComponent(`/discover?${nextParams}`)}`); return; }
    setParams(nextParams); setSearch(next.q); setSheet(''); setFilterError('');
  };
  const openFilter = type => { setDraft(filters); setFilterError(''); setSheet(type); };
  const openSave = () => {
    if (authStatus === 'loading') return;
    if (authStatus === 'error') { notify('暂时无法确认登录，请联网后重试'); return; }
    if (!user) { navigate(`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`); return; }
    setSaveName(editSearch?.name || [filters.q, filters.location, filters.major].filter(Boolean).join(' · ') || '我的岗位搜索'); setSaveError(''); setSheet('save');
  };
  const saveSearch = async () => {
    if (savingRef.current || !saveName.trim()) return;
    if (authStatus !== 'authenticated' || !user) { setSaveError('请先重新确认登录状态，再保存搜索。'); return; }
    const owner = user?.id; savingRef.current = true; setSaving(true); setSaveError('');
    try {
      const body = { name: saveName.trim(), filters };
      const result = editSearch ? await request(`/me/saved-searches/${encodeURIComponent(editSearch.id)}`, { method: 'PUT', body }) : await workspaceApi.saveSearch(body);
      if (!live.current || currentUser.current !== owner) return;
      setSheet(''); setEditSearch(null); notify(result.duplicate ? '已有相同条件的保存搜索，没有重复创建' : '搜索条件已保存到账号'); bumpRefresh();
    } catch (failure) { if (live.current && currentUser.current === owner) setSaveError(failure.message); }
    finally { savingRef.current = false; if (live.current) setSaving(false); }
  };
  const chips = jobFilterChips(filters);
  return <><TopBar /><main className="page discover-page live-jobs"><h1>发现机会</h1>
    <form className="search-box" onSubmit={event => { event.preventDefault(); apply({ ...filters, q: search.trim(), sort: search.trim() ? 'relevance' : filters.sort }); }}><Icon name="search" /><input aria-label="搜索岗位、公司、关键词" placeholder="搜索岗位、公司、关键词" value={search} onChange={event => setSearch(event.target.value)} /><button aria-label="执行搜索" type="submit"><Icon name="chevron" size={20} /></button></form>
    <div className="discovery-tabs"><button className={filters.sort === 'match' ? 'selected' : ''} onClick={() => apply({ ...filters, sort: 'match' })}>为你推荐</button><button className={filters.sort !== 'match' ? 'selected' : ''} onClick={() => apply({ ...filters, sort: 'latest' })}>全部岗位</button><Link to="/ai"><Icon name="spark" size={19} filled />个人 AI 推荐</Link></div>
    <div className="filter-row"><button onClick={() => openFilter('地点')}><Icon name="pin" /><span>{filters.location || '地点'}</span><Icon name="down" size={16} /></button><button onClick={() => openFilter('专业')}><Icon name="cap" /><span>{filters.major || '专业'}</span><Icon name="down" size={16} /></button><button onClick={() => openFilter('筛选')}><Icon name="filter" />筛选{chips.length ? ` · ${chips.length}` : ''}<Icon name="down" size={16} /></button></div>
    {chips.length > 0 && <div className="job-applied-chips">{chips.map(chip => <button key={chip.key} onClick={() => apply({ ...filters, [chip.key]: JOB_FILTER_DEFAULTS[chip.key] })} aria-label={`移除${chip.label}筛选`}>{chip.label}：{chip.value}<Icon name="close" size={13} /></button>)}<button onClick={() => apply({ ...JOB_FILTER_DEFAULTS })}>清除筛选</button></div>}
    <div className="job-results-meta"><span>{pages.loading ? '正在读取…' : pages.data ? `${pages.data.total} 个机会` : '岗位目录'} · {JOB_FILTER_OPTIONS.availability.find(([value]) => value === filters.availability)?.[1]}</span><button className="text-link" onClick={openSave} disabled={authStatus === 'loading'}>{editSearch ? '更新保存搜索' : '保存搜索'}</button></div>
    <p className="caption job-rule-note">规则分不是录用概率；未知条件、薪资与实际招聘名额仍需核实。</p>
    {pages.data?.dataQuality && <details className="job-quality"><summary>目录数据说明</summary><p>当前目录 {pages.data.dataQuality.total} 条；明确过期 {pages.data.dataQuality.expired} 条；截止日期待确认 {pages.data.dataQuality.unknownDeadline} 条。列表结果另按你的筛选条件计算。</p></details>}
    {pages.error && <Notice tone="amber">{pages.error.message}{pages.error.status === 401 ? <Link className="text-link" to={`/auth/login?returnTo=${encodeURIComponent(location.pathname + location.search)}`}>登录后查看个人记录</Link> : <button className="text-link" onClick={pages.reload}>重新加载</button>}</Notice>}
    {filterError && !sheet && <p className="job-error" role="alert">{filterError}</p>}
    {pages.loading && !pages.data ? <p className="loading-text" role="status">正在寻找机会…</p> : pages.jobs.length ? <div className="job-list">{pages.jobs.map(job => <JobCard key={job.id} job={job} />)}</div> : !pages.error && <Empty title="没有找到符合条件的岗位" message="试试放宽城市、关键词或专业条件。" label="清除筛选" action={() => apply({ ...JOB_FILTER_DEFAULTS })} />}
    {pages.moreError && <p className="job-error" role="alert">{pages.moreError}</p>}{pages.nextCursor && <Button className="full" variant="outline" disabled={pages.moreBusy || pages.loading} onClick={pages.more}>{pages.moreBusy ? '加载中…' : '加载更多岗位'}</Button>}
  </main>
    {sheet && sheet !== 'save' && <Sheet title={sheet === '筛选' ? '筛选岗位' : `选择${sheet}`} onClose={() => setSheet('')} footer={<><Button variant="outline" onClick={() => setDraft({ ...JOB_FILTER_DEFAULTS })}>重置</Button><Button onClick={() => apply(draft)}>应用条件</Button></>}>
      {['location', 'major', 'role', 'industry', 'nature', 'source'].map(name => <Field key={name} label={JOB_FILTER_LABELS[name]}><input aria-label={JOB_FILTER_LABELS[name]} value={draft[name]} list={`mobile-facet-${name}`} maxLength={300} placeholder="不限，也可直接输入" onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))} /><datalist id={`mobile-facet-${name}`}>{(pages.data?.facets?.[name] || []).map(item => <option value={item.value} key={item.value}>{item.label} · {item.count}</option>)}</datalist></Field>)}
      <div className="form-row"><Field label="币种"><select value={draft.currency} onChange={event => setDraft(current => ({ ...current, currency: event.target.value }))}><option value="">不限币种</option>{['CNY', 'AUD', 'USD', 'HKD', 'SGD', 'EUR', 'GBP', 'JPY', 'CAD', 'NZD'].map(value => <option key={value}>{value}</option>)}</select></Field><SelectFilter name="salaryPeriod" draft={draft} update={(name, value) => setDraft(current => ({ ...current, [name]: value }))} /></div>
      <div className="form-row">{['salaryMin', 'salaryMax'].map(name => <Field label={JOB_FILTER_LABELS[name]} key={name}><input type="number" min="0" value={draft[name]} onChange={event => setDraft(current => ({ ...current, [name]: event.target.value }))} /></Field>)}</div>
      {['sort', 'availability', 'qualification', 'view', 'deadlineWithin'].map(name => <SelectFilter key={name} name={name} draft={draft} update={(key, value) => setDraft(current => ({ ...current, [key]: value }))} />)}
      <Field label="最低规则分"><input type="number" min="0" max="100" value={draft.minMatch} onChange={event => setDraft(current => ({ ...current, minMatch: event.target.value }))} /></Field>
      <Notice>筛选项来自当前目录，也可自由输入。薪资比较需指定相同币种和周期；未知条件不表示资格通过。</Notice>{filterError && <p className="job-error" role="alert">{filterError}</p>}
    </Sheet>}
    {sheet === 'save' && <Sheet title={editSearch ? '更新保存搜索' : '保存搜索条件'} onClose={() => { if (!saving) setSheet(''); }} footer={<Button disabled={saving || !saveName.trim()} onClick={saveSearch}>{saving ? '保存中…' : '保存到账号'}</Button>}><Field label="搜索名称"><input value={saveName} maxLength={100} onChange={event => setSaveName(event.target.value)} /></Field><Notice>保存当前已应用的筛选条件。新匹配通知取决于你的通知设置与可用渠道，不会自动发送。</Notice>{editSearch && <button className="text-link" onClick={() => setEditSearch(null)}>另存为新的搜索</button>}{saveError && <p role="alert" className="job-error">{saveError}</p>}</Sheet>}
  </>;
}

const RUN_LABELS = { queued: '排队中', running: '评估中', complete: '已完成', partial: '部分完成', paused: '已暂停', cancelled: '已取消', stale: '画像已变化' };
export function AiPage() {
  const { user, notify } = useMobile();
  const [consent, setConsent] = useState(false), [scope, setScope] = useState('top'), [limit, setLimit] = useState(20), [minScore, setMinScore] = useState('0');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const status = useResource(signal => request('/me/ai', { signal }), []);
  const pages = useJobPages((cursor, signal) => request(`/me/ai/recommendations?${new URLSearchParams({ limit: '20', minScore, ...(cursor ? { cursor } : {}) })}`, { signal }), minScore);
  const lock = useRef(false), retry = useRef(null), owner = useRef(user?.id), mounted = useRef(true), progress = useRef(''); owner.current = user?.id;
  const runs = status.data?.runs || [], active = runs.some(run => ['queued', 'running'].includes(run.status));
  const progressKey = runs.map(run => `${run.id}:${run.status}:${run.completed}:${run.failed}:${run.cached}`).join('|');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { retry.current = null; setConsent(false); setError(''); }, [user?.id]);
  useEffect(() => { if (progress.current && progress.current !== progressKey) void pages.reload(); progress.current = progressKey; }, [progressKey, pages.reload]);
  useEffect(() => {
    if (!active) return undefined;
    const timer = window.setInterval(() => { if (!lock.current && document.visibilityState === 'visible' && navigator.onLine) void status.reload(); }, 10000);
    return () => window.clearInterval(timer);
  }, [active, status.reload]);
  const mutate = async (action, run) => {
    if (lock.current || !user) return;
    if (action === 'create' && (!consent || !status.data?.configured || !status.data?.profileReady)) return;
    const identity = user.id; lock.current = true; setBusy(true); setError('');
    try {
      let path, body = {};
      if (action === 'create') {
        body = { scope, ...(scope === 'all' ? {} : { limit: Number(limit) }), consent: true };
        const signature = JSON.stringify(body);
        if (retry.current?.signature !== signature) retry.current = { signature, key: newRequestKey() };
        body.idempotencyKey = retry.current.key; path = '/me/ai/runs';
      } else path = `/me/ai/runs/${encodeURIComponent(run.id)}/${action}`;
      await request(path, { method: 'POST', body });
      if (!mounted.current || owner.current !== identity) return;
      if (action === 'create') retry.current = null;
      notify(action === 'create' ? '已提交个人 AI 评估任务，可在本页查看进度' : '任务操作已保存');
      await Promise.all([status.reload(), pages.reload()]);
    } catch (failure) { if (mounted.current && owner.current === identity) setError(`${failure.message}${action === 'create' ? '；若未确认结果，重试同一范围将复用请求编号。' : ''}`); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  return <><TopBar title="个人 AI 推荐" back action={null} /><main className="page live-jobs"><h1>多一个角度，找机会</h1><p className="muted">规则匹配与 AI 建议并列参考，最终以招聘公告为准。</p>
    {status.loading && !status.data && <p className="loading-text" role="status">正在读取个人 AI 状态…</p>}
    {status.error && <Notice tone="amber">{status.error.message}<button className="text-link" onClick={status.reload}>重试</button></Notice>}
    {status.data && <><Notice icon="spark">{status.data.configured ? `当前模型：${status.data.model}。本日剩余额度 ${status.data.quota?.remaining ?? '待确认'} / ${status.data.quota?.limit ?? '待确认'} 个岗位。` : '个人 AI 服务尚未配置，目前不能开始评估。'} 额度按服务设置调整；模型建议不是录用承诺。</Notice>
      {!status.data.profileReady && <Notice tone="amber">请先完成求职画像，AI 才能给出个人评估。<Link className="text-link" to="/onboarding">完善画像</Link></Notice>}
      <section className="plain-section"><h2>评估范围</h2><Field label="选择范围"><select value={scope} disabled={busy} onChange={event => setScope(event.target.value)}><option value="top">规则排序靠前的岗位</option><option value="saved">我的收藏</option><option value="all">全部可见岗位</option></select></Field>{scope !== 'all' && <Field label="本次最多评估岗位数"><input type="number" min="1" max="500" value={limit} disabled={busy} onChange={event => setLimit(event.target.value)} /></Field>}
      <label className="check-line"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={busy} />我同意将求职画像与公开岗位资料发送给已配置的 AI 服务进行评估，不包含邮箱、私人备注与附件。点击后才创建真实任务并使用服务额度。</label>
      <Button className="full" disabled={busy || !consent || !status.data.configured || !status.data.profileReady || status.data.quota?.remaining === 0 || (scope !== 'all' && (!Number.isInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 500))} onClick={() => mutate('create')}>{busy ? '提交中…' : '开始真实 AI 评估'}</Button></section>
      <p className="caption job-rule-note">已评估 {status.data.coverage?.current ?? 0} 个当前画像岗位；旧画像结果 {status.data.coverage?.stale ?? 0} 个。任务在云端运行，离开页面不会自动取消。</p>
      {runs.slice(0, 5).map(run => <section className="job-ai-run" key={run.id}><strong>{RUN_LABELS[run.status] || run.status} · {run.completed} / {run.total}</strong><p className="caption">复用 {run.cached || 0} · 失败 {run.failed || 0} · 跳过 {run.skipped || 0}</p>{run.error && <p className="job-error">{run.error}</p>}{['queued', 'running'].includes(run.status) && <button className="text-link" disabled={busy} onClick={() => mutate('cancel', run)}>取消任务</button>}{['paused', 'partial'].includes(run.status) && <button className="text-link" disabled={busy || !consent} onClick={() => mutate('resume', run)}>继续评估（需勾选同意）</button>}</section>)}
    </>}
    {error && <p className="job-error" role="alert">{error}</p>}<div className="section-title job-ai-results"><h2>个人推荐结果</h2><button className="text-link" disabled={status.loading || pages.loading} onClick={() => { void status.reload(); void pages.reload(); }}>刷新结果</button></div>
    <Field label="最低 AI 建议分"><select value={minScore} onChange={event => setMinScore(event.target.value)}>{['0', '40', '60', '80'].map(value => <option value={value} key={value}>{value === '0' ? '不限建议分' : `${value} 分及以上`}</option>)}</select></Field>
    {pages.error && <Notice tone="amber">{pages.error.message}<button className="text-link" onClick={pages.reload}>重试</button></Notice>}
    {pages.loading && !pages.data ? <p className="loading-text">正在读取结果…</p> : pages.jobs.length ? pages.jobs.map(job => <div className="ai-result" key={job.id}><JobCard job={job} /><div className="ai-explanation"><strong>AI 建议分 {job.aiAssessment?.score ?? '—'}</strong><p>{job.aiAssessment?.reason}</p>{(job.aiAssessment?.risks || []).map((risk, index) => <p className="job-risk" key={index}>{risk}</p>)}<small>{job.aiAssessment?.model} · 模型建议不替代公告核实</small></div></div>) : !pages.error && <Notice>暂无符合当前分数条件的个人 AI 结果。可以放宽分数条件，或在了解数据发送范围后主动开始评估。</Notice>}
    {pages.data && <p className="caption">已显示 {pages.jobs.length} / {pages.data.total} 条个人推荐</p>}{pages.moreError && <p className="job-error" role="alert">{pages.moreError}</p>}{pages.nextCursor && <Button variant="outline" className="full" disabled={pages.moreBusy || pages.loading} onClick={pages.more}>{pages.moreBusy ? '加载中…' : '加载更多推荐'}</Button>}
  </main></>;
}
