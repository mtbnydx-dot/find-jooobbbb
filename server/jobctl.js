#!/usr/bin/env node
'use strict';

const base = String(process.env.JOBTRACKER_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const password = process.env.JOBTRACKER_PASSWORD || process.env.EDIT_PASSWORD || '';

function usage() {
  console.log(`jobctl - 秋招云端任务控制器

用法：
  jobctl doctor
  jobctl sources
  jobctl runs [数量]
  jobctl run <source-id>
  jobctl run-all
  jobctl daily-check
  jobctl research
  jobctl source-add --name 名称 --kind feishu --url URL [--table-id ID] [--sheet SHEET] [--schedule 10:00,22:00]

服务器要求密码时，通过 JOBTRACKER_PASSWORD（或 EDIT_PASSWORD）提供；未启用密码时可省略。`);
}

function flags(args) {
  const result = {};
  for (let index = 0; index < args.length; index++) {
    const token = args[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    result[key] = args[index + 1] && !args[index + 1].startsWith('--') ? args[++index] : true;
  }
  return result;
}

async function request(route, { method = 'GET', body = null } = {}) {
  const payload = body ? { ...body, ...(password ? { password } : {}) } : null;
  const response = await fetch(`${base}${route}`, {
    method,
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || ['help', '-h', '--help'].includes(command)) return usage();
  if (command === 'doctor') {
    const [health, overview] = await Promise.all([request('/api/health'), request('/api/cloud/overview')]);
    console.log(JSON.stringify({ url: base, health, overview }, null, 2));
    return;
  }
  if (command === 'sources') {
    console.table((await request('/api/cloud/sources')).sources.map(source => ({ id: source.id, name: source.name, kind: source.kind, enabled: source.enabled, schedule: source.schedule, status: source.lastStatus, count: source.lastCount })));
    return;
  }
  if (command === 'runs') {
    console.table((await request(`/api/cloud/runs?limit=${encodeURIComponent(args[0] || 20)}`)).runs.map(run => ({ id: run.id, source: run.sourceName, status: run.status, fetched: run.fetchedCount, canonical: run.canonicalCount, started: run.startedAt, error: run.error })));
    return;
  }
  if (command === 'run') {
    if (!args[0]) throw new Error('缺少 source-id');
    console.log(JSON.stringify(await request(`/api/cloud/sources/${encodeURIComponent(args[0])}/run`, { method: 'POST', body: {} }), null, 2));
    return;
  }
  if (command === 'run-all') {
    console.log(JSON.stringify(await request('/api/cloud/run-all', { method: 'POST', body: {} }), null, 2));
    return;
  }
  if (command === 'daily-check') {
    console.log(JSON.stringify(await request('/api/cloud/daily-check', { method: 'POST', body: {} }), null, 2));
    return;
  }
  if (command === 'research') {
    console.log(JSON.stringify(await request('/api/cloud/research', { method: 'POST', body: {} }), null, 2));
    return;
  }
  if (command === 'source-add') {
    const options = flags(args);
    const source = {
      name: options.name,
      kind: options.kind,
      url: options.url,
      tableId: options['table-id'] || '',
      sheetName: options.sheet || '',
      schedule: options.schedule || '10:00,22:00',
      authProfile: options['auth-profile'] || options.kind || 'default',
      enabled: true,
    };
    console.log(JSON.stringify(await request('/api/cloud/sources', { method: 'POST', body: source }), null, 2));
    return;
  }
  throw new Error(`未知命令：${command}`);
}

main().catch(error => {
  console.error(`jobctl: ${error.message}`);
  process.exitCode = 1;
});
