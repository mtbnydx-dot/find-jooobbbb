'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');

test('preview installer provisions and reports an independent AI edit password', () => {
  const installer = fs.readFileSync(path.resolve(__dirname, '..', 'deploy', 'preview', 'install_preview.sh'), 'utf8');
  assert.match(installer, /AI_EDIT_PASSWORD=\$ai_edit_password/);
  assert.match(installer, /PREVIEW_AI_EDIT_PASSWORD/);
  assert.match(installer, /job-tracker-preview\.env/);
});

test('preview snapshot is consistent and removes copied AI credentials', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-preview-snapshot-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(sourceDir);
  fs.writeFileSync(path.join(sourceDir, 'jobs.json'), JSON.stringify([{ id: 'job-1' }]));

  const source = new DatabaseSync(path.join(sourceDir, 'cloud.db'));
  source.exec(`
    CREATE TABLE ai_settings(id INTEGER PRIMARY KEY,enabled INTEGER,api_key TEXT,auto_run INTEGER);
    INSERT INTO ai_settings VALUES(1,1,'must-not-leave-production',1);
    CREATE TABLE runs(id INTEGER PRIMARY KEY,status TEXT,finished_at TEXT,error TEXT);
    INSERT INTO runs VALUES(1,'running',NULL,'');
    CREATE TABLE ai_runs(id INTEGER PRIMARY KEY,status TEXT,finished_at TEXT,error TEXT);
    INSERT INTO ai_runs VALUES(1,'queued',NULL,'');
  `);
  source.close();

  const helper = path.resolve(__dirname, '..', 'deploy', 'preview', 'create_preview_snapshot.js');
  const result = spawnSync(process.execPath, [helper, sourceDir, targetDir], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(targetDir, 'jobs.json'), 'utf8')), [{ id: 'job-1' }]);

  const preview = new DatabaseSync(path.join(targetDir, 'cloud.db'), { readOnly: true });
  try {
    const settings = preview.prepare('SELECT enabled,api_key,auto_run FROM ai_settings').get();
    assert.equal(settings.enabled, 0);
    assert.equal(settings.api_key, '');
    assert.equal(settings.auto_run, 0);
    assert.equal(preview.prepare('SELECT status FROM runs').get().status, 'failed');
    assert.equal(preview.prepare('SELECT status FROM ai_runs').get().status, 'failed');
  } finally {
    preview.close();
  }
});

test('preview snapshot refuses to overwrite an existing target', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'job-preview-existing-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sourceDir = path.join(root, 'source');
  const targetDir = path.join(root, 'target');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(sourceDir, 'jobs.json'), '[]');
  fs.writeFileSync(path.join(targetDir, 'jobs.json'), 'keep');
  const source = new DatabaseSync(path.join(sourceDir, 'cloud.db'));
  source.close();

  const helper = path.resolve(__dirname, '..', 'deploy', 'preview', 'create_preview_snapshot.js');
  const result = spawnSync(process.execPath, [helper, sourceDir, targetDir], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.readFileSync(path.join(targetDir, 'jobs.json'), 'utf8'), 'keep');
});
