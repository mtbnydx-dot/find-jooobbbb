'use strict';

const { deadlineFact } = require('../cloud/job-facts');
const { normalizeSalary } = require('./matching');

function jobAvailability(job, now = Date.now()) {
  const fact = deadlineFact(job.deadline);
  // The published deadlines are calendar dates in China, inclusive of the last day.
  const today = new Date(Number(now) + 8 * 3600000).toISOString().slice(0, 10);
  return { ...fact, status: fact.date ? (fact.date < today ? 'expired' : 'active') : fact.kind === 'rolling' ? 'rolling' : 'unknown' };
}

function availabilityMatches(job, value, now = Date.now()) {
  const status = jobAvailability(job, now).status;
  return value === 'all' || (value === 'expired' ? status === 'expired' : status !== 'expired');
}

function qualitySummary(jobs, now = Date.now()) {
  const result = { total: jobs.length, active: 0, expired: 0, unknownDeadline: 0, rolling: 0, salaryKnown: 0, salaryCurrencyKnown: 0, updatedAt: '', sources: [] };
  const sources = new Map();
  for (const job of jobs) {
    const availability = jobAvailability(job, now);
    if (availability.status === 'expired') result.expired++;
    else result.active++;
    if (availability.status === 'unknown') result.unknownDeadline++;
    if (availability.status === 'rolling') result.rolling++;
    const salary = normalizeSalary(job);
    if (salary) result.salaryKnown++;
    if (salary && salary.currency !== 'UNKNOWN') result.salaryCurrencyKnown++;
    if (job.lastSeenAt && job.lastSeenAt > result.updatedAt) result.updatedAt = job.lastSeenAt;
    let origins = job.origins;
    if (typeof origins === 'string') { try { origins = JSON.parse(origins); } catch (_) { origins = []; } }
    const names = Array.isArray(origins) ? [...new Set(origins.map(o => typeof o === 'string' ? o : o.name || o.sourceName || o.sourceId).filter(Boolean))] : [];
    for (const name of names.length ? names : ['来源未标注']) {
      if (!sources.has(name)) sources.set(name, { name, records: 0, expired: 0, salaryKnown: 0, lastSeenAt: '' });
      const source = sources.get(name); source.records++;
      if (availability.status === 'expired') source.expired++;
      if (salary) source.salaryKnown++;
      if (job.lastSeenAt > source.lastSeenAt) source.lastSeenAt = job.lastSeenAt;
    }
  }
  result.sources = [...sources.values()].sort((a, b) => b.records - a.records);
  return result;
}

// Only map explicitly named public fields. Never infer a salary from a date, URL,
// recruitment year or an AI estimate, and never copy entire source records.
function enrichSourceFacts(job, records) {
  const result = { ...job };
  const aliases = {
    salaryText: ['薪资', '薪资待遇', '薪酬', '薪酬范围', '薪资范围', '月薪', '年薪', 'salary', 'salaryText', 'compensation'],
    salaryCurrency: ['薪资币种', '币种', 'salaryCurrency'],
    salaryPeriod: ['计薪周期', 'salaryPeriod'],
    benefits: ['福利', '福利待遇', 'benefits'],
    requirements: ['任职要求', '岗位要求', '招聘要求', 'requirements'],
    description: ['岗位职责', '工作职责', '职位描述', 'description'],
    major: ['专业要求', '招聘专业', 'major'],
    degree: ['学历', '学历要求', 'degree'],
    audience: ['招聘对象', '应届生', 'audience'],
    batch: ['批次', '类别', 'batch'],
  };
  for (const [field, names] of Object.entries(aliases)) {
    if (result[field]) continue;
    const found = [];
    for (const record of records) {
      for (const name of names) {
        const value = record[name];
        if (!['string', 'number'].includes(typeof value) || !String(value).trim()) continue;
        let content = String(value).trim().slice(0, field === 'description' || field === 'requirements' ? 12000 : 2000);
        if (field === 'salaryText' && name === '年薪') content += '/年';
        if (field === 'salaryText' && name === '月薪') content += '/月';
        found.push(content);
      }
    }
    if (found.length) result[field] = ['salaryCurrency', 'salaryPeriod'].includes(field) ? found[0] : [...new Set(found)].join('；');
  }
  return result;
}

function initializeQuality(platform) {
  if (platform._qualityInitialized) return;
  platform.store.db.exec(`CREATE TABLE IF NOT EXISTS catalog_fact_overrides (
    job_id TEXT PRIMARY KEY, facts_json TEXT NOT NULL, evidence_url TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '', actor_id TEXT NOT NULL, updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS catalog_fact_audit (
    id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, facts_json TEXT NOT NULL,
    evidence_url TEXT NOT NULL, actor_id TEXT NOT NULL, created_at TEXT NOT NULL
  );`);
  platform._qualityInitialized = true;
}

function applyFactOverrides(platform, jobs) {
  initializeQuality(platform);
  const rows = platform.store.db.prepare('SELECT * FROM catalog_fact_overrides').all();
  if (!rows.length) return jobs;
  const byId = new Map(rows.map(row => [row.job_id, row]));
  return jobs.map(job => {
    const row = byId.get(String(job.id));
    return row ? { ...job, ...JSON.parse(row.facts_json), factReview: { evidenceUrl: row.evidence_url, updatedAt: row.updated_at } } : job;
  });
}

function registerQualityRoutes(router, { platform, requireAuth }) {
  initializeQuality(platform);
  const summary = () => qualitySummary(platform._catalogJobs(), platform.clock());
  router.get('/catalog/quality', (req, res) => res.json({ ok: true, dataQuality: summary() }));
  router.get('/admin/catalog/quality', requireAuth, (req, res, next) => {
    try { platform.requireRole(req.productUser, ['admin', 'content_editor']); res.json({ ok: true, dataQuality: summary(), policy: '明确截止日期过期的岗位默认隐藏；未知日期保留并标注，历史收藏不删除。' }); } catch (error) { next(error); }
  });
  router.put('/admin/catalog/jobs/:id/facts', requireAuth, (req, res, next) => {
    try {
      const { ProductError } = require('./platform');
      platform.requireRole(req.productUser, ['admin', 'content_editor']);
      platform.getJob(req.params.id);
      const input = req.body || {};
      let evidence;
      try { evidence = new URL(input.evidenceUrl); } catch (_) { throw new ProductError('请提供可核验的公开来源链接', 400, 'EVIDENCE_REQUIRED'); }
      if (!['https:', 'http:'].includes(evidence.protocol) || evidence.username || evidence.password) throw new ProductError('来源链接无效', 400, 'INVALID_INPUT');
      const facts = {};
      for (const key of ['salaryText', 'salaryCurrency', 'salaryPeriod', 'deadline', 'benefits', 'requirements', 'description']) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string' || input[key].length > 12000) throw new ProductError('字段必须为限定长度文本', 400, 'INVALID_INPUT');
        facts[key] = input[key].trim();
      }
      if (!Object.keys(facts).length) throw new ProductError('请至少提交一个事实字段', 400, 'INVALID_INPUT');
      if (Object.hasOwn(facts, 'salaryText')) Object.assign(facts, { salaryMin: null, salaryMax: null, salary: '', pay: '', compensation: null });
      if (facts.salaryCurrency && !/^[A-Z]{3}$/.test(facts.salaryCurrency)) throw new ProductError('薪资币种请使用 CNY、AUD 等三位代码', 400, 'INVALID_INPUT');
      if (facts.salaryPeriod && !['month', 'year', 'week', 'hour'].includes(facts.salaryPeriod)) throw new ProductError('计薪周期无效', 400, 'INVALID_INPUT');
      const previous = platform.store.db.prepare('SELECT facts_json FROM catalog_fact_overrides WHERE job_id=?').get(req.params.id);
      const merged = { ...JSON.parse(previous?.facts_json || '{}'), ...facts };
      const now = new Date(platform.clock()).toISOString();
      const db = platform.store.db;
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT INTO catalog_fact_overrides VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET facts_json=excluded.facts_json,evidence_url=excluded.evidence_url,note=excluded.note,actor_id=excluded.actor_id,updated_at=excluded.updated_at')
          .run(req.params.id, JSON.stringify(merged), evidence.href, String(input.note || '').slice(0, 2000), req.productUser.id, now);
        db.prepare('INSERT INTO catalog_fact_audit(job_id,facts_json,evidence_url,actor_id,created_at) VALUES(?,?,?,?,?)').run(req.params.id, JSON.stringify(merged), evidence.href, req.productUser.id, now);
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
      platform._rankings?.clear();
      res.json({ ok: true, job: platform.getJob(req.params.id), dataQuality: summary() });
    } catch (error) { next(error); }
  });
}

module.exports = { jobAvailability, availabilityMatches, qualitySummary, enrichSourceFacts, applyFactOverrides, initializeQuality, registerQualityRoutes };
