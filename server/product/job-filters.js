'use strict';

const { normalizeCurrency, normalizeSalaryPeriod } = require('./matching');

function invalid(message) {
  // Lazy import keeps the platform -> filters -> matching dependency acyclic.
  const { ProductError } = require('./platform');
  throw new ProductError(message, 400, 'INVALID_INPUT');
}

function scalar(value, name, max = 300) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number'].includes(typeof value)) invalid(`${name} 必须是文本`);
  const result = String(value).trim();
  if (result.length > max || /[\u0000-\u001f]/.test(result)) invalid(`${name} 格式非法或过长`);
  return result;
}

function list(value, name) {
  const input = Array.isArray(value) ? value : scalar(value, name, 2400).split(/[,，、|]/);
  if (input.length > 20) invalid(`${name} 最多 20 项`);
  return [...new Set(input.map(item => scalar(item, name, 120)).filter(Boolean))].sort().join(',');
}

function choice(value, name, allowed, fallback) {
  const normalized = scalar(value, name).toLowerCase() || fallback;
  if (!allowed.includes(normalized)) invalid(`${name} 仅支持 ${allowed.join('/')}`);
  return normalized;
}

function amount(value, name, max = 100_000_000) {
  const raw = scalar(value, name);
  if (!raw) return '';
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0 || number > max) invalid(`${name} 必须是 0 到 ${max} 之间的数字`);
  return number;
}

function normalizeJobFilters(input = {}, { currencyFallback = 'CNY', salaryPeriodFallback = 'month', requireSalaryCurrency = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('筛选条件必须是对象');
  const result = { q: scalar(input.q, 'q') };
  for (const key of ['location', 'major', 'role', 'industry', 'nature', 'source']) result[key] = list(input[key], key);
  result.salaryMin = amount(input.salaryMin, 'salaryMin');
  result.salaryMax = amount(input.salaryMax, 'salaryMax');
  if (result.salaryMin !== '' && result.salaryMax !== '' && result.salaryMin > result.salaryMax) invalid('最低薪资不能高于最高薪资');
  let currency = scalar(input.currency, 'currency', 10).toUpperCase();
  if (currency && !/^[A-Z]{3}$/.test(currency) && !['¥', '￥', 'A$', 'AU$', 'US$', '$', 'HK$', 'S$', '£', '€'].includes(currency)) invalid('currency 请使用 CNY、AUD 等币种代码');
  if (!currency && (result.salaryMin !== '' || result.salaryMax !== '')) {
    if (requireSalaryCurrency) invalid('薪资筛选请同时选择币种');
    currency = currencyFallback;
  }
  result.currency = currency ? normalizeCurrency(currency) : '';
  const period = scalar(input.salaryPeriod, 'salaryPeriod').toLowerCase();
  if (period && !['month', 'monthly', '月', '月薪', 'year', 'annual', 'annually', '年', '年薪', 'week', 'weekly', '周', '周薪', 'hour', 'hourly', '时', '小时', '时薪'].includes(period)) invalid('salaryPeriod 仅支持 hour/week/month/year');
  result.salaryPeriod = normalizeSalaryPeriod(period || salaryPeriodFallback);
  result.sort = choice(input.sort, 'sort', ['match', 'relevance', 'deadline', 'salary', 'latest'], 'match');
  result.availability = choice(input.availability, 'availability', ['active', 'all', 'expired'], 'active');
  result.qualification = choice(input.qualification, 'qualification', ['all', 'no_conflict', 'pass', 'unknown', 'fail'], 'all');
  result.minMatch = amount(input.minMatch, 'minMatch', 100) || 0;
  result.view = choice(input.view, 'view', ['all', 'saved', 'unapplied', 'applied', 'hidden'], 'all');
  result.deadlineWithin = choice(input.deadlineWithin, 'deadlineWithin', ['', '7', '30'], '');
  return result;
}

module.exports = { normalizeJobFilters };
