'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform } = require('../server/product');
const { initializeContent } = require('../server/product/content-admin');
const { ProductCommerce } = require('../server/product/commerce');
const { importContentQuestions, registerContentImportRoutes } = require('../server/product/content-import');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-content-import-'));
  const platform = new ProductPlatform({ dataDir: directory, jobService: { snapshot: () => ({ jobs: [] }) },
    bootstrapRoles: { 'editor@import.example': 'content_editor', 'admin@import.example': 'admin' }, bootstrapToken: 'local-import-test' }).initialize();
  new ProductCommerce(platform);
  const editor = await platform.register({ email: 'editor@import.example', password: 'Local-import-test-123!', bootstrapToken: 'local-import-test' });
  const admin = await platform.register({ email: 'admin@import.example', password: 'Local-import-test-123!', bootstrapToken: 'local-import-test' });
  const student = await platform.register({ email: 'student@import.example', password: 'Local-import-test-123!' });
  t.after(() => { platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const service = initializeContent(platform);
  const count = table => platform.store.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
  return { platform, service, editor, admin, student, count, run: (input, actor = editor.user) => importContentQuestions(platform, actor, input) };
}

// Synthetic fixtures only; these are not real exam questions or licensed content.
const record = (label, overrides = {}) => ({ trackId: 'track_job_search', type: 'single', difficulty: '基础',
  prompt: `导入测试记录 ${label}`, options: ['测试选项甲', '测试选项乙'], answer: '测试选项甲', explanation: '仅用于自动化测试。',
  contentKind: 'original_mock', sourceType: 'original', author: '测试作者', licenseNote: '自动化测试用原创占位内容。', rightsConfirmed: true, ...overrides });

test('content import defaults to preview, retains provenance, commits only drafts and is idempotent', async t => {
  const f = await fixture(t);
  const input = record('来源', { contentKind: 'past_paper', examType: 'xingce', section: 'reasoning', year: 2025,
    region: '测试地区', questionNumber: '12', sourceTitle: '测试来源记录（非真实试卷）', sourcePublisher: '测试发布方',
    sourceUrl: 'https://example.com/test-source', sourceEvidence: '内部测试核验备注', sourceType: 'unverified',
    author: '测试权利人', licenseNote: '尚未取得正式授权，仅暂存草稿', rightsConfirmed: false });
  const before = { content: f.count('content_questions'), live: f.count('prep_questions'), audit: f.count('admin_audit') };
  const planned = f.run({ records: [input] });
  assert.equal(planned.dryRun, true); assert.equal(planned.committed, false); assert.equal(planned.rows[0].status, 'ready');
  assert.equal(f.count('content_questions'), before.content); assert.equal(f.count('admin_audit'), before.audit);
  const imported = f.run({ records: [input], dryRun: false });
  assert.equal(imported.summary.created, 1); assert.equal(imported.committed, true);
  const saved = f.service.getQuestion(f.editor.user, imported.rows[0].createdId);
  assert.equal(saved.status, 'draft'); assert.equal(saved.published, null); assert.equal(f.count('prep_questions'), before.live);
  for (const key of ['contentKind', 'examType', 'section', 'year', 'region', 'questionNumber', 'sourceTitle', 'sourcePublisher', 'sourceUrl', 'sourceEvidence', 'sourceType', 'author', 'licenseNote', 'rightsConfirmed']) assert.deepEqual(saved.draft[key], input[key], key);
  assert.equal(saved.history[0].actorId, f.editor.user.id);
  const replay = f.run({ records: [input], dryRun: false }, f.admin.user);
  assert.equal(replay.summary.created, 0); assert.equal(replay.summary.skipped, 1);
  assert.equal(f.count('content_questions'), before.content + 1);
});

test('normalized prompt and sorted options deduplicate within a batch and against published and draft versions', async t => {
  const f = await fixture(t);
  const first = record('Ａ');
  const reordered = record('A', { options: [...first.options].reverse() });
  const planned = f.run({ records: [first, reordered] });
  assert.deepEqual(planned.rows.map(row => row.status), ['ready', 'duplicate']);
  const imported = f.run({ records: [first, reordered], dryRun: false });
  assert.equal(imported.summary.created, 1); assert.equal(imported.summary.skipped, 1);
  const id = imported.rows[0].createdId;
  f.service.publishQuestion(f.editor.user, id, { expectedVersion: 1, changeNote: '测试发布' });
  f.service.updateQuestion(f.editor.user, id, { expectedVersion: 2, prompt: '修改后的测试题干' });
  assert.equal(f.run({ records: [reordered] }).rows[0].status, 'duplicate');
  assert.equal(f.run({ records: [record('无关', { prompt: '修改后的测试题干' })] }).rows[0].status, 'duplicate');
});

test('answer conflicts and invalid records block the entire import without overwrites', async t => {
  const f = await fixture(t);
  const seed = f.service.getQuestion(f.editor.user, 'q_job_1');
  const conflict = { ...seed.draft, answer: seed.draft.options.find(option => option !== seed.draft.answer) };
  const before = f.count('content_questions');
  const result = f.run({ records: [record('有效'), conflict, record('无效', { answer: '不在选项中' })], dryRun: false });
  assert.equal(result.committed, false); assert.equal(result.canImport, false);
  assert.deepEqual(result.rows.map(row => row.status), ['ready', 'conflict', 'invalid']);
  assert.equal(result.summary.created, 0); assert.equal(f.count('content_questions'), before);
  assert.deepEqual(f.service.getQuestion(f.editor.user, seed.id), seed);
  const batchConflict = f.run({ records: [record('同题'), record('同题', { answer: '测试选项乙' })] });
  assert.deepEqual(batchConflict.rows.map(row => row.status), ['conflict', 'conflict']);
});

test('a runtime failure rolls back all drafts, history and audit entries', async t => {
  const f = await fixture(t);
  const tables = ['content_questions', 'content_question_history', 'admin_audit'];
  const before = tables.map(f.count);
  const create = f.service.createQuestion;
  let calls = 0;
  f.service.createQuestion = function(...args) { if (++calls === 2) throw new Error('injected import failure'); return create.apply(this, args); };
  try { assert.throws(() => f.run({ records: [record('原子1'), record('原子2')], dryRun: false }), /injected import failure/); }
  finally { f.service.createQuestion = create; }
  assert.deepEqual(tables.map(f.count), before);
});

test('import validates bounds, explicit source category, types and supported answer structures', async t => {
  const f = await fixture(t);
  for (const input of [null, [], {}, { records: [] }, { records: Array(201).fill(record('越界')) }, { records: [record('布尔')], dryRun: 'false' }]) assert.throws(() => f.run(input), error => error.statusCode === 400);
  const invalid = f.run({ records: [null, record('来源', { contentKind: '' }), record('轨道', { trackId: 'missing' }), record('选项', { options: ['same', 'ＳＡＭＥ'], answer: 'same' }), record('年份', { year: 3000 }), record('简答', { type: 'short', answer: {} })] });
  assert.equal(invalid.summary.invalid, 6);
  const valid = f.run({ records: [record('多选', { type: 'multi', answer: ['测试选项乙', '测试选项甲'] }), record('简答', { type: 'short', answer: { keywords: ['测试'], sample: '测试回答' } }), record('来源待核', { sourceType: undefined, rightsConfirmed: false })], dryRun: false });
  assert.equal(valid.summary.created, 3); assert.equal(valid.rows[2].draft.sourceType, 'unverified');
});

test('import route permits only authenticated editors or administrators', async t => {
  const f = await fixture(t);
  const app = express(); app.use(express.json());
  registerContentImportRoutes(app, { platform: f.platform, requireAuth: (req, res, next) => {
    req.productUser = f.platform.authenticate(String(req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!req.productUser) return res.status(401).json({ ok: false }); next();
  } });
  app.use((error, req, res, next) => res.status(error.statusCode || 500).json({ ok: false, error: error.message }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    for (const [account, expected] of [[null, 401], [f.student, 403], [f.editor, 200], [f.admin, 200]]) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/admin/content/import`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(account ? { Authorization: `Bearer ${account.token}` } : {}) }, body: JSON.stringify({ records: [record('权限')] }) });
      assert.equal(response.status, expected);
    }
  } finally { await new Promise(resolve => server.close(resolve)); }
});
