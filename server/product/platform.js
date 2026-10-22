'use strict';

const crypto = require('crypto');
const {
  hashPassword,
  hashSessionToken,
  newOpaqueToken,
  normalizeEmail,
  normalizeDevice,
  randomId,
  verifyPassword,
} = require('./auth');
const { PLANS } = require('./catalog');
const { jobPassesFilters, searchJob, matchJob, normalizeCurrency, normalizeSalary, salaryForPeriod } = require('./matching');
const { normalizeJobFilters } = require('./job-filters');
const { ProductStore } = require('./store');
const { CONTENT_KINDS, EXAM_TYPES, questionProvenance } = require('./provenance');
const { deadlineFact, applicationFact } = require('../cloud/job-facts');
const { fingerprint, idempotencyKey, expectedVersion } = require('./mobile-contract');

const ROLES = Object.freeze(['user', 'content_editor', 'admin']);
const JOB_STATUSES = Object.freeze(['not_applied', 'saved', 'preparing', 'applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn', 'ignored']);
const PERIOD_ENTITLEMENTS = new Set(['prep.attempts.daily']);

class ProductError extends Error {
  constructor(message, statusCode = 400, code = 'PRODUCT_ERROR', detail = null) {
    super(message);
    this.name = 'ProductError';
    this.statusCode = statusCode;
    this.code = code;
    this.detail = detail;
  }
}

function normalizeTimeZone(value) {
  const timeZone = String(value || '').trim();
  if (!timeZone) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone }).format(0);
    return timeZone;
  } catch (_) {
    throw new ProductError('timeZone 必须是有效的 IANA 时区', 400, 'INVALID_INPUT');
  }
}

function localDateKey(timestamp, timeZone = 'UTC') {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: normalizeTimeZone(timeZone),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDateKey(key, days) {
  const [year, month, day] = String(key).split('-').map(Number);
  if (![year, month, day].every(Number.isFinite)) return '';
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function cleanText(value, field, { required = false, max = 2000 } = {}) {
  if (value === undefined || value === null) value = '';
  if (!['string', 'number', 'boolean'].includes(typeof value)) throw new ProductError(`${field} 必须是文本`, 400, 'INVALID_INPUT');
  const result = String(value).trim();
  if (required && !result) throw new ProductError(`${field} 不能为空`, 400, 'INVALID_INPUT');
  if (result.includes('\0') || result.length > max) throw new ProductError(`${field} 格式非法或过长`, 400, 'INVALID_INPUT');
  return result;
}

function cleanArray(value, field, { maxItems = 20, itemMax = 100 } = {}) {
  if (value === undefined || value === null || value === '') return [];
  const input = Array.isArray(value) ? value : String(value).split(/[,，、]/);
  if (input.length > maxItems) throw new ProductError(`${field} 最多 ${maxItems} 项`, 400, 'INVALID_INPUT');
  const output = [];
  const seen = new Set();
  for (const item of input) {
    const normalized = cleanText(item, field, { max: itemMax });
    const key = normalized.toLowerCase();
    if (normalized && !seen.has(key)) {
      seen.add(key);
      output.push(normalized);
    }
  }
  return output;
}

function parseOptionalNumber(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0 || number > 100_000_000) {
    throw new ProductError(`${field} 必须是非负数字`, 400, 'INVALID_INPUT');
  }
  return number;
}

function stableProfileHash(profile) {
  const canonical = {
    majors: profile.majors,
    targetRoles: profile.targetRoles,
    locations: profile.locations,
    industries: profile.industries,
    salaryCurrency: profile.salaryCurrency,
    salaryMin: profile.salaryMin,
    salaryMax: profile.salaryMax,
    salaryPeriod: profile.salaryPeriod,
    educationLevel: profile.extras?.educationLevel,
    graduationYear: profile.extras?.graduationYear,
    experienceYears: profile.extras?.experienceYears,
    skills: profile.extras?.skills,
    workModes: profile.extras?.workModes,
    restrictions: profile.extras?.restrictions,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function equalSecret(left, right) {
  if (!left || !right) return false;
  const first = crypto.createHash('sha256').update(String(left)).digest();
  const second = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(first, second);
}

function encodeCursor(offset) {
  return Buffer.from(String(offset), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return 0;
  try {
    const decoded = Buffer.from(String(value), 'base64url').toString('utf8');
    return /^\d+$/.test(decoded) ? Number(decoded) : 0;
  } catch (_) {
    return 0;
  }
}

function dateValue(value, fallback) {
  const parsed = Date.parse(String(value || '').replace(/\//g, '-'));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function followUpDue(value, now, timeZone) {
  if (!value) return false;
  if (/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && timestamp <= now;
  }
  // Legacy datetime-local values remain readable in the profile's zone. Compare
  // wall clocks, never let the server's timezone turn 18:00 into midnight.
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(value)) return false;
  const parts = new Intl.DateTimeFormat('en', { timeZone: normalizeTimeZone(timeZone), year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(now));
  const local = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const due = value.length === 10 ? `${value}T23:59:59` : value.length === 16 ? `${value}:00` : value;
  return due <= `${local.year}-${local.month}-${local.day}T${local.hour}:${local.minute}:${local.second}`;
}

function normalizeFollowUp(value) {
  const raw = cleanText(value, 'followUpAt', { max: 100 });
  if (!raw) return '';
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/i.test(raw) || !Number.isFinite(Date.parse(raw)) || !deadlineFact(raw.slice(0, 10)).date) {
    throw new ProductError('提醒时间必须是带时区的有效 ISO 日期时间', 400, 'INVALID_INPUT');
  }
  return new Date(raw).toISOString();
}

function answerScore(question, response) {
  const optionValue = value => {
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < question.options.length && String(value).trim() !== String(question.options[index]).trim()) {
      return question.options[index];
    }
    return value;
  };
  if (question.type === 'single') {
    const correct = cleanText(optionValue(response), 'response', { max: 500 }) === String(question.answer);
    return { score: correct ? 100 : 0, correct };
  }
  if (question.type === 'multi') {
    const raw = Array.isArray(response) ? response : [response];
    const actual = cleanArray(raw.map(optionValue), 'response', { maxItems: 20, itemMax: 500 }).sort();
    const expected = cleanArray(question.answer, 'answer', { maxItems: 20, itemMax: 500 }).sort();
    const correct = actual.length === expected.length && actual.every((item, index) => item === expected[index]);
    const overlap = actual.filter(item => expected.includes(item)).length;
    const wrong = actual.some(item => !expected.includes(item));
    return { score: correct ? 100 : wrong ? 0 : Math.round(100 * overlap / Math.max(1, expected.length)), correct };
  }
  const responseText = cleanText(response, 'response', { required: true, max: 5000 }).toLowerCase();
  const keywords = Array.isArray(question.answer?.keywords) ? question.answer.keywords.map(item => String(item).toLowerCase()) : [];
  const matched = keywords.filter(keyword => responseText.includes(keyword));
  const score = Math.round(100 * matched.length / Math.max(1, keywords.length));
  return { score, correct: score >= 75 };
}

function hasResponse(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value === undefined || value === null) return false;
  return String(value).trim() !== '';
}

function textContains(left, right) {
  const first = String(left || '').trim().toLowerCase();
  const second = String(right || '').trim().toLowerCase();
  return Boolean(first && second && (first.includes(second) || second.includes(first)));
}

class ProductPlatform {
  constructor({
    dataDir,
    jobService,
    cloud = null,
    clock = () => Date.now(),
    sessionTtlMs = 30 * 24 * 60 * 60 * 1000,
    paymentProvider = null,
    bootstrapRoles = {},
    bootstrapToken = '',
    authMessageSender = null,
    publicAppUrl = '',
    corsOrigins = [],
  } = {}) {
    if (!jobService || typeof jobService.snapshot !== 'function') throw new Error('ProductPlatform 需要 jobService.snapshot()');
    this.clock = clock;
    this.jobService = jobService;
    this.cloud = cloud;
    this.store = new ProductStore({ dataDir, clock });
    this.sessionTtlMs = sessionTtlMs;
    this.paymentProvider = paymentProvider;
    this.authMessageSender = typeof authMessageSender === 'function' ? authMessageSender : null;
    this.publicAppUrl = publicAppUrl;
    this.corsOrigins = corsOrigins;
    this.bootstrapRoles = new Map(Object.entries(bootstrapRoles || {}).map(([email, role]) => [String(email).trim().toLowerCase(), role]));
    this.bootstrapToken = String(bootstrapToken || '');
  }

  initialize() {
    this.store.initialize();
    require('./workspace').initializeWorkspace(this);
    require('./content-admin').initializeContent(this);
    require('./recovery').initializeRecovery(this);
    require('./announcement-enrichment').initializeAnnouncements(this);
    return this;
  }

  close() {
    this.store.close();
  }

  notifications(user) {
    this.requireRole(user, ROLES);
    require('./workspace').workspaceNotifications(this, user);
    const profile = this.store.getProfile(user.id);
    const jobs = new Map(this._catalogJobs(user.id).map(job => [job.id, job]));
    const now = new Date(this.clock()).toISOString();
    const today = localDateKey(this.clock(), profile?.timeZone || 'Asia/Shanghai');
    const insert = this.store.db.prepare('INSERT OR IGNORE INTO user_notifications(user_id,id,title,body,link,created_at) VALUES(?,?,?,?,?,?)');
    for (const state of this.store.listJobStates(user.id)) {
      if (state.hidden || ['ignored','rejected','withdrawn','offer'].includes(state.status)) continue;
      const job = jobs.get(state.jobId); if (!job) continue;
      if (followUpDue(state.followUpAt, this.clock(), profile?.timeZone || 'Asia/Shanghai')) insert.run(user.id, `followup:${state.jobId}:${state.followUpAt}`, '求职行动提醒', `${job.company} · ${state.nextAction || job.position}`, `/jobs/${encodeURIComponent(job.id)}`, now);
      const date=deadlineFact(job.deadline).date;
      const days=date ? Math.round((Date.parse(date)-Date.parse(today))/86400000) : null;
      if (profile?.notificationDeadline !== false && days !== null && days >= 0 && days <= 7) insert.run(user.id,`deadline:${state.jobId}:${date}`, '收藏岗位即将截止', `${job.company} · ${job.position} · ${date} 截止`, `/jobs/${encodeURIComponent(job.id)}`, now);
    }
    const rows=this.store.db.prepare('SELECT * FROM user_notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(user.id);
    return { items:rows.map(row=>({ id:row.id,title:row.title,body:row.body,link:row.link,createdAt:row.created_at,readAt:row.read_at || '' })), unread:rows.filter(row=>!row.read_at).length };
  }

  readNotifications(user) {
    this.requireRole(user, ROLES);
    this.store.db.prepare('UPDATE user_notifications SET read_at=? WHERE user_id=? AND read_at IS NULL').run(new Date(this.clock()).toISOString(),user.id);
    return this.notifications(user);
  }

  exportAccount(user) {
    this.requireRole(user,ROLES);
    const owned = table => this.store.db.prepare(`SELECT * FROM ${table} WHERE user_id=?`).all(user.id);
    const commerce = new (require('./commerce').ProductCommerce)(this);
    const membershipOrders = this.store.db.prepare('SELECT * FROM membership_orders WHERE user_id=? ORDER BY created_at,id').all(user.id).map(row => commerce.order(row));
    const supportTickets = this.store.db.prepare('SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at,id').all(user.id).map(row => commerce.ticket(row));
    return { exportedAt:new Date(this.clock()).toISOString(),user,profile:this.store.getProfile(user.id),jobStates:this.store.listJobStates(user.id),customJobs:this.store.listUserCustomJobs(user.id),...require('./workspace').workspaceExport(this,user),membershipOrders,supportTickets,
      attachments: require('./attachments').initializeAttachments(this).list(user).attachments,
      jobHistory: require('./job-history').exportHistory(this, user),
        ...require('./delivery').initializeDelivery(this).accountExport(user),
        transactions: commerce.accountTransactions(user),
        personalAi: require('./personal-ai').initializePersonalAi(this).exportAccount(user),
        prepBookmarks: require('./prep-notebook').exportNotebook(this, user),
      examSessions:owned('exam_sessions'),prepAttempts:owned('prep_attempts'),prepProgress:owned('prep_progress'),wrongAnswers:owned('exam_wrong_answers'),notifications:owned('user_notifications'),subscription:this.store.getUserPlan(user.id),usage:owned('usage_counters') };
  }

  async deleteAccount(user,input={}) {
    this.requireRole(user,ROLES);
    if (input.confirmation !== 'DELETE') throw new ProductError('请输入 DELETE 确认删除',400,'CONFIRMATION_REQUIRED');
    const record=this.store.getUserWithPasswordByEmail(user.email);
    if (!record || !await verifyPassword(String(input.password || ''),record.passwordHash)) throw new ProductError('密码不正确',401,'INVALID_CREDENTIALS');
      require('./attachments').initializeAttachments(this);
    this.store.db.exec('BEGIN IMMEDIATE');
    try {
      const current=this.store.getUser(user.id);
      if (current?.role==='admin' && this.store.db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin' AND status='active'").get().n<=1) throw new ProductError('请先把管理员权限移交给另一个账户',409,'LAST_ADMIN');
      require('./commerce').anonymizeCommerceUser(this, user.id);
        const cleanupAt = new Date(this.clock()).toISOString();
        this.store.db.prepare('INSERT OR IGNORE INTO attachment_cleanup_tasks(user_id,created_at,updated_at) VALUES(?,?,?)').run(user.id,cleanupAt,cleanupAt);
      this.store.db.prepare('DELETE FROM users WHERE id=?').run(user.id);
      this.store.db.exec('COMMIT');
    } catch(error) { this.store.db.exec('ROLLBACK');throw error; }
    this._rankings?.clear();
      let attachmentCleanup = 'complete';
    try { require('./attachments').cleanupAttachmentUser(this, user.id); }
      catch (_) { attachmentCleanup = 'pending'; console.error('Account deleted; private attachment cleanup requires operator retry'); }
      return {deleted:true,attachmentCleanup};
  }

  async register(input = {}) {
    this.initialize();
    const device = normalizeDevice(input.device);
    const email = normalizeEmail(input.email);
    const displayName = cleanText(input.displayName || input.name || email.split('@')[0], 'displayName', { required: true, max: 80 });
    const passwordHash = await hashPassword(input.password);
    const configuredRole = this.bootstrapRoles.get(email);
    const role = ROLES.includes(configuredRole) && equalSecret(input.bootstrapToken, this.bootstrapToken) ? configuredRole : 'user';
    let user;
    try {
      user = this.store.createUser({ id: randomId('usr'), email, passwordHash, displayName, role });
    } catch (error) {
      if (/UNIQUE constraint failed: users\.email/i.test(String(error.message || ''))) {
        throw new ProductError('该邮箱已注册', 409, 'EMAIL_EXISTS');
      }
      throw error;
    }
    const session = this._createSession(user, device);
    return { user, ...session };
  }

  async login(input = {}) {
    this.initialize();
    const device = normalizeDevice(input.device);
    const email = normalizeEmail(input.email);
    const record = this.store.getUserWithPasswordByEmail(email);
    const valid = record && record.status === 'active' && await verifyPassword(String(input.password || ''), record.passwordHash);
    if (!valid) throw new ProductError('邮箱或密码错误', 401, 'INVALID_CREDENTIALS');
    const { passwordHash, ...user } = record;
    return { user, ...this._createSession(user, device) };
  }

  _createSession(user, device = {}) {
    const token = newOpaqueToken();
    const expiresAt = new Date(this.clock() + this.sessionTtlMs).toISOString();
    this.store.createSession({ id: randomId('ses'), userId: user.id, tokenHash: hashSessionToken(token), expiresAt, device });
    return { token, expiresAt };
  }

  authenticate(token) {
    if (!token) return null;
    return this.store.sessionUser(hashSessionToken(token));
  }

  refreshSession(token, input = {}) {
    const device = input.device === undefined ? null : normalizeDevice(input.device);
    return this.store.transaction(() => {
      const user = this.authenticate(token);
      if (!user) throw new ProductError('登录已过期，请重新登录', 401, 'AUTH_REQUIRED');
      const previous = this.store.db.prepare('SELECT device_json FROM sessions WHERE token_hash=?').get(hashSessionToken(token));
      if (!this.store.revokeSession(hashSessionToken(token))) throw new ProductError('此登录已被替换', 401, 'SESSION_CHANGED');
      return { user, ...this._createSession(user, device || JSON.parse(previous.device_json || '{}')) };
    });
  }

  logout(token) {
    return token ? this.store.revokeSession(hashSessionToken(token)) : false;
  }

  requireRole(user, accepted) {
    if (!user) throw new ProductError('请先登录', 401, 'AUTH_REQUIRED');
    if (!accepted.includes(user.role)) throw new ProductError('没有执行该操作的权限', 403, 'FORBIDDEN');
    return user;
  }

  getProfile(userId) {
    return this.store.getProfile(userId);
  }

  updateProfile(user, input = {}) {
    this.requireRole(user, ROLES);
    const existing = this.store.getProfile(user.id) || {};
    const own = key => Object.prototype.hasOwnProperty.call(input, key);
    const majors = cleanArray(own('majors') ? input.majors : own('major') ? input.major : existing.majors, 'majors', { maxItems: 20 });
    const plan = this.store.getUserPlan(user.id);
    const majorLimit = Number(plan.entitlements['profile.majors']);
    if (majorLimit >= 0 && majors.length > majorLimit) {
      throw new ProductError(`当前套餐最多保存 ${majorLimit} 个专业`, 403, 'ENTITLEMENT_LIMIT', { key: 'profile.majors', limit: majorLimit });
    }
    const profile = {
      majors,
      targetRoles: cleanArray(own('targetRoles') ? input.targetRoles : own('roles') ? input.roles : existing.targetRoles, 'targetRoles'),
      locations: cleanArray(own('locations') ? input.locations : own('preferredLocations') ? input.preferredLocations : own('cities') ? input.cities : existing.locations, 'locations'),
      industries: cleanArray(own('industries') ? input.industries : own('targetIndustries') ? input.targetIndustries : existing.industries, 'industries'),
      salaryCurrency: normalizeCurrency(own('salaryCurrency') ? input.salaryCurrency : own('currency') ? input.currency : existing.salaryCurrency || 'CNY'),
      salaryMin: parseOptionalNumber(own('salaryMin') ? input.salaryMin : existing.salaryMin, 'salaryMin'),
      salaryMax: parseOptionalNumber(own('salaryMax') ? input.salaryMax : existing.salaryMax, 'salaryMax'),
      salaryPeriod: cleanText(own('salaryPeriod') ? input.salaryPeriod : existing.salaryPeriod || 'month', 'salaryPeriod', { max: 20 }),
    };
    if (!['hour', 'week', 'month', 'year'].includes(profile.salaryPeriod)) throw new ProductError('salaryPeriod 仅支持 hour/week/month/year', 400, 'INVALID_INPUT');
    if (profile.salaryMin !== null && profile.salaryMax !== null && profile.salaryMin > profile.salaryMax) {
      throw new ProductError('salaryMin 不能高于 salaryMax', 400, 'INVALID_INPUT');
    }
    const existingExtras = existing || {};
    profile.extras = {
      displayName: cleanText(own('displayName') ? input.displayName : existingExtras.displayName || user.displayName, 'displayName', { max: 80 }),
      educationLevel: cleanText(own('educationLevel') ? input.educationLevel : existingExtras.educationLevel, 'educationLevel', { max: 50 }),
      school: cleanText(own('school') ? input.school : existingExtras.school, 'school', { max: 200 }),
      graduationYear: parseOptionalNumber(own('graduationYear') ? input.graduationYear : existingExtras.graduationYear, 'graduationYear'),
      experienceYears: parseOptionalNumber(own('experienceYears') ? input.experienceYears : existingExtras.experienceYears, 'experienceYears'),
      majorCategory: cleanText(own('majorCategory') ? input.majorCategory : existingExtras.majorCategory, 'majorCategory', { max: 100 }),
      major: cleanText(own('major') ? input.major : existingExtras.major || majors[0], 'major', { max: 100 }),
      skills: cleanArray(own('skills') ? input.skills : existingExtras.skills, 'skills', { maxItems: 100, itemMax: 100 }),
      workModes: cleanArray(own('workModes') ? input.workModes : existingExtras.workModes, 'workModes', { maxItems: 10, itemMax: 50 }),
      salaryMonths: parseOptionalNumber(own('salaryMonths') ? input.salaryMonths : existingExtras.salaryMonths, 'salaryMonths'),
      timeZone: normalizeTimeZone(own('timeZone') ? input.timeZone : existingExtras.timeZone || 'UTC'),
      restrictions: cleanArray(own('restrictions') ? input.restrictions : existingExtras.restrictions, 'restrictions', { maxItems: 50, itemMax: 200 }),
      notificationDeadline: own('notificationDeadline') ? Boolean(input.notificationDeadline) : existingExtras.notificationDeadline !== false,
      notificationRecommendation: own('notificationRecommendation') ? Boolean(input.notificationRecommendation) : existingExtras.notificationRecommendation !== false,
      notificationPrep: own('notificationPrep') ? Boolean(input.notificationPrep) : existingExtras.notificationPrep !== false,
      onboardingCompleted: own('onboardingCompleted') ? Boolean(input.onboardingCompleted) : Boolean(existingExtras.onboardingCompleted),
    };
    if (profile.extras.experienceYears !== null && profile.extras.experienceYears > 60) {
      throw new ProductError('experienceYears 不能超过 60', 400, 'INVALID_INPUT');
    }
    profile.profileHash = stableProfileHash(profile);
    return this.store.updateProfile(user.id, profile, input.expectedVersion);
  }

  _catalogJobs(userId = null) {
    let jobs = this.jobService.snapshot().jobs || [];
    jobs = jobs.filter(job => job && job.active !== '0' && job.source !== '自选');
    jobs = require('./announcement-enrichment').applyAnnouncementOverrides(this, jobs);
    if (userId) {
      const catalogIds = new Set(jobs.map(job => String(job.id)));
      const customJobs = this.store.listUserCustomJobs(userId).filter(job => !catalogIds.has(String(job.id)));
      jobs = [...jobs, ...customJobs];
    }
    return require('./job-quality').applyFactOverrides(this, jobs);
  }

  _publicJob(job) {
    this._publicCache ||= new WeakMap();
    const availability = require('./job-quality').jobAvailability(job, this.clock());
    if (this._publicCache.has(job)) return { ...this._publicCache.get(job), availability };
    const {
      status, appliedAt, statusUpdatedAt, note,
      aiAssessment, classification, priority, isCustom,
      ...catalog
    } = job;
    // The legacy AI assessment was produced from one global profile. It is useful to the
    // operations dashboard, but must never be presented as a new user's personal match.
    void status; void appliedAt; void statusUpdatedAt; void note;
    void aiAssessment; void classification; void priority;
    let application = { ...applicationFact(job.url), source: 'url' };
    if (!application.href) {
      const notice = applicationFact(job.notice);
      if (notice.href) application = { ...notice, source: 'notice', label: notice.kind === 'web' ? '查看公告与投递说明' : notice.label };
      else if (application.kind === 'unknown') application = { ...notice, source: 'notice' };
    }
    const result = { ...catalog, compensation: normalizeSalary(job), deadlineInfo: deadlineFact(job.deadline), application };
    this._publicCache.set(job, result);
    return { ...result, availability };
  }

  listJobs({ user = null, filters = {}, cursor = '', limit = 24 } = {}) {
    const profile = user ? this.store.getProfile(user.id) : null;
    const stateMap = user ? new Map(this.store.listJobStates(user.id).map(state => [state.jobId, state])) : new Map();
    const effectiveFilters = normalizeJobFilters(filters, { currencyFallback: profile?.salaryCurrency || 'CNY', salaryPeriodFallback: profile?.salaryPeriod || 'month' });
    const availability = effectiveFilters.availability;
    if (!user && effectiveFilters.view !== 'all') throw new ProductError('请先登录后查看个人岗位', 401, 'AUTH_REQUIRED');
    const snapshot = this.jobService.snapshot();
    if (this._rankingSnapshot !== snapshot.jobs) { this._rankings = new Map(); this._rankingSnapshot = snapshot.jobs; }
    this._rankings ||= new Map();
    const catalogJobs = this._catalogJobs(user?.id);
    const day = localDateKey(this.clock(), 'Asia/Shanghai');
    // Published catalogs already carry a content hash. Re-hashing every public row
    // for every mobile page request would block the event loop unnecessarily.
    const factVersion = require('./job-quality').qualityVersion(this);
    const catalogVersion = `${snapshot.version || fingerprint(snapshot.jobs)}:${factVersion}:${require('./announcement-enrichment').announcementVersion(this)}`;
    const customVersion = user ? JSON.stringify(this.store.listUserCustomJobs(user.id)) : '';
    const stateVersion = user ? fingerprint([...stateMap.values()].sort((a, b) => a.jobId.localeCompare(b.jobId))) : '';
    const cacheKey = JSON.stringify([user?.id || '', profile, effectiveFilters, customVersion, stateVersion, day, catalogVersion]);
    const signature = fingerprint(cacheKey);
    let requestedOffset = decodeCursor(cursor);
    if (cursor) {
      let decoded;
      try { decoded = Buffer.from(String(cursor), 'base64url').toString('utf8'); } catch (_) { throw new ProductError('分页标识无效', 400, 'INVALID_CURSOR'); }
      if (!/^\d+$/.test(decoded)) {
        let parsed;
        try { parsed = JSON.parse(decoded); } catch (_) { throw new ProductError('分页标识无效', 400, 'INVALID_CURSOR'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1 || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new ProductError('分页标识无效', 400, 'INVALID_CURSOR');
        if (parsed.signature !== signature) throw new ProductError('岗位或筛选条件已更新，请从首页重新加载', 409, 'CURSOR_STALE');
        requestedOffset = parsed.offset;
      }
    }
    let items = this._rankings.get(cacheKey);
    if (!items) {
    const appliedStatuses = new Set(['applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn']);
    items = catalogJobs.filter(job => {
      const state = stateMap.get(String(job.id));
      if (effectiveFilters.view === 'hidden' ? !state?.hidden : state?.hidden) return false;
      if (effectiveFilters.view === 'saved' && !state?.saved) return false;
      const applied = Boolean(state?.appliedAt) || appliedStatuses.has(state?.status);
      if (effectiveFilters.view === 'applied' && !applied) return false;
      if (effectiveFilters.view === 'unapplied' && (applied || state?.status === 'ignored')) return false;
      if (!require('./job-quality').availabilityMatches(job, availability, this.clock()) || !jobPassesFilters(job, effectiveFilters)) return false;
      if (effectiveFilters.deadlineWithin) {
        const date = deadlineFact(job.deadline).date;
        if (!date || date < day || date > shiftDateKey(day, Number(effectiveFilters.deadlineWithin))) return false;
      }
      return true;
    }).map(job => {
      const catalog = this._publicJob(job);
      const match = matchJob(catalog, profile);
      return {
        ...catalog,
        match,
        matchScore: match.score,
        matchReason: match.reasons.join('；'),
        matchReasonShort: match.reasons[0] || '',
        relevanceScore: searchJob(catalog, effectiveFilters.q).score,
      };
    }).filter(job => {
      const qualification = effectiveFilters.qualification;
      return job.match.score >= effectiveFilters.minMatch && (qualification === 'all'
        || (qualification === 'no_conflict' ? job.match.qualification.status !== 'fail' : job.match.qualification.status === qualification));
    });
    const sort = effectiveFilters.sort;
    // lastSeenAt is a collection heartbeat, not a new vacancy or publication.
    const newest = job => [job.publishedAt, job.firstSeenAt, job.createdAt, job.updatedAt].map(value => dateValue(value, 0)).find(Boolean) || 0;
    const deadline = job => dateValue(job.deadlineInfo?.date, Number.POSITIVE_INFINITY);
    const salary = job => {
      const normalized = job.compensation;
      const comparisonCurrency = effectiveFilters.currency || profile?.salaryCurrency || 'CNY';
      const comparisonPeriod = effectiveFilters.salaryPeriod || profile?.salaryPeriod || 'month';
      if (!normalized || normalized.currency !== comparisonCurrency) return Number.NEGATIVE_INFINITY;
      return salaryForPeriod(normalized, comparisonPeriod)?.max ?? Number.NEGATIVE_INFINITY;
    };
    items.sort((left, right) => {
      if (sort === 'relevance') return right.relevanceScore - left.relevanceScore || right.match.score - left.match.score || newest(right) - newest(left) || String(left.id).localeCompare(String(right.id));
      if (sort === 'deadline') return deadline(left) - deadline(right) || right.match.score - left.match.score || String(left.id).localeCompare(String(right.id));
      if (sort === 'salary') return salary(right) - salary(left) || right.match.score - left.match.score || String(left.id).localeCompare(String(right.id));
      if (sort === 'latest') return newest(right) - newest(left) || right.match.score - left.match.score || String(left.id).localeCompare(String(right.id));
      return right.match.score - left.match.score || newest(right) - newest(left) || String(left.id).localeCompare(String(right.id));
    });
    // Bound by rows as well as profiles: 64 complete catalogs can consume too much
    // memory on the small production host. Small queries still benefit from 64 keys.
    let cachedRows = [...this._rankings.values()].reduce((sum, rows) => sum + rows.length, 0);
    while (this._rankings.size && (this._rankings.size >= 64 || cachedRows + items.length > 50000)) {
      const oldest = this._rankings.keys().next().value;
      cachedRows -= this._rankings.get(oldest).length;
      this._rankings.delete(oldest);
    }
    this._rankings.set(cacheKey, items);
    }
    const total = items.length;
    const offset = Math.min(total, requestedOffset);
    const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)));
    items = items.slice(offset, offset + bounded).map(job => ({ ...job, userState: stateMap.get(String(job.id)) || null }));
    const nextOffset = offset + items.length;
    this._qualitySummaries ||= new Map();
    const qualityKey = JSON.stringify([catalogVersion, day, user?.id && customVersion !== '[]' ? user.id : '', customVersion]);
    if (!this._qualitySummaries.has(qualityKey)) {
      if (this._qualitySummaries.size >= 64) this._qualitySummaries.delete(this._qualitySummaries.keys().next().value);
      this._qualitySummaries.set(qualityKey, { dataQuality: require('./job-quality').qualitySummary(catalogJobs, this.clock()), ...require('./job-quality').catalogFacets(catalogJobs) });
    }
    return { items, total, nextCursor: nextOffset < total ? Buffer.from(JSON.stringify({ v: 1, offset: nextOffset, signature })).toString('base64url') : '', limit: bounded,
      ...this._qualitySummaries.get(qualityKey), appliedFilters: effectiveFilters };
  }

  _resolveJobId(jobId, catalogJobs) {
    const requested = String(jobId);
    const ids = new Set(catalogJobs.map(job => String(job.id)));
    if (ids.has(requested)) return requested;
    const aliases = this.jobService.snapshot().aliases;
    const visited = new Set();
    let candidate = requested;
    while (aliases && Object.hasOwn(aliases, candidate) && !visited.has(candidate) && visited.size < 32) {
      visited.add(candidate);
      if (typeof aliases[candidate] !== 'string') break;
      candidate = aliases[candidate];
      if (ids.has(candidate)) return candidate;
    }
    // An acyclic chain may point to a job that has since gone offline. Resolve it
    // so getJob can check this user's state/history, not somebody else's record.
    return visited.size && aliases && !Object.hasOwn(aliases, candidate) ? candidate : requested;
  }

  getJob(jobId, user = null) {
    const catalogJobs = this._catalogJobs(user?.id);
    const canonicalId = this._resolveJobId(jobId, catalogJobs);
    const raw = catalogJobs.find(job => String(job.id) === canonicalId);
    if (!raw) {
      const state = user && (this.store.getJobState(user.id, canonicalId) || this.store.getJobState(user.id, String(jobId)));
      if (!state) throw new ProductError('岗位不存在', 404, 'JOB_NOT_FOUND');
      return { ...this._historicalJob(user, state.jobId), requestedId: String(jobId), canonicalId: state.jobId, userState: state };
    }
    const catalog = this._publicJob(raw);
    const match = matchJob(catalog, user ? this.store.getProfile(user.id) : null);
    return {
      ...catalog, available: true,
      requestedId: String(jobId), canonicalId,
      match,
      matchScore: match.score,
      matchReason: match.reasons.join('；'),
      matchReasonShort: match.reasons[0] || '',
      userState: user ? this.store.getJobState(user.id, canonicalId) || this.store.getJobState(user.id, String(jobId)) : null,
    };
  }

  _historicalJob(user, jobId) {
    const snapshot = require('./job-history').historicalJob(this, user, jobId);
    const job = snapshot || { id: jobId, company: '来源已失效', position: '岗位已下线', active: '0' };
    const catalog = this._publicJob(job);
    const match = matchJob(catalog, this.store.getProfile(user.id));
    return { ...catalog, id: jobId, active: '0', available: false, historical: true,
      application: { kind: 'unavailable', href: '', label: '岗位已下线，请核实最新招聘信息', raw: '', source: '' },
      match, matchScore: match.score, matchReason: match.reasons.join('；'), matchReasonShort: match.reasons[0] || '' };
  }

  updateJobState(user, jobId, input = {}) {
    this.requireRole(user, ROLES);
    jobId = this._resolveJobId(jobId, this._catalogJobs(user.id));
    const savedState = this.store.getJobState(user.id, jobId);
    if (!savedState) this.getJob(jobId, user);
    const existing = savedState || {
      status: 'not_applied', saved: false, favorite: false, hidden: false, note: '', nextAction: '', appliedAt: '', followUpAt: '',
    };
    const status = cleanText(input.status ?? existing.status, 'status', { required: true, max: 30 });
    if (!JOB_STATUSES.includes(status)) throw new ProductError(`status 仅支持 ${JOB_STATUSES.join('/')}`, 400, 'INVALID_INPUT');
    const state = {
      status,
      saved: input.saved === undefined ? existing.saved : Boolean(input.saved),
      favorite: input.favorite === undefined ? existing.favorite : Boolean(input.favorite),
      hidden: input.hidden === undefined ? existing.hidden : Boolean(input.hidden),
      note: cleanText(input.note ?? existing.note, 'note', { max: 8000 }),
      nextAction: cleanText(input.nextAction ?? existing.nextAction, 'nextAction', { max: 500 }),
      appliedAt: cleanText(input.appliedAt ?? existing.appliedAt, 'appliedAt', { max: 100 }),
      followUpAt: Object.hasOwn(input, 'followUpAt') ? normalizeFollowUp(input.followUpAt) : existing.followUpAt,
    };
    const saved = this.store.updateJobState(user.id, String(jobId), state);
    const current = this._catalogJobs(user.id).find(job => String(job.id) === String(jobId));
    if (current) require('./job-history').rememberJob(this, user, this._publicJob(current));
    return saved;
  }

  pipeline(user) {
    this.requireRole(user, ROLES);
    const catalog = new Map(this._catalogJobs(user.id).map(job => [String(job.id), this._publicJob(job)]));
    const items = this.store.listJobStates(user.id)
      .filter(state => state.saved || !['not_applied', 'ignored'].includes(state.status))
      .map(state => {
        const job = catalog.get(state.jobId);
        return {
          ...(job || this._historicalJob(user, state.jobId)),
          id: state.jobId,
          available: Boolean(job),
          userState: state,
        };
      })
      .sort((left, right) => {
        const leftDue = dateValue(left.userState?.followUpAt, Number.NaN);
        const rightDue = dateValue(right.userState?.followUpAt, Number.NaN);
        if (Number.isFinite(leftDue) && Number.isFinite(rightDue)) return leftDue - rightDue;
        if (Number.isFinite(leftDue)) return -1;
        if (Number.isFinite(rightDue)) return 1;
        return dateValue(right.userState?.updatedAt, 0) - dateValue(left.userState?.updatedAt, 0);
      });
    return { counts: this.store.pipelineCounts(user.id), items };
  }

  dashboard(user) {
    this.requireRole(user, ROLES);
    const profile = this.store.getProfile(user.id);
    const recommendations = this.listJobs({ user, limit: 5 }).items;
    const summary = this.store.dashboard(user.id);
    const pipeline = this.store.pipelineCounts(user.id);
    const now = this.clock();
    const urgentJobs = recommendations.filter(job => {
      const end = dateValue(job.deadline, Number.NaN);
      const days = (end - now) / 86_400_000;
      return Number.isFinite(days) && days >= 0 && days <= 7;
    });
    const practiceTrack = this.listPrepTracks(user).find(track => !track.locked) || null;
    const practiceQuestions = practiceTrack ? this.store.listPrepQuestions({ trackId: practiceTrack.id, limit: 5 }) : [];
    const practiceProgress = practiceTrack
      ? this.store.prepProgress(user.id).filter(item => item.trackId === practiceTrack.id)
      : [];
    const completedFields = [profile?.majors?.length, profile?.targetRoles?.length, profile?.locations?.length,
      profile?.skills?.length, profile?.educationLevel, profile?.salaryMin, profile?.salaryMax].filter(Boolean).length;
    return {
      summary,
      counts: {
        recommendedToApply: recommendations.filter(job => job.matchScore >= 60).length,
        interviewsToPlan: Number(pipeline.assessment || 0) + Number(pipeline.interview || 0),
      },
      profile,
      profileCompletion: Math.round(completedFields / 7 * 100),
      recommendations,
      urgentJobs,
      dailyPractice: practiceTrack ? {
        trackId: practiceTrack.id,
        title: practiceTrack.title,
        description: practiceTrack.description,
        questionCount: practiceQuestions.length,
        minutes: Math.max(3, practiceQuestions.length * 2),
        completed: practiceProgress.length,
        topics: practiceQuestions.map(question => question.prompt),
      } : null,
      salaryTarget: { min: profile?.salaryMin, max: profile?.salaryMax, currency: profile?.salaryCurrency, period: profile?.salaryPeriod },
      plan: this.store.getUserPlan(user.id),
    };
  }

  salaryInsights(user) {
    this.requireRole(user, ROLES);
    const plan = this.store.getUserPlan(user.id);
    if (Number(plan.entitlements['salary.insights'] || 0) <= 0) {
      throw new ProductError('薪酬洞察属于专业版或冲刺版权益', 403, 'ENTITLEMENT_LIMIT', {
        key: 'salary.insights',
        planId: plan.id,
      });
    }

    const profile = this.store.getProfile(user.id) || {};
    const currency = profile.salaryCurrency || 'CNY';
    const period = profile.salaryPeriod || 'month';
    const candidates = this._catalogJobs().map(job => {
      const catalog = this._publicJob(job);
      const compensation = salaryForPeriod(normalizeSalary(catalog), period);
      return compensation && compensation.currency === currency
        ? { job: catalog, compensation, match: matchJob(catalog, profile) }
        : null;
    }).filter(Boolean).sort((left, right) => right.match.score - left.match.score ||
      String(right.job.lastSeenAt || '').localeCompare(String(left.job.lastSeenAt || '')));

    const hasRoles = Boolean(profile.targetRoles?.length);
    const hasIndustries = Boolean(profile.industries?.length);
    const hasMajors = Boolean(profile.majors?.length);
    const directional = candidates.filter(row => {
      if (hasRoles) return row.match.dimensions.role > 0;
      if (hasIndustries) return row.match.dimensions.industry > 0;
      if (hasMajors) return row.match.dimensions.major > 0;
      return true;
    });
    const local = profile.locations?.length
      ? directional.filter(row => row.match.dimensions.location > 0)
      : [];
    const rows = local.length >= 5 ? local : directional;
    const sampleScope = local.length >= 5
      ? '目标岗位方向与意向地点'
      : hasRoles ? '目标岗位方向' : hasIndustries ? '目标行业' : hasMajors ? '专业相关方向' : '当前岗位目录';

    const midpointValues = rows.map(row => (row.compensation.min + row.compensation.max) / 2)
      .filter(Number.isFinite).sort((left, right) => left - right);
    const sampleSize = midpointValues.length;
    const median = sampleSize
      ? sampleSize % 2
        ? midpointValues[(sampleSize - 1) / 2]
        : (midpointValues[sampleSize / 2 - 1] + midpointValues[sampleSize / 2]) / 2
      : null;
    const targetValues = [profile.salaryMin, profile.salaryMax]
      .filter(value => value !== null && value !== undefined && value !== '')
      .map(Number).filter(Number.isFinite);
    const targetMidpoint = targetValues.length ? targetValues.reduce((sum, value) => sum + value, 0) / targetValues.length : null;
    const percentile = sampleSize >= 5 && Number.isFinite(targetMidpoint)
      ? Math.round(midpointValues.filter(value => value <= targetMidpoint).length / sampleSize * 100)
      : null;
    const formatRange = compensation => `${Math.round(compensation.min).toLocaleString('en-US')}–${Math.round(compensation.max).toLocaleString('en-US')}`;

    return {
      target: {
        min: profile.salaryMin,
        max: profile.salaryMax,
        currency,
        period,
        months: profile.salaryMonths || null,
      },
      market: {
        currency,
        period,
        sampleSize,
        min: sampleSize ? midpointValues[0] : null,
        median,
        max: sampleSize ? midpointValues[sampleSize - 1] : null,
        percentile,
        insufficient: sampleSize < 5,
        scope: sampleScope,
      },
      comparisons: rows.slice(0, 8).map(row => ({
        id: row.job.id,
        role: row.job.position || '岗位未命名',
        location: row.job.location || '地点未注明',
        min: row.compensation.min,
        max: row.compensation.max,
        currency,
        period,
        range: `${formatRange(row.compensation)} ${currency}/${period === 'year' ? '年' : period === 'hour' ? '小时' : '月'}`,
        package: '岗位公开固定薪资；奖金、股权与福利需向雇主核实',
      })),
      recommendations: [
        '比较年包时把固定薪资、奖金、补贴和股权拆开记录。',
        '岗位公开薪资缺失时保留为未知，不要按零薪资参与比较。',
        '进入面试后结合职责范围、职级和工作地点再次确认薪资区间。',
      ],
      source: `${sampleScope}中可解析的公开薪资字段`,
      updatedAt: new Date(this.clock()).toISOString(),
      disclaimer: '这是岗位库样本汇总，不是全市场薪资调查；样本不足时不计算百分位。',
    };
  }

  listPlans() {
    const seeds = new Map(PLANS.map(plan => [plan.id, plan]));
    return this.store.listPlans().map(plan => ({
      ...plan,
      price: plan.priceMonthly / 100,
      unit: plan.priceMonthly ? '/30 天' : '永久免费',
      description: plan.tagline,
      features: plan.features || seeds.get(plan.id)?.features || [],
      availableForCheckout: Boolean(seeds.get(plan.id)?.availableForCheckout),
      availabilityLabel: seeds.get(plan.id)?.availabilityLabel || '',
    }));
  }

  _userTimeZone(user) {
    if (!user?.id) return 'UTC';
    return normalizeTimeZone(this.store.getProfile(user.id)?.timeZone || 'UTC');
  }

  _periodKey(key, user) {
    if (PERIOD_ENTITLEMENTS.has(key)) return localDateKey(this.clock(), this._userTimeZone(user));
    return 'lifetime';
  }

  entitlements(user) {
    this.requireRole(user, ROLES);
    const plan = this.store.getUserPlan(user.id);
    const values = {};
    const storedCounts = {};
    for (const [key, table] of [['savedSearches.limit','saved_searches'],['offers.limit','user_offers'],['studyPlans.limit','study_plans']]) {
      storedCounts[key] = Number(this.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE user_id=?`).get(user.id).n);
    }
    storedCounts['profile.majors'] = this.store.getProfile(user.id)?.majors?.length || 0;
    for (const [key, limitValue] of Object.entries(plan.entitlements)) {
      const limit = Number(limitValue);
      const used = PERIOD_ENTITLEMENTS.has(key) ? this.store.usage(user.id, key, this._periodKey(key, user)) : (storedCounts[key] || 0);
      values[key] = { limit, used, remaining: limit < 0 ? -1 : Math.max(0, limit - used) };
    }
    return { plan, values, paymentConfigured: this.isPaymentConfigured() };
  }

  isPaymentConfigured() {
    return Boolean(/^[a-z][a-z0-9_-]{0,39}$/.test(this.paymentProvider?.id || '') && typeof this.paymentProvider?.createCheckout === 'function' && typeof this.paymentProvider?.verifyWebhook === 'function');
  }

  _assertAndConsume(user, key, quantity = 1) {
    const plan = this.store.getUserPlan(user.id);
    const limit = Number(plan.entitlements[key] ?? 0);
    const periodKey = this._periodKey(key, user);
    const result = this.store.consumeUsageWithinLimit(user.id, key, periodKey, quantity, limit);
    if (!result.accepted) {
      throw new ProductError('当前套餐用量已达上限', 403, 'ENTITLEMENT_LIMIT', { key, limit, used: result.used });
    }
  }

  listPrepTracks(user) {
    this.requireRole(user, ROLES);
    const limit = Number(this.store.getUserPlan(user.id).entitlements['prep.tracks'] ?? 0);
    const profile = this.store.getProfile(user.id) || {};
    const progress = this.store.prepProgress(user.id);
    const completedByTrack = new Map();
    for (const item of progress) completedByTrack.set(item.trackId, (completedByTrack.get(item.trackId) || 0) + 1);
    const timeZone = this._userTimeZone(user);
    const attemptDays = new Set(this.store.prepAttemptTimestamps(user.id).map(timestamp => localDateKey(timestamp, timeZone)));
    const today = localDateKey(this.clock(), timeZone);
    const yesterday = shiftDateKey(today, -1);
    let cursor = attemptDays.has(today) ? today : attemptDays.has(yesterday) ? yesterday : '';
    let streak = 0;
    while (cursor && attemptDays.has(cursor)) {
      streak++;
      cursor = shiftDateKey(cursor, -1);
    }
    const majors = (profile.majors || []).map(item => String(item).toLowerCase());
    const roles = (profile.targetRoles || []).map(item => String(item).toLowerCase());
    return this.store.listPrepTracks().map(track => {
      const matchedMajor = (track.majors || []).find(item => item !== '不限专业' && majors.some(major => major.includes(String(item).toLowerCase()) || String(item).toLowerCase().includes(major)));
      const matchedRole = (track.roles || []).find(item => item !== '通用' && roles.some(role => role.includes(String(item).toLowerCase()) || String(item).toLowerCase().includes(role)));
      const recommended = Boolean(matchedMajor || matchedRole);
      const totalQuestions = this.store.countPrepQuestions(track.id);
      const completedQuestions = completedByTrack.get(track.id) || 0;
      return {
        ...track,
        locked: !track.freeAccess && limit >= 0 && track.order > limit,
        recommended,
        recommendationReason: matchedRole ? `目标岗位相关：${matchedRole}` : matchedMajor ? `专业方向相关：${matchedMajor}` : '',
        totalQuestions,
        completedQuestions,
        progress: totalQuestions ? Math.round(completedQuestions / totalQuestions * 100) : 0,
        minutes: Math.max(3, Math.min(30, totalQuestions * 2)),
        streak,
      };
    });
  }

  _assertTrackAccess(user, trackId) {
    const track = this.store.getPrepTrack(trackId);
    if (!track) throw new ProductError('备考路径不存在', 404, 'TRACK_NOT_FOUND');
    const limit = Number(this.store.getUserPlan(user.id).entitlements['prep.tracks'] ?? 0);
    if (!track.freeAccess && limit >= 0 && track.order > limit) throw new ProductError('当前套餐未解锁该备考路径', 403, 'ENTITLEMENT_LIMIT', { key: 'prep.tracks', limit });
    return track;
  }

  prepLibrary(user) {
    this.requireRole(user, ROLES);
    const trackIds = this.listPrepTracks(user).filter(track => !track.locked).map(track => track.id);
    const rows = this.store.prepQuestionFacets();
    const available = this.store.prepQuestionFacets({ trackIds });
    const count = (items, match) => items.filter(match).reduce((sum, item) => sum + item.count, 0);
    const counts = match => ({ count: count(rows, match), availableCount: count(available, match) });
    return {
      total: count(rows, () => true), availableTotal: count(available, () => true),
      examTypes: EXAM_TYPES.map(group => {
        const sections = [...group.sections];
        for (const row of rows.filter(item => item.examType === group.value)) {
          if (row.section && !sections.some(section => section.value === row.section)) sections.push({ value: row.section, label: row.section });
        }
        return { value: group.value, label: group.label, ...counts(item => item.examType === group.value),
          sections: sections.map(section => ({ ...section, ...counts(item => item.examType === group.value && item.section === section.value) })) };
      }),
      contentKinds: Object.entries(CONTENT_KINDS).map(([value, label]) => ({ value, label, ...counts(item => item.contentKind === value) })),
      sources: require('./exam-sources').EXAM_SOURCES,
    };
  }

  listPrepQuestions(user, { trackId = '', cursor = '', limit = 24, examType = '', section = '', contentKind = '' } = {}) {
    this.requireRole(user, ROLES);
    let allowedTrackIds;
    if (trackId) {
      this._assertTrackAccess(user, trackId);
      allowedTrackIds = [trackId];
    } else {
      allowedTrackIds = this.listPrepTracks(user).filter(track => !track.locked).map(track => track.id);
    }
    const filters = { trackIds: allowedTrackIds, examType, section, contentKind };
    const total = this.store.countPrepQuestions(filters);
    const offset = Math.min(total, decodeCursor(cursor));
    const bounded = Math.max(1, Math.min(100, Math.floor(Number(limit) || 24)));
    const items = this.store.listPrepQuestions({ ...filters, offset, limit: bounded });
    const nextOffset = offset + items.length;
    return { items, total, nextCursor: nextOffset < total ? encodeCursor(nextOffset) : '', limit: bounded };
  }

  submitPrepAttempt(user, input = {}) {
    if (input.idempotencyKey !== undefined) return this.submitPrepAttempts(user, input);
    this.requireRole(user, ROLES);
    const questionId = cleanText(input.questionId, 'questionId', { required: true, max: 200 });
    const question = this.store.getPrepQuestion(questionId, { includeAnswer: true });
    if (!question) throw new ProductError('题目不存在', 404, 'QUESTION_NOT_FOUND');
    this._assertTrackAccess(user, question.trackId);
    const response = Object.prototype.hasOwnProperty.call(input, 'response') ? input.response : input.answer;
    const result = answerScore(question, response);
    const plan = this.store.getUserPlan(user.id);
    const key = 'prep.attempts.daily';
    const saved = this.store.addPrepAttemptsBatch({
      userId: user.id,
      attempts: [{ id: randomId('att'), questionId, response, ...result }],
      entitlementKey: key,
      periodKey: this._periodKey(key, user),
      limit: Number(plan.entitlements[key] ?? 0),
    });
    if (!saved.accepted) throw new ProductError('当前套餐用量已达上限', 403, 'ENTITLEMENT_LIMIT', { key, limit: saved.limit, used: saved.used });
    const [attempt] = saved.attempts;
    return { attempt, explanation: question.explanation, referenceAnswer: question.answer, ...questionProvenance(question) };
  }

  submitPrepAttempts(user, input = {}) {
    this.requireRole(user, ROLES);
    const keyValue = idempotencyKey(input.idempotencyKey);
    if (keyValue) {
      const normalize = item => ({ questionId: item?.questionId, response: Object.prototype.hasOwnProperty.call(item || {}, 'response') ? item.response : item?.answer });
      const payload = Array.isArray(input.answers) ? { answers: input.answers.map(normalize) } : normalize(input);
      const { idempotencyKey: ignored, ...legacyInput } = input;
      return this.store.idempotent(user.id, 'prep_attempts', keyValue, fingerprint(payload), () => this.submitPrepAttempts(user, legacyInput));
    }
    if (input.idempotencyKey !== undefined) { const { idempotencyKey: ignored, ...legacyInput } = input; return this.submitPrepAttempts(user, legacyInput); }
    if (!Array.isArray(input.answers)) return this.submitPrepAttempt(user, input);
    if (!input.answers.length || input.answers.length > 20) throw new ProductError('answers 数量需为 1-20', 400, 'INVALID_INPUT');
    const prepared = input.answers.map(item => {
      const questionId = cleanText(item.questionId, 'questionId', { required: true, max: 200 });
      const question = this.store.getPrepQuestion(questionId, { includeAnswer: true });
      if (!question) throw new ProductError('题目不存在', 404, 'QUESTION_NOT_FOUND');
      this._assertTrackAccess(user, question.trackId);
      const response = Object.prototype.hasOwnProperty.call(item, 'response') ? item.response : item.answer;
      return {
        attempt: { id: randomId('att'), questionId, response, ...answerScore(question, response) },
        prompt: question.prompt,
        explanation: question.explanation,
        referenceAnswer: question.answer,
        ...questionProvenance(question),
      };
    });
    const key = 'prep.attempts.daily';
    const plan = this.store.getUserPlan(user.id);
    const saved = this.store.addPrepAttemptsBatch({
      userId: user.id,
      attempts: prepared.map(item => item.attempt),
      entitlementKey: key,
      periodKey: this._periodKey(key, user),
      limit: Number(plan.entitlements[key] ?? 0),
    });
    if (!saved.accepted) throw new ProductError('当前套餐用量已达上限', 403, 'ENTITLEMENT_LIMIT', { key, limit: saved.limit, used: saved.used });
    const attempts = saved.attempts;
    const score = Math.round(attempts.reduce((sum, attempt) => sum + attempt.score, 0) / attempts.length);
    const correctCount = attempts.filter(attempt => attempt.correct).length;
    const detailByQuestion = new Map(prepared.map(item => [item.attempt.questionId, item]));
    const items = attempts.map(attempt => {
      const detail = detailByQuestion.get(attempt.questionId);
      return {
        questionId: attempt.questionId,
        prompt: detail?.prompt || '',
        score: attempt.score,
        correct: attempt.correct,
        explanation: detail?.explanation || '',
        referenceAnswer: detail?.referenceAnswer,
        ...questionProvenance(detail || {}),
      };
    });
    return { result: { score, correctCount, total: attempts.length, summary: `得分 ${score} 分，正确 ${correctCount} / ${attempts.length} 题。`, items } };
  }

  prepProgress(user) {
    this.requireRole(user, ROLES);
    return this.store.prepProgress(user.id);
  }

  _examPackQuestions(pack, { includeAnswer = false } = {}) {
    if (pack?._sessionId) {
      const snapshot = this.store.db.prepare('SELECT * FROM exam_session_versions WHERE session_id=?').get(pack._sessionId);
      if (snapshot) return JSON.parse(snapshot.questions_json).map(question => {
        const { answer, explanation, ...publicQuestion } = question;
        return { ...(includeAnswer ? question : publicQuestion), ...questionProvenance(question, { legacySnapshot: true }), version: snapshot.version, scoringRule: snapshot.scoring_rule };
      });
    }
    return (pack?.questionIds || []).map(questionId => this.store.getPrepQuestion(questionId, { includeAnswer })).filter(Boolean);
  }

  _examPackAccess(user, pack) {
    const limit = Number(this.store.getUserPlan(user.id).entitlements['prep.tracks'] ?? 0);
    const tracks = new Map(this.store.listPrepTracks().map(track => [track.id, track]));
    const questions = this._examPackQuestions(pack);
    const lockedTracks = [...new Set(questions.map(question => question.trackId))]
      .map(trackId => tracks.get(trackId))
      .filter(track => track && !track.freeAccess && limit >= 0 && track.order > limit);
    return {
      locked: lockedTracks.length > 0,
      lockedTrackNames: lockedTracks.map(track => track.title),
      entitlement: { key: 'prep.tracks', limit },
    };
  }

  _assertExamPackAccess(user, pack) {
    if (!pack) throw new ProductError('试卷不存在', 404, 'EXAM_PACK_NOT_FOUND');
    const access = this._examPackAccess(user, pack);
    if (access.locked) {
      throw new ProductError('当前套餐未解锁这套试卷', 403, 'ENTITLEMENT_LIMIT', {
        ...access.entitlement,
        lockedTracks: access.lockedTrackNames,
      });
    }
    return access;
  }

  _examPackWithUserState(user, pack, sessions = []) {
    const questions = this._examPackQuestions(pack);
    const access = this._examPackAccess(user, pack);
    const packSessions = sessions.filter(session => session.packId === pack.id);
    const open = packSessions.find(session => session.status === 'in_progress') || null;
    const latestSubmitted = packSessions.find(session => session.status === 'submitted') || null;
    const answeredCount = open ? Object.values(open.answers || {}).filter(hasResponse).length : 0;
    const profile = this.store.getProfile(user.id) || {};
    const matchedRole = (pack.roles || []).find(role => (profile.targetRoles || []).some(target => textContains(role, target)));
    const matchedMajor = (pack.majors || []).find(major => major !== '不限专业' && (profile.majors || []).some(target => textContains(major, target)));
    return {
      ...pack,
      questionCount: questions.length,
      questionTypes: [...new Set(questions.map(question => question.type))],
      locked: access.locked,
      lockedTrackNames: access.lockedTrackNames,
      recommended: Boolean(matchedRole || matchedMajor || pack.featured),
      recommendationReason: matchedRole ? `目标岗位相关：${matchedRole}` : matchedMajor ? `专业方向相关：${matchedMajor}` : pack.featured ? '当前重点题库' : '',
      progress: open ? {
        sessionId: open.id,
        answeredCount,
        totalQuestions: questions.length,
        percent: questions.length ? Math.round(answeredCount / questions.length * 100) : 0,
        currentIndex: open.currentIndex,
        updatedAt: open.updatedAt,
      } : null,
      latestResult: latestSubmitted ? {
        sessionId: latestSubmitted.id,
        score: latestSubmitted.score,
        correctCount: latestSubmitted.correctCount,
        totalQuestions: latestSubmitted.totalQuestions,
        submittedAt: latestSubmitted.submittedAt,
      } : null,
    };
  }

  listExamPacks(user, filters = {}) {
    this.requireRole(user, ROLES);
    const sessions = this.store.listExamSessions(user.id, { limit: 300 });
    const q = cleanText(filters.q, 'q', { max: 120 }).toLowerCase();
    const company = cleanText(filters.company, 'company', { max: 120 });
    const role = cleanText(filters.role, 'role', { max: 120 });
    const major = cleanText(filters.major, 'major', { max: 120 });
    const year = cleanText(filters.year, 'year', { max: 10 });
    const type = cleanText(filters.type, 'type', { max: 40 });
    const difficulty = cleanText(filters.difficulty, 'difficulty', { max: 40 });
    const items = this.store.listExamPacks().map(pack => this._examPackWithUserState(user, pack, sessions)).filter(pack => {
      const haystack = [pack.title, pack.subtitle, pack.description, pack.company, ...(pack.roles || []), ...(pack.majors || [])].join(' ').toLowerCase();
      if (q && !haystack.includes(q)) return false;
      if (company && !textContains(pack.company, company)) return false;
      if (role && !(pack.roles || []).some(item => textContains(item, role))) return false;
      if (major && !(pack.majors || []).some(item => item === '不限专业' || textContains(item, major))) return false;
      if (year && String(pack.year) !== year) return false;
      if (type && pack.type !== type) return false;
      if (difficulty && pack.difficulty !== difficulty) return false;
      return true;
    });
    return {
      items,
      total: items.length,
      facets: {
        companies: [...new Set(this.store.listExamPacks().map(pack => pack.company))],
        years: [...new Set(this.store.listExamPacks().map(pack => pack.year))].sort((a, b) => b - a),
        types: [...new Set(this.store.listExamPacks().map(pack => pack.type))],
        difficulties: [...new Set(this.store.listExamPacks().map(pack => pack.difficulty))],
      },
    };
  }

  getExamPack(user, packId) {
    this.requireRole(user, ROLES);
    const pack = this.store.getExamPack(cleanText(packId, 'packId', { required: true, max: 200 }));
    if (!pack) throw new ProductError('试卷不存在', 404, 'EXAM_PACK_NOT_FOUND');
    const sessions = this.store.listExamSessions(user.id, { limit: 300 });
    return {
      pack: this._examPackWithUserState(user, pack, sessions),
      questions: this._examPackQuestions(pack),
    };
  }

  _cleanExamProgress(pack, input = {}, existing = null) {
    const questions = this._examPackQuestions(pack);
    const questionMap = new Map(questions.map(question => [question.id, question]));
    const rawAnswers = input.answers && typeof input.answers === 'object' && !Array.isArray(input.answers)
      ? input.answers
      : existing?.answers || {};
    const answers = {};
    for (const [questionId, response] of Object.entries(rawAnswers)) {
      const question = questionMap.get(questionId);
      if (!question || !hasResponse(response)) continue;
      if (question.type === 'multi') {
        if (!Array.isArray(response) || response.length > 20) throw new ProductError('多选题答案格式非法', 400, 'INVALID_INPUT');
        answers[questionId] = response.map(item => cleanText(item, 'answer', { max: 500 }));
      } else {
        answers[questionId] = cleanText(response, 'answer', { max: question.type === 'short' ? 5000 : 500 });
      }
    }
    const rawFlagged = Object.prototype.hasOwnProperty.call(input, 'flagged') ? input.flagged : existing?.flagged || [];
    const flagged = cleanArray(rawFlagged, 'flagged', { maxItems: questions.length, itemMax: 200 })
      .filter(questionId => questionMap.has(questionId));
    const currentIndex = Math.max(0, Math.min(questions.length - 1, Number(input.currentIndex ?? existing?.currentIndex) || 0));
    const elapsedSeconds = Math.max(0, Math.min(7 * 24 * 60 * 60, Number(input.elapsedSeconds ?? existing?.elapsedSeconds) || 0));
    return { answers, flagged, currentIndex, elapsedSeconds };
  }

  startExamSession(user, input = {}) {
    this.requireRole(user, ROLES);
    const packId = cleanText(input.packId, 'packId', { required: true, max: 200 });
    const pack = this.store.getExamPack(packId);
    this._assertExamPackAccess(user, pack);
    const questions = this._examPackQuestions(pack);
    if (!questions.length) throw new ProductError('这套试卷暂时没有可用题目', 409, 'EXAM_PACK_EMPTY');
    const started = this.store.createOrResumeExamSession({
      id: randomId('exs'), userId: user.id, packId: pack.id, totalQuestions: questions.length,
    });
    const frozen = this._examPackQuestions(pack, { includeAnswer: true });
    const version = crypto.createHash('sha256').update(JSON.stringify(frozen)).digest('hex');
    this.store.db.prepare('INSERT OR IGNORE INTO exam_session_versions(session_id,version,questions_json) VALUES(?,?,?)').run(started.session.id,version,JSON.stringify(frozen));
    return {
      resumed: started.resumed,
      session: started.session,
      pack: this._examPackWithUserState(user, pack, this.store.listExamSessions(user.id, { limit: 300 })),
      questions: this._examPackQuestions({ ...pack, _sessionId: started.session.id }),
    };
  }

  getExamSession(user, sessionId) {
    this.requireRole(user, ROLES);
    const session = this.store.getExamSession(cleanText(sessionId, 'sessionId', { required: true, max: 200 }), user.id);
    if (!session) throw new ProductError('考试记录不存在', 404, 'EXAM_SESSION_NOT_FOUND');
    const pack = { ...this.store.getExamPack(session.packId), _sessionId: session.id };
    if (!pack) throw new ProductError('试卷不存在', 404, 'EXAM_PACK_NOT_FOUND');
    return { session, pack: this._examPackWithUserState(user, pack, [session]), questions: this._examPackQuestions(pack),
      ...(session.status === 'submitted' ? { result: this._examResult(session, pack) } : {}) };
  }

  _examResult(session, pack) {
    // Older submissions use their frozen question snapshot; never current editorial content.
    const items = this.store.examResults(session.id, session.userId) || this._examPackQuestions(pack, { includeAnswer: true }).map(question => {
      const response = session.answers?.[question.id];
      const scored = hasResponse(response) ? answerScore(question, response) : { score: 0, correct: false };
      return { questionId: question.id, prompt: question.prompt, response: hasResponse(response) ? response : null,
        ...scored, explanation: question.explanation, referenceAnswer: question.answer, ...questionProvenance(question, { legacySnapshot: true }) };
    });
    return { score: session.score, correctCount: session.correctCount, total: session.totalQuestions,
      wrongCount: session.totalQuestions - session.correctCount,
      summary: `得分 ${session.score} 分，答对 ${session.correctCount} / ${session.totalQuestions} 题。`, items };
  }

  saveExamSession(user, sessionId, input = {}) {
    this.requireRole(user, ROLES);
    const id = cleanText(sessionId, 'sessionId', { required: true, max: 200 });
    const existing = this.store.getExamSession(id, user.id);
    if (!existing) throw new ProductError('考试记录不存在', 404, 'EXAM_SESSION_NOT_FOUND');
    if (existing.status !== 'in_progress') throw new ProductError('已交卷记录不能再修改', 409, 'EXAM_ALREADY_SUBMITTED');
    const pack = { ...this.store.getExamPack(existing.packId), _sessionId: existing.id };
    const progress = this._cleanExamProgress(pack, input, existing);
    return this.store.saveExamSession({ id, userId: user.id, ...progress, expectedVersion: input.expectedVersion });
  }

  submitExamSession(user, sessionId, input = {}) {
    this.requireRole(user, ROLES);
    const id = cleanText(sessionId, 'sessionId', { required: true, max: 200 });
    let existing = this.store.getExamSession(id, user.id);
    if (!existing) throw new ProductError('考试记录不存在', 404, 'EXAM_SESSION_NOT_FOUND');
    const pack = { ...this.store.getExamPack(existing.packId), _sessionId: existing.id };
    if (!pack) throw new ProductError('试卷不存在', 404, 'EXAM_PACK_NOT_FOUND');
    if (existing.status === 'submitted') return { session: existing, submittedNow: false, result: this._examResult(existing, pack) };
    expectedVersion(input.expectedVersion);
    if (existing.status === 'in_progress' && input && Object.keys(input).length) {
      const progress = this._cleanExamProgress(pack, input, existing);
      existing = { ...existing, ...progress };
    }
    const questions = this._examPackQuestions(pack, { includeAnswer: true });
    const results = questions.map(question => {
      const response = existing.answers?.[question.id];
      const scored = hasResponse(response) ? answerScore(question, response) : { score: 0, correct: false };
      return {
        attemptId: randomId('att'),
        questionId: question.id,
        prompt: question.prompt,
        response: hasResponse(response) ? response : null,
        score: scored.score,
        correct: scored.correct,
        explanation: question.explanation,
        referenceAnswer: question.answer,
        ...questionProvenance(question, { legacySnapshot: true }),
      };
    });
    const score = questions.length ? Math.round(results.reduce((sum, item) => sum + item.score, 0) / questions.length) : 0;
    const correctCount = results.filter(item => item.correct).length;
    const saved = this.store.submitExamSession({
      id, userId: user.id, answers: existing.answers, flagged: existing.flagged,
      currentIndex: existing.currentIndex, elapsedSeconds: existing.elapsedSeconds,
      score, correctCount, totalQuestions: questions.length, results, expectedVersion: input.expectedVersion,
    });
    if (!saved) throw new ProductError('考试记录不存在', 404, 'EXAM_SESSION_NOT_FOUND');
    return {
      session: saved.session,
      submittedNow: saved.submittedNow,
      result: this._examResult(saved.session, pack),
    };
  }

  examSummary(user) {
    this.requireRole(user, ROLES);
    return this.store.examSummary(user.id);
  }

  examWrongAnswers(user, { includeMastered = false, limit = 100 } = {}) {
    this.requireRole(user, ROLES);
    return this.store.listExamWrongAnswers(user.id, { includeMastered: Boolean(includeMastered), limit });
  }

  examPacksForJob(user, jobId) {
    this.requireRole(user, ROLES);
    const job = this.getJob(jobId, user);
    const company = String(job.company || job.companyName || '');
    const role = String(job.position || job.title || job.role || '');
    const major = String(job.major || job.majors || '');
    const sessions = this.store.listExamSessions(user.id, { limit: 300 });
    const ranked = this.store.listExamPacks().map(pack => {
      let score = pack.featured ? 1 : 0;
      const reasons = [];
      if (textContains(pack.company, company)) { score += 8; reasons.push('公司专项'); }
      const roleMatch = (pack.roles || []).find(item => textContains(item, role));
      if (roleMatch) { score += 5; reasons.push(`岗位方向：${roleMatch}`); }
      const majorMatch = (pack.majors || []).find(item => item !== '不限专业' && textContains(item, major));
      if (majorMatch) { score += 4; reasons.push(`专业方向：${majorMatch}`); }
      if ((pack.majors || []).includes('不限专业')) { score += 1; reasons.push('通用基础'); }
      return { pack: this._examPackWithUserState(user, pack, sessions), score, reason: reasons[0] || '综合能力补充' };
    }).sort((left, right) => right.score - left.score || left.pack.order - right.pack.order);
    return {
      job: { id: job.id, company, title: role, status: job.userState?.status || 'not_applied' },
      items: ranked.slice(0, 3).map(item => ({ ...item.pack, jobRecommendationReason: item.reason })),
    };
  }

  async checkout(user, input = {}) {
    this.requireRole(user, ROLES);
    const planId = cleanText(input.planId, 'planId', { required: true, max: 30 });
    if (!this.store.getPlan(planId) || planId === 'free') throw new ProductError('请选择有效付费套餐', 400, 'INVALID_PLAN');
    const configuredPlan = PLANS.find(plan => plan.id === planId);
    if (!configuredPlan?.availableForCheckout) {
      throw new ProductError('该套餐仍在筹备中，暂不可购买', 409, 'PLAN_NOT_AVAILABLE', { planId });
    }
    if (!this.paymentProvider || typeof this.paymentProvider.createCheckout !== 'function') {
      throw new ProductError('支付渠道尚未配置，当前仅展示套餐与权益', 503, 'PAYMENT_NOT_CONFIGURED', { paymentConfigured: false });
    }
    return this.paymentProvider.createCheckout({ user, planId, returnUrl: cleanText(input.returnUrl, 'returnUrl', { max: 2000 }) });
  }

  listUsers(actor, limit) {
    this.requireRole(actor, ['admin']);
    return this.store.listUsers({ limit }).map(user => ({ ...user, plan: this.store.getUserPlan(user.id) }));
  }

  setUserRole(actor, userId, role) {
    this.requireRole(actor, ['admin']);
    if (!ROLES.includes(role)) throw new ProductError('角色非法', 400, 'INVALID_ROLE');
    const user = this.store.setUserRole(userId, role);
    if (!user) throw new ProductError('用户不存在', 404, 'USER_NOT_FOUND');
    return user;
  }

  setUserPlan(actor, userId, planId) {
    this.requireRole(actor, ['admin']);
    const plan = this.store.setUserPlan(userId, planId, 'admin');
    if (!plan) throw new ProductError('套餐或用户不存在', 404, 'PLAN_NOT_FOUND');
    return plan;
  }

  addPrepQuestion(actor, input = {}) {
    this.requireRole(actor, ['content_editor', 'admin']);
    const trackId = cleanText(input.trackId, 'trackId', { required: true, max: 200 });
    if (!this.store.getPrepTrack(trackId)) throw new ProductError('备考路径不存在', 404, 'TRACK_NOT_FOUND');
    const type = cleanText(input.type, 'type', { required: true, max: 20 });
    if (!['single', 'multi', 'short'].includes(type)) throw new ProductError('题型非法', 400, 'INVALID_INPUT');
    return this.store.addPrepQuestion({
      id: randomId('q'), trackId, type,
      difficulty: cleanText(input.difficulty || '进阶', 'difficulty', { max: 20 }),
      prompt: cleanText(input.prompt, 'prompt', { required: true, max: 5000 }),
      options: cleanArray(input.options, 'options', { maxItems: 20, itemMax: 1000 }),
      answer: input.answer,
      explanation: cleanText(input.explanation, 'explanation', { required: true, max: 5000 }),
    });
  }

  remapJobAliases(aliases) {
    const history = require('./job-history');
    history.remapHistory(this, {}); // Create the additive table outside the atomic remap.
    const announcements = require('./announcement-enrichment');
    announcements.initializeAnnouncements(this);
    const quality = require('./job-quality');
    quality.initializeQuality(this);
    return this.store.remapJobAliases(aliases, resolved => {
      history.remapHistory(this, resolved);
      announcements.remapAnnouncements(this, resolved);
      quality.remapFactOverrides(this, resolved);
    });
  }

  prepareJobAliases(aliases) {
    return this.store.createJobAliasIntent(aliases)?.id || '';
  }

  applyPreparedJobAliases(intentId) {
    if (!intentId) return { aliases: 0, remapped: 0, merged: 0, intentId: '' };
    const intent = this.store.getJobAliasIntent(intentId);
    if (!intent || intent.status === 'applied') return { aliases: 0, remapped: 0, merged: 0, intentId };
    const result = this.remapJobAliases(intent.aliases);
    this.store.markJobAliasIntentApplied(intentId);
    return { ...result, intentId };
  }

  replayPendingJobAliases() {
    const catalogIds = new Set(this._catalogJobs().map(job => String(job.id)));
    const results = [];
    for (const intent of this.store.listPendingJobAliasIntents()) {
      const entries = Object.entries(intent.aliases);
      const committed = entries.length > 0 && entries.every(([oldId, targetId]) => !catalogIds.has(String(oldId)) && catalogIds.has(String(targetId)));
      if (committed) results.push(this.applyPreparedJobAliases(intent.id));
    }
    return results;
  }
}

module.exports = {
  JOB_STATUSES,
  ProductError,
  ProductPlatform,
  ROLES,
};
