import React, { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { Button, Company, Empty, Meta, Notice, Page, Sheet, TopBar } from '../components/UI';
import Icon from '../components/Icon';
import { api } from '../lib/api';
import { useMobile, useResource } from '../lib/runtime';
import { useJobAction } from '../lib/use-job-action';
import { availabilityMessage, companyName, detailLines, factualDate, jobDeadlineLabel, jobSourceText, jobTitle, matchScore, safeJobReturn, safePublicLink, salaryText } from '../lib/job-tools';
import { ProgressEditor } from './Progress';
import './jobs.css';

function Fact({ icon, label, children }) { return <div className="fact"><Icon name={icon} /><span>{label}：</span><p>{children || '来源未注明'}</p></div>; }
function JobLoad({ resource, title = '岗位详情' }) {
  return <Page title={title}>{resource.loading ? <p className="loading-text" role="status">正在读取岗位…</p> : <Empty title={resource.error?.status === 404 ? '岗位暂不可用' : '暂时无法读取'} message={resource.error?.message || '请回到发现页查看其他机会。'} action={resource.reload} label="重试" />}</Page>;
}
export default function JobDetail() {
  const { id } = useParams(), location = useLocation(), navigate = useNavigate();
  const { user, authStatus, notify } = useMobile();
  const resource = useResource(signal => api.jobs.get(id, signal), [id]);
  const [apply, setApply] = useState(false), [editing, setEditing] = useState(false);
  const { run, busy, error, confirming } = useJobAction();
  const job = resource.data?.job;
  if (!job) return <JobLoad resource={resource} />;
  const saved = Boolean(job.userState?.saved), score = matchScore(job);
  const requirements = detailLines(job.requirements), benefits = detailLines(job.benefits);
  const checks = job.match?.qualification?.checks || [];
  const canonical = job.canonicalId || job.id;
  const returnState = { returnTo: safeJobReturn(location.state?.returnTo) };
  const applicationUrl = job.available !== false && job.application?.kind === 'web' ? safePublicLink(job.application.href) : '';
  const emailUrl = job.available !== false && job.application?.kind === 'email' && /^mailto:[^\s?@]+@[^\s?@]+$/.test(job.application.href || '') ? job.application.href : '';
  const toggleSaved = () => run(canonical, { saved: !saved }, state => { resource.setData(current => ({ ...current, job: { ...current.job, userState: state } })); notify(state.saved ? '已收藏到你的账号' : '已取消收藏，其他进度保留'); });
  const openProgress = () => {
    if (authStatus === 'loading') return;
    if (authStatus === 'error') { notify('暂时无法确认登录，请联网后重试'); return; }
    if (!user) { navigate(`/auth/login?returnTo=${encodeURIComponent(location.pathname)}`); return; }
    setApply(false); setEditing(true);
  };
  return <><TopBar title="岗位详情" back action={null} /><main className="page detail-page live-jobs">
    <Link className="text-link" to={safeJobReturn(location.state?.returnTo)}>返回{location.state?.returnTo?.startsWith('/pipeline') ? '求职进度' : '岗位列表'}</Link>
    <Company job={job} /><h1>{jobTitle(job)}</h1><p className="detail-salary">{salaryText(job)}</p><Meta job={job} />
    <Link className="source-banner" to={`/jobs/${encodeURIComponent(canonical)}/source`} state={returnState}><Icon name="file" /><span>岗位来源</span><strong>查看原文与核验记录</strong><Icon name="chevron" size={18} /></Link>
    {resource.error && <Notice tone="amber">刷新未完成，以下是上次读取的记录。<button className="text-link" onClick={resource.reload}>重试</button></Notice>}
    <section className="fact-section"><div className="section-title"><h2>你需要满足</h2></div><Fact icon="cap" label="专业">{job.major}</Fact><Fact icon="briefcase" label="经验">{job.experience}</Fact><Fact icon="user" label="对象">{job.audience || job.batch}</Fact>{requirements.length > 0 && <ul className="clean-list job-lines">{requirements.map((line, index) => <li key={index}>{line}</li>)}</ul>}{job.description && <div className="job-description"><h3>岗位介绍</h3><p>{String(job.description)}</p></div>}</section>
    {(score !== null || checks.length > 0) && <section className="fact-section"><div className="section-title"><h2>条件匹配</h2>{score !== null && <span className="tag">规则分 {score}</span>}</div><p className="caption">规则分用于排列机会，不是录用概率；未知条件仍需核实。</p>{checks.map((check, index) => <div className="job-check" key={check.key || index}><strong>{check.label || check.key} · {check.status === 'fail' ? '存在冲突' : check.status === 'pass' ? '已知条件通过' : '待确认'}</strong><p>{check.requirement && `岗位：${check.requirement}`}</p><p>{check.message}</p></div>)}{detailLines(job.match?.reasons).map((line, index) => <p className="job-explanation" key={index}>{line}</p>)}{detailLines(job.match?.gaps).map((line, index) => <p className="job-risk" key={index}>{line}</p>)}</section>}
    {score === null && <Link className="text-link" to="/onboarding">完善画像，查看规则匹配 <Icon name="chevron" size={16} /></Link>}
    <section className="fact-section"><div className="section-title"><h2>薪资与福利</h2></div><Fact icon="money" label="薪资">{salaryText(job)}</Fact><Fact icon="gift" label="福利">{benefits.length ? benefits.join(' · ') : '来源未公开完整福利'}</Fact></section>
    <section className="fact-section status-section"><h2>招聘状态</h2><Notice tone={job.availability?.status === 'expired' || job.available === false ? 'amber' : ''}>{job.available === false ? '已下线 · 历史记录' : jobDeadlineLabel(job)}</Notice><p className="caption">{availabilityMessage(job)}</p><p className="caption job-deadline">来源：{jobSourceText(job)}</p></section>
    {error && <p className="job-error" role="alert">{error}</p>}
    <Button variant="outline" className="full" disabled={confirming} onClick={openProgress}>管理我的投递进度</Button>
  </main><div className="bottom-action"><Button variant="outline" disabled={busy || confirming} onClick={toggleSaved}><Icon name="star" filled={saved} />{busy ? '保存中…' : saved ? '已收藏' : '收藏'}</Button><Button onClick={() => setApply(true)}>查看投递方式</Button></div>
    {apply && <Sheet title="投递方式" onClose={() => setApply(false)} footer={<Button disabled={authStatus === 'loading'} onClick={openProgress}>记录 / 更新我的进度</Button>}>
      <Notice>{availabilityMessage(job)}</Notice><p>请在招聘方渠道自行完成投递。打开以下链接不会自动标记“已投递”，也不会替你发送简历。</p>
      {applicationUrl || emailUrl ? <a className="button primary full" href={applicationUrl || emailUrl} target={applicationUrl ? '_blank' : undefined} rel="noopener noreferrer">{emailUrl ? '打开邮件投递入口' : '打开招聘方投递入口'}</a> : <Notice tone="amber">{job.available === false ? '该岗位下线，原投递入口已停用。' : '没有可直接使用的投递链接，请阅读原始公告中的申请说明。'}</Notice>}
      {job.available !== false && job.application?.raw && !safePublicLink(job.application.raw) && <p className="job-description">{String(job.application.raw)}</p>}
      <Link className="text-link" to={`/jobs/${encodeURIComponent(canonical)}/source`} state={returnState}>查看公告与来源 <Icon name="chevron" size={16} /></Link>
    </Sheet>}
    {editing && user && <ProgressEditor key={`${user.id}:${canonical}`} job={job} onClose={() => setEditing(false)} />}
  </>;
}

const fieldLabels = { salaryText: '薪资原文', salaryCurrency: '薪资币种', salaryPeriod: '薪资周期', deadline: '截止日期', benefits: '福利', requirements: '任职要求', description: '岗位介绍' };
function SourceLink({ value, children }) { const href = safePublicLink(value); return href ? <a className="text-link" href={href} target="_blank" rel="noopener noreferrer">{children} <Icon name="chevron" size={16} /></a> : null; }
export function SourcePage() {
  const { id } = useParams(), location = useLocation();
  const resource = useResource(signal => api.jobs.get(id, signal), [id]);
  const job = resource.data?.job;
  if (!job) return <JobLoad resource={resource} title="公告与核验" />;
  const review = job.announcementReview, verification = review?.verification;
  const fields = Object.entries(review?.fields || {}), superseded = new Set(job.factReview?.fields || []);
  const warnings = (Array.isArray(job.sourceFactWarnings) ? job.sourceFactWarnings : []).map(item => typeof item === 'string' ? item : '来源之间存在字段差异，请核实原文与后续人工更正。');
  return <Page title="公告与核验" className="live-jobs">
    <h1 className="compact-heading">{jobTitle(job)}</h1><p className="muted">{companyName(job)} · {jobSourceText(job)}</p>
    <Notice>{availabilityMessage(job)}</Notice>
    <section className="plain-section"><h2>原始来源</h2><div className="job-source-links"><SourceLink value={job.notice}>打开招聘公告</SourceLink><SourceLink value={job.sourceUrl}>打开信息来源</SourceLink><SourceLink value={job.factReview?.evidenceUrl}>查看人工更正依据</SourceLink></div>{!safePublicLink(job.notice) && !safePublicLink(job.sourceUrl) && !safePublicLink(job.factReview?.evidenceUrl) && <p className="muted">当前没有可直接打开的公开来源链接，不代表信息已完成核验。</p>}{job.sourceNote && <p className="job-description">{String(job.sourceNote)}</p>}{job.notice && !safePublicLink(job.notice) && <p className="job-description">{String(job.notice)}</p>}<dl className="evidence-list"><dt>首次收录</dt><dd>{factualDate(job.firstSeen || job.firstSeenAt)}</dd><dt>最近采集</dt><dd>{factualDate(job.lastSeen || job.lastSeenAt)}</dd></dl><p className="caption">最近采集不等于公告重新发布，也不代表仍有名额。</p></section>
    <section className="plain-section"><h2>招聘有效性核验</h2>{verification ? <><p><strong>{verification.status === 'open' ? '核对时处于公告报名窗口内' : verification.status === 'closed' ? '公告存在截止或结束依据' : '当前有效性仍待核实'}</strong></p><p className="muted">核对时间：{factualDate(verification.checkedAt)}</p><p>{verification.reason}</p>{verification.excerpt && <blockquote className="job-quote">{verification.excerpt}</blockquote>}<SourceLink value={verification.evidenceUrl}>查看核验依据</SourceLink></> : <p className="muted">尚无已记录的公告有效性核验。页面可访问不等于仍在招聘。</p>}{warnings.map((warning, index) => <Notice tone="amber" key={index}>{warning}</Notice>)}</section>
    <section className="plain-section"><h2>字段证据</h2>{fields.length ? fields.map(([key, field]) => <article className="job-evidence" key={key}><h3>{fieldLabels[key] || key}</h3><p>{Array.isArray(field.value) ? field.value.join(' · ') : String(field.value ?? '未记录')}</p>{superseded.has(key) && <p className="job-risk">此字段已有后续人工更正，当前岗位以人工更正为准。</p>}<small className="muted">核对：{factualDate(field.checkedAt)}</small>{(field.evidence || []).map((evidence, index) => <div key={index}>{evidence.quote && <blockquote className="job-quote">{evidence.quote}</blockquote>}{evidence.locator && <p className="caption">原文位置：{evidence.locator}</p>}<SourceLink value={evidence.sourceUrl}>打开原文依据</SourceLink></div>)}</article>) : <p className="muted">尚无逐字段证据记录。未公开的薪资、福利或要求不会由系统推测补齐。</p>}{job.factReview && <p className="caption">人工更正时间：{factualDate(job.factReview.updatedAt || job.factReview.checkedAt)}{job.factReview.note ? ` · ${job.factReview.note}` : ''}</p>}</section>
    {review?.lastAttempt && <section className="plain-section"><h2>最近核验尝试</h2><p>{factualDate(review.lastAttempt.checkedAt)} · {({ ok: '完成核对', accessible: '页面可访问，尚不能确认招聘状态', blocked: '来源限制访问', unsupported: '暂不支持解析此来源', unavailable: '来源暂不可用', manual: '人工核对' })[review.lastAttempt.status] || '未完成核验'}</p></section>}
    <Link className="button outline full" to={`/jobs/${encodeURIComponent(job.canonicalId || job.id)}`} state={{ returnTo: safeJobReturn(location.state?.returnTo) }}>返回岗位</Link>
  </Page>;
}
