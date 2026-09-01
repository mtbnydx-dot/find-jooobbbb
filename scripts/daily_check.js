// 秋招每日检查：DDL 提醒（剩 7/3/1 天）+ 停滞提醒（状态更新 >= 14 天）
// 用法: node job-sync/scripts/daily_check.js
const fs = require('fs');
const path = require('path');

const data = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'jobs_check.json'), 'utf8'));
const jobs = data.jobs || data;

const NOW = new Date();
const today = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
const daysDiff = (dateStr) => {
  const m = /(\d{4})[.\-\/年](\d{1,2})[.\-\/月](\d{1,2})日?/.exec(dateStr);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    const m2 = /(\d{1,2})[.\-\/月](\d{1,2})日?/.exec(dateStr);
    if (m2) { y = NOW.getFullYear(); mo = +m2[1]; d = +m2[2]; }
    else return null;
  }
  const dt = new Date(y, mo - 1, d);
  return Math.round((dt - today) / 86400000);
};

// ---------- DDL 提醒 ----------
const ddlJobs = jobs.filter(j => {
  if (!['符合条件', '可试试'].includes(j.source)) return false;
  if (j.status !== '未投递') return false;
  const dd = daysDiff(j.deadline);
  return dd !== null && [1, 3, 7].includes(dd);
}).sort((a, b) => daysDiff(a.deadline) - daysDiff(b.deadline));

console.log('=== DDL 提醒（符合条件/可试试 + 未投递 + 剩 7/3/1 天）===');
if (ddlJobs.length === 0) console.log('今日无紧急截止');
ddlJobs.forEach(j => console.log(`${j.company} | ${j.position} | 剩 ${daysDiff(j.deadline)} 天（截止 ${j.deadline}）`));

// ---------- 停滞提醒 ----------
const STALL_STATUS = ['已投递', '笔试', '一面', '二面'];
const stallJobs = jobs.filter(j => {
  if (!STALL_STATUS.includes(j.status)) return false;
  if (!j.statusUpdatedAt) return false;
  const upd = new Date(j.statusUpdatedAt);
  if (isNaN(upd)) return false;
  const days = Math.floor((today - upd) / 86400000);
  return days >= 14;
}).sort((a, b) => {
  const da = (today - new Date(a.statusUpdatedAt)) / 86400000;
  const db = (today - new Date(b.statusUpdatedAt)) / 86400000;
  return db - da;
});

console.log('\n=== 停滞提醒（已投递/笔试/一面/二面 + 状态更新 >= 14 天）===');
if (stallJobs.length === 0) console.log('无停滞');
stallJobs.forEach(j => {
  const days = Math.floor((today - new Date(j.statusUpdatedAt)) / 86400000);
  console.log(`${j.company} | ${j.position} | 已停 ${days} 天（状态:${j.status}，更新于 ${j.statusUpdatedAt}）`);
});

// 附注：全部岗位池 3 天内截止（仅供参考）
console.log('\n=== 附注：全部岗位池 3 天内截止（参考）===');
const allSoon = jobs.filter(j => {
  const dd = daysDiff(j.deadline);
  return dd !== null && dd >= 0 && dd <= 3;
}).sort((a, b) => daysDiff(a.deadline) - daysDiff(b.deadline));
if (allSoon.length === 0) console.log('无');
allSoon.forEach(j => console.log(`[${j.source}] ${j.company} | ${j.position} | 剩 ${daysDiff(j.deadline)} 天`));
