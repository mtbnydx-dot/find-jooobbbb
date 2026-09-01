/**
 * 秋招本地同步脚本
 * 流程：读 Excel → 全量推送 → 拉回服务器状态 → 安全写回 Excel
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const XLSX = require('xlsx');

const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..');
const EXCEL = path.join(WORKSPACE_ROOT, '秋招投递追踪表.xlsx');
const SHEET = '投递追踪';
const CONFIG = path.join(__dirname, 'config.json');
const LAST_PUSH = path.join(__dirname, '.last_push.json');
const PENDING_PUSH = path.join(__dirname, '.last_push.pending.json');
const LOCK_FILE = path.join(__dirname, '.sync.lock');
const STATUSES = Object.freeze(['未投递', '已投递', '笔试', '一面', '二面', 'offer', '挂']);
const STALE_DAYS = 14;
const DDL_REMINDER_DAYS = new Set([7, 3, 1]);
const FETCH_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_JOBS = 5000;

const COLUMNS = Object.freeze([
  ['id', '_id'],
  ['source', '来源'],
  ['priority', '优先级'],
  ['matchDir', '匹配方向'],
  ['company', '公司名称'],
  ['nature', '企业性质'],
  ['industry', '行业大类'],
  ['position', '招聘岗位'],
  ['location', '工作地点'],
  ['deadline', '截止时间'],
  ['exam', '是否需要笔试'],
  ['url', '投递方式'],
  ['notice', '官方公告'],
  ['status', '投递状态'],
  ['appliedAt', '投递日期'],
  ['statusUpdatedAt', '状态更新时间'],
  ['note', '备注'],
  ['ddlRemind', 'DDL提醒'],
]);

function log(...args) { console.log(...args); }
function nowIso(nowMs = Date.now()) { return new Date(nowMs).toISOString(); }
function pad(value) { return String(value).padStart(2, '0'); }
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function isBlank(value) { return value === undefined || value === null || String(value).trim() === ''; }

function decodeTextFile(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) return buffer.subarray(3).toString('utf8');
  return buffer.toString('utf8').replace(/^\uFEFF/, '');
}

function readJsonFile(file, { optional = false } = {}) {
  try {
    return JSON.parse(decodeTextFile(file));
  } catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error(`${path.basename(file)} 不是有效 JSON`);
    throw error;
  }
}

function writeFileDurably(file, text) {
  const descriptor = fs.openSync(file, 'w', 0o600);
  try {
    fs.writeFileSync(descriptor, text, 'utf8');
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
    // Windows 不支持目录 fsync；同目录 rename 仍避免暴露半个 JSON。
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function atomicWriteJson(file, value, { backupCurrent = true } = {}) {
  const directory = path.dirname(file);
  const temporary = `${file}.tmp`;
  const backup = `${file}.bak`;
  const backupTemporary = `${backup}.tmp`;
  fs.mkdirSync(directory, { recursive: true });
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

function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

function acquireSyncLock(lockFile = LOCK_FILE) {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  for (let attempt = 0; attempt < 2; attempt++) {
    let descriptor;
    let created = false;
    try {
      descriptor = fs.openSync(lockFile, 'wx', 0o600);
      created = true;
      const record = `${JSON.stringify({ pid: process.pid, startedAt: nowIso(), nonce })}\n`;
      fs.writeFileSync(descriptor, record, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      return () => {
        try {
          const current = JSON.parse(decodeTextFile(lockFile));
          if (current.nonce === nonce) fs.rmSync(lockFile, { force: true });
        } catch (_) { /* 不删除无法确认归属的锁 */ }
      };
    } catch (error) {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (error.code !== 'EEXIST') {
        if (created) try { fs.rmSync(lockFile, { force: true }); } catch (_) { /* best effort */ }
        throw error;
      }
      let existing;
      try { existing = JSON.parse(decodeTextFile(lockFile)); } catch (_) {
        throw new Error(`同步锁无效，请确认没有同步进程后手工删除: ${lockFile}`);
      }
      if (processIsRunning(existing.pid)) throw new Error(`另一个同步进程正在运行（PID ${existing.pid}）`);
      try { fs.rmSync(lockFile); } catch (removeError) {
        throw new Error(`无法清理崩溃遗留的同步锁: ${removeError.message}`);
      }
    }
  }
  throw new Error('无法获取同步锁');
}

function parseCalendarText(value, field, { allowText = false } = {}) {
  const text = String(value == null ? '' : value).trim();
  if (!text) return '';
  const match = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(text);
  if (!match) {
    if (allowText && !/^\d{4}[/-]/.test(text)) return text;
    throw new Error(`${field} 不是有效日期: ${text}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    throw new Error(`${field} 不是有效日期: ${text}`);
  }
  return `${year}/${pad(month)}/${pad(day)}`;
}

function excelSerialParts(value, date1904, field) {
  const parts = XLSX.SSF.parse_date_code(Number(value), { date1904: Boolean(date1904) });
  if (!parts) throw new Error(`${field} 含非法 Excel 日期序列号: ${value}`);
  const date = new Date(Date.UTC(parts.y, parts.m - 1, parts.d));
  if (date.getUTCFullYear() !== parts.y || date.getUTCMonth() !== parts.m - 1 || date.getUTCDate() !== parts.d) {
    throw new Error(`${field} 含 Excel 不可表示的日历日期: ${value}`);
  }
  return parts;
}

function calendarCellToText(value, field, { date1904 = false, allowText = false } = {}) {
  if (isBlank(value)) return '';
  if (typeof value === 'number') {
    const parts = excelSerialParts(value, date1904, field);
    return `${parts.y}/${pad(parts.m)}/${pad(parts.d)}`;
  }
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${field} 不是有效日期`);
    return `${value.getFullYear()}/${pad(value.getMonth() + 1)}/${pad(value.getDate())}`;
  }
  return parseCalendarText(value, field, { allowText });
}

function localPartsToIso(parts, field) {
  const date = new Date(parts.y, parts.m - 1, parts.d, parts.H || 0, parts.M || 0, Math.floor(parts.S || 0), 0);
  if (date.getFullYear() !== parts.y || date.getMonth() !== parts.m - 1 || date.getDate() !== parts.d ||
      date.getHours() !== (parts.H || 0) || date.getMinutes() !== (parts.M || 0)) {
    throw new Error(`${field} 不是有效本地时间`);
  }
  return date.toISOString();
}

function normalizeTimestamp(value, field, { date1904 = false, nowMs = Date.now(), allowFuture = false } = {}) {
  if (isBlank(value)) return '';
  let result;
  if (typeof value === 'number') {
    result = localPartsToIso(excelSerialParts(value, date1904, field), field);
  } else if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error(`${field} 不是有效时间`);
    result = value.toISOString();
  } else {
    const text = String(value).trim();
    const explicit = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(text);
    if (explicit) {
      const timestamp = Date.parse(text);
      if (!Number.isFinite(timestamp)) throw new Error(`${field} 不是有效 ISO 时间: ${text}`);
      const calendar = parseCalendarText(`${explicit[1]}/${explicit[2]}/${explicit[3]}`, field);
      if (!calendar || Number(explicit[4]) > 23 || Number(explicit[5]) > 59 || Number(explicit[6]) > 59) {
        throw new Error(`${field} 不是有效 ISO 时间: ${text}`);
      }
      result = new Date(timestamp).toISOString();
    } else {
      const legacy = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(text);
      if (!legacy) throw new Error(`${field} 必须是带时区 ISO 时间或本地日期时间: ${text}`);
      const parts = {
        y: Number(legacy[1]), m: Number(legacy[2]), d: Number(legacy[3]),
        H: Number(legacy[4] || 0), M: Number(legacy[5] || 0), S: Number(legacy[6] || 0),
      };
      result = localPartsToIso(parts, field);
    }
  }
  const timestamp = Date.parse(result);
  if (timestamp < Date.UTC(2000, 0, 1)) throw new Error(`${field} 早于支持范围`);
  if (!allowFuture && timestamp > nowMs + 24 * 60 * 60 * 1000) throw new Error(`${field} 超出允许的未来时间`);
  return result;
}

function daysUntil(deadline, nowMs = Date.now()) {
  const text = parseCalendarText(deadline, '截止时间', { allowText: true });
  const match = /^(\d{4})\/(\d{2})\/(\d{2})$/.exec(text);
  if (!match) return null;
  const now = new Date(nowMs);
  const target = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((target - today) / 86400000);
}

function daysSince(timestamp, nowMs = Date.now()) {
  if (!timestamp) return null;
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return null;
  return Math.floor((nowMs - parsed) / 86400000);
}

function buildHeaderMap(header) {
  if (!Array.isArray(header)) throw new Error('Excel 缺少表头行');
  const indices = new Map();
  header.forEach((value, index) => {
    const name = String(value == null ? '' : value).replace(/^\uFEFF/, '').trim();
    if (!name) return;
    if (indices.has(name)) throw new Error(`Excel 表头重复: ${name}`);
    indices.set(name, index);
  });
  const map = {};
  for (const [field, headerName] of COLUMNS) {
    if (!indices.has(headerName)) throw new Error(`Excel 缺少列: ${headerName}`);
    map[field] = indices.get(headerName);
  }
  return map;
}

function fingerprintFile(file) {
  const stat = fs.statSync(file);
  const digest = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  return { size: stat.size, mtimeMs: stat.mtimeMs, digest };
}

function sameFingerprint(first, second) {
  return first.size === second.size && first.mtimeMs === second.mtimeMs && first.digest === second.digest;
}

function cellDisplayValue(worksheet, row, column, fallback) {
  const cell = worksheet[XLSX.utils.encode_cell({ r: row, c: column })];
  if (!cell) return fallback;
  if (cell.t === 'n') return XLSX.utils.format_cell(cell);
  return cell.v;
}

function scalarText(value, field) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${field} 必须是标量值`);
  const text = String(value).trim();
  if (text.includes('\0')) throw new Error(`${field} 含非法字符`);
  if (Buffer.byteLength(text, 'utf8') > 8192) throw new Error(`${field} 过长`);
  return text;
}

function readExcel(excelPath = EXCEL, nowMs = Date.now()) {
  if (!fs.existsSync(excelPath)) throw new Error(`找不到 Excel: ${excelPath}`);
  const before = fingerprintFile(excelPath);
  let workbook;
  try {
    workbook = XLSX.readFile(excelPath, { cellDates: false, cellNF: true });
  } catch (error) {
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) throw new Error('Excel 文件正被占用，请关闭后重试');
    throw error;
  }
  const after = fingerprintFile(excelPath);
  if (!sameFingerprint(before, after)) throw new Error('Excel 在读取期间发生变化，请重试');
  const worksheet = workbook.Sheets[SHEET];
  if (!worksheet) throw new Error(`Excel 中没有 sheet: ${SHEET}`);
  const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '', raw: true, blankrows: true });
  const map = buildHeaderMap(rows[0]);
  const date1904 = Boolean(workbook.Workbook?.WBProps?.date1904);
  const jobs = [];
  const originalStates = new Map();
  const ids = new Map();

  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex];
    if (!Array.isArray(row)) continue;
    const rawId = cellDisplayValue(worksheet, rowIndex, map.id, row[map.id]);
    if (isBlank(rawId)) continue;
    const id = scalarText(rawId, `第 ${rowIndex + 1} 行 _id`);
    if (!/^[\p{L}\p{N}._:-]+$/u.test(id)) throw new Error(`第 ${rowIndex + 1} 行 _id 格式非法`);
    if (ids.has(id)) throw new Error(`Excel _id 重复: ${id}（第 ${ids.get(id)}、${rowIndex + 1} 行）`);
    ids.set(id, rowIndex + 1);

    const status = scalarText(row[map.status] || '未投递', `第 ${rowIndex + 1} 行投递状态`) || '未投递';
    if (!STATUSES.includes(status)) throw new Error(`第 ${rowIndex + 1} 行投递状态非法: ${status}`);
    const job = {
      id,
      source: scalarText(row[map.source], '来源'),
      priority: scalarText(row[map.priority], '优先级'),
      matchDir: scalarText(row[map.matchDir], '匹配方向'),
      company: scalarText(row[map.company], '公司名称'),
      nature: scalarText(row[map.nature], '企业性质'),
      industry: scalarText(row[map.industry], '行业大类'),
      position: scalarText(row[map.position], '招聘岗位'),
      location: scalarText(row[map.location], '工作地点'),
      deadline: calendarCellToText(row[map.deadline], `第 ${rowIndex + 1} 行截止时间`, { date1904, allowText: true }),
      exam: scalarText(row[map.exam], '是否需要笔试'),
      url: scalarText(row[map.url], '投递方式'),
      notice: scalarText(row[map.notice], '官方公告'),
      status,
      appliedAt: calendarCellToText(row[map.appliedAt], `第 ${rowIndex + 1} 行投递日期`, { date1904 }),
      statusUpdatedAt: normalizeTimestamp(row[map.statusUpdatedAt], `第 ${rowIndex + 1} 行状态更新时间`, { date1904, nowMs }),
      note: scalarText(row[map.note], '备注'),
      ddlRemind: scalarText(row[map.ddlRemind], 'DDL提醒'),
      _rowIdx: rowIndex,
    };
    jobs.push(job);
    originalStates.set(id, stateFromJob(job));
  }
  return { workbook, worksheet, rows, map, jobs, originalStates, fingerprint: after, excelPath };
}

function normalizeCheckpoint(raw, name, nowMs = Date.now()) {
  if (raw === null) return {};
  if (!isPlainObject(raw)) throw new Error(`${name} 结构非法`);
  const result = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isPlainObject(value)) throw new Error(`${name} 中 ${id} 结构非法`);
    const status = scalarText(value.status || '未投递', `${name}.${id}.status`) || '未投递';
    if (!STATUSES.includes(status)) throw new Error(`${name} 中 ${id} 状态非法`);
    result[id] = {
      status,
      appliedAt: calendarCellToText(value.appliedAt, `${name}.${id}.appliedAt`),
      statusUpdatedAt: normalizeTimestamp(value.statusUpdatedAt, `${name}.${id}.statusUpdatedAt`, { nowMs }),
      note: scalarText(value.note, `${name}.${id}.note`),
      time: value.time ? normalizeTimestamp(value.time, `${name}.${id}.time`, { nowMs, allowFuture: true }) : '',
    };
  }
  return result;
}

function loadCheckpoints(nowMs = Date.now()) {
  const committed = normalizeCheckpoint(readJsonFile(LAST_PUSH, { optional: true }), path.basename(LAST_PUSH), nowMs);
  const pending = normalizeCheckpoint(readJsonFile(PENDING_PUSH, { optional: true }), path.basename(PENDING_PUSH), nowMs);
  return { committed, pending };
}

function sameState(entry, job) {
  return Boolean(entry) && entry.status === job.status && entry.appliedAt === job.appliedAt && entry.note === job.note;
}

function stateFromJob(job) {
  return {
    status: job.status,
    appliedAt: job.appliedAt,
    statusUpdatedAt: job.statusUpdatedAt,
    note: job.note,
  };
}

function checkpointSnapshot(jobs, time = nowIso()) {
  const snapshot = {};
  for (const job of jobs) snapshot[job.id] = { ...stateFromJob(job), time };
  return snapshot;
}

function meaningfulState(job) {
  return job.status !== '未投递' || Boolean(job.appliedAt) || Boolean(job.note);
}

function localCalendarDate(nowMs) {
  const date = new Date(nowMs);
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())}`;
}

function markLocalChanges(jobs, checkpoints = { committed: {}, pending: {} }, nowMs = Date.now()) {
  const timestamp = nowIso(nowMs);
  const snapshot = {};
  let timestamped = 0;
  for (const job of jobs) {
    const pending = checkpoints.pending[job.id];
    const committed = checkpoints.committed[job.id];
    const baseline = sameState(pending, job) ? pending : committed;
    const changed = baseline ? !sameState(baseline, job) : meaningfulState(job);

    if (changed && job.status === '已投递' && !job.appliedAt) job.appliedAt = localCalendarDate(nowMs);
    if (changed && (!job.statusUpdatedAt || job.statusUpdatedAt === baseline?.statusUpdatedAt || job.statusUpdatedAt === pending?.statusUpdatedAt)) {
      job.statusUpdatedAt = timestamp;
      timestamped++;
    } else if (!changed && !job.statusUpdatedAt && baseline?.statusUpdatedAt) {
      job.statusUpdatedAt = baseline.statusUpdatedAt;
    }

    snapshot[job.id] = { ...stateFromJob(job), time: timestamp };
  }
  return { timestamped, snapshot };
}

function stageCheckpoint(snapshot) {
  atomicWriteJson(PENDING_PUSH, snapshot);
}

function commitCheckpoint(snapshot) {
  atomicWriteJson(LAST_PUSH, snapshot);
  try { fs.rmSync(PENDING_PUSH, { force: true }); } catch (_) { /* stale pending is safe to reuse */ }
}

function setStringCell(worksheet, row, column, value) {
  const address = XLSX.utils.encode_cell({ r: row, c: column });
  const old = worksheet[address] || {};
  const cell = { ...old, t: 's', v: String(value == null ? '' : value), z: 'General' };
  delete cell.f;
  delete cell.F;
  delete cell.w;
  delete cell.h;
  delete cell.r;
  delete cell.l;
  worksheet[address] = cell;
}

function assertWorkbookUnchanged(excelPath, fingerprint) {
  const current = fingerprintFile(excelPath);
  if (!sameFingerprint(current, fingerprint)) {
    throw new Error('Excel 在同步期间已被修改；为避免覆盖你的新改动，本次未写回，请重新运行');
  }
}

function atomicWriteWorkbook(workbook, excelPath, fingerprint) {
  const directory = path.dirname(excelPath);
  const temporary = path.join(directory, `.${path.basename(excelPath)}.${process.pid}.${Date.now()}.tmp.xlsx`);
  const backup = `${excelPath}.bak`;
  const backupTemporary = `${backup}.tmp`;
  try {
    assertWorkbookUnchanged(excelPath, fingerprint);
    XLSX.writeFile(workbook, temporary, { bookType: 'xlsx', compression: true });
    const descriptor = fs.openSync(temporary, 'r+');
    try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
    const verification = XLSX.readFile(temporary, { bookSheets: true });
    if (!verification.SheetNames.includes(SHEET)) throw new Error(`临时工作簿缺少 sheet: ${SHEET}`);
    assertWorkbookUnchanged(excelPath, fingerprint);
    fs.copyFileSync(excelPath, backupTemporary);
    const backupDescriptor = fs.openSync(backupTemporary, 'r+');
    try { fs.fsyncSync(backupDescriptor); } finally { fs.closeSync(backupDescriptor); }
    fs.renameSync(backupTemporary, backup);
    assertWorkbookUnchanged(excelPath, fingerprint);
    fs.renameSync(temporary, excelPath);
    fsyncDirectory(directory);
  } catch (error) {
    for (const candidate of [temporary, backupTemporary]) {
      try { fs.rmSync(candidate, { force: true }); } catch (_) { /* best effort */ }
    }
    if (['EBUSY', 'EPERM', 'EACCES'].includes(error.code)) {
      throw new Error('Excel 文件正被占用，原文件未修改；请关闭 Excel 后重试');
    }
    throw error;
  }
}

function normalizeServerJobs(rawJobs, nowMs = Date.now()) {
  if (!Array.isArray(rawJobs)) throw new Error('服务器 jobs 不是数组');
  if (rawJobs.length > MAX_JOBS) throw new Error('服务器返回岗位数量超限');
  const ids = new Set();
  return rawJobs.map((raw, index) => {
    if (!isPlainObject(raw)) throw new Error(`服务器 jobs[${index}] 不是对象`);
    const id = scalarText(raw.id, `服务器 jobs[${index}].id`);
    if (!id) throw new Error(`服务器 jobs[${index}].id 为空`);
    if (ids.has(id)) throw new Error(`服务器返回重复 id: ${id}`);
    ids.add(id);
    const status = scalarText(raw.status || '未投递', `服务器 jobs[${index}].status`) || '未投递';
    if (!STATUSES.includes(status)) throw new Error(`服务器返回非法状态: ${status}`);
    return {
      id,
      status,
      appliedAt: calendarCellToText(raw.appliedAt, `服务器 jobs[${index}].appliedAt`),
      statusUpdatedAt: normalizeTimestamp(raw.statusUpdatedAt, `服务器 jobs[${index}].statusUpdatedAt`, { nowMs }),
      note: scalarText(raw.note, `服务器 jobs[${index}].note`),
    };
  });
}

function reconcileJobs(context, serverJobs, webChanges) {
  const byId = new Map(serverJobs.map(job => [job.id, job]));
  let updated = 0;
  for (const localJob of context.jobs) {
    const serverJob = byId.get(localJob.id);
    if (!serverJob) throw new Error(`服务器响应缺少岗位: ${localJob.id}`);
    const localTime = localJob.statusUpdatedAt ? Date.parse(localJob.statusUpdatedAt) : Number.NEGATIVE_INFINITY;
    const serverTime = serverJob.statusUpdatedAt ? Date.parse(serverJob.statusUpdatedAt) : Number.NEGATIVE_INFINITY;
    const stateDiffers = serverJob.status !== localJob.status || serverJob.appliedAt !== localJob.appliedAt || serverJob.note !== localJob.note;
    // 服务端在时间戳相等时保留其现有状态；客户端也采用同一 tie-break，避免永久分叉。
    const serverWins = serverTime > localTime || (serverTime === localTime && stateDiffers);
    const finalState = serverWins ? stateFromJob(serverJob) : stateFromJob(localJob);
    const originalState = context.originalStates?.get(localJob.id) || stateFromJob(localJob);
    const needsWrite = Object.keys(finalState).some(field => finalState[field] !== originalState[field]);
    Object.assign(localJob, finalState);
    if (needsWrite) {
      setStringCell(context.worksheet, localJob._rowIdx, context.map.status, finalState.status || '未投递');
      setStringCell(context.worksheet, localJob._rowIdx, context.map.appliedAt, finalState.appliedAt || '');
      setStringCell(context.worksheet, localJob._rowIdx, context.map.statusUpdatedAt, finalState.statusUpdatedAt || '');
      setStringCell(context.worksheet, localJob._rowIdx, context.map.note, finalState.note || '');
      updated++;
      if (serverWins) webChanges.push({ id: localJob.id, company: localJob.company, status: finalState.status });
    }
  }
  if (byId.size !== context.jobs.length) throw new Error('服务器响应岗位集合与本地全量清单不一致');
  return updated;
}

function writeBackExcel(context, serverJobs, webChanges) {
  const updated = reconcileJobs(context, serverJobs, webChanges);
  if (updated > 0) atomicWriteWorkbook(context.workbook, context.excelPath, context.fingerprint);
  return updated;
}

/* 自选岗位回写：服务器 source=自选 且本地 Excel 无此 id → 追加行；本地 source=自选 但服务器无 → 移除行 */
function reconcileCustomJobs(context, serverJobs) {
  const ws = context.worksheet;
  if (!ws) return { added: 0, removed: 0 };
  const localIds = new Set(context.jobs.map(j => j.id));
  const serverById = new Map(serverJobs.map(j => [j.id, j]));
  let added = 0;
  let removed = 0;

  // 追加：服务器有但本地无的自选岗位
  for (const job of serverJobs) {
    if (job.source !== '自选' || localIds.has(job.id)) continue;
    const rowIndex0 = context.rows.length;
    for (const [key] of COLUMNS) {
      const colIndex = context.map[key];
      if (colIndex === undefined) continue;
      let value = '';
      if (key === 'id') value = job.id;
      else if (key === 'status') value = job.status || '未投递';
      else value = job[key] != null ? String(job[key]) : '';
      setStringCell(ws, rowIndex0, colIndex, value);
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    if (rowIndex0 > range.e.r) { range.e.r = rowIndex0; ws['!ref'] = XLSX.utils.encode_range(range); }
    context.jobs.push({ ...job, _rowIdx: rowIndex0 });
    added++;
  }

  // 标记：本地有但服务器上被标为自选（source 从其他变成自选）→ 更新本地 source 列
  let marked = 0;
  for (const job of context.jobs) {
    if (job.source === '自选') continue;
    const serverJob = serverById.get(job.id);
    if (serverJob && serverJob.source === '自选' && job._rowIdx !== undefined) {
      setStringCell(ws, job._rowIdx, context.map.source, '自选');
      job.source = '自选';
      marked++;
    }
  }

  // 移除：本地有自选但服务器没有（仅清单元格，不改表结构——筛选时不再匹配）
  const removeRowIdxs = context.jobs
    .filter(j => j.source === '自选' && !serverById.has(j.id) && j._rowIdx !== undefined)
    .map(j => j._rowIdx)
    .sort((a, b) => b - a);
  for (const r0 of removeRowIdxs) {
    for (const [key] of COLUMNS) {
      const colIndex = context.map[key];
      if (colIndex === undefined) continue;
      delete ws[XLSX.utils.encode_cell({ r: r0, c: colIndex })];
    }
    removed++;
  }
  if (removed) context.jobs = context.jobs.filter(j => !(j.source === '自选' && !serverById.has(j.id)));
  return { added, removed, marked };
}

function buildReminders(jobs, nowMs = Date.now()) {
  const urgent = [];
  const stale = [];
  for (const job of jobs) {
    const days = daysUntil(job.deadline, nowMs);
    if (days !== null && DDL_REMINDER_DAYS.has(days) && job.status === '未投递') {
      urgent.push({ company: job.company, position: job.position, deadline: job.deadline, days });
    }
    if (['已投递', '笔试', '一面', '二面'].includes(job.status)) {
      const since = daysSince(job.statusUpdatedAt, nowMs);
      if (since !== null && since >= STALE_DAYS) {
        stale.push({ company: job.company, position: job.position, status: job.status, days: since });
      }
    }
  }
  urgent.sort((a, b) => a.days - b.days);
  stale.sort((a, b) => b.days - a.days);
  return { urgent, stale };
}

function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new Error('config.json 必须是 JSON 对象');
  if (typeof raw.serverUrl !== 'string' || typeof raw.syncToken !== 'string' || !raw.serverUrl.trim() || !raw.syncToken) {
    throw new Error('config.json 缺少 serverUrl 或 syncToken');
  }
  let parsed;
  try { parsed = new URL(raw.serverUrl.trim()); } catch (_) { throw new Error('config.json 的 serverUrl 无效'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('serverUrl 只允许 http 或 https');
  const loopbackHost = parsed.hostname === 'localhost' || parsed.hostname.endsWith('.localhost') ||
    /^127(?:\.\d{1,3}){3}$/.test(parsed.hostname) || parsed.hostname === '[::1]';
  if (parsed.protocol === 'http:' && !loopbackHost) throw new Error('非本机 serverUrl 必须使用 https，避免泄露 syncToken');
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error('serverUrl 不能包含凭据、查询参数或片段');
  const serverUrl = parsed.href.replace(/\/+$/, '');
  if (Buffer.byteLength(raw.syncToken, 'utf8') > 4096) throw new Error('syncToken 过长');
  if (/[\0\r\n]/.test(raw.syncToken)) throw new Error('syncToken 含非法控制字符');
  if (raw.syncToken.trim().toLowerCase() === '请改成随机token') throw new Error('syncToken 仍是示例值');
  const result = { serverUrl, syncToken: raw.syncToken };
  if (isPlainObject(raw.tunnel) && typeof raw.tunnel.local === 'string' && typeof raw.tunnel.key === 'string' && typeof raw.tunnel.ssh === 'string') {
    result.tunnel = { local: raw.tunnel.local, key: raw.tunnel.key, ssh: raw.tunnel.ssh };
  }
  return result;
}

async function readResponseBody(response, maxBytes = MAX_RESPONSE_BYTES) {
  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error('服务器响应过大');
  if (!response.body || typeof response.body.getReader !== 'function') {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('服务器响应过大');
    return buffer.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('服务器响应过大');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

async function requestJson(url, options, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, redirect: 'error', signal: controller.signal });
    const text = await readResponseBody(response);
    const contentType = response.headers.get('content-type') || '';
    let data = null;
    if (contentType.toLowerCase().includes('application/json')) {
      try { data = text ? JSON.parse(text) : null; } catch (_) { throw new Error(`${label}返回了无效 JSON`); }
    }
    if (!response.ok) {
      const detail = data && typeof data.error === 'string' ? data.error : text.slice(0, 200);
      throw new Error(`${label}失败 HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
    }
    if (!data || !isPlainObject(data)) throw new Error(`${label}响应不是 JSON 对象`);
    return data;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`请求超时（${FETCH_TIMEOUT_MS / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* 检测 SSH 隧道连通性；断开则自动重建（config.json 需配 tunnel 字段） */
async function ensureTunnel(config) {
  const probe = `${config.serverUrl}/api/health`;
  try {
    const r = await fetch(probe, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return true;
  } catch (_) { /* 隧道断了 */ }
  if (!config.tunnel) return false;
  log('检测到同步通道断开，正在重建 SSH 隧道…');
  try {
    const { spawn } = require('child_process');
    const args = ['-f', '-N', '-L', config.tunnel.local, '-i', config.tunnel.key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', config.tunnel.ssh];
    const child = spawn('ssh', args, { stdio: 'ignore', shell: false });
    child.unref();
    await new Promise(r => setTimeout(r, 2500));
    const r2 = await fetch(probe, { signal: AbortSignal.timeout(4000) });
    if (r2.ok) { log('隧道重建成功。'); return true; }
  } catch (_) { /* 重建失败 */ }
  return false;
}

function validatePushResponse(data, nowMs = Date.now()) {
  if (data.ok !== true) throw new Error('推送响应缺少 ok=true');
  const result = { ...data };
  for (const field of ['inserted', 'updated', 'stateTaken', 'kept', 'deleted', 'received']) {
    if (!Number.isInteger(result[field]) || result[field] < 0) throw new Error(`推送响应 ${field} 非法`);
  }
  result.syncAt = normalizeTimestamp(result.syncAt, '推送响应 syncAt', { nowMs });
  return result;
}

async function runSync(args = process.argv.slice(2)) {
  const asJson = args.includes('--json');
  const dryRun = args.includes('--check');
  const nowMs = Date.now();
  const context = readExcel(EXCEL, nowMs);
  if (!context.jobs.length) throw new Error('Excel 中没有有效数据');

  const { urgent, stale } = buildReminders(context.jobs, nowMs);

  if (dryRun) {
    const output = { dryRun: true, total: context.jobs.length, urgent, stale };
    log(asJson ? JSON.stringify(output) : `干跑完成：共 ${context.jobs.length} 条；紧急 ${urgent.length} 条；停滞 ${stale.length} 条`);
    return output;
  }

  const checkpoints = loadCheckpoints(nowMs);
  const localChanges = markLocalChanges(context.jobs, checkpoints, nowMs);
  if (!fs.existsSync(CONFIG)) throw new Error('缺少配置文件 local/config.json（从 config.example.json 复制并填写）');
  const config = validateConfig(readJsonFile(CONFIG));
  // 隧道断了自动重建（config.json 配了 tunnel 字段时）
  if (!(await ensureTunnel(config))) {
    throw new Error('同步通道不可用（服务器不可达且隧道重建失败）');
  }
  const pushBody = { jobs: context.jobs.map(({ _rowIdx, ...job }) => job), syncAt: nowIso(nowMs) };
  stageCheckpoint(localChanges.snapshot);

  const pushData = await requestJson(`${config.serverUrl}/api/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.syncToken}` },
    body: JSON.stringify(pushBody),
  }, '推送');
  const push = validatePushResponse(pushData);

  const getData = await requestJson(`${config.serverUrl}/api/jobs`, { method: 'GET' }, '拉取');
  const serverJobs = normalizeServerJobs(getData.jobs);
  const webChanges = [];
  const written = reconcileJobs(context, serverJobs, webChanges);
  const custom = reconcileCustomJobs(context, serverJobs);
  const finalSnapshot = checkpointSnapshot(context.jobs);
  // 先把最终胜出状态放入 pending；即使之后 Excel 或 committed 写入失败，下次也不会把旧状态误判成新改动。
  stageCheckpoint(finalSnapshot);
  if (written > 0 || custom.added > 0 || custom.removed > 0 || custom.marked > 0) atomicWriteWorkbook(context.workbook, context.excelPath, context.fingerprint);
  commitCheckpoint(finalSnapshot);

  const summary = {
    total: context.jobs.length,
    pushedAt: push.syncAt,
    push: { inserted: push.inserted, updated: push.updated, stateTaken: push.stateTaken, kept: push.kept, deleted: push.deleted },
    localChanged: localChanges.timestamped,
    webChanges,
    writtenBack: written,
    customAdded: custom.added,
    customRemoved: custom.removed,
    customMarked: custom.marked || 0,
    urgent,
    stale,
  };

  if (asJson) {
    log(JSON.stringify(summary));
  } else {
    log('=== 秋招同步完成 ===');
    log(`共 ${summary.total} 条岗位，推送于 ${summary.pushedAt}`);
    log(`推送: 新增 ${push.inserted}，信息更新 ${push.updated}，本地状态变更补录 ${summary.localChanged}，本地较新状态采用 ${push.stateTaken}，删除 ${push.deleted}`);
    if (written > 0) {
      log(`Excel 状态字段已安全写回 ${written} 条。`);
    }
    if (custom.added > 0 || custom.removed > 0 || custom.marked > 0) {
      log(`自选岗位：新增 ${custom.added} 条，标记 ${custom.marked || 0} 条，移除 ${custom.removed} 条。`);
    }
    if (webChanges.length > 0) {
      log(`其中网页端较新改动 ${webChanges.length} 条:`);
      for (const change of webChanges) log(`  - ${change.company}: ${change.status}`);
    } else {
      log('网页端无新改动');
    }
    if (urgent.length) {
      log('\n⚠️ 截止提醒（未投递）:');
      for (const item of urgent) log(`  - ${item.company}（${item.position}）剩 ${item.days} 天，截止 ${item.deadline}`);
    }
    if (stale.length) {
      log(`\n⏳ 投递停滞（≥${STALE_DAYS} 天无动静）:`);
      for (const item of stale) log(`  - ${item.company}（${item.position}）${item.status} 已 ${item.days} 天`);
    }
    log('\n完成。');
  }
  return summary;
}

async function main(args = process.argv.slice(2)) {
  if (args.includes('--check')) return runSync(args);
  const releaseLock = acquireSyncLock();
  try {
    return await runSync(args);
  } finally {
    releaseLock();
  }
}

if (require.main === module) {
  main().catch(error => {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: error.message }));
    else console.error(`同步失败: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  COLUMNS,
  STATUSES,
  EXCEL,
  SHEET,
  parseCalendarText,
  calendarCellToText,
  normalizeTimestamp,
  daysUntil,
  daysSince,
  buildHeaderMap,
  readExcel,
  normalizeCheckpoint,
  checkpointSnapshot,
  loadCheckpoints,
  markLocalChanges,
  buildReminders,
  normalizeServerJobs,
  reconcileJobs,
  writeBackExcel,
  atomicWriteJson,
  atomicWriteWorkbook,
  acquireSyncLock,
  validateConfig,
  validatePushResponse,
  requestJson,
  main,
};
