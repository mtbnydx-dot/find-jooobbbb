'use strict';

function deadlineFact(value) {
  const raw = String(value || '').trim();
  const match = /^(20\d{2})[年/.\-](\d{1,2})[月/.\-](\d{1,2})日?$/.exec(raw);
  if (match) {
    const [year, month, day] = match.slice(1).map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day) return { kind: 'fixed', date: date.toISOString().slice(0, 10), raw, timeZone: 'Asia/Shanghai' };
  }
  return { kind: /招满|尽快|长期|常年|滚动|随时/.test(raw) ? 'rolling' : 'unknown', date: null, raw, timeZone: 'Asia/Shanghai' };
}

function applicationFact(value) {
  const raw = String(value || '').trim();
  const email = raw.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  if (email && !/^https?:/i.test(raw)) return { kind: 'email', href: `mailto:${email}`, label: email, raw };
  try {
    const candidate = /^[\w.-]+\.[a-z]{2,}(?:\/|$)/i.test(raw) ? `https://${raw}` : raw;
    const url = new URL(candidate);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return { kind: 'web', href: url.href, label: '前往投递', raw };
  } catch (_) { /* retain unsupported instructions verbatim */ }
  return { kind: raw ? 'instructions' : 'unknown', href: '', label: raw || '暂未提供投递方式', raw };
}

module.exports = { deadlineFact, applicationFact };
