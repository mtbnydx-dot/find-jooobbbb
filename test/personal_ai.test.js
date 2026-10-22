'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProductPlatform } = require('../server/product');
const { initializePersonalAi, PersonalAi, providerFingerprint } = require('../server/product/personal-ai');
const { DeepSeekClient } = require('../server/cloud/ai');

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-ai-test-'));
  let now = Date.parse('2026-10-23T00:00:00Z');
  const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `job_${i}`, company: `公司${i}`, position: '软件工程师', location: '上海', deadline: '2027-01-01', salaryText: '15K-20K CNY/月', note: 'NEVER_SEND_PRIVATE_NOTE', aiAssessment: { reason: 'NEVER_SEND_LEGACY_PROFILE' } }));
  jobs.push({ id: 'expired', company: '过期', position: '软件工程师', deadline: '2026-01-01' });
  const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => ({ jobs }) }, clock: () => now }).initialize();
  const calls = [];
  const client = options.client || { assessJobs: async (batch, settings, { onProgress }) => {
    calls.push({ batch, settings });
    const results = batch.map(job => ({ jobId: job.id, score: 88, recommendation: '强烈推荐', reason: '基于本人画像', risks: [], confidence: .8 }));
    await onProgress({ results, call: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } });
    return { results, usage: { totalTokens: 120 } };
  } };
  const ai = initializePersonalAi(platform, { client, env: { PRODUCT_AI_API_KEY: 'test-only-not-a-real-key' } });
  const account = await platform.register({ email: 'person-ai@example.invalid', password: 'testing-only-password', displayName: 'AI测试' });
  platform.updateProfile(account.user, { majors: ['计算机科学'], targetRoles: ['软件开发'], locations: ['上海'], skills: ['JavaScript'] });
  t.after(async () => { await ai.drain(); platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { platform, ai, user: account.user, calls, jobs, setNow: value => { now = value; } };
}

test('personal AI runs isolate user/profile data, persist progress, reuse cache and never assess expired jobs', async t => {
  const { platform, ai, user, calls } = await fixture(t);
  const run = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'first-request-1' });
  assert.equal(run.total, 12); assert.equal(ai.quota(user).used, 12);
  assert.equal(ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'first-request-1' }).id, run.id);
  await ai.tick(); assert.equal(ai.run(user, run.id).completed, 10);
  await ai.tick(); assert.equal(ai.run(user, run.id).status, 'complete');
  assert.equal(ai.run(user, run.id).usage.totalTokens, 240);
  assert.equal(ai.recommendations(user).jobs.length, 12);
  const serialized = JSON.stringify(calls);
  assert.ok(!serialized.includes('person-ai@example.invalid'));
  assert.ok(!serialized.includes('NEVER_SEND_PRIVATE_NOTE'));
  assert.ok(!serialized.includes('NEVER_SEND_LEGACY_PROFILE'));
  assert.ok(serialized.includes('计算机科学'));
  const cached = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'second-request-2' });
  assert.equal(cached.status, 'complete'); assert.equal(cached.cached, 12); assert.equal(ai.quota(user).used, 12);
  const other = (await platform.register({ email: 'other-ai@example.invalid', password: 'testing-only-password', displayName: 'other' })).user;
  assert.equal(ai.recommendations(other).total, 0);
  assert.throws(() => ai.run(other, run.id), error => error.code === 'AI_RUN_NOT_FOUND');
  platform.updateProfile(user, { targetRoles: ['数据分析'] });
  assert.equal(ai.recommendations(user).total, 0); assert.equal(ai.status(user).coverage.stale, 12);
});

test('AI budget is reserved atomically, cancellation releases only undispatched work, explicit consent required', async t => {
  const { ai, user } = await fixture(t);
  assert.throws(() => ai.create(user, { idempotencyKey: 'without-consent' }), error => error.code === 'AI_CONSENT_REQUIRED');
  const run = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'cancel-request-1' });
  await ai.tick(); ai.cancel(user, run.id);
  assert.equal(ai.run(user, run.id).completed, 10); assert.equal(ai.quota(user).used, 10);
  const again = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'cancel-request-2' });
  assert.equal(again.cached, 10); assert.equal(ai.quota(user).used, 12);
  assert.throws(() => ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'cancel-request-2' }), error => error.code === 'IDEMPOTENCY_CONFLICT');
});

test('profile and job revisions invalidate cache, paused tasks retain completed billable results', async t => {
  let call = 0;
  const { ai, user, jobs, platform } = await fixture(t, { client: { assessJobs: async (batch, settings, { onProgress }) => {
    call++;
    if (call === 1) {
      await onProgress({ results: [{ jobId: batch[0].id, score: 81, reason: '保留部分' }], call: { totalTokens: 34 } });
      throw new Error('never expose apiKey or upstream secrets');
    }
    return { results: batch.map(job => ({ jobId: job.id, score: 82, reason: '重试完成' })), usage: { totalTokens: 50 } };
  } } });
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'retry-request-1' });
  await ai.tick(); assert.equal(ai.run(user, run.id).status, 'paused'); assert.equal(ai.run(user, run.id).completed, 1);
  assert.ok(!ai.run(user, run.id).error.includes('secrets'));
  ai.resume(user, run.id); await ai.tick(); assert.equal(ai.run(user, run.id).completed, 3);
  assert.equal(ai.run(user, run.id).usage.totalTokens, 84);
  const first = ai.recommendations(user).jobs[0]; jobs.find(job => job.id === first.id).requirements = '全新要求';
  assert.equal(ai.recommendations(user).total, 2);
  const next = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'new-profile-request' });
  platform.updateProfile(user, { locations: ['北京'] });
  await ai.tick(); assert.equal(ai.run(user, next.id).status, 'stale'); assert.equal(ai.recommendations(user).total, 0);
});

test('AI unconfigured status is explicit and settings never return credentials', async t => {
  const { ai, user, platform } = await fixture(t);
  ai.env = {};
  assert.equal(ai.status(user).configured, false);
  assert.throws(() => ai.create(user, { consent: true, idempotencyKey: 'unconfigured-request' }), error => error.code === 'AI_NOT_CONFIGURED');
  assert.throws(() => ai.updateSettings(user, { apiKey: 'secret' }), error => error.statusCode === 403);
  platform.store.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(user.id);
  const admin = platform.store.getUser(user.id);
  const settings = ai.updateSettings(admin, { apiKey: 'secret-test-key', model: 'test-model' });
  assert.equal(settings.configured, true); assert.ok(!JSON.stringify(settings).includes('secret-test-key'));
  assert.equal(ai.quota(admin).limit, 20000);
});

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }

test('cancel during an upstream request keeps billable partial progress but prevents SDK internal retries', async t => {
  const entered = deferred(); const response = deferred(); let requests = 0;
  const client = new DeepSeekClient({ sleep: async () => {}, fetchImpl: async () => {
    requests++; entered.resolve(); await response.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{ jobId: 'job_0', score: 80, reason: 'partial' }] }) } }], usage: { total_tokens: 75 } }));
  } });
  const { ai, user } = await fixture(t, { client });
  const run = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'cancel-in-flight' });
  const running = ai.tick(); await entered.promise;
  ai.cancel(user, run.id); response.resolve(); await running;
  assert.equal(requests, 1);
  const result = ai.run(user, run.id);
  assert.equal(result.status, 'cancelled'); assert.equal(result.completed, 1); assert.equal(result.usage.totalTokens, 75);
  assert.equal(ai.quota(user).used, 10); // Two never-dispatched queued items were refunded.
  await ai.tick(); assert.equal(requests, 1);
});

test('drain waits for one in-flight response, persists its charge, and does not issue internal retries', async t => {
  const entered = deferred(); const response = deferred(); let requests = 0;
  const client = new DeepSeekClient({ sleep: async () => {}, fetchImpl: async () => {
    requests++; entered.resolve(); await response.promise;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ results: [{ jobId: 'job_0', score: 80 }] }) } }], usage: { total_tokens: 25 } }));
  } });
  const { ai, user, platform } = await fixture(t, { client });
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'stop-in-flight' });
  const running = ai.tick(); await entered.promise;
  let drained = false; const draining = ai.drain().then(() => { drained = true; });
  await Promise.resolve(); assert.equal(drained, false);
  response.resolve(); await running; await draining;
  assert.equal(requests, 1); assert.equal(ai.run(user, run.id).usage.totalTokens, 25);
  assert.equal(ai.run(user, run.id).status, 'queued'); assert.equal(ai.run(user, run.id).completed, 1);
  assert.equal(platform.store.db.prepare('SELECT owner FROM personal_ai_worker_lease').get().owner, '');
  await ai.tick(); assert.equal(requests, 1);
});

test('cancellation during SDK backoff is checked before the next upstream request', async t => {
  const sleeping = deferred(); const resumeSleep = deferred(); let requests = 0;
  const client = new DeepSeekClient({ sleep: async () => { sleeping.resolve(); await resumeSleep.promise; }, fetchImpl: async () => {
    requests++;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"results":[]}' } }], usage: { total_tokens: 18 } }));
  } });
  const { ai, user } = await fixture(t, { client });
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'cancel-during-backoff' });
  const running = ai.tick(); await sleeping.promise;
  ai.cancel(user, run.id); resumeSleep.resolve(); await running;
  assert.equal(requests, 1); assert.equal(ai.run(user, run.id).usage.calls, 1);
  assert.equal(ai.run(user, run.id).usage.totalTokens, 18); assert.equal(ai.run(user, run.id).status, 'cancelled');
});

test('provider fingerprints invalidate old caches and pending tasks without including API credentials', async t => {
  const { ai, user, calls } = await fixture(t);
  const first = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'provider-original' });
  await ai.tick(); assert.equal(ai.recommendations(user).total, 3);
  const hash = providerFingerprint(ai.settings());
  ai.env.PRODUCT_AI_API_KEY = 'rotated-private-test-key';
  assert.equal(providerFingerprint(ai.settings()), hash); assert.equal(ai.recommendations(user).total, 3);
  const queued = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'provider-queued' });
  ai.env.PRODUCT_AI_BASE_URL = 'https://new-provider.example.com/v1';
  assert.equal(ai.recommendations(user).total, 0);
  assert.notEqual(providerFingerprint(ai.settings()), hash);
  await ai.tick(); assert.equal(ai.run(user, queued.id).status, 'stale'); assert.equal(calls.length, 1);
  assert.equal(ai.quota(user).used, 3);
  const next = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'provider-new-run' });
  assert.equal(next.cached, 0); await ai.tick(); assert.equal(ai.recommendations(user).total, 3);
  assert.ok(!JSON.stringify(ai.exportAccount(user)).includes('rotated-private-test-key'));
  assert.notEqual(ai.run(user, first.id).providerFingerprint, next.providerFingerprint);
});

test('queued jobs changed, aliased, or expired before dispatch are skipped and undispatched reservations released', async t => {
  const { ai, user, jobs, calls } = await fixture(t);
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'stale-catalog-run' });
  jobs.find(job => job.id === 'job_0').id = 'merged_canonical';
  jobs.find(job => job.id === 'job_1').deadline = '2026-01-01';
  jobs.find(job => job.id === 'job_10').requirements = 'Changed hard requirement';
  await ai.tick(); assert.equal(calls.length, 0);
  const result = ai.run(user, run.id); assert.equal(result.skipped, 3); assert.equal(result.completed, 0);
  assert.equal(ai.quota(user).used, 0);
});

test('manual retries are capped and each failed billable request remains in the task ledger', async t => {
  const { ai, user } = await fixture(t, { client: { assessJobs: async (jobs, settings, { onProgress }) => {
    await onProgress({ results: [], call: { totalTokens: 50, error: 'invalid result' } });
    throw new Error('malformed model response');
  } } });
  const run = ai.create(user, { scope: 'top', limit: 1, consent: true, idempotencyKey: 'retry-budget-run' });
  await ai.tick();
  for (let n = 0; n < 3; n++) { ai.resume(user, run.id); await ai.tick(); }
  assert.equal(ai.run(user, run.id).retry.remaining, 0);
  assert.throws(() => ai.resume(user, run.id), e => e.code === 'AI_RETRY_LIMIT');
  assert.equal(ai.run(user, run.id).usage.calls, 4); assert.equal(ai.run(user, run.id).usage.totalTokens, 200);
  assert.equal(ai.quota(user).used, 1);
});

test('token budget stops internal retries after recording the response even before the manual retry cap', async t => {
  let requests = 0;
  const { ai, user, platform } = await fixture(t, { client: { assessJobs: async (jobs, settings, { onProgress }) => {
    requests++; await onProgress({ results: [], call: { totalTokens: 25 } });
    requests++; return { results: [] };
  } } });
  const run = ai.create(user, { scope: 'top', limit: 1, consent: true, idempotencyKey: 'token-budget-run' });
  platform.store.db.prepare('UPDATE personal_ai_runs SET token_budget=20 WHERE id=?').run(run.id);
  await ai.tick(); assert.equal(requests, 1); assert.equal(ai.run(user, run.id).usage.totalTokens, 25);
  assert.throws(() => ai.resume(user, run.id), e => e.code === 'AI_RETRY_LIMIT');
});

test('another worker never resets a live lease or duplicates dispatch; an expired lease can recover safely', async t => {
  const entered = deferred(); const response = deferred(); let requests = 0;
  const { ai, user, platform, jobs, setNow } = await fixture(t, { client: { assessJobs: async (batch, settings, { onProgress }) => {
    requests++; entered.resolve(); await response.promise;
    await onProgress({ results: batch.map(job => ({ jobId: job.id, score: 80 })), call: { totalTokens: 10 } }); return { results: [] };
  } } });
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'lease-test-run' });
  const running = ai.tick(); await entered.promise;
  const second = new ProductPlatform({ dataDir: platform.store.dataDir, jobService: { snapshot: () => ({ jobs }) }, clock: platform.clock }).initialize();
  try {
    const other = new PersonalAi(second, { env: ai.env, client: { assessJobs: async () => { requests++; return { results: [] }; } } });
    assert.equal(other.run(user, run.id).status, 'running');
    await other.tick(); assert.equal(requests, 1);
    response.resolve(); await running; assert.equal(ai.run(user, run.id).status, 'complete');
    const newRun = ai.create(user, { scope: 'all', consent: true, idempotencyKey: 'lease-recover-run' });
    platform.store.db.prepare("UPDATE personal_ai_worker_lease SET owner='dead-worker',expires_ms=?").run(platform.clock() + 300000);
    await other.tick(); assert.equal(requests, 1);
    setNow(platform.clock() + 300001); await other.tick(); assert.equal(requests, 2);
    assert.notEqual(other.run(user, newRun.id).status, 'running');
    await other.drain();
  } finally { response.resolve(); await running; second.close(); }
});

test('creation checks quota inside the database write transaction and account export is isolated', async t => {
  const { ai, user, platform } = await fixture(t);
  const quota = ai.quota.bind(ai); ai.quota = account => { assert.equal(platform.store.db.isTransaction, true); return quota(account); };
  const run = ai.create(user, { scope: 'top', limit: 3, consent: true, idempotencyKey: 'atomic-budget-run' });
  ai.quota = quota; await ai.tick();
  const exported = ai.exportAccount(user); assert.equal(exported.runs[0].id, run.id); assert.equal(exported.results.length, 3);
  const other = (await platform.register({ email: 'export-other@example.invalid', password: 'testing-only-password' })).user;
  assert.deepEqual(ai.exportAccount(other), { runs: [], results: [] });
});
