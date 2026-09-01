'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { jobPassesFilters, matchJob, normalizeSalary, salaryForPeriod } = require('../server/product/matching');
const { createApp, createService } = require('../server/server');

const CATALOG = [
  {
    id: 'job_soft', active: '1', company: 'Nebula Cloud', position: '后端软件工程师', location: 'Brisbane',
    industry: '科技', matchDir: '软件开发', salary: '15K-22K/月', salaryCurrency: 'CNY', classification: '不符合条件',
    status: 'offer', note: '旧系统私密备注不得进入公共目录', lastSeenAt: '2026-08-31T10:00:00.000Z',
    aiAssessment: { score: 99, reason: '旧全局画像结果不得冒充个性匹配' },
  },
  {
    id: 'job_marketing', active: '1', company: '青空品牌', position: '品牌营销专员', location: '上海',
    industry: '传媒', matchDir: '品牌营销', salary: '18K-25K/月', salaryCurrency: 'CNY', classification: '符合条件',
    status: '已投递', note: '另一个旧备注', lastSeenAt: '2026-08-31T09:00:00.000Z',
  },
  {
    id: 'job_finance', active: '1', company: 'Harbour Advisory', position: '财务分析师', location: 'Sydney',
    industry: '金融', matchDir: '财务分析', salaryMin: 7000, salaryMax: 9000, salaryCurrency: 'AUD',
    lastSeenAt: '2026-08-30T09:00:00.000Z',
  },
  {
    id: 'job_inactive', active: '0', company: '离线公司', position: '软件工程师', location: 'Brisbane', industry: '科技',
  },
  {
    id: 'job_private_legacy', active: '1', isCustom: '1', source: '自选', company: '私人公司', position: '私人岗位',
  },
];

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-product-'));
}

function jobService() {
  return { snapshot: () => ({ jobs: CATALOG.map(job => ({ ...job })) }) };
}

async function startFixture(options = {}) {
  const directory = tempDirectory();
  const platform = new ProductPlatform({ dataDir: directory, jobService: jobService(), ...options }).initialize();
  const app = express();
  app.use('/api/v1', createProductRouter({ platform }));
  const server = await new Promise(resolve => {
    const instance = http.createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  return {
    directory,
    platform,
    base,
    async close() {
      await new Promise(resolve => server.close(resolve));
      platform.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function request(fixture, route, { method = 'GET', body, token, cookie } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cookie) headers.Cookie = cookie;
  const response = await fetch(`${fixture.base}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const payload = response.status === 204 ? null : await response.json();
  return { response, payload };
}

async function register(fixture, email, displayName = email.split('@')[0], extra = {}) {
  const { response, payload } = await request(fixture, '/auth/register', {
    method: 'POST', body: { email, displayName, password: 'Passw0rd!demo', ...extra },
  });
  assert.equal(response.status, 201, JSON.stringify(payload));
  return {
    ...payload,
    cookie: String(response.headers.get('set-cookie') || '').split(';')[0],
  };
}

test('product database initializes independently with plans, eight tracks and 24 original seed questions', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  assert.equal(path.basename(fixture.platform.store.file), 'product.db');
  assert.equal(fixture.platform.listPlans().length, 3);
  assert.equal(fixture.platform.store.listPrepTracks().length, 8);
  assert.equal(fixture.platform.store.countPrepQuestions(), 24);
  const health = await request(fixture, '/health');
  assert.deepEqual(health.payload, { ok: true, product: true, paymentConfigured: false });
});

test('main server mounts the product API and serves client routes through the PWA entry', async t => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory });
  service.load();
  const platform = new ProductPlatform({
    dataDir: directory,
    jobService: service,
    bootstrapRoles: { 'ops@example.com': 'admin' },
    bootstrapToken: 'test-bootstrap-secret',
  }).initialize();
  const admin = await platform.register({
    email: 'ops@example.com', displayName: 'Ops', password: 'Passw0rd!demo', bootstrapToken: 'test-bootstrap-secret',
  });
  const app = createApp({ service, product: platform, secureProductCookies: false });
  const server = await new Promise(resolve => {
    const instance = http.createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    platform.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).product, true);
  response = await fetch(origin, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/app/');
  response = await fetch(`${origin}/api/jobs`);
  assert.equal(response.status, 401);
  response = await fetch(`${origin}/api/jobs`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(response.status, 200);
  response = await fetch(`${origin}/ops`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  response = await fetch(`${origin}/ops`, { headers: { Authorization: `Bearer ${admin.token}` } });
  assert.equal(response.status, 200);
  response = await fetch(`${origin}/app/jobs`, { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>职路/);
});

test('preview path configuration isolates product, operations API and session cookie namespaces', async t => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory });
  service.load();
  const platform = new ProductPlatform({
    dataDir: directory,
    jobService: service,
    bootstrapRoles: { 'preview-ops@example.com': 'admin' },
    bootstrapToken: 'preview-bootstrap-secret',
  }).initialize();
  await platform.register({
    email: 'preview-ops@example.com', displayName: 'Preview Ops', password: 'Passw0rd!demo', bootstrapToken: 'preview-bootstrap-secret',
  });
  const app = createApp({
    service,
    product: platform,
    secureProductCookies: false,
    productPublicBase: '/usertest',
    opsPublicBase: '/test',
    productCookieName: 'job_usertest_session',
  });
  const server = await new Promise(resolve => {
    const instance = http.createServer(app);
    instance.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    platform.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let response = await fetch(origin, { redirect: 'manual' });
  assert.equal(response.headers.get('location'), '/usertest/');
  response = await fetch(`${origin}/usertest/jobs`, { headers: { Accept: 'text/html' } });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<title>职路/);
  response = await fetch(`${origin}/usertest/api/v1/health`);
  assert.deepEqual(await response.json(), { ok: true, product: true, paymentConfigured: false });

  response = await fetch(`${origin}/usertest/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'preview-ops@example.com', password: 'Passw0rd!demo' }),
  });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get('set-cookie') || '';
  assert.match(setCookie, /^job_usertest_session=/);
  assert.match(setCookie, /; Path=\//);
  const cookie = setCookie.split(';')[0];

  response = await fetch(`${origin}/test`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/usertest/login');
  response = await fetch(`${origin}/test`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const opsHtml = await response.text();
  assert.match(opsHtml, /name="ops-public-base" content="\/test"/);
  assert.match(opsHtml, /href="\/usertest\/login"/);
  assert.match(opsHtml, /src="\/test\/app\.js\?/);
  response = await fetch(`${origin}/test/app.js`);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /OPS_API_ROOT/);

  response = await fetch(`${origin}/test/api/jobs`);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).loginUrl, '/usertest/login');
  response = await fetch(`${origin}/test/api/jobs`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
});

test('web build settings preserve production defaults and derive isolated preview routes', async () => {
  const { buildSettings } = await import('../web/build-config.mjs');
  assert.deepEqual(buildSettings({}), {
    productPublicBase: '/app',
    productPublicBaseWithSlash: '/app/',
    productApiBase: '/api/v1',
    opsPublicBase: '/ops',
    opsApiBase: '/api',
  });
  assert.deepEqual(buildSettings({ PRODUCT_PUBLIC_BASE: '/usertest/', OPS_PUBLIC_BASE: 'test' }), {
    productPublicBase: '/usertest',
    productPublicBaseWithSlash: '/usertest/',
    productApiBase: '/usertest/api/v1',
    opsPublicBase: '/test',
    opsApiBase: '/test/api',
  });
  assert.throws(() => buildSettings({ PRODUCT_PUBLIC_BASE: '/../escape' }), /绝对路径/);
});

test('registration creates a hashed cookie session and two users keep job state private', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const alice = await register(fixture, 'alice@example.com', 'Alice');
  const bob = await register(fixture, 'bob@example.com', 'Bob');

  assert.match(alice.cookie, /^job_session=/);
  const sessionRow = fixture.platform.store.db.prepare('SELECT token_hash FROM sessions WHERE user_id=?').get(alice.user.id);
  assert.match(sessionRow.token_hash, /^[a-f0-9]{64}$/);
  assert.equal(sessionRow.token_hash.includes(alice.sessionToken), false);

  let result = await request(fixture, '/me/jobs/job_soft', {
    method: 'PUT', token: alice.sessionToken,
    body: { status: 'interview', saved: true, favorite: true, note: 'Alice 私有进度', nextAction: '准备系统设计' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.state.status, 'interview');

  result = await request(fixture, '/jobs/job_soft', { token: bob.sessionToken });
  assert.equal(result.payload.job.userState, null);
  assert.equal(Object.hasOwn(result.payload.job, 'note'), false);
  assert.equal(Object.hasOwn(result.payload.job, 'status'), false);
  assert.equal(Object.hasOwn(result.payload.job, 'aiAssessment'), false);
  assert.equal(Object.hasOwn(result.payload.job, 'classification'), false);

  result = await request(fixture, '/me/jobs/job_soft', {
    method: 'PUT', token: bob.sessionToken, body: { status: 'saved', note: 'Bob 的笔记' },
  });
  assert.equal(result.payload.state.note, 'Bob 的笔记');
  const aliceJob = await request(fixture, '/jobs/job_soft', { cookie: alice.cookie });
  assert.equal(aliceJob.payload.job.userState.note, 'Alice 私有进度');
  assert.equal(aliceJob.payload.job.userState.status, 'interview');

  await request(fixture, '/me/jobs/job_marketing', {
    method: 'PUT', token: bob.sessionToken, body: { status: 'ignored', saved: false },
  });
  const bobPipeline = await request(fixture, '/me/pipeline', { token: bob.sessionToken });
  assert.equal(bobPipeline.payload.items.some(item => item.id === 'job_marketing'), false);

  await request(fixture, '/auth/logout', { method: 'POST', cookie: alice.cookie, body: {} });
  result = await request(fixture, '/auth/me', { cookie: alice.cookie });
  assert.equal(result.response.status, 401);
  result = await request(fixture, '/auth/login', {
    method: 'POST', body: { email: 'alice@example.com', password: 'Passw0rd!demo' },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.user.id, alice.user.id);

  const pipeline = await request(fixture, '/me/pipeline', { token: result.payload.sessionToken });
  assert.equal(pipeline.payload.counts.interview, 1);
  assert.equal(pipeline.payload.items[0].id, 'job_soft');
  assert.equal(pipeline.payload.items[0].company, 'Nebula Cloud');
  const dashboard = await request(fixture, '/dashboard', { token: result.payload.sessionToken });
  assert.equal(dashboard.payload.summary.trackedJobs, 1);
  assert.equal(dashboard.payload.summary.activeApplications, 1);
});

test('different majors, roles, locations and salary profiles produce different deterministic rankings', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const engineer = await register(fixture, 'engineer@example.com');
  const marketer = await register(fixture, 'marketer@example.com');

  let result = await request(fixture, '/me/profile', {
    method: 'PUT', token: engineer.sessionToken,
    body: {
      majors: ['计算机科学', '软件工程'], targetRoles: ['软件工程师'], locations: ['Brisbane'], industries: ['科技'],
      salaryCurrency: 'CNY', salaryMin: 14000, salaryMax: 25000, salaryPeriod: 'month',
    },
  });
  assert.equal(result.response.status, 200);
  result = await request(fixture, '/me/profile', {
    method: 'PUT', token: marketer.sessionToken,
    body: {
      major: '市场营销', targetRoles: ['品牌营销'], preferredLocations: ['上海'], targetIndustries: ['传媒'],
      currency: 'CNY', salaryMin: 16000, salaryMax: 26000, salaryPeriod: 'month', skills: ['内容策划'],
    },
  });
  assert.equal(result.response.status, 200);
  assert.deepEqual(result.payload.profile.majors, ['市场营销']);
  assert.deepEqual(result.payload.profile.preferredLocations, ['上海']);

  const engineeringJobs = await request(fixture, '/jobs?limit=1', { token: engineer.sessionToken });
  const marketingJobs = await request(fixture, '/jobs?limit=1', { token: marketer.sessionToken });
  assert.equal(engineeringJobs.payload.jobs[0].id, 'job_soft');
  assert.equal(marketingJobs.payload.jobs[0].id, 'job_marketing');
  assert.ok(engineeringJobs.payload.jobs[0].match.reasons.some(reason => reason.includes('目标岗位')));
  assert.ok(marketingJobs.payload.jobs[0].match.reasons.some(reason => reason.includes('目标城市')));
  assert.ok(engineeringJobs.payload.nextCursor);

  result = await request(fixture, `/jobs?cursor=${encodeURIComponent(engineeringJobs.payload.nextCursor)}&limit=1`, { token: engineer.sessionToken });
  assert.notEqual(result.payload.jobs[0].id, 'job_soft');
  result = await request(fixture, '/jobs?major=市场营销&role=品牌&location=上海&salaryMin=20000', { token: engineer.sessionToken });
  assert.deepEqual(result.payload.jobs.map(job => job.id), ['job_marketing']);
});

test('plans expose server-side entitlements and checkout clearly reports missing payment configuration', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const user = await register(fixture, 'plan@example.com');

  let result = await request(fixture, '/plans');
  assert.equal(result.payload.plans.length, 3);
  assert.equal(result.payload.paymentConfigured, false);
  result = await request(fixture, '/me/entitlements', { token: user.sessionToken });
  assert.equal(result.payload.plan.id, 'free');
  assert.equal(result.payload.values['prep.tracks'].limit, 2);
  result = await request(fixture, '/billing/checkout', {
    method: 'POST', token: user.sessionToken, body: { planId: 'pro', returnUrl: 'https://example.com/account' },
  });
  assert.equal(result.response.status, 503);
  assert.equal(result.payload.code, 'PAYMENT_NOT_CONFIGURED');
  assert.equal(result.payload.detail.paymentConfigured, false);

  result = await request(fixture, '/prep/tracks', { token: user.sessionToken });
  assert.equal(result.payload.tracks.length, 8);
  assert.equal(result.payload.tracks.filter(track => !track.locked).length, 2);
  result = await request(fixture, '/prep/questions?trackId=track_software', { token: user.sessionToken });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.code, 'ENTITLEMENT_LIMIT');

  result = await request(fixture, '/salary/insights', { token: user.sessionToken });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.detail.key, 'salary.insights');
  fixture.platform.store.setUserPlan(user.user.id, 'pro', 'test');
  result = await request(fixture, '/salary/insights', { token: user.sessionToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.source, '当前岗位目录中可解析的公开薪资字段');
  assert.equal(result.payload.market.insufficient, true);
  assert.equal(result.payload.market.percentile, null);
});

test('daily prep quotas and streaks use each user profile time zone', async t => {
  let now = Date.parse('2026-08-31T14:30:00.000Z'); // 2026-09-01 00:30 in Brisbane.
  const fixture = await startFixture({ clock: () => now });
  t.after(() => fixture.close());
  const account = await register(fixture, 'timezone@example.com');
  fixture.platform.updateProfile(account.user, { timeZone: 'Australia/Brisbane' });
  const questions = fixture.platform.store.listPrepQuestions({ trackId: 'track_job_search', limit: 3 });
  const first = fixture.platform.store.getPrepQuestion(questions[0].id, { includeAnswer: true });
  fixture.platform.submitPrepAttempt(account.user, { questionId: first.id, answer: first.answer });

  assert.equal(fixture.platform.store.usage(account.user.id, 'prep.attempts.daily', '2026-08-31'), 0);
  assert.equal(fixture.platform.store.usage(account.user.id, 'prep.attempts.daily', '2026-09-01'), 1);
  assert.equal(fixture.platform.entitlements(account.user).values['prep.attempts.daily'].used, 1);
  assert.equal(fixture.platform.listPrepTracks(account.user)[0].streak, 1);

  now = Date.parse('2026-09-01T14:30:00.000Z');
  const second = fixture.platform.store.getPrepQuestion(questions[1].id, { includeAnswer: true });
  fixture.platform.submitPrepAttempt(account.user, { questionId: second.id, answer: second.answer });
  assert.equal(fixture.platform.entitlements(account.user).values['prep.attempts.daily'].used, 1);
  assert.equal(fixture.platform.listPrepTracks(account.user)[0].streak, 2);
  assert.throws(() => fixture.platform.updateProfile(account.user, { timeZone: 'Mars/Olympus_Mons' }), /有效的 IANA 时区/);
});

test('prep answers and progress are isolated per user and never reveal answers before submission', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const first = await register(fixture, 'prep-one@example.com');
  const second = await register(fixture, 'prep-two@example.com');

  let result = await request(fixture, '/prep/questions?trackId=track_job_search', { token: first.sessionToken });
  assert.equal(result.payload.questions.length, 3);
  assert.equal(Object.hasOwn(result.payload.questions[0], 'answer'), false);

  result = await request(fixture, '/prep/attempts', {
    method: 'POST', token: first.sessionToken,
    body: { questionId: 'q_job_1', response: '岗位核心产出与硬性门槛' },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.attempt.score, 100);
  result = await request(fixture, '/prep/attempts', {
    method: 'POST', token: second.sessionToken,
    body: { questionId: 'q_job_1', response: '招聘海报颜色' },
  });
  assert.equal(result.payload.attempt.score, 0);

  const firstProgress = await request(fixture, '/me/prep/progress', { token: first.sessionToken });
  const secondProgress = await request(fixture, '/me/prep/progress', { token: second.sessionToken });
  assert.equal(firstProgress.payload.progress[0].bestScore, 100);
  assert.equal(secondProgress.payload.progress[0].bestScore, 0);
  const firstEntitlements = await request(fixture, '/me/entitlements', { token: first.sessionToken });
  const secondEntitlements = await request(fixture, '/me/entitlements', { token: second.sessionToken });
  assert.equal(firstEntitlements.payload.values['prep.attempts.daily'].used, 1);
  assert.equal(secondEntitlements.payload.values['prep.attempts.daily'].used, 1);
  const tracks = await request(fixture, '/prep/tracks', { token: first.sessionToken });
  const jobSearchTrack = tracks.payload.tracks.find(track => track.id === 'track_job_search');
  assert.equal(jobSearchTrack.completedQuestions, 1);
  assert.equal(jobSearchTrack.progress, 33);
});

test('cloud exams resume drafts, isolate users, submit once and feed wrong-answer review', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const first = await register(fixture, 'exam-one@example.com');
  const second = await register(fixture, 'exam-two@example.com');

  let result = await request(fixture, '/exams/packs', { token: first.sessionToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.packs.length, 6);
  assert.equal(result.payload.packs.filter(pack => !pack.locked).length, 2);
  assert.equal(result.payload.packs.find(pack => pack.id === 'exam_huzhou_cloud').locked, false);
  assert.equal(result.payload.packs.find(pack => pack.id === 'exam_software_campus').locked, true);

  result = await request(fixture, '/exams/packs?major=%E7%BB%9F%E8%AE%A1%E5%AD%A6', { token: first.sessionToken });
  assert.ok(result.payload.packs.some(pack => pack.id === 'exam_data_business'));

  result = await request(fixture, '/exams/sessions', {
    method: 'POST', token: first.sessionToken, body: { packId: 'exam_huzhou_cloud' },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.resumed, false);
  const firstSessionId = result.payload.session.id;
  assert.equal(result.payload.questions.length, 6);
  assert.equal(Object.hasOwn(result.payload.questions[0], 'answer'), false);

  result = await request(fixture, `/exams/sessions/${firstSessionId}`, {
    method: 'PUT', token: first.sessionToken,
    body: { answers: { q_job_1: '1' }, flagged: ['q_job_2'], currentIndex: 2, elapsedSeconds: 47 },
  });
  assert.equal(result.payload.session.answers.q_job_1, '1');
  assert.deepEqual(result.payload.session.flagged, ['q_job_2']);
  assert.equal(result.payload.session.currentIndex, 2);
  assert.equal(result.payload.session.elapsedSeconds, 47);

  result = await request(fixture, '/exams/sessions', {
    method: 'POST', token: first.sessionToken, body: { packId: 'exam_huzhou_cloud' },
  });
  assert.equal(result.payload.resumed, true);
  assert.equal(result.payload.session.id, firstSessionId);

  result = await request(fixture, `/exams/sessions/${firstSessionId}`, { token: second.sessionToken });
  assert.equal(result.response.status, 404);
  result = await request(fixture, '/exams/sessions', {
    method: 'POST', token: second.sessionToken, body: { packId: 'exam_huzhou_cloud' },
  });
  assert.notEqual(result.payload.session.id, firstSessionId);

  result = await request(fixture, `/exams/sessions/${firstSessionId}/submit`, {
    method: 'POST', token: first.sessionToken,
    body: { answers: { q_job_1: '1' }, flagged: ['q_job_2'], currentIndex: 5, elapsedSeconds: 73 },
  });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.submittedNow, true);
  assert.equal(result.payload.session.status, 'submitted');
  assert.equal(result.payload.result.correctCount, 1);
  assert.equal(result.payload.result.wrongCount, 5);
  const attemptCount = fixture.platform.store.db.prepare('SELECT COUNT(*) AS n FROM prep_attempts WHERE user_id=?')
    .get(first.user.id).n;
  assert.equal(attemptCount, 6);

  result = await request(fixture, `/exams/sessions/${firstSessionId}/submit`, {
    method: 'POST', token: first.sessionToken, body: {},
  });
  assert.equal(result.payload.submittedNow, false);
  assert.equal(fixture.platform.store.db.prepare('SELECT COUNT(*) AS n FROM prep_attempts WHERE user_id=?').get(first.user.id).n, attemptCount);

  const summary = await request(fixture, '/me/exams/summary', { token: first.sessionToken });
  assert.equal(summary.payload.summary.submitted, 1);
  assert.equal(summary.payload.summary.wrongCount, 5);
  const wrong = await request(fixture, '/me/exams/wrong', { token: first.sessionToken });
  assert.equal(wrong.payload.items.length, 5);
  assert.ok(wrong.payload.items.every(item => item.packId === 'exam_huzhou_cloud'));
  const otherWrong = await request(fixture, '/me/exams/wrong', { token: second.sessionToken });
  assert.equal(otherWrong.payload.items.length, 0);

  const recommendations = await request(fixture, '/jobs/job_soft/exam-packs', { token: first.sessionToken });
  assert.equal(recommendations.response.status, 200);
  assert.equal(recommendations.payload.job.id, 'job_soft');
  assert.equal(recommendations.payload.items.length, 3);
});

test('role authorization separates ordinary users, content editors and administrators', async t => {
  const fixture = await startFixture({
    bootstrapRoles: {
      'admin@example.com': 'admin',
      'editor@example.com': 'content_editor',
      'reserved@example.com': 'admin',
    },
    bootstrapToken: 'test-bootstrap-secret',
  });
  t.after(() => fixture.close());
  const normal = await register(fixture, 'normal@example.com');
  const reserved = await register(fixture, 'reserved@example.com');
  const editor = await register(fixture, 'editor@example.com', 'Editor', { bootstrapToken: 'test-bootstrap-secret' });
  const admin = await register(fixture, 'admin@example.com', 'Admin', { bootstrapToken: 'test-bootstrap-secret' });
  assert.equal(reserved.user.role, 'user');
  assert.equal(editor.user.role, 'content_editor');
  assert.equal(admin.user.role, 'admin');

  let result = await request(fixture, '/admin/users', { token: normal.sessionToken });
  assert.equal(result.response.status, 403);
  result = await request(fixture, '/admin/prep/questions', {
    method: 'POST', token: editor.sessionToken,
    body: {
      trackId: 'track_job_search', type: 'single', prompt: '原创编辑测试题：哪项代表可验证结果？',
      options: ['具体数字', '大概不错'], answer: '具体数字', explanation: '具体数字更容易验证。',
    },
  });
  assert.equal(result.response.status, 201);
  result = await request(fixture, '/admin/users', { token: editor.sessionToken });
  assert.equal(result.response.status, 403);
  result = await request(fixture, '/admin/users', { token: admin.sessionToken });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.users.length, 4);

  result = await request(fixture, `/admin/users/${normal.user.id}/plan`, {
    method: 'PUT', token: admin.sessionToken, body: { planId: 'pro' },
  });
  assert.equal(result.payload.plan.id, 'pro');
  result = await request(fixture, '/me/entitlements', { token: normal.sessionToken });
  assert.equal(result.payload.plan.id, 'pro');
  result = await request(fixture, '/prep/questions?trackId=track_software', { token: normal.sessionToken });
  assert.equal(result.response.status, 200);
  result = await request(fixture, '/admin/users/missing-user/plan', {
    method: 'PUT', token: admin.sessionToken, body: { planId: 'pro' },
  });
  assert.equal(result.response.status, 404);
});

test('batch prep limits are atomic and successful submissions return per-question explanations', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const user = await register(fixture, 'batch@example.com');
  const answers = Array.from({ length: 6 }, () => ({ questionId: 'q_job_1', answer: '岗位核心产出与硬性门槛' }));
  let result = await request(fixture, '/prep/attempts', { method: 'POST', token: user.sessionToken, body: { answers } });
  assert.equal(result.response.status, 403);
  assert.equal(fixture.platform.store.db.prepare('SELECT COUNT(*) AS n FROM prep_attempts WHERE user_id=?').get(user.user.id).n, 0);
  result = await request(fixture, '/me/entitlements', { token: user.sessionToken });
  assert.equal(result.payload.values['prep.attempts.daily'].used, 0);

  result = await request(fixture, '/prep/attempts', {
    method: 'POST', token: user.sessionToken,
    body: { answers: [{ questionId: 'q_job_1', answer: '岗位核心产出与硬性门槛' }] },
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.result.items[0].correct, true);
  assert.match(result.payload.result.items[0].explanation, /核心产出/);
  assert.equal(result.payload.result.items[0].referenceAnswer, '岗位核心产出与硬性门槛');
});

test('expired subscriptions fall back to free entitlements and international salary parsing preserves currency and period', async t => {
  const fixture = await startFixture();
  t.after(() => fixture.close());
  const user = await register(fixture, 'expired@example.com');
  fixture.platform.store.setUserPlan(user.user.id, 'pro', 'test');
  fixture.platform.store.db.prepare('UPDATE subscriptions SET current_period_end=? WHERE user_id=?')
    .run('2020-01-01T00:00:00.000Z', user.user.id);
  const result = await request(fixture, '/me/entitlements', { token: user.sessionToken });
  assert.equal(result.payload.plan.id, 'free');

  const annual = normalizeSalary({ salary: 'A$80,000 - A$100,000 per annum' });
  assert.equal(annual.currency, 'AUD');
  assert.equal(annual.period, 'year');
  assert.equal(Math.round(salaryForPeriod(annual, 'month').max), 8333);
  const weekly = normalizeSalary({ salary: 'HK$8,000 - 10,000 /周' });
  assert.equal(weekly.currency, 'HKD');
  assert.equal(weekly.period, 'week');
  assert.equal(Math.round(salaryForPeriod(weekly, 'month').min), 34667);
  assert.equal(normalizeSalary({ position: '2026-2027届校园招聘 管培生' }), null);
  assert.equal(normalizeSalary({ notice: 'https://example.com/2026-2027/job' }), null);
  assert.equal(normalizeSalary({ salary: '15K-22K/月' }).currency, 'UNKNOWN');
});

test('weekly pay and explicit 13/14-pay packages convert without crossing currency boundaries', () => {
  const structuredWeekly = normalizeSalary({
    salaryMin: 1000, salaryMax: 1200, salaryCurrency: 'GBP', salaryPeriod: 'weekly',
  });
  assert.equal(structuredWeekly.period, 'week');
  assert.equal(salaryForPeriod(structuredWeekly, 'year').min, 52_000);
  assert.equal(Math.round(salaryForPeriod(structuredWeekly, 'month').max), 5200);
  assert.equal(salaryForPeriod(structuredWeekly, 'year').currency, 'GBP');
  assert.equal(jobPassesFilters({ salaryMin: 1000, salaryMax: 1200, salaryCurrency: 'GBP', salaryPeriod: 'week' }, {
    currency: 'GBP', salaryPeriod: 'week', salaryMin: 1100,
  }), true);

  const fourteenPay = normalizeSalary({ salary: 'CNY 20K-30K/月 · 14薪' });
  assert.equal(fourteenPay.salaryMonths, 14);
  assert.deepEqual([fourteenPay.salaryMonthsMin, fourteenPay.salaryMonthsMax], [14, 14]);
  assert.deepEqual(
    [salaryForPeriod(fourteenPay, 'year').min, salaryForPeriod(fourteenPay, 'year').max],
    [280_000, 420_000],
  );

  const variablePay = normalizeSalary({ salary: 'CNY 20K-30K/月，13-14薪' });
  assert.equal(variablePay.salaryMonths, null);
  assert.deepEqual([variablePay.salaryMonthsMin, variablePay.salaryMonthsMax], [13, 14]);
  assert.deepEqual(
    [salaryForPeriod(variablePay, 'year').min, salaryForPeriod(variablePay, 'year').max],
    [260_000, 420_000],
  );
  const annualPackage = normalizeSalary({
    salaryMin: 260_000, salaryMax: 420_000, salaryCurrency: 'CNY', salaryPeriod: 'year', salaryMonths: '13/14',
  });
  assert.equal(Math.round(salaryForPeriod(annualPackage, 'month').min), 18_571);
  assert.equal(Math.round(salaryForPeriod(annualPackage, 'month').max), 32_308);
  assert.equal(salaryForPeriod(annualPackage, 'month').currency, 'CNY');
});

test('public degree, graduation cohort and experience requirements produce pass fail or unknown qualification results', () => {
  const job = {
    position: '数据分析师', matchDir: '数据分析', location: '上海', industry: '科技', major: '统计学',
    degree: '硕士及以上', audience: '2027届毕业生', experience: '至少 2 年工作经验',
  };
  const commonProfile = {
    targetRoles: ['数据分析师'], locations: ['上海'], industries: ['科技'], majors: ['统计学'], skills: [], workModes: [],
  };
  const qualified = matchJob(job, {
    ...commonProfile, educationLevel: '博士', graduationYear: 2027, experienceYears: 3,
  });
  assert.equal(qualified.qualification.status, 'pass');
  assert.equal(qualified.qualification.label, '通过');
  assert.deepEqual(qualified.qualification.checks.map(check => check.status), ['pass', 'pass', 'pass']);
  assert.equal(qualified.qualification.penalty, 0);

  const ineligible = matchJob(job, {
    ...commonProfile, educationLevel: '本科', graduationYear: 2026, experienceYears: 1,
  });
  assert.equal(ineligible.qualification.status, 'fail');
  assert.equal(ineligible.qualification.label, '不满足');
  assert.deepEqual(ineligible.qualification.checks.map(check => check.status), ['fail', 'fail', 'fail']);
  assert.equal(ineligible.qualification.risks.length, 3);
  assert.equal(ineligible.label, '硬条件风险');
  assert.ok(ineligible.score < qualified.score);
  assert.ok(ineligible.gaps.some(gap => gap.startsWith('资格风险：')));

  const missingCandidateFacts = matchJob(job, commonProfile);
  assert.equal(missingCandidateFacts.qualification.status, 'unknown');
  assert.equal(missingCandidateFacts.qualification.label, '未知');
  assert.deepEqual(missingCandidateFacts.qualification.checks.map(check => check.status), ['unknown', 'unknown', 'unknown']);
  assert.equal(missingCandidateFacts.qualification.penalty, 0);
  assert.deepEqual(missingCandidateFacts.qualification.risks, []);

  const unpublished = matchJob({ position: '数据分析师' }, commonProfile);
  assert.equal(unpublished.qualification.status, 'unknown');
  assert.ok(unpublished.qualification.checks.every(check => check.published === false));
  assert.deepEqual(unpublished.qualification.risks, []);
  const ambiguousFreshGraduate = matchJob({ position: '数据分析师', audience: '应届生' }, commonProfile);
  assert.equal(ambiguousFreshGraduate.qualification.status, 'unknown');
  assert.equal(ambiguousFreshGraduate.qualification.checks.find(check => check.key === 'graduation').status, 'unknown');
});

test('qualification parser reads explicit hard conditions from requirements but does not turn preferences into failures', () => {
  const profile = {
    targetRoles: ['研究员'], majors: ['统计学'], locations: [], industries: [], skills: [], workModes: [],
    educationLevel: '本科', graduationYear: 2027, experienceYears: 1,
  };
  const explicit = matchJob({
    position: '研究员', requirements: '学历要求硕士及以上；面向 2027-2028 届毕业生；3 年以上相关经验',
  }, profile);
  assert.equal(explicit.qualification.status, 'fail');
  assert.deepEqual(explicit.qualification.checks.map(check => check.status), ['fail', 'pass', 'fail']);

  const preference = matchJob({ position: '研究员', degree: '硕士优先' }, profile);
  const education = preference.qualification.checks.find(check => check.key === 'education');
  assert.equal(education.status, 'unknown');
  assert.equal(preference.qualification.penalty, 0);
  assert.deepEqual(preference.qualification.risks, []);
});

test('remapJobAliases synchronously moves and merges every user state without losing notes', async t => {
  let now = Date.parse('2026-08-31T00:00:00.000Z');
  const directory = tempDirectory();
  const platform = new ProductPlatform({ dataDir: directory, jobService: jobService(), clock: () => now }).initialize();
  t.after(() => {
    platform.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const first = (await platform.register({ email: 'alias-one@example.com', password: 'Passw0rd!demo', displayName: 'One' })).user;
  const second = (await platform.register({ email: 'alias-two@example.com', password: 'Passw0rd!demo', displayName: 'Two' })).user;

  platform.updateJobState(first, 'job_marketing', {
    status: 'applied', favorite: true, note: '目标岗位原备注', nextAction: '等待回复',
  });
  now += 60_000;
  platform.updateJobState(first, 'job_soft', {
    status: 'interview', saved: true, note: '旧 ID 上的新备注', nextAction: '准备面试',
  });
  platform.updateJobState(second, 'job_soft', {
    status: 'saved', saved: true, note: '第二个用户的记录', nextAction: '定制简历',
  });

  const stats = platform.remapJobAliases({ job_soft: 'job_marketing' });
  assert.deepEqual(stats, { aliases: 1, remapped: 1, merged: 1 });
  assert.equal(platform.store.getJobState(first.id, 'job_soft'), null);
  const merged = platform.store.getJobState(first.id, 'job_marketing');
  assert.equal(merged.status, 'interview');
  assert.equal(merged.nextAction, '准备面试');
  assert.equal(merged.favorite, true);
  assert.equal(merged.saved, true);
  assert.match(merged.note, /目标岗位原备注/);
  assert.match(merged.note, /旧 ID 上的新备注/);
  assert.equal(platform.store.getJobState(second.id, 'job_marketing').note, '第二个用户的记录');
});

test('pending alias intents apply only after the catalog commit is visible and survive a restart', async t => {
  const directory = tempDirectory();
  let jobs = CATALOG.map(job => ({ ...job }));
  const mutableJobService = { snapshot: () => ({ jobs }) };
  let platform = new ProductPlatform({ dataDir: directory, jobService: mutableJobService }).initialize();
  t.after(() => {
    platform?.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const registered = await platform.register({ email: 'intent@example.com', password: 'Passw0rd!demo', displayName: 'Intent' });
  platform.updateJobState(registered.user, 'job_soft', { status: 'saved', saved: true, note: '需要跟随 canonical ID' });
  const intentId = platform.prepareJobAliases({ job_soft: 'job_marketing' });
  assert.match(intentId, /^jai_/);
  platform.close();

  platform = new ProductPlatform({ dataDir: directory, jobService: mutableJobService }).initialize();
  assert.deepEqual(platform.replayPendingJobAliases(), []);
  assert.equal(platform.store.getJobState(registered.user.id, 'job_soft').note, '需要跟随 canonical ID');

  jobs = jobs.filter(job => job.id !== 'job_soft');
  const replayed = platform.replayPendingJobAliases();
  assert.equal(replayed.length, 1);
  assert.equal(platform.store.getJobState(registered.user.id, 'job_soft'), null);
  assert.equal(platform.store.getJobState(registered.user.id, 'job_marketing').note, '需要跟随 canonical ID');
  assert.equal(platform.store.getJobAliasIntent(intentId).status, 'applied');
});
