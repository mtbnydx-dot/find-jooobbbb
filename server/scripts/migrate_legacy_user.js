#!/usr/bin/env node
'use strict';

const { runLegacyMigration } = require('./product_maintenance');

function usage() {
  return `旧单用户 jobs.json -> 指定产品账号迁移工具

默认只做 dry-run；只有显式 --apply 才会先备份 product.db 再写入。

用法:
  node server/scripts/migrate_legacy_user.js \\
    --data-dir /opt/job-tracker/data \\
    --jobs-file /opt/job-tracker/data/jobs.json \\
    --email owner@example.com [--expect-user-id usr_xxx] [--apply] [--json]

必需:
  --data-dir       已初始化且含 product.db 的数据目录（无默认值）
  --jobs-file      要迁移的旧 jobs.json（无默认值）
  --email          明确的数据归属账号；账号必须已经存在

安全选项:
  --expect-user-id 同时校验账号 ID，防止选错同名/改名账号
  --apply          执行迁移；不提供时数据库以只读方式打开
  --json           输出机器可读 JSON
  --help           显示帮助
`;
}

function parseArgs(argv) {
  const result = { apply: false, json: false };
  const values = new Set(['data-dir', 'jobs-file', 'email', 'expect-user-id']);
  const flags = new Set(['apply', 'json', 'help']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`未知参数: ${token}`);
    const name = token.slice(2);
    if (flags.has(name)) {
      result[name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`未知参数: ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${token} 缺少值`);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (result[key] !== undefined) throw new Error(`${token} 重复`);
    result[key] = value;
  }
  return result;
}

function printHuman(result) {
  const changes = result.plan.states.insert + result.plan.states.update
    + result.plan.customSnapshots.insert + result.plan.customSnapshots.update;
  console.log(`模式: ${result.mode === 'dry-run' ? 'DRY-RUN（只读）' : 'APPLY'}`);
  console.log(`目标账号: ${result.target.email} (${result.target.id})`);
  console.log(`来源: ${result.source.jobsFile}`);
  console.log(`来源 SHA-256: ${result.source.sha256}`);
  console.log(`旧数据: 总岗位 ${result.legacy.totalJobs}，待迁状态 ${result.legacy.eligibleStates}，自选 ${result.legacy.customJobs}，备注 ${result.legacy.notes}`);
  console.log(`迁移前: 状态 ${result.before.total}，收藏 ${result.before.saved}，自选标记 ${result.before.favorite}，备注 ${result.before.notes}`);
  console.log(`计划: 状态新增 ${result.plan.states.insert} / 更新 ${result.plan.states.update} / 不变 ${result.plan.states.unchanged}`);
  console.log(`计划: 保留已有产品端状态 ${result.plan.preservedExistingStatuses}`);
  console.log(`计划: 自选快照新增 ${result.plan.customSnapshots.insert} / 更新 ${result.plan.customSnapshots.update} / 不变 ${result.plan.customSnapshots.unchanged}`);
  if (result.after) console.log(`迁移后: 状态 ${result.after.total}，收藏 ${result.after.saved}，自选标记 ${result.after.favorite}，备注 ${result.after.notes}`);
  if (result.backupPath) console.log(`数据库备份: ${result.backupPath}`);
  else if (result.mode === 'dry-run' && changes) console.log('数据库备份: --apply 时写入 data/backups/，备份成功后才开始事务');
  else console.log('数据库备份: 无写入，无需新备份');
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  for (const key of ['dataDir', 'jobsFile', 'email']) {
    if (!args[key]) throw new Error(`缺少 --${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`);
  }
  const result = runLegacyMigration(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`迁移失败: ${error.message}`);
    console.error('未完成任何已规划的迁移写入。先运行 --help，并在不带 --apply 时检查结果。');
    process.exitCode = 1;
  }
}

module.exports = {
  main,
  parseArgs,
  printHuman,
  usage,
};
