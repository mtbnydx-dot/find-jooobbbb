'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');

async function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-notebook-'));
  const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => ({ jobs: [] }) } }).initialize();
  const one = await platform.register({ email: 'one@notebook.example', password: 'Notebook-Password-2026' });
  const two = await platform.register({ email: 'two@notebook.example', password: 'Notebook-Password-2026' });
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const call = async (route, method = 'GET', body, token = one.token) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1${route}`, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });
  return { platform, one, two, call };
}

test('real bookmarks are idempotent, private, bounded and contain no answer keys', async t => {
  const { call, two } = await fixture(t);
  assert.equal((await call('/me/prep/bookmarks', 'GET', undefined, '')).status, 401);
  for (const id of ['q_job_1', 'q_job_2', 'q_job_3']) {
    assert.equal((await call(`/me/prep/bookmarks/${id}`, 'PUT', { saved: true })).status, 200);
    assert.equal((await call(`/me/prep/bookmarks/${id}`, 'PUT', { saved: true })).status, 200);
  }
  const first = (await call('/me/prep/bookmarks?limit=2')).body;
  assert.equal(first.total, 3); assert.equal(first.items.length, 2); assert.ok(first.nextCursor);
  const second = (await call('/me/prep/bookmarks?limit=2&cursor=' + first.nextCursor)).body;
  assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.questionId)).size, 3);
  assert.ok(first.items.every(item => !Object.hasOwn(item.question, 'answer') && !Object.hasOwn(item.question, 'explanation')));
  assert.equal((await call('/me/prep/bookmarks', 'GET', undefined, two.token)).body.total, 0);
  assert.equal((await call('/me/prep/bookmarks?cursor=' + first.nextCursor, 'GET', undefined, two.token)).status, 400);
  assert.equal((await call('/me/prep/bookmarks?cursor=garbage')).status, 400);
  assert.equal((await call('/me/prep/bookmarks/q_job_1')).body.saved, true);
  assert.equal((await call('/me/prep/questions/q_job_1')).body.bookmarked, true);
  assert.equal((await call('/me/prep/bookmarks/q_job_1', 'PUT', { saved: false })).body.saved, false);
  assert.equal((await call('/me/prep/bookmarks')).body.total, 2);
});

test('bookmarks enforce active content and current membership but allow removal after unpublication', async t => {
  const { call, platform } = await fixture(t);
  assert.equal((await call('/me/prep/bookmarks/missing', 'PUT', { saved: true })).status, 404);
  assert.equal((await call('/me/prep/bookmarks/q_job_1', 'PUT', { saved: 'true' })).status, 400);
  await call('/me/prep/bookmarks/q_job_1', 'PUT', { saved: true });
  platform.store.db.prepare('UPDATE prep_questions SET active=0 WHERE id=?').run('q_job_1');
  assert.equal((await call('/me/prep/bookmarks')).body.total, 0);
  assert.equal((await call('/me/prep/questions/q_job_1')).status, 404);
  assert.equal((await call('/me/prep/bookmarks/q_job_1', 'PUT', { saved: false })).status, 200);
  const track = platform.store.db.prepare('SELECT track_id FROM prep_questions WHERE id=?').get('q_job_2');
  platform.store.db.prepare('UPDATE prep_tracks SET free_access=0,sort_order=999 WHERE id=?').run(track.track_id);
  assert.equal((await call('/me/prep/bookmarks/q_job_2', 'PUT', { saved: true })).status, 403);
  assert.equal((await call('/me/prep/questions/q_job_2')).status, 403);
});

test('unified wrongbook includes practice and exam attempts and latest correct practice resolves a mistake', async t => {
  const { call, platform, one, two } = await fixture(t);
  const answer = platform.store.getPrepQuestion('q_job_1', { includeAnswer: true }).answer;
  const wrong = await call('/prep/attempts', 'POST', { questionId: 'q_job_1', answer: 'definitely wrong', idempotencyKey: 'wrong-first' });
  assert.equal(wrong.status, 201);
  let notebook = (await call('/me/prep/wrong')).body;
  assert.equal(notebook.total, 1); assert.equal(notebook.items[0].questionId, 'q_job_1');
  assert.deepEqual(notebook.items[0].question.answer, answer);
  assert.equal((await call('/me/prep/wrong', 'GET', undefined, two.token)).body.total, 0);
  const exam = platform.startExamSession(one.user, { packId: 'exam_huzhou_cloud' });
  platform.submitExamSession(one.user, exam.session.id, {});
  notebook = (await call('/me/prep/wrong?limit=2')).body;
  assert.equal(notebook.total, 6); assert.equal(notebook.items.length, 2); assert.ok(notebook.nextCursor);
  const resolved = await call('/prep/attempts', 'POST', { questionId: 'q_job_1', answer, idempotencyKey: 'correct-after' });
  assert.equal(resolved.status, 201);
  const after = (await call('/me/prep/wrong')).body;
  assert.equal(after.total, 5); assert.ok(after.items.every(item => item.questionId !== 'q_job_1'));
});

test('account export includes bookmarks and account deletion cascades only owned bookmarks', async t => {
  const { call, platform, one, two } = await fixture(t);
  await call('/me/prep/bookmarks/q_job_1', 'PUT', { saved: true });
  await call('/me/prep/bookmarks/q_job_2', 'PUT', { saved: true }, two.token);
  assert.equal((await call('/me/export')).body.prepBookmarks.length, 1);
  assert.equal((await call('/me/account', 'DELETE', { password: 'Notebook-Password-2026', confirmation: 'DELETE' })).status, 200);
  assert.equal(platform.store.db.prepare('SELECT COUNT(*) n FROM prep_bookmarks WHERE user_id=?').get(one.user.id).n, 0);
  assert.equal((await call('/me/prep/bookmarks', 'GET', undefined, two.token)).body.total, 1);
  assert.equal(platform.store.db.prepare('PRAGMA foreign_key_check').all().length, 0);
});
