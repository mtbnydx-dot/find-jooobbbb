import { factualDate, safePublicLink } from '../lib/job-detail';
import '../styles/announcements.css';

const labels = { salaryText:'薪资', salaryCurrency:'币种', salaryPeriod:'薪资周期', salaryMonths:'发薪月数', major:'专业', degree:'学历', experience:'经验', benefits:'福利', requirements:'任职要求', description:'岗位介绍', deadline:'截止日期', audience:'招聘对象', batch:'招聘批次', employmentType:'用工类型', workMode:'工作方式' };
function EvidenceLink({ url }) { const link = safePublicLink(url); return link ? <a href={link} target="_blank" rel="noopener noreferrer">打开依据原文</a> : null; }
export function AnnouncementEvidence({ job }) {
  const review = job.announcementReview, verification = review?.verification;
  const fields = Object.entries(review?.fields || {});
  const superseded = new Set(job.factReview?.fields || []);
  if (!review && !job.sourceFactWarnings?.length) return null;
  return <section className="detail-section announcement-evidence"><h2>原公告核验记录</h2>
    {job.sourceFactWarnings?.length > 0 && <div className="inline-notice">{job.sourceFactWarnings.map((warning,index) => <p key={index}>{typeof warning === 'string' ? warning : '多来源薪资存在冲突，暂不合并为一个金额，请核对原公告。'}</p>)}</div>}
    {verification ? <><p><strong>{{ open:'核对时处于公告报名窗口内（非实时名额）', closed:'公告存在报名截止或结束招聘依据', unknown:'当前有效性仍待核实' }[verification.status] || '当前有效性仍待核实'}</strong> · 核对时间：{factualDate(verification.checkedAt)}</p><p>{verification.reason}{superseded.has('deadline') && '。截止时间以最新人工更正为准。'}</p>{verification.excerpt && <blockquote>{verification.excerpt}</blockquote>}<EvidenceLink url={verification.evidenceUrl} /></> : <p>尚无已采纳的当前招聘有效性证据。读取到公告、长期招聘或有投递链接，都不等于确认仍有名额。</p>}
    {fields.map(([field, record]) => <details key={field}><summary>{labels[field] || field} · {superseded.has(field) ? '后续人工更正优先' : '已核对原文'}</summary><p className="preline">{String(record.value)}</p>{(record.evidence || []).map((evidence, index) => <div key={index}><blockquote>{evidence.quote}</blockquote><EvidenceLink url={evidence.sourceUrl} /><p className="commerce-caption">{evidence.locator || (evidence.method === 'manual-reviewed' ? '人工摘录' : '公告原文')} · 核对时间：{factualDate(record.checkedAt)}</p></div>)}</details>)}
    {review?.lastAttempt && <p className="commerce-caption">最近尝试读取：{factualDate(review.lastAttempt.checkedAt)} · {{ ok:'已读取', accessible:'已读取', blocked:'访问受限，不能据此判断停招', unsupported:'需人工查看', unavailable:'暂时无法访问，不能据此判断停招', manual:'人工摘录' }[review.lastAttempt.status] || '核验记录已更新'}。最近尝试不代表以上事实已经重新确认。</p>}
  </section>;
}
