'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ProductPlatform } = require('../server/product');

async function fixture(t, configured = true) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-recovery-')); const messages = [];
  let now = Date.parse('2026-10-23T08:00:00Z');
  const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => ({ jobs: [] }) }, clock: () => now,
    ...(configured ? { publicAppUrl: 'https://jobs.example.com/app', authMessageSender: async message => { messages.push(message); } } : {}) }).initialize();
  const account = await platform.register({ email: 'one@example.com', password: 'Initial-password-123' });
  t.after(() => { platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { platform, account, recovery: platform.recovery, messages, token: () => new URL(messages.at(-1).actionUrl).hash.split('=')[1], advance: ms => { now += ms; } };
}

test('unconfigured delivery explicitly returns 503 without issuing tokens or pretending a message was sent', async t => {
  const f = await fixture(t, false);
  await assert.rejects(f.recovery.forgotPassword({ email: f.account.user.email }), e => e.statusCode === 503 && e.code === 'AUTH_DELIVERY_UNAVAILABLE');
  await assert.rejects(f.recovery.requestVerification(f.account.user), e => e.statusCode === 503);
  assert.equal(f.platform.store.db.prepare('SELECT COUNT(*) n FROM auth_action_tokens').get().n, 0);
});

test('password reset is one-use, trusted-link-only, stored hashed, and revokes every old session', async t => {
  const f = await fixture(t); const another = await f.platform.login({ email: f.account.user.email, password: 'Initial-password-123' });
  const unknown = await f.recovery.forgotPassword({ email: 'missing@example.com' });
  const requested = await f.recovery.forgotPassword({ email: f.account.user.email }); assert.deepEqual(requested, unknown);
  assert.equal(f.messages.length, 1); assert.match(f.messages[0].actionUrl, /^https:\/\/jobs.example.com\/app\/reset-password#token=/);
  const token = f.token(); const stored = f.platform.store.db.prepare('SELECT * FROM auth_action_tokens').get();
  assert.ok(!JSON.stringify(stored).includes(token));
  await assert.rejects(f.recovery.resetPassword({ token, newPassword: 'short' }), e => e.code === 'INVALID_PASSWORD');
  assert.ok(f.platform.authenticate(f.account.token));
  assert.deepEqual(await f.recovery.resetPassword({ token, newPassword: 'Replacement-password-456' }), { reset: true, requiresLogin: true });
  assert.equal(f.platform.authenticate(f.account.token), null); assert.equal(f.platform.authenticate(another.token), null);
  await assert.rejects(f.platform.login({ email: f.account.user.email, password: 'Initial-password-123' }), e => e.code === 'INVALID_CREDENTIALS');
  assert.ok((await f.platform.login({ email: f.account.user.email, password: 'Replacement-password-456' })).token);
  await assert.rejects(f.recovery.resetPassword({ token, newPassword: 'Another-password-789' }), e => e.code === 'INVALID_AUTH_TOKEN');
});

test('verification tokens cannot reset passwords; expired and superseded links cannot be consumed', async t => {
  const f = await fixture(t); assert.equal(f.account.user.emailVerifiedAt, null);
  await f.recovery.requestVerification(f.account.user); const verifyToken = f.token();
  await assert.rejects(f.recovery.resetPassword({ token: verifyToken, newPassword: 'Replacement-password-456' }), e => e.code === 'INVALID_AUTH_TOKEN');
  assert.deepEqual(f.recovery.verifyEmail({ token: verifyToken }), { verified: true });
  assert.ok(f.platform.store.getUser(f.account.user.id).emailVerifiedAt);
  assert.throws(() => f.recovery.verifyEmail({ token: verifyToken }), e => e.code === 'INVALID_AUTH_TOKEN');
  await f.recovery.forgotPassword({ email: f.account.user.email }); const old = f.token();
  await f.recovery.forgotPassword({ email: f.account.user.email }); const current = f.token();
  await assert.rejects(f.recovery.resetPassword({ token: old, newPassword: 'Replacement-password-456' }), e => e.code === 'INVALID_AUTH_TOKEN');
  f.advance(31 * 60000);
  await assert.rejects(f.recovery.resetPassword({ token: current, newPassword: 'Replacement-password-456' }), e => e.code === 'INVALID_AUTH_TOKEN');
});

test('delivery failure invalidates the new link, retains the previous delivered link, and throttles requests', async t => {
  const f = await fixture(t);
  await f.recovery.forgotPassword({ email: f.account.user.email }); const previous = f.token();
  f.platform.authMessageSender = async () => { throw new Error('private upstream credential detail'); };
  await assert.rejects(f.recovery.forgotPassword({ email: f.account.user.email }), e => e.code === 'AUTH_DELIVERY_UNAVAILABLE' && !e.message.includes('credential'));
  assert.equal((await f.recovery.resetPassword({ token: previous, newPassword: 'Replacement-password-456' })).reset, true);
  for (let n = 0; n < 3; n++) await assert.rejects(f.recovery.forgotPassword({ email: f.account.user.email }));
  await assert.rejects(f.recovery.forgotPassword({ email: f.account.user.email }), e => e.code === 'AUTH_DELIVERY_RATE_LIMIT');
});
