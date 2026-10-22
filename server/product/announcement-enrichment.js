'use strict';

// A review-only enrichment layer. It never edits the publisher/source catalog,
// personal job state, or existing human overrides. Fetching is only triggered by
// an explicit administrator run, never by reading a job or a timer-created run.
const crypto = require('node:crypto');

const FIELDS = Object.freeze(['salaryText', 'salaryCurrency', 'salaryPeriod', 'salaryMonths', 'benefits', 'major', 'degree', 'experience', 'requirements', 'description', 'deadline', 'audience', 'batch', 'workMode', 'employmentType']);
const SALARY_FIELDS = ['salaryText', 'salaryCurrency', 'salaryPeriod', 'salaryMonths', 'salaryMin', 'salaryMax', 'salary', 'pay', 'compensation'];
const SNAPSHOT_FIELDS = ['id', 'company', 'companyName', 'position', 'title', 'location', 'notice', 'url', 'sourceRecordIds', 'origins', 'sourceNames', 'sourceName', 'source', ...FIELDS];
const RETRYABLE = ['blocked', 'unavailable', 'unsupported', 'cancelled', 'failed'];
const LEASE_MS = 5 * 60000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const json = value => JSON.stringify(value);
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch (_) { return fallback; } };
const fail = (message, status = 400, code = 'INVALID_INPUT') => { const { ProductError } = require('./platform'); throw new ProductError(message, status, code); };
const text = (value, limit = 2000) => typeof value === 'string' ? value.trim().slice(0, limit) : '';
const iso = platform => new Date(platform.clock()).toISOString();
function publicUrl(value) {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; } catch (_) { return ''; }
}
function snapshotJob(job) {
  return Object.fromEntries(SNAPSHOT_FIELDS.filter(key => Object.hasOwn(job, key)).map(key => [key, Array.isArray(job[key]) ? job[key].filter(v => typeof v === 'string').slice(0, 100) : ['string', 'number'].includes(typeof job[key]) ? job[key] : null]));
}
function sourceUrl(job) { return publicUrl(job.notice) || publicUrl(job.url); }
function page(input = {}) {
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
  const offset = input.cursor ? Number(Buffer.from(String(input.cursor), 'base64url').toString()) : 0;
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit)) fail('分页参数无效');
  return { limit, offset };
}
function sanitizeAnalysis(result, fetched) {
  let status = ['ok', 'blocked', 'unavailable', 'unsupported', 'mismatch', 'needs_review'].includes(result?.status) ? result.status : 'needs_review';
  if (!['ok', 'accessible', 'manual'].includes(fetched.accessStatus)) status = ['blocked', 'unsupported'].includes(fetched.accessStatus) ? fetched.accessStatus : 'unavailable';
  const identity = { level: ['exact', 'company', 'ambiguous', 'none'].includes(result?.identity?.level) ? result.identity.level : 'none', reason: text(result?.identity?.reason) };
  const facts = {};
  for (const key of FIELDS) {
    const value = result?.facts?.[key];
    if (key === 'salaryMonths') { if (Number.isInteger(value) && value >= 1 && value <= 24) facts[key] = value; }
    else if (typeof value === 'string' && value.trim()) facts[key] = text(value, ['requirements', 'description'].includes(key) ? 12000 : 4000);
  }
  if (facts.salaryCurrency && !/^[A-Z]{3}$/.test(facts.salaryCurrency)) delete facts.salaryCurrency;
  if (facts.salaryPeriod && !['month', 'year', 'week', 'day', 'hour'].includes(facts.salaryPeriod)) delete facts.salaryPeriod;
  const evidence = (Array.isArray(result?.evidence) ? result.evidence : []).slice(0, 100).map(item => ({
    fields: (Array.isArray(item.fields) ? item.fields : []).filter(field => FIELDS.includes(field)),
    quote: text(item.quote, 4000), sourceUrl: publicUrl(item.sourceUrl) || publicUrl(fetched.finalUrl || fetched.url),
    locator: text(item.locator, 500), method: text(item.method, 100),
  })).filter(item => item.fields.length && item.quote && item.sourceUrl);
  const verification = { status: ['open', 'closed', 'unknown'].includes(result?.verification?.status) ? result.verification.status : 'unknown', reason: text(result?.verification?.reason), evidenceUrl: publicUrl(result?.verification?.evidenceUrl), excerpt: text(result?.verification?.excerpt, 4000), checkedAt: fetched.checkedAt };
  // HTTP failure, auth walls and parser mismatch can never constitute closure.
  if (!['ok', 'needs_review'].includes(status) || !['ok', 'accessible'].includes(fetched.accessStatus) || !verification.evidenceUrl || !verification.excerpt) verification.status = 'unknown';
  return { status, identity, facts, evidence, verification };
}

class AnnouncementEnrichment {
  constructor(platform, options = {}) {
    this.platform = platform; this.db = platform.store.db; this.options = options;
    this.workerId = crypto.randomUUID(); this.busy = false; this.stopping = false;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS announcement_runs (
        id TEXT PRIMARY KEY, actor_id TEXT NOT NULL, request_key TEXT NOT NULL, input_hash TEXT NOT NULL,
        status TEXT NOT NULL, retry_count INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        UNIQUE(actor_id,request_key)
      );
      CREATE TABLE IF NOT EXISTS announcement_items (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES announcement_runs(id), job_id TEXT NOT NULL,
        original_job_id TEXT NOT NULL, job_json TEXT NOT NULL, source_url TEXT NOT NULL,
        status TEXT NOT NULL, attempt INTEGER NOT NULL DEFAULT 0, result_json TEXT NOT NULL DEFAULT '{}',
        decision_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS announcement_queue ON announcement_items(status,created_at);
      CREATE TABLE IF NOT EXISTS announcement_fetches (
        run_id TEXT NOT NULL REFERENCES announcement_runs(id), source_url TEXT NOT NULL, result_json TEXT NOT NULL,
        PRIMARY KEY(run_id,source_url)
      );
      CREATE TABLE IF NOT EXISTS announcement_overlays (
        job_id TEXT PRIMARY KEY, facts_json TEXT NOT NULL DEFAULT '{}', fields_json TEXT NOT NULL DEFAULT '{}',
        verification_json TEXT NOT NULL DEFAULT 'null', last_attempt_json TEXT NOT NULL DEFAULT 'null', updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS announcement_audit (
        id INTEGER PRIMARY KEY, event TEXT NOT NULL, actor_id TEXT NOT NULL, run_id TEXT NOT NULL,
        item_id TEXT NOT NULL, job_id TEXT NOT NULL, detail_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS announcement_actions (
        run_id TEXT NOT NULL, request_key TEXT NOT NULL, action TEXT NOT NULL, PRIMARY KEY(run_id,request_key)
      );
      CREATE TABLE IF NOT EXISTS announcement_worker_lease (id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT NOT NULL, expires_ms INTEGER NOT NULL);
      INSERT OR IGNORE INTO announcement_worker_lease VALUES(1,'',0);
    `);
  }
  authorize(actor) { this.platform.requireRole(actor, ['admin', 'content_editor']); }
  audit(event, actor, runId, itemId, jobId, detail) {
    this.db.prepare('INSERT INTO announcement_audit(event,actor_id,run_id,item_id,job_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').run(event, actor?.id || '', runId || '', itemId || '', jobId || '', json(detail), iso(this.platform));
    this.platform._rankings?.clear(); this.platform._qualitySummaries?.clear();
  }
  item(row) {
    if (!row) fail('核验条目不存在', 404, 'NOT_FOUND');
    return { id: row.id, runId: row.run_id, jobId: row.job_id, originalJobId: row.original_job_id, job: parse(row.job_json), sourceUrl: row.source_url, status: row.status, attempt: row.attempt, result: parse(row.result_json), decision: parse(row.decision_json), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  run(id) {
    const row = this.db.prepare('SELECT * FROM announcement_runs WHERE id=?').get(String(id));
    if (!row) fail('核验任务不存在', 404, 'NOT_FOUND');
    const counts = {};
    for (const count of this.db.prepare('SELECT status,COUNT(*) count FROM announcement_items WHERE run_id=? GROUP BY status').all(row.id)) counts[count.status] = count.count;
    return { id: row.id, status: row.status, counts, total: Object.values(counts).reduce((a, b) => a + b, 0), retry: { used: row.retry_count, limit: 3 }, createdAt: row.created_at, updatedAt: row.updated_at };
  }
  detail(id) { return { run: this.run(id), items: this.db.prepare('SELECT * FROM announcement_items WHERE run_id=? ORDER BY created_at,id').all(String(id)).map(row => this.item(row)) }; }
  listRuns(input = {}) {
    const { limit, offset } = page(input);
    const total = this.db.prepare('SELECT COUNT(*) count FROM announcement_runs').get().count;
    const items = this.db.prepare('SELECT id FROM announcement_runs ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => this.run(row.id));
    return { items, total, nextCursor: offset + items.length < total ? Buffer.from(String(offset + items.length)).toString('base64url') : null };
  }
  listAudit(input = {}) {
    const { limit, offset } = page(input);
    const total = this.db.prepare('SELECT COUNT(*) count FROM announcement_audit').get().count;
    const items = this.db.prepare('SELECT * FROM announcement_audit ORDER BY id DESC LIMIT ? OFFSET ?').all(limit, offset).map(row => ({ id: row.id, event: row.event, actorId: row.actor_id, runId: row.run_id, itemId: row.item_id, jobId: row.job_id, detail: parse(row.detail_json), createdAt: row.created_at }));
    return { items, total, nextCursor: offset + items.length < total ? Buffer.from(String(offset + items.length)).toString('base64url') : null };
  }
  adminSummary() {
    const counts = {};
    for (const row of this.db.prepare('SELECT status,COUNT(*) count FROM announcement_items GROUP BY status').all()) counts[row.status] = row.count;
    const active = this.db.prepare("SELECT id FROM announcement_runs WHERE status IN ('queued','running') ORDER BY created_at LIMIT 1").get();
    const overlays = this.db.prepare('SELECT facts_json,verification_json FROM announcement_overlays').all();
    return { summary: { runs: this.db.prepare('SELECT COUNT(*) count FROM announcement_runs').get().count, items: Object.values(counts).reduce((a, b) => a + b, 0), reviewPending: counts.review || 0, counts, enrichedJobs: overlays.filter(row => Object.keys(parse(row.facts_json)).length).length, verifiedJobs: overlays.filter(row => ['open', 'closed'].includes(parse(row.verification_json, null)?.status)).length }, activeRun: active ? this.run(active.id) : null, policy: { maxJobs: 50, automaticAdoption: false, scheduledCrawling: false, manualOverridesWin: true, unavailableMeansClosed: false, maxRetries: 3 } };
  }
  createRun(actor, input = {}) {
    this.authorize(actor);
    if (!Array.isArray(input.jobIds) || !input.jobIds.length || input.jobIds.length > 50 || input.jobIds.some(id => typeof id !== 'string' || !id || id.length > 200)) fail('每次请选择 1 至 50 个公开岗位');
    const key = String(input.idempotencyKey || ''); if (!/^[\w.-]{8,120}$/.test(key)) fail('请提供稳定请求编号', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    const ids = [...new Set(input.jobIds)].sort(); const inputHash = hash(ids);
    return this.platform.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM announcement_runs WHERE actor_id=? AND request_key=?').get(actor.id, key);
      if (previous) { if (previous.input_hash !== inputHash) fail('该请求编号已用于其他岗位', 409, 'IDEMPOTENCY_CONFLICT'); return this.detail(previous.id); }
      if (this.db.prepare("SELECT id FROM announcement_runs WHERE status IN ('queued','running')").get()) fail('已有公告核验任务进行中，请等待或取消', 409, 'ANNOUNCEMENT_RUN_ACTIVE');
      const catalog = this.platform._catalogJobs(); const byId = new Map(catalog.map(job => [String(job.id), job]));
      const jobs = [...new Map(ids.map(id => { const canonical = this.platform._resolveJobId(id, catalog); const job = byId.get(canonical); if (!job) fail('仅可核验当前公开目录岗位', 404, 'JOB_NOT_FOUND'); return [canonical, job]; })).values()];
      const now = iso(this.platform); const id = 'anr_' + crypto.randomUUID();
      this.db.prepare('INSERT INTO announcement_runs(id,actor_id,request_key,input_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, actor.id, key, inputHash, 'queued', now, now);
      for (const job of jobs) {
        const url = this.canonicalUrl(sourceUrl(job));
        this.db.prepare('INSERT INTO announcement_items(id,run_id,job_id,original_job_id,job_json,source_url,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run('ani_' + crypto.randomUUID(), id, String(job.id), String(job.id), json(snapshotJob(job)), url, url ? 'queued' : 'unsupported', now, now);
      }
      this.reconcile(id); this.audit('create', actor, id, '', '', { jobIds: jobs.map(job => job.id) });
      return this.detail(id);
    });
  }
  submitManualEvidence(actor, input = {}) {
    this.authorize(actor);
    const evidenceUrl = this.canonicalUrl(publicUrl(input.evidenceUrl));
    const reason = text(input.reason); const scope = input.scope;
    if (!evidenceUrl || reason.length < 6 || !['job', 'company'].includes(scope)) fail('请提供公开证据链接、明确作用范围 job/company 和至少六字的核对依据');
    if (!input.facts || typeof input.facts !== 'object' || Array.isArray(input.facts) || !Object.keys(input.facts).length || Object.keys(input.facts).some(field => !FIELDS.includes(field))) fail('只能摘录允许的公共岗位事实字段');
    if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.some(entry => !entry || !Array.isArray(entry.fields) || !entry.fields.length || !text(entry.quote) || entry.quote.length > 4000 || !publicUrl(entry.sourceUrl))) fail('每项人工摘录必须有短原文和公开来源链接');
    const now = iso(this.platform);
    const analysis = sanitizeAnalysis({ facts: input.facts, evidence: input.evidence.map(entry => ({ ...entry, method: 'manual-reviewed' })), identity: { level: 'company', reason: `人工摘录（${scope === 'job' ? '岗位条目' : '公司共性要求'}），仍需逐岗位确认。${reason}` }, status: 'needs_review', verification: { status: 'unknown', reason: '人工摘录事实不代表已确认当前招聘开放或关闭' } }, { finalUrl: evidenceUrl, checkedAt: now, accessStatus: 'manual' });
    for (const field of Object.keys(input.facts)) {
      if (!Object.hasOwn(analysis.facts, field) || !analysis.evidence.some(entry => entry.fields.includes(field))) fail(`字段 ${field} 无有效事实或原文证据`, 400, 'EVIDENCE_REQUIRED');
    }
    const identity = { jobId: String(input.jobId || ''), evidenceUrl, facts: analysis.facts, evidence: analysis.evidence, reason, scope };
    const inputHash = hash(identity); const key = input.idempotencyKey === undefined ? `manual-${inputHash}` : String(input.idempotencyKey);
    if (!/^[\w.-]{8,120}$/.test(key)) fail('人工摘录请求编号无效', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    return this.platform.store.transaction(() => {
      const previous = this.db.prepare('SELECT * FROM announcement_runs WHERE actor_id=? AND request_key=?').get(actor.id, key);
      if (previous) { if (previous.input_hash !== inputHash) fail('该请求编号已用于不同证据', 409, 'IDEMPOTENCY_CONFLICT'); return this.detail(previous.id); }
      const catalog = this.platform._catalogJobs(); const jobId = this.platform._resolveJobId(identity.jobId, catalog); const job = catalog.find(value => String(value.id) === jobId);
      if (!job) fail('仅可摘录当前公开目录岗位', 404, 'JOB_NOT_FOUND');
      const id = 'anr_' + crypto.randomUUID(); const itemId = 'ani_' + crypto.randomUUID();
      this.db.prepare('INSERT INTO announcement_runs(id,actor_id,request_key,input_hash,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id, actor.id, key, inputHash, 'complete', now, now);
      const result = { ...analysis, checkedAt: now, sourceUrl: evidenceUrl, accessStatus: 'manual', statusCode: null, contentHash: '', manual: { scope, reason, actorId: actor.id, checkedAt: now } };
      this.db.prepare('INSERT INTO announcement_items(id,run_id,job_id,original_job_id,job_json,source_url,status,result_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(itemId, id, jobId, jobId, json(snapshotJob(job)), evidenceUrl, 'review', json(result), now, now);
      this.audit('manual_evidence', actor, id, itemId, jobId, { scope, reason, evidenceUrl, fields: Object.keys(analysis.facts) });
      return this.detail(id);
    });
  }
  canonicalUrl(url) { if (!url) return ''; const fn = this.options.canonicalAnnouncementUrl; if (fn) return fn(url); try { return require('./announcement-source').canonicalAnnouncementUrl(url); } catch (_) { return url.split('#')[0]; } }
  reconcile(runId) {
    const row = this.db.prepare('SELECT status FROM announcement_runs WHERE id=?').get(runId);
    if (!row || row.status === 'cancelled') return;
    const pending = this.db.prepare("SELECT COUNT(*) count FROM announcement_items WHERE run_id=? AND status IN ('queued','running')").get(runId).count;
    const running = this.db.prepare("SELECT COUNT(*) count FROM announcement_items WHERE run_id=? AND status='running'").get(runId).count;
    this.db.prepare('UPDATE announcement_runs SET status=?,updated_at=? WHERE id=?').run(pending ? running ? 'running' : 'queued' : 'complete', iso(this.platform), runId);
    if (!pending) this.pruneBodies(runId);
  }
  pruneBodies(runId) {
    // The durable artifact is bounded evidence + content hash, not an unbounded
    // mirror of entire websites. Full bodies are cached only while a run needs
    // to match additional roles from the same notice.
    for (const row of this.db.prepare('SELECT source_url,result_json FROM announcement_fetches WHERE run_id=?').all(runId)) {
      const fetched = parse(row.result_json); delete fetched.html; delete fetched.text;
      this.db.prepare('UPDATE announcement_fetches SET result_json=? WHERE run_id=? AND source_url=?').run(json(fetched), runId, row.source_url);
    }
  }
  cancel(actor, id) {
    this.authorize(actor);
    return this.platform.store.transaction(() => {
      const run = this.run(id); if (!['queued', 'running'].includes(run.status)) return this.detail(id);
      this.db.prepare("UPDATE announcement_runs SET status='cancelled',updated_at=? WHERE id=?").run(iso(this.platform), id);
      this.db.prepare("UPDATE announcement_items SET status='cancelled',updated_at=? WHERE run_id=? AND status IN ('queued','running')").run(iso(this.platform), id);
      this.pruneBodies(id);
      this.audit('cancel', actor, id, '', '', {}); return this.detail(id);
    });
  }
  retry(actor, id, input = {}) {
    this.authorize(actor);
    const key = String(input.idempotencyKey || ''); if (!/^[\w.-]{8,120}$/.test(key)) fail('请提供稳定重试编号', 400, 'IDEMPOTENCY_KEY_REQUIRED');
    return this.platform.store.transaction(() => {
      const old = this.db.prepare('SELECT action FROM announcement_actions WHERE run_id=? AND request_key=?').get(id, key);
      if (old) return this.detail(id);
      const run = this.run(id);
      if (this.db.prepare("SELECT id FROM announcement_runs WHERE status IN ('queued','running')").get()) fail('请等待当前任务结束', 409, 'ANNOUNCEMENT_RUN_ACTIVE');
      if (run.retry.used >= 3) fail('单任务最多重试三次，请创建新的人工核验任务', 409, 'RETRY_LIMIT');
      const rows = this.db.prepare('SELECT * FROM announcement_items WHERE run_id=?').all(id).filter(row => RETRYABLE.includes(row.status) && row.source_url);
      if (!rows.length) fail('没有可重试条目；已审核和待审核结果不会被覆盖', 409, 'NOT_RETRYABLE');
      for (const row of rows) {
        this.db.prepare('DELETE FROM announcement_fetches WHERE run_id=? AND source_url=?').run(id, row.source_url);
        this.db.prepare("UPDATE announcement_items SET status='queued',updated_at=? WHERE id=?").run(iso(this.platform), row.id);
      }
      this.db.prepare("UPDATE announcement_runs SET status='queued',retry_count=retry_count+1,updated_at=? WHERE id=?").run(iso(this.platform), id);
      this.db.prepare('INSERT INTO announcement_actions VALUES(?,?,?)').run(id, key, 'retry');
      this.audit('retry', actor, id, '', '', { itemIds: rows.map(row => row.id) }); return this.detail(id);
    });
  }
  approve(actor, id, input = {}) {
    this.authorize(actor);
    const reason = text(input.reason); if (!reason) fail('请填写人工采纳依据');
    return this.platform.store.transaction(() => {
      const row = this.db.prepare('SELECT * FROM announcement_items WHERE id=?').get(id); const item = this.item(row);
      const requested = input.fields === undefined ? Object.keys(item.result.facts || {}) : input.fields;
      if (!Array.isArray(requested) || requested.some(field => !FIELDS.includes(field))) fail('采纳字段无效');
      const selected = [...new Set(requested)].sort(); const includeVerification = input.includeVerification === true;
      const decision = { action: 'approve', fields: selected, includeVerification, reason, confirmIdentity: input.confirmIdentity === true };
      if (item.status === 'approved' && item.decision.inputHash === hash(decision)) return { item, job: this.platform.getJob(item.jobId) };
      if (item.status !== 'review') fail('只能采纳待审核结果，已审核条目不可更改', 409, 'ITEM_FINALIZED');
      if (!['exact', 'company', 'ambiguous'].includes(item.result.identity?.level) || item.result.status === 'mismatch') fail('公告未匹配到该岗位，不得采纳', 409, 'IDENTITY_MISMATCH');
      if (item.result.identity.level !== 'exact' && input.confirmIdentity !== true) fail('请先人工确认公告确实对应此岗位', 409, 'IDENTITY_CONFIRMATION_REQUIRED');
      const catalog = this.platform._catalogJobs(); const canonical = this.platform._resolveJobId(item.jobId, catalog);
      if (!catalog.some(job => String(job.id) === canonical)) fail('岗位已离开公开目录，请先核对最新岗位', 409, 'JOB_UNAVAILABLE');
      const currentJob = catalog.find(job => String(job.id) === canonical);
      if (['company', 'position'].some(key => String(currentJob[key] || '') !== String(item.job[key] || '')) && input.confirmIdentity !== true) fail('目录岗位名称已变更，请人工确认公告对应关系', 409, 'IDENTITY_CONFIRMATION_REQUIRED');
      const now = iso(this.platform); const old = this.db.prepare('SELECT * FROM announcement_overlays WHERE job_id=?').get(canonical);
      const facts = parse(old?.facts_json); const fields = parse(old?.fields_json); let verification = parse(old?.verification_json, null);
      const before = { facts: { ...facts }, verification };
      for (const field of selected) {
        if (!Object.hasOwn(item.result.facts || {}, field)) fail(`没有 ${field} 的提取事实`);
        const evidence = (item.result.evidence || []).filter(entry => entry.fields.includes(field) && entry.quote && entry.sourceUrl);
        if (!evidence.length) fail(`字段 ${field} 缺少原文证据`, 409, 'EVIDENCE_REQUIRED');
        facts[field] = item.result.facts[field]; fields[field] = { value: facts[field], evidence, checkedAt: item.result.checkedAt, itemId: id };
      }
      if (selected.includes('salaryText')) {
        Object.assign(facts, { salaryMin: null, salaryMax: null, salary: '', pay: '', compensation: null });
        for (const key of ['salaryCurrency', 'salaryPeriod', 'salaryMonths']) if (!selected.includes(key)) { facts[key] = key === 'salaryMonths' ? null : ''; delete fields[key]; }
      }
      if (includeVerification) {
        const candidate = item.result.verification;
        if (!candidate || !['open', 'closed'].includes(candidate.status) || !candidate.evidenceUrl || !candidate.excerpt || !['ok', 'accessible'].includes(item.result.accessStatus)) fail('无明确有效公告证据，不能确认招聘开放或关闭', 409, 'VERIFICATION_EVIDENCE_REQUIRED');
        verification = { ...candidate, itemId: id };
      }
      if (!selected.length && !includeVerification) fail('请选择事实字段或明确招聘状态');
      const finalized = { ...decision, inputHash: hash(decision), actorId: actor.id, decidedAt: now };
      this.db.prepare(`INSERT INTO announcement_overlays(job_id,facts_json,fields_json,verification_json,last_attempt_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET facts_json=excluded.facts_json,fields_json=excluded.fields_json,verification_json=excluded.verification_json,updated_at=excluded.updated_at`).run(canonical, json(facts), json(fields), json(verification), old?.last_attempt_json || 'null', now);
      this.db.prepare("UPDATE announcement_items SET job_id=?,status='approved',decision_json=?,updated_at=? WHERE id=?").run(canonical, json(finalized), now, id);
      const lastAttempt = parse(old?.last_attempt_json, null);
      if (lastAttempt?.itemId === id) this.db.prepare('UPDATE announcement_overlays SET last_attempt_json=? WHERE job_id=?').run(json({ ...lastAttempt, adopted: true }), canonical);
      this.audit('approve', actor, item.runId, id, canonical, { before, after: { facts, verification }, decision: finalized });
      return { item: this.item(this.db.prepare('SELECT * FROM announcement_items WHERE id=?').get(id)), job: this.platform.getJob(canonical) };
    });
  }
  reject(actor, id, input = {}) {
    this.authorize(actor); const reason = text(input.reason); if (!reason) fail('请填写拒绝原因');
    return this.platform.store.transaction(() => {
      const item = this.item(this.db.prepare('SELECT * FROM announcement_items WHERE id=?').get(id));
      if (item.status === 'rejected' && item.decision.reason === reason) return { item };
      if (item.status !== 'review') fail('只能拒绝待审核结果', 409, 'ITEM_FINALIZED');
      this.db.prepare("UPDATE announcement_items SET status='rejected',decision_json=?,updated_at=? WHERE id=?").run(json({ action: 'reject', reason, actorId: actor.id, decidedAt: iso(this.platform) }), iso(this.platform), id);
      this.audit('reject', actor, item.runId, id, item.jobId, { reason }); return { item: this.item(this.db.prepare('SELECT * FROM announcement_items WHERE id=?').get(id)) };
    });
  }
  claim() {
    return this.platform.store.transaction(() => {
      const now = this.platform.clock(); const lease = this.db.prepare('SELECT * FROM announcement_worker_lease WHERE id=1').get();
      if (lease.owner && lease.owner !== this.workerId && lease.expires_ms > now) return null;
      if (lease.owner !== this.workerId || lease.expires_ms <= now) this.db.prepare("UPDATE announcement_items SET status='queued' WHERE status='running' AND run_id IN (SELECT id FROM announcement_runs WHERE status IN ('queued','running'))").run();
      this.db.prepare('UPDATE announcement_worker_lease SET owner=?,expires_ms=? WHERE id=1').run(this.workerId, now + LEASE_MS);
      const row = this.db.prepare("SELECT i.* FROM announcement_items i JOIN announcement_runs r ON i.run_id=r.id WHERE i.status='queued' AND r.status IN ('queued','running') ORDER BY i.created_at,i.id LIMIT 1").get();
      if (!row) return null;
      this.db.prepare("UPDATE announcement_items SET status='running',attempt=attempt+1,updated_at=? WHERE id=?").run(iso(this.platform), row.id);
      this.reconcile(row.run_id); return row;
    });
  }
  async tick() {
    if (this.busy || this.stopping) return false; this.busy = true;
    let row;
    try {
      row = this.claim(); if (!row) return false;
      let fetched = parse(this.db.prepare('SELECT result_json FROM announcement_fetches WHERE run_id=? AND source_url=?').get(row.run_id, row.source_url)?.result_json, null);
      if (!fetched) {
        const fetcher = this.options.fetchAnnouncement || require('./announcement-source').fetchAnnouncement;
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 30000);
        try { fetched = await fetcher(row.source_url, { signal: controller.signal }); }
        catch (_) { fetched = { url: row.source_url, finalUrl: row.source_url, accessStatus: 'unavailable', statusCode: 0, checkedAt: iso(this.platform), text: '', html: '' }; }
        finally { clearTimeout(timer); }
        fetched = { url: row.source_url, finalUrl: publicUrl(fetched.finalUrl) || row.source_url, statusCode: Number(fetched.statusCode) || 0, accessStatus: text(fetched.accessStatus, 100) || 'unavailable', reason: text(fetched.reason), checkedAt: Number.isFinite(Date.parse(fetched.checkedAt)) ? new Date(fetched.checkedAt).toISOString() : iso(this.platform), contentHash: text(fetched.contentHash, 100), contentType: text(fetched.contentType, 200), html: text(fetched.html, 2 * 1024 * 1024), text: text(fetched.text, 2 * 1024 * 1024) };
        const current = this.db.prepare('SELECT status,attempt FROM announcement_items WHERE id=?').get(row.id);
        if (current?.status !== 'running' || current.attempt !== row.attempt + 1) return true;
        this.db.prepare('INSERT INTO announcement_fetches VALUES(?,?,?) ON CONFLICT(run_id,source_url) DO UPDATE SET result_json=excluded.result_json').run(row.run_id, row.source_url, json(fetched));
      }
      const analyzer = this.options.analyzeAnnouncement || require('./announcement-source').analyzeAnnouncement;
      const analysis = sanitizeAnalysis(await analyzer({ job: parse(row.job_json), ...fetched }), fetched);
      const result = { ...analysis, checkedAt: fetched.checkedAt, sourceUrl: fetched.finalUrl, accessStatus: fetched.accessStatus, statusCode: fetched.statusCode, contentHash: fetched.contentHash };
      this.finish(row, ['ok', 'needs_review', 'mismatch'].includes(analysis.status) ? 'review' : analysis.status, result);
      return true;
    } catch (error) {
      if (row) this.finish(row, 'failed', { status: 'unavailable', checkedAt: iso(this.platform), sourceUrl: row.source_url, error: 'ANNOUNCEMENT_PROCESSING_FAILED' });
      else throw error;
      return true;
    } finally {
      try {
        if (row && !['queued', 'running'].includes(this.run(row.run_id).status)) this.pruneBodies(row.run_id);
        this.db.prepare("UPDATE announcement_worker_lease SET owner='',expires_ms=0 WHERE id=1 AND owner=?").run(this.workerId);
      } finally { this.busy = false; }
    }
  }
  finish(row, status, result) {
    this.platform.store.transaction(() => {
      const current = this.db.prepare('SELECT * FROM announcement_items WHERE id=?').get(row.id);
      if (current?.status !== 'running' || current.attempt !== row.attempt + 1) return; // A cancelled/old attempt never reopens or overwrites a newer task.
      this.db.prepare('UPDATE announcement_items SET status=?,result_json=?,updated_at=? WHERE id=?').run(status, json(result), iso(this.platform), row.id);
      const attempt = { status: result.status, checkedAt: result.checkedAt, sourceUrl: result.sourceUrl, accessStatus: result.accessStatus || 'unavailable', itemId: row.id, adopted: false };
      this.db.prepare(`INSERT INTO announcement_overlays(job_id,last_attempt_json,updated_at) VALUES(?,?,?) ON CONFLICT(job_id) DO UPDATE SET last_attempt_json=excluded.last_attempt_json,updated_at=excluded.updated_at`).run(current.job_id, json(attempt), iso(this.platform));
      this.audit('checked', null, row.run_id, row.id, current.job_id, { status, attempt }); this.reconcile(row.run_id);
    });
  }
  start() { if (this.timer) return; this.stopping = false; this.timer = setInterval(() => this.tick().catch(() => console.error('ANNOUNCEMENT_WORKER_FAILED')), 1500); this.timer.unref?.(); }
  stop() { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; }
  async drain() { this.stop(); while (this.busy) await new Promise(resolve => setTimeout(resolve, 50)); }
}

function initializeAnnouncements(platform, options = {}) {
  if (!platform.announcements) platform.announcements = new AnnouncementEnrichment(platform, options);
  else if (Object.keys(options).length) Object.assign(platform.announcements.options, options);
  return platform.announcements;
}
function applyAnnouncementOverrides(platform, jobs) {
  initializeAnnouncements(platform);
  const rows = platform.store.db.prepare('SELECT * FROM announcement_overlays').all();
  if (!rows.length) return jobs;
  const byId = new Map(rows.map(row => [row.job_id, row]));
  return jobs.map(job => {
    const row = byId.get(String(job.id)); if (!row || job.isCustom === true) return job;
    return { ...job, ...parse(row.facts_json), announcementReview: { fields: parse(row.fields_json), verification: parse(row.verification_json, null), lastAttempt: parse(row.last_attempt_json, null), updatedAt: row.updated_at } };
  });
}
function announcementVersion(platform) { initializeAnnouncements(platform); return platform.store.db.prepare('SELECT COALESCE(MAX(id),0) version FROM announcement_audit').get().version; }
function remapAnnouncements(platform, aliases) {
  const service = initializeAnnouncements(platform); const db = platform.store.db;
  for (const [oldId, newId] of Object.entries(aliases || {})) {
    if (oldId === newId) continue;
    const old = db.prepare('SELECT * FROM announcement_overlays WHERE job_id=?').get(oldId);
    const next = db.prepare('SELECT * FROM announcement_overlays WHERE job_id=?').get(newId);
    if (old) {
      // Merge independently approved fields by evidence timestamp. Never drop a
      // different-source fact merely because a canonical record already exists.
      const fields = parse(next?.fields_json); const facts = parse(next?.facts_json);
      const oldFields = parse(old.fields_json), oldFacts = parse(old.facts_json);
      const targetFields = { ...fields }, targetFacts = { ...facts };
      for (const [key, entry] of Object.entries(oldFields)) if (!SALARY_FIELDS.includes(key) && (!fields[key] || entry.checkedAt > fields[key].checkedAt)) { fields[key] = entry; facts[key] = entry.value; }
      const groupTime = values => values.salaryText?.checkedAt || Object.entries(values).filter(([key]) => SALARY_FIELDS.includes(key)).map(([, value]) => value.checkedAt || '').sort().at(-1) || '';
      const oldTime = groupTime(oldFields), targetTime = groupTime(targetFields);
      if (oldTime || targetTime) {
        const winnerFields = oldTime > targetTime ? oldFields : targetFields;
        const winnerFacts = oldTime > targetTime ? oldFacts : targetFacts;
        for (const key of SALARY_FIELDS) { delete fields[key]; delete facts[key]; if (Object.hasOwn(winnerFields, key)) fields[key] = winnerFields[key]; if (Object.hasOwn(winnerFacts, key)) facts[key] = winnerFacts[key]; }
      }
      const newer = (a, b) => !a ? b : !b ? a : a.checkedAt > b.checkedAt ? a : b;
      const verification = newer(parse(old.verification_json, null), parse(next?.verification_json, null));
      const latest = newer(parse(old.last_attempt_json, null), parse(next?.last_attempt_json, null));
      db.prepare(`INSERT INTO announcement_overlays VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET facts_json=excluded.facts_json,fields_json=excluded.fields_json,verification_json=excluded.verification_json,last_attempt_json=excluded.last_attempt_json,updated_at=excluded.updated_at`).run(newId, json(facts), json(fields), json(verification), json(latest), iso(platform));
      db.prepare('DELETE FROM announcement_overlays WHERE job_id=?').run(oldId);
    }
    const changed = db.prepare('UPDATE announcement_items SET job_id=? WHERE job_id=?').run(newId, oldId).changes;
    if (old || changed) service.audit('alias', null, '', '', newId, { oldId, newId });
  }
}
function registerAnnouncementRoutes(router, { platform, requireAuth }) {
  const service = initializeAnnouncements(platform);
  const route = fn => (req, res, next) => { try { service.authorize(req.productUser); res.json({ ok: true, ...fn(req) }); } catch (error) { next(error); } };
  router.get('/admin/announcements', requireAuth, route(() => service.adminSummary()));
  router.get('/admin/announcements/audit', requireAuth, route(req => service.listAudit(req.query)));
  router.post('/admin/announcements/manual', requireAuth, route(req => service.submitManualEvidence(req.productUser, req.body)));
  router.get('/admin/announcements/runs', requireAuth, route(req => service.listRuns(req.query)));
  router.post('/admin/announcements/runs', requireAuth, route(req => service.createRun(req.productUser, req.body)));
  router.get('/admin/announcements/runs/:id', requireAuth, route(req => service.detail(req.params.id)));
  router.post('/admin/announcements/runs/:id/cancel', requireAuth, route(req => service.cancel(req.productUser, req.params.id)));
  router.post('/admin/announcements/runs/:id/retry', requireAuth, route(req => service.retry(req.productUser, req.params.id, req.body)));
  router.post('/admin/announcements/items/:id/approve', requireAuth, route(req => service.approve(req.productUser, req.params.id, req.body)));
  router.post('/admin/announcements/items/:id/reject', requireAuth, route(req => service.reject(req.productUser, req.params.id, req.body)));
}

module.exports = { FIELDS, AnnouncementEnrichment, initializeAnnouncements, applyAnnouncementOverrides, announcementVersion, remapAnnouncements, registerAnnouncementRoutes };
