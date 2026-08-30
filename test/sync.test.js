'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const {
  COLUMNS,
  buildHeaderMap,
  calendarCellToText,
  normalizeTimestamp,
  readExcel,
  markLocalChanges,
  buildReminders,
  normalizeServerJobs,
  writeBackExcel,
  atomicWriteWorkbook,
  checkpointSnapshot,
  acquireSyncLock,
  validateConfig,
  validatePushResponse,
} = require('../local/sync');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-sync-local-'));
}

function cleanup(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())), 'refuse to clean outside temp');
  fs.rmSync(directory, { recursive: true, force: true });
}

test('header mapping follows names, accepts reordering, and rejects gaps/duplicates', () => {
  const headers = COLUMNS.map(([, header]) => header).reverse();
  const map = buildHeaderMap(headers);
  assert.equal(map.id, headers.indexOf('_id'));
  assert.equal(map.statusUpdatedAt, headers.indexOf('状态更新时间'));
  assert.throws(() => buildHeaderMap(headers.filter(header => header !== '备注')), /缺少列: 备注/);
  assert.throws(() => buildHeaderMap([...headers, '备注']), /表头重复: 备注/);
});

test('Excel serial dates and explicit offsets normalize deterministically', () => {
  assert.equal(calendarCellToText(1, '日期'), '1900/01/01');
  assert.equal(calendarCellToText(0, '日期', { date1904: true }), '1904/01/01');
  assert.equal(normalizeTimestamp('2026-08-07T10:00:00+10:00', '时间', { nowMs: Date.parse('2026-08-08T00:00:00Z') }), '2026-08-07T00:00:00.000Z');
  assert.match(normalizeTimestamp('2026/08/07 10:20:30', '时间', { nowMs: Date.parse('2026-08-08T00:00:00Z') }), /^2026-08-0[67]T/);
  assert.throws(() => normalizeTimestamp('46241', '时间'), /必须是带时区 ISO 时间/);
});

test('local state changes always get a fresh timestamp and pending retries reuse it', () => {
  const now = Date.parse('2026-08-08T02:00:00Z');
  const oldTimestamp = '2026-08-01T00:00:00.000Z';
  const jobs = [{ id: 'job_1', status: '已投递', appliedAt: '', statusUpdatedAt: oldTimestamp, note: '' }];
  const first = markLocalChanges(jobs, {
    committed: { job_1: { status: '未投递', appliedAt: '', statusUpdatedAt: oldTimestamp, note: '' } },
    pending: {},
  }, now);
  assert.equal(first.timestamped, 1);
  assert.equal(jobs[0].statusUpdatedAt, new Date(now).toISOString());
  assert.match(jobs[0].appliedAt, /^\d{4}\/\d{2}\/\d{2}$/);

  const retryJobs = [{ id: 'job_1', status: '已投递', appliedAt: jobs[0].appliedAt, statusUpdatedAt: '', note: '' }];
  const retry = markLocalChanges(retryJobs, { committed: {}, pending: first.snapshot }, now + 60_000);
  assert.equal(retry.timestamped, 0);
  assert.equal(retryJobs[0].statusUpdatedAt, jobs[0].statusUpdatedAt);
});

test('reminders fire only on 7/3/1 calendar days and stale status uses elapsed days', () => {
  const now = new Date(2026, 7, 7, 12, 0, 0).getTime();
  const jobs = [
    { company: 'A', position: 'P', deadline: '2026/08/14', status: '未投递', statusUpdatedAt: '' },
    { company: 'B', position: 'P', deadline: '2026/08/13', status: '未投递', statusUpdatedAt: '' },
    { company: 'C', position: 'P', deadline: '2026/08/10', status: '未投递', statusUpdatedAt: '' },
    { company: 'D', position: 'P', deadline: '2026/08/08', status: '未投递', statusUpdatedAt: '' },
    { company: 'E', position: 'P', deadline: '招满为止', status: '已投递', statusUpdatedAt: new Date(now - 14 * 86400000).toISOString() },
  ];
  const reminders = buildReminders(jobs, now);
  assert.deepEqual(reminders.urgent.map(item => item.days), [1, 3, 7]);
  assert.equal(reminders.stale.length, 1);
});

test('server response validation rejects duplicates and bad status', () => {
  const now = Date.parse('2026-08-08T00:00:00Z');
  assert.throws(() => normalizeServerJobs([{ id: 'a', status: '未投递' }, { id: 'a', status: '未投递' }], now), /重复 id/);
  assert.throws(() => normalizeServerJobs([{ id: 'a', status: '未知' }], now), /非法状态/);
  const response = validatePushResponse({ ok: true, inserted: 0, updated: 0, stateTaken: 0, kept: 0, deleted: 0, received: 0, syncAt: '2026-08-07T00:00:00Z' }, now);
  assert.equal(response.syncAt, '2026-08-07T00:00:00.000Z');
});

test('reordered workbook is read by header name and preserves formatted numeric IDs', () => {
  const directory = tempDirectory();
  const file = path.join(directory, 'tracker.xlsx');
  try {
    const headers = COLUMNS.map(([, header]) => header).reverse();
    const map = new Map(headers.map((header, index) => [header, index]));
    const row = new Array(headers.length).fill('');
    row[map.get('_id')] = 7;
    row[map.get('公司名称')] = '测试公司';
    row[map.get('招聘岗位')] = '后端';
    row[map.get('投递状态')] = '未投递';
    row[map.get('截止时间')] = 46247;
    const worksheet = XLSX.utils.aoa_to_sheet([headers, row]);
    worksheet[XLSX.utils.encode_cell({ r: 1, c: map.get('_id') })].z = '0000';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '投递追踪');
    XLSX.writeFile(workbook, file);

    const context = readExcel(file, Date.parse('2026-08-08T00:00:00Z'));
    assert.equal(context.jobs.length, 1);
    assert.equal(context.jobs[0].id, '0007');
    assert.match(context.jobs[0].deadline, /^\d{4}\/\d{2}\/\d{2}$/);
  } finally {
    cleanup(directory);
  }
});

test('workbook replacement keeps a backup and aborts on concurrent modification', () => {
  const directory = tempDirectory();
  const file = path.join(directory, 'tracker.xlsx');
  try {
    const headers = COLUMNS.map(([, header]) => header);
    const row = new Array(headers.length).fill('');
    row[0] = 'job_1';
    row[13] = '未投递';
    const worksheet = XLSX.utils.aoa_to_sheet([headers, row]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '投递追踪');
    XLSX.writeFile(workbook, file);

    const context = readExcel(file, Date.parse('2026-08-08T00:00:00Z'));
    context.worksheet.B2 = { t: 's', v: '更新' };
    atomicWriteWorkbook(context.workbook, file, context.fingerprint);
    assert.equal(fs.existsSync(`${file}.bak`), true);
    assert.doesNotThrow(() => XLSX.readFile(file));

    const stale = readExcel(file, Date.parse('2026-08-08T00:00:00Z'));
    fs.appendFileSync(file, Buffer.from([0]));
    assert.throws(() => atomicWriteWorkbook(stale.workbook, file, stale.fingerprint), /同步期间已被修改/);
  } finally {
    cleanup(directory);
  }
});

test('inferred local timestamps and the final server winner are persisted before checkpoint commit', () => {
  const directory = tempDirectory();
  const file = path.join(directory, 'tracker.xlsx');
  const now = Date.parse('2026-08-08T02:00:00Z');
  try {
    const headers = COLUMNS.map(([, header]) => header);
    const index = new Map(headers.map((header, column) => [header, column]));
    const row = new Array(headers.length).fill('');
    row[index.get('_id')] = 'job_1';
    row[index.get('公司名称')] = '测试公司';
    row[index.get('投递状态')] = '已投递';
    const worksheet = XLSX.utils.aoa_to_sheet([headers, row]);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, '投递追踪');
    XLSX.writeFile(workbook, file);

    const context = readExcel(file, now);
    const changes = markLocalChanges(context.jobs, {
      committed: { job_1: { status: '未投递', appliedAt: '', statusUpdatedAt: '', note: '' } },
      pending: {},
    }, now);
    assert.equal(changes.timestamped, 1);
    const webChanges = [];
    const written = writeBackExcel(context, [
      { id: 'job_1', status: '已投递', appliedAt: context.jobs[0].appliedAt, statusUpdatedAt: context.jobs[0].statusUpdatedAt, note: '' },
    ], webChanges);
    assert.equal(written, 1);
    assert.equal(webChanges.length, 0);
    const persisted = readExcel(file, now + 1000).jobs[0];
    assert.equal(persisted.appliedAt, context.jobs[0].appliedAt);
    assert.equal(persisted.statusUpdatedAt, context.jobs[0].statusUpdatedAt);

    const newerServer = {
      id: 'job_1', status: '笔试', appliedAt: persisted.appliedAt,
      statusUpdatedAt: new Date(now + 1000).toISOString(), note: '网页更新',
    };
    const secondContext = readExcel(file, now + 2000);
    const secondWebChanges = [];
    assert.equal(writeBackExcel(secondContext, [newerServer], secondWebChanges), 1);
    assert.equal(secondWebChanges.length, 1);
    const finalCheckpoint = checkpointSnapshot(secondContext.jobs, new Date(now + 2000).toISOString());
    assert.equal(finalCheckpoint.job_1.status, '笔试');
    assert.equal(finalCheckpoint.job_1.note, '网页更新');
  } finally {
    cleanup(directory);
  }
});

test('configuration permits only credential-free HTTP(S) base URLs', () => {
  assert.deepEqual(validateConfig({ serverUrl: 'https://example.com/', syncToken: 'secret' }), { serverUrl: 'https://example.com', syncToken: 'secret' });
  assert.deepEqual(validateConfig({ serverUrl: 'http://localhost:3000', syncToken: 'secret' }), { serverUrl: 'http://localhost:3000', syncToken: 'secret' });
  assert.throws(() => validateConfig({ serverUrl: 'file:///tmp/data', syncToken: 'secret' }), /只允许 http/);
  assert.throws(() => validateConfig({ serverUrl: 'http://example.com', syncToken: 'secret' }), /必须使用 https/);
  assert.throws(() => validateConfig({ serverUrl: 'https://user:pass@example.com', syncToken: 'secret' }), /不能包含凭据/);
  assert.throws(() => validateConfig({ serverUrl: 'https://example.com', syncToken: '请改成随机token' }), /仍是示例值/);
});

test('exclusive sync lock prevents overlapping local writers and releases cleanly', () => {
  const directory = tempDirectory();
  const lockFile = path.join(directory, '.sync.lock');
  try {
    const release = acquireSyncLock(lockFile);
    assert.throws(() => acquireSyncLock(lockFile), /另一个同步进程正在运行/);
    release();
    const releaseAgain = acquireSyncLock(lockFile);
    releaseAgain();
    assert.equal(fs.existsSync(lockFile), false);
  } finally {
    cleanup(directory);
  }
});
