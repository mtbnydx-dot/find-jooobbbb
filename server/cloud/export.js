'use strict';

function buildJobsWorkbook(jobs, sources = [], runs = []) {
  const XLSX = require('xlsx');
  const workbook = XLSX.utils.book_new();
  const rows = jobs.map(job => ({
    ID: job.id,
    分类: job.classification || job.source || '',
    自选: job.isCustom === '1' || job.source === '自选' ? '是' : '',
    优先级: job.priority || '',
    匹配方向: job.matchDir || '',
    公司名称: job.company || '',
    企业性质: job.nature || '',
    行业大类: job.industry || '',
    招聘岗位: job.position || '',
    工作地点: job.location || '',
    截止时间: job.deadline || '',
    是否需要笔试: job.exam || '',
    投递方式: job.url || '',
    官方公告: job.notice || '',
    来源备注: job.sourceNote || '',
    信息源: (() => { try { return JSON.parse(job.origins || '[]').join('、'); } catch (_) { return job.origins || ''; } })(),
    投递状态: job.status || '未投递',
    投递日期: job.appliedAt || '',
    状态更新时间: job.statusUpdatedAt || '',
    个人备注: job.note || '',
    首次发现: job.firstSeenAt || '',
    最后发现: job.lastSeenAt || '',
    是否有效: job.active === '0' ? '否' : '是',
  }));
  const jobsSheet = XLSX.utils.json_to_sheet(rows);
  jobsSheet['!cols'] = [
    { wch: 28 }, { wch: 12 }, { wch: 8 }, { wch: 12 }, { wch: 30 }, { wch: 24 }, { wch: 14 }, { wch: 18 },
    { wch: 48 }, { wch: 24 }, { wch: 14 }, { wch: 14 }, { wch: 42 }, { wch: 42 }, { wch: 36 }, { wch: 24 },
    { wch: 12 }, { wch: 14 }, { wch: 24 }, { wch: 36 }, { wch: 24 }, { wch: 24 }, { wch: 10 },
  ];
  XLSX.utils.book_append_sheet(workbook, jobsSheet, '岗位');

  const sourceRows = sources.map(source => ({
    名称: source.name,
    类型: source.kind,
    链接: source.url,
    表格ID: source.tableId,
    Sheet: source.sheetName,
    计划: source.schedule,
    启用: source.enabled ? '是' : '否',
    最近运行: source.lastRunAt,
    最近状态: source.lastStatus,
    最近数量: source.lastCount,
    最近错误: source.lastError,
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(sourceRows), '信息源');

  const runRows = runs.map(run => ({
    ID: run.id,
    信息源: run.sourceName,
    触发: run.trigger,
    状态: run.status,
    开始: run.startedAt,
    完成: run.finishedAt,
    原始记录: run.fetchedCount,
    唯一岗位: run.canonicalCount,
    新增: run.insertedCount,
    更新: run.updatedCount,
    失效: run.inactiveCount,
    错误: run.error,
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(runRows), '运行记录');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildJobsWorkbook };
