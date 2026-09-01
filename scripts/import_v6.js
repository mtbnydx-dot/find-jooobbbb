/* 一次性导入：把 2027届秋招岗位表_v6.xlsx 的「全部岗位总表」+「可试试」合并推送到服务器
 * 用法: node scripts/import_v6.js
 * 幂等：重复跑同 id 会覆盖信息字段，状态字段按服务器时间戳保留（不会被重置）
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'job-sync', 'local', 'config.json');
const EXCEL_PATH = path.join(ROOT, '2027届秋招岗位表_v6.xlsx');
const FETCH_TIMEOUT_MS = 60_000;

/* 隧道断了自动重建（config.json 配了 tunnel 字段时） */
async function ensureTunnel(config) {
  const probe = `${config.serverUrl}/api/health`;
  try {
    const r = await fetch(probe, { signal: AbortSignal.timeout(4000) });
    if (r.ok) return true;
  } catch (_) { /* 隧道断了 */ }
  if (!config.tunnel) return false;
  console.log('检测到同步通道断开，正在重建 SSH 隧道…');
  try {
    const { spawn } = require('child_process');
    const args = ['-f', '-N', '-L', config.tunnel.local, '-i', config.tunnel.key, '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=10', config.tunnel.ssh];
    const child = spawn('ssh', args, { stdio: 'ignore', shell: false });
    child.unref();
    await new Promise(r => setTimeout(r, 2500));
    const r2 = await fetch(probe, { signal: AbortSignal.timeout(4000) });
    if (r2.ok) { console.log('隧道重建成功。'); return true; }
  } catch (_) { /* 重建失败 */ }
  return false;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`缺少配置文件: ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

function scalarText(v) { return v == null ? '' : String(v).trim(); }
// 服务器字段限制 position<=2000 字节，超长截断（历史经验：东营城建一行 2441B）
function clampBytes(s, max = 2000) {
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = s;
  while (Buffer.byteLength(out + '…', 'utf8') > max) out = out.slice(0, -1);
  return out + '…';
}
function makeId(company, position, source) {
  const h = crypto.createHash('sha1').update(`${source}|${company}|${position}`).digest('hex').slice(0, 10);
  return `v6-${h}`;
}

function readSheet(XLSX, wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function rowToJob(row, source) {
  // 三个 sheet 列结构不同，按各自表头映射：
  // 符合条件(15列): [优先级, 匹配方向, 公司名称, 企业性质, 行业大类, 批次, 招聘对象, 工作地点, 招聘岗位, 更新时间, 截止时间, 是否需要笔试, 投递方式, 官方公告, 备注/提示]
  // 可试试(15列):   [匹配方向, 说明, 公司名称, 企业性质, 行业大类, 批次, 招聘对象, 工作地点, 招聘岗位, 更新时间, 截止时间, 是否需要笔试, 投递方式, 官方公告, 备注/提示]
  // 全部岗位(14列): [筛选状态, 公司名称, 企业性质, 行业大类, 批次, 招聘对象, 工作地点, 招聘岗位, 更新时间, 截止时间, 是否需要笔试, 投递方式, 官方公告, 备注/提示]
  const a = row.map(scalarText);
  let company, position, location, deadline, exam, url, notice, nature, industry, matchDir, priority, note;
  if (source === '符合条件') {
    [priority, matchDir, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    note = a[14] || '';
  } else if (source === '可试试') {
    [matchDir, note, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    priority = '';
  } else { // 全部岗位
    [note, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    matchDir = '';
    priority = '';
  }
  if (!company || !position) return null;
  return {
    id: makeId(company, position, source),
    source,
    priority: priority || '',
    matchDir: matchDir || '',
    company,
    nature: nature || '',
    industry: industry || '',
    position: clampBytes(position),
    location: clampBytes(location || '', 1000),
    deadline: deadline || '',
    exam: exam || '',
    url: url || '',
    notice: notice || '',
    ddlRemind: '',
    status: '未投递',
    appliedAt: '',
    statusUpdatedAt: '',
    note: note || '',
  };
}

async function postJson(url, body, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error(`响应不是 JSON: ${text.slice(0, 120)}`); }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${data.error || text.slice(0, 120)}`);
    return data;
  } finally { clearTimeout(timer); }
}

async function main() {
  const XLSX = require('xlsx');
  if (!fs.existsSync(EXCEL_PATH)) throw new Error(`找不到岗位表: ${EXCEL_PATH}`);
  const config = loadConfig();
  const wb = XLSX.readFile(EXCEL_PATH);

  const jobs = [];
  const seen = new Set();
  const push = (rows, source) => {
    for (const row of rows) {
      const job = rowToJob(row, source);
      if (!job || seen.has(job.id)) continue;
      seen.add(job.id);
      jobs.push(job);
    }
  };
  push(readSheet(XLSX, wb, '符合条件的岗位').slice(1), '符合条件');
  push(readSheet(XLSX, wb, '可试试(混合招聘非技术岗)').slice(1), '可试试');
  push(readSheet(XLSX, wb, '全部岗位总表').slice(1), '全部岗位');

  console.log(`解析出 ${jobs.length} 条岗位（符合条件/可试试/全部岗位合并去重）`);
  const counts = jobs.reduce((acc, j) => { acc[j.source] = (acc[j.source] || 0) + 1; return acc; }, {});
  console.log('分布:', counts);

  if (!(await ensureTunnel(config))) {
    throw new Error('同步通道不可用（服务器不可达且隧道重建失败）');
  }
  const url = `${config.serverUrl}/api/sync`;
  console.log(`推送到 ${url} ...`);
  const res = await postJson(url, { jobs, syncAt: new Date().toISOString() }, config.syncToken);
  console.log('推送结果:', JSON.stringify(res));
  console.log('完成。服务器上全部岗位已导入（含符合条件/可试试/全部岗位），自选与状态不受影响。');
}

main().catch(err => { console.error('导入失败:', err.message); process.exit(1); });
