import { toLocalDateTime, toReminderIso } from '../../../src/lib/job-detail.js';
export { jobTitle, companyName, jobLocation, salaryText, jobSourceText, matchScore, formatDateTime } from '../../../src/lib/format.js';
export { JOB_FILTER_DEFAULTS, JOB_FILTER_OPTIONS, JOB_FILTER_LABELS, readJobFilters, jobFilterParams, jobFilterChips, validateJobFilters, jobDeadlineLabel } from '../../../src/lib/job-discovery.js';
export { detailLines, safePublicLink, factualDate, toLocalDateTime, toReminderIso } from '../../../src/lib/job-detail.js';

export const STAGES = { not_applied: '尚未投递', saved: '已收藏（旧记录）', preparing: '准备中', applied: '已投递', assessment: '笔试 / 测评', interview: '面试', offer: 'Offer', rejected: '未通过', withdrawn: '已撤回', ignored: '暂不考虑' };
export const EDITABLE_STAGES = Object.entries(STAGES).filter(([key]) => key !== 'saved');
export function mergeJobs(first = [], next = []) {
  const rows = new Map(first.map(job => [job.id, job]));
  next.forEach(job => rows.set(job.id, job));
  return [...rows.values()];
}
export function stageLabel(state) { return STAGES[state?.status] || '尚未投递'; }
export function availabilityMessage(job) {
  if (job.available === false) return '岗位已从当前目录下线，仅保留你的历史记录。旧投递入口已停用，进度与备注仍可维护。';
  if (job.availability?.status === 'expired') return '公开截止日期已过或公告显示招聘结束。请核实是否延期，勿将历史信息视为仍可申请。';
  if (job.availability?.status === 'rolling') return '来源标注长期或滚动招聘，是否仍有空缺需向招聘方核实。';
  if (job.availability?.status === 'active') return '公开截止日期尚未到，不代表名额仍在或申请链接已核验。请以招聘方公告为准。';
  return '没有可确认的截止日期，不能据此认定仍在招聘。请查看原始公告并向招聘方核实。';
}
export function progressDraft(state = {}) {
  return { status: state.status || 'not_applied', nextAction: state.nextAction || '', note: state.note || '', followUpAt: state.followUpAt || '', appliedAt: state.appliedAt || '' };
}
// Partial PUTs must not turn off a separately saved bookmark or overwrite unrelated fields.
export function changedProgress(initial, next) {
  return Object.fromEntries(Object.keys(progressDraft()).filter(key => String(initial[key] || '') !== String(next[key] || '')).map(key => [key, next[key]]));
}
export function progressPatch(initial, draft) {
  const next = { ...draft };
  for (const key of ['appliedAt', 'followUpAt']) next[key] = draft[key] === toLocalDateTime(initial[key]) ? initial[key] : toReminderIso(draft[key]);
  return changedProgress(initial, next);
}
export function safeJobReturn(value, fallback = '/discover') {
  return typeof value === 'string' && /^\/(?:discover|pipeline|ai)(?:\?|$)/.test(value) && !/[\r\n\\]/.test(value) ? value : fallback;
}
