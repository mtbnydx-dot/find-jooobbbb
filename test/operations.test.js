'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('../server/node_modules/express');
const { ProductPlatform, createProductRouter } = require('../server/product');

test('operations are admin-only, activity excludes private input, evidence-backed overrides update salary and cursors', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'operations-test-'));
  const jobs = [{ id: 'job1', company: '公司', position: '研发', deadline: '2027-01-01', salaryMin: 1000, salaryMax: 2000, salaryCurrency: 'CNY' }, { id: 'job2', company: '公司2', position: '研发2', deadline: '2027-01-01' }];
  const platform = new ProductPlatform({ dataDir: directory, jobService: { snapshot: () => ({ jobs, version: 'fixture' }) }, clock: () => Date.parse('2026-10-23T00:00:00Z') }).initialize();
  const app = express(); app.use('/api/v1', createProductRouter({ platform }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); platform.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;
  const ordinary = await platform.register({ email: 'ordinary@qa.invalid', password: 'test-password-123', displayName: 'User' });
  const admin = await platform.register({ email: 'admin@qa.invalid', password: 'test-password-123', displayName: 'Admin' });
  platform.store.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.user.id);
  const request = async (route, token = ordinary.token, method = 'GET', body) => {
    const response = await fetch(base + route, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  assert.equal((await request('/admin/operations')).status, 403);
  await request('/jobs');
  const overview = await request('/admin/operations', admin.token);
  assert.equal(overview.status, 200); assert.equal(overview.body.operations.users.active7Days, 1);
  assert.ok(!JSON.stringify(overview.body).includes('ordinary@qa.invalid'));
  const page = await request('/jobs?limit=1');
  const result = await request('/admin/catalog/jobs/job1/facts', admin.token, 'PUT', { salaryText: '10K-20K CNY/月', salaryCurrency: 'CNY', evidenceUrl: 'https://example.com/jobs/1' });
  assert.equal(result.status, 200); assert.equal(result.body.job.compensation.min, 10000);
  assert.equal((await request('/jobs?limit=1&cursor=' + page.body.nextCursor)).body.code, 'CURSOR_STALE');
  assert.equal(platform.store.db.prepare('SELECT COUNT(*) n FROM catalog_fact_audit').get().n, 1);
});
