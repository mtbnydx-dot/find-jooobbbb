'use strict';

const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { hashPassword, verifyPassword } = require('../server/product/auth');
const { ProductPlatform } = require('../server/product/platform');
const { ProductStore } = require('../server/product/store');
const { runAdminBootstrap } = require('../server/scripts/product_admin');
const { runLegacyMigration } = require('../server/scripts/product_maintenance');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-product-maintenance-'));
}

function fileHash(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function createUser(dataDir, {
  id = 'usr_owner',
  email = 'owner@example.test',
  displayName = 'Owner',
  role = 'user',
} = {}) {
  const store = new ProductStore({ dataDir, clock: () => Date.parse('2026-08-30T00:00:00.000Z') }).initialize();
  const passwordHash = await hashPassword('owner-password');
  store.createUser({ id, email, displayName, role, passwordHash });
  store.close();
  return { id, email };
}

function writeLegacyJobs(file) {
  const payload = {
    jobs: [
      {
        id: 'custom_1', source: '自选', isCustom: '1', company: '自选公司', position: '自选岗位',
        status: '未投递', note: '自选备注', appliedAt: '', statusUpdatedAt: '2026-08-20T10:00:00+08:00',
      },
      {
        id: 'applied_1', source: '符合条件', company: '申请公司', position: '分析师',
        status: '已投递', note: '等待回复', appliedAt: '2026/08/21', statusUpdatedAt: '2026-08-21T12:30:00Z',
      },
      {
        id: 'noted_1', source: '可试试', company: '备注公司', position: '研究员',
        status: '未投递', note: '先准备作品集', appliedAt: '', statusUpdatedAt: '',
      },
      {
        id: 'clean_1', source: '符合条件', company: '无状态公司', position: '工程师',
        status: '未投递', note: '', appliedAt: '', statusUpdatedAt: '',
      },
    ],
    meta: { lastWebEditAt: '2026-08-22T00:00:00Z' },
  };
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
}

test('legacy migration is read-only by default, backs up on apply, and is idempotent', async () => {
  const dataDir = tempDir();
  try {
    const owner = await createUser(dataDir);
    const jobsFile = path.join(dataDir, 'jobs.json');
    writeLegacyJobs(jobsFile);
    const dbFile = path.join(dataDir, 'product.db');
    const beforeHash = fileHash(dbFile);

    const dryRun = runLegacyMigration({ dataDir, jobsFile, email: owner.email });
    assert.equal(dryRun.mode, 'dry-run');
    assert.deepEqual(dryRun.plan.states, { insert: 3, update: 0, unchanged: 0 });
    assert.deepEqual(dryRun.plan.customSnapshots, { insert: 1, update: 0, unchanged: 0 });
    assert.equal(dryRun.legacy.totalJobs, 4);
    assert.equal(dryRun.legacy.eligibleStates, 3);
    assert.equal(dryRun.backupPath, '');
    assert.equal(fileHash(dbFile), beforeHash);

    let db = new DatabaseSync(dbFile, { readOnly: true });
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM job_states WHERE user_id='usr_owner'").get().n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM user_custom_jobs").get().n, 0);
    db.close();

    const applied = runLegacyMigration({ dataDir, jobsFile, email: owner.email, expectUserId: owner.id, apply: true });
    assert.equal(applied.mode, 'apply');
    assert.ok(applied.backupPath);
    assert.ok(fs.existsSync(applied.backupPath));
    assert.equal(fs.readFileSync(applied.backupPath).subarray(0, 16).toString('ascii'), 'SQLite format 3\0');
    assert.equal(applied.after.total, 3);
    assert.equal(applied.after.notes, 3);

    db = new DatabaseSync(dbFile, { readOnly: true });
    const custom = db.prepare("SELECT * FROM job_states WHERE user_id='usr_owner' AND job_id='custom_1'").get();
    assert.equal(custom.status, 'saved');
    assert.equal(custom.saved, 1);
    assert.equal(custom.favorite, 1);
    assert.equal(custom.note, '自选备注');
    const appliedRow = db.prepare("SELECT * FROM job_states WHERE user_id='usr_owner' AND job_id='applied_1'").get();
    assert.equal(appliedRow.status, 'applied');
    assert.equal(appliedRow.applied_at, '2026-08-21');
    assert.equal(appliedRow.note, '等待回复');
    const noted = db.prepare("SELECT * FROM job_states WHERE user_id='usr_owner' AND job_id='noted_1'").get();
    assert.equal(noted.status, 'saved');
    assert.equal(noted.note, '先准备作品集');
    const customSnapshot = db.prepare("SELECT * FROM user_custom_jobs WHERE user_id='usr_owner' AND job_id='custom_1'").get();
    assert.equal(JSON.parse(customSnapshot.job_json).company, '自选公司');
    db.close();

    const platform = new ProductPlatform({ dataDir, jobService: { snapshot: () => ({ jobs: [] }) } }).initialize();
    const productOwner = platform.store.getUser(owner.id);
    const visibleCustom = platform.listJobs({ user: productOwner }).items.find(job => job.id === 'custom_1');
    assert.equal(visibleCustom.company, '自选公司');
    assert.equal(visibleCustom.userState.note, '自选备注');
    assert.equal(platform.listJobs({ user: null }).items.some(job => job.id === 'custom_1'), false);
    platform.close();

    const repeated = runLegacyMigration({ dataDir, jobsFile, email: owner.email, apply: true });
    assert.deepEqual(repeated.plan.states, { insert: 0, update: 0, unchanged: 3 });
    assert.deepEqual(repeated.plan.customSnapshots, { insert: 0, update: 0, unchanged: 1 });
    assert.equal(repeated.backupPath, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy migration refuses missing or mismatched target accounts without writing', async () => {
  const dataDir = tempDir();
  try {
    await createUser(dataDir);
    const jobsFile = path.join(dataDir, 'jobs.json');
    writeLegacyJobs(jobsFile);
    const dbFile = path.join(dataDir, 'product.db');
    const beforeHash = fileHash(dbFile);
    assert.throws(() => runLegacyMigration({ dataDir, jobsFile, email: 'missing@example.test', apply: true }), /指定账号不存在/);
    assert.throws(() => runLegacyMigration({ dataDir, jobsFile, email: 'owner@example.test', expectUserId: 'usr_wrong', apply: true }), /账号 ID 不匹配/);
    assert.equal(fileHash(dbFile), beforeHash);
    assert.equal(fs.existsSync(path.join(dataDir, 'backups')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('legacy migration preserves an existing product status while merging missing legacy note data', async () => {
  const dataDir = tempDir();
  try {
    const owner = await createUser(dataDir);
    const store = new ProductStore({ dataDir, clock: () => Date.parse('2026-08-30T12:00:00Z') }).initialize();
    store.updateJobState(owner.id, 'applied_1', {
      status: 'interview', saved: true, favorite: false, hidden: false,
      note: '产品端面试记录，正在等待回复相关事项', nextAction: '准备二面', appliedAt: '2026-08-22', followUpAt: '',
    });
    store.close();
    const jobsFile = path.join(dataDir, 'jobs.json');
    writeLegacyJobs(jobsFile);

    const applied = runLegacyMigration({ dataDir, jobsFile, email: owner.email, apply: true });
    assert.equal(applied.plan.preservedExistingStatuses, 1);
    const db = new DatabaseSync(path.join(dataDir, 'product.db'), { readOnly: true });
    const state = db.prepare("SELECT * FROM job_states WHERE user_id='usr_owner' AND job_id='applied_1'").get();
    assert.equal(state.status, 'interview');
    assert.equal(state.next_action, '准备二面');
    assert.equal(state.applied_at, '2026-08-22');
    assert.match(state.note, /产品端面试记录/);
    assert.equal(state.note.split(/\n{2,}/).includes('等待回复'), true);
    db.close();

    const repeated = runLegacyMigration({ dataDir, jobsFile, email: owner.email, apply: true });
    assert.equal(repeated.plan.states.update, 0);
    assert.equal(repeated.backupPath, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admin recovery requires configured email and matching token, stays dry-run by default, and repeats safely', async () => {
  const dataDir = tempDir();
  try {
    await createUser(dataDir, { email: 'admin@example.test' });
    const dbFile = path.join(dataDir, 'product.db');
    const env = {
      PRODUCT_ADMIN_EMAILS: 'admin@example.test',
      PRODUCT_BOOTSTRAP_TOKEN: 'bootstrap-token-123456',
      PRODUCT_BOOTSTRAP_TOKEN_CONFIRM: 'bootstrap-token-123456',
    };
    const beforeHash = fileHash(dbFile);
    const dryRun = await runAdminBootstrap({ dataDir, email: 'admin@example.test', env });
    assert.equal(dryRun.mode, 'dry-run');
    assert.equal(dryRun.action, 'restore-role');
    assert.equal(dryRun.before.role, 'user');
    assert.equal(fileHash(dbFile), beforeHash);

    await assert.rejects(() => runAdminBootstrap({
      dataDir,
      email: 'admin@example.test',
      env: { ...env, PRODUCT_BOOTSTRAP_TOKEN_CONFIRM: 'wrong-token-1234567' },
      apply: true,
    }), /不匹配/);
    await assert.rejects(() => runAdminBootstrap({
      dataDir,
      email: 'other@example.test',
      env,
      apply: true,
    }), /不在 PRODUCT_ADMIN_EMAILS/);

    const applied = await runAdminBootstrap({ dataDir, email: 'admin@example.test', env, apply: true });
    assert.equal(applied.after.role, 'admin');
    assert.ok(fs.existsSync(applied.backupPath));

    const repeated = await runAdminBootstrap({ dataDir, email: 'admin@example.test', env, apply: true });
    assert.equal(repeated.action, 'unchanged');
    assert.equal(repeated.backupPath, '');
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('admin bootstrap can explicitly create a configured account with its free plan', async () => {
  const dataDir = tempDir();
  try {
    await createUser(dataDir);
    const env = {
      PRODUCT_ADMIN_EMAILS: 'new-admin@example.test',
      PRODUCT_BOOTSTRAP_TOKEN: 'bootstrap-token-123456',
      PRODUCT_BOOTSTRAP_TOKEN_CONFIRM: 'bootstrap-token-123456',
      PRODUCT_ADMIN_PASSWORD: 'new-admin-password',
    };
    const dryRun = await runAdminBootstrap({ dataDir, email: 'new-admin@example.test', env, create: true });
    assert.equal(dryRun.action, 'create');
    assert.equal(dryRun.after, null);

    const applied = await runAdminBootstrap({
      dataDir,
      email: 'new-admin@example.test',
      displayName: 'New Admin',
      env,
      create: true,
      apply: true,
    });
    assert.equal(applied.after.role, 'admin');
    assert.equal(applied.after.displayName, 'New Admin');
    assert.ok(fs.existsSync(applied.backupPath));

    const db = new DatabaseSync(path.join(dataDir, 'product.db'), { readOnly: true });
    const row = db.prepare("SELECT u.password_hash,s.plan_id,s.source FROM users u JOIN subscriptions s ON s.user_id=u.id WHERE u.email='new-admin@example.test'").get();
    assert.equal(row.plan_id, 'free');
    assert.equal(row.source, 'bootstrap-cli');
    assert.equal(await verifyPassword('new-admin-password', row.password_hash), true);
    db.close();
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
