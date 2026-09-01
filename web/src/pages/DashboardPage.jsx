import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { EmptyState, ErrorState, LoadingState } from '../components/StatusViews';
import { JobListHeader, JobRow } from '../components/JobRow';
import { api, listPayload } from '../lib/api';
import { deadlineText, greeting, userDisplayName } from '../lib/format';
import { useAuth } from '../context/AuthContext';

function completionOf(data, user) {
  return Number(data?.profileCompletion ?? data?.profile?.completion ?? user?.profileCompletion ?? 0);
}

function DashboardHero({ data, user }) {
  const completion = completionOf(data, user);
  const profileComplete = completion >= 100;
  return (
    <section className="dashboard-hero">
      <div className="mobile-dashboard-heading">
        <p>{greeting()}，{userDisplayName(user)}同学</p>
        <h1>今天，向理想工作更近一步</h1>
      </div>
      <div className="desktop-dashboard-heading">
        <h1>找到更适合你的下一份工作</h1>
        <Link className="button primary" to="/profile">{profileComplete ? '查看求职画像' : '完善求职画像'}</Link>
      </div>
      <ol className="career-path" aria-label="求职路径">
        <li className="active"><i /><strong>定位方向</strong><span>完善画像，精准推荐</span></li>
        <li><i /><strong>积极探索</strong><span>投递机会，积累经验</span></li>
        <li><i /><strong>收获 Offer</strong><span>高效准备，顺利入职</span></li>
      </ol>
      <div className="mobile-profile-progress">
        <span className="profile-illustration"><Icon name="user" size={35} strokeWidth={2.4} /></span>
        <div>
          <h2>{profileComplete ? '求职画像已就绪' : '完善求职画像'}</h2>
          <p>{profileComplete ? '已完成核心信息，可随时更新方向与偏好' : `已完成 ${completion}%，再完善 ${Math.max(1, Math.ceil((100 - completion) / 15))} 项，推荐更精准`}</p>
          <span className="progress-line"><i style={{ width: `${completion}%` }} /></span>
        </div>
        <Link className="button primary" to="/profile">{profileComplete ? '查看画像' : '继续完善'} <Icon name="chevronRight" size={18} /></Link>
      </div>
    </section>
  );
}

function TodayActions({ data }) {
  const counts = data?.counts || data?.stats || {};
  const recommendedCount = Number(counts.recommendedToApply || 0);
  const interviewCount = Number(counts.interviewsToPlan || 0);
  const profileComplete = completionOf(data) >= 100;
  const actions = [
    profileComplete
      ? { icon: 'document', title: '画像与目标已就绪', body: '方向或薪酬预期变化时，记得及时更新画像', cta: '查看画像', to: '/profile', color: 'blue' }
      : { icon: 'document', title: '完善求职画像', body: '补充你的技能、经历与偏好，获得更精准推荐', cta: '去完善', to: '/profile', color: 'blue' },
    { icon: 'send', title: recommendedCount ? `查看 ${recommendedCount} 个优先岗位` : '探索今日岗位', body: '核对要求和来源后，再决定是否前往招聘方页面投递', cta: '去查看', to: '/jobs', color: 'green' },
    { icon: 'calendar', title: interviewCount ? `推进 ${interviewCount} 个面试或测评` : '梳理求职进度', body: '记录真实阶段与下一步，避免遗漏重要节点', cta: '去管理', to: '/pipeline', color: 'blue' },
  ];
  return (
    <section className="dashboard-section action-section">
      <h2>今日行动</h2>
      <div className="action-band">
        {actions.map(action => (
          <article className="action-item" key={action.title}>
            <span className={`action-icon ${action.color}`}><Icon name={action.icon} size={23} /></span>
            <div><h3>{action.title}</h3><p>{action.body}</p><Link to={action.to}>{action.cta} <Icon name="chevronRight" size={14} /></Link></div>
          </article>
        ))}
      </div>
    </section>
  );
}

function RecommendedJobs({ jobs }) {
  return (
    <section className="dashboard-section recommended-section">
      <div className="section-title-row"><h2>为你推荐</h2><Link to="/jobs">查看全部 <Icon name="chevronRight" size={17} /></Link></div>
      {jobs.length ? (
        <div className="job-list-frame">
          <JobListHeader />
          {jobs.slice(0, 4).map(job => <JobRow key={job.id || job.jobId} job={job} />)}
          <Link className="list-more" to="/jobs">查看更多推荐岗位 <Icon name="chevronRight" size={15} /></Link>
        </div>
      ) : <EmptyState title="画像越完整，推荐越精准" description="完善专业、目标岗位与薪酬期望后，这里会出现适合你的机会。" action={<Link className="button primary" to="/profile">完善画像</Link>} />}
    </section>
  );
}

function UpcomingJobs({ jobs }) {
  if (!jobs.length) return null;
  return (
    <section className="dashboard-section mobile-upcoming">
      <div className="section-title-row"><h2>即将截止</h2><Link to="/jobs?sort=deadline">查看全部 <Icon name="chevronRight" size={17} /></Link></div>
      <div className="open-job-list">{jobs.slice(0, 2).map(job => <JobRow key={job.id || job.jobId} job={job} deadlineMode />)}</div>
    </section>
  );
}

function SalaryPanel({ data }) {
  const salary = data?.salaryTarget || data?.salary || {};
  const min = Number(salary.min);
  const max = Number(salary.max);
  const hasTarget = Number.isFinite(min) && Number.isFinite(max) && (min > 0 || max > 0);
  const current = Number(salary.current ?? salary.marketMedian);
  const hasCurrent = Number.isFinite(current) && current > 0;
  const formatAmount = value => value >= 1000 ? `${Math.round(value / 100) / 10}K` : String(value);
  const displayTarget = hasTarget ? `${formatAmount(min)}–${formatAmount(max)}` : '待补充';
  return (
    <section className="rail-panel salary-panel">
      <div className="rail-heading"><h2>薪资目标</h2><Link to="/profile">编辑</Link></div>
      <div className="rail-divider" />
      <span>期望薪资（税前）</span><strong>{displayTarget}</strong>
      {hasCurrent && <small>岗位样本中位数 <em>{formatAmount(current)}</em></small>}
      {hasCurrent && <div className="salary-scale"><i style={{ width: '50%' }}><b /></i></div>}
      {hasCurrent && <div className="scale-labels"><span>较低</span><span>市场中位</span><span>较高</span></div>}
      <div className="salary-message"><Icon name="coin" size={31} /><p><strong>{hasTarget ? '薪酬目标已记录' : '补充你的薪酬目标'}</strong><span>{hasTarget ? '薪酬洞察会基于真实岗位样本更新' : '设置币种、周期和可接受区间'}</span></p></div>
    </section>
  );
}

function PracticePanel({ practice }) {
  const topics = practice?.topics || practice?.questions || [];
  const complete = Number(practice?.completed || 0);
  return (
    <section className="rail-panel practice-panel">
      <div className="rail-heading"><h2>今日练习</h2><Link to="/prep">更多练习 <Icon name="chevronRight" size={15} /></Link></div>
      <div className="rail-divider" />
      <h3>{practice?.title || '选择备考方向'}{topics.length ? ` · ${topics.length} 题` : ''}</h3>
      <p>{practice?.description || '进入备考中心，根据目标岗位选择可用练习。'}</p>
      {topics.length > 0 && <ol>{topics.slice(0, 5).map((topic, index) => <li key={`${topic}-${index}`}><span>{index + 1}</span>{typeof topic === 'string' ? topic : topic.title}<i className={index < complete ? 'done' : ''}>{index < complete && <Icon name="check" size={12} />}</i></li>)}</ol>}
      <Link className="button primary practice-button" to="/prep">开始练习</Link>
    </section>
  );
}

function MobilePractice({ practice }) {
  return (
    <section className="dashboard-section mobile-practice">
      <div className="section-title-row"><h2>今日练习</h2><Link to="/prep">查看全部 <Icon name="chevronRight" size={17} /></Link></div>
      <div className="practice-strip"><span><Icon name="document" size={26} /></span><div><h3>{practice?.title || '选择备考方向'}</h3><p>{practice?.questionCount ? `${practice.questionCount} 题 · 约 ${practice.minutes || practice.questionCount * 2} 分钟` : '题量与内容以当前题库为准'}</p></div><Link className="button primary" to="/prep">开始练习 <Icon name="chevronRight" size={17} /></Link></div>
    </section>
  );
}

export function DashboardPage() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    api.dashboard.get(controller.signal).then(setData).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return controller;
  }, []);

  useEffect(() => {
    const controller = load();
    return () => controller.abort();
  }, [load]);

  if (loading) return <div className="page dashboard-loading"><div className="hero-skeleton" /><LoadingState rows={4} /></div>;
  if (error && !data) return <div className="page"><ErrorState message={error} onRetry={load} /></div>;

  const recommended = listPayload(data?.recommendations || data?.recommendedJobs || data?.jobs || [], 'jobs').items;
  const urgent = listPayload(data?.urgentJobs || data?.deadlines || [], 'jobs').items;
  const practice = data?.dailyPractice || data?.practice || {};

  return (
    <div className="dashboard-grid">
      <div className="dashboard-main">
        <DashboardHero data={data} user={user} />
        <TodayActions data={data} />
        <RecommendedJobs jobs={recommended} />
        <UpcomingJobs jobs={urgent} />
        <MobilePractice practice={practice} />
      </div>
      <aside className="dashboard-rail">
        <SalaryPanel data={data} />
        <PracticePanel practice={practice} />
      </aside>
    </div>
  );
}
