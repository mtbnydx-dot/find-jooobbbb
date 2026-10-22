'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { AnnouncementEnrichment, initializeAnnouncements } = require('../server/product/announcement-enrichment');
const { jobHash } = require('../server/product/personal-ai');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-announcements-'));
  let now = Date.parse('2026-10-23T08:00:00Z'); let fetchCount = 0; let analyzeCount = 0;
  const snapshot = { version: 'published-1', aliases: {}, jobs: [
    { id: 'a', company: '星光公司', position: '软件工程师', notice: 'https://example.com/jobs?utm_source=one', deadline: '长期招聘', sourceRecordIds: ['fs:1', 'qq:2'], origins: '["飞书","腾讯"]' },
    { id: 'b', company: '星光公司', position: '财务', notice: 'https://example.com/jobs?utm_source=two', deadline: '长期招聘' },
    { id: 'c', company: '第二公司', position: '人事', url: 'https://example.com/other', deadline: '长期招聘' },
  ] };
  const platform = new ProductPlatform({ dataDir: directory, clock: () => now, jobService: { snapshot: () => snapshot } }).initialize();
  const admin = await platform.register({ email: 'admin@example.com', password: 'Testing-password-123' });
  platform.store.setUserRole(admin.user.id, 'admin'); admin.user = platform.store.getUser(admin.user.id);
  const user = await platform.register({ email: 'user@example.com', password: 'Testing-password-123' });
  const options = {
    fetchAnnouncement: async url => { fetchCount++; return { url, finalUrl: url, statusCode: 200, accessStatus: 'ok', text: '公开岗位原文', checkedAt: new Date(now).toISOString(), contentHash: 'hash-' + now }; },
    analyzeAnnouncement: async ({ job, checkedAt, finalUrl }) => { analyzeCount++; return { status: 'ok', identity: { level: 'exact', reason: '岗位名称和公司匹配' }, facts: { major: job.id === 'b' ? '会计学' : '计算机类', experience: '三年以上经验', salaryText: '15K-20K/月', salaryCurrency: 'CNY', salaryPeriod: 'month' }, evidence: [{ fields: ['major', 'experience', 'salaryText', 'salaryCurrency', 'salaryPeriod'], quote: '软件工程师：计算机类，三年以上经验，15000-20000元/月', sourceUrl: finalUrl, locator: 'section', method: 'label' }], verification: { status: 'open', reason: '明确招聘开放', evidenceUrl: finalUrl, excerpt: '该岗位正在招聘', checkedAt } }; },
  };
  const service = initializeAnnouncements(platform, options);
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const call = async (route, { account = admin, method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method, headers: { ...(account ? { Authorization: `Bearer ${account.token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { statusCode: response.status, ...await response.json() };
  };
  t.after(async () => { await service.drain(); await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const run = ids => service.createRun(admin.user, { jobIds: ids, idempotencyKey: 'request-' + crypto.randomUUID() });
  return { platform, service, options, admin, user, snapshot, call, run, counts: () => ({ fetchCount, analyzeCount }), advance: ms => { now += ms; }, now: () => now };
}

test('manual salary replacement cannot inherit units from a previous announcement or correction', async t => {
  const f = await fixture(t); const { run } = f.run(['a']); await f.service.tick();
  f.service.approve(f.admin.user, f.service.detail(run.id).items[0].id, { reason: '核对完整薪资组' });
  const first = await f.call('/admin/catalog/jobs/a/facts', { method:'PUT', body:{ salaryText:'90000', salaryCurrency:'AUD', salaryPeriod:'year', evidenceUrl:'https://example.com/a' } });
  assert.equal(first.statusCode,200);
  const next = await f.call('/admin/catalog/jobs/a/facts', { method:'PUT', body:{ salaryText:'薪资面议', evidenceUrl:'https://example.com/new' } });
  assert.equal(next.statusCode,200); const job = f.platform.getJob('a');
  assert.equal(job.salaryText,'薪资面议'); assert.equal(job.salaryCurrency,''); assert.equal(job.salaryPeriod,''); assert.equal(job.salaryMonths,null);
});

test('announcement runs are admin-only, explicit, bounded, idempotent and exclude private custom jobs', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/admin/announcements', { account: null })).statusCode, 401);
  assert.equal((await f.call('/admin/announcements', { account: f.user })).statusCode, 403);
  assert.equal(f.service.adminSummary().summary.runs, 0);
  f.platform.listJobs(); f.platform.getJob('a'); assert.deepEqual(f.counts(), { fetchCount: 0, analyzeCount: 0 });
  const input = { jobIds: ['a', 'b'], idempotencyKey: 'stable-request' };
  const first = f.service.createRun(f.admin.user, input);
  assert.equal(f.service.createRun(f.admin.user, input).run.id, first.run.id);
  assert.throws(() => f.service.createRun(f.admin.user, { ...input, jobIds: ['c'] }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  assert.throws(() => f.service.createRun(f.admin.user, { jobIds: Array(51).fill('a'), idempotencyKey: 'invalid-limit' }), e => e.statusCode === 400);
  f.service.cancel(f.admin.user, first.run.id);
  f.platform.store.db.prepare('INSERT INTO user_custom_jobs(user_id,job_id,job_json,migrated_at) VALUES(?,?,?,?)').run(f.user.user.id, 'private-one', JSON.stringify({ id: 'private-one', company: '私人备注公司', position: '隐私岗位', source: '自选' }), new Date(f.now()).toISOString());
  assert.throws(() => f.run(['private-one']), e => e.code === 'JOB_NOT_FOUND');
  assert.equal((await f.call('/admin/announcements')).policy.automaticAdoption, false);
});

test('same notice fetches once but matches each role separately, preserving review-only behavior and provenance', async t => {
  const f = await fixture(t); const { run } = f.run(['a', 'b']);
  await f.service.tick(); await f.service.tick();
  assert.deepEqual(f.counts(), { fetchCount: 1, analyzeCount: 2 });
  const detail = f.service.detail(run.id); assert.equal(detail.run.status, 'complete'); assert.equal(detail.run.counts.review, 2);
  assert.equal(f.platform.getJob('a').major, undefined);
  const a = detail.items.find(item => item.jobId === 'a'); const b = detail.items.find(item => item.jobId === 'b');
  assert.deepEqual(a.job.sourceRecordIds, ['fs:1', 'qq:2']); assert.equal(a.result.facts.major, '计算机类'); assert.equal(b.result.facts.major, '会计学');
  assert.equal(Object.hasOwn(a.result, 'html'), false);
  const approved = f.service.approve(f.admin.user, a.id, { reason: '人工逐项对照公告', includeVerification: true });
  assert.equal(approved.job.major, '计算机类'); assert.equal(approved.job.compensation.period, 'month');
  assert.equal(approved.job.announcementReview.fields.major.evidence[0].sourceUrl, 'https://example.com/jobs');
  assert.equal(approved.job.announcementReview.lastAttempt.adopted, true);
  assert.equal(f.platform.getJob('b').major, undefined);
  const persistedFetch = JSON.parse(f.platform.store.db.prepare('SELECT result_json FROM announcement_fetches WHERE run_id=?').get(run.id).result_json);
  assert.equal(persistedFetch.html, undefined); assert.equal(persistedFetch.text, undefined); assert.ok(persistedFetch.contentHash);
  assert.equal(f.service.approve(f.admin.user, a.id, { reason: '人工逐项对照公告', includeVerification: true }).item.id, a.id);
  assert.throws(() => f.service.reject(f.admin.user, a.id, { reason: '试图修改定稿' }), e => e.code === 'ITEM_FINALIZED');
});

test('adoption invalidates pagination and AI hashes but preserves personal profile/state and manual facts', async t => {
  const f = await fixture(t);
  f.platform.updateJobState(f.user.user, 'a', { saved: true, status: 'applied', note: '个人私密记录' });
  const beforeState = JSON.stringify(f.platform.store.listJobStates(f.user.user.id)); const beforeProfile = JSON.stringify(f.platform.getProfile(f.user.user.id));
  const beforeHash = jobHash(f.platform._catalogJobs().find(job => job.id === 'a'));
  const { run } = f.run(['a']); await f.service.tick();
  const page = f.platform.listJobs({ limit: 1 });
  const item = f.service.detail(run.id).items[0]; f.service.approve(f.admin.user, item.id, { reason: '核对事实' });
  assert.throws(() => f.platform.listJobs({ cursor: page.nextCursor, limit: 1 }), e => e.code === 'CURSOR_STALE');
  assert.notEqual(jobHash(f.platform._catalogJobs().find(job => job.id === 'a')), beforeHash);
  assert.equal(JSON.stringify(f.platform.store.listJobStates(f.user.user.id)), beforeState);
  assert.equal(JSON.stringify(f.platform.getProfile(f.user.user.id)), beforeProfile);
  assert.equal((await f.call('/admin/catalog/jobs/a/facts', { method: 'PUT', body: { salaryText: '30000元/月', salaryCurrency: 'CNY', salaryPeriod: 'month', evidenceUrl: 'https://example.com/human' } })).statusCode, 200);
  const job = f.platform.getJob('a'); assert.equal(job.salaryText, '30000元/月'); assert.equal(job.major, '计算机类');
  assert.equal(job.factReview.evidenceUrl, 'https://example.com/human');
});

test('failed recheck preserves last approved facts and old checkedAt, never closes rolling recruitment', async t => {
  const f = await fixture(t); const first = f.run(['a']); await f.service.tick();
  f.service.approve(f.admin.user, f.service.detail(first.run.id).items[0].id, { reason: '首次核验', includeVerification: true });
  const checkedAt = f.platform.getJob('a').announcementReview.verification.checkedAt;
  f.advance(86400000);
  f.service.options.fetchAnnouncement = async url => ({ url, finalUrl: url, statusCode: 404, accessStatus: 'unavailable', checkedAt: new Date(f.now()).toISOString() });
  f.service.options.analyzeAnnouncement = async ({ finalUrl, checkedAt }) => ({ status: 'unavailable', facts: { major: '不可信新字段' }, identity: { level: 'none' }, verification: { status: 'closed', evidenceUrl: finalUrl, excerpt: '404', checkedAt } });
  const second = f.run(['a']); await f.service.tick();
  const item = f.service.detail(second.run.id).items[0]; assert.equal(item.status, 'unavailable'); assert.equal(item.result.verification.status, 'unknown');
  const job = f.platform.getJob('a'); assert.equal(job.major, '计算机类'); assert.equal(job.announcementReview.verification.checkedAt, checkedAt);
  assert.equal(job.announcementReview.lastAttempt.accessStatus, 'unavailable'); assert.notEqual(job.announcementReview.lastAttempt.checkedAt, checkedAt);
  assert.equal(job.availability.status, 'rolling');
  assert.throws(() => f.service.approve(f.admin.user, item.id, { reason: '不应通过' }), e => e.code === 'ITEM_FINALIZED');
});

test('ambiguous identity needs explicit confirmation, absent source evidence is refused, and closure requires evidence', async t => {
  const f = await fixture(t); const analyze = f.options.analyzeAnnouncement;
  f.service.options.analyzeAnnouncement = async input => ({ ...await analyze(input), identity: { level: 'company', reason: '同公司多岗位' } });
  const first = f.run(['a']); await f.service.tick(); const item = f.service.detail(first.run.id).items[0];
  assert.throws(() => f.service.approve(f.admin.user, item.id, { reason: '未确认' }), e => e.code === 'IDENTITY_CONFIRMATION_REQUIRED');
  f.service.approve(f.admin.user, item.id, { fields: ['experience'], reason: '人工确认该岗位条目', confirmIdentity: true });
  f.service.options.analyzeAnnouncement = async input => ({ ...await analyze(input), evidence: [], verification: { status: 'closed', reason: '没有引用原文' } });
  const second = f.run(['b']); await f.service.tick(); const noEvidence = f.service.detail(second.run.id).items[0];
  assert.throws(() => f.service.approve(f.admin.user, noEvidence.id, { reason: '无证据' }), e => e.code === 'EVIDENCE_REQUIRED');
  assert.throws(() => f.service.approve(f.admin.user, noEvidence.id, { fields: [], includeVerification: true, reason: '无证据' }), e => e.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  f.service.options.analyzeAnnouncement = async input => { const result = await analyze(input); result.verification.status = 'closed'; result.verification.excerpt = '该岗位招聘已结束'; return result; };
  const third = f.run(['c']); await f.service.tick();
  f.service.approve(f.admin.user, f.service.detail(third.run.id).items[0].id, { fields: [], includeVerification: true, reason: '人工核验停止招聘公告' });
  assert.equal(f.platform.getJob('c').availability.status, 'expired');
  assert.equal(f.platform.listJobs().items.some(job => job.id === 'c'), false);
  assert.equal((await f.call('/admin/catalog/jobs/c/facts', { method: 'PUT', body: { deadline: '2026-12-31', major: '管理类', experience: '一年经验', evidenceUrl: 'https://example.com/correction' } })).statusCode, 200);
  assert.equal(f.platform.getJob('c').availability.status, 'active'); assert.equal(f.platform.getJob('c').major, '管理类');
});

test('in-flight cancellation stays cancelled; retry is idempotent and never reopens approved items', async t => {
  const f = await fixture(t); let release; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.service.options.fetchAnnouncement = url => new Promise(resolve => { release = () => resolve({ url, finalUrl: url, statusCode: 200, accessStatus: 'ok', text: '正文', checkedAt: new Date(f.now()).toISOString() }); entered(); });
  const first = f.run(['a']); const pending = f.service.tick(); await started;
  f.service.cancel(f.admin.user, first.run.id); release(); await pending;
  assert.equal(f.service.detail(first.run.id).items[0].status, 'cancelled'); assert.equal(f.platform.getJob('a').major, undefined);
  f.service.options.fetchAnnouncement = f.options.fetchAnnouncement = async url => ({ url, finalUrl: url, statusCode: 200, accessStatus: 'ok', text: '正文', checkedAt: new Date(f.now()).toISOString() });
  const retry = { idempotencyKey: 'retry-attempt-one' };
  assert.equal(f.service.retry(f.admin.user, first.run.id, retry).run.retry.used, 1);
  assert.equal(f.service.retry(f.admin.user, first.run.id, retry).run.retry.used, 1);
  await f.service.tick(); const item = f.service.detail(first.run.id).items[0]; f.service.approve(f.admin.user, item.id, { reason: '核对重试结果' });
  assert.throws(() => f.service.retry(f.admin.user, first.run.id, { idempotencyKey: 'retry-attempt-two' }), e => e.code === 'NOT_RETRYABLE');
});

test('worker lease prevents concurrent takeover and stale restart resumes only queued work', async t => {
  const f = await fixture(t); const { run } = f.run(['a']);
  f.service.claim();
  const restarted = new AnnouncementEnrichment(f.platform, f.options);
  assert.equal(await restarted.tick(), false);
  assert.equal(f.service.detail(run.id).items[0].status, 'running');
  f.advance(5 * 60000 + 1);
  assert.equal(await restarted.tick(), true);
  assert.equal(restarted.detail(run.id).items[0].status, 'review');
  assert.equal(f.counts().fetchCount, 1);
});

test('alias remap keeps evidence, original IDs, approved fields and personal state atomically', async t => {
  const f = await fixture(t); f.platform.updateJobState(f.user.user, 'a', { saved: true, note: '不丢失' });
  const { run } = f.run(['a']); await f.service.tick(); const item = f.service.detail(run.id).items[0]; f.service.approve(f.admin.user, item.id, { reason: '核验' });
  f.snapshot.jobs[0] = { ...f.snapshot.jobs[0], id: 'new-a' }; f.snapshot.aliases.a = 'new-a';
  f.platform.remapJobAliases({ a: 'new-a' });
  const updated = f.service.detail(run.id).items[0]; assert.equal(updated.jobId, 'new-a'); assert.equal(updated.originalJobId, 'a');
  assert.deepEqual(updated.job.sourceRecordIds, ['fs:1', 'qq:2']); assert.equal(f.platform.getJob('a').major, '计算机类');
  assert.equal(f.platform.store.listJobStates(f.user.user.id)[0].note, '不丢失');
  const audit = f.platform.store.db.prepare("SELECT COUNT(*) count FROM announcement_audit WHERE event='alias'").get().count;
  assert.equal(audit, 1);
  f.platform.store.db.exec(`CREATE TRIGGER reject_announcement_alias BEFORE UPDATE OF job_id ON announcement_items WHEN NEW.job_id='bad-id' BEGIN SELECT RAISE(ABORT,'probe'); END`);
  assert.throws(() => f.platform.remapJobAliases({ 'new-a': 'bad-id' }), /probe/);
  assert.equal(f.platform.store.listJobStates(f.user.user.id)[0].jobId, 'new-a');
  assert.equal(f.platform.getJob('new-a').major, '计算机类');
});

test('new salary text cannot inherit old year/currency/months and reject never mutates catalog', async t => {
  const f = await fixture(t); f.snapshot.jobs[0].salaryText = '20万/年'; f.snapshot.jobs[0].salaryCurrency = 'AUD'; f.snapshot.jobs[0].salaryPeriod = 'year'; f.snapshot.jobs[0].salaryMonths = 14;
  const { run } = f.run(['a', 'b']); await f.service.tick(); await f.service.tick();
  const items = f.service.detail(run.id).items; f.service.approve(f.admin.user, items.find(i => i.jobId === 'a').id, { fields: ['salaryText'], reason: '只确认原文薪资，其他未知' });
  const job = f.platform.getJob('a'); assert.equal(job.salaryCurrency, ''); assert.equal(job.salaryPeriod, ''); assert.equal(job.salaryMonths, null); assert.equal(job.compensation.currency, 'UNKNOWN'); assert.equal(job.compensation.period, 'month');
  const b = items.find(i => i.jobId === 'b'); f.service.reject(f.admin.user, b.id, { reason: '不对应岗位' });
  assert.equal(f.platform.getJob('b').salaryText, undefined); assert.equal(f.service.reject(f.admin.user, b.id, { reason: '不对应岗位' }).item.status, 'rejected');
});

test('manual PDF excerpts remain review-only, require per-field evidence and identity confirmation, and are idempotent', async t => {
  const f = await fixture(t);
  const input = { jobId: 'a', evidenceUrl: 'https://example.com/official.pdf', scope: 'company', reason: '已阅读官方校招公告，适用于本批次公司岗位', facts: { major: '计算机、软件工程相关专业', experience: '接受应届毕业生' }, evidence: [{ fields: ['major', 'experience'], quote: '招聘专业：计算机、软件工程；招聘对象：应届毕业生', sourceUrl: 'https://example.com/official.pdf' }] };
  assert.equal((await f.call('/admin/announcements/manual', { account: f.user, method: 'POST', body: input })).statusCode, 403);
  assert.throws(() => f.service.submitManualEvidence(f.admin.user, { ...input, evidence: [] }), /原文/);
  assert.throws(() => f.service.submitManualEvidence(f.admin.user, { ...input, facts: { ...input.facts, note: '私人内容' } }), /公共/);
  assert.throws(() => f.service.submitManualEvidence(f.admin.user, { ...input, facts: { major: '计算机', degree: '本科' } }), e => e.code === 'EVIDENCE_REQUIRED');
  const response = await f.call('/admin/announcements/manual', { method: 'POST', body: input });
  assert.equal(response.statusCode, 200); const item = response.items[0];
  assert.equal(f.service.submitManualEvidence(f.admin.user, input).run.id, response.run.id);
  assert.equal(item.status, 'review'); assert.equal(item.result.accessStatus, 'manual'); assert.equal(item.result.evidence[0].method, 'manual-reviewed'); assert.equal(item.result.verification.status, 'unknown');
  assert.deepEqual(f.counts(), { fetchCount: 0, analyzeCount: 0 }); assert.equal(f.platform.getJob('a').major, undefined);
  assert.throws(() => f.service.approve(f.admin.user, item.id, { reason: '人工初审' }), e => e.code === 'IDENTITY_CONFIRMATION_REQUIRED');
  assert.throws(() => f.service.approve(f.admin.user, item.id, { fields: [], includeVerification: true, reason: '人工核对', confirmIdentity: true }), e => e.code === 'VERIFICATION_EVIDENCE_REQUIRED');
  const result = f.service.approve(f.admin.user, item.id, { reason: '已核对岗位属于本批招聘适用范围', confirmIdentity: true });
  assert.equal(result.job.experience, '接受应届毕业生'); assert.equal(result.job.announcementReview.fields.major.checkedAt, new Date(f.now()).toISOString());
  const audit = await f.call('/admin/announcements/audit?limit=1'); assert.equal(audit.total, 2); assert.ok(audit.nextCursor); assert.equal(audit.items[0].event, 'approve');
});

test('transport failures cannot be promoted by a faulty parser; retries stay capped and drain preserves response', async t => {
  const f = await fixture(t);
  f.service.options.fetchAnnouncement = async url => ({ url, finalUrl: url, statusCode: 403, accessStatus: 'blocked', checkedAt: new Date(f.now()).toISOString() });
  const { run } = f.run(['a']); await f.service.tick();
  assert.equal(f.service.detail(run.id).items[0].status, 'blocked');
  for (let attempt = 1; attempt <= 3; attempt++) {
    f.service.retry(f.admin.user, run.id, { idempotencyKey: 'retry-capped-' + attempt }); await f.service.tick();
  }
  assert.throws(() => f.service.retry(f.admin.user, run.id, { idempotencyKey: 'retry-capped-four' }), e => e.code === 'RETRY_LIMIT');
  let release; let enter;
  const entered = new Promise(resolve => { enter = resolve; });
  f.service.options.fetchAnnouncement = url => new Promise(resolve => { release = () => resolve({ url, finalUrl: url, statusCode: 200, accessStatus: 'ok', checkedAt: new Date(f.now()).toISOString() }); enter(); });
  const second = f.run(['b']); const pending = f.service.tick(); await entered;
  const draining = f.service.drain(); release(); await pending; await draining;
  assert.equal(f.service.detail(second.run.id).items[0].status, 'review'); assert.equal(await f.service.tick(), false);
});

test('manual fact alias remaps preserve canonical reviews as an evidence group, archive conflicts and roll back atomically', async t => {
  const f = await fixture(t);
  const put = (id, facts, url) => f.call(`/admin/catalog/jobs/${id}/facts`, { method: 'PUT', body: { ...facts, evidenceUrl: url } });
  await put('a', { major: '计算机类', experience: '三年经验' }, 'https://example.com/old');
  const original = f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('a');
  const originalAudit = f.platform.store.db.prepare('SELECT * FROM catalog_fact_audit').all();
  f.snapshot.jobs[0] = { ...f.snapshot.jobs[0], id: 'moved-a' }; f.snapshot.aliases.a = 'moved-a';
  f.platform.remapJobAliases({ a: 'moved-a' });
  const migrated = f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('moved-a');
  assert.deepEqual({ ...migrated, job_id: 'a' }, { ...original });
  await put('b', { major: '财务管理', deadline: '2027-01-01' }, 'https://example.com/canonical');
  const canonical = f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('b');
  f.platform.remapJobAliases({ 'moved-a': 'b' });
  assert.deepEqual(f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('b'), canonical);
  assert.equal(f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('moved-a'), undefined);
  const archived = f.platform.store.db.prepare("SELECT * FROM catalog_fact_alias_audit WHERE resolution='canonical_preserved'").get();
  assert.equal(JSON.parse(archived.old_override_json).evidence_url, 'https://example.com/old');
  assert.equal(JSON.parse(archived.canonical_override_json).evidence_url, 'https://example.com/canonical');
  assert.deepEqual(f.platform.store.db.prepare('SELECT * FROM catalog_fact_audit WHERE id=?').get(originalAudit[0].id), originalAudit[0]);
  f.platform.updateJobState(f.user.user, 'b', { saved: true });
  f.platform.store.db.exec("CREATE TRIGGER alias_review_fail BEFORE INSERT ON catalog_fact_alias_audit WHEN NEW.new_id='broken' BEGIN SELECT RAISE(ABORT,'review rollback'); END");
  assert.throws(() => f.platform.remapJobAliases({ b: 'broken' }), /review rollback/);
  assert.equal(f.platform.store.listJobStates(f.user.user.id)[0].jobId, 'b');
  assert.deepEqual(f.platform.store.db.prepare('SELECT * FROM catalog_fact_overrides WHERE job_id=?').get('b'), canonical);
});

test('announcement alias migration keeps salary evidence atomic and cannot attach old units to newer text', async t => {
  const f = await fixture(t);
  const manual = (jobId, facts) => f.service.submitManualEvidence(f.admin.user, { jobId, facts, evidenceUrl: 'https://example.com/' + jobId, evidence: [{ fields: Object.keys(facts), quote: JSON.stringify(facts), sourceUrl: 'https://example.com/' + jobId }], scope: 'job', reason: '已核实同一公告本岗位明确薪资' });
  const target = manual('b', { salaryText: '200000-300000 AUD/year', salaryCurrency: 'AUD', salaryPeriod: 'year', salaryMonths: 14 });
  f.service.approve(f.admin.user, target.items[0].id, { reason: '旧薪资核验', confirmIdentity: true });
  f.advance(86400000);
  const source = manual('a', { salaryText: '15000-20000/月' });
  f.service.approve(f.admin.user, source.items[0].id, { reason: '新薪资仅金额明示单位未知', confirmIdentity: true });
  f.platform.remapJobAliases({ a: 'b' });
  const job = f.platform.getJob('b');
  assert.equal(job.salaryText, '15000-20000/月'); assert.equal(job.salaryCurrency, ''); assert.equal(job.salaryPeriod, ''); assert.equal(job.salaryMonths, null);
  assert.equal(job.compensation.period, 'month'); assert.equal(job.compensation.currency, 'UNKNOWN');
  assert.deepEqual(Object.keys(job.announcementReview.fields), ['salaryText']);
});
