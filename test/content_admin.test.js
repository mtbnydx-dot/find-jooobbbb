'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { initializeContent, registerContentRoutes } = require('../server/product/content-admin');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-content-'));
  const options = { dataDir: directory, jobService: { snapshot: () => ({ jobs: [] }) },
    bootstrapRoles: { 'editor@example.com': 'content_editor', 'admin@example.com': 'admin' }, bootstrapToken: 'bootstrap-content' };
  const platform = new ProductPlatform(options).initialize();
  const service = initializeContent(platform);
  const editor = await platform.register({ email: 'editor@example.com', password: 'Strong-content-password', displayName: 'Content editor', bootstrapToken: 'bootstrap-content' });
  const user = await platform.register({ email: 'student@example.com', password: 'Strong-content-password', displayName: 'Student' });
  const admin = await platform.register({ email: 'admin@example.com', password: 'Strong-content-password', displayName: 'Administrator', bootstrapToken: 'bootstrap-content' });
  const router = express.Router(); router.use(express.json());
  const requireAuth = (req, res, next) => {
    req.productUser = platform.authenticate(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!req.productUser) return res.status(401).json({ ok: false });
    next();
  };
  registerContentRoutes(router, { platform, requireAuth });
  router.use((error, req, res, next) => res.status(error.statusCode || 500).json({ ok: false, error: error.message, code: error.code }));
  const app = express(); app.use('/api/v1', router); app.use('/api/v1', createProductRouter({ platform }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = async (route, account, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, {
      method, headers: { ...(account ? { Authorization: `Bearer ${account.token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  return { platform, service, editor, user, admin, request, options };
}

const original = overrides => ({ trackId: 'track_job_search', type: 'single', difficulty: '基础',
  prompt: '原创内容审核题：哪种结果可以验证？', options: ['有凭据的结果', '没有依据的判断'], answer: '有凭据的结果',
  explanation: '可查证的材料能帮助验证结果。', sourceType: 'original', author: '课程团队',
  licenseNote: '本团队原创，授权本站公开教学使用。', rightsConfirmed: true, ...overrides });

test('content administration allows editors but excludes students and anonymous requests', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/admin/content/questions')).status, 401);
  assert.equal((await f.request('/admin/content/questions', f.user)).status, 403);
  assert.equal((await f.request('/admin/content/questions/q_job_1', f.user)).status, 403);
  assert.equal((await f.request('/admin/content/questions', f.user, 'POST', original())).status, 403);
  const list = await f.request('/admin/content/questions?limit=5&page=2', f.editor);
  assert.equal(list.status, 200); assert.equal(list.body.items.length, 5); assert.equal(list.body.total, 192);
  const detail = await f.request('/admin/content/questions/q_job_1', f.admin);
  assert.equal(detail.status, 200); assert.ok(detail.body.question.draft.answer); assert.equal(detail.body.question.history[0].action, 'import');
});

test('drafts require validated answers and rights before publishing and never leak into student questions', async t => {
  const f = await fixture(t);
  const created = await f.request('/admin/content/questions', f.editor, 'POST', original({ rightsConfirmed: false }));
  assert.equal(created.status, 201); const id = created.body.question.id;
  assert.equal(created.body.question.status, 'draft'); assert.equal(f.platform.store.getPrepQuestion(id), null);
  assert.equal((await f.request(`/admin/content/questions/${id}/publish`, f.editor, 'POST', { expectedVersion: 1, changeNote: '首发' })).status, 400);
  let edited = f.service.updateQuestion(f.editor.user, id, { expectedVersion: 1, rightsConfirmed: true, answer: '不存在的选项' });
  assert.throws(() => f.service.publishQuestion(f.editor.user, id, { expectedVersion: edited.version, changeNote: '首发' }), /正确答案/);
  edited = f.service.updateQuestion(f.editor.user, id, { expectedVersion: edited.version, answer: '有凭据的结果' });
  const published = f.service.publishQuestion(f.editor.user, id, { expectedVersion: edited.version, changeNote: '核对选项与授权后发布' });
  assert.equal(published.status, 'published'); assert.equal(published.hasDraft, false);
  const student = f.platform.store.getPrepQuestion(id); assert.ok(student); assert.equal(Object.hasOwn(student, 'answer'), false);
  const attempt = f.platform.submitPrepAttempt(f.user.user, { questionId: id, answer: '有凭据的结果' });
  assert.equal(attempt.attempt.score, 100);
  assert.equal(published.history[0].actorId, f.editor.user.id);
  const audit = f.platform.store.db.prepare("SELECT * FROM admin_audit WHERE action='content.publish' AND target_id=?").get(id);
  assert.equal(audit.actor_id, f.editor.user.id);
  assert.equal(JSON.parse(audit.detail_json).version, published.version);
});

test('publishing updated answers preserves in-progress exam snapshots and rejects stale editors', async t => {
  const f = await fixture(t);
  const start = await f.request('/exams/sessions', f.user, 'POST', { packId: 'exam_job_foundations' });
  assert.equal(start.status, 201);
  const before = f.service.getQuestion(f.editor.user, 'q_job_1');
  const edited = f.service.updateQuestion(f.editor.user, 'q_job_1', { expectedVersion: before.version, prompt: '新版题干', answer: before.draft.options[0] });
  assert.equal(f.platform.store.getPrepQuestion('q_job_1').prompt, before.draft.prompt);
  assert.throws(() => f.service.updateQuestion(f.admin.user, 'q_job_1', { expectedVersion: before.version, prompt: '并发覆盖' }), error => error.code === 'CONTENT_VERSION_CONFLICT');
  const published = f.service.publishQuestion(f.editor.user, 'q_job_1', { expectedVersion: edited.version, changeNote: '修改测试题并核对正确答案' });
  assert.equal(f.platform.store.getPrepQuestion('q_job_1').prompt, '新版题干');
  const submitted = await f.request(`/exams/sessions/${start.body.session.id}/submit`, f.user, 'POST', { answers: { q_job_1: before.draft.answer } });
  assert.equal(submitted.status, 200); assert.equal(submitted.body.result.correctCount, 1);
  assert.equal(published.history[0].action, 'publish');
});

test('published edits and retirement survive store restart without changing existing seed count', async t => {
  const f = await fixture(t);
  const before = f.service.getQuestion(f.editor.user, 'q_job_1');
  const edited = f.service.updateQuestion(f.editor.user, before.id, { expectedVersion: before.version, explanation: '这是一条审核后的长期解释。' });
  const published = f.service.publishQuestion(f.editor.user, before.id, { expectedVersion: edited.version, changeNote: '修订解析' });
  f.service.retireQuestion(f.editor.user, before.id, { expectedVersion: published.version, changeNote: '等待进一步复核' });
  assert.equal(f.platform.store.getPrepQuestion(before.id), null);
  f.platform.close(); f.platform.initialize();
  const restarted = initializeContent(f.platform);
  assert.equal(restarted.getQuestion(f.editor.user, before.id).status, 'retired');
  assert.equal(f.platform.store.getPrepQuestion(before.id), null);
  assert.equal(restarted.getQuestion(f.editor.user, before.id).published.explanation, '这是一条审核后的长期解释。');
  assert.equal(f.platform.store.countPrepQuestions(), 191);
});

test('content validation covers authorized sources, duplicate options and short-answer rubrics', async t => {
  const f = await fixture(t);
  const licensed = f.service.createQuestion(f.editor.user, original({ sourceType: 'authorized', sourceUrl: 'javascript:alert(1)' }));
  assert.throws(() => f.service.publishQuestion(f.editor.user, licensed.id, { expectedVersion: licensed.version, changeNote: '发布' }), /有效的公开来源链接/);
  const duplicate = f.service.createQuestion(f.editor.user, original({ options: ['相同', '相同'], answer: '相同' }));
  assert.throws(() => f.service.publishQuestion(f.editor.user, duplicate.id, { expectedVersion: duplicate.version, changeNote: '发布' }), /互不重复/);
  const short = f.service.createQuestion(f.editor.user, original({ type: 'short', answer: { keywords: [], sample: '' } }));
  assert.throws(() => f.service.publishQuestion(f.editor.user, short.id, { expectedVersion: short.version, changeNote: '发布' }), /评分关键词/);
  const update = f.service.updateQuestion(f.editor.user, short.id, { expectedVersion: short.version, answer: { keywords: ['证据'], sample: '说明可以核验的证据。' } });
  assert.equal(f.service.publishQuestion(f.editor.user, short.id, { expectedVersion: update.version, changeNote: '补充量表' }).status, 'published');
});
