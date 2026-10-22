'use strict';

const crypto = require('crypto');
const { ProductError } = require('./platform');

const DAY = 86400000;
const TERMS = { month: 30, quarter: 90, year: 365 };
const PLAN_RANK = { free: 0, pro: 1, coach: 2 };
const quantity = value => Number(value) < 0 ? '不限量' : String(value);
const TICKET_CATEGORIES = ['account', 'billing', 'job_correction', 'suggestion', 'other'];
const ENTITLEMENTS = ['profile.majors', 'prep.tracks', 'prep.attempts.daily', 'salary.insights', 'coach.feedback', 'savedSearches.limit', 'offers.limit', 'studyPlans.limit'];
const text = (value, label, max = 1000, required = false) => {
  if (value !== undefined && value !== null && typeof value !== 'string') throw new ProductError(`${label} 必须是文本`, 400, 'INVALID_INPUT');
  const result = String(value || '').trim();
  if ((required && !result) || result.length > max || result.includes('\0')) throw new ProductError(`${label} 不能为空或超过 ${max} 字符`, 400, 'INVALID_INPUT');
  return result;
};
const id = prefix => `${prefix}_${crypto.randomUUID()}`;
const parse = (value, fallback = {}) => { try { return JSON.parse(value); } catch (_) { return fallback; } };

class ProductCommerce {
  constructor(platform) {
    this.platform = platform;
    this.store = platform.store;
    this.store.initialize();
    this.db = this.store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS membership_orders (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, plan_id TEXT NOT NULL, plan_name TEXT NOT NULL,
        term_id TEXT NOT NULL, term_label TEXT NOT NULL, days INTEGER NOT NULL, amount INTEGER NOT NULL,
        currency TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','cancelled')),
        note TEXT NOT NULL DEFAULT '', idempotency_key TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        reviewed_at TEXT NOT NULL DEFAULT '', reviewed_by TEXT NOT NULL DEFAULT '', reference TEXT NOT NULL DEFAULT '',
        review_note TEXT NOT NULL DEFAULT '', current_period_end TEXT NOT NULL DEFAULT '', entitlements_json TEXT NOT NULL DEFAULT '{}',
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE, FOREIGN KEY(plan_id) REFERENCES plans(id),
        UNIQUE(user_id,idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS membership_orders_status_idx ON membership_orders(status,created_at);
      CREATE INDEX IF NOT EXISTS membership_orders_user_idx ON membership_orders(user_id,created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS membership_reference_idx ON membership_orders(reference COLLATE NOCASE) WHERE status='approved' AND reference<>'';
      CREATE UNIQUE INDEX IF NOT EXISTS membership_pending_idx ON membership_orders(user_id) WHERE status='pending';
      CREATE TABLE IF NOT EXISTS support_tickets (
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,category TEXT NOT NULL,subject TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved')),
        job_id TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS support_ticket_user_idx ON support_tickets(user_id,updated_at DESC);
      CREATE TABLE IF NOT EXISTS support_messages (
        id TEXT PRIMARY KEY,ticket_id TEXT NOT NULL,author_role TEXT NOT NULL,message TEXT NOT NULL,created_at TEXT NOT NULL,
        FOREIGN KEY(ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages(ticket_id,created_at,id);
      CREATE TABLE IF NOT EXISTS admin_audit (
        id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_type TEXT NOT NULL,
        target_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS admin_audit_created_idx ON admin_audit(created_at DESC);
    `);
    if (!this.db.prepare('PRAGMA table_info(membership_orders)').all().some(column => column.name === 'entitlements_json')) {
      this.db.exec("ALTER TABLE membership_orders ADD COLUMN entitlements_json TEXT NOT NULL DEFAULT '{}'");
    }
  }

  now() { return new Date(this.platform.clock()).toISOString(); }
  page(query = {}) {
    const cursor = String(query.cursor || '0');
    if (!/^\d{1,9}$/.test(cursor)) throw new ProductError('分页位置无效', 400, 'INVALID_CURSOR');
    return { offset: Number(cursor), limit: Math.min(200, Math.max(1, Math.trunc(Number(query.limit)) || 50)) };
  }
  pageResult(items, total, query, key) {
    const { offset, limit } = this.page(query);
    return { [key]: items, total: Number(total), cursor: String(offset), limit, nextCursor: offset + items.length < total ? String(offset + items.length) : '' };
  }
  admin(actor) { this.platform.requireRole(actor, ['admin']); }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  audit(actor, action, targetType, targetId, detail = {}) {
    this.db.prepare('INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id('audit'), actor.id, action, targetType, String(targetId), JSON.stringify(detail), this.now());
  }
  notify(userId, key, title, body, link) {
    this.db.prepare('INSERT OR IGNORE INTO user_notifications(user_id,id,title,body,link,created_at) VALUES(?,?,?,?,?,?)')
      .run(userId, key, title, body, link, this.now());
  }

  plans() {
    return this.store.listPlans().map(plan => ({
      ...plan, price: plan.priceMonthly / 100, unit: plan.priceMonthly ? '/30 天' : '永久免费',
      features: [
        '岗位搜索、收藏与投递进度',
        Number(plan.entitlements['prep.tracks']) < 0 ? '全部备考路径' : `${plan.entitlements['prep.tracks']} 条备考路径`,
        Number(plan.entitlements['prep.attempts.daily']) < 0 ? '每日答题不限次数' : `每日最多 ${plan.entitlements['prep.attempts.daily']} 次答题`,
        Number(plan.entitlements['salary.insights']) > 0 ? '公开岗位薪资样本洞察' : '公开岗位薪资字段查看',
        `保存搜索 ${quantity(plan.entitlements['savedSearches.limit'])} · Offer 记录 ${quantity(plan.entitlements['offers.limit'])}`,
        `学习计划 ${quantity(plan.entitlements['studyPlans.limit'])}`,
      ],
      description: plan.tagline, availableForCheckout: false,
      availabilityLabel: plan.id === 'free' ? '永久免费' : plan.availableForRequest ? '申请开通，人工核验' : '暂未开放申请',
      purchaseMode: 'manual_review', pricingStage: '测试定价', autoRenew: false,
    }));
  }

  updatePlan(actor, planId, input = {}) {
    this.admin(actor);
    const old = this.store.getPlan(planId);
    if (!old) throw new ProductError('套餐不存在', 404, 'PLAN_NOT_FOUND');
    const name = text(input.name ?? old.name, '套餐名称', 50, true);
    const tagline = text(input.tagline ?? old.tagline, '套餐说明', 200, true);
    const entitlements = { ...old.entitlements };
    if (input.entitlements !== undefined) {
      if (!input.entitlements || typeof input.entitlements !== 'object' || Array.isArray(input.entitlements)) throw new ProductError('权益格式错误', 400, 'INVALID_INPUT');
      for (const [key, value] of Object.entries(input.entitlements)) {
        if (!ENTITLEMENTS.includes(key) || !Number.isInteger(value) || value < -1 || value > 10000) throw new ProductError(`权益 ${key} 无效`, 400, 'INVALID_INPUT');
        if (['salary.insights', 'coach.feedback'].includes(key) && ![0, 1].includes(value)) throw new ProductError('功能开关只能为 0 或 1', 400, 'INVALID_INPUT');
        if (key === 'coach.feedback' && value !== 0) throw new ProductError('真人服务尚未提供，不能销售该权益', 400, 'SERVICE_UNAVAILABLE');
        if (key === 'profile.majors' && (value < 1 || value > 20)) throw new ProductError('专业方向数量应为 1 到 20，不能超出画像支持范围', 400, 'INVALID_INPUT');
        entitlements[key] = value;
      }
    }
    let terms = input.terms === undefined ? old.terms : input.terms;
    if (!Array.isArray(terms) || terms.length > 3) throw new ProductError('请配置 30、90、365 天的有效价格', 400, 'INVALID_INPUT');
    const seen = new Set();
    terms = terms.map(term => {
      if (!term || !Object.hasOwn(TERMS, term.id) || seen.has(term.id) || !Number.isInteger(term.price) || term.price < 100 || term.price > 1000000) throw new ProductError('周期价格必须为有效整数分，且不能重复', 400, 'INVALID_INPUT');
      seen.add(term.id);
      return { id: term.id, days: TERMS[term.id], label: `${TERMS[term.id]} 天`, price: term.price };
    });
    if (planId === 'free' && terms.length) throw new ProductError('免费版不能配置收费周期', 400, 'INVALID_INPUT');
    const available = input.availableForRequest === undefined ? old.availableForRequest : input.availableForRequest;
    if (typeof available !== 'boolean') throw new ProductError('申请开关必须是布尔值', 400, 'INVALID_INPUT');
    if (planId !== 'free' && available && !terms.some(term => term.id === 'month')) throw new ProductError('开放申请前请配置 30 天价格', 400, 'INVALID_INPUT');
    return this.transaction(() => {
      this.db.prepare('UPDATE plans SET name=?,tagline=?,price_monthly=?,entitlements_json=? WHERE id=?')
        .run(name, tagline, terms.find(term => term.id === 'month')?.price || old.priceMonthly, JSON.stringify(entitlements), planId);
      this.db.prepare('UPDATE plan_settings SET terms_json=?,available_for_request=?,updated_at=? WHERE plan_id=?')
        .run(JSON.stringify(terms), planId === 'free' ? 0 : Number(available), this.now(), planId);
      this.audit(actor, 'plan.updated', 'plan', planId, { before: { name: old.name, terms: old.terms, entitlements: old.entitlements }, after: { name, terms, entitlements } });
      return this.plans().find(plan => plan.id === planId);
    });
  }

  order(row) {
    if (!row) return null;
    return {
      id: row.id, userId: row.user_id, planId: row.plan_id, planName: row.plan_name, termId: row.term_id,
      termLabel: row.term_label, days: Number(row.days), amount: Number(row.amount), currency: row.currency,
      status: row.status, note: row.note, createdAt: row.created_at, updatedAt: row.updated_at,
      reviewedAt: row.reviewed_at, reference: row.reference, reviewNote: row.review_note,
      currentPeriodEnd: row.current_period_end, autoRenew: false, purchaseMode: 'manual_review',
      entitlementsSnapshot: parse(row.entitlements_json),
      ...(row.email ? { userEmail: row.email, displayName: row.display_name } : {}),
    };
  }
  orders(user, query = {}, admin = false) {
    if (admin) this.admin(user);
    const { offset, limit } = this.page(query);
    const status = text(query.status, '状态', 20);
    if (status && !['pending', 'approved', 'rejected', 'cancelled'].includes(status)) throw new ProductError('订单状态错误', 400, 'INVALID_INPUT');
    return this.db.prepare(`SELECT o.*${admin ? ',u.email,u.display_name' : ''} FROM membership_orders o ${admin ? 'JOIN users u ON u.id=o.user_id' : ''}
      WHERE (?='' OR o.status=?) ${admin ? '' : 'AND o.user_id=?'} ORDER BY o.created_at DESC,o.id LIMIT ? OFFSET ?`)
      .all(...(admin ? [status, status, limit, offset] : [status, status, user.id, limit, offset])).map(row => this.order(row));
  }
  ordersPage(user, query = {}, admin = false) {
    const items = this.orders(user, query, admin);
    const status = String(query.status || '');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM membership_orders WHERE (?='' OR status=?) ${admin ? '' : 'AND user_id=?'}`)
      .get(...(admin ? [status, status] : [status, status, user.id])).n;
    return this.pageResult(items, total, query, 'orders');
  }
  createOrder(user, input = {}) {
    const planId = text(input.planId, '套餐', 30, true);
    const termId = text(input.termId, '周期', 30, true);
    const note = text(input.note, '说明', 2000);
    const key = text(input.idempotencyKey || crypto.randomUUID(), '请求标识', 100, true);
    const existing = this.db.prepare('SELECT * FROM membership_orders WHERE user_id=? AND idempotency_key=?').get(user.id, key);
    if (existing) {
      if (existing.plan_id !== planId || existing.term_id !== termId) throw new ProductError('此请求标识已用于其他套餐', 409, 'IDEMPOTENCY_CONFLICT');
      return this.order(existing);
    }
    const plan = this.store.getPlan(planId);
    const term = plan?.terms.find(item => item.id === termId);
    if (!plan || planId === 'free' || !plan.availableForRequest || !term) throw new ProductError('套餐或周期暂不可申请', 400, 'PLAN_NOT_AVAILABLE');
    const pending = this.db.prepare("SELECT * FROM membership_orders WHERE user_id=? AND status='pending'").get(user.id);
    if (pending) {
      if (pending.plan_id === planId && pending.term_id === termId) return this.order(pending);
      throw new ProductError('已有待审核申请，请先取消或等待处理', 409, 'ORDER_PENDING');
    }
    const current = this.store.getUserPlan(user.id);
    if (PLAN_RANK[current.id] > PLAN_RANK[planId]) throw new ProductError('当前套餐有效期内不能降级，请到期后再申请', 409, 'ACTIVE_HIGHER_PLAN');
    const recent = this.db.prepare('SELECT COUNT(*) AS n FROM membership_orders WHERE user_id=? AND created_at>?').get(user.id, new Date(this.platform.clock() - DAY).toISOString()).n;
    if (recent >= 10) throw new ProductError('今日申请次数已达上限，请明天再试', 429, 'ORDER_RATE_LIMIT');
    const orderId = id('order'); const now = this.now();
    this.db.prepare('INSERT INTO membership_orders(id,user_id,plan_id,plan_name,term_id,term_label,days,amount,currency,note,idempotency_key,created_at,updated_at,entitlements_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(orderId, user.id, plan.id, plan.name, term.id, term.label, term.days, term.price, plan.currency, note, key, now, now, JSON.stringify(plan.entitlements));
    return this.order(this.db.prepare('SELECT * FROM membership_orders WHERE id=?').get(orderId));
  }
  cancelOrder(user, orderId) {
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM membership_orders WHERE id=? AND user_id=?').get(orderId, user.id);
      if (!row) throw new ProductError('申请不存在', 404, 'ORDER_NOT_FOUND');
      if (row.status === 'cancelled') return this.order(row);
      if (row.status !== 'pending') throw new ProductError('已处理申请不能取消，请联系客服', 409, 'ORDER_FINALIZED');
      this.db.prepare("UPDATE membership_orders SET status='cancelled',updated_at=? WHERE id=?").run(this.now(), orderId);
      return this.order(this.db.prepare('SELECT * FROM membership_orders WHERE id=?').get(orderId));
    });
  }
  reviewOrder(actor, orderId, input = {}) {
    this.admin(actor);
    if (!['approve', 'reject'].includes(input.action)) throw new ProductError('请选择通过或拒绝', 400, 'INVALID_INPUT');
    const reference = text(input.reference, '核验交易凭据', 120, input.action === 'approve');
    const reason = text(input.reason, '审核说明', 2000, true);
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM membership_orders WHERE id=?').get(orderId);
      if (!row) throw new ProductError('申请不存在', 404, 'ORDER_NOT_FOUND');
      const targetStatus = input.action === 'approve' ? 'approved' : 'rejected';
      if (row.status === targetStatus && (targetStatus !== 'approved' || row.reference === reference)) return this.order(row);
      if (row.status !== 'pending') throw new ProductError('该申请已经处理，请勿重复变更', 409, 'ORDER_FINALIZED');
      let end = '';
      if (input.action === 'approve') {
        const owner = this.store.getUser(row.user_id);
        if (owner?.status !== 'active') throw new ProductError('账户不可用，不能开通会员', 409, 'USER_INACTIVE');
        const duplicate = this.db.prepare("SELECT id FROM membership_orders WHERE reference=? COLLATE NOCASE AND status='approved'").get(reference);
        if (duplicate) throw new ProductError('该交易凭据已经核验过，不能重复使用', 409, 'REFERENCE_USED');
        const current = this.store.getUserPlan(row.user_id);
        const plan = this.store.getPlan(row.plan_id);
        if (PLAN_RANK[current.id] > PLAN_RANK[row.plan_id]) throw new ProductError('用户仍有更高套餐，请到期后再处理此申请', 409, 'ACTIVE_HIGHER_PLAN');
        if (current.id !== 'free' && !current.subscription?.currentPeriodEnd) throw new ProductError('用户有长期人工授权，请先明确授权截止时间再核验', 409, 'UNBOUNDED_MEMBERSHIP');
        const start = Math.max(this.platform.clock(), Date.parse(current.subscription?.currentPeriodEnd || '') || 0);
        end = new Date(start + Number(row.days) * DAY).toISOString();
        const snapshot = parse(row.entitlements_json);
        const lockedEntitlements = Object.keys(snapshot).length ? snapshot : { ...plan.entitlements };
        // Renewals must not reduce benefits already paid for during the remaining active period.
        if (current.id !== 'free') for (const [key,value] of Object.entries(current.entitlements)) {
          const next = lockedEntitlements[key];
          lockedEntitlements[key] = value < 0 || next < 0 ? -1 : Math.max(Number(value) || 0, Number(next) || 0);
        }
        this.db.prepare(`INSERT INTO subscriptions(user_id,plan_id,status,source,current_period_start,current_period_end,updated_at,entitlements_snapshot_json)
          VALUES(?,?,'active','manual_verified',?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,
          status='active',source='manual_verified',current_period_start=excluded.current_period_start,
          current_period_end=excluded.current_period_end,updated_at=excluded.updated_at,entitlements_snapshot_json=excluded.entitlements_snapshot_json`)
          .run(row.user_id, row.plan_id, this.now(), end, this.now(), JSON.stringify(lockedEntitlements));
      }
      this.db.prepare('UPDATE membership_orders SET status=?,updated_at=?,reviewed_at=?,reviewed_by=?,reference=?,review_note=?,current_period_end=? WHERE id=?')
        .run(targetStatus, this.now(), this.now(), actor.id, reference, reason, end, orderId);
      this.audit(actor, `order.${targetStatus}`, 'order', orderId, { userId: row.user_id, planId: row.plan_id, amount: row.amount, reference, reason, currentPeriodEnd: end });
      this.notify(row.user_id, `order:${orderId}:${targetStatus}`, targetStatus === 'approved' ? '会员已开通' : '会员申请处理结果', targetStatus === 'approved' ? `${row.plan_name} 已开通，有效期至 ${end.slice(0, 10)}。到期不自动扣费。` : reason, '/pricing');
      return this.order(this.db.prepare('SELECT * FROM membership_orders WHERE id=?').get(orderId));
    });
  }

  grantPlan(actor, userId, input = {}) {
    this.admin(actor);
    const planId = text(input.planId, '套餐', 30, true);
    const plan = this.store.getPlan(planId);
    const user = this.store.getUser(userId);
    if (!plan || !user || user.status === 'deleted') throw new ProductError('用户或套餐不存在', 404, 'PLAN_NOT_FOUND');
    const days = input.days === undefined ? 30 : Number(input.days);
    if (planId !== 'free' && (!Number.isInteger(days) || days < 1 || days > 365)) throw new ProductError('授权期限必须为 1 到 365 天', 400, 'INVALID_INPUT');
    const reason = text(input.reason || '管理员人工授权', '授权原因', 1000, true);
    return this.transaction(() => {
      const before = this.store.getUserPlan(userId);
      this.store.setUserPlan(userId, planId, 'admin');
      const end = planId === 'free' ? null : new Date(this.platform.clock() + days * DAY).toISOString();
      this.db.prepare('UPDATE subscriptions SET current_period_end=?,entitlements_snapshot_json=? WHERE user_id=?').run(end, planId === 'free' ? null : JSON.stringify(plan.entitlements), userId);
      this.audit(actor, 'membership.granted', 'user', userId, { before: before.id, planId, days: planId === 'free' ? 0 : days, reason, currentPeriodEnd: end });
      this.notify(userId, id('grant'), '会员权益已更新', `${plan.name}${end ? `，有效期至 ${end.slice(0, 10)}` : ''}。${reason}`, '/pricing');
      return this.store.getUserPlan(userId);
    });
  }
  guardLastAdmin(user) {
    if (user.role === 'admin' && user.status === 'active' && this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get().n <= 1) throw new ProductError('至少保留一个有效管理员', 409, 'LAST_ADMIN');
  }
  setRole(actor, userId, input = {}) {
    this.admin(actor);
    const target = this.store.getUser(userId);
    if (!target || target.status === 'deleted') throw new ProductError('用户不存在', 404, 'USER_NOT_FOUND');
    if (!['admin', 'content_editor', 'user'].includes(input.role)) throw new ProductError('角色非法', 400, 'INVALID_ROLE');
    return this.transaction(() => {
      if (input.role !== 'admin') this.guardLastAdmin(target);
      const result = this.store.setUserRole(userId, input.role);
      this.audit(actor, 'user.role_changed', 'user', userId, { before: target.role, role: input.role });
      return result;
    });
  }
  setStatus(actor, userId, input = {}) {
    this.admin(actor);
    const target = this.store.getUser(userId);
    if (!target || target.status === 'deleted') throw new ProductError('用户不存在', 404, 'USER_NOT_FOUND');
    if (!['active', 'suspended'].includes(input.status)) throw new ProductError('账户状态无效', 400, 'INVALID_INPUT');
    const reason = text(input.reason, '处理原因', 1000, true);
    return this.transaction(() => {
      if (input.status === 'suspended') {
        if (actor.id === userId) throw new ProductError('不能停用当前操作账户', 409, 'SELF_SUSPENSION');
        this.guardLastAdmin(target);
        this.db.prepare('UPDATE sessions SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(this.now(), userId);
      }
      this.db.prepare('UPDATE users SET status=?,updated_at=? WHERE id=?').run(input.status, this.now(), userId);
      this.audit(actor, 'user.status_changed', 'user', userId, { before: target.status, status: input.status, reason });
      return this.store.getUser(userId);
    });
  }

  ticket(row) {
    return {
      id: row.id, userId: row.user_id, category: row.category, subject: row.subject, status: row.status,
      jobId: row.job_id, createdAt: row.created_at, updatedAt: row.updated_at,
      messages: this.db.prepare('SELECT * FROM support_messages WHERE ticket_id=? ORDER BY created_at,rowid').all(row.id).map(message => ({ id: message.id, authorRole: message.author_role, message: message.message, createdAt: message.created_at })),
      ...(row.email ? { userEmail: row.email, displayName: row.display_name } : {}),
    };
  }
  tickets(user, query = {}, admin = false) {
    if (admin) this.admin(user);
    const { offset, limit } = this.page(query);
    const status = text(query.status, '状态', 20);
    if (status && !['open', 'in_progress', 'resolved'].includes(status)) throw new ProductError('工单状态无效', 400, 'INVALID_INPUT');
    return this.db.prepare(`SELECT t.*${admin ? ',u.email,u.display_name' : ''} FROM support_tickets t ${admin ? 'JOIN users u ON u.id=t.user_id' : ''}
      WHERE (?='' OR t.status=?) ${admin ? '' : 'AND t.user_id=?'} ORDER BY t.updated_at DESC,t.id LIMIT ? OFFSET ?`)
      .all(...(admin ? [status, status, limit, offset] : [status, status, user.id, limit, offset])).map(row => this.ticket(row));
  }
  ticketsPage(user, query = {}, admin = false) {
    const items = this.tickets(user, query, admin);
    const status = String(query.status || '');
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM support_tickets WHERE (?='' OR status=?) ${admin ? '' : 'AND user_id=?'}`)
      .get(...(admin ? [status, status] : [status, status, user.id])).n;
    return this.pageResult(items, total, query, 'tickets');
  }
  createTicket(user, input = {}) {
    const category = text(input.category || 'other', '分类', 30, true);
    if (!TICKET_CATEGORIES.includes(category)) throw new ProductError('工单分类无效', 400, 'INVALID_INPUT');
    const subject = text(input.subject, '主题', 150, true);
    const message = text(input.message, '内容', 5000, true);
    const jobId = text(input.jobId, '岗位', 200);
    if (jobId) this.platform.getJob(jobId, user);
    const recent = this.db.prepare('SELECT COUNT(*) AS n FROM support_tickets WHERE user_id=? AND created_at>?').get(user.id, new Date(this.platform.clock() - DAY).toISOString()).n;
    if (recent >= 10) throw new ProductError('今日反馈次数已达上限，请在已有工单中补充', 429, 'TICKET_RATE_LIMIT');
    return this.transaction(() => {
      const ticketId = id('ticket'); const now = this.now();
      this.db.prepare('INSERT INTO support_tickets(id,user_id,category,subject,job_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(ticketId, user.id, category, subject, jobId, now, now);
      this.db.prepare('INSERT INTO support_messages(id,ticket_id,author_role,message,created_at) VALUES(?,?,?,?,?)').run(id('msg'), ticketId, 'user', message, now);
      return this.ticket(this.db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId));
    });
  }
  replyTicket(user, ticketId, input = {}, admin = false) {
    if (admin) this.admin(user);
    const message = text(input.message, '回复', 5000, !admin);
    const row = this.db.prepare(`SELECT * FROM support_tickets WHERE id=? ${admin ? '' : 'AND user_id=?'}`).get(...(admin ? [ticketId] : [ticketId, user.id]));
    if (!row) throw new ProductError('工单不存在', 404, 'TICKET_NOT_FOUND');
    const status = admin ? input.status || 'in_progress' : 'open';
    if (!['open', 'in_progress', 'resolved'].includes(status)) throw new ProductError('工单状态无效', 400, 'INVALID_INPUT');
    if (admin && status === 'resolved' && !message) throw new ProductError('关闭工单时请填写处理结果', 400, 'INVALID_INPUT');
    const count = this.db.prepare('SELECT COUNT(*) AS n FROM support_messages WHERE ticket_id=?').get(ticketId).n;
    if (count >= 100) throw new ProductError('此工单回复已达上限，请新建工单继续', 409, 'TICKET_MESSAGE_LIMIT');
    return this.transaction(() => {
      if (message) this.db.prepare('INSERT INTO support_messages(id,ticket_id,author_role,message,created_at) VALUES(?,?,?,?,?)').run(id('msg'), ticketId, admin ? 'admin' : 'user', message, this.now());
      this.db.prepare('UPDATE support_tickets SET status=?,updated_at=? WHERE id=?').run(status, this.now(), ticketId);
      if (admin) {
        this.audit(user, 'ticket.updated', 'ticket', ticketId, { status, replied: Boolean(message) });
        this.notify(row.user_id, id('support'), '反馈有了新回复', `${row.subject}：${message || '处理状态已更新'}`.slice(0, 500), '/support');
      }
      return this.ticket(this.db.prepare('SELECT * FROM support_tickets WHERE id=?').get(ticketId));
    });
  }
  overview(actor) {
    this.admin(actor);
    const count = sql => Number(this.db.prepare(sql).get().n || 0);
    const jobs = this.platform._catalogJobs();
    return {
      users: count("SELECT COUNT(*) AS n FROM users WHERE status<>'deleted'"),
      totalJobs: jobs.length, activeJobs: jobs.filter(job => !['0', 0, false].includes(job.active)).length,
      paidMembers: Number(this.db.prepare("SELECT COUNT(*) AS n FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE s.plan_id<>'free' AND s.status IN ('active','trialing') AND u.status='active' AND (s.current_period_end IS NULL OR s.current_period_end>?)").get(this.now()).n),
      pendingOrders: count("SELECT COUNT(*) AS n FROM membership_orders WHERE status='pending'"),
      openTickets: count("SELECT COUNT(*) AS n FROM support_tickets WHERE status<>'resolved'"),
      verifiedRevenue: count("SELECT COALESCE(SUM(amount),0) AS n FROM membership_orders WHERE status='approved'"),
      approvedOrders: count("SELECT COUNT(*) AS n FROM membership_orders WHERE status='approved'"),
      profilesCompleted: count("SELECT COUNT(*) AS n FROM profiles WHERE target_roles_json<>'[]' AND majors_json<>'[]'"),
      applications: count("SELECT COUNT(*) AS n FROM job_states WHERE status IN ('applied','assessment','interview','offer')"),
      examSubmissions: count("SELECT COUNT(*) AS n FROM exam_sessions WHERE status='submitted'"),
      currency: 'CNY', asOf: this.now(), revenueLabel: '人工核验金额（非支付渠道结算）',
    };
  }
  audits(actor, query = {}) {
    this.admin(actor);
    const { offset, limit } = this.page(query);
    return this.db.prepare('SELECT a.*,u.email FROM admin_audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.rowid DESC LIMIT ? OFFSET ?').all(limit, offset)
      .map(row => ({ id: row.id, actorId: row.actor_id, actorEmail: row.email || '', action: row.action, targetType: row.target_type, targetId: row.target_id, detail: parse(row.detail_json), createdAt: row.created_at }));
  }
  auditsPage(actor, query = {}) {
    const items = this.audits(actor, query);
    return this.pageResult(items, this.db.prepare('SELECT COUNT(*) AS n FROM admin_audit').get().n, query, 'items');
  }
  usersPage(actor, query = {}) {
    this.admin(actor);
    const { offset, limit } = this.page(query);
    const q = text(query.q, '搜索词', 100).toLowerCase();
    const rows = this.db.prepare("SELECT id FROM users WHERE status<>'deleted' AND (?='' OR instr(lower(email),?)>0 OR instr(lower(display_name),?)>0) ORDER BY created_at DESC,id LIMIT ? OFFSET ?").all(q, q, q, limit, offset);
    const total = this.db.prepare("SELECT COUNT(*) AS n FROM users WHERE status<>'deleted' AND (?='' OR instr(lower(email),?)>0 OR instr(lower(display_name),?)>0)").get(q, q, q).n;
    const users = rows.map(row => ({ ...this.store.getUser(row.id), plan: this.store.getUserPlan(row.id) }));
    return this.pageResult(users, total, query, 'users');
  }
}

function registerCommerceRoutes(router, { platform, requireAuth }) {
  const commerce = new ProductCommerce(platform);
  const route = handler => (req, res, next) => { try { handler(req, res); } catch (error) { next(error); } };
  router.get('/plans', route((req, res) => res.json({ ok: true, plans: commerce.plans(), paymentConfigured: platform.isPaymentConfigured(), purchaseMode: 'manual_review', autoRenew: false, content: {tracks:platform.store.listPrepTracks().length,questions:platform.store.countPrepQuestions(),source:'原创及已审核授权内容',grading:'客观题自动评分；简答题按关键词规则反馈'} })));
  router.get('/me/orders', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.ordersPage(req.productUser, req.query) })));
  router.post('/me/orders', requireAuth, route((req, res) => res.status(201).json({ ok: true, order: commerce.createOrder(req.productUser, req.body) })));
  router.post('/me/orders/:id/cancel', requireAuth, route((req, res) => res.json({ ok: true, order: commerce.cancelOrder(req.productUser, req.params.id) })));
  router.get('/me/tickets', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.ticketsPage(req.productUser, req.query) })));
  router.post('/me/tickets', requireAuth, route((req, res) => res.status(201).json({ ok: true, ticket: commerce.createTicket(req.productUser, req.body) })));
  router.post('/me/tickets/:id/replies', requireAuth, route((req, res) => res.json({ ok: true, ticket: commerce.replyTicket(req.productUser, req.params.id, req.body) })));
  router.get('/admin/overview', requireAuth, route((req, res) => res.json({ ok: true, overview: commerce.overview(req.productUser) })));
  router.get('/admin/plans', requireAuth, route((req, res) => { commerce.admin(req.productUser); res.json({ ok: true, plans: commerce.plans() }); }));
  router.put('/admin/plans/:id', requireAuth, route((req, res) => res.json({ ok: true, plan: commerce.updatePlan(req.productUser, req.params.id, req.body) })));
  router.get('/admin/orders', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.ordersPage(req.productUser, req.query, true) })));
  router.put('/admin/orders/:id', requireAuth, route((req, res) => res.json({ ok: true, order: commerce.reviewOrder(req.productUser, req.params.id, req.body) })));
  router.put('/admin/users/:id/plan', requireAuth, route((req, res) => res.json({ ok: true, plan: commerce.grantPlan(req.productUser, req.params.id, req.body) })));
  router.get('/admin/users', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.usersPage(req.productUser, req.query) })));
  router.put('/admin/users/:id/role', requireAuth, route((req, res) => res.json({ ok: true, user: commerce.setRole(req.productUser, req.params.id, req.body) })));
  router.put('/admin/users/:id/status', requireAuth, route((req, res) => res.json({ ok: true, user: commerce.setStatus(req.productUser, req.params.id, req.body) })));
  router.get('/admin/tickets', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.ticketsPage(req.productUser, req.query, true) })));
  router.put('/admin/tickets/:id', requireAuth, route((req, res) => res.json({ ok: true, ticket: commerce.replyTicket(req.productUser, req.params.id, req.body, true) })));
  router.get('/admin/audit', requireAuth, route((req, res) => res.json({ ok: true, ...commerce.auditsPage(req.productUser, req.query) })));
  return commerce;
}

module.exports = { ProductCommerce, registerCommerceRoutes };
