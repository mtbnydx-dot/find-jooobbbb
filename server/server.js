/**
 * Job Tracker Sync Server
 * 秋招进度看板 + 双向同步服务（单进程，JSON 文件存储）
 */
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const net = require('net');
const { canonicalKeyForJob } = require('./cloud/classifier');
const { CloudRuntime } = require('./cloud/runtime');
const { ProductPlatform, createProductRouter } = require('./product');
const { parseCookies } = require('./product/auth');

const DEFAULT_PORT = 3000;
const DEFAULT_DATA_DIR = path.join(__dirname, 'data');
const STATUSES = Object.freeze(['未投递', '已投递', '笔试', '一面', '二面', 'offer', '挂']);
const INFO_FIELDS = Object.freeze([
  'source', 'classification', 'origins', 'originIds', 'sourceRecordIds', 'canonicalKey',
  'active', 'firstSeenAt', 'lastSeenAt', 'missingAt', 'isCustom', 'sourceNote', 'contentSourceId',
  'priority', 'matchDir', 'company', 'nature', 'industry',
  'position', 'location', 'deadline', 'exam', 'url', 'notice', 'ddlRemind',
  'major', 'majors', 'degree', 'educationLevel', 'experience', 'description', 'requirements',
  'skills', 'skillTags', 'workMode', 'employmentType', 'benefits',
  'salary', 'salaryText', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryMonths', 'pay',
]);
const STATE_FIELDS = Object.freeze(['status', 'appliedAt', 'statusUpdatedAt', 'note']);
const JOB_FIELDS = new Set(['id', ...INFO_FIELDS, ...STATE_FIELDS]);
const MAX_JOBS = 20_000;
const MAX_FUTURE_SKEW_MS = 24 * 60 * 60 * 1000;
const MIN_TIMESTAMP_MS = Date.UTC(2000, 0, 1);
const FIELD_LIMIT_BYTES = Object.freeze({
  id: 256,
  source: 1000,
  classification: 100,
  origins: 8000,
  originIds: 8000,
  sourceRecordIds: 32_000,
  canonicalKey: 256,
  active: 20,
  firstSeenAt: 200,
  lastSeenAt: 200,
  missingAt: 200,
  isCustom: 20,
  sourceNote: 8000,
  contentSourceId: 256,
  priority: 100,
  matchDir: 500,
  company: 1000,
  nature: 500,
  industry: 500,
  position: 8000,
  location: 1000,
  deadline: 200,
  exam: 500,
  url: 8192,
  notice: 8192,
  ddlRemind: 500,
  major: 1000,
  majors: 4000,
  degree: 1000,
  educationLevel: 1000,
  experience: 1000,
  description: 32_000,
  requirements: 32_000,
  skills: 8000,
  skillTags: 8000,
  workMode: 1000,
  employmentType: 1000,
  benefits: 8000,
  salary: 2000,
  salaryText: 2000,
  salaryMin: 200,
  salaryMax: 200,
  salaryCurrency: 50,
  salaryPeriod: 50,
  salaryMonths: 50,
  pay: 2000,
  status: 100,
  appliedAt: 100,
  statusUpdatedAt: 200,
  note: 8000,
});
const PLACEHOLDER_SECRETS = new Set([
  '改成你的同步token', '改成你的编辑密码', '请改成随机token',
  'changeme', 'change-me', 'password', 'token',
]);

class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
    this.statusCode = 400;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

function nowIso(nowMs = Date.now()) {
  return new Date(nowMs).toISOString();
}

function normalizeString(value, field, { allowEmpty = true } = {}) {
  if (value === undefined || value === null) value = '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) {
    throw new InputError(`${field} 必须是字符串或标量值`);
  }
  const result = String(value).trim();
  if (!allowEmpty && result === '') throw new InputError(`${field} 不能为空`);
  if (result.includes('\0')) throw new InputError(`${field} 含非法字符`);
  const limit = FIELD_LIMIT_BYTES[field] || 2000;
  if (Buffer.byteLength(result, 'utf8') > limit) {
    throw new InputError(`${field} 过长`);
  }
  return result;
}

function normalizeId(value, field = 'id') {
  if (typeof value !== 'string') throw new InputError(`${field} 必须是字符串`);
  const id = normalizeString(value, 'id', { allowEmpty: false });
  if (!/^[\p{L}\p{N}._:-]+$/u.test(id)) throw new InputError(`${field} 格式非法`);
  return id;
}

function normalizeCalendarDate(value, field) {
  const text = normalizeString(value, field);
  if (!text) return '';
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(text);
  if (!match) throw new InputError(`${field} 必须是 YYYY/MM/DD`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new InputError(`${field} 不是有效日期`);
  }
  return `${yearText}/${monthText}/${dayText}`;
}

function normalizeIsoTimestamp(value, field, nowMs = Date.now()) {
  const text = normalizeString(value, field);
  if (!text) return '';
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
  if (!match) throw new InputError(`${field} 必须是带时区的 ISO 8601 时间`);
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day ||
      hour > 23 || minute > 59 || second > 59) {
    throw new InputError(`${field} 不是有效时间`);
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) throw new InputError(`${field} 不是有效时间`);
  if (timestamp < MIN_TIMESTAMP_MS) throw new InputError(`${field} 早于支持范围`);
  if (timestamp > nowMs + MAX_FUTURE_SKEW_MS) throw new InputError(`${field} 超出允许的未来时间`);
  return new Date(timestamp).toISOString();
}

function timestampMs(value) {
  if (typeof value !== 'string' || value === '') return Number.NEGATIVE_INFINITY;
  try {
    const normalized = normalizeIsoTimestamp(value, 'statusUpdatedAt', Number.MAX_SAFE_INTEGER);
    return normalized ? Date.parse(normalized) : Number.NEGATIVE_INFINITY;
  } catch (_) {
    // 旧数据中无时区或非法时间一律视为最旧，避免它永久压住新的规范时间戳。
    return Number.NEGATIVE_INFINITY;
  }
}

function rejectUnknownFields(object, allowed, context) {
  const unknown = Object.keys(object).filter(key => !allowed.has(key));
  if (unknown.length) throw new InputError(`${context} 含未知字段: ${unknown.join(', ')}`);
}

function normalizeIncomingJob(raw, index, nowMs) {
  const context = `jobs[${index}]`;
  if (!isPlainObject(raw)) throw new InputError(`${context} 必须是对象`);
  rejectUnknownFields(raw, JOB_FIELDS, context);
  const REQUIRED_FIELDS = new Set(['company', 'position']);
  const job = {};
  for (const field of INFO_FIELDS) {
    job[field] = normalizeString(raw[field], field, { allowEmpty: !REQUIRED_FIELDS.has(field) });
  }

  const status = raw.status === undefined || raw.status === ''
    ? '未投递'
    : normalizeString(raw.status, 'status', { allowEmpty: false });
  if (!STATUSES.includes(status)) throw new InputError(`${context}.status 非法`);
  job.status = status;
  job.appliedAt = normalizeCalendarDate(raw.appliedAt, `${context}.appliedAt`);
  job.statusUpdatedAt = normalizeIsoTimestamp(raw.statusUpdatedAt, `${context}.statusUpdatedAt`, nowMs);
  job.note = normalizeString(raw.note, 'note');
  if (raw.id === undefined || raw.id === null || String(raw.id).trim() === '') throw new InputError(`${context}.id 不能为空`);
  job.id = normalizeId(raw.id, `${context}.id`);
  return job;
}

function validateSyncPayload(payload, nowMs = Date.now()) {
  if (!isPlainObject(payload)) throw new InputError('请求体必须是 JSON 对象');
  rejectUnknownFields(payload, new Set(['jobs', 'syncAt']), '请求体');
  if (!Array.isArray(payload.jobs)) throw new InputError('jobs 必须是数组');
  if (payload.jobs.length > MAX_JOBS) throw new InputError(`jobs 最多 ${MAX_JOBS} 条`);
  const jobs = payload.jobs.map((job, index) => normalizeIncomingJob(job, index, nowMs));
  const ids = new Set();
  for (const job of jobs) {
    if (ids.has(job.id)) throw new InputError(`岗位 id 重复: ${job.id}`);
    ids.add(job.id);
  }
  const syncAt = payload.syncAt === undefined || payload.syncAt === ''
    ? nowIso(nowMs)
    : normalizeIsoTimestamp(payload.syncAt, 'syncAt', nowMs);
  return { jobs, syncAt };
}

function validateWebEditBody(body, nowMs = Date.now()) {
  if (!isPlainObject(body)) throw new InputError('请求体必须是 JSON 对象');
  rejectUnknownFields(body, new Set(['password', 'status', 'note']), '请求体');
  const status = normalizeString(body.status, 'status', { allowEmpty: false });
  if (!STATUSES.includes(status)) throw new InputError('非法状态');
  const result = { status, statusUpdatedAt: nowIso(nowMs) };
  if (Object.prototype.hasOwnProperty.call(body, 'note')) {
    if (typeof body.note !== 'string') throw new InputError('note 必须是字符串');
    result.note = normalizeString(body.note, 'note');
  }
  return result;
}

function validateCustomAddBody(body, nowMs = Date.now()) {
  if (!isPlainObject(body)) throw new InputError('请求体必须是 JSON 对象');
  rejectUnknownFields(body, new Set(['password', 'company', 'position', 'deadline', 'url', 'note', 'location']), '请求体');
  const company = normalizeString(body.company, 'company', { allowEmpty: false });
  const position = normalizeString(body.position, 'position', { allowEmpty: false });
  const deadline = normalizeString(body.deadline, 'deadline');
  if (deadline && !/^\d{4}\/\d{2}\/\d{2}$/.test(deadline)) throw new InputError('deadline 格式必须是 YYYY/MM/DD');
  const url = normalizeString(body.url, 'url');
  if (url && !/^https?:\/\//i.test(url)) throw new InputError('url 必须以 http:// 或 https:// 开头');
  const location = normalizeString(body.location, 'location');
  const note = normalizeString(body.note, 'note');
  // 自选岗位信息字段保持与 INFO_FIELDS 对齐，未填的留空，防止下游 sync 补录时字段缺失。
  const job = normalizeIncomingJob({
    id: 'custom-pending',
    source: '自选',
    classification: '自选',
    origins: JSON.stringify(['网页自选']),
    originIds: JSON.stringify(['custom']),
    sourceRecordIds: '[]',
    canonicalKey: '',
    active: '1',
    firstSeenAt: nowIso(nowMs),
    lastSeenAt: nowIso(nowMs),
    missingAt: '',
    isCustom: '1',
    sourceNote: '',
    priority: '',
    matchDir: '自选',
    company,
    nature: '',
    industry: '',
    position,
    location,
    deadline,
    exam: '',
    url,
    notice: '',
    ddlRemind: '',
    status: '未投递',
    appliedAt: '',
    statusUpdatedAt: nowIso(nowMs),
    note,
  }, 0, nowMs);
  job.id = `custom-${nowMs.toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
  job.canonicalKey = canonicalKeyForJob(job);
  return { id: job.id, addedAt: nowIso(nowMs), job };
}

function formatLocalDate(nowMs) {
  const date = new Date(nowMs);
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function writeFileDurably(file, contents) {
  const descriptor = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, contents, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(directory) {
  let descriptor;
  try {
    descriptor = fs.openSync(directory, 'r');
    fs.fsyncSync(descriptor);
  } catch (_) {
    // Windows 不支持目录 fsync；同目录 rename 仍提供名称级原子替换。
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteJson(file, value, { backupCurrent = true } = {}) {
  const directory = path.dirname(file);
  const temporary = `${file}.tmp`;
  const backup = `${file}.bak`;
  const backupTemporary = `${backup}.tmp`;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    writeFileDurably(temporary, `${JSON.stringify(value, null, 2)}\n`);
    if (backupCurrent && fs.existsSync(file)) {
      fs.copyFileSync(file, backupTemporary);
      const descriptor = fs.openSync(backupTemporary, 'r+');
      try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
      fs.renameSync(backupTemporary, backup);
    }
    fs.renameSync(temporary, file);
    fsyncDirectory(directory);
  } catch (error) {
    for (const candidate of [temporary, backupTemporary]) {
      try { fs.rmSync(candidate, { force: true }); } catch (_) { /* best effort */ }
    }
    throw error;
  }
}

function validateStoredStore(raw) {
  if (!isPlainObject(raw) || !Array.isArray(raw.jobs)) throw new Error('jobs.json 结构非法');
  if (raw.meta !== undefined && !isPlainObject(raw.meta)) throw new Error('jobs.json meta 结构非法');
  if (raw.jobs.length > MAX_JOBS) throw new Error(`jobs.json 岗位数量超过 ${MAX_JOBS}`);
  const ids = new Set();
  const jobs = [];
  for (let index = 0; index < raw.jobs.length; index++) {
    const source = raw.jobs[index];
    if (!isPlainObject(source)) throw new Error(`jobs.json jobs[${index}] 结构非法`);
    const id = normalizeId(source.id, `jobs[${index}].id`);
    if (ids.has(id)) throw new Error(`jobs.json 含重复 id: ${id}`);
    ids.add(id);
    const job = { id };
    for (const field of INFO_FIELDS) job[field] = normalizeString(source[field], field);
    const status = source.status === undefined || source.status === '' ? '未投递' : normalizeString(source.status, 'status');
    if (!STATUSES.includes(status)) throw new Error(`jobs.json jobs[${index}].status 非法`);
    job.status = status;
    job.appliedAt = normalizeCalendarDate(source.appliedAt, `jobs[${index}].appliedAt`);
    job.statusUpdatedAt = normalizeIsoTimestamp(source.statusUpdatedAt, `jobs[${index}].statusUpdatedAt`, Number.MAX_SAFE_INTEGER);
    job.note = normalizeString(source.note, 'note');
    jobs.push(job);
  }
  const storedMetaTimestamp = (value, field) => {
    if (value === undefined || value === null || value === '') return null;
    return normalizeIsoTimestamp(value, field, Number.MAX_SAFE_INTEGER);
  };
  return {
    jobs,
    meta: {
      lastSyncAt: storedMetaTimestamp(raw.meta?.lastSyncAt, 'meta.lastSyncAt'),
      lastWebEditAt: storedMetaTimestamp(raw.meta?.lastWebEditAt, 'meta.lastWebEditAt'),
    },
  };
}

function parseStringArray(value) {
  if (Array.isArray(value)) return value.map(item => String(item)).filter(Boolean);
  if (typeof value !== 'string' || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(item => String(item)).filter(Boolean) : [];
  } catch (_) {
    return [];
  }
}

function uniqueJsonArray(...values) {
  const items = new Set();
  for (const value of values) for (const item of parseStringArray(value)) items.add(item);
  return JSON.stringify([...items]);
}

function mergedOriginFields(jobs, sourceId, sourceName) {
  const pairs = new Map();
  for (const job of jobs) {
    const ids = parseStringArray(job?.originIds);
    const names = parseStringArray(job?.origins);
    ids.forEach((id, index) => {
      if (id && id !== sourceId && !pairs.has(id)) pairs.set(id, names[index] || id);
    });
  }
  pairs.set(sourceId, sourceName);
  const sorted = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    originIds: JSON.stringify(sorted.map(([id]) => id)),
    origins: JSON.stringify(sorted.map(([, name]) => name)),
  };
}

function mergedAllOriginFields(jobs, allowedIds = null) {
  const pairs = new Map();
  for (const job of jobs) {
    const ids = parseStringArray(job?.originIds);
    const names = parseStringArray(job?.origins);
    ids.forEach((id, index) => {
      if (!id || allowedIds && !allowedIds.has(id)) return;
      if (!pairs.has(id)) pairs.set(id, names[index] || id);
    });
  }
  const sorted = [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    originIds: JSON.stringify(sorted.map(([id]) => id)),
    origins: JSON.stringify(sorted.map(([, name]) => name)),
  };
}

function withoutSourceOrigin(job, sourceId) {
  const ids = parseStringArray(job.originIds);
  const names = parseStringArray(job.origins);
  const kept = ids.map((id, index) => ({ id, name: names[index] || id })).filter(pair => pair.id !== sourceId);
  return {
    originIds: JSON.stringify(kept.map(pair => pair.id)),
    origins: JSON.stringify(kept.map(pair => pair.name)),
    count: kept.length,
  };
}

function mergedSourceRecordIds(matches, local, sourceId, liveSourceRecordIds = new Set()) {
  const prefix = `${sourceId}:`;
  const ids = new Set();
  for (const match of matches) {
    for (const id of parseStringArray(match.sourceRecordIds)) {
      if (!id.startsWith(prefix) || liveSourceRecordIds.has(id)) ids.add(id);
    }
  }
  for (const id of parseStringArray(local.sourceRecordIds)) ids.add(id);
  return JSON.stringify([...ids].sort());
}

function hasUserState(job) {
  return Boolean(job && (job.status && job.status !== '未投递' || job.appliedAt || job.statusUpdatedAt || job.note));
}

function chooseStateJob(jobs) {
  return jobs.slice().sort((a, b) => {
    const aTime = timestampMs(a.statusUpdatedAt);
    const bTime = timestampMs(b.statusUpdatedAt);
    if (aTime !== bTime) return bTime > aTime ? 1 : -1;
    const state = Number(hasUserState(b)) - Number(hasUserState(a));
    if (state !== 0) return state;
    return String(a?.id || '').localeCompare(String(b?.id || ''));
  })[0] || null;
}

const CONTENT_FIELDS = Object.freeze([
  'sourceNote', 'priority', 'matchDir', 'company', 'nature', 'industry',
  'position', 'location', 'deadline', 'exam', 'url', 'notice', 'ddlRemind',
  'major', 'majors', 'degree', 'educationLevel', 'experience', 'description', 'requirements',
  'skills', 'skillTags', 'workMode', 'employmentType', 'benefits',
  'salary', 'salaryText', 'salaryMin', 'salaryMax', 'salaryCurrency', 'salaryPeriod', 'salaryMonths', 'pay',
]);

function contentVector(job) {
  const classification = job?.classification || job?.source;
  const classificationRank = classification === '符合条件' ? 3 : classification === '可试试' ? 2 : 1;
  let filled = 0;
  let richness = 0;
  for (const field of CONTENT_FIELDS) {
    const value = String(job?.[field] || '').trim();
    if (!value) continue;
    filled++;
    richness += Math.min(value.length, field === 'position' || field === 'sourceNote' ? 4_000 : 1_000);
  }
  return [classificationRank, filled, richness];
}

function compareContent(left, right) {
  const a = contentVector(left);
  const b = contentVector(right);
  for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
  return 0;
}

function inferredContentSource(job) {
  if (job?.contentSourceId) return String(job.contentSourceId);
  return parseStringArray(job?.originIds).find(id => id !== 'custom') || '';
}

function cloudKey(job) {
  // Recompute so canonical normalization upgrades also migrate existing records in place.
  return canonicalKeyForJob(job);
}

function dedupeCompact(value) {
  return String(value || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function dedupeCompany(value) {
  let result = dedupeCompact(value);
  const suffix = /(?:校园招聘|校园招募|实习生招募|实习招募|金融科技专场|精英计划|技术专项|校招|秋招|春招|实习|招聘|股份有限公司|有限责任公司|有限公司)$/u;
  let previous = '';
  while (result && result !== previous) {
    previous = result;
    result = result.replace(suffix, '');
  }
  return result;
}

function companySimilarity(left, right) {
  const a = dedupeCompany(left);
  const b = dedupeCompany(right);
  if (!a || !b) return 0;
  if (a === b) return 4;
  if (Math.min(a.length, b.length) >= 4 && (a.includes(b) || b.includes(a))) return 3;
  return 0;
}

function dedupeLocationParts(value) {
  return [...new Set(String(value || '')
    .toLowerCase()
    .split(/[|｜,，、/\\;；\s]+/u)
    .map(part => dedupeCompact(part).replace(/市$/u, ''))
    .filter(Boolean))];
}

function locationSimilarity(left, right) {
  const a = dedupeLocationParts(left);
  const b = dedupeLocationParts(right);
  if (!a.length || !b.length) return 0;
  const overlaps = a.filter(x => b.some(y => x === y || Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))));
  if (!overlaps.length) return 0;
  if (overlaps.length === a.length && overlaps.length === b.length) return 3;
  return 2;
}

function positionSimilarity(left, right) {
  const a = dedupeCompact(left);
  const b = dedupeCompact(right);
  if (!a || !b) return 0;
  if (a === b) return 3;
  if (Math.min(a.length, b.length) >= 8 && (a.includes(b) || b.includes(a))) return 2;
  const grams = value => new Set([...Array(Math.max(0, Math.min(value.length, 8_000) - 1))].map((_, index) => value.slice(index, index + 2)));
  const aGrams = grams(a);
  const bGrams = grams(b);
  if (!aGrams.size || !bGrams.size) return 0;
  let shared = 0;
  for (const gram of aGrams) if (bGrams.has(gram)) shared++;
  return 2 * shared / (aGrams.size + bGrams.size) >= 0.35 ? 1 : 0;
}

function normalizedRecruitmentLink(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.hostname = url.hostname.toLowerCase();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, '');
    const params = [...url.searchParams.entries()].sort(([aKey, aValue], [bKey, bValue]) => aKey.localeCompare(bKey) || aValue.localeCompare(bValue));
    url.search = '';
    for (const [key, item] of params) url.searchParams.append(key, item);
    return `${url.host}${url.pathname}${url.search}${url.hash}`;
  } catch (_) {
    return '';
  }
}

function recruitmentLinks(job) {
  return [...new Set([job?.url, job?.notice].map(normalizedRecruitmentLink).filter(Boolean))];
}

function calendarDeadline(value) {
  const match = /(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/u.exec(String(value || ''));
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function crossSourceAliasScore(local, candidate, sourceId) {
  const sourcePrefix = `${sourceId}:`;
  // During a source refresh, an existing job carrying another record ID from that same source is
  // reserved for its owning incoming row. Letting a link alias consume it early causes the later
  // row to be reinserted on every schedule cycle.
  if (parseStringArray(candidate?.sourceRecordIds).some(id => id.startsWith(sourcePrefix))) return -1;
  const origins = parseStringArray(candidate?.originIds);
  if (origins.length && !origins.some(id => id !== sourceId && id !== 'custom')) return -1;
  const localLinks = recruitmentLinks(local);
  const candidateLinks = new Set(recruitmentLinks(candidate));
  const sharedLinks = localLinks.filter(link => candidateLinks.has(link));
  if (!sharedLinks.length) return -1;
  const company = companySimilarity(local.company, candidate.company);
  const location = locationSimilarity(local.location, candidate.location);
  const position = positionSimilarity(local.position, candidate.position);
  if (company < 3 || location < 2 && position < 2) return -1;
  const localDeadline = calendarDeadline(local.deadline);
  const candidateDeadline = calendarDeadline(candidate.deadline);
  if (localDeadline !== null && candidateDeadline !== null && Math.abs(localDeadline - candidateDeadline) > 62 * 86_400_000) return -1;
  const localNotice = normalizedRecruitmentLink(local.notice);
  const candidateNotice = normalizedRecruitmentLink(candidate.notice);
  const noticeMatch = Boolean(localNotice && localNotice === candidateNotice);
  const deadlineMatch = localDeadline !== null && localDeadline === candidateDeadline;
  return company * 100 + location * 10 + position + Number(noticeMatch) * 5 + Number(deadlineMatch) * 3;
}

function bestCrossSourceAlias(local, sourceId, oldByLink, consumed, excludedIds = new Set()) {
  const candidates = new Map();
  for (const link of recruitmentLinks(local)) {
    for (const candidate of oldByLink.get(link) || []) {
      if (!consumed.has(candidate.id) && !excludedIds.has(candidate.id)) candidates.set(candidate.id, candidate);
    }
  }
  const scored = [...candidates.values()]
    .map(candidate => ({ candidate, score: crossSourceAliasScore(local, candidate, sourceId) }))
    .filter(item => item.score >= 0)
    .sort((a, b) => b.score - a.score || String(a.candidate.id).localeCompare(String(b.candidate.id)));
  if (!scored.length || scored.length > 1 && scored[0].score === scored[1].score) return null;
  return scored[0].candidate;
}

function createService({ dataDir = DEFAULT_DATA_DIR, clock = () => Date.now() } = {}) {
  const jobsFile = path.join(dataDir, 'jobs.json');
  const logFile = path.join(dataDir, 'log.jsonl');
  let store = { jobs: [], meta: { lastSyncAt: null, lastWebEditAt: null } };
  let logFailureWarned = false;

  function audit(action, detail) {
    try {
      fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
      const descriptor = fs.openSync(logFile, 'a', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ ts: nowIso(clock()), action, detail })}\n`, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      logFailureWarned = false;
    } catch (error) {
      if (!logFailureWarned) console.error(`audit log failed: ${error.message}`);
      logFailureWarned = true;
    }
  }

  function preserveCorruptPrimary() {
    if (!fs.existsSync(jobsFile)) return null;
    const suffix = nowIso(clock()).replace(/[:.]/g, '-');
    const target = `${jobsFile}.corrupt-${suffix}`;
    fs.copyFileSync(jobsFile, target, fs.constants.COPYFILE_EXCL);
    return target;
  }

  function load() {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const candidates = [jobsFile, `${jobsFile}.tmp`, `${jobsFile}.bak`];
    const existing = candidates.filter(candidate => fs.existsSync(candidate));
    if (!existing.length) {
      const initial = { jobs: [], meta: { lastSyncAt: null, lastWebEditAt: null } };
      atomicWriteJson(jobsFile, initial, { backupCurrent: false });
      store = initial;
      return store;
    }

    const errors = [];
    for (const candidate of existing) {
      try {
        const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
        const recovered = validateStoredStore(parsed);
        if (candidate !== jobsFile) {
          let preserved = null;
          try { preserved = preserveCorruptPrimary(); } catch (_) { /* recovery can continue */ }
          atomicWriteJson(jobsFile, recovered, { backupCurrent: false });
          audit('recovery', { source: path.basename(candidate), corruptCopy: preserved ? path.basename(preserved) : null });
        }
        store = recovered;
        return store;
      } catch (error) {
        errors.push(`${path.basename(candidate)}: ${error.message}`);
      }
    }
    throw new Error(`无法加载数据，原文件未被覆盖（${errors.join('; ')}）`);
  }

  function commit(nextStore) {
    atomicWriteJson(jobsFile, nextStore);
    store = nextStore;
  }

  function copyStoredState(job) {
    const status = typeof job.status === 'string' && STATUSES.includes(job.status) ? job.status : '未投递';
    return {
      status,
      appliedAt: typeof job.appliedAt === 'string' ? job.appliedAt : '',
      statusUpdatedAt: typeof job.statusUpdatedAt === 'string' ? job.statusUpdatedAt : '',
      note: typeof job.note === 'string' ? job.note : '',
    };
  }

  function mergeStoredState(jobs) {
    const primary = copyStoredState(chooseStateJob(jobs) || {});
    const notes = [...new Set(jobs.map(job => copyStoredState(job).note).filter(Boolean))].sort();
    primary.note = normalizeString(notes.join('\n\n'), 'note');
    return primary;
  }

  function applySync(payload) {
    const nowMs = clock();
    const incoming = validateSyncPayload(payload, nowMs);
    const oldById = new Map(store.jobs.map(job => [job.id, job]));
    const nextJobs = [];
    let inserted = 0;
    let updated = 0;
    let kept = 0;
    let stateTaken = 0;

    for (const local of incoming.jobs) {
      const old = oldById.get(local.id);
      if (!old) {
        nextJobs.push({ ...local, active: '1', missingAt: '' });
        inserted++;
        continue;
      }

      const next = { id: local.id };
      let changed = false;
      for (const field of INFO_FIELDS) {
        const cloudOwned = ['classification', 'origins', 'originIds', 'sourceRecordIds', 'canonicalKey', 'firstSeenAt', 'lastSeenAt', 'isCustom', 'sourceNote', 'contentSourceId'].includes(field);
        next[field] = cloudOwned && !local[field] ? String(old[field] || '') : local[field];
        if (String(old[field] ?? '') !== next[field]) changed = true;
      }
      next.active = '1';
      next.missingAt = '';
      if (old.source === '自选' || old.isCustom === '1') next.isCustom = '1';
      const oldState = copyStoredState(old);
      const localIsNewer = timestampMs(local.statusUpdatedAt) > timestampMs(oldState.statusUpdatedAt);
      for (const field of STATE_FIELDS) next[field] = localIsNewer ? local[field] : oldState[field];
      if (localIsNewer) {
        stateTaken++;
        changed = true;
      }
      nextJobs.push(next);
      if (changed) updated++; else kept++;
    }

    const localIds = new Set(incoming.jobs.map(job => job.id));
    let deleted = 0;
    for (const old of store.jobs) {
      if (localIds.has(old.id)) continue;
      if (old.source === '自选' || old.isCustom === '1') {
        nextJobs.push({ ...old, active: '1' });
        kept++;
        continue;
      }
      nextJobs.push({ ...old, active: '0', missingAt: incoming.syncAt });
      deleted++;
    }
    const nextStore = {
      jobs: nextJobs,
      meta: { ...store.meta, lastSyncAt: incoming.syncAt },
    };
    commit(nextStore);
    audit('sync', { received: incoming.jobs.length, inserted, updated, kept, stateTaken, deleted });
    return { received: incoming.jobs.length, inserted, updated, kept, stateTaken, deleted, syncAt: incoming.syncAt };
  }

  function applyCloudSync(payload, { beforeCommitAliases = null, afterCommitAliases = null } = {}) {
    const nowMs = clock();
    if (!isPlainObject(payload)) throw new InputError('云同步请求必须是对象');
    const sourceId = normalizeString(payload.sourceId, 'source', { allowEmpty: false });
    const sourceName = normalizeString(payload.sourceName, 'source', { allowEmpty: false });
    const incoming = validateSyncPayload({ jobs: payload.jobs, syncAt: payload.syncAt }, nowMs);
    const liveSourceRecordIds = new Set(incoming.jobs.flatMap(job => parseStringArray(job.sourceRecordIds)));
    const incomingKeys = new Set(incoming.jobs.map(cloudKey));
    const oldById = new Map(store.jobs.map(job => [job.id, job]));
    const oldByKey = new Map();
    const oldBySourceRecordId = new Map();
    const oldByLink = new Map();
    for (const job of store.jobs) {
      const key = cloudKey(job);
      if (!oldByKey.has(key)) oldByKey.set(key, []);
      oldByKey.get(key).push(job);
      for (const id of parseStringArray(job.sourceRecordIds)) {
        if (!oldBySourceRecordId.has(id)) oldBySourceRecordId.set(id, []);
        oldBySourceRecordId.get(id).push(job);
      }
      for (const link of recruitmentLinks(job)) {
        if (!oldByLink.has(link)) oldByLink.set(link, []);
        oldByLink.get(link).push(job);
      }
    }
    const firstCloudSync = !store.jobs.some(job => parseStringArray(job.originIds).some(id => id !== 'custom'));
    const consumed = new Set();
    const outputIndexByOldId = new Map();
    const assignedIds = new Set();
    const aliases = {};
    const nextJobs = [];
    const newJobs = [];
    let inserted = 0;
    let updated = 0;
    let deduplicated = 0;
    let crossSourceMatched = 0;
    let coalesced = 0;

    for (const local of incoming.jobs) {
      const key = cloudKey(local);
      const stableMatches = new Map();
      for (const recordId of parseStringArray(local.sourceRecordIds)) {
        for (const job of oldBySourceRecordId.get(recordId) || []) stableMatches.set(job.id, job);
      }
      // Tencent previously used physical row numbers as record IDs. If a row was inserted or
      // sorted, that ID can now point at a different company. Reserve the old job for an incoming
      // row that still has its old canonical content instead of moving its personal state.
      const eligibleStable = [...stableMatches.values()].filter(job => {
        const oldKey = cloudKey(job);
        return oldKey === key || !incomingKeys.has(oldKey);
      });
      const availableStable = eligibleStable.filter(job => !consumed.has(job.id));
      const consumedOutputs = new Set(eligibleStable.map(job => outputIndexByOldId.get(job.id)).filter(Number.isInteger));
      if (eligibleStable.length && !availableStable.length && consumedOutputs.size === 1) {
        const outputIndex = [...consumedOutputs][0];
        const target = nextJobs[outputIndex];
        const hasForeignOrigin = parseStringArray(target?.originIds).some(id => id !== sourceId && id !== 'custom');
        if (target && hasForeignOrigin) {
          target.sourceRecordIds = uniqueJsonArray(target.sourceRecordIds, local.sourceRecordIds);
          target.lastSeenAt = incoming.syncAt;
          coalesced++;
          continue;
        }
      }
      const matchesById = new Map();
      for (const job of availableStable) matchesById.set(job.id, job);
      // Always fold exact canonical aliases into the same output, including sourced duplicates
      // left by old imports. This makes every normal source refresh repair part of the history.
      const exact = (oldByKey.get(key) || []).filter(job => !consumed.has(job.id));
      for (const job of exact) matchesById.set(job.id, job);
      // Link-assisted matching is only for a genuinely new/unmatched source row. Once a stable
      // record or exact canonical match exists, adding a second alias can collapse two distinct
      // rows owned by another source into one job and make alternating source runs oscillate.
      const alias = matchesById.size ? null : bestCrossSourceAlias(local, sourceId, oldByLink, consumed);
      if (alias) {
        matchesById.set(alias.id, alias);
        crossSourceMatched++;
      }
      const matches = [...matchesById.values()];
      const stateSource = chooseStateJob(matches);
      const identitySource = stateSource || matches[0] || null;
      for (const match of matches) consumed.add(match.id);
      if (matches.length > 1) deduplicated += matches.length - 1;
      const originFields = mergedOriginFields([...matches, local], sourceId, sourceName);
      const wasCustom = matches.some(job => job.source === '自选' || job.isCustom === '1');
      let informationSource = local;
      let contentSourceId = sourceId;
      if (identitySource) {
        const existingProvider = inferredContentSource(identitySource);
        const mergedOriginIds = new Set(parseStringArray(originFields.originIds));
        if (existingProvider && existingProvider !== sourceId && mergedOriginIds.has(existingProvider)) {
          const comparison = compareContent(local, identitySource);
          if (comparison < 0 || comparison === 0 && sourceId.localeCompare(existingProvider) > 0) {
            informationSource = identitySource;
            contentSourceId = existingProvider;
          }
        }
      }
      const replaceableIds = new Set(matches.map(match => match.id));
      const idAvailable = candidate => !assignedIds.has(candidate) && (!oldById.has(candidate) || replaceableIds.has(candidate));
      let outputId = identitySource?.id || local.id;
      if (!idAvailable(outputId)) {
        if (idAvailable(local.id)) outputId = local.id;
        else {
          const seed = `${sourceId}\u001f${key}\u001f${parseStringArray(local.sourceRecordIds).join('\u001f')}`;
          const suffix = crypto.createHash('sha1').update(seed, 'utf8').digest('hex').slice(0, 12);
          outputId = `${local.id}-${suffix}`;
          let sequence = 2;
          while (!idAvailable(outputId)) outputId = `${local.id}-${suffix}-${sequence++}`;
        }
      }
      const job = {
        ...informationSource,
        id: outputId,
        canonicalKey: cloudKey(informationSource),
        ...originFields,
        sourceRecordIds: mergedSourceRecordIds(matches, local, sourceId, liveSourceRecordIds),
        active: '1',
        firstSeenAt: matches.map(item => item.firstSeenAt).find(Boolean) || local.firstSeenAt || incoming.syncAt,
        lastSeenAt: incoming.syncAt,
        missingAt: '',
        isCustom: wasCustom ? '1' : local.isCustom,
        contentSourceId,
      };
      const preserved = mergeStoredState(matches);
      for (const field of STATE_FIELDS) job[field] = preserved[field];
      // Older imports stored the upstream "备注/提示" column in the personal-note field.
      // Once the source has a dedicated sourceNote, remove only an exact duplicate and retain any
      // genuinely different user-authored note.
      if (job.sourceNote && job.note === job.sourceNote) job.note = '';
      // lastSeenAt is an operational heartbeat. Counting it as a content update would make every
      // unchanged scheduled run report that every job changed.
      const changed = !identitySource || INFO_FIELDS.some(field => field !== 'lastSeenAt' && String(identitySource[field] || '') !== String(job[field] || ''));
      if (!identitySource) {
        inserted++;
        newJobs.push(job);
      } else if (changed || matches.length > 1) {
        updated++;
      }
      const outputIndex = nextJobs.length;
      nextJobs.push(job);
      assignedIds.add(job.id);
      for (const match of matches) {
        outputIndexByOldId.set(match.id, outputIndex);
        if (match.id !== job.id) aliases[match.id] = job.id;
      }
    }

    let inactive = 0;
    for (const old of store.jobs) {
      if (consumed.has(old.id)) continue;
      const custom = old.source === '自选' || old.isCustom === '1';
      const hadSource = parseStringArray(old.originIds).includes(sourceId);
      const remaining = withoutSourceOrigin(old, sourceId);
      const contentSourceId = old.contentSourceId === sourceId ? '' : old.contentSourceId;
      const belongsToFirstSource = firstCloudSync && !remaining.count && !custom;
      if (belongsToFirstSource || hadSource && !remaining.count) {
        nextJobs.push({ ...old, active: '0', missingAt: incoming.syncAt, originIds: remaining.originIds, origins: remaining.origins, contentSourceId });
        inactive++;
      } else {
        nextJobs.push({ ...old, active: custom ? '1' : old.active || '1', originIds: remaining.originIds, origins: remaining.origins, contentSourceId });
      }
    }

    if (nextJobs.length > MAX_JOBS) throw new InputError(`合并后岗位超过 ${MAX_JOBS} 条`);
    const ids = new Set();
    for (const job of nextJobs) {
      if (ids.has(job.id)) throw new InputError(`合并后岗位 id 重复: ${job.id}`);
      ids.add(job.id);
    }
    const nextStore = { jobs: nextJobs, meta: { ...store.meta, lastSyncAt: incoming.syncAt } };
    const aliasContext = typeof beforeCommitAliases === 'function' ? beforeCommitAliases(aliases) : null;
    commit(nextStore);
    const aliasEffects = typeof afterCommitAliases === 'function' ? afterCommitAliases(aliases, aliasContext) : null;
    audit('cloudSync', { sourceId, received: incoming.jobs.length, inserted, updated, deduplicated, crossSourceMatched, coalesced, inactive, aliases: Object.keys(aliases).length });
    return { received: incoming.jobs.length, inserted, updated, deduplicated, crossSourceMatched, coalesced, inactive, active: nextJobs.filter(job => job.active !== '0').length, newJobs, aliases, aliasEffects, syncAt: incoming.syncAt };
  }

  function reconcileCloudJobs({ sourceIds = [], activeSourceRecordIds = null, preferredIds = [], syncAt = nowIso(clock()), dryRun = false, beforeCommitAliases = null, afterCommitAliases = null } = {}) {
    const nowMs = clock();
    const timestamp = normalizeIsoTimestamp(syncAt, 'syncAt', nowMs);
    const currentSources = new Set((Array.isArray(sourceIds) ? sourceIds : []).map(String).filter(Boolean));
    const liveRecords = Array.isArray(activeSourceRecordIds)
      ? new Set(activeSourceRecordIds.map(String).filter(Boolean))
      : null;
    const allowedOrigins = new Set([...currentSources, 'custom']);
    const preferred = new Set((Array.isArray(preferredIds) ? preferredIds : []).map(String).filter(Boolean));
    const groups = new Map();
    for (const job of store.jobs) {
      const key = cloudKey(job);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }

    const hasCurrentOrigin = job => parseStringArray(job.originIds).some(id => currentSources.has(id));
    const contentOrder = (a, b) => {
      const currentDifference = Number(hasCurrentOrigin(b)) - Number(hasCurrentOrigin(a));
      if (currentDifference) return currentDifference;
      const contentDifference = compareContent(b, a);
      if (contentDifference) return contentDifference;
      const preferredDifference = Number(preferred.has(b.id)) - Number(preferred.has(a.id));
      if (preferredDifference) return preferredDifference;
      const seenDifference = timestampMs(b.lastSeenAt) - timestampMs(a.lastSeenAt);
      if (seenDifference) return seenDifference;
      return String(a.id).localeCompare(String(b.id));
    };
    const identityOrder = (a, b) => {
      const preferredDifference = Number(preferred.has(b.id)) - Number(preferred.has(a.id));
      if (preferredDifference) return preferredDifference;
      return contentOrder(a, b);
    };

    const aliases = {};
    const nextJobs = [];
    let duplicateGroups = 0;
    let duplicatesRemoved = 0;
    let legacyDeactivated = 0;
    const activeBefore = store.jobs.filter(job => job.active !== '0').length;
    for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      if (group.length > 1) {
        duplicateGroups++;
        duplicatesRemoved += group.length - 1;
      }
      const contentSource = group.slice().sort(contentOrder)[0];
      const identitySource = group.slice().sort(identityOrder)[0];
      const originFields = mergedAllOriginFields(group, allowedOrigins);
      const custom = group.some(job => job.source === '自选' || job.isCustom === '1');
      const activeFromSource = liveRecords
        // Reconciliation may deactivate stale rows, but it must never revive a row merely because
        // an old positional Tencent ID was later reused by different content. A source run is the
        // only operation allowed to reactivate a previously missing record.
        ? group.some(item => item.active !== '0' && parseStringArray(item.sourceRecordIds).some(id => liveRecords.has(id)))
        : parseStringArray(originFields.originIds).some(id => currentSources.has(id));
      const active = custom || activeFromSource;
      const existingContentSource = inferredContentSource(contentSource);
      const contentSourceId = currentSources.has(existingContentSource)
        ? existingContentSource
        : parseStringArray(originFields.originIds).find(id => currentSources.has(id)) || '';
      const firstSeenAt = group.map(job => job.firstSeenAt).filter(Boolean).sort()[0] || timestamp;
      const lastSeenAt = group.map(job => job.lastSeenAt).filter(Boolean).sort().at(-1) || timestamp;
      const state = mergeStoredState(group);
      const job = {
        ...contentSource,
        id: identitySource.id,
        canonicalKey: key,
        ...originFields,
        sourceRecordIds: uniqueJsonArray(...group.map(item => item.sourceRecordIds)),
        active: active ? '1' : '0',
        firstSeenAt,
        lastSeenAt,
        missingAt: active ? '' : timestamp,
        isCustom: custom ? '1' : '',
        contentSourceId,
        ...state,
      };
      if (job.sourceNote && job.note === job.sourceNote) job.note = '';
      nextJobs.push(job);
      for (const old of group) if (old.id !== job.id) aliases[old.id] = job.id;
      if (!active) legacyDeactivated += group.filter(old => old.active !== '0').length;
    }
    if (nextJobs.length > MAX_JOBS) throw new InputError(`整理后岗位超过 ${MAX_JOBS} 条`);
    const ids = new Set();
    for (const job of nextJobs) {
      if (ids.has(job.id)) throw new InputError(`整理后岗位 id 重复: ${job.id}`);
      ids.add(job.id);
    }
    const result = {
      dryRun: Boolean(dryRun),
      before: store.jobs.length,
      after: nextJobs.length,
      activeBefore,
      activeAfter: nextJobs.filter(job => job.active !== '0').length,
      duplicateGroups,
      duplicatesRemoved,
      legacyDeactivated,
      aliases,
      syncAt: timestamp,
    };
    if (!dryRun) {
      const aliasContext = typeof beforeCommitAliases === 'function' ? beforeCommitAliases(aliases) : null;
      commit({ jobs: nextJobs, meta: { ...store.meta } });
      result.aliasEffects = typeof afterCommitAliases === 'function' ? afterCommitAliases(aliases, aliasContext) : null;
      audit('reconcile', { ...result, aliases: undefined });
    }
    return result;
  }

  function applyWebEdit(idValue, body) {
    const nowMs = clock();
    const id = normalizeId(idValue);
    const edit = validateWebEditBody(body, nowMs);
    const index = store.jobs.findIndex(job => job.id === id);
    if (index < 0) return { ok: false, error: '岗位不存在' };

    const job = { ...store.jobs[index], status: edit.status, statusUpdatedAt: edit.statusUpdatedAt };
    if (edit.status === '已投递' && !job.appliedAt) job.appliedAt = formatLocalDate(nowMs);
    if (Object.prototype.hasOwnProperty.call(edit, 'note')) job.note = edit.note;
    const jobs = store.jobs.slice();
    jobs[index] = job;
    const nextStore = {
      jobs,
      meta: { ...store.meta, lastWebEditAt: edit.statusUpdatedAt },
    };
    commit(nextStore);
    audit('webEdit', { id, status: edit.status, noteChanged: Object.prototype.hasOwnProperty.call(edit, 'note') });
    return { ok: true, job };
  }

  function applyCustomAdd(body) {
    const nowMs = clock();
    const edit = validateCustomAddBody(body, nowMs);
    const index = store.jobs.findIndex(job => job.id === edit.id);
    if (index >= 0) return { ok: false, error: '岗位 ID 冲突，请稍后重试' };
    const jobs = store.jobs.concat([edit.job]);
    const nextStore = {
      jobs,
      meta: { ...store.meta, lastWebEditAt: edit.addedAt },
    };
    commit(nextStore);
    audit('customAdd', { id: edit.id, company: edit.job.company });
    return { ok: true, job: edit.job };
  }

  function applyCustomDelete(idValue) {
    const nowMs = clock();
    const id = normalizeId(idValue);
    const index = store.jobs.findIndex(job => job.id === id);
    if (index < 0) return { ok: false, error: '岗位不存在' };
    const target = store.jobs[index];
    if (target.source !== '自选' && target.isCustom !== '1') return { ok: false, error: '仅自选岗位可删除' };
    if (target.source !== '自选') {
      const job = { ...target, isCustom: '0', statusUpdatedAt: nowIso(nowMs) };
      const jobs = store.jobs.slice();
      jobs[index] = job;
      const nextStore = {
        jobs,
        meta: { ...store.meta, lastWebEditAt: nowIso(nowMs) },
      };
      commit(nextStore);
      audit('unmarkCustom', { id, company: target.company });
      return { ok: true, unmarked: true, job };
    }
    const jobs = store.jobs.slice();
    jobs.splice(index, 1);
    const nextStore = {
      jobs,
      meta: { ...store.meta, lastWebEditAt: nowIso(nowMs) },
    };
    commit(nextStore);
    audit('customDelete', { id, company: target.company });
    return { ok: true, deleted: target };
  }

  function applyMarkCustom(idValue) {
    const nowMs = clock();
    const id = normalizeId(idValue);
    const index = store.jobs.findIndex(job => job.id === id);
    if (index < 0) return { ok: false, error: '岗位不存在' };
    const target = store.jobs[index];
    if (target.source === '自选' || target.isCustom === '1') return { ok: false, error: '已是自选岗位' };
    const job = { ...target, isCustom: '1', statusUpdatedAt: nowIso(nowMs) };
    const jobs = store.jobs.slice();
    jobs[index] = job;
    const nextStore = {
      jobs,
      meta: { ...store.meta, lastWebEditAt: nowIso(nowMs) },
    };
    commit(nextStore);
    audit('markCustom', { id, company: target.company });
    return { ok: true, job };
  }

  return {
    load,
    applySync,
    applyCloudSync,
    reconcileCloudJobs,
    applyWebEdit,
    applyCustomAdd,
    applyCustomDelete,
    applyMarkCustom,
    snapshot: () => store,
    paths: { jobsFile, logFile },
  };
}

function createFailureLimiter({ limit = 10, windowMs = 15 * 60 * 1000, blockMs = 15 * 60 * 1000, clock = () => Date.now() } = {}) {
  const entries = new Map();
  function prune(now) {
    for (const [key, entry] of entries) {
      if (entry.blockedUntil <= now && entry.windowStart + windowMs <= now) entries.delete(key);
    }
    while (entries.size > 2048) entries.delete(entries.keys().next().value);
  }
  return {
    retryAfter(key) {
      const now = clock();
      const entry = entries.get(key);
      if (!entry || entry.blockedUntil <= now) return 0;
      return Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    },
    fail(key) {
      const now = clock();
      prune(now);
      let entry = entries.get(key);
      if (!entry || entry.windowStart + windowMs <= now) entry = { count: 0, windowStart: now, blockedUntil: 0 };
      entry.count++;
      if (entry.count >= limit) entry.blockedUntil = now + blockMs;
      entries.set(key, entry);
    },
    clear(key) { entries.delete(key); },
  };
}

function parseBearer(header) {
  if (typeof header !== 'string') return '';
  const match = /^Bearer ([^\s]+)$/i.exec(header.trim());
  return match ? match[1] : '';
}

function requestKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function normalizePublicBase(value, fallback, name) {
  let result = String(value || fallback).trim();
  if (!result.startsWith('/')) result = `/${result}`;
  result = result.replace(/\/{2,}/g, '/');
  if (result.length > 1) result = result.replace(/\/+$/, '');
  if (!result || /[?#\\]/.test(result) || result.split('/').includes('..')) {
    throw new Error(`${name} 必须是站点内的绝对路径`);
  }
  return result;
}

function publicPath(base, child = '') {
  const suffix = String(child || '').replace(/^\/+/, '');
  if (!suffix) return base === '/' ? '/' : `${base}/`;
  return base === '/' ? `/${suffix}` : `${base}/${suffix}`;
}

function rewriteUrlPrefix(url, sourcePrefix, targetPrefix) {
  if (sourcePrefix === targetPrefix) return url;
  const queryIndex = url.indexOf('?');
  const pathname = queryIndex === -1 ? url : url.slice(0, queryIndex);
  if (pathname !== sourcePrefix && !pathname.startsWith(`${sourcePrefix}/`)) return url;
  const query = queryIndex === -1 ? '' : url.slice(queryIndex);
  return `${targetPrefix}${pathname.slice(sourcePrefix.length)}${query}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createApp({
  service,
  cloud = null,
  product = null,
  syncToken = process.env.SYNC_TOKEN || '',
  editPassword = process.env.EDIT_PASSWORD || '',
  aiEditPassword = process.env.AI_EDIT_PASSWORD || '',
  legacySyncEnabled = false,
  secureProductCookies = process.env.NODE_ENV === 'production',
  legacyAdminOnly = process.env.LEGACY_ADMIN_ONLY === undefined ? Boolean(product) : process.env.LEGACY_ADMIN_ONLY !== '0',
  productPublicBase = process.env.PRODUCT_PUBLIC_BASE || '/app',
  opsPublicBase = process.env.OPS_PUBLIC_BASE || '/ops',
  productCookieName = process.env.PRODUCT_COOKIE_NAME || 'job_session',
} = {}) {
  if (!service) throw new Error('createApp requires a service');
  const productBase = normalizePublicBase(productPublicBase, '/app', 'PRODUCT_PUBLIC_BASE');
  const opsBase = normalizePublicBase(opsPublicBase, '/ops', 'OPS_PUBLIC_BASE');
  if (productBase === '/' || opsBase === '/') throw new Error('产品端与运营端必须使用非根路径');
  if (productBase === opsBase) throw new Error('PRODUCT_PUBLIC_BASE 与 OPS_PUBLIC_BASE 不能相同');
  const productBaseWithSlash = publicPath(productBase);
  const productApiBase = productBase === '/app' ? '/api/v1' : publicPath(productBase, 'api/v1').replace(/\/$/, '');
  const opsApiBase = opsBase === '/ops' ? '/api' : publicPath(opsBase, 'api').replace(/\/$/, '');
  const app = express();
  const editJson = express.json({ limit: '16kb', strict: true });
  const cloudJson = express.json({ limit: '128kb', strict: true });
  const syncJson = express.json({ limit: '16mb', strict: true });
  const editLimiter = createFailureLimiter();
  const aiEditLimiter = createFailureLimiter();
  const syncLimiter = createFailureLimiter();

  function productUserFromRequest(req) {
    if (!product) return null;
    const authorization = String(req.headers.authorization || '');
    const bearer = /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] || '';
    const token = bearer || parseCookies(req.headers.cookie || '')[productCookieName] || '';
    return product.authenticate(token);
  }

  function authorizeEdit(req, res) {
    const key = requestKey(req);
    if (!editPassword) {
      editLimiter.clear(key);
      return true;
    }
    const retryAfter = editLimiter.retryAfter(key);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ ok: false, error: '尝试次数过多，请稍后再试' });
      return false;
    }
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!safeEqual(password, editPassword)) {
      editLimiter.fail(key);
      res.status(401).json({ ok: false, error: '密码错误' });
      return false;
    }
    editLimiter.clear(key);
    return true;
  }

  function authorizeAiEdit(req, res) {
    const key = requestKey(req);
    if (!aiEditPassword) {
      aiEditLimiter.clear(key);
      res.status(503).json({ ok: false, error: '服务器尚未配置 AI 画像密码', code: 'AI_EDIT_PASSWORD_NOT_CONFIGURED' });
      return false;
    }
    const retryAfter = aiEditLimiter.retryAfter(key);
    if (retryAfter) {
      res.set('Retry-After', String(retryAfter));
      res.status(429).json({ ok: false, error: 'AI 画像密码尝试次数过多，请稍后再试' });
      return false;
    }
    const password = typeof req.body?.aiPassword === 'string' ? req.body.aiPassword : '';
    if (!safeEqual(password, aiEditPassword)) {
      aiEditLimiter.fail(key);
      res.status(401).json({ ok: false, error: 'AI 画像密码错误' });
      return false;
    }
    aiEditLimiter.clear(key);
    return true;
  }

  function sourceRunAllowsAutoAi(req, res) {
    const settings = cloud?.getAiSettings?.();
    const allowAutoAi = Boolean(settings?.enabled && settings?.autoRun);
    if (allowAutoAi && !authorizeAiEdit(req, res)) return null;
    return allowAutoAi;
  }

  app.disable('x-powered-by');
  // 仅信任直接位于本机/容器私网的反向代理，避免公网客户端伪造 X-Forwarded-For 绕过限速。
  app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
  // Preview deployments keep their public prefixes in the browser while the existing handlers stay on /api.
  app.use((req, res, next) => {
    req.url = rewriteUrlPrefix(req.url, productApiBase, '/api/v1');
    req.url = rewriteUrlPrefix(req.url, opsApiBase, '/api');
    next();
  });
  app.use((req, res, next) => {
    res.set({
      'Content-Security-Policy': "default-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
      'Strict-Transport-Security': 'max-age=31536000',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.get(['/', '/index.html'], (req, res) => {
    if (product) return res.redirect(302, productBaseWithSlash);
    return res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });
  const opsEntry = (req, res) => {
    if (product && legacyAdminOnly) {
      const user = productUserFromRequest(req);
      if (!user || user.role !== 'admin') return res.redirect(302, publicPath(productBase, 'login'));
    }
    if (opsBase === '/ops') return res.sendFile(path.join(__dirname, 'public', 'index.html'));
    const template = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
    return res.type('html').send(template
      .replace('<meta name="ops-public-base" content="/ops">', `<meta name="ops-public-base" content="${opsBase}">`)
      .replace('href="/app/login"', `href="${publicPath(productBase, 'login')}"`)
      .replace('src="/app.js?', `src="${publicPath(opsBase, 'app.js')}?`));
  };
  app.get(opsBase, opsEntry);
  if (opsBase !== '/ops') {
    app.get(publicPath(opsBase, 'app.js'), (req, res) => res.sendFile(path.join(__dirname, 'public', 'app.js')));
  }
  if (productBase !== '/app') {
    app.use(productBase, express.static(path.join(__dirname, 'public', 'app'), {
      dotfiles: 'deny', index: false, etag: true, maxAge: 0,
      setHeaders(response) { response.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
    }));
  }
  app.use(express.static(path.join(__dirname, 'public'), {
    dotfiles: 'deny',
    index: false,
    etag: true,
    maxAge: 0,
    setHeaders(response) { response.setHeader('Cache-Control', 'no-cache, must-revalidate'); },
  }));

  // Client-side routes such as /app/jobs or /usertest/jobs must survive a browser reload.
  // Missing files keep their normal 404 instead of receiving HTML as a script or image.
  const productRoutePattern = new RegExp(`^${escapeRegex(productBase)}(?:/.*)?$`);
  app.get(productRoutePattern, (req, res, next) => {
    if (path.extname(req.path) || !req.accepts('html')) return next();
    const entry = path.join(__dirname, 'public', 'app', 'index.html');
    return fs.existsSync(entry) ? res.sendFile(entry) : next();
  });

  if (product) {
    app.use('/api/v1', createProductRouter({
      platform: product,
      cookieName: productCookieName,
      secureCookies: Boolean(secureProductCookies),
    }));
  }

  // The original single-user operations API contains global notes, sources and model settings.
  // In product mode it is a separate admin surface; public users only use /api/v1.
  if (product && legacyAdminOnly) {
    app.use('/api', (req, res, next) => {
      const protectedPath = req.path === '/jobs' || req.path.startsWith('/jobs/') ||
        req.path === '/backup.xlsx' || req.path === '/cloud' || req.path.startsWith('/cloud/');
      if (!protectedPath) return next();
      const user = productUserFromRequest(req);
      if (!user) return res.status(401).json({ ok: false, error: '请先登录产品管理员账户', code: 'PRODUCT_ADMIN_REQUIRED', loginUrl: publicPath(productBase, 'login') });
      if (user.role !== 'admin') return res.status(403).json({ ok: false, error: '仅产品管理员可访问运营接口', code: 'PRODUCT_ADMIN_REQUIRED' });
      req.productUser = user;
      return next();
    });
  }

  app.get('/api/health', (req, res) => {
    const jobs = service.snapshot().jobs;
    res.json({
      ok: true,
      time: nowIso(),
      jobs: jobs.filter(job => job.active !== '0').length,
      storedJobs: jobs.length,
      cloud: Boolean(cloud),
      product: Boolean(product),
      editPasswordRequired: Boolean(editPassword),
      aiEditPasswordRequired: true,
      aiEditPasswordConfigured: Boolean(aiEditPassword),
    });
  });

  app.get('/api/jobs', (req, res) => {
    const snapshot = service.snapshot();
    let jobs = req.query.includeInactive === '1' ? snapshot.jobs.slice() : snapshot.jobs.filter(job => job.active !== '0');
    const query = String(req.query.q || '').trim().toLowerCase();
    if (query) jobs = jobs.filter(job => [job.company, job.position, job.location, job.industry].some(value => String(value || '').toLowerCase().includes(query)));
    if (req.query.status) jobs = jobs.filter(job => job.status === req.query.status);
    if (req.query.classification) jobs = jobs.filter(job => (job.classification || job.source) === req.query.classification);
    if (req.query.priority) jobs = jobs.filter(job => String(job.priority || '').includes(String(req.query.priority)));
    if (req.query.custom === '1') jobs = jobs.filter(job => job.isCustom === '1' || job.source === '自选');
    const total = jobs.length;
    const offset = Math.max(0, Number(req.query.offset) || 0);
    const limit = req.query.limit === undefined ? total : Math.max(1, Math.min(2000, Number(req.query.limit) || 200));
    jobs = jobs.slice(offset, offset + limit);
    if (cloud) jobs = cloud.enrichJobs(jobs);
    res.json({ jobs, total, offset, limit, meta: snapshot.meta, updatedAt: nowIso() });
  });

  app.get('/api/jobs/stats', (req, res) => {
    const jobs = service.snapshot().jobs.filter(job => job.active !== '0');
    const count = predicate => jobs.filter(predicate).length;
    res.json({
      ok: true,
      total: jobs.length,
      custom: count(job => job.isCustom === '1' || job.source === '自选'),
      fit: count(job => (job.classification || job.source) === '符合条件'),
      tryable: count(job => (job.classification || job.source) === '可试试'),
      applied: count(job => job.status === '已投递'),
      ongoing: count(job => ['笔试', '一面', '二面'].includes(job.status)),
      offer: count(job => job.status === 'offer'),
    });
  });

  app.get('/api/backup.xlsx', (req, res) => {
    const token = parseBearer(req.headers.authorization || '');
    if (!syncToken || !safeEqual(token, syncToken)) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const backupPath = path.join(service.paths.jobsFile, '..', 'jobs-backup.xlsx');
    if (!fs.existsSync(backupPath)) return res.status(404).json({ ok: false, error: '备份尚未生成（等待每日定时任务）' });
    res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.set('Content-Disposition', 'attachment; filename="jobs-backup.xlsx"');
    res.sendFile(path.resolve(backupPath));
  });

  app.post('/api/jobs/:id/status', editJson, (req, res, next) => {
    try {
      if (!isPlainObject(req.body)) throw new InputError('请求体必须是 JSON 对象');
      if (!authorizeEdit(req, res)) return;
      const result = service.applyWebEdit(req.params.id, req.body);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/jobs', editJson, (req, res, next) => {
    try {
      if (!isPlainObject(req.body)) throw new InputError('请求体必须是 JSON 对象');
      if (!authorizeEdit(req, res)) return;
      const result = service.applyCustomAdd(req.body);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.delete('/api/jobs/:id', editJson, (req, res, next) => {
    try {
      if (!isPlainObject(req.body)) throw new InputError('请求体必须是 JSON 对象');
      if (!authorizeEdit(req, res)) return;
      const result = service.applyCustomDelete(req.params.id);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.post('/api/jobs/:id/mark-custom', editJson, (req, res, next) => {
    try {
      if (!isPlainObject(req.body)) throw new InputError('请求体必须是 JSON 对象');
      if (!authorizeEdit(req, res)) return;
      const result = service.applyMarkCustom(req.params.id);
      return res.status(result.ok ? 200 : 400).json(result);
    } catch (error) {
      return next(error);
    }
  });

  app.use('/api/cloud', (req, res, next) => {
    if (!cloud) return res.status(503).json({ ok: false, error: '云端采集尚未启用' });
    return next();
  });

  app.get('/api/cloud/overview', (req, res, next) => {
    try { return res.json({ ok: true, ...cloud.overview() }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/ai', (req, res, next) => {
    try { return res.json({ ok: true, ...cloud.aiDashboard() }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/ai/settings', (req, res, next) => {
    try { return res.json({ ok: true, settings: cloud.getAiSettings() }); } catch (error) { return next(error); }
  });

  app.put('/api/cloud/ai/settings', cloudJson, (req, res, next) => {
    try {
      if (!authorizeAiEdit(req, res)) return;
      const { password, aiPassword, ...input } = req.body;
      return res.json({ ok: true, settings: cloud.updateAiSettings(input) });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/ai/test', cloudJson, async (req, res, next) => {
    try {
      if (!authorizeAiEdit(req, res)) return;
      const { password, aiPassword, ...overrides } = req.body;
      return res.json({ ok: true, result: await cloud.testAiConnection(overrides) });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/ai/run', cloudJson, (req, res, next) => {
    try {
      if (!authorizeAiEdit(req, res)) return;
      const { password, aiPassword, ...input } = req.body;
      return res.status(202).json({ ok: true, ...cloud.enqueueAi(input, 'manual-ai') });
    } catch (error) { return next(error); }
  });

  app.get('/api/cloud/ai/runs', (req, res, next) => {
    try { return res.json({ ok: true, runs: cloud.listAiRuns({ limit: req.query.limit }) }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/ai/assessments', (req, res, next) => {
    try { return res.json({ ok: true, assessments: cloud.listAiAssessments() }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/sources', (req, res, next) => {
    try { return res.json({ ok: true, sources: cloud.listSources() }); } catch (error) { return next(error); }
  });

  app.post('/api/cloud/sources', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const { password, ...input } = req.body;
      return res.status(201).json({ ok: true, source: cloud.createSource(input) });
    } catch (error) { return next(error); }
  });

  app.put('/api/cloud/sources/:id', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const { password, ...input } = req.body;
      const source = cloud.updateSource(req.params.id, input);
      return source ? res.json({ ok: true, source }) : res.status(404).json({ ok: false, error: '信息源不存在' });
    } catch (error) { return next(error); }
  });

  app.delete('/api/cloud/sources/:id', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const archived = cloud.archiveSource(req.params.id);
      return archived ? res.json({ ok: true }) : res.status(404).json({ ok: false, error: '信息源不存在' });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/sources/:id/run', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const allowAutoAi = sourceRunAllowsAutoAi(req, res);
      if (allowAutoAi === null) return;
      return res.status(202).json({ ok: true, ...cloud.enqueueSource(req.params.id, 'manual', { allowAutoAi }) });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/run-all', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const allowAutoAi = sourceRunAllowsAutoAi(req, res);
      if (allowAutoAi === null) return;
      return res.status(202).json({ ok: true, runs: cloud.enqueueAll('manual-all', { allowAutoAi }) });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/reconcile', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      return res.json({ ok: true, ...cloud.reconcileJobs({ dryRun: req.body?.dryRun === true }) });
    } catch (error) { return next(error); }
  });

  app.get('/api/cloud/runs', (req, res, next) => {
    try { return res.json({ ok: true, runs: cloud.listRuns({ limit: req.query.limit, sourceId: req.query.sourceId || '' }) }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/notifications', (req, res, next) => {
    try { return res.json({ ok: true, notifications: cloud.listNotifications(req.query.limit) }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/research', (req, res, next) => {
    try { return res.json({ ok: true, results: cloud.listResearch({ limit: req.query.limit, company: req.query.company || '' }) }); } catch (error) { return next(error); }
  });

  app.post('/api/cloud/daily-check', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      return res.status(202).json({ ok: true, ...cloud.enqueueSystem('daily-check') });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/research', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      return res.status(202).json({ ok: true, ...cloud.enqueueSystem('research') });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/sources/:id/login', cloudJson, async (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      return res.json({ ok: true, ...(await cloud.startLogin(req.params.id)) });
    } catch (error) { return next(error); }
  });

  app.get('/api/cloud/sources/:id/login', async (req, res, next) => {
    try { return res.json({ ok: true, ...(await cloud.loginStatus(req.params.id)) }); } catch (error) { return next(error); }
  });

  app.get('/api/cloud/sources/:id/login.png', async (req, res, next) => {
    try {
      const screenshot = await cloud.loginScreenshot(req.params.id);
      if (!screenshot) return res.status(404).end();
      res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
      return res.send(screenshot);
    } catch (error) { return next(error); }
  });

  app.delete('/api/cloud/sources/:id/login', cloudJson, async (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      await cloud.closeLogin(req.params.id);
      return res.json({ ok: true });
    } catch (error) { return next(error); }
  });

  app.post('/api/cloud/export.xlsx', cloudJson, (req, res, next) => {
    try {
      if (!authorizeEdit(req, res)) return;
      const { buildJobsWorkbook } = require('./cloud/export');
      const buffer = buildJobsWorkbook(service.snapshot().jobs, cloud.listSources(), cloud.listRuns({ limit: 200 }));
      res.set({
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename="job-tracker-cloud.xlsx"',
      });
      return res.send(buffer);
    } catch (error) { return next(error); }
  });

  app.post('/api/sync', syncJson, (req, res, next) => {
    try {
      if (!legacySyncEnabled) return res.status(410).json({ ok: false, error: '旧同步接口已停用，请使用云端信息源' });
      const key = requestKey(req);
      const retryAfter = syncLimiter.retryAfter(key);
      if (retryAfter) {
        res.set('Retry-After', String(retryAfter));
        return res.status(429).json({ ok: false, error: 'too many attempts' });
      }
      const token = parseBearer(req.headers.authorization);
      if (!syncToken || !safeEqual(token, syncToken)) {
        syncLimiter.fail(key);
        return res.status(401).json({ ok: false, error: 'unauthorized' });
      }
      syncLimiter.clear(key);
      const result = service.applySync(req.body);
      return res.json({ ok: true, ...result });
    } catch (error) {
      return next(error);
    }
  });

  app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not found' }));
  app.use((error, req, res, next) => { // eslint-disable-line no-unused-vars
    if (error?.type === 'entity.too.large') return res.status(413).json({ ok: false, error: '请求体过大' });
    if (error?.type === 'entity.parse.failed' || error instanceof SyntaxError) {
      return res.status(400).json({ ok: false, error: '请求 JSON 无效' });
    }
    if (error instanceof InputError || (Number.isInteger(error?.statusCode) && error.statusCode >= 400 && error.statusCode < 500)) {
      return res.status(error.statusCode || 400).json({ ok: false, error: error.message });
    }
    if (error?.name === 'AiApiError') return res.status(error.statusCode || 502).json({ ok: false, error: error.message });
    console.error('request failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: '服务器存储失败' });
  });
  return app;
}

function parsePort(value) {
  const text = value === undefined || value === '' ? String(DEFAULT_PORT) : String(value);
  if (!/^\d+$/.test(text)) throw new Error('PORT 必须是 1-65535 的整数');
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是 1-65535 的整数');
  return port;
}

function parseBindHost(value) {
  const host = String(value || '').trim();
  if (!host) return '';
  const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
  if (!net.isIP(host) && !hostname.test(host)) throw new Error('BIND_HOST 必须是有效的 IP 地址或主机名');
  return host;
}

function checkConfiguredSecret(name, value) {
  if (!value) return;
  if (PLACEHOLDER_SECRETS.has(value.trim().toLowerCase())) throw new Error(`${name} 仍是示例值，拒绝启动`);
  if (Buffer.byteLength(value, 'utf8') < 12) console.warn(`WARNING: ${name} 建议至少 12 字节并使用随机值`);
}

function productBootstrapRoles(env = process.env) {
  const roles = {};
  const add = (value, role) => {
    for (const email of String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean)) roles[email] = role;
  };
  add(env.PRODUCT_CONTENT_EDITOR_EMAILS, 'content_editor');
  add(env.PRODUCT_ADMIN_EMAILS, 'admin');
  return roles;
}

function startServer() {
  const port = parsePort(process.env.PORT);
  const bindHost = parseBindHost(process.env.BIND_HOST);
  const syncToken = process.env.SYNC_TOKEN || '';
  const editPassword = process.env.EDIT_PASSWORD || '';
  const productBootstrapToken = process.env.PRODUCT_BOOTSTRAP_TOKEN || '';
  const aiEditPassword = process.env.AI_EDIT_PASSWORD || '';
  checkConfiguredSecret('SYNC_TOKEN', syncToken);
  checkConfiguredSecret('EDIT_PASSWORD', editPassword);
  checkConfiguredSecret('PRODUCT_BOOTSTRAP_TOKEN', productBootstrapToken);
  checkConfiguredSecret('AI_EDIT_PASSWORD', aiEditPassword);
  const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : DEFAULT_DATA_DIR;
  const service = createService({ dataDir });
  service.load();
  const product = new ProductPlatform({
    dataDir,
    jobService: service,
    bootstrapRoles: productBootstrapRoles(process.env),
    bootstrapToken: productBootstrapToken,
  }).initialize();
  const replayedAliases = product.replayPendingJobAliases();
  if (replayedAliases.length) console.log(`replayed ${replayedAliases.length} pending product alias remap(s)`);
  const cloud = new CloudRuntime({
    dataDir,
    jobService: service,
    onJobAliases: {
      prepare: aliases => product.prepareJobAliases(aliases),
      apply: (aliases, intentId) => intentId ? product.applyPreparedJobAliases(intentId) : product.remapJobAliases(aliases),
    },
  });
  cloud.initialize({ startScheduler: process.env.CLOUD_SCHEDULER !== '0' });
  product.cloud = cloud;
  const legacySyncEnabled = process.env.LEGACY_SYNC_ENABLED === '1';
  const app = createApp({ service, cloud, product, syncToken, editPassword, aiEditPassword, legacySyncEnabled });
  const onListening = () => {
    console.log(`job-tracker listening on ${bindHost || '*'}:${port} (jobs=${service.snapshot().jobs.length}, syncToken=${syncToken ? 'set' : 'MISSING'}, editPassword=${editPassword ? 'set' : 'MISSING'}, aiEditPassword=${aiEditPassword ? 'set' : 'MISSING'}, legacySync=${legacySyncEnabled ? 'enabled' : 'disabled'})`);
    if (!syncToken) console.warn('WARNING: SYNC_TOKEN 未设置，/api/sync 将拒绝所有请求');
    if (!editPassword) console.log('EDIT_PASSWORD 未设置：网页与 jobctl 写操作无需密码');
    if (!aiEditPassword) console.warn('WARNING: AI_EDIT_PASSWORD 未设置，AI 配置、测试和运行接口已禁用');
  };
  const server = bindHost ? app.listen(port, bindHost, onListening) : app.listen(port, onListening);
  return { app, server, service, cloud, product };
}

if (require.main === module) {
  try {
    const runtime = startServer();
    let stopping = false;
    const stop = async signal => {
      if (stopping) return;
      stopping = true;
      console.log(`${signal} received; waiting for active cloud task to finish`);
      runtime.cloud.stopScheduler();
      const closed = new Promise(resolve => runtime.server.close(resolve));
      const timeout = setTimeout(() => {
        console.error('graceful shutdown timed out');
        process.exit(1);
      }, 160_000);
      timeout.unref?.();
      await runtime.cloud.waitForIdle(150_000).catch(error => console.error(error.message));
      await runtime.cloud.shutdown().catch(error => console.error(`cloud shutdown failed: ${error.message}`));
      runtime.product.close();
      await closed;
      clearTimeout(timeout);
      process.exit(0);
    };
    process.once('SIGTERM', () => { stop('SIGTERM'); });
    process.once('SIGINT', () => { stop('SIGINT'); });
  } catch (error) {
    console.error(`startup failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  InputError,
  STATUSES,
  INFO_FIELDS,
  STATE_FIELDS,
  safeEqual,
  normalizeIsoTimestamp,
  normalizeCalendarDate,
  validateSyncPayload,
  validateWebEditBody,
  atomicWriteJson,
  createService,
  createApp,
  createFailureLimiter,
  parseBearer,
  parsePort,
  parseBindHost,
  normalizePublicBase,
  productBootstrapRoles,
  startServer,
};
