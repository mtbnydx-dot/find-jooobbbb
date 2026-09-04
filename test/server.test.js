'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  InputError,
  safeEqual,
  validateSyncPayload,
  createService,
  createApp,
  createFailureLimiter,
  parseBearer,
  parsePort,
  parseBindHost,
} = require('../server/server');

const FIXED_NOW = Date.parse('2026-08-08T00:00:00.000Z');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-sync-server-'));
}

function cleanup(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())), 'refuse to clean outside temp');
  fs.rmSync(directory, { recursive: true, force: true });
}

function job(overrides = {}) {
  return {
    id: 'job_001',
    company: '示例公司',
    position: '后端工程师',
    status: '未投递',
    statusUpdatedAt: '',
    ...overrides,
  };
}

test('constant-time helper and strict bearer/port parsing keep their boundaries', () => {
  assert.equal(safeEqual('abc', 'abc'), true);
  assert.equal(safeEqual('abc', 'abcd'), false);
  assert.equal(safeEqual(null, 'abc'), false);
  assert.equal(parseBearer('Bearer abc-123'), 'abc-123');
  assert.equal(parseBearer('abc-123'), '');
  assert.equal(parseBearer('Bearer abc extra'), '');
  assert.equal(parsePort('3000'), 3000);
  assert.throws(() => parsePort('named-pipe'));
  assert.throws(() => parsePort('70000'));
  assert.equal(parseBindHost(undefined), '');
  assert.equal(parseBindHost('127.0.0.1'), '127.0.0.1');
  assert.equal(parseBindHost('localhost'), 'localhost');
  assert.throws(() => parseBindHost('host/name'));
});

test('sync validation rejects destructive ambiguity and invalid records atomically', () => {
  assert.throws(() => validateSyncPayload({}, FIXED_NOW), /jobs 必须是数组/);
  assert.deepEqual(validateSyncPayload({ jobs: [] }, FIXED_NOW).jobs, []);
  assert.throws(() => validateSyncPayload({ jobs: [job(), job()] }, FIXED_NOW), /重复/);
  assert.throws(() => validateSyncPayload({ jobs: [job({ status: '任意状态' })] }, FIXED_NOW), /status 非法/);
  assert.throws(() => validateSyncPayload({ jobs: [job({ company: { nested: true } })] }, FIXED_NOW), /必须是字符串或标量值/);
  assert.throws(() => validateSyncPayload({ jobs: [job({ statusUpdatedAt: '2026/08/07 10:00:00' })] }, FIXED_NOW), /ISO 8601/);
  assert.throws(() => validateSyncPayload({ jobs: [job({ injected: 'value' })] }, FIXED_NOW), /未知字段/);
});

test('ISO offsets are compared as instants and server wins exact ties', () => {
  const directory = tempDirectory();
  try {
    const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
    service.load();
    service.applySync({ jobs: [job({ status: '已投递', statusUpdatedAt: '2026-08-07T10:00:00+10:00' })] });
    const newer = service.applySync({ jobs: [job({ status: '笔试', statusUpdatedAt: '2026-08-07T01:00:00Z' })] });
    assert.equal(newer.stateTaken, 1);
    assert.equal(service.snapshot().jobs[0].status, '笔试');

    service.applySync({ jobs: [job({ status: '一面', statusUpdatedAt: '2026-08-07T10:30:00+10:00' })] });
    assert.equal(service.snapshot().jobs[0].status, '笔试');
    service.applySync({ jobs: [job({ status: '挂', statusUpdatedAt: '2026-08-07T01:00:00Z' })] });
    assert.equal(service.snapshot().jobs[0].status, '笔试');
  } finally {
    cleanup(directory);
  }
});

test('web edits can clear notes and failed persistence does not mutate memory', () => {
  const directory = tempDirectory();
  try {
    const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
    service.load();
    service.applySync({ jobs: [job({ note: '旧备注' })] });
    const cleared = service.applyWebEdit('job_001', { status: '已投递', note: '' });
    assert.equal(cleared.job.note, '');
    assert.equal(cleared.job.appliedAt, '2026/08/08');
    const auditLog = fs.readFileSync(service.paths.logFile, 'utf8');
    assert.doesNotMatch(auditLog, /旧备注/);
    assert.match(auditLog, /"noteChanged":true/);

    const before = JSON.stringify(service.snapshot());
    const originalRename = fs.renameSync;
    fs.renameSync = function injectedRenameFailure(source, destination) {
      if (destination === service.paths.jobsFile) {
        const error = new Error('injected rename failure');
        error.code = 'EIO';
        throw error;
      }
      return originalRename.call(fs, source, destination);
    };
    try {
      assert.throws(() => service.applyWebEdit('job_001', { status: '笔试' }), /injected rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }
    assert.equal(JSON.stringify(service.snapshot()), before);
  } finally {
    cleanup(directory);
  }
});

test('removing a custom flag keeps a source-derived job instead of deleting it', () => {
  const directory = tempDirectory();
  try {
    const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
    service.load();
    service.applySync({ jobs: [job({ source: '符合条件', classification: '符合条件', isCustom: '0' })] });
    const marked = service.applyMarkCustom('job_001');
    assert.equal(marked.job.isCustom, '1');

    const result = service.applyCustomDelete('job_001');
    assert.equal(result.ok, true);
    assert.equal(result.unmarked, true);
    assert.equal(result.job.isCustom, '0');
    assert.equal(service.snapshot().jobs.length, 1);
    assert.equal(service.snapshot().jobs[0].source, '符合条件');
  } finally {
    cleanup(directory);
  }
});

test('restart recovers a validated backup and never overwrites unrecoverable JSON', () => {
  const directory = tempDirectory();
  const brokenDirectory = tempDirectory();
  try {
    const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
    service.load();
    service.applySync({ jobs: [job({ company: '第一版' })] });
    service.applySync({ jobs: [job({ company: '第二版' })] });
    fs.writeFileSync(service.paths.jobsFile, '{broken', 'utf8');

    const recovered = createService({ dataDir: directory, clock: () => FIXED_NOW + 1000 });
    recovered.load();
    assert.equal(recovered.snapshot().jobs[0].company, '第一版');
    assert.ok(fs.readdirSync(directory).some(name => name.startsWith('jobs.json.corrupt-')));

    const unrecoverable = createService({ dataDir: brokenDirectory, clock: () => FIXED_NOW });
    fs.writeFileSync(unrecoverable.paths.jobsFile, '{still-broken', 'utf8');
    assert.throws(() => unrecoverable.load(), /原文件未被覆盖/);
    assert.equal(fs.readFileSync(unrecoverable.paths.jobsFile, 'utf8'), '{still-broken');
  } finally {
    cleanup(directory);
    cleanup(brokenDirectory);
  }
});

test('failure limiter is bounded by a retry window', () => {
  let now = 1000;
  const limiter = createFailureLimiter({ limit: 2, windowMs: 1000, blockMs: 5000, clock: () => now });
  limiter.fail('client');
  assert.equal(limiter.retryAfter('client'), 0);
  limiter.fail('client');
  assert.equal(limiter.retryAfter('client'), 5);
  now += 5001;
  assert.equal(limiter.retryAfter('client'), 0);
});

test('HTTP API returns bounded JSON errors without changing the contract', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const app = createApp({ service, syncToken: 'sync-secret-123456', editPassword: 'edit-secret-123456', legacySyncEnabled: true });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sync-secret-123456' },
      body: '{}',
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal((await response.json()).ok, false);

    response = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'sync-secret-123456' },
      body: '{"jobs":[]}',
    });
    assert.equal(response.status, 401);

    response = await fetch(`${base}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sync-secret-123456' },
      body: '{bad-json',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error, '请求 JSON 无效');

    response = await fetch(`${base}/api/jobs/job_001/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null',
    });
    assert.equal(response.status, 400);
    assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000');

    response = await fetch(`${base}/api/jobs/job_001/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456', status: '未投递', note: 'x'.repeat(20_000) }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, '请求体过大');

    response = await fetch(`${base}/api/jobs`);
    const data = await response.json();
    assert.ok(Array.isArray(data.jobs));
    assert.ok(isPlainObjectForTest(data.meta));
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanup(directory);
  }
});

test('legacy sync endpoint is disabled by default and cannot overwrite cloud jobs', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  service.applySync({ jobs: [job({ company: '保留岗位' })] });
  const app = createApp({ service, syncToken: 'sync-secret-123456' });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sync-secret-123456' },
      body: JSON.stringify({ jobs: [job({ company: '不应覆盖' })] }),
    });
    assert.equal(response.status, 410);
    assert.match((await response.json()).error, /已停用/);
    assert.equal(service.snapshot().jobs[0].company, '保留岗位');
  } finally {
    await new Promise(resolve => server.close(resolve));
    cleanup(directory);
  }
});

test('edit password is optional when unset and remains enforceable when configured', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  service.applySync({ jobs: [{
    id: 'job_001', source: '全部岗位', company: '示例传媒', position: '内容运营', location: '上海',
    status: '未投递', statusUpdatedAt: '',
  }] });

  const openApp = createApp({ service, editPassword: '' });
  const openServer = await new Promise(resolve => {
    const instance = openApp.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const openBase = `http://127.0.0.1:${openServer.address().port}`;
  try {
    const health = await (await fetch(`${openBase}/api/health`)).json();
    assert.equal(health.editPasswordRequired, false);
    const response = await fetch(`${openBase}/api/jobs/job_001/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '已投递', note: '无需密码' }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).job.status, '已投递');
  } finally {
    await new Promise(resolve => openServer.close(resolve));
  }

  const protectedApp = createApp({ service, editPassword: 'edit-secret-123456' });
  const protectedServer = await new Promise(resolve => {
    const instance = protectedApp.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const protectedBase = `http://127.0.0.1:${protectedServer.address().port}`;
  try {
    const health = await (await fetch(`${protectedBase}/api/health`)).json();
    assert.equal(health.editPasswordRequired, true);
    let response = await fetch(`${protectedBase}/api/jobs/job_001/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: '一面' }),
    });
    assert.equal(response.status, 401);
    response = await fetch(`${protectedBase}/api/jobs/job_001/status`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456', status: '一面' }),
    });
    assert.equal(response.status, 200);
  } finally {
    await new Promise(resolve => protectedServer.close(resolve));
    cleanup(directory);
  }
});

function isPlainObjectForTest(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

test('InputError remains distinguishable for API mapping', () => {
  assert.ok(new InputError('bad') instanceof Error);
});

test('frontend and deployment templates keep XSS and secret regressions out', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'app.js'), 'utf8');
  const indexSource = fs.readFileSync(path.join(__dirname, '..', 'server', 'public', 'index.html'), 'utf8');
  const compose = fs.readFileSync(path.join(__dirname, '..', 'server', 'docker-compose.yml'), 'utf8');
  const dockerfile = fs.readFileSync(path.join(__dirname, '..', 'server', 'Dockerfile'), 'utf8');
  assert.doesNotMatch(appSource, /\.(?:innerHTML|outerHTML)\s*=/);
  assert.doesNotMatch(appSource, /localStorage\.setItem/);
  assert.match(appSource, /url\.protocol === 'http:' \|\| url\.protocol === 'https:'/);
  assert.match(appSource, /AI 推荐/);
  assert.match(appSource, /btnReconcile/);
  assert.match(indexSource, /class="exam-entry" href="\/exam\/" target="_blank" rel="noopener"/);
  assert.match(indexSource, />笔试题库<\/a>/);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /\$\{SYNC_TOKEN:\?/);
  assert.match(compose, /\$\{AI_EDIT_PASSWORD:\?/);
  assert.doesNotMatch(compose, /改成你的同步token|改成你的编辑密码/);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /USER node/);
});
