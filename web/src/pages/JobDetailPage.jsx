import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CompanyLogo } from '../components/JobRow';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { api } from '../lib/api';
import { companyName, deadlineText, jobLocation, jobSourceText, jobTitle, matchScore, salaryText } from '../lib/format';
import { useOnline } from '../hooks/useOnline';

export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const online = useOnline();
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('not_applied');
  const [note, setNote] = useState('');
  const [nextAction, setNextAction] = useState('');
  const [followUpAt, setFollowUpAt] = useState('');
  const [saving, setSaving] = useState(false);
  const [savedMessage, setSavedMessage] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [examPacks, setExamPacks] = useState([]);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setExamPacks([]);
    api.jobs.get(jobId, controller.signal).then(data => {
      const next = data?.job || data;
      setJob(next);
      setStatus(next.userState?.status || 'not_applied');
      setNote(next.userState?.note || next.note || '');
      setNextAction(next.userState?.nextAction || '');
      setFollowUpAt(String(next.userState?.followUpAt || '').slice(0, 16));
      api.exams.forJob(jobId, controller.signal)
        .then(examData => setExamPacks(Array.isArray(examData.items) ? examData.items : []))
        .catch(() => {});
    }).catch(requestError => {
      if (requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [jobId, reloadKey]);

  const saveState = async nextState => {
    setSaving(true); setSavedMessage(''); setSaveFailed(false);
    try {
      const nextStatus = nextState || (status === 'not_applied' ? 'saved' : status);
      const state = await api.jobs.updateState(jobId, {
        status: nextStatus, note, nextAction, followUpAt, saved: !['ignored', 'not_applied'].includes(nextStatus),
      });
      setStatus(nextStatus);
      setJob(current => current ? { ...current, userState: state?.state || state?.jobState || state } : current);
      setSavedMessage(nextStatus === 'ignored' ? '已移出求职进度' : '已保存到你的求职进度');
    } catch (requestError) {
      setSaveFailed(true);
      setSavedMessage(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="page"><LoadingState rows={5} /></div>;
  if (error || !job) return <div className="page"><ErrorState message={error || '岗位不存在或已失效'} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  const score = matchScore(job);
  const needsProfile = job.match?.label === '待完善画像';
  const matchTone = needsProfile ? 'neutral' : score >= 60 ? 'positive' : score >= 40 ? 'caution' : 'risk';
  const reasons = Array.isArray(job.match?.reasons) ? job.match.reasons : [];
  const gaps = Array.isArray(job.match?.gaps) ? job.match.gaps : [];
  const description = String(job.description || '').trim();
  const requirements = Array.isArray(job.requirements) ? job.requirements : String(job.requirements || '').split(/\n+/).map(item => item.trim()).filter(Boolean);
  const benefits = Array.isArray(job.benefits) ? job.benefits : [];
  const missingDescription = job.applyUrl || job.url
    ? '岗位来源暂未提供介绍，请前往原始招聘页面核对职责、要求与待遇。'
    : '岗位来源暂未提供介绍，请结合任职要求和来源信息谨慎核对。';

  return (
    <div className="page job-detail-page">
      <button className="back-link" type="button" onClick={() => navigate(-1)}><Icon name="arrowLeft" size={18} />返回岗位列表</button>
      <div className="job-detail-layout">
        <article className="job-detail-content">
          <header className="job-detail-header">
            <CompanyLogo job={job} size="large" />
            <div><span>{companyName(job)}</span><h1>{jobTitle(job)}</h1><p><Icon name="location" size={16} />{jobLocation(job)} <b>·</b> {job.education || job.educationLevel || job.degree || '学历未注明'} <b>·</b> {job.experience || '经验未注明'}</p></div>
          </header>
          <div className="job-key-facts">
            <div><span>薪资待遇</span><strong>{salaryText(job)}</strong></div>
            <div><span>截止日期</span><strong>{deadlineText(job.deadline || job.deadlineAt)}</strong></div>
            <div><span>岗位来源</span><strong>{jobSourceText(job)}</strong></div>
          </div>
          {(score !== null || needsProfile) && <section className={`match-analysis ${matchTone}`}>
            <div className="match-score"><strong>{needsProfile ? '—' : score}</strong><span>{needsProfile ? '待评估' : '匹配度'}</span></div>
            <div><h2>画像匹配分析 · {job.match?.label || '待核对'}</h2><p>{job.matchReason || '当前公开信息中还没有足够的明确匹配信号。'}</p>{needsProfile && <Link className="inline-link" to="/profile">完善求职画像后评估</Link>}{(reasons.length > 0 || gaps.length > 0) && <ul>{reasons.map(item => <li key={`reason-${item}`}><Icon name="check" size={13} />{item}</li>)}{gaps.map(item => <li className="match-gap" key={`gap-${item}`}><Icon name="close" size={13} />{item}</li>)}</ul>}</div>
          </section>}
          {examPacks.length > 0 && <section className="job-exam-suggestions">
            <header><div><span>笔试准备</span><h2>为这个岗位推荐</h2><p>结合公司、岗位名称和专业方向匹配，作答进度会同步到你的账号。</p></div><Link to={`/exams?jobId=${encodeURIComponent(jobId)}`}>查看全部 <Icon name="chevronRight" size={15} /></Link></header>
            <div>{examPacks.slice(0, 2).map(pack => <article key={pack.id}><span><Icon name="document" size={21} /></span><div><h3>{pack.title}</h3><p>{pack.jobRecommendationReason || pack.recommendationReason || '综合能力补充'} · {pack.questionCount} 题 · {pack.durationMinutes} 分钟</p></div>{pack.locked ? <Link to="/pricing"><Icon name="lock" size={16} />解锁</Link> : <Link to={`/exams?jobId=${encodeURIComponent(jobId)}`}>{pack.progress ? '继续' : '开始'} <Icon name="chevronRight" size={14} /></Link>}</article>)}</div>
          </section>}
          <section className="detail-section"><h2>岗位介绍</h2><p className="preline">{description || missingDescription}</p></section>
          <section className="detail-section"><h2>任职要求</h2>{requirements.length ? <ul className="requirement-list">{requirements.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>岗位来源暂未单独列出任职要求，请在投递前核对原始招聘信息。</p>}</section>
          {benefits.length > 0 && <section className="detail-section"><h2>福利与待遇</h2><div className="benefit-list">{benefits.map(item => <span key={item}>{item}</span>)}</div></section>}
        </article>
        <aside className="job-action-panel">
          <h2>推进这次机会</h2>
          <label className="field"><span>求职状态</span><select value={status} onChange={event => setStatus(event.target.value)}><option value="not_applied">尚未加入进度</option><option value="saved">已收藏</option><option value="preparing">准备投递</option><option value="applied">已投递</option><option value="assessment">在线测评</option><option value="interview">面试中</option><option value="offer">收到 Offer</option><option value="rejected">未通过</option><option value="withdrawn">已撤回</option><option value="ignored">暂不考虑并移出进度</option></select></label>
          <label className="field"><span>下一步行动</span><input value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder="例如：完善项目经历并投递" /></label>
          <label className="field"><span>提醒时间</span><input type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} /></label>
          <label className="field"><span>个人备注</span><textarea value={note} onChange={event => setNote(event.target.value)} placeholder="记录联系人、准备重点或沟通结果" /></label>
          <button className="button secondary full" type="button" onClick={() => saveState()} disabled={saving || !online}>{saving ? '保存中…' : status === 'not_applied' ? '加入求职进度' : '保存进度'}</button>
          {status === 'assessment' && <Link className="button exam-job-cta full" to={`/exams?jobId=${encodeURIComponent(jobId)}`}><Icon name="document" size={17} />进入岗位笔试准备</Link>}
          {job.applyUrl || job.url ? <a className="button primary full" href={job.applyUrl || job.url} target="_blank" rel="noopener noreferrer">前往投递页面 <Icon name="external" size={17} /></a> : <button className="button primary full" disabled>暂无投递链接</button>}
          {savedMessage && <p className={`saved-message${saveFailed ? ' error' : ''}`} role={saveFailed ? 'alert' : 'status'}>{savedMessage}</p>}
          <small>来源于 {jobSourceText(job)} · {job.updatedAt || job.lastSeenAt ? `更新于 ${new Date(job.updatedAt || job.lastSeenAt).toLocaleDateString('zh-CN')}` : '更新时间未记录'}</small>
        </aside>
      </div>
    </div>
  );
}
