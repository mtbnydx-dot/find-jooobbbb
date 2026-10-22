'use strict';

const crypto = require('node:crypto');
const { PREP_QUESTIONS } = require('./catalog');
const { normalizeProvenance, publicProvenance, safePublicUrl } = require('./provenance');

const services = new WeakMap();
const EDITORS = ['content_editor', 'admin'];

function fail(message, statusCode = 400, code = 'CONTENT_INVALID') {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  throw error;
}

function text(value, label, max = 5000) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) fail(`${label}格式错误或过长`);
  return value.trim();
}

function strings(value, label, max = 20, length = 500) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > max) fail(`${label}应为不超过 ${max} 项的列表`);
  return value.map(item => text(item, label, length)).filter(Boolean);
}

function normalizeDraft(input = {}, base = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('题目格式错误');
  const value = { ...base, ...input };
  const type = text(value.type || 'single', '题型', 20);
  if (!['single', 'multi', 'short'].includes(type)) fail('请选择单选、多选或简答题');
  let answer;
  if (type === 'short') {
    const supplied = value.answer && typeof value.answer === 'object' && !Array.isArray(value.answer) ? value.answer : {};
    answer = { keywords: strings(supplied.keywords, '评分关键词', 20, 100), sample: text(supplied.sample, '参考回答') };
  } else if (type === 'multi') answer = strings(Array.isArray(value.answer) ? value.answer : [], '正确选项', 12);
  else answer = text(typeof value.answer === 'string' ? value.answer : '', '正确答案', 500);
  const sourceType = text(value.sourceType || 'original', '内容来源', 30);
  if (!['original', 'authorized', 'unverified'].includes(sourceType)) fail('内容来源无效');
  return {
    trackId: text(value.trackId, '备考路径', 200), type,
    difficulty: text(value.difficulty || '基础', '难度', 30),
    prompt: text(value.prompt, '题干'),
    options: type === 'short' ? [] : strings(value.options, '选项', 12),
    answer, explanation: text(value.explanation, '解析'),
    sourceType, ...normalizeProvenance(value),
    author: text(value.author, '作者或权利人', 200),
    licenseNote: text(value.licenseNote, '授权说明', 2000),
    rightsConfirmed: value.rightsConfirmed === true,
  };
}

function rowQuestion(row) {
  return {
    ...JSON.parse(row.provenance_json || '{}'),
    trackId: row.track_id, type: row.type, difficulty: row.difficulty, prompt: row.prompt,
    options: JSON.parse(row.options_json), answer: JSON.parse(row.answer_json), explanation: row.explanation,
  };
}

function validatePublish(db, draft) {
  if (!db.prepare('SELECT id FROM prep_tracks WHERE id=? AND active=1').get(draft.trackId)) fail('请选择有效的备考路径');
  if (!draft.prompt || !draft.explanation || !draft.difficulty) fail('发布前请补全题干、难度与解析');
  if (!['original', 'authorized'].includes(draft.sourceType) || !draft.rightsConfirmed || !draft.author || !draft.licenseNote) {
    fail('发布前请确认原创或授权来源，并填写作者及授权说明', 400, 'CONTENT_RIGHTS_REQUIRED');
  }
  if (draft.examType === 'xingce' && !draft.section) fail('发布行测题目前请选择六大板块之一', 400, 'CONTENT_PROVENANCE_REQUIRED');
  if (draft.contentKind !== 'original_mock') {
    if (draft.sourceType !== 'authorized' || !draft.sourceTitle || !draft.sourceEvidence || !draft.year || !draft.questionNumber || !safePublicUrl(draft.sourceUrl)) {
      fail('官方样题或历年真题发布前必须提供授权来源、来源标题、有效链接、核验依据、年份与原卷题号', 400, 'CONTENT_PROVENANCE_REQUIRED');
    }
  }
  if (draft.sourceType === 'authorized') {
    try {
      const url = new URL(draft.sourceUrl);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid');
    } catch (_) { fail('授权内容必须填写有效的公开来源链接'); }
  }
  if (draft.type === 'short') {
    if (!draft.answer.keywords.length || !draft.answer.sample) fail('简答题需要评分关键词与参考回答');
    if (new Set(draft.answer.keywords).size !== draft.answer.keywords.length) fail('评分关键词不能重复');
    return;
  }
  if (draft.options.length < 2 || new Set(draft.options).size !== draft.options.length) fail('至少需要两个互不重复的选项');
  const answers = draft.type === 'multi' ? draft.answer : [draft.answer];
  if (!answers.length || new Set(answers).size !== answers.length || answers.some(answer => !draft.options.includes(answer))) {
    fail('正确答案必须与选项文字一致且不能重复');
  }
}

function insertLive(db, id, draft, active = 1) {
  db.prepare(`INSERT INTO prep_questions(id,track_id,type,difficulty,prompt,options_json,answer_json,explanation,active,provenance_json)
    VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET track_id=excluded.track_id,type=excluded.type,
    difficulty=excluded.difficulty,prompt=excluded.prompt,options_json=excluded.options_json,
    answer_json=excluded.answer_json,explanation=excluded.explanation,active=excluded.active,provenance_json=excluded.provenance_json`)
    .run(id, draft.trackId, draft.type, draft.difficulty, draft.prompt, JSON.stringify(draft.options),
      JSON.stringify(draft.answer), draft.explanation, active, JSON.stringify(publicProvenance(draft)));
}

class ContentAdmin {
  constructor(platform) {
    this.platform = platform;
    this.db = platform.store.db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS content_questions (
        id TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('draft','published','retired')),
        version INTEGER NOT NULL DEFAULT 1, draft_json TEXT NOT NULL, published_json TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT,
        created_by TEXT NOT NULL, updated_by TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS content_question_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT, question_id TEXT NOT NULL, version INTEGER NOT NULL,
        action TEXT NOT NULL, actor_id TEXT NOT NULL, actor_label TEXT NOT NULL, note TEXT NOT NULL,
        snapshot_json TEXT NOT NULL, created_at TEXT NOT NULL,
        FOREIGN KEY(question_id) REFERENCES content_questions(id)
      );
      CREATE INDEX IF NOT EXISTS content_questions_status_idx ON content_questions(status,updated_at DESC);
      CREATE INDEX IF NOT EXISTS content_question_history_question_idx ON content_question_history(question_id,version DESC);
    `);
    const seeds = new Set(PREP_QUESTIONS.map(question => question.id));
    this.transaction(() => {
      const timestamp = this.now();
      for (const row of this.db.prepare('SELECT * FROM prep_questions').all()) {
        if (this.db.prepare('SELECT id FROM content_questions WHERE id=?').get(row.id)) continue;
        const original = seeds.has(row.id);
        const question = rowQuestion(row);
        const draft = normalizeDraft({ ...question, sourceType: original ? 'original' : 'unverified',
          author: original ? question.sourcePublisher || '职路内容团队' : '', licenseNote: original ? '平台内置原创教学练习，不代表招聘方真题。' : '', rightsConfirmed: original });
        const snapshot = JSON.stringify(draft);
        this.db.prepare(`INSERT INTO content_questions(id,status,version,draft_json,published_json,created_at,updated_at,published_at,created_by,updated_by)
          VALUES(?,?,1,?,?,?,?,?,'system','system')`)
          .run(row.id, row.active ? 'published' : 'retired', snapshot, snapshot, timestamp, timestamp, row.active ? timestamp : null);
        this.history(row.id, 1, 'import', { id: 'system', displayName: '系统迁移' }, '保留现有题目与学生进度', draft);
      }
      // Reapply explicitly managed publications if older catalog code reseeded on startup.
      for (const row of this.db.prepare('SELECT * FROM content_questions WHERE published_json IS NOT NULL').all()) {
        insertLive(this.db, row.id, JSON.parse(row.published_json), row.status === 'published' ? 1 : 0);
      }
    });
  }

  now() { return new Date(this.platform.clock()).toISOString(); }
  authorize(actor) { this.platform.requireRole(actor, EDITORS); }
  transaction(action) {
    const nested = Boolean(this.transactionDepth || this.db.isTransaction);
    const savepoint = `content_${this.transactionSequence = (this.transactionSequence || 0) + 1}`;
    this.db.exec(nested ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth = (this.transactionDepth || 0) + 1;
    try {
      const result = action();
      this.db.exec(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK');
      if (nested) this.db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      throw error;
    } finally { this.transactionDepth--; }
  }
  history(id, version, action, actor, note, snapshot) {
    this.db.prepare(`INSERT INTO content_question_history(question_id,version,action,actor_id,actor_label,note,snapshot_json,created_at)
      VALUES(?,?,?,?,?,?,?,?)`).run(id, version, action, actor.id, actor.displayName || actor.email || actor.id, note, JSON.stringify(snapshot), this.now());
    if (action !== 'import' && this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='admin_audit'").get()) {
      this.db.prepare('INSERT INTO admin_audit(id,actor_id,action,target_type,target_id,detail_json,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(`audit_${crypto.randomUUID()}`, actor.id, `content.${action}`, 'prep_question', id,
          JSON.stringify({ version, note, prompt: snapshot.prompt, trackId: snapshot.trackId }), this.now());
    }
  }
  row(id) {
    const row = this.db.prepare('SELECT * FROM content_questions WHERE id=?').get(String(id));
    if (!row) fail('题目不存在', 404, 'CONTENT_NOT_FOUND');
    return row;
  }
  checkVersion(row, expected) {
    if (!Number.isInteger(expected) || expected !== row.version) fail('内容已被更新，请重新载入后编辑', 409, 'CONTENT_VERSION_CONFLICT');
  }
  view(row, detail = false) {
    const draft = normalizeDraft(JSON.parse(row.draft_json));
    const result = {
      id: row.id, status: row.status, version: row.version, prompt: draft.prompt,
      trackId: draft.trackId, type: draft.type, difficulty: draft.difficulty,
      sourceType: draft.sourceType, author: draft.author, updatedAt: row.updated_at,
      ...publicProvenance(draft),
      publishedAt: row.published_at || '', hasDraft: !row.published_json || row.draft_json !== row.published_json,
    };
    if (detail) {
      result.draft = draft;
      result.published = row.published_json ? normalizeDraft(JSON.parse(row.published_json)) : null;
      result.history = this.db.prepare('SELECT * FROM content_question_history WHERE question_id=? ORDER BY version DESC,id DESC LIMIT 100').all(row.id)
        .map(item => ({ id: item.id, version: item.version, action: item.action, actor: item.actor_label,
          actorId: item.actor_id, note: item.note, createdAt: item.created_at, snapshot: JSON.parse(item.snapshot_json) }));
    }
    return result;
  }
  listQuestions(actor, query = {}) {
    this.authorize(actor);
    const where = [], params = [];
    const q = text(query.q, '搜索词', 200);
    if (q) { where.push('instr(lower(draft_json),?)>0'); params.push(q.toLowerCase()); }
    if (query.status) {
      if (!['draft', 'published', 'retired'].includes(query.status)) fail('题目状态无效');
      where.push('status=?'); params.push(query.status);
    }
    if (query.trackId) { where.push("json_extract(draft_json,'$.trackId')=?"); params.push(text(query.trackId, '路径', 200)); }
    for (const [key, fallback] of [['examType', 'job_general'], ['section', 'general'], ['contentKind', 'original_mock']]) {
      if (query[key]) { where.push(`COALESCE(json_extract(draft_json,'$.${key}'),'${fallback}')=?`); params.push(text(query[key], key, 80)); }
    }
    const clause = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const page = Math.max(1, Math.min(10000, Math.floor(Number(query.page) || 1)));
    const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 25)));
    const total = this.db.prepare(`SELECT COUNT(*) AS n FROM content_questions${clause}`).get(...params).n;
    const items = this.db.prepare(`SELECT * FROM content_questions${clause} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`)
      .all(...params, limit, (page - 1) * limit).map(row => this.view(row));
    const counts = { draft: 0, published: 0, retired: 0 };
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM content_questions GROUP BY status').all()) counts[row.status] = row.n;
    return { items, total, page, limit, counts };
  }
  getQuestion(actor, id) { this.authorize(actor); return this.view(this.row(id), true); }
  listTracks(actor) { this.authorize(actor); return this.platform.store.listPrepTracks(); }
  createQuestion(actor, input = {}) {
    this.authorize(actor);
    const draft = normalizeDraft(input);
    if (!draft.prompt) fail('请填写题干后保存草稿');
    const id = `q_${crypto.randomUUID().replaceAll('-', '')}`;
    this.transaction(() => {
      const timestamp = this.now();
      this.db.prepare(`INSERT INTO content_questions(id,status,version,draft_json,created_at,updated_at,created_by,updated_by)
        VALUES(?,'draft',1,?,?,?,?,?)`).run(id, JSON.stringify(draft), timestamp, timestamp, actor.id, actor.id);
      this.history(id, 1, 'create', actor, text(input.changeNote || '创建草稿', '变更说明', 1000), draft);
    });
    return this.getQuestion(actor, id);
  }
  updateQuestion(actor, id, input = {}) {
    this.authorize(actor);
    this.transaction(() => {
      const row = this.row(id); this.checkVersion(row, input.expectedVersion);
      const draft = normalizeDraft(input, JSON.parse(row.draft_json));
      if (!draft.prompt) fail('请填写题干后保存草稿');
      this.db.prepare('UPDATE content_questions SET draft_json=?,version=version+1,updated_at=?,updated_by=? WHERE id=?')
        .run(JSON.stringify(draft), this.now(), actor.id, id);
      this.history(id, row.version + 1, 'edit', actor, text(input.changeNote || '保存草稿', '变更说明', 1000), draft);
    });
    return this.getQuestion(actor, id);
  }
  publishQuestion(actor, id, input = {}) {
    this.authorize(actor);
    this.transaction(() => {
      const row = this.row(id); this.checkVersion(row, input.expectedVersion);
      const draft = normalizeDraft(JSON.parse(row.draft_json)); validatePublish(this.db, draft);
      const note = text(input.changeNote, '发布说明', 1000);
      if (!note) fail('请填写发布说明');
      insertLive(this.db, id, draft);
      this.db.prepare("UPDATE content_questions SET status='published',draft_json=?,published_json=?,version=version+1,updated_at=?,published_at=?,updated_by=? WHERE id=?")
        .run(JSON.stringify(draft), JSON.stringify(draft), this.now(), this.now(), actor.id, id);
      this.history(id, row.version + 1, 'publish', actor, note, draft);
    });
    return this.getQuestion(actor, id);
  }
  retireQuestion(actor, id, input = {}) {
    this.authorize(actor);
    this.transaction(() => {
      const row = this.row(id); this.checkVersion(row, input.expectedVersion);
      if (row.status === 'retired') fail('题目已经下架', 409, 'CONTENT_ALREADY_RETIRED');
      const note = text(input.changeNote, '下架原因', 1000);
      if (!note) fail('请填写下架原因');
      this.db.prepare('UPDATE prep_questions SET active=0 WHERE id=?').run(id);
      this.db.prepare("UPDATE content_questions SET status='retired',version=version+1,updated_at=?,updated_by=? WHERE id=?")
        .run(this.now(), actor.id, id);
      this.history(id, row.version + 1, 'retire', actor, note, JSON.parse(row.draft_json));
    });
    return this.getQuestion(actor, id);
  }
}

function initializeContent(platform) {
  platform.store.initialize();
  let service = services.get(platform);
  if (!service || service.db !== platform.store.db) {
    service = new ContentAdmin(platform);
    services.set(platform, service);
  }
  return service;
}

function registerContentRoutes(router, { platform, requireAuth }) {
  const service = initializeContent(platform);
  const route = handler => (req, res, next) => { try { handler(req, res); } catch (error) { next(error); } };
  router.get('/admin/content/tracks', requireAuth, route((req, res) => res.json({ ok: true, tracks: service.listTracks(req.productUser) })));
  router.get('/admin/content/questions', requireAuth, route((req, res) => res.json({ ok: true, ...service.listQuestions(req.productUser, req.query) })));
  router.get('/admin/content/questions/:id', requireAuth, route((req, res) => res.json({ ok: true, question: service.getQuestion(req.productUser, req.params.id) })));
  router.post('/admin/content/questions', requireAuth, route((req, res) => res.status(201).json({ ok: true, question: service.createQuestion(req.productUser, req.body) })));
  router.put('/admin/content/questions/:id', requireAuth, route((req, res) => res.json({ ok: true, question: service.updateQuestion(req.productUser, req.params.id, req.body) })));
  router.post('/admin/content/questions/:id/publish', requireAuth, route((req, res) => res.json({ ok: true, question: service.publishQuestion(req.productUser, req.params.id, req.body) })));
  router.post('/admin/content/questions/:id/retire', requireAuth, route((req, res) => res.json({ ok: true, question: service.retireQuestion(req.productUser, req.params.id, req.body) })));
}

module.exports = { initializeContent, registerContentRoutes, normalizeDraft };
