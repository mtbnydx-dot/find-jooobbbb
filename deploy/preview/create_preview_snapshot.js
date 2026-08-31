#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function fail(message) {
  throw new Error(message);
}

const sourceDir = path.resolve(process.argv[2] || '');
const targetDir = path.resolve(process.argv[3] || '');
if (!process.argv[2] || !process.argv[3]) fail('用法: create_preview_snapshot.js SOURCE_DATA_DIR TARGET_DATA_DIR');
if (sourceDir === targetDir) fail('来源与目标数据目录不能相同');

const sourceJobs = path.join(sourceDir, 'jobs.json');
const sourceCloud = path.join(sourceDir, 'cloud.db');
const targetJobs = path.join(targetDir, 'jobs.json');
const targetCloud = path.join(targetDir, 'cloud.db');
if (!fs.existsSync(sourceJobs) || !fs.existsSync(sourceCloud)) fail('来源目录缺少 jobs.json 或 cloud.db');
if (fs.existsSync(targetJobs) || fs.existsSync(targetCloud)) fail('目标快照已存在；本工具不会覆盖');

fs.mkdirSync(targetDir, { recursive: true });
const jobsTemporary = `${targetJobs}.tmp-${process.pid}`;
fs.copyFileSync(sourceJobs, jobsTemporary, fs.constants.COPYFILE_EXCL);
fs.renameSync(jobsTemporary, targetJobs);

const source = new DatabaseSync(sourceCloud);
try {
  source.exec(`VACUUM INTO ${sqlString(targetCloud)}`);
} finally {
  source.close();
}

const preview = new DatabaseSync(targetCloud);
try {
  preview.exec('PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;');
  const settings = preview.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_settings'").get();
  if (settings) preview.exec("UPDATE ai_settings SET enabled=0,api_key='',auto_run=0");
  const running = preview.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").get();
  if (running) preview.exec("UPDATE runs SET status='failed',finished_at=datetime('now'),error='预览快照已中止原运行任务' WHERE status IN ('queued','running')");
  const aiRunning = preview.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ai_runs'").get();
  if (aiRunning) preview.exec("UPDATE ai_runs SET status='failed',finished_at=datetime('now'),error='预览快照已中止原 AI 任务' WHERE status IN ('queued','running')");
  preview.exec('PRAGMA wal_checkpoint(TRUNCATE);');
} finally {
  preview.close();
}

const jobs = JSON.parse(fs.readFileSync(targetJobs, 'utf8'));
const total = Array.isArray(jobs) ? jobs.length : Array.isArray(jobs.jobs) ? jobs.jobs.length : 0;
process.stdout.write(JSON.stringify({ ok: true, sourceDir, targetDir, jobs: total, aiCredentialsCopied: false }) + '\n');
