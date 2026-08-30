/* 分批推送版本：数据量增长后单次 POST 超过服务器 body 限制(413)，改为每批 800 条分次推送 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = path.join(ROOT, 'job-sync', 'local', 'config.json');
const EXCEL_PATH = path.join(ROOT, '2027届秋招岗位表_v6.xlsx');
const FETCH_TIMEOUT_MS = 60_000;
const CHUNK = 800;

async function ensureTunnel(config) {
  const probe = `${config.serverUrl}/api/health`;
  try { const r = await fetch(probe, { signal: AbortSignal.timeout(4000) }); if (r.ok) return true; } catch (_) {}
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
  } catch (_) {}
  return false;
}
function scalarText(v) { return v == null ? '' : String(v).trim(); }
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
  const a = row.map(scalarText);
  let company, position, location, deadline, exam, url, notice, nature, industry, matchDir, priority, note;
  if (source === '符合条件') {
    [priority, matchDir, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    note = a[14] || '';
  } else if (source === '可试试') {
    [matchDir, note, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    priority = '';
  } else {
    [note, company, nature, industry, , , location, position, , deadline, exam, url, notice] = a;
    matchDir = ''; priority = '';
  }
  if (!company || !position) return null;
  return { id: makeId(company, position, source), source, priority: priority || '', matchDir: matchDir || '', company, nature: nature || '', industry: industry || '', position, location: location || '', deadline: deadline || '', exam: exam || '', url: url || '', notice: notice || '', ddlRemind: '', status: '未投递', appliedAt: '', statusUpdatedAt: '', note: note || '' };
}
async function postJson(url, body, token) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await r.text();
    let data; try { data = JSON.parse(text); } catch { throw new Error(`响应不是 JSON: ${text.slice(0, 120)}`); }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${data.error || text.slice(0, 120)}`);
    return data;
  } finally { clearTimeout(timer); }
}
async function main() {
  const XLSX = require('xlsx');
  if (!fs.existsSync(EXCEL_PATH)) throw new Error(`找不到岗位表: ${EXCEL_PATH}`);
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const wb = XLSX.readFile(EXCEL_PATH);
  const jobs = []; const seen = new Set();
  const push = (rows, source) => {
    for (const row of rows) {
      const job = rowToJob(row, source);
      if (!job || seen.has(job.id)) continue;
      seen.add(job.id); jobs.push(job);
    }
  };
  push(readSheet(XLSX, wb, '符合条件的岗位').slice(1), '符合条件');
  push(readSheet(XLSX, wb, '可试试(混合招聘非技术岗)').slice(1), '可试试');
  push(readSheet(XLSX, wb, '全部岗位总表').slice(1), '全部岗位');
  console.log(`解析出 ${jobs.length} 条岗位`);
  if (!(await ensureTunnel(config))) throw new Error('同步通道不可用（服务器不可达且隧道重建失败）');
  const url = `${config.serverUrl}/api/sync`;
  const totals = { received: 0, inserted: 0, updated: 0, kept: 0 };
  for (let i = 0; i < jobs.length; i += CHUNK) {
    const chunk = jobs.slice(i, i + CHUNK);
    const res = await postJson(url, { jobs: chunk, syncAt: new Date().toISOString() }, config.syncToken);
    console.log(`批次 ${Math.floor(i / CHUNK) + 1}/${Math.ceil(jobs.length / CHUNK)}: ${chunk.length} 条 ->`, JSON.stringify(res));
    for (const k of Object.keys(totals)) if (typeof res[k] === 'number') totals[k] += res[k];
  }
  console.log('合计:', JSON.stringify(totals));
  console.log('完成。');
}
main().catch(err => { console.error('导入失败:', err.message); process.exit(1); });
