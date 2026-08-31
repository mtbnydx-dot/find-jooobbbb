#!/usr/bin/env node
'use strict';

const { normalizeEmail, hashPassword, randomId } = require('../product/auth');
const {
  backupDatabase,
  backupPathFor,
  configuredBootstrapRole,
  dataVersion,
  equalSecret,
  openExistingProductDb,
} = require('./product_maintenance');

function usage() {
  return `产品管理员/内容编辑引导与角色恢复工具

默认只做 dry-run。角色由 PRODUCT_ADMIN_EMAILS / PRODUCT_CONTENT_EDITOR_EMAILS 决定，
不能通过命令行任意指定。配置令牌还必须与另一个环境变量中的确认值一致。

检查或恢复现有账号:
  PRODUCT_BOOTSTRAP_TOKEN='configured-token' \\
  PRODUCT_BOOTSTRAP_TOKEN_CONFIRM='configured-token' \\
  PRODUCT_ADMIN_EMAILS='admin@example.com' \\
  node server/scripts/product_admin.js \\
    --data-dir /opt/job-tracker/data --email admin@example.com [--apply]

首次创建（仅当账号不存在，额外要求 --create 和密码环境变量）:
  PRODUCT_ADMIN_PASSWORD='initial-password' ... \\
  node server/scripts/product_admin.js \\
    --data-dir /opt/job-tracker/data --email admin@example.com \\
    --create --password-env PRODUCT_ADMIN_PASSWORD --display-name Admin --apply

选项:
  --data-dir       已初始化且含 product.db 的数据目录（必需，无默认值）
  --email          必须出现在配置邮箱列表中的精确邮箱（必需）
  --token-env      令牌确认环境变量名，默认 PRODUCT_BOOTSTRAP_TOKEN_CONFIRM
  --create         账号不存在时允许创建；不提供时只允许恢复现有账号
  --password-env   首次创建时读取密码的环境变量名，默认 PRODUCT_ADMIN_PASSWORD
  --display-name   首次创建时的显示名
  --apply          先备份数据库再执行；不提供时数据库只读
  --json           输出机器可读 JSON
  --help           显示帮助
`;
}

function parseArgs(argv) {
  const result = {
    apply: false,
    create: false,
    json: false,
    tokenEnv: 'PRODUCT_BOOTSTRAP_TOKEN_CONFIRM',
    passwordEnv: 'PRODUCT_ADMIN_PASSWORD',
  };
  const values = new Set(['data-dir', 'email', 'token-env', 'password-env', 'display-name']);
  const flags = new Set(['apply', 'create', 'json', 'help']);
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new Error(`未知参数: ${token}`);
    const name = token.slice(2);
    const key = name.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (flags.has(name)) {
      result[key] = true;
      continue;
    }
    if (!values.has(name)) throw new Error(`未知参数: ${token}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`${token} 缺少值`);
    result[key] = value;
  }
  return result;
}

function envName(value, field) {
  const name = String(value || '');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${field} 不是有效环境变量名`);
  return name;
}

function validateBootstrap(emailValue, tokenEnv, env) {
  const email = normalizeEmail(emailValue);
  const role = configuredBootstrapRole(email, env);
  const configured = String(env.PRODUCT_BOOTSTRAP_TOKEN || '');
  const confirmationName = envName(tokenEnv, '--token-env');
  const confirmation = String(env[confirmationName] || '');
  if (configured.length < 16) throw new Error('PRODUCT_BOOTSTRAP_TOKEN 未配置或长度不足 16 个字符');
  if (!equalSecret(configured, confirmation)) {
    throw new Error(`${confirmationName} 与 PRODUCT_BOOTSTRAP_TOKEN 不匹配`);
  }
  return { email, role, confirmationName };
}

function findAnyUser(db, email) {
  const row = db.prepare('SELECT id,email,display_name,role,status FROM users WHERE email=? COLLATE NOCASE').get(email);
  return row ? {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
  } : null;
}

async function runAdminBootstrap({
  dataDir,
  email,
  tokenEnv = 'PRODUCT_BOOTSTRAP_TOKEN_CONFIRM',
  passwordEnv = 'PRODUCT_ADMIN_PASSWORD',
  displayName = '',
  create = false,
  apply = false,
  env = process.env,
  now = Date.now,
} = {}) {
  if (!dataDir) throw new Error('必须显式指定 --data-dir，工具不会猜测数据目录');
  const eligibility = validateBootstrap(email, tokenEnv, env);
  const opened = openExistingProductDb(dataDir, { readOnly: !apply });
  try {
    let user = findAnyUser(opened.db, eligibility.email);
    if (user?.status === 'deleted') throw new Error('账号已标记删除；本工具不会自动恢复已删除账号');
    if (!user && !create) throw new Error('账号不存在；如需首次引导，请核对邮箱后显式增加 --create');
    const action = !user ? 'create' : user.role === eligibility.role ? 'unchanged' : 'restore-role';
    const base = {
      ok: true,
      mode: apply ? 'apply' : 'dry-run',
      email: eligibility.email,
      configuredRole: eligibility.role,
      tokenConfirmationEnv: eligibility.confirmationName,
      action,
      before: user,
      after: user,
      backupPath: '',
    };
    if (!apply || action === 'unchanged') return base;

    let createInput = null;
    if (action === 'create') {
      const passwordName = envName(passwordEnv, '--password-env');
      const password = String(env[passwordName] || '');
      if (!password) throw new Error(`${passwordName} 未设置；首次创建的密码不会从命令行读取`);
      const requiredTables = ['profiles', 'subscriptions', 'plans'];
      for (const table of requiredTables) {
        if (!opened.tables.has(table)) throw new Error(`product.db 缺少 ${table} 表，不能创建完整账号`);
      }
      if (!opened.db.prepare("SELECT 1 FROM plans WHERE id='free'").get()) throw new Error('product.db 缺少 free 套餐');
      const name = String(displayName || eligibility.email.split('@')[0]).trim();
      if (!name || name.length > 80 || name.includes('\0')) throw new Error('--display-name 格式非法或过长');
      createInput = {
        id: randomId('usr'),
        name,
        passwordHash: await hashPassword(password),
      };
    }

    const beforeBackupVersion = dataVersion(opened.db);
    const backupPath = backupPathFor(opened.file, 'product-admin', now());
    backupDatabase(opened.db, opened.file, backupPath);
    const timestamp = new Date(now()).toISOString();
    opened.db.exec('BEGIN IMMEDIATE');
    try {
      if (dataVersion(opened.db) !== beforeBackupVersion) {
        throw new Error(`product.db 在备份期间被其他进程修改，操作已中止；备份保留在 ${backupPath}`);
      }
      if (action === 'restore-role') {
        const changed = opened.db.prepare('UPDATE users SET role=?,updated_at=? WHERE id=? AND status<>\'deleted\'')
          .run(eligibility.role, timestamp, user.id).changes;
        if (changed !== 1) throw new Error('账号在执行期间发生变化，角色恢复已中止');
      } else {
        opened.db.prepare("INSERT INTO users(id,email,password_hash,display_name,role,status,created_at,updated_at) VALUES(?,?,?,?,?,'active',?,?)")
          .run(createInput.id, eligibility.email, createInput.passwordHash, createInput.name, eligibility.role, timestamp, timestamp);
        opened.db.prepare('INSERT INTO profiles(user_id,profile_hash,updated_at) VALUES(?,?,?)').run(createInput.id, '', timestamp);
        opened.db.prepare("INSERT INTO subscriptions(user_id,plan_id,status,source,current_period_start,updated_at) VALUES(?,'free','active','bootstrap-cli',?,?)")
          .run(createInput.id, timestamp, timestamp);
      }
      opened.db.exec('COMMIT');
    } catch (error) {
      try { opened.db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
      throw error;
    }
    user = findAnyUser(opened.db, eligibility.email);
    return { ...base, after: user, backupPath };
  } finally {
    opened.db.close();
  }
}

function printHuman(result) {
  console.log(`模式: ${result.mode === 'dry-run' ? 'DRY-RUN（只读）' : 'APPLY'}`);
  console.log(`账号: ${result.email}`);
  console.log(`配置角色: ${result.configuredRole}`);
  console.log(`计划: ${result.action}`);
  if (result.before) console.log(`执行前: ${result.before.role} / ${result.before.status} / ${result.before.id}`);
  else console.log('执行前: 账号不存在');
  if (result.mode === 'apply') console.log(`执行后: ${result.after.role} / ${result.after.status} / ${result.after.id}`);
  if (result.backupPath) console.log(`数据库备份: ${result.backupPath}`);
  else console.log(result.action === 'unchanged' ? '数据库备份: 无写入，无需新备份' : '数据库备份: --apply 时先写入 data/backups/');
}

async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(usage());
    return 0;
  }
  if (!args.dataDir) throw new Error('缺少 --data-dir');
  if (!args.email) throw new Error('缺少 --email');
  const result = await runAdminBootstrap({ ...args, env });
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHuman(result);
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(error => {
    console.error(`管理员引导/恢复失败: ${error.message}`);
    console.error('未执行已规划的角色或账号写入。请先使用默认 dry-run 检查邮箱与数据目录。');
    process.exitCode = 1;
  });
}

module.exports = {
  main,
  parseArgs,
  runAdminBootstrap,
  usage,
  validateBootstrap,
};
