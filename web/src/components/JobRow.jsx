import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Icon } from './Icon';
import { companyName, jobLocation, jobSourceText, jobTitle, matchScore, salaryText } from '../lib/format';
import { api } from '../lib/api';
import { jobDeadlineLabel } from '../lib/job-discovery';
import { useOnline } from '../hooks/useOnline';
import '../styles/job-discovery.css';

const LOGO_COLORS = ['#0759ed', '#06a66b', '#1439a8', '#8b4ed8', '#d8485f', '#087a91'];

function hashColor(value) {
  let hash = 0;
  for (const char of String(value || '职')) hash = ((hash << 5) - hash) + char.charCodeAt(0);
  return LOGO_COLORS[Math.abs(hash) % LOGO_COLORS.length];
}

export function CompanyLogo({ job, size = 'medium' }) {
  const company = companyName(job);
  const [failed, setFailed] = React.useState(false);
  const src = job.logoUrl || job.companyLogo || '';
  if (src && !failed) {
    return <img className={`company-logo ${size}`} src={src} alt="" onError={() => setFailed(true)} />;
  }
  return (
    <span className={`company-logo fallback ${size}`} style={{ '--logo-color': hashColor(company) }} aria-hidden="true">
      {company.slice(0, 1)}
    </span>
  );
}

const STATUS_LABELS = { saved: '已加入进度', preparing: '准备投递', applied: '已投递', assessment: '在线测评', interview: '面试中', offer: '收到 Offer', rejected: '未通过', withdrawn: '已撤回', ignored: '已移出进度' };
export function JobRow({ job, deadlineMode = false, actionLabel = '查看岗位', onStateChange, onNavigate }) {
  const location = useLocation();
  const online = useOnline();
  const [userState, setUserState] = React.useState(job.userState || {});
  const [busy, setBusy] = React.useState(false), [error, setError] = React.useState(''), [notice, setNotice] = React.useState('');
  React.useEffect(() => { setUserState(job.userState || {}); }, [job.id, job.jobId, job.userState]);
  const needsProfile = job.match?.label === '待完善画像';
  const score = needsProfile ? null : matchScore(job);
  const id = job.id || job.jobId;
  const returnState = { returnTo: `${location.pathname}${location.search}` };
  const href = `/jobs/${encodeURIComponent(id)}`;
  const qualification = job.match?.qualification?.status;
  const qualificationLabel = qualification === 'fail' ? '硬条件风险' : qualification === 'pass' ? '已知条件通过' : '资格待确认';
  const change = async patch => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      const response = await api.jobs.updateState(id, patch);
      const state = response.state || response.jobState || response;
      setUserState(state); onStateChange?.(id, state);
      setNotice(patch.hidden === true ? '已暂不考虑，可恢复。' : patch.hidden === false ? '已恢复显示。' : patch.saved ? '已收藏，投递阶段不变。' : '已取消收藏，投递阶段不变。');
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  };
  return (
    <article className={`job-row job-discovery-row${userState.hidden ? ' is-hidden-job' : ''}`}>
      <CompanyLogo job={job} />
      <div className="job-primary">
        <h3><Link to={href} state={returnState} onClick={onNavigate}>{companyName(job)}<span className="desktop-role"> · {jobTitle(job)}</span></Link></h3>
        <p className="mobile-role"><Link to={href} state={returnState} onClick={onNavigate}>{jobTitle(job)}</Link></p>
        <p className="job-subline">{jobLocation(job)} · {job.education || job.educationLevel || job.degree || '学历未注明'}</p>
        <p className="job-salary">{salaryText(job)}</p>
      </div>
      <div className="job-desktop-cell location-cell">{jobLocation(job)}</div>
      <div className="job-desktop-cell salary-cell">{salaryText(job)}</div>
      <div className="job-desktop-cell match-cell">
        {!needsProfile && score !== null ? <><strong title="画像规则匹配分，不是录用概率">{score} 分</strong><span>{job.matchReasonShort || '画像规则匹配'}</span></> : <span>完善画像后评估</span>}
      </div>
      <div className={`job-deadline${deadlineMode ? ' urgent' : ''}`}>{jobDeadlineLabel(job)}</div>
      <Link className="job-action" to={href} state={returnState} onClick={onNavigate} aria-label={`${actionLabel}：${companyName(job)} ${jobTitle(job)}`}>
        <span>{actionLabel}</span><Icon name="chevronRight" size={19} />
      </Link>
      <div className="job-discovery-footer"><div className="job-discovery-facts">
        <div className="job-discovery-badges"><span className={`job-qualification ${qualification || 'unknown'}`}>{qualificationLabel}</span>{STATUS_LABELS[userState.status] && <span className="job-personal-status">{STATUS_LABELS[userState.status]}</span>}{userState.hidden && <span>暂不考虑</span>}<span className="job-mobile-rule-score">{needsProfile || score === null ? '完善画像后评估' : `规则分 ${score} · 非录用概率`}</span></div>
        <small>来源：{jobSourceText(job)}</small><small className="job-mobile-deadline">{jobDeadlineLabel(job)}</small>
        {qualification === 'fail' && <small className="job-qualification-risk">{job.match?.qualification?.risks?.[0] || job.match?.risks?.[0] || '请在详情核对学历、经验等要求'}</small>}
      </div><div className="job-quick-actions"><button type="button" aria-pressed={Boolean(userState.saved)} aria-label={`${userState.saved ? '取消收藏' : '收藏'}：${companyName(job)} ${jobTitle(job)}`} disabled={busy || !online} onClick={() => change({ saved: !userState.saved })}><Icon name="bookmark" size={15} />{userState.saved ? '已收藏' : '收藏'}</button><button type="button" aria-label={`${userState.hidden ? '恢复显示' : '暂不考虑'}：${companyName(job)} ${jobTitle(job)}`} disabled={busy || !online} onClick={() => change({ hidden: !userState.hidden })}><Icon name={userState.hidden ? 'eye' : 'eyeOff'} size={15} />{userState.hidden ? '恢复显示' : '暂不考虑'}</button></div></div>
      {error && <p className="job-row-feedback error" role="alert">{error}</p>}{notice && !onStateChange && <p className="job-row-feedback" role="status">{notice}</p>}
    </article>
  );
}

export function JobListHeader() {
  return (
    <div className="job-list-header" aria-hidden="true">
      <span>公司/职位</span><span>工作地点</span><span>公开薪资</span><span title="规则分不是录用概率">规则分</span><span>截止日期</span><span>操作</span>
    </div>
  );
}
