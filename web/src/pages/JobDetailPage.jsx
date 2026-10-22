import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { CompanyLogo } from '../components/JobRow';
import { Icon } from '../components/Icon';
import { ErrorState, LoadingState } from '../components/StatusViews';
import { api } from '../lib/api';
import { companyName, jobLocation, jobSourceText, jobTitle, matchScore, salaryText } from '../lib/format';
import { useOnline } from '../hooks/useOnline';
import { detailLines, factualDate, safePublicLink, safeReturnPath, toLocalDateTime, toReminderIso } from '../lib/job-detail';
import { jobDeadlineLabel } from '../lib/job-discovery';
import { AnnouncementEvidence } from '../components/AnnouncementEvidence';

export function JobDetailPage() {
  const { jobId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const returnTo = safeReturnPath(location.state?.returnTo);
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
  const requestVersion = useRef(0);
  const savePending = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    const version = ++requestVersion.current;
    const current = () => !controller.signal.aborted && version === requestVersion.current;
    savePending.current = false;
    setLoading(true); setError(''); setJob(null); setExamPacks([]); setSaving(false); setSavedMessage(''); setSaveFailed(false);
    api.jobs.get(jobId, controller.signal).then(data => {
      if (!current()) return;
      const next = data?.job || data;
      setJob(next);
      setStatus(next.userState?.saved && next.userState?.status === 'not_applied' ? 'saved' : next.userState?.status || 'not_applied');
      setNote(next.userState?.note ?? '');
      setNextAction(next.userState?.nextAction || '');
      setFollowUpAt(toLocalDateTime(next.userState?.followUpAt));
    }).catch(requestError => {
      if (current() && requestError.name !== 'AbortError') setError(requestError.message);
    }).finally(() => { if (current()) setLoading(false); });
    // Recommendations are optional and independent; a slow pack lookup cannot block details.
    api.exams.forJob(jobId, controller.signal)
      .then(data => { if (current()) setExamPacks(Array.isArray(data.items) ? data.items : []); })
      .catch(() => {});
    return () => { controller.abort(); requestVersion.current += 1; };
  }, [jobId, reloadKey]);

  const saveState = async nextState => {
    if (savePending.current || !online) return;
    const version = requestVersion.current;
    savePending.current = true;
    setSaving(true); setSavedMessage(''); setSaveFailed(false);
    try {
      const nextStatus = nextState || (status === 'not_applied' ? 'saved' : status);
      const state = await api.jobs.updateState(jobId, {
        status: nextStatus, note, nextAction, followUpAt: toReminderIso(followUpAt),
        saved: !['ignored', 'not_applied'].includes(nextStatus), hidden: nextStatus === 'ignored',
      });
      if (version !== requestVersion.current) return;
      setStatus(nextStatus);
      setJob(current => current ? { ...current, userState: state?.state || state?.jobState || state } : current);
      setSavedMessage(nextStatus === 'ignored' ? '已移出求职进度' : '已保存到你的求职进度');
    } catch (requestError) {
      if (version !== requestVersion.current) return;
      setSaveFailed(true);
      setSavedMessage(requestError.message);
    } finally {
      if (version === requestVersion.current) { savePending.current = false; setSaving(false); }
    }
  };

  if (loading) return <div className="page"><LoadingState rows={5} /></div>;
  if (error || !job) return <div className="page"><Link className="back-link" to={returnTo} state={{ restoreJobList: true }}>返回机会列表</Link><ErrorState message={error || '岗位不存在或已失效'} onRetry={() => setReloadKey(value => value + 1)} /></div>;

  const score = matchScore(job);
  const needsProfile = job.match?.label === '待完善画像';
  const matchTone = needsProfile ? 'neutral' : score >= 60 ? 'positive' : score >= 40 ? 'caution' : 'risk';
  const reasons = Array.isArray(job.match?.reasons) ? job.match.reasons : [];
  const gaps = Array.isArray(job.match?.gaps) ? job.match.gaps : [];
  const description = String(job.description || '').trim();
  const requirements = detailLines(job.requirements);
  const benefits = detailLines(job.benefits);
  const qualification = job.match?.qualification || job.qualification;
  const checks = Array.isArray(qualification?.checks) ? qualification.checks : [];
  const archived = job.available === false || job.availability?.status === 'inactive';
  const expired = job.availability?.status === 'expired';
  const noticeUrl = safePublicLink(job.notice);
  const sourceUrl = safePublicLink(job.sourceUrl);
  const evidenceUrl = safePublicLink(job.factReview?.evidenceUrl);
  const applicationUrl = job.application?.kind === 'web' ? safePublicLink(job.application.href) : '';
  const emailUrl = job.application?.kind === 'email' && /^mailto:[^\s?@]+@[^\s?@]+$/.test(job.application.href || '') ? job.application.href : '';
  const sourceNote = String(job.sourceNote || '').trim();
  const originalInstructions = typeof job.url === 'string' && !safePublicLink(job.url) && job.url !== job.application?.raw ? job.url.trim() : '';
  const noticeText = !noticeUrl ? String(job.notice || '').trim() : '';
  const backLabel = returnTo.startsWith('/pipeline') ? '返回求职进度' : returnTo.startsWith('/workspace') ? '返回求职工具' : returnTo === '/' ? '返回今日' : '返回岗位列表';
  const missingDescription = job.applyUrl || job.url
    ? '岗位来源暂未提供介绍，请前往原始招聘页面核对职责、要求与待遇。'
    : '岗位来源暂未提供介绍，请结合任职要求和来源信息谨慎核对。';

  return (
    <div className="page job-detail-page">
      <button className="back-link" type="button" onClick={() => navigate(returnTo, { state: { restoreJobList: true } })}><Icon name="arrowLeft" size={18} />{backLabel}</button>
      <div className="job-detail-layout">
        <article className="job-detail-content">
          <header className="job-detail-header">
            <CompanyLogo job={job} size="large" />
            <div><span>{companyName(job)}</span><h1>{jobTitle(job)}</h1><p><Icon name="location" size={16} />{jobLocation(job)} <b>·</b> {job.education || job.educationLevel || job.degree || '学历未注明'} <b>·</b> {job.experience || '经验未注明'}</p></div>
          </header>
          <a className="button secondary" href="#job-action-panel" aria-controls="job-action-panel" onClick={event => { event.preventDefault(); document.getElementById('job-action-panel')?.scrollIntoView({ behavior:'smooth', block:'start' }); document.getElementById('job-action-heading')?.focus({ preventScroll:true }); }}>查看投递方式与管理进度 <Icon name="chevronRight" size={16} /></a>
          <div className="job-key-facts">
            <div><span>薪资待遇</span><strong>{salaryText(job)}</strong></div>
            <div><span>截止日期</span><strong>{jobDeadlineLabel(job)}</strong></div>
            <div><span>岗位来源</span><strong>{jobSourceText(job)}</strong></div>
          </div>
          <p className="inline-notice" role="status">{archived ? '岗位已从当前来源下线。这里保留的是你的历史机会记录，不表示仍在招聘；个人进度与备注可继续维护。' : expired ? (job.availability?.reason === 'announcement_closed' ? '原公告已有报名截止或结束招聘依据。这里仍保留历史信息，请通过原渠道核实是否重新开放。' : '该岗位公开截止日期已过。请先核实是否延期，不要把当前页面视为仍可申请。') : job.availability?.status === 'rolling' ? '来源标注为长期或滚动招聘，是否仍有空缺需要向招聘方核实。' : job.availability?.status === 'active' ? '公开截止日期尚未到，不代表招聘名额或申请链接已经核验。投递前请查看原始公告。' : '来源没有可确认的截止日期，不能据此认定仍在招聘。请先查看原始公告。'}</p>
          {(job.audience || job.batch) && <p>招聘对象：{job.audience || '未注明'} · 批次：{job.batch || '未注明'}</p>}
          {job.major && <p>专业要求：{job.major}</p>}
          <AnnouncementEvidence job={job} />
          {(score !== null || needsProfile) && <section className={`match-analysis ${matchTone}`}>
            <div className="match-score"><strong>{needsProfile ? '—' : score}</strong><span>{needsProfile ? '待评估' : '规则分'}</span></div>
            <div><h2>画像规则匹配 · {job.match?.label || '待核对'}</h2><p>{job.matchReason || '当前公开信息中还没有足够的明确匹配信号。'}</p>{needsProfile && <Link className="inline-link" to="/profile">完善求职画像后评估</Link>}{(reasons.length > 0 || gaps.length > 0) && <ul>{reasons.map(item => <li key={`reason-${item}`}><Icon name="check" size={13} />{item}</li>)}{gaps.map(item => <li className="match-gap" key={`gap-${item}`}><Icon name="close" size={13} />{item}</li>)}</ul>}</div>
          </section>}
          <p className="commerce-caption">规则分只表示当前信息与画像的匹配信号，不是录用概率，也不等于资格审核通过。</p>
          <section className="detail-section"><h2>公开条件逐项核对</h2><p>仅对岗位明确公布的要求与当前画像进行规则比对，不代表招聘方已确认录用资格；“待核对”不等于符合。</p>{checks.length ? <ul className="requirement-list">{checks.map(check => <li key={check.key}><strong>{check.label} · {{ pass: '公开条件匹配', fail: '存在明确风险', unknown: '待核对' }[check.status] || '待核对'}</strong><p>岗位要求：{check.requirement || '来源未公开'}<br />你的画像：{check.candidate || '未填写'}<br />{check.message}</p></li>)}</ul> : <p>目前信息不足，尚不能做出可靠的资格判断。</p>}<Link className="inline-link" to="/profile">核对或补全我的画像</Link></section>
          {examPacks.length > 0 && <section className="job-exam-suggestions">
            <header><div><span>笔试准备</span><h2>为这个岗位推荐</h2><p>结合公司、岗位名称和专业方向匹配，作答进度会同步到你的账号。</p></div><Link to={`/exams?jobId=${encodeURIComponent(jobId)}`}>查看全部 <Icon name="chevronRight" size={15} /></Link></header>
            <div>{examPacks.slice(0, 2).map(pack => <article key={pack.id}><span><Icon name="document" size={21} /></span><div><h3>{pack.title}</h3><p>{pack.jobRecommendationReason || pack.recommendationReason || '综合能力补充'} · {pack.questionCount} 题 · {pack.durationMinutes} 分钟</p></div>{pack.locked ? <Link to="/pricing"><Icon name="lock" size={16} />解锁</Link> : <Link to={`/exams?jobId=${encodeURIComponent(jobId)}`}>{pack.progress ? '继续' : '开始'} <Icon name="chevronRight" size={14} /></Link>}</article>)}</div>
          </section>}
          <section className="detail-section"><h2>岗位介绍</h2><p className="preline">{description || missingDescription}</p></section>
          <section className="detail-section"><h2>任职要求</h2>{requirements.length ? <ul className="requirement-list">{requirements.map((item, index) => <li key={`${item}-${index}`}>{item}</li>)}</ul> : <p>岗位来源暂未单独列出任职要求，请在投递前核对原始招聘信息。</p>}</section>
          {benefits.length > 0 && <section className="detail-section"><h2>福利与待遇</h2><div className="benefit-list">{benefits.map(item => <span key={item}>{item}</span>)}</div></section>}
          <section className="detail-section"><h2>来源与投递说明</h2><p>收录来源：{jobSourceText(job)}。来源名称仅说明信息从哪里收录，不等于平台已经核验招聘方或保证招聘真实性。</p>{sourceNote && <p className="preline">{sourceNote}</p>}{noticeUrl ? <p><a className="inline-link" href={noticeUrl} target="_blank" rel="noopener noreferrer">查看来源提供的公告 <Icon name="external" size={15} /></a></p> : noticeText ? <p className="preline">公告说明：{noticeText}</p> : <p>来源未提供可打开的公告链接。</p>}{sourceUrl && sourceUrl !== noticeUrl && <p><a className="inline-link" href={sourceUrl} target="_blank" rel="noopener noreferrer">查看原始信息来源 <Icon name="external" size={15} /></a></p>}{evidenceUrl && <p><a className="inline-link" href={evidenceUrl} target="_blank" rel="noopener noreferrer">查看人工更正所依据的公开出处 <Icon name="external" size={15} /></a> · 更正记录时间：{factualDate(job.factReview.updatedAt)}</p>}<p>首次收录：{factualDate(job.firstSeenAt)}<br />最近采集发现：{factualDate(job.lastSeenAt)}（不是招聘信息的发布日期）{archived && <><br />历史快照留存：{factualDate(job.capturedAt)}</>}</p></section>
        </article>
        <aside id="job-action-panel" className="job-action-panel" aria-labelledby="job-action-heading" style={{ scrollMarginTop:'110px' }}>
          <h2 id="job-action-heading" tabIndex={-1}>推进这次机会</h2>
          <label className="field"><span>求职状态</span><select disabled={saving} value={status} onChange={event => setStatus(event.target.value)}><option value="not_applied">尚未加入进度</option><option value="saved">已收藏</option><option value="preparing">准备投递</option><option value="applied">已投递</option><option value="assessment">在线测评</option><option value="interview">面试中</option><option value="offer">收到 Offer</option><option value="rejected">未通过</option><option value="withdrawn">已撤回</option><option value="ignored">暂不考虑并移出进度</option></select></label>
          <label className="field"><span>下一步行动</span><input disabled={saving} maxLength={500} value={nextAction} onChange={event => setNextAction(event.target.value)} placeholder="例如：完善项目经历并投递" /></label>
          <label className="field"><span>提醒时间（设备当地时间）</span><input disabled={saving} type="datetime-local" value={followUpAt} onChange={event => setFollowUpAt(event.target.value)} /></label>
          <label className="field"><span id="job-note-label">个人备注</span><textarea aria-labelledby="job-note-label" disabled={saving} maxLength={8000} value={note} onChange={event => setNote(event.target.value)} placeholder="记录联系人、准备重点或沟通结果" /></label>
          <button className="button secondary full" type="button" onClick={() => saveState()} disabled={saving || !online}>{saving ? '保存中…' : status === 'not_applied' ? '加入求职进度' : '保存进度'}</button>
          {status === 'assessment' && <Link className="button exam-job-cta full" to={`/exams?jobId=${encodeURIComponent(jobId)}`}><Icon name="document" size={17} />进入岗位笔试准备</Link>}
          {applicationUrl || emailUrl ? <a className={`button ${archived || expired ? 'secondary' : 'primary'} full`} href={applicationUrl || emailUrl} target={applicationUrl ? '_blank' : undefined} rel="noopener noreferrer">{archived || expired ? '打开原始渠道核实招聘状态' : emailUrl ? '通过邮件投递' : job.application.label || '前往投递页面'} <Icon name="external" size={17} /></a> : <p className="preline">{archived ? '岗位已下线，请通过原始公告核实最新招聘信息。' : job.application?.raw || '来源暂未提供投递方式'}</p>}
          {(applicationUrl || emailUrl) && job.application?.raw && (job.application.kind !== 'web' || job.application.raw !== applicationUrl) && <p className="preline">来源投递说明：{job.application.raw}</p>}
          {originalInstructions && <p className="preline">原始投递说明：{originalInstructions}</p>}
          <small>打开外部渠道不会自动标记“已投递”。完成申请后请回来更新进度。</small>
          <Link className="button secondary full" to={`/support?category=job_correction&jobId=${encodeURIComponent(jobId)}`}>反馈岗位信息问题</Link>
          {status === 'offer' && <Link className="button secondary full" to="/workspace?tab=offers">记录并比较 Offer</Link>}
          {status === 'interview' && <Link className="button secondary full" to="/workspace?tab=study">制定面试准备计划</Link>}
          {savedMessage && <p className={`saved-message${saveFailed ? ' error' : ''}`} role={saveFailed ? 'alert' : 'status'}>{savedMessage}</p>}
          <small>来源于 {jobSourceText(job)} · {job.lastSeenAt ? `最近采集发现 ${factualDate(job.lastSeenAt)}` : '采集时间未记录'}</small>
        </aside>
      </div>
    </div>
  );
}
