export function jobTitle(job = {}) {
  return job.title || job.position || job.role || '未命名岗位';
}

export function companyName(job = {}) {
  return job.companyName || job.company || '未知公司';
}

export function jobLocation(job = {}) {
  if (Array.isArray(job.locations)) return job.locations.join('、');
  return job.location || job.city || '地点待确认';
}

export function salaryText(job = {}) {
  if (job.salaryText || job.salary) return job.salaryText || job.salary;
  const compensation = job.compensation && typeof job.compensation === 'object' ? job.compensation : {};
  const min = Number(job.salaryMin ?? compensation.min ?? 0);
  const max = Number(job.salaryMax ?? compensation.max ?? 0);
  if (!min && !max) return '薪资未公开';
  const currency = job.salaryCurrency || compensation.currency;
  if (!currency || currency === 'UNKNOWN') return `${min || max}-${max || min}（币种未注明）`;
  const symbol = { CNY: '¥', AUD: 'A$', USD: '$', HKD: 'HK$', SGD: 'S$', GBP: '£', EUR: '€' }[currency] || `${currency} `;
  const divisor = Math.max(min, max) >= 1000 ? 1000 : 1;
  const unit = divisor === 1000 ? 'K' : '';
  const shownMin = Math.round((min / divisor) * 10) / 10;
  const shownMax = Math.round((max / divisor) * 10) / 10;
  const months = Number(job.salaryMonths || 0);
  const period = job.salaryPeriod || compensation.period || 'month';
  const range = shownMin && shownMax ? `${symbol}${shownMin}-${shownMax}${unit}` : `${symbol}${shownMin || shownMax}${unit}+`;
  const periodLabel = period === 'year' ? '/年' : period === 'week' ? '/周' : period === 'hour' ? '/时' : '/月';
  return months ? `${range}${periodLabel} · ${months}薪` : `${range}${periodLabel}`;
}

function sourceList(value) {
  if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { return sourceList(JSON.parse(value)); } catch (_) { /* fall through */ }
  }
  return String(value || '').split(/[、,，|]/).map(item => item.trim()).filter(Boolean);
}

export function jobSourceText(job = {}) {
  const categories = new Set(['符合条件', '可试试', '不符合条件', '自选']);
  const names = [
    ...sourceList(job.origins),
    ...sourceList(job.sourceNames),
    ...sourceList(job.sourceName),
    ...sourceList(categories.has(String(job.source || '')) ? '' : job.source),
  ];
  return [...new Set(names)].join('、') || '来源未注明';
}

export function matchScore(job = {}) {
  if (job.match?.label === '待完善画像') return null;
  const value = job.matchScore ?? job.score ?? job.aiAssessment?.score;
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
}

export function deadlineText(value) {
  if (!value) return '截止日期未公开';
  const date = new Date(String(value).replace(/\//g, '-'));
  if (Number.isNaN(date.getTime())) return String(value);
  const days = Math.ceil((date.setHours(23, 59, 59, 999) - Date.now()) / 86_400_000);
  if (days < 0) return '已截止';
  if (days === 0) return '今天截止';
  if (days <= 7) return `${days} 天后截止`;
  return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric' }).format(date);
}

export function formatDateTime(value) {
  if (!value) return '待安排';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

export function toCsv(value) {
  return Array.isArray(value) ? value.join('、') : value || '';
}

export function fromCsv(value) {
  return String(value || '').split(/[、,，\n]/).map(item => item.trim()).filter(Boolean);
}

export function browserTimeZone() {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof timeZone === 'string' && timeZone.trim() ? timeZone.trim() : undefined;
  } catch (_) {
    return undefined;
  }
}

export function greeting() {
  const hour = new Date().getHours();
  if (hour < 11) return '早上好';
  if (hour < 14) return '中午好';
  if (hour < 18) return '下午好';
  return '晚上好';
}

export function userDisplayName(user = {}) {
  return user.displayName || user.name || user.nickname || user.email?.split('@')[0] || '同学';
}
