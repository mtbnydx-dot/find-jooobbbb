import React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';
import { companyName, deadlineText, jobLocation, jobTitle, matchScore, salaryText } from '../lib/format';

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

export function JobRow({ job, deadlineMode = false, actionLabel = '查看岗位' }) {
  const needsProfile = job.match?.label === '待完善画像';
  const score = needsProfile ? null : matchScore(job);
  const id = job.id || job.jobId;
  return (
    <article className="job-row">
      <CompanyLogo job={job} />
      <div className="job-primary">
        <h3>{companyName(job)}<span className="desktop-role"> · {jobTitle(job)}</span></h3>
        <p className="mobile-role">{jobTitle(job)}</p>
        <p className="job-subline">{jobLocation(job)} · {job.education || job.educationLevel || '学历未注明'}</p>
        <p className="job-salary">{salaryText(job)}</p>
      </div>
      <div className="job-desktop-cell location-cell">{jobLocation(job)}</div>
      <div className="job-desktop-cell salary-cell">{salaryText(job)}</div>
      <div className="job-desktop-cell match-cell">
        {!needsProfile && score !== null ? <><strong>{score}%</strong><span>{job.matchReasonShort || job.aiAssessment?.matchedRoles?.[0] || '与画像匹配'}</span></> : <span>完善画像后评估</span>}
      </div>
      <div className={`job-deadline${deadlineMode ? ' urgent' : ''}`}>{deadlineText(job.deadline || job.deadlineAt)}</div>
      <Link className="job-action" to={`/jobs/${encodeURIComponent(id)}`} aria-label={`${actionLabel}：${companyName(job)} ${jobTitle(job)}`}>
        <span>{actionLabel}</span><Icon name="chevronRight" size={19} />
      </Link>
      <span className={`job-mobile-match${needsProfile || score === null ? ' pending' : ''}`}>{needsProfile || score === null ? '完善画像后评估' : `匹配度 ${score}%`}</span>
    </article>
  );
}

export function JobListHeader() {
  return (
    <div className="job-list-header" aria-hidden="true">
      <span>公司/职位</span><span>工作地点</span><span>薪资（税前）</span><span>匹配度</span><span>截止日期</span><span>操作</span>
    </div>
  );
}
