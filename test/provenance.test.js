'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');
const { initializeContent } = require('../server/product/content-admin');

async function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'job-provenance-'));
  const platform = new ProductPlatform({ dataDir: directory, jobService: { snapshot: () => ({ jobs: [] }) },
    bootstrapRoles: { 'editor@example.com': 'content_editor' }, bootstrapToken: 'test-provenance' }).initialize();
  const service = initializeContent(platform);
  const editor = await platform.register({ email: 'editor@example.com', password: 'Strong-provenance-password', displayName: 'Editor', bootstrapToken: 'test-provenance' });
  const student = await platform.register({ email: 'student@example.com', password: 'Strong-provenance-password', displayName: 'Student' });
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const request = async (route, account = student, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method,
      headers: { ...(account ? { Authorization: `Bearer ${account.token}` } : {}), 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  return { directory, platform, service, editor, student, request };
}

// Test-only fixtures, not seed content or claims about a real examination.
const original = overrides => ({ trackId: 'track_job_search', type: 'single', difficulty: '基础',
  prompt: '自动化测试题，不是公开题库内容。', options: ['甲', '乙'], answer: '甲', explanation: '用于验证题库流程。',
  sourceType: 'original', author: '测试作者', licenseNote: '测试授权记录（不得公开）。', rightsConfirmed: true, ...overrides });
const sourced = overrides => original({ sourceType: 'authorized', contentKind: 'official_sample', examType: 'xingce',
  section: 'quantitative', year: 2025, region: '测试地区', questionNumber: '例 1',
  sourceTitle: '测试材料', sourcePublisher: '测试发布机构', sourceUrl: 'https://example.com/public-test-source',
  sourceEvidence: '内部核验记录，不得出现在学生接口。', ...overrides });
function publish(f, input) {
  const draft = f.service.createQuestion(f.editor.user, input);
  return f.service.publishQuestion(f.editor.user, draft.id, { expectedVersion: draft.version, changeNote: '仅测试发布验证' });
}

test('original catalog classification is honest and library counts separate availability from subscription access', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/prep/library', null)).status, 401);
  const response = await f.request('/prep/library');
  assert.equal(response.status, 200); const library = response.body;
  assert.equal(library.total, 192);
  assert.equal(library.availableTotal, 132);
  assert.deepEqual(library.contentKinds.map(item => [item.value, item.count]), [['original_mock', 192], ['official_sample', 0], ['past_paper', 0]]);
  const xingce = library.examTypes.find(item => item.value === 'xingce');
  assert.equal(xingce.count, 120); assert.equal(xingce.sections.length, 6);
  assert.ok(xingce.sections.every(item => item.count === (['political_theory', 'general_knowledge'].includes(item.value) ? 0 : 30)));
  assert.equal(library.examTypes.find(item => item.value === 'job_general').count, 72);
  assert.ok(library.sources.every(source => source.availability === 'external_reference'));
  const questions = f.platform.store.listPrepQuestions({ limit: 200 });
  assert.equal(questions.length, 192);
  assert.ok(questions.every(question => question.contentKind === 'original_mock'));
  assert.equal(questions.filter(question => question.examType === 'job_general').length, 72);
  assert.equal(questions.filter(question => question.examType === 'xingce').length, 120);
  assert.ok(questions.every(question => !Object.hasOwn(question, 'answer')));
});

test('free xingce path is additive to the original free paths and shares the enforced daily quota', async t => {
  const f = await fixture(t);
  const tracks = f.platform.listPrepTracks(f.student.user);
  const xingce = tracks.find(track => track.id === 'track_xingce');
  assert.equal(xingce.examType, 'xingce'); assert.equal(xingce.freeAccess, true); assert.equal(xingce.locked, false);
  assert.deepEqual(tracks.filter(track => !track.locked).map(track => track.id), ['track_job_search', 'track_behavioral', 'track_xingce']);
  assert.equal(tracks.find(track => track.id === 'track_software').locked, true);
  assert.equal(f.platform.listPrepQuestions(f.student.user, { trackId: 'track_xingce' }).total, 120);
  const questions = f.platform.store.listPrepQuestions({ trackId: 'track_xingce', limit: 6, includeAnswer: true });
  for (const question of questions.slice(0, 5)) f.platform.submitPrepAttempt(f.student.user, { questionId: question.id, answer: question.answer });
  assert.throws(() => f.platform.submitPrepAttempt(f.student.user, { questionId: questions[5].id, answer: questions[5].answer }), error => error.code === 'ENTITLEMENT_LIMIT');
  assert.equal(f.platform.prepProgress(f.student.user).reduce((sum, item) => sum + item.attempts, 0), 5);
});

test('official samples and past papers require provenance and rights before publication', async t => {
  const f = await fixture(t);
  for (const contentKind of ['official_sample', 'past_paper']) {
    for (const missing of ['sourceUrl', 'sourceTitle', 'sourceEvidence', 'year', 'questionNumber', 'rightsConfirmed']) {
      const value = missing === 'rightsConfirmed' ? false : missing === 'year' ? null : '';
      const question = f.service.createQuestion(f.editor.user, sourced({ contentKind, [missing]: value }));
      assert.throws(() => f.service.publishQuestion(f.editor.user, question.id, { expectedVersion: question.version, changeNote: '不能绕过核验' }),
        error => ['CONTENT_RIGHTS_REQUIRED', 'CONTENT_PROVENANCE_REQUIRED'].includes(error.code), `${contentKind} missing ${missing}`);
      assert.equal(f.platform.store.getPrepQuestion(question.id), null);
    }
    for (const sourceUrl of ['javascript:alert(1)', 'https://name:secret@example.com/private', '/relative']) {
      const question = f.service.createQuestion(f.editor.user, sourced({ contentKind, sourceUrl }));
      assert.throws(() => f.service.publishQuestion(f.editor.user, question.id, { expectedVersion: question.version, changeNote: '拒绝无效链接' }), /有效链接/);
    }
    const forged = f.service.createQuestion(f.editor.user, sourced({ contentKind, sourceType: 'original' }));
    assert.throws(() => f.service.publishQuestion(f.editor.user, forged.id, { expectedVersion: forged.version, changeNote: '禁止伪装原创' }), /授权来源/);
    assert.equal(publish(f, sourced({ contentKind })).status, 'published');
  }
  assert.throws(() => f.service.createQuestion(f.editor.user, sourced({ year: 2025.5 })), /年份/);
  assert.throws(() => f.service.createQuestion(f.editor.user, sourced({ section: 'made_up_section' })), /板块/);
  const noSection = f.service.createQuestion(f.editor.user, sourced({ section: '' }));
  assert.throws(() => f.service.publishQuestion(f.editor.user, noSection.id, { expectedVersion: noSection.version, changeNote: '缺分类' }), /六大板块/);
});

test('student question and feedback expose only published public provenance, never editorial evidence or rights records', async t => {
  const f = await fixture(t); const published = publish(f, sourced());
  const draft = f.service.updateQuestion(f.editor.user, published.id, { expectedVersion: published.version, sourceTitle: '未审核新来源', sourceEvidence: '秘密新证据' });
  const response = await f.request('/prep/questions?examType=xingce&section=quantitative&contentKind=official_sample');
  assert.equal(response.status, 200); assert.equal(response.body.total, 1);
  const question = response.body.questions[0];
  assert.equal(question.id, published.id); assert.equal(question.provenance.sourceTitle, '测试材料');
  assert.equal(question.provenance.year, 2025); assert.equal(question.provenance.questionNumber, '例 1');
  const feedback = await f.request('/prep/attempts', f.student, 'POST', { answers: [{ questionId: published.id, answer: '甲' }] });
  assert.equal(feedback.status, 201); assert.equal(feedback.body.result.items[0].provenance.sourceTitle, '测试材料');
  const solo = f.platform.submitPrepAttempt(f.student.user, { questionId: published.id, answer: '甲' });
  assert.equal(solo.provenance.contentKind, 'official_sample');
  const exposed = JSON.stringify([response.body, feedback.body, solo]);
  for (const secret of ['sourceEvidence', 'rightsConfirmed', 'licenseNote', '内部核验记录', '未审核新来源', '秘密新证据']) assert.ok(!exposed.includes(secret), secret);
  const persisted = f.platform.store.db.prepare('SELECT provenance_json FROM prep_questions WHERE id=?').get(published.id).provenance_json;
  assert.ok(!persisted.includes('sourceEvidence')); assert.ok(!persisted.includes('licenseNote'));
  assert.equal(draft.draft.sourceEvidence, '秘密新证据');
  const adminList = f.service.listQuestions(f.editor.user, { examType: 'xingce', section: 'quantitative', contentKind: 'official_sample' });
  assert.equal(adminList.total, 1);
});

test('mounted editorial import accepts a bounded large preview without relaxing other request limits or publishing content', async t => {
  const f = await fixture(t);
  const records = Array.from({ length: 40 }, (_, index) => original({ contentKind: 'original_mock',
    prompt: `大型导入传输测试第${index}条：${'甲'.repeat(4000)}` }));
  assert.ok(Buffer.byteLength(JSON.stringify({ records })) > 128 * 1024);
  const before = f.platform.store.countPrepQuestions();
  const imported = await f.request('/admin/content/import', f.editor, 'POST', { records });
  assert.equal(imported.status, 200); assert.equal(imported.body.dryRun, true);
  assert.equal(imported.body.summary.ready, 40); assert.equal(imported.body.committed, false);
  assert.equal(f.platform.store.countPrepQuestions(), before);
  assert.equal((await f.request('/prep/attempts', f.student, 'POST', { padding: 'A'.repeat(150000) })).status, 413);
});

test('question cursor reaches all questions beyond 200 and sixth question while preserving filters and access checks', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 220; i++) f.platform.store.addPrepQuestion({ id: `q_paging_${String(i).padStart(3, '0')}`, ...original() });
  const expected = f.platform.store.countPrepQuestions('track_job_search'); assert.ok(expected > 200);
  const seen = new Set(); let cursor = ''; let page = 0;
  do {
    const response = await f.request(`/prep/questions?trackId=track_job_search&examType=job_general&contentKind=original_mock&limit=5&cursor=${encodeURIComponent(cursor)}`);
    assert.equal(response.status, 200); assert.equal(response.body.total, expected); assert.ok(response.body.questions.length <= 5);
    for (const question of response.body.questions) { assert.ok(!seen.has(question.id)); seen.add(question.id); }
    cursor = response.body.nextCursor; page++;
  } while (cursor);
  assert.equal(seen.size, expected); assert.ok(page > 40);
  assert.equal((await f.request('/prep/questions?trackId=track_job_search&examType=xingce')).body.total, 0);
  const locked = f.platform.listPrepTracks(f.student.user).find(track => track.locked);
  assert.ok(locked);
  assert.equal((await f.request(`/prep/questions?trackId=${locked.id}&examType=job_general`)).status, 403);
});

test('publishing source updates leaves frozen exam provenance intact and old snapshots explicitly unknown', async t => {
  const f = await fixture(t);
  const start = f.platform.startExamSession(f.student.user, { packId: 'exam_job_foundations' });
  const before = f.service.getQuestion(f.editor.user, 'q_job_1');
  const edited = f.service.updateQuestion(f.editor.user, before.id, { ...sourced(), expectedVersion: before.version });
  f.service.publishQuestion(f.editor.user, before.id, { expectedVersion: edited.version, changeNote: '验证快照不受新来源影响' });
  assert.equal(f.platform.store.getPrepQuestion(before.id).contentKind, 'official_sample');
  const session = f.platform.getExamSession(f.student.user, start.session.id);
  const question = session.questions.find(item => item.id === before.id);
  assert.equal(question.provenance.contentKind, 'original_mock');
  const submitted = f.platform.submitExamSession(f.student.user, start.session.id, { answers: { [before.id]: before.draft.answer } });
  assert.equal(submitted.result.items.find(item => item.questionId === before.id).provenance.contentKind, 'original_mock');
  // Simulate an existing snapshot from before provenance support; never backfill
  // the current official_sample claim into that older original question record.
  const row = f.platform.store.db.prepare('SELECT questions_json FROM exam_session_versions WHERE session_id=?').get(start.session.id);
  const oldQuestions = JSON.parse(row.questions_json).map(({ provenance, contentKind, examType, section, ...item }) => item);
  f.platform.store.db.prepare('UPDATE exam_session_versions SET questions_json=? WHERE session_id=?').run(JSON.stringify(oldQuestions), start.session.id);
  // Pre-upgrade submissions have no independently frozen result payload either.
  f.platform.store.db.prepare('UPDATE exam_sessions SET results_json=NULL WHERE id=?').run(start.session.id);
  const historical = f.platform.getExamSession(f.student.user, start.session.id).questions.find(item => item.id === before.id);
  assert.equal(historical.provenance.contentKind, null); assert.equal(historical.provenance.recorded, false);
  const oldResult = f.platform.submitExamSession(f.student.user, start.session.id, {});
  assert.equal(oldResult.result.items[0].provenance.recorded, false);
});

test('additive provenance migration preserves old content JSON, identities, history, attempts and snapshots across restarts', async t => {
  const f = await fixture(t); const db = f.platform.store.db;
  const oldMetadata = f.service.getQuestion(f.editor.user, 'q_job_1').draft;
  const legacy = Object.fromEntries(Object.entries(oldMetadata).filter(([key]) => !['contentKind', 'examType', 'section', 'year', 'region', 'questionNumber', 'sourceTitle', 'sourcePublisher', 'sourceEvidence'].includes(key)));
  db.prepare('UPDATE content_questions SET draft_json=?,published_json=? WHERE id=?').run(JSON.stringify(legacy), JSON.stringify(legacy), 'q_job_1');
  f.platform.submitPrepAttempt(f.student.user, { questionId: 'q_job_1', answer: legacy.answer });
  f.platform.startExamSession(f.student.user, { packId: 'exam_job_foundations' });
  const protectedTables = ['content_questions', 'content_question_history', 'prep_attempts', 'prep_progress', 'exam_sessions', 'exam_session_versions'];
  const before = Object.fromEntries(protectedTables.map(table => [table, JSON.stringify(db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())]));
  const ids = db.prepare('SELECT id FROM prep_questions ORDER BY id').all().map(row => row.id);
  const questionCoreSql = 'SELECT id,track_id,type,difficulty,prompt,options_json,answer_json,explanation,active FROM prep_questions ORDER BY id';
  const questionCoreBefore = JSON.stringify(db.prepare(questionCoreSql).all());
  db.exec('ALTER TABLE prep_questions DROP COLUMN provenance_json');
  f.platform.close(); f.platform.initialize();
  const reopened = f.platform.store.db;
  assert.deepEqual(reopened.prepare('SELECT id FROM prep_questions ORDER BY id').all().map(row => row.id), ids);
  assert.equal(JSON.stringify(reopened.prepare(questionCoreSql).all()), questionCoreBefore);
  for (const table of protectedTables) assert.equal(JSON.stringify(reopened.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()), before[table], table);
  assert.equal(f.platform.store.getPrepQuestion('q_job_1').provenance.contentKind, 'original_mock');
  assert.equal(initializeContent(f.platform).getQuestion(f.editor.user, 'q_job_1').draft.examType, 'job_general');
  assert.equal(reopened.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  assert.equal(reopened.prepare('PRAGMA foreign_key_check').all().length, 0);
});

test('pre-upgrade exam without a frozen version records missing provenance as unknown rather than importing current labels', async t => {
  const f = await fixture(t);
  const start = f.platform.startExamSession(f.student.user, { packId: 'exam_job_foundations' });
  const db = f.platform.store.db;
  const sessionBefore = JSON.stringify(db.prepare('SELECT * FROM exam_sessions WHERE id=?').get(start.session.id));
  const answersBefore = f.platform.getExamSession(f.student.user, start.session.id).questions.map(question => ({ id: question.id, prompt: question.prompt }));
  db.prepare('DELETE FROM exam_session_versions WHERE session_id=?').run(start.session.id);
  db.exec('ALTER TABLE prep_questions DROP COLUMN provenance_json');
  f.platform.close(); f.platform.initialize();
  const restored = f.platform.getExamSession(f.student.user, start.session.id);
  assert.equal(JSON.stringify(f.platform.store.db.prepare('SELECT * FROM exam_sessions WHERE id=?').get(start.session.id)), sessionBefore);
  assert.deepEqual(restored.questions.map(question => ({ id: question.id, prompt: question.prompt })), answersBefore);
  assert.ok(restored.questions.every(question => question.provenance.recorded === false && question.provenance.contentKind === null));
  assert.equal(f.platform.store.getPrepQuestion('q_job_1').provenance.contentKind, 'original_mock');
  const frozenBefore = f.platform.store.db.prepare('SELECT questions_json FROM exam_session_versions WHERE session_id=?').get(start.session.id).questions_json;
  f.platform.close(); f.platform.initialize();
  assert.equal(f.platform.store.db.prepare('SELECT questions_json FROM exam_session_versions WHERE session_id=?').get(start.session.id).questions_json, frozenBefore);
});
