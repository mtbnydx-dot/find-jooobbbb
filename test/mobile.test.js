'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');

async function fixture(t, options = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-mobile-'));
  let now = Date.parse('2026-10-23T08:00:00Z');
  const snapshot = { jobs: [{ id: 'a', company: 'A', position: '开发', deadline: '2026-10-23' }, { id: 'b', company: 'B', position: '开发', deadline: '2026-10-22' }, { id: 'c', company: 'C', position: '开发', deadline: '长期招聘' }] };
  const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => snapshot }, clock: () => now, ...options }).initialize();
  const account = await platform.register({ email: 'one@example.com', password: 'Initial-password-123' });
  const second = await platform.register({ email: 'two@example.com', password: 'Initial-password-123' });
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (route, { token = account.token, method = 'GET', body, headers = {} } = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: response.status === 204 ? null : await response.json() };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { platform, account, second, call, snapshot, advance: ms => { now += ms; }, dataDir };
}

test('single and batch attempts replay persisted results without consuming quota; conflicting payload and users are isolated', async t => {
  const f = await fixture(t);
  const payload = { questionId: 'q_job_1', response: '1', idempotencyKey: 'retry-single' };
  const first = f.platform.submitPrepAttempt(f.account.user, payload);
  const replay = f.platform.submitPrepAttempt(f.account.user, payload);
  assert.equal(replay.replayed, true); assert.deepEqual(replay.attempt, first.attempt);
  assert.throws(() => f.platform.submitPrepAttempt(f.account.user, { ...payload, response: '0' }), e => e.code === 'IDEMPOTENCY_CONFLICT' && e.statusCode === 409);
  const batch = { answers: [{ questionId: 'q_job_1', response: '1' }, { questionId: 'q_job_2', response: '1' }] };
  const headers = { 'Idempotency-Key': 'retry-batch' };
  const original = await f.call('/prep/attempts', { method: 'POST', body: batch, headers });
  const repeated = await f.call('/prep/attempts', { method: 'POST', body: batch, headers });
  assert.equal(original.status, 201); assert.equal(repeated.body.replayed, true); assert.deepEqual(repeated.body.result, original.body.result);
  assert.equal(f.platform.store.db.prepare('SELECT COUNT(*) n FROM prep_attempts WHERE user_id=?').get(f.account.user.id).n, 3);
  f.platform.submitPrepAttempts(f.account.user, batch);
  assert.equal(f.platform.submitPrepAttempts(f.account.user, payload).replayed, true);
  assert.throws(() => f.platform.submitPrepAttempts(f.account.user, { ...payload, idempotencyKey: 'over-quota' }), e => e.code === 'ENTITLEMENT_LIMIT');
  assert.equal(f.platform.store.db.prepare("SELECT COUNT(*) n FROM request_idempotency WHERE key='over-quota'").get().n, 0);
  f.platform.submitPrepAttempt(f.second.user, payload);
  assert.equal(f.platform.store.db.prepare('SELECT COUNT(*) n FROM prep_attempts WHERE user_id=?').get(f.second.user.id).n, 1);
  const other = new ProductPlatform({ dataDir: f.dataDir, jobService: { snapshot: () => f.snapshot }, clock: f.platform.clock }).initialize();
  try { assert.equal(other.submitPrepAttempts(f.account.user, payload).replayed, true); } finally { other.close(); }
  assert.equal((await f.call('/prep/attempts', { method: 'POST', body: payload, headers: { 'Idempotency-Key': 'different' } })).status, 400);
});

test('profile optimistic updates reject stale writes without changing profile or user display name', async t => {
  const f = await fixture(t); const initial = f.platform.getProfile(f.account.user.id);
  const updated = f.platform.updateProfile(f.account.user, { displayName: 'Phone', expectedVersion: initial.version });
  assert.equal(updated.version, initial.version + 1);
  const stale = await f.call('/me/profile', { method: 'PUT', body: { displayName: 'Old laptop', expectedVersion: initial.version } });
  assert.equal(stale.status, 409); assert.equal(stale.body.detail.resource, 'profile');
  assert.equal(f.platform.store.getUser(f.account.user.id).displayName, 'Phone');
  assert.equal(f.platform.getProfile(f.account.user.id).version, updated.version);
  assert.equal((await f.call('/me/profile', { method: 'PUT', body: { expectedVersion: '2' } })).status, 400);
});

test('exam versions protect drafts and submission; finalized GET and retry return identical frozen results', async t => {
  const f = await fixture(t);
  const created = f.platform.startExamSession(f.account.user, { packId: 'exam_huzhou_cloud' });
  const id = created.session.id;
  const saved = f.platform.saveExamSession(f.account.user, id, { answers: { q_job_1: '1' }, expectedVersion: 1 });
  assert.equal(saved.version, 2);
  for (const suffix of ['', '/submit']) {
    const stale = await f.call(`/exams/sessions/${id}${suffix}`, { method: suffix ? 'POST' : 'PUT', body: { answers: { q_job_1: '0' }, expectedVersion: 1 } });
    assert.equal(stale.status, 409); assert.equal(stale.body.detail.currentVersion, 2);
  }
  assert.equal(f.platform.store.getExamSession(id, f.account.user.id).answers.q_job_1, '1');
  const submitted = f.platform.submitExamSession(f.account.user, id, { expectedVersion: 2 });
  assert.equal(submitted.session.version, 3); assert.equal(submitted.result.items.length, 6);
  const read = await f.call(`/exams/sessions/${id}`);
  assert.deepEqual(read.body.result, submitted.result);
  const repeated = f.platform.submitExamSession(f.account.user, id, { expectedVersion: 1, answers: { q_job_1: '0' } });
  assert.equal(repeated.submittedNow, false); assert.deepEqual(repeated.result, submitted.result);
  assert.equal((await f.call(`/exams/sessions/${id}`, { token: f.second.token })).status, 404);
  assert.equal(f.platform.store.db.prepare('SELECT COUNT(*) n FROM prep_attempts WHERE user_id=?').get(f.account.user.id).n, 6);
});

test('session renewal rotates opaque token, preserves device metadata and never revives an expired session', async t => {
  const f = await fixture(t);
  const login = await f.platform.login({ email: f.account.user.email, password: 'Initial-password-123', device: { name: 'Phone', platform: 'ios', appVersion: '1.0' } });
  const refreshed = await f.call('/auth/refresh', { token: login.token, method: 'POST', body: {} });
  assert.equal(refreshed.status, 200); assert.match(refreshed.headers.get('set-cookie'), /HttpOnly/);
  assert.equal(f.platform.authenticate(login.token), null); assert.ok(f.platform.authenticate(refreshed.body.sessionToken));
  assert.equal((await f.call('/auth/refresh', { token: login.token, method: 'POST', body: {} })).status, 401);
  const inventory = await f.call('/me/sessions?metadata=1', { token: refreshed.body.sessionToken });
  assert.equal(inventory.body.sessions.find(s => s.current).device.platform, 'ios');
  assert.ok(inventory.body.sessions.every(s => !s.tokenHash && !s.token));
  f.advance(f.platform.sessionTtlMs + 1);
  assert.equal((await f.call('/auth/refresh', { token: refreshed.body.sessionToken, method: 'POST', body: {} })).status, 401);
});

test('explicit CORS allowlist and capabilities support native Bearer and reject unknown browser origins', async t => {
  const f = await fixture(t, { corsOrigins: ['https://mobile.example.com'] });
  const native = await f.call('/auth/capabilities', { token: '' }); assert.equal(native.status, 200); assert.equal(native.body.features.examVersion, true);
  assert.equal(native.body.recovery.passwordResetConfigured, false);
  const preflight = await f.call('/auth/me', { method: 'OPTIONS', token: '', headers: { Origin: 'https://mobile.example.com', 'Access-Control-Request-Method': 'GET' } });
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://mobile.example.com');
  assert.equal((await f.call('/auth/me', { headers: { Origin: 'https://evil.example.com' } })).status, 403);
  assert.equal((await f.call('/auth/me')).status, 200);
});

test('job availability changes at China midnight; version-bound cursors reject changed queries and catalogs', async t => {
  const f = await fixture(t);
  const page = f.platform.listJobs({ limit: 1 }); assert.equal(page.total, 2); assert.ok(page.nextCursor);
  assert.equal(f.platform.listJobs({ cursor: page.nextCursor, limit: 1 }).items.length, 1);
  assert.throws(() => f.platform.listJobs({ cursor: page.nextCursor, filters: { q: 'A' } }), e => e.code === 'CURSOR_STALE');
  assert.equal(f.platform.listJobs({ filters: { availability: 'expired' } }).total, 1);
  assert.equal(f.platform.getJob('b').availability.status, 'expired');
  f.advance(8 * 3600000 + 1);
  assert.equal(f.platform.getJob('a').availability.status, 'expired');
  assert.equal(f.platform.listJobs().total, 1);
  assert.throws(() => f.platform.listJobs({ cursor: page.nextCursor }), e => e.code === 'CURSOR_STALE');
  assert.equal(f.platform.listJobs({ cursor: Buffer.from('1').toString('base64url'), filters: { availability: 'all' } }).items.length, 2);
});
