'use strict';

const { hashPassword, hashSessionToken, newOpaqueToken, normalizeEmail, randomId } = require('./auth');
const { contractError } = require('./mobile-contract');

function initializeRecovery(platform) {
  if (platform.recovery) return platform.recovery;
  platform.store.initialize();
  platform.store.db.exec(`CREATE TABLE IF NOT EXISTS auth_action_tokens (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,purpose TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,email TEXT NOT NULL,
    created_at TEXT NOT NULL,expires_at TEXT NOT NULL,delivered_at TEXT,used_at TEXT,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  ); CREATE INDEX IF NOT EXISTS auth_action_user ON auth_action_tokens(user_id,purpose,created_at);
  CREATE TABLE IF NOT EXISTS auth_delivery_limits (key TEXT PRIMARY KEY,used INTEGER NOT NULL,until_ms INTEGER NOT NULL);`);
  let appUrl = '';
  if (platform.publicAppUrl) {
    const url = new URL(platform.publicAppUrl);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:') || url.username || url.password || url.search || url.hash) throw new Error('publicAppUrl must be a trusted HTTPS application URL');
    appUrl = url.href.replace(/\/$/, '');
  }
  const now = () => new Date(platform.clock()).toISOString();
  const unavailable = () => contractError('邮件发送渠道尚不可用，请联系管理员', 503, 'AUTH_DELIVERY_UNAVAILABLE');
  const configured = () => Boolean(platform.authMessageSender && appUrl);
  const throttle = (email, ip) => {
    platform.store.transaction(() => {
      const db = platform.store.db;
      db.prepare('DELETE FROM auth_delivery_limits WHERE until_ms<=?').run(platform.clock());
      const keys = [[`email:${hashSessionToken(email)}`, 5], [`ip:${hashSessionToken(ip || 'unknown')}`, 20]];
      for (const [key, max] of keys) {
        const row = db.prepare('SELECT used FROM auth_delivery_limits WHERE key=?').get(key);
        if (Number(row?.used || 0) >= max) throw contractError('邮件请求过多，请稍后再试', 429, 'AUTH_DELIVERY_RATE_LIMIT');
      }
      if (Number(db.prepare('SELECT COUNT(*) n FROM auth_delivery_limits').get().n) >= 20000) throw contractError('邮件请求繁忙，请稍后重试', 429, 'AUTH_DELIVERY_RATE_LIMIT');
      for (const [key] of keys) db.prepare('INSERT INTO auth_delivery_limits(key,used,until_ms) VALUES(?,1,?) ON CONFLICT(key) DO UPDATE SET used=used+1').run(key, platform.clock() + 3600000);
    });
  };
  const issue = async (user, purpose) => {
    if (!user || user.status !== 'active') return;
    const token = newOpaqueToken();
    const id = randomId('auth');
    const actionUrl = `${appUrl}/${purpose === 'reset' ? 'reset-password' : 'verify-email'}#token=${encodeURIComponent(token)}`;
    const expiresAt = new Date(platform.clock() + (purpose === 'reset' ? 30 * 60000 : 24 * 3600000)).toISOString();
    platform.store.db.prepare('INSERT INTO auth_action_tokens(id,user_id,purpose,token_hash,email,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, user.id, purpose, hashSessionToken(token), user.email, now(), expiresAt);
    try {
      const sent = await platform.authMessageSender({ to: user.email, purpose, actionUrl, expiresAt,
        subject: purpose === 'reset' ? '重设职路登录密码' : '验证职路邮箱',
        text: `请通过此链接${purpose === 'reset' ? '重设密码' : '验证邮箱'}：${actionUrl}\n有效期截至 ${expiresAt}。如非本人操作，请忽略。` });
      if (sent === false) throw new Error('delivery rejected');
      platform.store.transaction(() => {
        // Only a successfully delivered token supersedes prior links.
        platform.store.db.prepare('UPDATE auth_action_tokens SET used_at=? WHERE user_id=? AND purpose=? AND id<>? AND used_at IS NULL').run(now(), user.id, purpose, id);
        platform.store.db.prepare('UPDATE auth_action_tokens SET delivered_at=? WHERE id=? AND used_at IS NULL').run(now(), id);
      });
    } catch (_) {
      platform.store.db.prepare('UPDATE auth_action_tokens SET used_at=? WHERE id=?').run(now(), id);
      throw unavailable();
    }
  };
  const tokenRow = (token, purpose) => {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw contractError('链接无效或已过期，请重新申请', 400, 'INVALID_AUTH_TOKEN');
    const row = platform.store.db.prepare(`SELECT t.* FROM auth_action_tokens t JOIN users u ON u.id=t.user_id
      WHERE t.token_hash=? AND t.purpose=? AND t.used_at IS NULL AND t.delivered_at IS NOT NULL AND t.expires_at>? AND u.status='active' AND u.email=t.email`)
      .get(hashSessionToken(token), purpose, now());
    if (!row) throw contractError('链接无效或已过期，请重新申请', 400, 'INVALID_AUTH_TOKEN');
    return row;
  };
  platform.recovery = {
    configured,
    async forgotPassword(input = {}, ip = '') {
      if (!configured()) throw unavailable();
      const email = normalizeEmail(input.email);
      throttle(email, ip);
      await issue(platform.store.getUserWithPasswordByEmail(email), 'reset');
      return { accepted: true, message: '如果邮箱对应可用账户，我们会发送密码重设链接。' };
    },
    async requestVerification(user, ip = '') {
      if (!configured()) throw unavailable();
      const current = platform.store.getUser(user.id);
      if (!current || current.status !== 'active') throw contractError('请重新登录', 401, 'AUTH_REQUIRED');
      if (current.emailVerifiedAt) return { accepted: true, verified: true };
      throttle(current.email, ip);
      await issue(current, 'verify');
      return { accepted: true, message: '验证邮件已提交发送，请检查收件箱。' };
    },
    async resetPassword(input = {}) {
      tokenRow(input.token, 'reset');
      const passwordHash = await hashPassword(input.newPassword);
      return platform.store.transaction(() => {
        const row = tokenRow(input.token, 'reset');
        platform.store.db.prepare('UPDATE users SET password_hash=?,updated_at=? WHERE id=?').run(passwordHash, now(), row.user_id);
        platform.store.db.prepare("UPDATE auth_action_tokens SET used_at=? WHERE user_id=? AND purpose='reset' AND used_at IS NULL").run(now(), row.user_id);
        platform.store.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now(), row.user_id);
        return { reset: true, requiresLogin: true };
      });
    },
    verifyEmail(input = {}) {
      return platform.store.transaction(() => {
        const row = tokenRow(input.token, 'verify');
        platform.store.db.prepare('UPDATE users SET email_verified_at=?,updated_at=? WHERE id=?').run(now(), now(), row.user_id);
        platform.store.db.prepare("UPDATE auth_action_tokens SET used_at=? WHERE user_id=? AND purpose='verify' AND used_at IS NULL").run(now(), row.user_id);
        return { verified: true };
      });
    },
  };
  return platform.recovery;
}

function registerRecoveryRoutes(router, { platform, requireAuth }) {
  const recovery = initializeRecovery(platform);
  const route = fn => (req, res, next) => Promise.resolve().then(() => fn(req, res)).catch(next);
  router.post('/auth/forgot-password', route(async (req, res) => res.status(202).json({ ok: true, ...await recovery.forgotPassword(req.body, req.ip) })));
  router.post('/auth/reset-password', route(async (req, res) => res.json({ ok: true, ...await recovery.resetPassword(req.body) })));
  router.post('/me/email-verification', requireAuth, route(async (req, res) => res.status(202).json({ ok: true, ...await recovery.requestVerification(req.productUser, req.ip) })));
  router.post('/auth/verify-email', route((req, res) => res.json({ ok: true, ...recovery.verifyEmail(req.body) })));
  return recovery;
}

module.exports = { initializeRecovery, registerRecoveryRoutes };
