export const JOB_FILTER_DEFAULTS = Object.freeze({ q: '', location: '', major: '', role: '', industry: '', nature: '', source: '', currency: '', salaryPeriod: 'month', salaryMin: '', salaryMax: '', sort: 'match', availability: 'active', qualification: 'all', minMatch: '', view: 'all', deadlineWithin: '' });
export const JOB_FILTER_OPTIONS = {
  availability: [['active', '排除明确过期'], ['all', '含过期岗位'], ['expired', '仅明确过期']],
  qualification: [['all', '不限资格状态'], ['no_conflict', '无明确冲突（含待确认）'], ['pass', '已知条件通过'], ['unknown', '资格待确认'], ['fail', '存在硬条件风险']],
  view: [['all', '全部机会'], ['saved', '我的收藏'], ['unapplied', '尚未投递'], ['applied', '已有投递进展'], ['hidden', '暂不考虑']],
  sort: [['match', '规则匹配优先'], ['relevance', '关键词相关优先'], ['deadline', '即将截止优先'], ['salary', '薪资优先'], ['latest', '最近发布/首次收录']],
  salaryPeriod: [['month', '月薪'], ['year', '年薪'], ['week', '周薪'], ['hour', '时薪']],
  deadlineWithin: [['', '不限截止时间'], ['7', '7 天内截止'], ['30', '30 天内截止']],
};
export const JOB_FILTER_LABELS = { q: '关键词', location: '地点', major: '专业', role: '岗位方向', industry: '行业', nature: '招聘性质', source: '来源', currency: '币种', salaryPeriod: '薪资周期', salaryMin: '最低薪资', salaryMax: '最高薪资', sort: '排序', availability: '招聘期限', qualification: '资格判断', minMatch: '最低规则分', view: '个人进度', deadlineWithin: '截止范围' };
export function readJobFilters(params) {
  const result = { ...JOB_FILTER_DEFAULTS };
  Object.keys(result).forEach(key => { if (params.has(key)) result[key] = params.get(key).trim(); });
  Object.entries(JOB_FILTER_OPTIONS).forEach(([key, options]) => { if (!options.some(([value]) => value === result[key])) result[key] = JOB_FILTER_DEFAULTS[key]; });
  if (Number(result.minMatch) === 0) result.minMatch = '';
  return result;
}
export function jobFilterParams(filters, ai = false) {
  const params = new URLSearchParams();
  Object.entries(JOB_FILTER_DEFAULTS).forEach(([key, fallback]) => { const value = String(filters[key] ?? fallback).trim(); if (value !== fallback && value !== '') params.set(key, value); });
  if (ai) params.set('tab', 'ai');
  return params;
}
export function validateJobFilters(filters) {
  if ((filters.salaryMin !== '' || filters.salaryMax !== '' || filters.sort === 'salary') && !filters.currency) return '按薪资筛选或排序前，请先选择币种。不同币种不直接比较。';
  for (const key of ['salaryMin', 'salaryMax', 'minMatch']) if (filters[key] !== '' && (!Number.isFinite(Number(filters[key])) || Number(filters[key]) < 0)) return `${JOB_FILTER_LABELS[key]}需为非负数字。`;
  if (filters.minMatch !== '' && Number(filters.minMatch) > 100) return '最低规则分需在 0 到 100 之间。';
  if (filters.salaryMin !== '' && filters.salaryMax !== '' && Number(filters.salaryMin) > Number(filters.salaryMax)) return '最低薪资不能高于最高薪资。';
  return '';
}
export function jobFilterChips(filters) {
  return Object.keys(JOB_FILTER_DEFAULTS).filter(key => filters[key] !== '' && String(filters[key]) !== String(JOB_FILTER_DEFAULTS[key])).map(key => ({ key, label: JOB_FILTER_LABELS[key], value: JOB_FILTER_OPTIONS[key]?.find(([value]) => value === filters[key])?.[1] || filters[key] }));
}
export function matchesPersonalView(state = {}, view = 'all') {
  if (view === 'hidden') return Boolean(state.hidden);
  if (state.hidden) return false;
  if (view === 'saved') return Boolean(state.saved);
  const applied = Boolean(state.appliedAt) || ['applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn'].includes(state.status);
  return view === 'applied' ? applied : view === 'unapplied' ? !applied && state.status !== 'ignored' : true;
}
export function jobDeadlineLabel(job) {
  const raw = String(job.deadline || job.deadlineAt || '').trim();
  const date = job.availability?.date || job.deadlineInfo?.date;
  const shown = date ? String(date).slice(0, 10) : raw;
  const status = job.availability?.status;
  if (status === 'expired') return `${shown ? `${shown} · ` : ''}已截止`;
  if (status === 'rolling') return '长期招聘 · 名额需核实';
  if (status === 'active') return shown ? `截止 ${shown}` : '期限需核实';
  return shown ? `${shown} · 期限待核实` : '截止日期未公开';
}
const positionKey = userId => `zhilu-job-position:v1:${encodeURIComponent(userId || '')}`;
export function readJobPosition(userId, query) {
  if (!userId) return null;
  try { const record = JSON.parse(sessionStorage.getItem(positionKey(userId)) || '{}')[query]; return record && Date.now() - record.at < 1800000 && Number.isSafeInteger(record.count) && record.count >= 0 && Number.isFinite(record.scroll) ? record : null; } catch { return null; }
}
export function rememberJobPosition(userId, query, count, scroll) {
  if (!userId || !count) return;
  try {
    const records = JSON.parse(sessionStorage.getItem(positionKey(userId)) || '{}');
    records[query] = { count, scroll: Math.max(0, scroll), at: Date.now() };
    const recent = Object.entries(records).filter(([, value]) => Date.now() - value.at < 1800000).sort((a, b) => b[1].at - a[1].at).slice(0, 8);
    sessionStorage.setItem(positionKey(userId), JSON.stringify(Object.fromEntries(recent)));
  } catch { /* Private browsing or a full store must not block discovery. */ }
}
