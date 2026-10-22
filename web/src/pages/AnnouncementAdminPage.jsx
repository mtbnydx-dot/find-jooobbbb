import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { newRequestKey, request } from '../lib/api';
import { safePublicLink, factualDate } from '../lib/job-detail';
import { ErrorState, LoadingState } from '../components/StatusViews';
import '../styles/announcements.css';

export const factLabels = { salaryText:'薪资原文', salaryCurrency:'币种', salaryPeriod:'薪资周期', salaryMonths:'发薪月数', benefits:'福利待遇', major:'专业要求', degree:'学历要求', experience:'经验要求', requirements:'任职要求', description:'岗位介绍', deadline:'截止日期', audience:'招聘对象', batch:'招聘批次', workMode:'工作方式', employmentType:'用工类型' };
const statusLabels = { queued:'等待核验', running:'正在核验', complete:'已完成提取', cancelled:'已取消', review:'待人工审核', approved:'已采纳', rejected:'已拒绝', blocked:'访问受限', unsupported:'需要人工读取', unavailable:'暂时无法访问', failed:'核验失败', mismatch:'岗位对应关系不符', needs_review:'需要人工核对', ok:'已读取', manual:'人工摘录' };
const statusText = value => statusLabels[value] || value || '未记录';
function SourceLink({ url, children = '查看原文' }) { const safe = safePublicLink(url); return safe ? <a href={safe} target="_blank" rel="noopener noreferrer">{children}</a> : <span>未提供可打开的公开链接</span>; }

function ReviewItem({ item, busy, mutate }) {
  const result = item.result || {}, facts = result.facts || {}, verification = result.verification || {};
  const [fields, setFields] = useState([]);
  const [includeVerification, setIncludeVerification] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState('');
  const editable = item.status === 'review';
  return <article className="commerce-panel announcement-item">
    <header><div><h3>{item.job?.company} · {item.job?.position}</h3><p><Link to={`/jobs/${encodeURIComponent(item.jobId)}`}>查看当前岗位</Link> · {item.jobId}</p></div><span className="announcement-status">{statusText(item.status)}</span></header>
    <p><SourceLink url={item.sourceUrl} /> · 本次检查 {factualDate(result.checkedAt || item.updatedAt)} · {statusText(result.accessStatus)}</p>
    <p className="inline-notice">{result.identity?.reason || '核验尚未完成'}{result.manual && `。人工摘录：${result.manual.reason}`}</p>
    {Object.keys(facts).length ? <div className="announcement-facts">{Object.entries(facts).map(([field, value]) => <label className="announcement-fact" key={field}>
      {editable && <input type="checkbox" disabled={busy} checked={fields.includes(field)} onChange={event => setFields(current => event.target.checked ? [...current, field] : current.filter(key => key !== field))} />}
      <span><strong>{factLabels[field] || field}</strong><span className="preline">{String(value)}</span>{item.job?.[field] !== undefined && String(item.job[field]) !== String(value) && <small>任务创建时的值：{String(item.job[field])}</small>}
        {(result.evidence || []).filter(entry => entry.fields.includes(field)).map((entry, index) => <span className="announcement-quote" key={index}><q>{entry.quote}</q><span><SourceLink url={entry.sourceUrl} /> · {entry.locator || '人工摘录'}{entry.method === 'manual-reviewed' ? ' · 人工核对' : ''}</span></span>)}
      </span>
    </label>)}</div> : <p>本次没有可直接采纳的岗位字段。不要把未提取到的信息理解为“不限”。</p>}
    <div className="announcement-verification"><strong>招聘有效性：{{ open:'公告窗口内（不保证名额）', closed:'存在结束招聘依据', unknown:'当前有效性未知' }[verification.status] || '尚未核验'}</strong><p>{verification.reason}</p>{verification.excerpt && <><q>{verification.excerpt}</q><p><SourceLink url={verification.evidenceUrl} /></p></>}
      {editable && verification.status !== 'unknown' && verification.status && <label className="commerce-check"><input type="checkbox" disabled={busy} checked={includeVerification} onChange={event => setIncludeVerification(event.target.checked)} /><span>采纳以上有效性依据（不会删除用户收藏或投递记录）</span></label>}
    </div>
    {editable ? <form onSubmit={event => { event.preventDefault(); mutate(`/admin/announcements/items/${item.id}/approve`, { fields, includeVerification, confirmIdentity:confirmed, reason }, fields.includes('salaryText') ? '已采纳薪资原文；未勾选的币种、周期和发薪月数已清空，避免混用旧依据。' : '已采纳选中的事实。已有人工更正仍优先。'); }}>
      <label className="commerce-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} /><span>我已核对公司、具体岗位、招聘届次及条件适用范围；并非其他岗位的要求</span></label>
      <label className="field"><span>审核依据或拒绝原因</span><textarea required maxLength={2000} value={reason} disabled={busy} onChange={event => setReason(event.target.value)} placeholder="说明为什么这些条件适用于当前岗位；总公告只采纳明确适用的共同条件" /></label>
      <div className="commerce-actions"><button className="button primary" disabled={busy || !confirmed || !reason.trim() || (!fields.length && !includeVerification)}>采纳选中内容</button><button className="button secondary" type="button" disabled={busy || !reason.trim()} onClick={() => mutate(`/admin/announcements/items/${item.id}/reject`, { reason }, '已拒绝本次结果，原岗位信息未改动。')}>拒绝本次结果</button></div>
      <p className="commerce-caption">薪资按一组更新，不能把不同公告的金额、币种和周期拼接；已有人工更正优先于公告提取。</p>
    </form> : item.decision?.reason && <p>审核记录：{item.decision.reason}</p>}
  </article>;
}

export function AnnouncementAdminPage() {
  const { user } = useAuth(), allowed = ['admin', 'content_editor'].includes(user?.role);
  const [summary, setSummary] = useState(null), [runs, setRuns] = useState({ items:[] }), [detail, setDetail] = useState(null), [selectedId, setSelectedId] = useState('');
  const [error, setError] = useState(''), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const [pollVersion, setPollVersion] = useState(0);
  const [ids, setIds] = useState(''), [query, setQuery] = useState(''), [jobs, setJobs] = useState([]), [searching, setSearching] = useState(false);
  const [manual, setManual] = useState({ jobId:'', evidenceUrl:'', field:'major', value:'', quote:'', reason:'', scope:'job' });
  const createKey = useRef(newRequestKey()), retryKey = useRef(newRequestKey()), manualKey = useRef(newRequestKey()), selectedRef = useRef(''), searchVersion = useRef(0), actionPending = useRef(false);
  const load = useCallback(async signal => {
    const [overview, listing] = await Promise.all([request('/admin/announcements', { signal }), request('/admin/announcements/runs', { signal })]);
    if (!signal?.aborted) { setSummary(overview); setRuns(listing); }
  }, []);
  useEffect(() => { if (!allowed) return; const c = new AbortController(); load(c.signal).catch(err => { if (err.name !== 'AbortError') setError(err.message); }); return () => c.abort(); }, [allowed, load]);
  useEffect(() => {
    selectedRef.current = selectedId; if (!selectedId) return;
    const c = new AbortController(); let timer; let pollFailed = false;
    const update = async () => {
      try { const data = await request(`/admin/announcements/runs/${selectedId}`, { signal:c.signal }); if (!c.signal.aborted) { setDetail(data); if (pollFailed) { setError(''); pollFailed = false; } if (['queued','running'].includes(data.run.status)) timer = setTimeout(update, 4000); else await load(c.signal); } }
      catch (err) { if (err.name !== 'AbortError' && !c.signal.aborted) { pollFailed = true; setError(err.message); timer = setTimeout(update, 8000); } }
    };
    update(); return () => { c.abort(); clearTimeout(timer); };
  }, [selectedId, pollVersion, load]);
  const mutate = async (path, body, success) => {
    if (actionPending.current) return; actionPending.current = true; setBusy(true); setError(''); setMessage('');
    try {
      const data = await request(path, { method:'POST', body });
      if (path.endsWith('/retry')) retryKey.current = newRequestKey();
      if (data.run) { setDetail(data); selectedRef.current = data.run.id; setSelectedId(data.run.id); }
      else if (data.item) setDetail(current => current ? { ...current, items:current.items.map(item => item.id === data.item.id ? data.item : item) } : current);
      // Keep request identities after success: a refresh failure must not duplicate a write.
      setPollVersion(value => value + 1); setMessage(success); try { await load(); } catch (refreshError) { setError(`操作已保存，但列表刷新失败：${refreshError.message}。可安全刷新查看。`); } return true;
    } catch (err) { setError(err.message); return false; }
    finally { actionPending.current = false; setBusy(false); }
  };
  const selectedIds = [...new Set(ids.split(/[\s,，]+/).filter(Boolean))];
  const changeIds = value => { setIds(value); createKey.current = newRequestKey(); };
  const search = async event => {
    event.preventDefault(); const version = ++searchVersion.current; setSearching(true); setError('');
    try { const data = await request(`/jobs?q=${encodeURIComponent(query.trim())}&limit=20&availability=all`); if (version === searchVersion.current) setJobs(data.items || data.jobs || []); }
    catch (err) { if (version === searchVersion.current) setError(err.message); }
    finally { if (version === searchVersion.current) setSearching(false); }
  };
  const changeManual = (key, value) => { setManual(current => ({ ...current, [key]:value })); manualKey.current = newRequestKey(); };
  if (!allowed) return <div className="page"><h1>仅管理员和内容编辑可访问</h1><Link to="/">返回首页</Link></div>;
  if (!summary) return <div className="page">{error ? <ErrorState message={error} onRetry={() => load().catch(err => setError(err.message))} /> : <LoadingState rows={4} />}</div>;
  return <div className="page announcement-admin"><header className="page-header"><div><Link to="/admin">返回管理后台</Link><h1>原公告核验</h1><p>逐项保留原文依据，先审核，再补充到公开岗位。不会修改个人画像、自选或会员配置。</p></div><button type="button" className="button secondary" disabled={busy} onClick={() => { setPollVersion(value => value + 1); load().catch(err => setError(err.message)); }}>刷新任务</button></header>
    {error && <div className="form-error" role="alert">{error}</div>}{message && <div className="form-success" role="status">{message}</div>}
    <p className="inline-notice">仅处理你明确发起的任务，每批最多 50 个岗位，不自动创建定时采集，不调用收费 AI。同一批次相同公告只读取一次，但按各岗位分别判断。登录、验证码、附件和动态页面不能读取时，保持“待核实”，不会自动判为停招。</p>
    <section className="commerce-panel"><h2>选择需要核实的岗位</h2><form onSubmit={search} className="commerce-actions"><label className="field"><span>搜索当前目录</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="公司或岗位名称" /></label><button className="button secondary" disabled={searching}>{searching ? '搜索中…' : '搜索岗位'}</button></form>
      <div className="announcement-search-results">{jobs.map(job => <label className="commerce-check" key={job.id}><input type="checkbox" disabled={busy || !selectedIds.includes(job.id) && selectedIds.length >= 50} checked={selectedIds.includes(job.id)} onChange={event => changeIds((event.target.checked ? [...selectedIds, job.id] : selectedIds.filter(id => id !== job.id)).join('\n'))} /><span><strong>{job.company} · {job.position}</strong><small>{job.location} · {job.experience || '经验未注明'} · {job.major || '专业未注明'}</small></span></label>)}</div>
      <form onSubmit={event => { event.preventDefault(); mutate('/admin/announcements/runs', { jobIds:selectedIds, idempotencyKey:createKey.current }, '核验任务已创建；提取结果需逐条审核。'); }}><label className="field"><span>已选岗位 ID（可粘贴，每行一个）· {selectedIds.length}/50</span><textarea value={ids} disabled={busy} onChange={event => changeIds(event.target.value)} /></label><button className="button primary" disabled={busy || !selectedIds.length || selectedIds.length > 50 || Boolean(summary.activeRun)}>发起原公告核验</button>{summary.activeRun && <button className="button secondary" type="button" onClick={() => { setDetail(null); setSelectedId(summary.activeRun.id); setPollVersion(value => value + 1); }}>查看正在运行的任务</button>}<button className="button secondary" type="button" disabled={busy || Boolean(summary.activeRun) || !selectedIds.length} onClick={() => { createKey.current = newRequestKey(); setMessage('已准备新一轮核验，请点击“发起原公告核验”。'); }}>为当前选择开启新一轮</button></form>
    </section>
    <details className="commerce-panel"><summary>无法自动读取？人工摘录官方原文</summary><p>用于已人工打开的原公告或附件。必须写清适用范围，只生成待审核候选；不能据此假称报名系统仍在开放。多岗位公告仅填写明确通用的条件。</p><form onSubmit={event => { event.preventDefault(); mutate('/admin/announcements/manual', { jobId:manual.jobId.trim(), evidenceUrl:manual.evidenceUrl, facts:{ [manual.field]:manual.value }, evidence:[{ fields:[manual.field], quote:manual.quote, sourceUrl:manual.evidenceUrl }], reason:manual.reason, scope:manual.scope, idempotencyKey:manualKey.current }, '人工摘录已保存，请在下方逐条核对后采纳。'); }}>
      <div className="field-grid two">{[['jobId','岗位 ID'],['evidenceUrl','官方原文或附件链接']].map(([key,label]) => <label className="field" key={key}><span>{label}</span><input required disabled={busy} type={key === 'evidenceUrl' ? 'url' : 'text'} value={manual[key]} onChange={event => changeManual(key,event.target.value)} /></label>)}<label className="field"><span>补充字段</span><select value={manual.field} onChange={event => changeManual('field',event.target.value)}>{Object.entries(factLabels).filter(([key]) => !['salaryCurrency','salaryPeriod','salaryMonths'].includes(key)).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></label><label className="field"><span>条件适用范围</span><select value={manual.scope} onChange={event => changeManual('scope',event.target.value)}><option value="job">已定位具体岗位</option><option value="company">总公告的明确共同条件</option></select></label></div>
      {[['value','要补充的事实'],['quote','支持该字段的原文短摘'],['reason','为什么适用于此岗位（至少六个字）']].map(([key,label]) => <label className="field" key={key}><span>{label}</span><textarea required minLength={key === 'reason' ? 6 : 1} maxLength={4000} disabled={busy} value={manual[key]} onChange={event => changeManual(key,event.target.value)} /></label>)}<button className="button secondary" disabled={busy}>提交人工摘录待审核</button>
    </form></details>
    <section className="commerce-panel"><h2>核验任务</h2><div className="announcement-runs">{runs.items.map(run => <button type="button" key={run.id} className={`button ${selectedId === run.id ? 'primary' : 'secondary'}`} disabled={busy} onClick={() => { setDetail(null); setSelectedId(run.id); setPollVersion(value => value + 1); }}>{factualDate(run.createdAt)} · {run.total} 项 · {statusText(run.status)}</button>)}</div>{!runs.items.length && <p>尚未创建核验任务。</p>}{runs.nextCursor && <button className="button secondary" type="button" disabled={busy} onClick={async () => { setBusy(true); try { const next = await request(`/admin/announcements/runs?cursor=${encodeURIComponent(runs.nextCursor)}`); setRuns(current => ({ ...next, items:[...current.items,...next.items] })); } catch (err) { setError(err.message); } finally { setBusy(false); } }}>加载更早任务</button>}</section>
    {selectedId && !detail && <LoadingState rows={3} />}{detail && <section><header className="page-header"><div><h2>当前任务 · {statusText(detail.run.status)}</h2><p>{Object.entries(detail.run.counts || {}).map(([key,count]) => `${statusText(key)} ${count}`).join(' · ')}</p></div><div className="commerce-actions">{['queued','running'].includes(detail.run.status) ? <button className="button secondary" disabled={busy} onClick={() => mutate(`/admin/announcements/runs/${detail.run.id}/cancel`, {}, '任务已取消，已审核事实保留。')}>取消未完成项</button> : <button className="button secondary" disabled={busy || detail.run.retry?.used >= 3 || !detail.items.some(item => ['blocked','unavailable','unsupported','cancelled','failed'].includes(item.status))} onClick={() => mutate(`/admin/announcements/runs/${detail.run.id}/retry`, { idempotencyKey:retryKey.current }, '已重试未成功项，待审核和已审核结果不会覆盖。')}>重试未成功项（{detail.run.retry?.used || 0}/3）</button>}</div></header>{detail.items.map(item => <ReviewItem key={`${item.id}-${item.status}`} item={item} busy={busy} mutate={mutate} />)}</section>}
  </div>;
}
