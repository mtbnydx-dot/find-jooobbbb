'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, DEFAULT_AI_PROFILE } = require('./ai');

const SOURCE_KINDS = Object.freeze(['feishu', 'tencent', 'html', 'json', 'xlsx']);
const RUN_STATUSES = Object.freeze(['queued', 'running', 'success', 'failed']);
const AI_SCOPES = Object.freeze(['candidates', 'all']);

class CloudInputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CloudInputError';
    this.statusCode = 400;
  }
}

function nowIso(clock = () => Date.now()) {
  return new Date(clock()).toISOString();
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cleanText(value, field, { required = false, max = 8192 } = {}) {
  if (value === undefined || value === null) value = '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new CloudInputError(`${field} 必须是字符串`);
  const text = String(value).trim();
  if (required && !text) throw new CloudInputError(`${field} 不能为空`);
  if (Buffer.byteLength(text, 'utf8') > max) throw new CloudInputError(`${field} 过长`);
  return text;
}

function normalizeSchedule(value) {
  const text = cleanText(value || '10:00,22:00', 'schedule', { max: 200 });
  const entries = [...new Set(text.split(',').map(part => part.trim()).filter(Boolean))];
  if (!entries.length || entries.some(entry => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(entry))) {
    throw new CloudInputError('schedule 必须是逗号分隔的 HH:mm，例如 10:00,22:00');
  }
  return entries.sort().join(',');
}

function normalizeUrl(value) {
  const text = cleanText(value, 'url', { required: true, max: 8192 });
  let url;
  try { url = new URL(text); } catch (_) { throw new CloudInputError('url 必须是有效网址'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CloudInputError('url 只支持 http/https');
  return url.href;
}

function normalizeObject(value, field) {
  if (value === undefined || value === null || value === '') return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { throw new CloudInputError(`${field} 必须是有效 JSON`); }
  }
  if (!isPlainObject(value)) throw new CloudInputError(`${field} 必须是对象`);
  return value;
}

function normalizeSourceInput(input, existing = null) {
  if (!isPlainObject(input)) throw new CloudInputError('来源必须是对象');
  const pick = (key, fallback) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback;
  const kind = cleanText(pick('kind', existing?.kind || 'html'), 'kind', { required: true, max: 30 }).toLowerCase();
  if (!SOURCE_KINDS.includes(kind)) throw new CloudInputError(`kind 仅支持 ${SOURCE_KINDS.join('/')}`);
  const enabledValue = pick('enabled', existing?.enabled ?? true);
  const enabled = enabledValue === true || enabledValue === 1 || enabledValue === '1';
  return {
    name: cleanText(pick('name', existing?.name), 'name', { required: true, max: 200 }),
    kind,
    url: normalizeUrl(pick('url', existing?.url)),
    tableId: cleanText(pick('tableId', existing?.tableId || ''), 'tableId', { max: 300 }),
    sheetName: cleanText(pick('sheetName', existing?.sheetName || ''), 'sheetName', { max: 300 }),
    schedule: normalizeSchedule(pick('schedule', existing?.schedule || '10:00,22:00')),
    authProfile: cleanText(pick('authProfile', existing?.authProfile || kind), 'authProfile', { max: 200 }) || kind,
    enabled,
    fieldMap: normalizeObject(pick('fieldMap', existing?.fieldMap || {}), 'fieldMap'),
    config: normalizeObject(pick('config', existing?.config || {}), 'config'),
  };
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = stableValue(value[key]);
    return out;
  }
  return value;
}

function stableStringify(value) {
  return JSON.stringify(stableValue(value));
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function sourceFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    url: row.url,
    tableId: row.table_id || '',
    sheetName: row.sheet_name || '',
    schedule: row.schedule,
    authProfile: row.auth_profile,
    enabled: Boolean(row.enabled),
    fieldMap: parseJson(row.field_map_json, {}),
    config: parseJson(row.config_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || '',
    lastRunAt: row.last_run_at || '',
    lastStatus: row.last_status || 'never',
    lastError: row.last_error || '',
    lastCount: Number(row.last_count || 0),
  };
}

function runFromRow(row) {
  return {
    id: Number(row.id),
    sourceId: row.source_id,
    sourceName: row.source_name || '',
    trigger: row.trigger,
    status: row.status,
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    fetchedCount: Number(row.fetched_count || 0),
    canonicalCount: Number(row.canonical_count || 0),
    insertedCount: Number(row.inserted_count || 0),
    updatedCount: Number(row.updated_count || 0),
    inactiveCount: Number(row.inactive_count || 0),
    error: row.error || '',
    detail: parseJson(row.detail_json, {}),
  };
}

function booleanValue(value) {
  return value === true || value === 1 || value === '1';
}

function normalizeAiBaseUrl(value) {
  const text = cleanText(value || DEFAULT_AI_BASE_URL, 'baseUrl', { required: true, max: 2000 });
  let url;
  try { url = new URL(text); } catch (_) { throw new CloudInputError('baseUrl 必须是有效网址'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new CloudInputError('baseUrl 只支持 http/https');
  return url.href.replace(/\/+$/, '');
}

function boundedInteger(value, field, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new CloudInputError(`${field} 必须是 ${minimum}-${maximum} 的整数`);
  }
  return number;
}

function normalizeAiSettingsInput(input, existing = null) {
  if (!isPlainObject(input)) throw new CloudInputError('AI 配置必须是对象');
  const current = existing || {
    enabled: true,
    baseUrl: DEFAULT_AI_BASE_URL,
    model: DEFAULT_AI_MODEL,
    apiKey: '',
    profile: DEFAULT_AI_PROFILE,
    autoRun: false,
    scope: 'candidates',
    maxJobs: 100,
    batchSize: 8,
  };
  const pick = (key, fallback) => Object.prototype.hasOwnProperty.call(input, key) ? input[key] : fallback;
  const scope = cleanText(pick('scope', current.scope), 'scope', { required: true, max: 30 });
  if (!AI_SCOPES.includes(scope)) throw new CloudInputError(`scope 仅支持 ${AI_SCOPES.join('/')}`);
  let apiKey = current.apiKey || '';
  if (booleanValue(input.clearApiKey)) apiKey = '';
  else if (Object.prototype.hasOwnProperty.call(input, 'apiKey') && String(input.apiKey || '').trim()) {
    apiKey = cleanText(input.apiKey, 'apiKey', { required: true, max: 20_000 });
  }
  return {
    enabled: booleanValue(pick('enabled', current.enabled)),
    baseUrl: normalizeAiBaseUrl(pick('baseUrl', current.baseUrl)),
    model: cleanText(pick('model', current.model), 'model', { required: true, max: 160 }),
    apiKey,
    profile: cleanText(pick('profile', current.profile), 'profile', { required: true, max: 30_000 }),
    autoRun: booleanValue(pick('autoRun', current.autoRun)),
    scope,
    maxJobs: boundedInteger(pick('maxJobs', current.maxJobs), 'maxJobs', 1, 1000),
    batchSize: boundedInteger(pick('batchSize', current.batchSize), 'batchSize', 1, 20),
  };
}

function aiSettingsFromRow(row) {
  if (!row) return null;
  return {
    enabled: Boolean(row.enabled),
    baseUrl: row.base_url,
    model: row.model,
    apiKey: row.api_key || '',
    profile: row.profile,
    autoRun: Boolean(row.auto_run),
    scope: row.scope,
    maxJobs: Number(row.max_jobs),
    batchSize: Number(row.batch_size),
    updatedAt: row.updated_at,
  };
}

function aiAssessmentFromRow(row) {
  if (!row) return null;
  return {
    jobId: row.job_id,
    contentHash: row.content_hash,
    profileHash: row.profile_hash,
    model: row.model,
    score: Number(row.score),
    recommendation: row.recommendation,
    matchedRoles: parseJson(row.matched_roles_json, []),
    reason: row.reason || '',
    risks: parseJson(row.risks_json, []),
    confidence: Number(row.confidence),
    assessedAt: row.assessed_at,
    runId: Number(row.run_id || 0),
  };
}

function aiRunFromRow(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    trigger: row.trigger,
    scope: row.scope,
    force: Boolean(row.force),
    limit: Number(row.limit_count),
    status: row.status,
    startedAt: row.started_at || '',
    finishedAt: row.finished_at || '',
    candidateCount: Number(row.candidate_count || 0),
    cachedCount: Number(row.cached_count || 0),
    assessedCount: Number(row.assessed_count || 0),
    failedCount: Number(row.failed_count || 0),
    inputTokens: Number(row.input_tokens || 0),
    outputTokens: Number(row.output_tokens || 0),
    error: row.error || '',
    detail: parseJson(row.detail_json, {}),
  };
}

class CloudStore {
  constructor({ dataDir, clock = () => Date.now() } = {}) {
    if (!dataDir) throw new Error('CloudStore 需要 dataDir');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'cloud.db');
    this.clock = clock;
    this.db = null;
  }

  initialize() {
    if (this.db) return this;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        url TEXT NOT NULL,
        table_id TEXT NOT NULL DEFAULT '',
        sheet_name TEXT NOT NULL DEFAULT '',
        schedule TEXT NOT NULL DEFAULT '10:00,22:00',
        auth_profile TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        field_map_json TEXT NOT NULL DEFAULT '{}',
        config_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        last_run_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_error TEXT NOT NULL DEFAULT '',
        last_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        fetched_count INTEGER NOT NULL DEFAULT 0,
        canonical_count INTEGER NOT NULL DEFAULT 0,
        inserted_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        inactive_count INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(source_id) REFERENCES sources(id)
      );
      CREATE INDEX IF NOT EXISTS runs_source_idx ON runs(source_id, id DESC);
      CREATE TABLE IF NOT EXISTS source_records (
        source_id TEXT NOT NULL,
        external_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY(source_id, external_id),
        FOREIGN KEY(source_id) REFERENCES sources(id)
      );
      CREATE INDEX IF NOT EXISTS source_records_active_idx ON source_records(source_id, active);
      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL,
        delivered_at TEXT,
        delivery_error TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS research_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company TEXT NOT NULL,
        provider TEXT NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        snippet TEXT NOT NULL DEFAULT '',
        found_at TEXT NOT NULL,
        UNIQUE(company, url)
      );
      CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_settings (
        id INTEGER PRIMARY KEY CHECK(id=1),
        enabled INTEGER NOT NULL DEFAULT 1,
        base_url TEXT NOT NULL,
        model TEXT NOT NULL,
        api_key TEXT NOT NULL DEFAULT '',
        profile TEXT NOT NULL,
        auto_run INTEGER NOT NULL DEFAULT 0,
        scope TEXT NOT NULL DEFAULT 'candidates',
        max_jobs INTEGER NOT NULL DEFAULT 100,
        batch_size INTEGER NOT NULL DEFAULT 8,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trigger TEXT NOT NULL,
        scope TEXT NOT NULL,
        force INTEGER NOT NULL DEFAULT 0,
        limit_count INTEGER NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        candidate_count INTEGER NOT NULL DEFAULT 0,
        cached_count INTEGER NOT NULL DEFAULT 0,
        assessed_count INTEGER NOT NULL DEFAULT 0,
        failed_count INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        error TEXT NOT NULL DEFAULT '',
        detail_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS ai_runs_status_idx ON ai_runs(status, id DESC);
      CREATE TABLE IF NOT EXISTS ai_assessments (
        job_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        profile_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        score INTEGER NOT NULL,
        recommendation TEXT NOT NULL,
        matched_roles_json TEXT NOT NULL DEFAULT '[]',
        reason TEXT NOT NULL DEFAULT '',
        risks_json TEXT NOT NULL DEFAULT '[]',
        confidence REAL NOT NULL DEFAULT 0.5,
        assessed_at TEXT NOT NULL,
        run_id INTEGER NOT NULL DEFAULT 0
      );
    `);
    const settingsAt = nowIso(this.clock);
    this.db.prepare(`INSERT OR IGNORE INTO ai_settings
      (id,enabled,base_url,model,api_key,profile,auto_run,scope,max_jobs,batch_size,updated_at)
      VALUES(1,1,?,?,?,?,0,'candidates',100,8,?)`)
      .run(DEFAULT_AI_BASE_URL, DEFAULT_AI_MODEL, '', DEFAULT_AI_PROFILE, settingsAt);
    const interruptedAt = nowIso(this.clock);
    const interrupted = this.db.prepare("SELECT DISTINCT source_id FROM runs WHERE status IN ('queued','running')").all();
    if (interrupted.length) {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare("UPDATE runs SET status='failed',finished_at=?,error=? WHERE status IN ('queued','running')")
          .run(interruptedAt, '任务因服务重启中断');
        const updateSource = this.db.prepare("UPDATE sources SET last_run_at=?,last_status='failed',last_error=?,updated_at=? WHERE id=?");
        for (const row of interrupted) updateSource.run(interruptedAt, '任务因服务重启中断', interruptedAt, row.source_id);
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
    this.db.prepare("UPDATE ai_runs SET status='failed',finished_at=?,error=? WHERE status IN ('queued','running')")
      .run(interruptedAt, '任务因服务重启中断');
    return this;
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  listSources({ includeDeleted = false } = {}) {
    this.initialize();
    const sql = `SELECT * FROM sources ${includeDeleted ? '' : 'WHERE deleted_at IS NULL'} ORDER BY created_at, name`;
    return this.db.prepare(sql).all().map(sourceFromRow);
  }

  getSource(id, { includeDeleted = false } = {}) {
    this.initialize();
    const row = this.db.prepare(`SELECT * FROM sources WHERE id=? ${includeDeleted ? '' : 'AND deleted_at IS NULL'}`).get(String(id));
    return sourceFromRow(row);
  }

  createSource(input) {
    this.initialize();
    const source = normalizeSourceInput(input);
    const id = `src_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const timestamp = nowIso(this.clock);
    this.db.prepare(`INSERT INTO sources
      (id,name,kind,url,table_id,sheet_name,schedule,auth_profile,enabled,field_map_json,config_json,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, source.name, source.kind, source.url, source.tableId, source.sheetName, source.schedule,
      source.authProfile, source.enabled ? 1 : 0, JSON.stringify(source.fieldMap), JSON.stringify(source.config), timestamp, timestamp,
    );
    return this.getSource(id);
  }

  updateSource(id, input) {
    this.initialize();
    const existing = this.getSource(id);
    if (!existing) return null;
    const source = normalizeSourceInput(input, existing);
    const timestamp = nowIso(this.clock);
    this.db.prepare(`UPDATE sources SET
      name=?,kind=?,url=?,table_id=?,sheet_name=?,schedule=?,auth_profile=?,enabled=?,field_map_json=?,config_json=?,updated_at=?
      WHERE id=? AND deleted_at IS NULL`).run(
      source.name, source.kind, source.url, source.tableId, source.sheetName, source.schedule,
      source.authProfile, source.enabled ? 1 : 0, JSON.stringify(source.fieldMap), JSON.stringify(source.config), timestamp, String(id),
    );
    return this.getSource(id);
  }

  archiveSource(id) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = this.db.prepare('UPDATE sources SET deleted_at=?,enabled=0,updated_at=? WHERE id=? AND deleted_at IS NULL')
        .run(timestamp, timestamp, String(id));
      if (result.changes > 0) this.db.prepare('UPDATE source_records SET active=0 WHERE source_id=?').run(String(id));
      this.db.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createRun(sourceId, trigger = 'manual', status = 'queued') {
    this.initialize();
    if (!RUN_STATUSES.includes(status)) throw new Error('运行状态非法');
    if (!this.getSource(sourceId)) throw new Error('信息源不存在');
    const startedAt = status === 'running' ? nowIso(this.clock) : null;
    const result = this.db.prepare('INSERT INTO runs(source_id,trigger,status,started_at) VALUES(?,?,?,?)')
      .run(String(sourceId), cleanText(trigger, 'trigger', { required: true, max: 80 }), status, startedAt);
    return Number(result.lastInsertRowid);
  }

  markRunRunning(runId) {
    this.initialize();
    this.db.prepare("UPDATE runs SET status='running',started_at=? WHERE id=? AND status='queued'")
      .run(nowIso(this.clock), Number(runId));
  }

  finishRun(runId, result) {
    this.initialize();
    const status = result?.status === 'success' ? 'success' : 'failed';
    const finishedAt = nowIso(this.clock);
    const detail = isPlainObject(result?.detail) ? result.detail : {};
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const run = this.db.prepare('SELECT source_id FROM runs WHERE id=?').get(Number(runId));
      if (!run) throw new Error('运行记录不存在');
      this.db.prepare(`UPDATE runs SET status=?,finished_at=?,fetched_count=?,canonical_count=?,inserted_count=?,updated_count=?,inactive_count=?,error=?,detail_json=? WHERE id=?`)
        .run(status, finishedAt, Number(result?.fetchedCount || 0), Number(result?.canonicalCount || 0),
          Number(result?.insertedCount || 0), Number(result?.updatedCount || 0), Number(result?.inactiveCount || 0),
          cleanText(result?.error || '', 'error', { max: 8000 }), JSON.stringify(detail), Number(runId));
      this.db.prepare('UPDATE sources SET last_run_at=?,last_status=?,last_error=?,last_count=?,updated_at=? WHERE id=?')
        .run(finishedAt, status, cleanText(result?.error || '', 'error', { max: 8000 }), Number(result?.fetchedCount || 0), finishedAt, run.source_id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listRuns({ limit = 50, sourceId = '' } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = sourceId
      ? this.db.prepare(`SELECT r.*,s.name AS source_name FROM runs r JOIN sources s ON s.id=r.source_id WHERE r.source_id=? ORDER BY r.id DESC LIMIT ?`).all(String(sourceId), bounded)
      : this.db.prepare(`SELECT r.*,s.name AS source_name FROM runs r JOIN sources s ON s.id=r.source_id ORDER BY r.id DESC LIMIT ?`).all(bounded);
    return rows.map(runFromRow);
  }

  upsertSourceRecords(sourceId, records, seenAt = nowIso(this.clock)) {
    this.initialize();
    if (!Array.isArray(records)) throw new Error('records 必须是数组');
    if (records.length > 50_000) throw new Error('单次来源记录超过 50000 条');
    const previousActive = new Set(this.db.prepare('SELECT external_id FROM source_records WHERE source_id=? AND active=1').all(String(sourceId)).map(row => row.external_id));
    const seen = new Set();
    const lookup = this.db.prepare('SELECT fingerprint FROM source_records WHERE source_id=? AND external_id=?');
    const insert = this.db.prepare(`INSERT INTO source_records(source_id,external_id,fingerprint,payload_json,first_seen_at,last_seen_at,active)
      VALUES(?,?,?,?,?,?,1)
      ON CONFLICT(source_id,external_id) DO UPDATE SET fingerprint=excluded.fingerprint,payload_json=excluded.payload_json,last_seen_at=excluded.last_seen_at,active=1`);
    let inserted = 0;
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE source_records SET active=0 WHERE source_id=?').run(String(sourceId));
      for (let index = 0; index < records.length; index++) {
        const record = records[index];
        if (!isPlainObject(record)) throw new Error(`records[${index}] 不是对象`);
        const payload = stableStringify(record);
        const externalId = cleanText(record._id || record.id || `row_${crypto.createHash('sha1').update(payload).digest('hex').slice(0, 20)}`, `records[${index}]._id`, { required: true, max: 500 });
        if (seen.has(externalId)) continue;
        seen.add(externalId);
        const fingerprint = crypto.createHash('sha256').update(payload).digest('hex');
        const old = lookup.get(String(sourceId), externalId);
        if (!old) inserted++;
        else if (old.fingerprint !== fingerprint) changed++;
        insert.run(String(sourceId), externalId, fingerprint, payload, seenAt, seenAt);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    let missing = 0;
    for (const id of previousActive) if (!seen.has(id)) missing++;
    return { inserted, changed, missing, active: seen.size };
  }

  listActiveSourceRecordIds() {
    this.initialize();
    return this.db.prepare(`SELECT r.source_id,r.external_id FROM source_records r
      JOIN sources s ON s.id=r.source_id
      WHERE r.active=1 AND s.deleted_at IS NULL`)
      .all().map(row => `${row.source_id}:${row.external_id}`);
  }

  addNotification(kind, title, body) {
    this.initialize();
    const result = this.db.prepare('INSERT INTO notifications(kind,title,body,created_at) VALUES(?,?,?,?)')
      .run(cleanText(kind, 'kind', { required: true, max: 80 }), cleanText(title, 'title', { required: true, max: 300 }), cleanText(body, 'body', { max: 100_000 }), nowIso(this.clock));
    return Number(result.lastInsertRowid);
  }

  markNotificationDelivered(id, error = '') {
    this.initialize();
    this.db.prepare('UPDATE notifications SET delivered_at=?,delivery_error=? WHERE id=?')
      .run(error ? null : nowIso(this.clock), cleanText(error, 'deliveryError', { max: 8000 }), Number(id));
  }

  listNotifications(limit = 30) {
    this.initialize();
    const bounded = Math.max(1, Math.min(200, Number(limit) || 30));
    return this.db.prepare('SELECT * FROM notifications ORDER BY id DESC LIMIT ?').all(bounded).map(row => ({
      id: Number(row.id), kind: row.kind, title: row.title, body: row.body, createdAt: row.created_at,
      deliveredAt: row.delivered_at || '', deliveryError: row.delivery_error || '',
    }));
  }

  addResearchResults(company, provider, results) {
    this.initialize();
    if (!Array.isArray(results)) return 0;
    const statement = this.db.prepare(`INSERT INTO research_results(company,provider,title,url,snippet,found_at)
      VALUES(?,?,?,?,?,?) ON CONFLICT(company,url) DO UPDATE SET title=excluded.title,snippet=excluded.snippet,found_at=excluded.found_at`);
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const result of results.slice(0, 50)) {
        const info = statement.run(
          cleanText(company, 'company', { required: true, max: 500 }), cleanText(provider, 'provider', { required: true, max: 100 }),
          cleanText(result.title, 'title', { required: true, max: 1000 }), normalizeUrl(result.url),
          cleanText(result.snippet || '', 'snippet', { max: 5000 }), nowIso(this.clock),
        );
        changed += Number(info.changes || 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  listResearch({ limit = 100, company = '' } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    const rows = company
      ? this.db.prepare('SELECT * FROM research_results WHERE company=? ORDER BY found_at DESC LIMIT ?').all(String(company), bounded)
      : this.db.prepare('SELECT * FROM research_results ORDER BY found_at DESC LIMIT ?').all(bounded);
    return rows.map(row => ({ id: Number(row.id), company: row.company, provider: row.provider, title: row.title, url: row.url, snippet: row.snippet, foundAt: row.found_at }));
  }

  getAiSettings() {
    this.initialize();
    return aiSettingsFromRow(this.db.prepare('SELECT * FROM ai_settings WHERE id=1').get());
  }

  updateAiSettings(input) {
    this.initialize();
    const settings = normalizeAiSettingsInput(input, this.getAiSettings());
    const updatedAt = nowIso(this.clock);
    this.db.prepare(`UPDATE ai_settings SET enabled=?,base_url=?,model=?,api_key=?,profile=?,auto_run=?,scope=?,max_jobs=?,batch_size=?,updated_at=? WHERE id=1`)
      .run(settings.enabled ? 1 : 0, settings.baseUrl, settings.model, settings.apiKey, settings.profile,
        settings.autoRun ? 1 : 0, settings.scope, settings.maxJobs, settings.batchSize, updatedAt);
    return this.getAiSettings();
  }

  createAiRun({ trigger = 'manual-ai', scope = 'candidates', force = false, limit = 100 } = {}) {
    this.initialize();
    if (!AI_SCOPES.includes(scope)) throw new CloudInputError(`scope 仅支持 ${AI_SCOPES.join('/')}`);
    const boundedLimit = boundedInteger(limit, 'limit', 1, 1000);
    const result = this.db.prepare(`INSERT INTO ai_runs(trigger,scope,force,limit_count,status) VALUES(?,?,?,?,'queued')`)
      .run(cleanText(trigger, 'trigger', { required: true, max: 80 }), scope, force ? 1 : 0, boundedLimit);
    return Number(result.lastInsertRowid);
  }

  markAiRunRunning(runId) {
    this.initialize();
    this.db.prepare("UPDATE ai_runs SET status='running',started_at=? WHERE id=? AND status='queued'")
      .run(nowIso(this.clock), Number(runId));
  }

  finishAiRun(runId, result = {}) {
    this.initialize();
    const status = result.status === 'success' ? 'success' : 'failed';
    this.db.prepare(`UPDATE ai_runs SET status=?,finished_at=?,candidate_count=?,cached_count=?,assessed_count=?,failed_count=?,input_tokens=?,output_tokens=?,error=?,detail_json=? WHERE id=?`)
      .run(status, nowIso(this.clock), Number(result.candidateCount || 0), Number(result.cachedCount || 0),
        Number(result.assessedCount || 0), Number(result.failedCount || 0), Number(result.inputTokens || 0), Number(result.outputTokens || 0),
        cleanText(result.error || '', 'error', { max: 8000 }), JSON.stringify(isPlainObject(result.detail) ? result.detail : {}), Number(runId));
  }

  listAiRuns({ limit = 30 } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(200, Number(limit) || 30));
    return this.db.prepare('SELECT * FROM ai_runs ORDER BY id DESC LIMIT ?').all(bounded).map(aiRunFromRow);
  }

  upsertAiAssessments(assessments, runId = 0) {
    this.initialize();
    if (!Array.isArray(assessments)) throw new Error('assessments 必须是数组');
    const statement = this.db.prepare(`INSERT INTO ai_assessments
      (job_id,content_hash,profile_hash,model,score,recommendation,matched_roles_json,reason,risks_json,confidence,assessed_at,run_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(job_id) DO UPDATE SET content_hash=excluded.content_hash,profile_hash=excluded.profile_hash,model=excluded.model,
      score=excluded.score,recommendation=excluded.recommendation,matched_roles_json=excluded.matched_roles_json,reason=excluded.reason,
      risks_json=excluded.risks_json,confidence=excluded.confidence,assessed_at=excluded.assessed_at,run_id=excluded.run_id`);
    let changed = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const assessment of assessments) {
        const score = Math.max(0, Math.min(100, Math.round(Number(assessment.score) || 0)));
        const confidence = Math.max(0, Math.min(1, Number(assessment.confidence) || 0));
        const result = statement.run(
          cleanText(assessment.jobId, 'jobId', { required: true, max: 300 }),
          cleanText(assessment.contentHash, 'contentHash', { required: true, max: 128 }),
          cleanText(assessment.profileHash, 'profileHash', { required: true, max: 128 }),
          cleanText(assessment.model, 'model', { required: true, max: 160 }), score,
          cleanText(assessment.recommendation, 'recommendation', { required: true, max: 50 }),
          JSON.stringify(Array.isArray(assessment.matchedRoles) ? assessment.matchedRoles.slice(0, 20) : []),
          cleanText(assessment.reason || '', 'reason', { max: 2000 }),
          JSON.stringify(Array.isArray(assessment.risks) ? assessment.risks.slice(0, 20) : []),
          confidence, cleanText(assessment.assessedAt || nowIso(this.clock), 'assessedAt', { required: true, max: 100 }), Number(runId || 0),
        );
        changed += Number(result.changes || 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return changed;
  }

  remapAiAssessments(aliases) {
    this.initialize();
    const entries = aliases instanceof Map ? [...aliases.entries()] : Object.entries(aliases || {});
    const lookup = this.db.prepare('SELECT * FROM ai_assessments WHERE job_id=?');
    const remove = this.db.prepare('DELETE FROM ai_assessments WHERE job_id=?');
    const move = this.db.prepare('UPDATE ai_assessments SET job_id=? WHERE job_id=?');
    let remapped = 0;
    let dropped = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [oldValue, targetValue] of entries) {
        const oldId = String(oldValue || '');
        const targetId = String(targetValue || '');
        if (!oldId || !targetId || oldId === targetId) continue;
        const source = lookup.get(oldId);
        if (!source) continue;
        const target = lookup.get(targetId);
        if (!target) {
          move.run(targetId, oldId);
          remapped++;
          continue;
        }
        const sourceTime = Date.parse(source.assessed_at || '') || 0;
        const targetTime = Date.parse(target.assessed_at || '') || 0;
        if (sourceTime > targetTime || sourceTime === targetTime && Number(source.run_id || 0) > Number(target.run_id || 0)) {
          remove.run(targetId);
          move.run(targetId, oldId);
          remapped++;
          dropped++;
        } else {
          remove.run(oldId);
          dropped++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { remapped, dropped };
  }

  listAiAssessments() {
    this.initialize();
    return this.db.prepare('SELECT * FROM ai_assessments ORDER BY assessed_at DESC').all().map(aiAssessmentFromRow);
  }

  aiAssessmentMap() {
    return new Map(this.listAiAssessments().map(item => [item.jobId, item]));
  }

  aiStats() {
    this.initialize();
    return {
      assessments: Number(this.db.prepare('SELECT COUNT(*) AS n FROM ai_assessments').get().n),
      successfulRuns: Number(this.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE status='success'").get().n),
      failedRuns: Number(this.db.prepare("SELECT COUNT(*) AS n FROM ai_runs WHERE status='failed'").get().n),
      latestRunAt: this.db.prepare('SELECT finished_at FROM ai_runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.finished_at || '',
    };
  }

  getKv(key) {
    this.initialize();
    return this.db.prepare('SELECT value FROM kv WHERE key=?').get(String(key))?.value || '';
  }

  setKv(key, value) {
    this.initialize();
    this.db.prepare(`INSERT INTO kv(key,value,updated_at) VALUES(?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`)
      .run(String(key), String(value), nowIso(this.clock));
  }

  overview() {
    this.initialize();
    return {
      sources: Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL').get().n),
      enabledSources: Number(this.db.prepare('SELECT COUNT(*) AS n FROM sources WHERE deleted_at IS NULL AND enabled=1').get().n),
      running: Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','running')").get().n),
      failed24h: Number(this.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='failed' AND julianday(finished_at)>=julianday('now','-1 day')").get().n),
      records: Number(this.db.prepare('SELECT COUNT(*) AS n FROM source_records r JOIN sources s ON s.id=r.source_id WHERE r.active=1 AND s.deleted_at IS NULL').get().n),
      lastRun: this.db.prepare('SELECT finished_at FROM runs WHERE finished_at IS NOT NULL ORDER BY id DESC LIMIT 1').get()?.finished_at || '',
    };
  }
}

module.exports = {
  CloudStore,
  SOURCE_KINDS,
  AI_SCOPES,
  normalizeAiSettingsInput,
  normalizeSourceInput,
  stableStringify,
};
