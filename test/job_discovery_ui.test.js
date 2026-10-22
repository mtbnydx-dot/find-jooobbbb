'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = import('../web/src/lib/job-discovery.js');

function installSessionStorage(t) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)) };
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => { if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor); else delete globalThis.sessionStorage; });
  return { storage, values };
}

test('job filter defaults exclude expired records and whitelist URL fields', async () => {
  const { JOB_FILTER_DEFAULTS, readJobFilters, jobFilterParams } = await helpers;
  const filters = readJobFilters(new URLSearchParams('unexpected=value&tab=ai'));
  assert.deepEqual(filters, JOB_FILTER_DEFAULTS);
  assert.equal(filters.availability, 'active');
  assert.equal(jobFilterParams(filters).toString(), '');
});

test('legacy AI URLs never send ai as the personal-view filter', async () => {
  const { readJobFilters, jobFilterParams } = await helpers;
  const filters = readJobFilters(new URLSearchParams('view=ai&q=开发'));
  assert.equal(filters.view, 'all');
  const params = jobFilterParams(filters, true);
  assert.equal(params.get('tab'), 'ai');
  assert.equal(params.has('view'), false);
  assert.equal(params.get('q'), '开发');
  assert.equal(jobFilterParams({ ...filters, view: 'saved' }, true).get('view'), 'saved');
});

test('weekly salary filters survive URL round trips', async () => {
  const { readJobFilters, jobFilterParams } = await helpers;
  const filters = readJobFilters(new URLSearchParams('currency=AUD&salaryPeriod=week&salaryMin=1200'));
  assert.equal(filters.salaryPeriod, 'week');
  assert.deepEqual(readJobFilters(jobFilterParams(filters)), filters);
});

test('zero minimum match scores do not create misleading active chips', async () => {
  const { readJobFilters, jobFilterChips } = await helpers;
  for (const value of ['0', '0.0', '']) {
    const filters = readJobFilters(new URLSearchParams({ minMatch: value }));
    assert.equal(filters.minMatch, '');
    assert.equal(jobFilterChips(filters).some(chip => chip.key === 'minMatch'), false);
  }
});

test('known filters serialize without losing sources or personal views', async () => {
  const { readJobFilters, jobFilterParams, jobFilterChips } = await helpers;
  const filters = readJobFilters(new URLSearchParams({ q: ' 财务 分析 ', source: '公开目录 / A&B', role: '分析师', nature: '校招', qualification: 'no_conflict', availability: 'all', view: 'saved', deadlineWithin: '7', salaryMax: '20000', currency: 'CNY' }));
  assert.equal(filters.q, '财务 分析');
  assert.deepEqual(readJobFilters(jobFilterParams(filters)), filters);
  assert.equal(jobFilterChips(filters).find(chip => chip.key === 'view').value, '我的收藏');
  assert.equal(jobFilterChips(filters).find(chip => chip.key === 'source').value, '公开目录 / A&B');
});

test('unknown enumerated filters fall back to supported defaults', async () => {
  const { JOB_FILTER_DEFAULTS, readJobFilters } = await helpers;
  const filters = readJobFilters(new URLSearchParams('view=invalid&availability=invalid&qualification=invalid&sort=invalid&salaryPeriod=invalid&deadlineWithin=99'));
  for (const key of ['view', 'availability', 'qualification', 'sort', 'salaryPeriod', 'deadlineWithin']) assert.equal(filters[key], JOB_FILTER_DEFAULTS[key]);
});

test('salary thresholds and salary sorting require an explicit currency', async () => {
  const { JOB_FILTER_DEFAULTS, validateJobFilters } = await helpers;
  for (const patch of [{ salaryMin: '10' }, { salaryMax: '20' }, { sort: 'salary' }]) {
    assert.match(validateJobFilters({ ...JOB_FILTER_DEFAULTS, ...patch }), /币种/);
    assert.equal(validateJobFilters({ ...JOB_FILTER_DEFAULTS, ...patch, currency: 'CNY' }), '');
  }
});

test('negative nonfinite and over-100 match inputs are rejected', async () => {
  const { JOB_FILTER_DEFAULTS, validateJobFilters } = await helpers;
  for (const [key, value] of [['salaryMin', '-1'], ['salaryMax', 'Infinity'], ['minMatch', 'bad'], ['minMatch', '101']]) assert.notEqual(validateJobFilters({ ...JOB_FILTER_DEFAULTS, currency: 'CNY', [key]: value }), '');
  assert.equal(validateJobFilters({ ...JOB_FILTER_DEFAULTS, minMatch: '100' }), '');
});

test('salary ranges reject inverted bounds but accept equal bounds', async () => {
  const { JOB_FILTER_DEFAULTS, validateJobFilters } = await helpers;
  assert.match(validateJobFilters({ ...JOB_FILTER_DEFAULTS, currency: 'CNY', salaryMin: '20000', salaryMax: '10000' }), /最低薪资不能高于最高薪资/);
  assert.equal(validateJobFilters({ ...JOB_FILTER_DEFAULTS, currency: 'CNY', salaryMin: '20000', salaryMax: '20000' }), '');
});

test('bookmarks and applied dates remain independent of application stages', async () => {
  const { matchesPersonalView } = await helpers;
  assert.equal(matchesPersonalView({ saved: true, status: 'applied' }, 'saved'), true);
  assert.equal(matchesPersonalView({ saved: false, status: 'saved' }, 'saved'), false);
  assert.equal(matchesPersonalView({ status: 'not_applied', appliedAt: '2026-10-23T00:00:00Z' }, 'applied'), true);
  for (const status of ['applied', 'assessment', 'interview', 'offer', 'rejected', 'withdrawn']) assert.equal(matchesPersonalView({ status }, 'applied'), true);
});

test('hidden records require the hidden view and ignored records are not unapplied', async () => {
  const { matchesPersonalView } = await helpers;
  const hidden = { hidden: true, saved: true, status: 'applied' };
  for (const view of ['all', 'saved', 'unapplied', 'applied']) assert.equal(matchesPersonalView(hidden, view), false);
  assert.equal(matchesPersonalView(hidden, 'hidden'), true);
  assert.equal(matchesPersonalView({}, 'hidden'), false);
  assert.equal(matchesPersonalView({ status: 'ignored' }, 'unapplied'), false);
  assert.equal(matchesPersonalView({ status: 'not_applied' }, 'unapplied'), true);
});

test('deadline labels preserve full dates and distinguish unknown from active', async () => {
  const { jobDeadlineLabel } = await helpers;
  assert.equal(jobDeadlineLabel({ availability: { status: 'expired', date: '2025-12-31' } }), '2025-12-31 · 已截止');
  assert.equal(jobDeadlineLabel({ availability: { status: 'active', date: '2027-12-31' } }), '截止 2027-12-31');
  assert.equal(jobDeadlineLabel({ availability: { status: 'rolling' } }), '长期招聘 · 名额需核实');
  assert.equal(jobDeadlineLabel({ deadline: '招满即止', availability: { status: 'unknown' } }), '招满即止 · 期限待核实');
  assert.equal(jobDeadlineLabel({}), '截止日期未公开');
});

test('reading positions are isolated by user and query and contain no job payloads', async t => {
  const { rememberJobPosition, readJobPosition } = await helpers;
  const { values } = installSessionStorage(t);
  rememberJobPosition('user-a', 'q=开发', 40, 1200);
  assert.equal(readJobPosition('user-a', 'q=开发').count, 40);
  assert.equal(readJobPosition('user-a', 'q=开发').scroll, 1200);
  assert.equal(readJobPosition('user-b', 'q=开发'), null);
  assert.equal(readJobPosition('user-a', 'q=财务'), null);
  const persisted = JSON.parse([...values.values()][0])['q=开发'];
  assert.deepEqual(Object.keys(persisted).sort(), ['at', 'count', 'scroll']);
});

test('reading-position storage is bounded expires and tolerates unavailable storage', async t => {
  const { rememberJobPosition, readJobPosition } = await helpers;
  const { storage, values } = installSessionStorage(t);
  let clock = 1800000000000;
  t.mock.method(Date, 'now', () => clock);
  for (let index = 0; index < 10; index++) { clock++; rememberJobPosition('user-a', `q=${index}`, 20, -5); }
  const stored = JSON.parse([...values.values()][0]);
  assert.equal(Object.keys(stored).length, 8);
  assert.equal(readJobPosition('user-a', 'q=9').scroll, 0);
  assert.equal(readJobPosition('user-a', 'q=0'), null);
  clock += 1800000;
  assert.equal(readJobPosition('user-a', 'q=9'), null);
  storage.getItem = () => '{malformed';
  assert.equal(readJobPosition('user-a', 'q=9'), null);
  storage.getItem = () => { throw new Error('Storage disabled'); };
  assert.doesNotThrow(() => rememberJobPosition('user-a', 'q=9', 20, 5));
  assert.equal(readJobPosition('user-a', 'q=9'), null);
});
