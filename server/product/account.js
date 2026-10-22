'use strict';

const { hashPassword, verifyPassword, hashSessionToken, sessionCookie, randomId } = require('./auth');
const { ProductError } = require('./platform');

class AccountSecurity {
  constructor(platform) { this.platform = platform; this.store = platform.store; }
  now() { return new Date(this.platform.clock()).toISOString(); }

  async changePassword(user, token, input = {}) {
    const record = this.store.getUserWithPasswordByEmail(user.email);
    if (typeof input.currentPassword !== 'string' || input.currentPassword.length > 256 || !record || !await verifyPassword(input.currentPassword, record.passwordHash)) {
      throw new ProductError('当前密码不正确', 401, 'INVALID_CREDENTIALS');
    }
    if (input.newPassword === input.currentPassword) throw new ProductError('新密码需要与当前密码不同', 400, 'PASSWORD_UNCHANGED');
    const passwordHash = await hashPassword(input.newPassword);
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      // Verification and hashing await; re-check the session and original hash under the write lock.
      if (!this.platform.authenticate(token)) throw new ProductError('登录状态已变化，请重新登录后修改密码', 401, 'SESSION_CHANGED');
      const updated = db.prepare("UPDATE users SET password_hash=?,updated_at=? WHERE id=? AND password_hash=? AND status='active'")
        .run(passwordHash, this.now(), user.id, record.passwordHash);
      if (!updated.changes) throw new ProductError('密码已在另一处修改，请重新登录', 409, 'PASSWORD_CHANGED');
      const previous = db.prepare('SELECT device_json FROM sessions WHERE token_hash=?').get(hashSessionToken(token));
      db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(this.now(), user.id);
      if (db.prepare("SELECT name FROM sqlite_master WHERE name='auth_action_tokens'").get()) db.prepare("UPDATE auth_action_tokens SET used_at=? WHERE user_id=? AND purpose='reset' AND used_at IS NULL").run(this.now(), user.id);
      const currentUser = this.store.getUser(user.id);
      const session = this.platform._createSession(currentUser, JSON.parse(previous?.device_json || '{}'));
      db.prepare('INSERT INTO user_notifications(user_id,id,title,body,link,created_at) VALUES(?,?,?,?,?,?)')
        .run(user.id, randomId('password'), '登录密码已更新', '本次密码修改已生效，其他登录已退出。', '/profile', this.now());
      db.exec('COMMIT');
      return { user: currentUser, ...session };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  sessions(user, token, query = {}) {
    const cursor = String(query.cursor || '0');
    if (!/^\d{1,9}$/.test(cursor)) throw new ProductError('分页位置无效', 400, 'INVALID_CURSOR');
    const offset = Number(cursor);
    const limit = 50;
    const now = this.now();
    const currentHash = hashSessionToken(token);
    const total = Number(this.store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>?').get(user.id, now).n);
    const sessions = this.store.db.prepare('SELECT id,token_hash,created_at,expires_at,device_json,last_seen_at FROM sessions WHERE user_id=? AND revoked_at IS NULL AND expires_at>? ORDER BY created_at DESC,rowid DESC LIMIT ? OFFSET ?')
      .all(user.id, now, limit, offset).map(row => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, current: row.token_hash === currentHash,
        ...((row.device_json !== '{}' || query.metadata === '1') ? { device: JSON.parse(row.device_json || '{}'), lastSeenAt: row.last_seen_at || row.created_at } : {}) }));
    return { sessions, total, limit, nextCursor: offset + sessions.length < total ? String(offset + sessions.length) : '' };
  }

  revokeSession(user, token, sessionId) {
    const row = this.store.db.prepare('SELECT id,token_hash FROM sessions WHERE id=? AND user_id=?').get(String(sessionId), user.id);
    if (!row) throw new ProductError('登录记录不存在', 404, 'SESSION_NOT_FOUND');
    this.store.db.prepare('UPDATE sessions SET revoked_at=? WHERE id=? AND revoked_at IS NULL').run(this.now(), row.id);
    return { revoked: true, revokedCurrent: row.token_hash === hashSessionToken(token) };
  }

  revokeOtherSessions(user, token) {
    const result = this.store.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND token_hash<>? AND revoked_at IS NULL')
      .run(this.now(), user.id, hashSessionToken(token));
    return { revoked: Number(result.changes), revokedCurrent: false };
  }

  revokeUserSessions(actor, userId, input = {}) {
    this.platform.requireRole(actor, ['admin']);
    const target = this.store.getUser(userId);
    if (!target || target.status === 'deleted') throw new ProductError('用户不存在', 404, 'USER_NOT_FOUND');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (!reason || reason.length > 1000 || reason.includes('\0')) throw new ProductError('请填写 1-1000 字的处理原因', 400, 'INVALID_INPUT');
    const db = this.store.db;
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(this.now(), userId);
      // Account routes may also be mounted independently of commerce.
      const auditAvailable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit'").get();
      if (auditAvailable) db.prepare('INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(randomId('audit'), actor.id, 'user.sessions_revoked', 'user', userId, JSON.stringify({ revoked: Number(result.changes), reason }), this.now());
      db.exec('COMMIT');
      return { revoked: Number(result.changes), revokedCurrent: actor.id === userId };
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
}

function registerAccountRoutes(router, { platform, requireAuth, cookieName = 'job_session', secureCookies = false }) {
  const account = new AccountSecurity(platform);
  const attempts = new Map();
  const rateLimit = (req, res, next) => {
    const now = platform.clock();
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
    const entry = attempts.get(req.productUser.id) || { count: 0, until: now + 15 * 60000 };
    if (entry.count >= 10 || attempts.size >= 10000 && !attempts.has(req.productUser.id)) {
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil((entry.until - now) / 1000))));
      return next(new ProductError('密码修改尝试过多，请 15 分钟后重试', 429, 'PASSWORD_RATE_LIMIT'));
    }
    entry.count += 1; attempts.set(req.productUser.id, entry); next();
  };
  const route = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);
  const clearCookie = (req, res) => res.setHeader('Set-Cookie', sessionCookie('', { name: cookieName, clear: true, secure: secureCookies || req.secure }));
  router.post('/me/password', requireAuth, rateLimit, route(async (req, res) => {
    const result = await account.changePassword(req.productUser, req.productToken, req.body);
    res.setHeader('Set-Cookie', sessionCookie(result.token, { name: cookieName, secure: secureCookies || req.secure, maxAgeSeconds: platform.sessionTtlMs / 1000 }));
    res.json({ ok: true, user: result.user, expiresAt: result.expiresAt, sessionToken: result.token });
  }));
  router.get('/me/sessions', requireAuth, route((req, res) => res.json({ ok: true, ...account.sessions(req.productUser, req.productToken, req.query) })));
  router.delete('/me/sessions', requireAuth, route((req, res) => res.json({ ok: true, ...account.revokeOtherSessions(req.productUser, req.productToken) })));
  router.delete('/me/sessions/:id', requireAuth, route((req, res) => {
    const result = account.revokeSession(req.productUser, req.productToken, req.params.id);
    if (result.revokedCurrent) clearCookie(req, res);
    res.json({ ok: true, ...result });
  }));
  router.delete('/admin/users/:id/sessions', requireAuth, route((req, res) => {
    const result = account.revokeUserSessions(req.productUser, req.params.id, req.body);
    if (result.revokedCurrent) clearCookie(req, res);
    res.json({ ok: true, ...result });
  }));
  return account;
}

module.exports = { AccountSecurity, registerAccountRoutes };
