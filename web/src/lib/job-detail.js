// Only return to known in-app collection surfaces, never a caller-provided host.
export function safeReturnPath(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\\\u0000-\u001f]/.test(value)) return '/jobs';
  try {
    const target = new URL(value, 'https://app.invalid');
    if (!value.startsWith('/') || target.origin !== 'https://app.invalid' || !['/', '/jobs', '/pipeline', '/workspace'].includes(target.pathname)) return '/jobs';
    return `${target.pathname}${target.search}${target.hash}`;
  } catch (_) { return '/jobs'; }
}

export function safePublicLink(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  try {
    const url = new URL(value.trim());
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

export function detailLines(value) {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\r\n；;]+/) : [];
  return [...new Set(values.filter(item => typeof item === 'string').map(item => item.trim()).filter(Boolean))];
}

function localDateTime(date) {
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function toLocalDateTime(value) {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : localDateTime(date);
}

export function toReminderIso(value) {
  if (!value) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('请填写有效的提醒日期与时间');
  const date = new Date(value);
  // The round trip also rejects nonexistent local times during a DST jump.
  if (Number.isNaN(date.getTime()) || localDateTime(date) !== value) throw new Error('该提醒时间无效或在当前时区不存在，请重新选择');
  return date.toISOString();
}

export function factualDate(value) {
  if (!value) return '未记录';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '未记录' : date.toLocaleString('zh-CN');
}
