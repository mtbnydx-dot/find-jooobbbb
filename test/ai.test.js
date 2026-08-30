'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DeepSeekClient, AiApiError } = require('../server/cloud/ai');
const { classifyRecords } = require('../server/cloud/classifier');
const { CloudRuntime } = require('../server/cloud/runtime');
const { createService, createApp } = require('../server/server');

const FIXED_NOW = Date.parse('2026-08-26T00:00:00.000Z');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-ai-'));
}

function cleanup(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())), 'refuse to clean outside temp');
  fs.rmSync(directory, { recursive: true, force: true });
}

function rawRecord() {
  return {
    _id: 'row_1', 公司名称: '示例品牌', 企业性质: '民企', 行业大类: '消费品', 批次: '秋招', 招聘对象: '2027届',
    工作地点: '合肥', 招聘岗位: '品牌传播管培生', 截止时间: '2026/10/20', 投递方式: 'https://example.com/apply',
  };
}

test('DeepSeek client requests JSON mode without thinking and retries malformed model output', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    const content = requests.length === 1
      ? 'not-json'
      : JSON.stringify({ results: [{ jobId: 'job_1', score: 88, recommendation: '强烈推荐', matchedRoles: ['品牌传播'], reason: '方向和地点均匹配', risks: [], confidence: 0.91 }] });
    return new Response(JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
  };
  const client = new DeepSeekClient({ fetchImpl, sleep: async () => {}, maxAttempts: 2 });
  const result = await client.assessJobs([{ id: 'job_1', company: '示例品牌', position: '品牌传播', location: '合肥' }], {
    apiKey: 'deepseek-test-key', baseUrl: 'https://api.deepseek.com', model: 'deepseek-v4-flash', profile: '传播学硕士，目标品牌传播岗位',
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer deepseek-test-key');
  assert.deepEqual(requests[0].body.response_format, { type: 'json_object' });
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.match(requests[0].body.messages[1].content, /json/);
  assert.equal(result.results[0].score, 88);
  assert.equal(result.usage.totalTokens, 20);
});

test('DeepSeek client maps an invalid API key without retrying', async () => {
  let calls = 0;
  const client = new DeepSeekClient({
    maxAttempts: 3,
    sleep: async () => {},
    fetchImpl: async () => {
      calls++;
      return new Response(JSON.stringify({ error: { message: 'Authentication Fails' } }), { status: 401, headers: { 'Content-Type': 'application/json' } });
    },
  });
  await assert.rejects(() => client.assessJobs([{ id: 'job_1' }], { apiKey: 'bad-key' }), error => {
    assert.ok(error instanceof AiApiError);
    assert.equal(error.statusCode, 400);
    assert.match(error.message, /API Key/);
    return true;
  });
  assert.equal(calls, 1);
});

test('AI runtime persists redacted settings, queues assessments and reuses fresh cache', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const classified = classifyRecords([rawRecord()], { id: 'src_ai', name: 'AI 测试表', fieldMap: {} }, new Date(FIXED_NOW).toISOString());
  service.applyCloudSync({ sourceId: 'src_ai', sourceName: 'AI 测试表', jobs: classified.jobs, syncAt: new Date(FIXED_NOW).toISOString() });
  let calls = 0;
  const aiClient = {
    async assessJobs(jobs) {
      calls++;
      return {
        results: jobs.map(job => ({ jobId: job.id, score: 93, recommendation: '强烈推荐', matchedRoles: ['品牌传播'], reason: '画像、岗位方向和地点高度匹配', risks: [], confidence: 0.95 })),
        usage: { inputTokens: 100, outputTokens: 50 }, model: 'deepseek-v4-flash',
      };
    },
    async testConnection(settings) { return { model: settings.model, latencyMs: 5, usage: { totalTokens: 1 } }; },
  };
  const runtime = new CloudRuntime({ dataDir: directory, jobService: service, clock: () => FIXED_NOW, aiClient, env: {} }).initialize({ startScheduler: false });
  let server;
  try {
    const settings = runtime.updateAiSettings({ apiKey: 'server-only-deepseek-key', batchSize: 4, maxJobs: 10 });
    assert.equal(settings.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(settings, 'apiKey'), false);
    assert.equal(settings.keySource, 'saved');

    const first = runtime.enqueueAi({ scope: 'candidates', limit: 10 });
    assert.equal(first.queued, true);
    await runtime.waitForIdle();
    assert.equal(calls, 1);
    assert.equal(runtime.listAiRuns()[0].assessedCount, 1);
    const enriched = runtime.enrichJobs(service.snapshot().jobs)[0];
    assert.equal(enriched.aiAssessment.score, 93);
    assert.equal(enriched.aiAssessment.fresh, true);

    runtime.enqueueAi({ scope: 'candidates', limit: 10 });
    await runtime.waitForIdle();
    assert.equal(calls, 1, 'fresh cache should avoid a second model call');
    assert.equal(runtime.listAiRuns()[0].cachedCount, 1);
    assert.equal(runtime.listAiRuns()[0].assessedCount, 0);

    runtime.updateAiSettings({ profile: '新的画像：重点关注品牌、公关和内容策略' });
    assert.equal(runtime.aiDashboard().stats.staleCount, 1);
    runtime.enqueueAi({ scope: 'candidates', limit: 10 });
    await runtime.waitForIdle();
    assert.equal(calls, 2, 'profile change should invalidate the cache');

    const app = createApp({ service, cloud: runtime, syncToken: 'sync-secret-123456', editPassword: '' });
    server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const dashboard = await (await fetch(`${base}/api/cloud/ai`)).json();
    assert.equal(dashboard.settings.apiKeyConfigured, true);
    assert.equal(Object.hasOwn(dashboard.settings, 'apiKey'), false);
    const jobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(jobs.jobs[0].aiAssessment.score, 93);
    const tested = await (await fetch(`${base}/api/cloud/ai/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
    assert.equal(tested.result.model, 'deepseek-v4-flash');
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await runtime.shutdown();
    cleanup(directory);
  }
});

test('AI non-force runs continue in bounded chunks until every active job is assessed', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const source = { id: 'src_all_ai', name: 'AI 全量表', fieldMap: {} };
  const records = [...Array(5)].map((_, index) => ({
    ...rawRecord(),
    _id: `row_${index + 1}`,
    公司名称: `示例品牌${index + 1}`,
    招聘岗位: `品牌传播岗位${index + 1}`,
    投递方式: `https://example.com/apply/${index + 1}`,
  }));
  const classified = classifyRecords(records, source, new Date(FIXED_NOW).toISOString());
  service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: classified.jobs, syncAt: new Date(FIXED_NOW).toISOString() });
  let calls = 0;
  const aiClient = {
    async assessJobs(jobs) {
      calls++;
      return {
        results: jobs.map(job => ({ jobId: job.id, score: 80, recommendation: '推荐', matchedRoles: ['品牌传播'], reason: '批量评估通过', risks: [], confidence: 0.8 })),
        usage: { inputTokens: 10 * jobs.length, outputTokens: 5 * jobs.length },
      };
    },
  };
  const runtime = new CloudRuntime({ dataDir: directory, jobService: service, clock: () => FIXED_NOW, aiClient, env: {} }).initialize({ startScheduler: false });
  try {
    runtime.updateAiSettings({ apiKey: 'server-only-deepseek-key', scope: 'all', maxJobs: 2, batchSize: 20 });
    runtime.enqueueAi({ scope: 'all', limit: 2, force: false });
    await runtime.waitForIdle();
    const runs = runtime.listAiRuns({ limit: 10 });
    assert.equal(calls, 3);
    assert.equal(runs.length, 3);
    assert.ok(runs.every(run => run.status === 'success' && run.assessedCount <= 2));
    assert.equal(runs.filter(run => run.trigger === 'ai-continuation').length, 2);
    assert.equal(runtime.listAiAssessments().length, 5);
    assert.equal(runtime.aiDashboard().stats.staleCount, 0);
  } finally {
    await runtime.shutdown();
    cleanup(directory);
  }
});

test('reconciliation keeps the newest AI assessment when duplicate job IDs collapse', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const runtime = new CloudRuntime({ dataDir: directory, jobService: service, clock: () => FIXED_NOW, env: {} }).initialize({ startScheduler: false });
  try {
    const source = runtime.createSource({
      name: 'AI 去重表', kind: 'json', url: 'https://example.com/jobs.json', schedule: '10:00', authProfile: 'ai-reconcile', enabled: true,
    });
    const classified = classifyRecords([rawRecord()], source, new Date(FIXED_NOW).toISOString());
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: classified.jobs, syncAt: new Date(FIXED_NOW).toISOString() });
    const current = service.snapshot().jobs[0];
    service.applySync({ jobs: [current, { ...current, id: 'legacy-ai-duplicate', origins: '[]', originIds: '[]', sourceRecordIds: '[]' }] });
    runtime.store.upsertAiAssessments([
      { jobId: current.id, contentHash: 'old-content', profileHash: 'profile', model: 'model', score: 70, recommendation: '推荐', assessedAt: '2026-08-25T00:00:00.000Z' },
      { jobId: 'legacy-ai-duplicate', contentHash: 'new-content', profileHash: 'profile', model: 'model', score: 96, recommendation: '强烈推荐', assessedAt: '2026-08-26T00:00:00.000Z' },
    ]);
    const result = runtime.reconcileJobs();
    assert.equal(result.duplicatesRemoved, 1);
    assert.equal(result.ai.remapped, 1);
    assert.equal(result.ai.dropped, 1);
    const assessments = runtime.store.listAiAssessments();
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0].jobId, current.id);
    assert.equal(assessments[0].score, 96);
  } finally {
    await runtime.shutdown();
    cleanup(directory);
  }
});

test('source synchronization remaps AI assessments from merged legacy aliases', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const runtime = new CloudRuntime({
    dataDir: directory,
    jobService: service,
    clock: () => FIXED_NOW,
    env: {},
    fetchSource: async () => [rawRecord()],
  }).initialize({ startScheduler: false });
  try {
    const source = runtime.createSource({
      name: '旧 ID 迁移表', kind: 'json', url: 'https://example.com/jobs.json', schedule: '10:00', authProfile: 'alias-remap', enabled: true,
    });
    const candidate = classifyRecords([rawRecord()], source, new Date(FIXED_NOW).toISOString()).jobs[0];
    const legacyFields = { ...candidate, origins: '[]', originIds: '[]', sourceRecordIds: '[]' };
    service.applySync({ jobs: [{ ...legacyFields, id: 'legacy-a' }, { ...legacyFields, id: 'legacy-z' }] });
    runtime.store.upsertAiAssessments([{
      jobId: 'legacy-z', contentHash: 'legacy-content', profileHash: 'profile', model: 'model', score: 91,
      recommendation: '强烈推荐', reason: '旧评分需要跟随合并', assessedAt: '2026-08-26T00:00:00.000Z',
    }]);
    runtime.enqueueSource(source.id, 'test-alias-remap');
    await runtime.waitForIdle();
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    const assessments = runtime.store.listAiAssessments();
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'legacy-a');
    assert.equal(assessments.length, 1);
    assert.equal(assessments[0].jobId, 'legacy-a');
    assert.equal(assessments[0].score, 91);
    assert.equal(runtime.listRuns({ limit: 1 })[0].detail.merged.aiRemap.remapped, 1);
  } finally {
    await runtime.shutdown();
    cleanup(directory);
  }
});
