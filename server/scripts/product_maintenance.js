'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { normalizeEmail } = require('../product/auth');

const LEGACY_STATUS_MAP = Object.freeze({
  '未投递': 'not_applied',
  '已投递': 'applied',
  '笔试': 'assessment',
  '一面': 'interview',
  '二面': 'interview',
  offer: 'offer',
  '挂': 'rejected',
});

const LEGACY_STATUSES = new Set(Object.keys(LEGACY_STATUS_MAP));
const PRODUCT_STATUSES = new Set([
  'not_applied', 'saved', 'preparing', 'applied', 'assessment', 'interview',
  'offer', 'rejected', 'withdrawn', 'ignored',
]);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function asText(value, field, maxBytes = 32_000) {
  if (value === undefined || value === null) return '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new Error(`${field} 必须是文本或标量值`);
  const result = String(value).trim();
  if (result.includes('\0') || Buffer.byteLength(result, 'utf8') > maxBytes) throw new Error(`${field} 格式非法或过长`);
  return result;
}

function normalizeLegacyDate(value, field) {
  const text = asText(value, field, 100);
  if (!text) return '';
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(text);
  if (!match) throw new Error(`${field} 必须是 YYYY/MM/DD 或 YYYY-MM-DD`);
  const [, yearText, monthText, dayText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.getUTCFullYear() !== Number(yearText) || date.getUTCMonth() !== Number(monthText) - 1 || date.getUTCDate() !== Number(dayText)) {
    throw new Error(`${field} 不是有效日期`);
  }
  return `${yearText}-${monthText}-${dayText}`;
}

function validIso(value) {
  const text = String(value || '').trim();
  if (!text || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(text)) return '';
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

function laterIso(left, right) {
  const leftTime = Date.parse(left || '');
  const rightTime = Date.parse(right || '');
  if (!Number.isFinite(leftTime)) return right || '';
  if (!Number.isFinite(rightTime)) return left || '';
  return leftTime >= rightTime ? left : right;
}

function isCustomJob(job) {
  return String(job?.source || '') === '自选' || String(job?.isCustom || '') === '1';
}

function legacyHasState(job) {
  return isCustomJob(job)
    || String(job.status || '未投递') !== '未投递'
    || Boolean(String(job.note || '').trim())
    || Boolean(String(job.appliedAt || '').trim());
}

function loadLegacyJobs(jobsFile) {
  const resolved = path.resolve(String(jobsFile || ''));
  if (!resolved || !fs.existsSync(resolved)) throw new Error(`旧岗位文件不存在: ${resolved || '(未指定)'}`);
  const bytes = fs.readFileSync(resolved);
  let parsed;
  try { parsed = JSON.parse(bytes.toString('utf8')); } catch (error) { throw new Error(`旧岗位文件 JSON 无效: ${error.message}`); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(parsed.jobs)) {
    throw new Error('旧岗位文件必须是含 jobs 数组的对象');
  }
  if (parsed.jobs.length > 20_000) throw new Error('旧岗位文件超过 20000 条上限');
  const ids = new Set();
  const jobs = parsed.jobs.map((raw, index) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`jobs[${index}] 必须是对象`);
    const id = asText(raw.id, `jobs[${index}].id`, 256);
    if (!id || !/^[\p{L}\p{N}._:-]+$/u.test(id)) throw new Error(`jobs[${index}].id 格式非法`);
    if (ids.has(id)) throw new Error(`旧岗位文件含重复 id: ${id}`);
    ids.add(id);
    const status = asText(raw.status || '未投递', `jobs[${index}].status`, 100);
    if (!LEGACY_STATUSES.has(status)) throw new Error(`jobs[${index}].status 非法: ${status}`);
    const note = asText(raw.note, `jobs[${index}].note`, 8000);
    const appliedAt = normalizeLegacyDate(raw.appliedAt, `jobs[${index}].appliedAt`);
    const statusUpdatedAt = raw.statusUpdatedAt ? validIso(raw.statusUpdatedAt) : '';
    if (raw.statusUpdatedAt && !statusUpdatedAt) throw new Error(`jobs[${index}].statusUpdatedAt 必须是带时区的 ISO 时间`);
    return { ...raw, id, status, note, appliedAt, statusUpdatedAt };
  });
  const stat = fs.statSync(resolved);
  const fallbackTimestamp = validIso(parsed.meta?.lastWebEditAt)
    || validIso(parsed.meta?.lastSyncAt)
    || stat.mtime.toISOString();
  return {
    file: resolved,
    fileHash: sha256(bytes),
    fileSize: bytes.length,
    fileMtimeMs: stat.mtimeMs,
    jobs,
    meta: parsed.meta && typeof parsed.meta === 'object' && !Array.isArray(parsed.meta) ? parsed.meta : {},
    fallbackTimestamp,
  };
}

function productDbPath(dataDir) {
  if (!dataDir) throw new Error('必须显式指定 --data-dir，工具不会猜测数据目录');
  return path.join(path.resolve(String(dataDir)), 'product.db');
}

function openExistingProductDb(dataDir, { readOnly = true } = {}) {
  const file = productDbPath(dataDir);
  if (!fs.existsSync(file)) throw new Error(`product.db 不存在，请先启动一次产品服务: ${file}`);
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly) db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  const required = ['users', 'job_states'];
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const table of required) {
    if (!tables.has(table)) {
      db.close();
      throw new Error(`product.db 缺少 ${table} 表，请先完成产品库初始化`);
    }
  }
  return { db, file, tables };
}

function findUserByEmail(db, emailValue) {
  const email = normalizeEmail(emailValue);
  const row = db.prepare("SELECT id,email,display_name,role,status FROM users WHERE email=? COLLATE NOCASE AND status<>'deleted'").get(email);
  if (!row) throw new Error(`指定账号不存在: ${email}；迁移工具不会创建账号或猜测归属`);
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  };
}

function rowToState(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    jobId: row.job_id,
    status: row.status,
    saved: Boolean(row.saved),
    favorite: Boolean(row.favorite),
    hidden: Boolean(row.hidden),
    note: row.note || '',
    nextAction: row.next_action || '',
    appliedAt: row.applied_at || '',
    followUpAt: row.follow_up_at || '',
    updatedAt: row.updated_at || '',
  };
}

function stateValues(state) {
  return [
    state.status,
    state.saved ? 1 : 0,
    state.favorite ? 1 : 0,
    state.hidden ? 1 : 0,
    state.note || '',
    state.nextAction || '',
    state.appliedAt || null,
    state.followUpAt || null,
    state.updatedAt,
  ];
}

function stateEqual(left, right) {
  return stableJson(stateValues(left)) === stableJson(stateValues(right));
}

function blankProductState(state) {
  return Boolean(state)
    && state.status === 'not_applied'
    && !state.saved
    && !state.favorite
    && !state.hidden
    && !state.note
    && !state.nextAction
    && !state.appliedAt
    && !state.followUpAt;
}

function appendLegacyNote(current, legacy) {
  const existing = String(current || '').trim();
  const incoming = String(legacy || '').trim();
  if (!incoming) return existing;
  if (!existing) return incoming;
  const normalizedExisting = existing.replace(/\r\n/g, '\n');
  const normalizedIncoming = incoming.replace(/\r\n/g, '\n');
  const existingParts = new Set(normalizedExisting.split(/\n{2,}/).map(part => part.trim()).filter(Boolean));
  const missingParts = normalizedIncoming.split(/\n{2,}/).map(part => part.trim()).filter(Boolean)
    .filter(part => !existingParts.has(part));
  if (!missingParts.length) return existing;
  return `${existing}\n\n${missingParts.join('\n\n')}`;
}

function desiredLegacyState(job, fallbackTimestamp) {
  const custom = isCustomJob(job);
  let status = LEGACY_STATUS_MAP[job.status] || 'not_applied';
  if (status === 'not_applied' && (custom || job.note)) status = 'saved';
  return {
    userId: '',
    jobId: job.id,
    status,
    saved: true,
    favorite: custom,
    hidden: false,
    note: job.note || '',
    nextAction: '',
    appliedAt: job.appliedAt || '',
    followUpAt: '',
    updatedAt: job.statusUpdatedAt || fallbackTimestamp,
  };
}

function mergeLegacyState(existing, incoming) {
  if (!existing || blankProductState(existing)) return { ...incoming, userId: existing?.userId || incoming.userId };
  const next = {
    ...existing,
    saved: existing.saved || incoming.saved,
    favorite: existing.favorite || incoming.favorite,
    note: appendLegacyNote(existing.note, incoming.note),
    appliedAt: existing.appliedAt || incoming.appliedAt,
  };
  const changed = !stateEqual(existing, next);
  if (changed) next.updatedAt = laterIso(existing.updatedAt, incoming.updatedAt) || incoming.updatedAt;
  return next;
}

function summarizeStates(rows) {
  const result = {
    total: rows.length,
    saved: 0,
    favorite: 0,
    notes: 0,
    appliedDates: 0,
    byStatus: {},
  };
  for (const row of rows) {
    const state = row.userId ? row : rowToState(row);
    if (state.saved) result.saved++;
    if (state.favorite) result.favorite++;
    if (state.note) result.notes++;
    if (state.appliedAt) result.appliedDates++;
    result.byStatus[state.status] = Number(result.byStatus[state.status] || 0) + 1;
  }
  return result;
}

function summarizeLegacy(legacy) {
  const eligible = legacy.jobs.filter(legacyHasState);
  return {
    totalJobs: legacy.jobs.length,
    eligibleStates: eligible.length,
    customJobs: legacy.jobs.filter(isCustomJob).length,
    nonDefaultStatuses: legacy.jobs.filter(job => job.status !== '未投递').length,
    notes: legacy.jobs.filter(job => job.note).length,
    appliedDates: legacy.jobs.filter(job => job.appliedAt).length,
  };
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(String(table)));
}

function loadCustomRows(db, userId) {
  if (!tableExists(db, 'user_custom_jobs')) return new Map();
  return new Map(db.prepare('SELECT job_id,job_json,source_hash FROM user_custom_jobs WHERE user_id=?').all(String(userId))
    .map(row => [row.job_id, row]));
}

function planLegacyMigration(db, user, legacy) {
  const currentRows = db.prepare('SELECT * FROM job_states WHERE user_id=?').all(String(user.id));
  const current = new Map(currentRows.map(row => [row.job_id, rowToState(row)]));
  const customRows = loadCustomRows(db, user.id);
  const stateOperations = [];
  const customOperations = [];

  for (const job of legacy.jobs.filter(legacyHasState)) {
    const incoming = { ...desiredLegacyState(job, legacy.fallbackTimestamp), userId: user.id };
    const existing = current.get(job.id) || null;
    const next = mergeLegacyState(existing, incoming);
    if (!PRODUCT_STATUSES.has(next.status)) throw new Error(`内部状态映射非法: ${next.status}`);
    stateOperations.push({
      action: !existing ? 'insert' : stateEqual(existing, next) ? 'unchanged' : 'update',
      jobId: job.id,
      existing,
      next,
      custom: isCustomJob(job),
      preservedExistingStatus: Boolean(existing && !blankProductState(existing) && existing.status !== incoming.status),
    });

    if (isCustomJob(job)) {
      const jobJson = stableJson(job);
      const sourceHash = sha256(jobJson);
      const stored = customRows.get(job.id);
      customOperations.push({
        action: !stored ? 'insert' : stored.source_hash === sourceHash ? 'unchanged' : 'update',
        jobId: job.id,
        jobJson,
        sourceHash,
      });
    }
  }

  const counts = operations => operations.reduce((result, item) => {
    result[item.action] = Number(result[item.action] || 0) + 1;
    return result;
  }, { insert: 0, update: 0, unchanged: 0 });

  return {
    before: summarizeStates([...current.values()]),
    stateOperations,
    customOperations,
    statePlan: counts(stateOperations),
    customPlan: counts(customOperations),
    preservedExistingStatuses: stateOperations.filter(operation => operation.preservedExistingStatus).length,
  };
}

function backupPathFor(dbFile, purpose, now = Date.now()) {
  const timestamp = new Date(now).toISOString().replace(/[-:.]/g, '').replace('Z', 'Z');
  const suffix = crypto.randomBytes(4).toString('hex');
  return path.join(path.dirname(dbFile), 'backups', `${path.basename(dbFile)}.before-${purpose}-${timestamp}-${suffix}.sqlite`);
}

function sqliteQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function backupDatabase(db, dbFile, destination) {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error(`备份目标已存在: ${target}`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  db.exec(`VACUUM INTO ${sqliteQuote(target)}`);
  try { fs.chmodSync(target, 0o600); } catch (_) { /* Windows may not implement POSIX modes */ }
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) throw new Error(`数据库备份失败: ${target}`);
  const sourceHeader = fs.readFileSync(dbFile).subarray(0, 16).toString('ascii');
  const backupHeader = fs.readFileSync(target).subarray(0, 16).toString('ascii');
  if (sourceHeader !== 'SQLite format 3\0' || backupHeader !== sourceHeader) throw new Error(`数据库备份校验失败: ${target}`);
  return target;
}

function verifyLegacyUnchanged(legacy) {
  const bytes = fs.readFileSync(legacy.file);
  if (sha256(bytes) !== legacy.fileHash) throw new Error('迁移规划后 jobs.json 已变化，已中止；请重新 dry-run');
}

function applyLegacyPlan(db, user, plan, legacy, { withinTransaction = false, migratedAt = new Date().toISOString() } = {}) {
  const insertState = db.prepare(`INSERT INTO job_states
    (user_id,job_id,status,saved,favorite,hidden,note,next_action,applied_at,follow_up_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`);
  const updateState = db.prepare(`UPDATE job_states SET status=?,saved=?,favorite=?,hidden=?,note=?,next_action=?,
    applied_at=?,follow_up_at=?,updated_at=? WHERE user_id=? AND job_id=?`);
  if (!withinTransaction) db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS user_custom_jobs (
      user_id TEXT NOT NULL,
      job_id TEXT NOT NULL,
      job_json TEXT NOT NULL,
      source_file TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      migrated_at TEXT NOT NULL,
      PRIMARY KEY(user_id,job_id),
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    const upsertCustom = db.prepare(`INSERT INTO user_custom_jobs
      (user_id,job_id,job_json,source_file,source_hash,migrated_at) VALUES(?,?,?,?,?,?)
      ON CONFLICT(user_id,job_id) DO UPDATE SET job_json=excluded.job_json,source_file=excluded.source_file,
      source_hash=excluded.source_hash,migrated_at=excluded.migrated_at`);
    for (const operation of plan.stateOperations) {
      if (operation.action === 'insert') insertState.run(user.id, operation.jobId, ...stateValues(operation.next));
      if (operation.action === 'update') updateState.run(...stateValues(operation.next), user.id, operation.jobId);
    }
    for (const operation of plan.customOperations) {
      if (operation.action !== 'unchanged') {
        upsertCustom.run(user.id, operation.jobId, operation.jobJson, legacy.file, operation.sourceHash, migratedAt);
      }
    }
    if (!withinTransaction) db.exec('COMMIT');
  } catch (error) {
    if (!withinTransaction) {
      try { db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
    }
    throw error;
  }
}

function dataVersion(db) {
  const row = db.prepare('PRAGMA data_version').get();
  return Number(row?.data_version ?? Object.values(row || {})[0] ?? 0);
}

function migrationResult({ mode, user, legacy, plan, backupPath = '', after = null }) {
  return {
    ok: true,
    mode,
    target: user,
    source: {
      jobsFile: legacy.file,
      sha256: legacy.fileHash,
      bytes: legacy.fileSize,
    },
    legacy: summarizeLegacy(legacy),
    before: plan.before,
    plan: {
      states: plan.statePlan,
      customSnapshots: plan.customPlan,
      preservedExistingStatuses: plan.preservedExistingStatuses,
    },
    after,
    backupPath,
  };
}

function runLegacyMigration({ dataDir, jobsFile, email, expectUserId = '', apply = false, now = Date.now } = {}) {
  const legacy = loadLegacyJobs(jobsFile);
  const opened = openExistingProductDb(dataDir, { readOnly: !apply });
  try {
    const user = findUserByEmail(opened.db, email);
    if (expectUserId && String(expectUserId) !== String(user.id)) {
      throw new Error(`账号 ID 不匹配：期望 ${expectUserId}，实际 ${user.id}`);
    }
    const plan = planLegacyMigration(opened.db, user, legacy);
    if (!apply) return migrationResult({ mode: 'dry-run', user, legacy, plan });
    verifyLegacyUnchanged(legacy);
    const writes = plan.statePlan.insert + plan.statePlan.update + plan.customPlan.insert + plan.customPlan.update;
    if (!writes) {
      const rows = opened.db.prepare('SELECT * FROM job_states WHERE user_id=?').all(String(user.id));
      return migrationResult({ mode: 'apply', user, legacy, plan, after: summarizeStates(rows) });
    }
    const migrationNow = now();
    const beforeBackupVersion = dataVersion(opened.db);
    const backupPath = backupPathFor(opened.file, 'legacy-user-migration', migrationNow);
    backupDatabase(opened.db, opened.file, backupPath);
    opened.db.exec('BEGIN IMMEDIATE');
    try {
      if (dataVersion(opened.db) !== beforeBackupVersion) {
        throw new Error(`product.db 在备份期间被其他进程修改，迁移已中止；备份保留在 ${backupPath}`);
      }
      verifyLegacyUnchanged(legacy);
      const lockedPlan = planLegacyMigration(opened.db, user, legacy);
      applyLegacyPlan(opened.db, user, lockedPlan, legacy, {
        withinTransaction: true,
        migratedAt: new Date(migrationNow).toISOString(),
      });
      opened.db.exec('COMMIT');
      plan.before = lockedPlan.before;
      plan.stateOperations = lockedPlan.stateOperations;
      plan.customOperations = lockedPlan.customOperations;
      plan.statePlan = lockedPlan.statePlan;
      plan.customPlan = lockedPlan.customPlan;
      plan.preservedExistingStatuses = lockedPlan.preservedExistingStatuses;
    } catch (error) {
      try { opened.db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
      throw error;
    }
    const rows = opened.db.prepare('SELECT * FROM job_states WHERE user_id=?').all(String(user.id));
    return migrationResult({ mode: 'apply', user, legacy, plan, backupPath, after: summarizeStates(rows) });
  } finally {
    opened.db.close();
  }
}

function configuredBootstrapRole(emailValue, env = process.env) {
  const email = normalizeEmail(emailValue);
  const parse = value => new Set(String(value || '').split(',').map(item => item.trim().toLowerCase()).filter(Boolean));
  if (parse(env.PRODUCT_ADMIN_EMAILS).has(email)) return 'admin';
  if (parse(env.PRODUCT_CONTENT_EDITOR_EMAILS).has(email)) return 'content_editor';
  throw new Error(`${email} 不在 PRODUCT_ADMIN_EMAILS 或 PRODUCT_CONTENT_EDITOR_EMAILS 中`);
}

function equalSecret(left, right) {
  if (!left || !right) return false;
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  backupDatabase,
  backupPathFor,
  configuredBootstrapRole,
  dataVersion,
  equalSecret,
  findUserByEmail,
  loadLegacyJobs,
  openExistingProductDb,
  planLegacyMigration,
  productDbPath,
  runLegacyMigration,
  summarizeLegacy,
  summarizeStates,
};
