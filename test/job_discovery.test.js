'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { normalizeJobFilters } = require('../server/product/job-filters');
const { jobPassesFilters, searchJob, matchJob, normalizeSalary, salaryForPeriod } = require('../server/product/matching');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-discovery-'));
  let now = Date.parse('2026-10-23T08:00:00Z');
  const snapshot = { jobs: [
    { id: 'a_low', company: '开发企业', position: '软件开发', location: '上海', industry: '科技', nature: '国企', origins: '["飞书主表","腾讯文档"]', salaryText: '15K-20K', salaryCurrency: 'CNY', degree: '本科', deadline: '2026-10-30', firstSeenAt: '2026-10-01', lastSeenAt: '2026-10-23', url: '详见公告', notice: 'https://example.com/notice' },
    { id: 'b_high', company: '创新企业', position: '软件开发', location: '杭州', industry: '科技', nature: '民企', origins: '["腾讯文档"]', salaryText: '30-40万', salaryPeriod: 'year', salaryCurrency: 'CNY', degree: '硕士及以上', deadline: '2026-11-20', firstSeenAt: '2026-10-20', lastSeenAt: '2026-10-21' },
    { id: 'c_unknown', company: '成长企业', position: '销售', description: '与软件开发团队协作', location: '上海', industry: '科技', nature: '民企', origins: '["飞书主表"]', deadline: '长期招聘', firstSeenAt: '2026-10-21' },
    { id: 'd_expired', company: '历史企业', position: '软件开发', location: '北京', deadline: '2026-10-22', firstSeenAt: '2026-10-22' },
  ], aliases: {} };
  const platform = new ProductPlatform({ dataDir, clock: () => now, jobService: { snapshot: () => snapshot } }).initialize();
  const one = await platform.register({ email: 'discovery-one@example.com', password: 'test-password-123' });
  const two = await platform.register({ email: 'discovery-two@example.com', password: 'test-password-123' });
  platform.updateProfile(one.user, { educationLevel: '本科', targetRoles: ['软件开发'], majors: ['计算机科学'], timeZone: 'Asia/Shanghai' });
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  const call = async (route, { token = one.token, method = 'GET', body } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  return { platform, one, two, snapshot, call, advance: ms => { now += ms; } };
}

test('job filter normalization is shared, canonical and rejects malformed bounds and unsupported choices', () => {
  const filters = normalizeJobFilters({ currency: 'rmb', salaryMin: '10000', salaryPeriod: 'annual', location: ['上海', '杭州'], minMatch: '40', deadlineWithin: 7 });
  assert.equal(filters.currency, 'CNY'); assert.equal(filters.salaryMin, 10000); assert.equal(filters.salaryPeriod, 'year');
  assert.equal(filters.location, '上海,杭州'); assert.equal(filters.view, 'all'); assert.equal(filters.qualification, 'all');
  assert.equal(filters.minMatch, 40); assert.equal(filters.deadlineWithin, '7');
  assert.equal(normalizeJobFilters({ salaryMin: 100 }, { currencyFallback: 'AUD' }).currency, 'AUD');
  for (const input of [{ salaryMin: -1 }, { salaryMin: 'garbage' }, { salaryMin: 20, salaryMax: 10 }, { minMatch: 101 }, { view: 'ai' }, { sort: 'sql' }, { deadlineWithin: 14 }, { currency: 'nonsense' }, { salaryPeriod: 'tomorrow' }, { q: {} }]) {
    assert.throws(() => normalizeJobFilters(input), error => error.statusCode === 400 && error.code === 'INVALID_INPUT');
  }
  assert.throws(() => normalizeJobFilters({ salaryMin: 100 }, { requireSalaryCurrency: true }), /币种/);
});

test('multiword search uses AND and quoted phrases, and prioritizes title/company over descriptions', () => {
  const job = { position: '软件开发', location: '上海', company: '星光企业' };
  assert.equal(jobPassesFilters(job, { q: '上海 开发' }), true);
  assert.equal(jobPassesFilters(job, { q: '开发 上海' }), true);
  assert.equal(jobPassesFilters(job, { q: '上海 北京' }), false);
  assert.equal(jobPassesFilters(job, { q: '"软件开发" 上海' }), true);
  assert.equal(jobPassesFilters(job, { q: '"上海 开发"' }), false);
  assert.ok(searchJob(job, '开发').score > searchJob({ position: '销售', description: '对接开发团队' }, '开发').score);
  assert.equal(jobPassesFilters({ position: 'Ｃ＋＋ 开发' }, { q: 'C++' }), true);
});

test('explicit major restrictions outrank keyword hints and preferred experience is never a hard failure', () => {
  const job = { position: '医疗软件开发', major: '仅限临床医学', experience: '3年以上工作经验优先' };
  const profile = { majors: ['计算机科学'], targetRoles: ['软件开发'], experienceYears: 0 };
  assert.equal(jobPassesFilters(job, { major: '计算机科学' }), false);
  assert.equal(jobPassesFilters({ ...job, major: '不限专业' }, { major: '计算机科学' }), true);
  assert.equal(jobPassesFilters({ position: '软件开发' }, { major: '计算机科学' }), true);
  const result = matchJob(job, profile);
  assert.equal(result.dimensions.major, 0);
  assert.equal(result.qualification.checks.find(check => check.key === 'major').status, 'fail');
  assert.equal(result.qualification.checks.find(check => check.key === 'experience').status, 'unknown');
  assert.equal(matchJob({ position: '软件开发', experience: '3年经验优先' }, profile).qualification.penalty, 0);
  assert.equal(matchJob({ position: '软件开发', experience: '至少3年经验' }, profile).qualification.status, 'fail');
});

test('salary text honors explicit period, supports fixed amounts, and preserves unknown facts', () => {
  const annual = normalizeSalary({ salaryText: '20-30万', salaryPeriod: 'year', salaryCurrency: 'RMB' });
  assert.equal(annual.period, 'year'); assert.equal(annual.currency, 'CNY'); assert.equal(annual.raw, '20-30万');
  assert.equal(salaryForPeriod(annual, 'month').max, 25000);
  assert.equal(normalizeSalary({ salaryText: '15000元/月', salaryCurrency: 'CNY' }).min, 15000);
  assert.equal(normalizeSalary({ salaryText: '年薪30万', salaryCurrency: 'CNY' }).period, 'year');
  assert.equal(normalizeSalary({ salaryText: '15K/月' }).currency, 'UNKNOWN');
  const unknownCurrency = normalizeSalary({ salaryText: '15K/月' });
  assert.equal(normalizeSalary({ compensation: unknownCurrency }).currency, 'UNKNOWN');
  assert.equal(matchJob({ position: '开发', compensation: unknownCurrency }, { targetRoles: ['开发'], salaryMin: 10000, salaryCurrency: 'CNY' }).dimensions.salary, 0);
  assert.equal(normalizeSalary({ salaryMin: 300, salaryMax: 200 }), null);
  assert.equal(normalizeSalary({ salaryMin: -100, salaryMax: 200 }), null);
  assert.equal(normalizeSalary({ salaryText: '20K以上' }), null);
  assert.equal(normalizeSalary({ salaryText: '13薪' }), null);
  assert.equal(normalizeSalary({ position: '2026-2027校招', description: '年薪30万' }), null);
});

test('jobs API returns canonical filters and catalog facets; relevance, salary aliases and true latest sorting work', async t => {
  const f = await fixture(t);
  for (const bad of ['null', '[]', 'true', '"invalid"']) {
    const result = await f.call('/jobs?cursor=' + Buffer.from(bad).toString('base64url'));
    assert.equal(result.status, 400);
  }
  let result = await f.call('/jobs?sort=salary&currency=RMB');
  assert.equal(result.status, 200); assert.deepEqual(result.body.jobs.map(job => job.id), ['b_high', 'a_low']);
  assert.equal(result.body.appliedFilters.currency, 'CNY');
  assert.equal(result.body.dataQuality.scope, 'catalog'); assert.equal(result.body.dataQuality.total, 4);
  assert.deepEqual(result.body.facets.source.find(item => item.value === '腾讯文档'), { value: '腾讯文档', label: '腾讯文档', count: 2 });
  result = await f.call(`/jobs?q=${encodeURIComponent('开发 上海')}&sort=relevance`);
  assert.deepEqual(result.body.jobs.map(job => job.id), ['a_low', 'c_unknown']);
  result = await f.call('/jobs?sort=latest'); assert.equal(result.body.jobs[0].id, 'c_unknown');
  result = await f.call(`/jobs?nature=${encodeURIComponent('国企')}&source=${encodeURIComponent('腾讯文档')}`);
  assert.deepEqual(result.body.jobs.map(job => job.id), ['a_low']);
  result = await f.call('/jobs?salaryMin=banana'); assert.equal(result.status, 400);
});

test('private state and qualification filters apply before pagination; changes invalidate old cursors without changing saved independence', async t => {
  const f = await fixture(t);
  const firstPage = f.platform.listJobs({ user: f.one.user, limit: 1 });
  f.platform.updateJobState(f.one.user, 'a_low', { status: 'applied', saved: true, note: 'private note' });
  assert.throws(() => f.platform.listJobs({ user: f.one.user, cursor: firstPage.nextCursor }), error => error.code === 'CURSOR_STALE');
  f.platform.updateJobState(f.one.user, 'a_low', { saved: false });
  assert.equal(f.platform.getJob('a_low', f.one.user).userState.status, 'applied');
  assert.equal(f.platform.getJob('a_low', f.one.user).userState.note, 'private note');
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { view: 'saved' } }).items, []);
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { view: 'applied' } }).items.map(job => job.id), ['a_low']);
  assert.ok(!f.platform.listJobs({ user: f.one.user, filters: { view: 'unapplied' } }).items.some(job => job.id === 'a_low'));
  f.platform.updateJobState(f.one.user, 'a_low', { hidden: true, saved: true });
  assert.ok(!f.platform.listJobs({ user: f.one.user }).items.some(job => job.id === 'a_low'));
  assert.equal(f.platform.listJobs({ user: f.one.user, filters: { view: 'saved' } }).total, 0);
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { view: 'hidden' } }).items.map(job => job.id), ['a_low']);
  assert.ok(f.platform.listJobs({ user: f.two.user }).items.some(job => job.id === 'a_low'));
  assert.equal((await f.call('/jobs?view=hidden', { token: null })).status, 401);
  f.platform.updateJobState(f.one.user, 'a_low', { hidden: false });
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { qualification: 'fail' } }).items.map(job => job.id), ['b_high']);
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { qualification: 'pass' } }).items.map(job => job.id), ['a_low']);
  assert.deepEqual(f.platform.listJobs({ user: f.one.user, filters: { qualification: 'unknown' } }).items.map(job => job.id), ['c_unknown']);
  assert.equal(f.platform.listJobs({ user: f.one.user, filters: { qualification: 'no_conflict' } }).total, 2);
  assert.ok(f.platform.listJobs({ user: f.one.user, filters: { minMatch: 30 } }).items.every(job => job.match.score >= 30));
});

test('deadline windows exclude unknown and expired dates, and facets never leak another user private job', async t => {
  const f = await fixture(t);
  let result = await f.call('/jobs?deadlineWithin=7'); assert.deepEqual(result.body.jobs.map(job => job.id), ['a_low']);
  result = await f.call('/jobs?deadlineWithin=30'); assert.deepEqual(new Set(result.body.jobs.map(job => job.id)), new Set(['a_low', 'b_high']));
  const created = await f.call('/me/custom-jobs', { method: 'POST', body: { company: '私密公司', position: '机密职位', location: '私密城市' } });
  assert.equal(created.status, 201);
  assert.ok((await f.call('/jobs')).body.facets.location.some(item => item.value === '私密城市'));
  assert.ok(!(await f.call('/jobs', { token: f.two.token })).body.facets.location.some(item => item.value === '私密城市'));
  assert.ok(!JSON.stringify((await f.call('/jobs', { token: null })).body).includes('私密城市'));
  f.advance(8 * 3600000 + 1);
  assert.equal(f.platform.listJobs({ filters: { deadlineWithin: '7' } }).items[0].id, 'a_low');
});

test('application fallback is safe and aliases resolve details and writes without exposing another user history', async t => {
  const f = await fixture(t);
  assert.equal(f.platform.getJob('a_low').application.href, 'https://example.com/notice');
  assert.equal(f.platform.getJob('a_low').application.source, 'notice');
  f.snapshot.aliases = { old: 'middle', middle: 'a_low', cycle1: 'cycle2', cycle2: 'cycle1' };
  const detail = f.platform.getJob('old', f.one.user);
  assert.equal(detail.requestedId, 'old'); assert.equal(detail.canonicalId, 'a_low');
  f.snapshot.jobs = f.snapshot.jobs.map(job => job.id === 'a_low' ? { ...job, experience: '5年以上', salaryMonths: 16, educationLevel: '本科', majors: ['计算机'], workMode: '混合办公', pay: '含年终奖' } : job);
  f.platform.updateJobState(f.one.user, 'old', { saved: true, note: 'kept private' });
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'old'), null);
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'a_low').saved, true);
  assert.throws(() => f.platform.getJob('cycle1'), error => error.statusCode === 404);
  f.snapshot.jobs = f.snapshot.jobs.filter(job => job.id !== 'a_low');
  const history = f.platform.getJob('a_low', f.one.user);
  assert.equal(history.company, '开发企业'); assert.equal(history.available, false); assert.equal(history.application.href, '');
  assert.equal(history.experience, '5年以上'); assert.equal(history.salaryMonths, 16);
  assert.equal(history.educationLevel, '本科'); assert.deepEqual(history.majors, ['计算机']); assert.equal(history.workMode, '混合办公');
  assert.equal(history.pay, '含年终奖');
  assert.equal(f.platform.pipeline(f.one.user).items[0].company, '开发企业');
  assert.equal(f.platform.getJob('old', f.one.user).canonicalId, 'a_low');
  assert.equal(f.platform.getJob('old', f.one.user).available, false);
  assert.throws(() => f.platform.getJob('old', f.two.user), error => error.statusCode === 404);
  assert.throws(() => f.platform.getJob('a_low', f.two.user), error => error.statusCode === 404);
  assert.throws(() => f.platform.getJob('a_low'), error => error.statusCode === 404);
  assert.ok(!JSON.stringify(require('../server/product/job-history').exportHistory(f.platform, f.one.user)).includes('kept private'));
});

test('history and state aliases remap atomically, preserve the latest copy, and roll back together on failure', async t => {
  const f = await fixture(t);
  const history = require('../server/product/job-history');
  f.platform.updateJobState(f.one.user, 'a_low', { saved: true, note: 'original state' });
  f.advance(60000);
  f.platform.updateJobState(f.one.user, 'b_high', { saved: true, note: 'newer state' });
  assert.throws(() => f.platform.store.remapJobAliases({ a_low: 'b_high' }, aliases => {
    history.remapHistory(f.platform, aliases);
    throw new Error('injected remap failure');
  }), /injected/);
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'a_low').note, 'original state');
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'b_high').note, 'newer state');
  assert.equal(history.historicalJob(f.platform, f.one.user, 'a_low').company, '开发企业');
  f.platform.remapJobAliases({ a_low: 'middle', middle: 'b_high' });
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'a_low'), null);
  assert.equal(history.historicalJob(f.platform, f.one.user, 'a_low'), null);
  assert.equal(history.historicalJob(f.platform, f.one.user, 'b_high').company, '创新企业');
  assert.equal(f.platform.exportAccount(f.one.user).jobHistory.length, 1);
  assert.equal(f.platform.exportAccount(f.two.user).jobHistory.length, 0);
});

test('source fields are allowlisted and facet choices are bounded without losing counts', () => {
  const { catalogFacets } = require('../server/product/job-quality');
  const { jobSourceNames } = require('../server/product/matching');
  const job = { origins: [{ name: '飞书主表' }, { name: { password: 'no' } }], sourceNames: ['腾讯/补充'], sourceName: '飞书主表', source: '符合条件' };
  assert.deepEqual(jobSourceNames(job), ['飞书主表', '腾讯/补充']);
  assert.equal(jobPassesFilters(job, { source: '腾讯/补充' }), true);
  const result = catalogFacets(Array.from({ length: 125 }, (_, index) => ({ position: `岗位 ${index}` })));
  assert.equal(result.facets.role.length, 100); assert.equal(result.facetMeta.truncated.role, true);
  assert.equal(result.facetMeta.totalValues.role, 125);
});

test('follow-up reminders respect exact instants and legacy local wall-clock data without rewriting it', async t => {
  const f = await fixture(t);
  assert.throws(() => f.platform.updateJobState(f.one.user, 'a_low', { followUpAt: '2026-10-23T18:00' }), /时区/);
  assert.throws(() => f.platform.updateJobState(f.one.user, 'a_low', { followUpAt: '2026-02-30T18:00:00Z' }), /有效/);
  f.platform.updateJobState(f.one.user, 'a_low', { saved: true, followUpAt: '2026-10-23T18:00:00+08:00' });
  assert.ok(!f.platform.notifications(f.one.user).items.some(item => item.id.startsWith('followup:')));
  f.advance(2 * 3600000);
  assert.equal(f.platform.notifications(f.one.user).items.filter(item => item.id.startsWith('followup:')).length, 1);
  f.platform.store.db.prepare('UPDATE job_states SET follow_up_at=? WHERE user_id=? AND job_id=?').run('2026-10-23T19:00', f.one.user.id, 'a_low');
  f.platform.updateJobState(f.one.user, 'a_low', { note: 'keep old timestamp unchanged' });
  assert.equal(f.platform.store.getJobState(f.one.user.id, 'a_low').followUpAt, '2026-10-23T19:00');
  assert.equal(f.platform.notifications(f.one.user).items.filter(item => item.id.startsWith('followup:')).length, 1);
  f.advance(3600000);
  assert.equal(f.platform.notifications(f.one.user).items.filter(item => item.id.startsWith('followup:')).length, 2);
});
