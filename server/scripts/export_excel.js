/* 服务器端 Excel 备份导出：把 jobs.json 当前状态导出为 Excel
 * 用法: node scripts/export_excel.js [输出路径]
 * 定时: crontab 每日运行（见 deploy/setup_cron.py）
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const JOBS_FILE = path.join(DATA_DIR, 'jobs.json');
const OUT_PATH = process.argv[2] || path.join(DATA_DIR, 'jobs-backup.xlsx');

const COLUMNS = [
  ['id', '_id'], ['source', '来源'], ['priority', '优先级'], ['matchDir', '匹配方向'],
  ['company', '公司名称'], ['nature', '企业性质'], ['industry', '行业大类'],
  ['position', '招聘岗位'], ['location', '工作地点'], ['deadline', '截止时间'],
  ['exam', '是否需要笔试'], ['url', '投递方式'], ['notice', '官方公告'],
  ['status', '投递状态'], ['appliedAt', '投递日期'], ['statusUpdatedAt', '状态更新时间'],
  ['note', '备注'], ['ddlRemind', 'DDL提醒'],
];

function main() {
  if (!fs.existsSync(JOBS_FILE)) { console.error('无数据文件:', JOBS_FILE); process.exit(1); }
  const store = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8'));
  const jobs = store.jobs || [];
  const XLSX = require('xlsx');
  const ws = XLSX.utils.json_to_sheet(
    jobs.map(j => {
      const row = {};
      for (const [key, header] of COLUMNS) row[header] = j[key] != null ? String(j[key]) : '';
      return row;
    }),
    { header: COLUMNS.map(([, h]) => h) }
  );
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '投递追踪');
  const tmp = OUT_PATH.replace(/\.xlsx$/i, '') + '.tmp.xlsx';
  XLSX.writeFile(wb, tmp, { bookType: 'xlsx' });
  fs.renameSync(tmp, OUT_PATH);
  console.log(`导出 ${jobs.length} 条 -> ${OUT_PATH}`);
}

main();
