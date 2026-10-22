'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { registerAccountRoutes } = require('../server/product/account');
const { parseCookies } = require('../server/product/auth');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-account-'));
  const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => ({ jobs: [] }) } }).initialize();
  const router = express.Router(); router.use(express.json());
  const requireAuth = (req, res, next) => {
    req.productToken = String(req.headers.authorization || '').replace(/^Bearer /, '') || parseCookies(req.headers.cookie).account_test || '';
    req.productUser = platform.authenticate(req.productToken);
    if (!req.productUser) return res.status(401).json({ ok: false, error: '请登录' });
    next();
  };
  registerAccountRoutes(router, { platform, requireAuth, cookieName: 'account_test', secureCookies: true });
  const app = express(); app.use('/api/v1', router, createProductRouter({ platform, cookieName: 'account_test' }));
  app.use((error, req, res, next) => { void req; void next; res.status(error.statusCode || 500).json({ ok: false, error: error.message, code: error.code }); });
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const call = async (route, token, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, cookie: response.headers.get('set-cookie'), ...await response.json() };
  };
  const account = await platform.register({ email: 'one@example.com', displayName: 'One', password: 'Initial-password-123' });
  const otherSession = await platform.login({ email: 'one@example.com', password: 'Initial-password-123' });
  const second = await platform.register({ email: 'two@example.com', displayName: 'Two', password: 'Second-password-123' });
  const admin = await platform.register({ email: 'admin@example.com', displayName: 'Admin', password: 'Admin-password-123' });
  platform.store.setUserRole(admin.user.id, 'admin');
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { platform, call, account, otherSession, second, admin };
}

test('session inventory exposes only own metadata and rejects cross-user revocation', async t => {
  const f = await fixture(t);
  const result = await f.call('/me/sessions', f.account.token);
  assert.equal(result.status, 200);
  assert.equal(result.total, 2);
  assert.equal(result.sessions.filter(session => session.current).length, 1);
  assert.deepEqual(Object.keys(result.sessions[0]).sort(), ['createdAt', 'current', 'expiresAt', 'id']);
  const other = result.sessions.find(session => !session.current);
  assert.equal((await f.call(`/me/sessions/${other.id}`, f.second.token, 'DELETE', {})).status, 404);
  assert.ok(f.platform.authenticate(f.otherSession.token));
  assert.equal((await f.call(`/me/sessions/${other.id}`, f.account.token, 'DELETE', {})).status, 200);
  assert.equal(f.platform.authenticate(f.otherSession.token), null);
  assert.ok(f.platform.authenticate(f.account.token));
});

test('wrong current password and invalid new password do not alter sessions or credentials', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/me/password', f.account.token, 'POST', { currentPassword: 'wrong-password', newPassword: 'New-password-123' })).status, 401);
  assert.equal((await f.call('/me/password', f.account.token, 'POST', { currentPassword: 'Initial-password-123', newPassword: 'short' })).status, 400);
  const same = await f.call('/me/password', f.account.token, 'POST', { currentPassword: 'Initial-password-123', newPassword: 'Initial-password-123' });
  assert.equal(same.code, 'PASSWORD_UNCHANGED');
  assert.ok(f.platform.authenticate(f.account.token));
  assert.ok(f.platform.authenticate(f.otherSession.token));
  const login = await f.platform.login({ email: 'one@example.com', password: 'Initial-password-123' });
  assert.ok(login.token);
});

test('password update revokes every old session and returns a replacement cookie and valid session', async t => {
  const f = await fixture(t);
  const changed = await f.call('/me/password', f.account.token, 'POST', { currentPassword: 'Initial-password-123', newPassword: 'Replacement-password-456' });
  assert.equal(changed.status, 200);
  assert.match(changed.cookie, /^account_test=/);
  assert.match(changed.cookie, /HttpOnly/);
  assert.match(changed.cookie, /Secure/);
  assert.equal(f.platform.authenticate(f.account.token), null);
  assert.equal(f.platform.authenticate(f.otherSession.token), null);
  assert.ok(f.platform.authenticate(changed.sessionToken));
  assert.ok(f.platform.authenticate(f.second.token));
  const sessions = await f.call('/me/sessions', changed.sessionToken);
  assert.equal(sessions.sessions.length, 1);
  assert.equal(sessions.sessions[0].current, true);
  await assert.rejects(f.platform.login({ email: 'one@example.com', password: 'Initial-password-123' }), error => error.code === 'INVALID_CREDENTIALS');
  assert.ok((await f.platform.login({ email: 'one@example.com', password: 'Replacement-password-456' })).token);
  const row = f.platform.store.getUserWithPasswordByEmail('one@example.com');
  assert.ok(row.passwordHash.startsWith('scrypt-v1$'));
  assert.ok(!row.passwordHash.includes('Replacement-password'));
});

test('concurrent password changes cannot revive sessions from an obsolete password', async t => {
  const f = await fixture(t);
  const results = await Promise.all(['Concurrent-password-A', 'Concurrent-password-B'].map(newPassword => f.call('/me/password', f.account.token, 'POST', { currentPassword: 'Initial-password-123', newPassword })));
  assert.equal(results.filter(result => result.status === 200).length, 1);
  assert.ok(results.some(result => [401, 409].includes(result.status)));
  const winner = results.find(result => result.status === 200);
  assert.equal((await f.call('/me/sessions', winner.sessionToken)).sessions.length, 1);
});

test('current logout clears correct cookie; ending others leaves the current session valid', async t => {
  const f = await fixture(t);
  const others = await f.call('/me/sessions', f.account.token, 'DELETE', {});
  assert.equal(others.revoked, 1);
  assert.equal(others.revokedCurrent, false);
  assert.ok(f.platform.authenticate(f.account.token));
  const session = (await f.call('/me/sessions', f.account.token)).sessions[0];
  const ended = await f.call(`/me/sessions/${session.id}`, f.account.token, 'DELETE', {});
  assert.equal(ended.revokedCurrent, true);
  assert.match(ended.cookie, /^account_test=;/);
  assert.match(ended.cookie, /Max-Age=0/);
  assert.equal(f.platform.authenticate(f.account.token), null);
});

test('administrator session reset requires role and reason and writes an audit record', async t => {
  const f = await fixture(t);
  const endpoint = `/admin/users/${f.account.user.id}/sessions`;
  assert.equal((await f.call(endpoint, f.second.token, 'DELETE', { reason: 'test' })).status, 403);
  assert.equal((await f.call(endpoint, f.admin.token, 'DELETE', {})).status, 400);
  assert.ok(f.platform.authenticate(f.account.token));
  const reset = await f.call(endpoint, f.admin.token, 'DELETE', { reason: 'User reported a lost device' });
  assert.equal(reset.status, 200);
  assert.equal(reset.revoked, 2);
  assert.equal(f.platform.authenticate(f.account.token), null);
  assert.equal(f.platform.authenticate(f.otherSession.token), null);
  const audit = f.platform.store.db.prepare("SELECT * FROM admin_audit WHERE action='user.sessions_revoked'").get();
  assert.equal(audit.target_id, f.account.user.id);
  assert.equal(JSON.parse(audit.detail_json).revoked, 2);
});
