'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { CloudStore } = require('../server/cloud/store');
const { classifyRecords } = require('../server/cloud/classifier');
const { CloudRuntime, daysUntil } = require('../server/cloud/runtime');
const { parseTabSeparated, recordsFromTencentGrid, stabilizeTencentRecords, parseDuckDuckGoHtml, parseBingRss } = require('../server/cloud/adapters');
const { createService, createApp } = require('../server/server');

const FIXED_NOW = Date.parse('2026-08-25T00:00:00.000Z');

function tempDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'job-cloud-'));
}

function cleanup(directory) {
  assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir())), 'refuse to clean outside temp');
  fs.rmSync(directory, { recursive: true, force: true });
}

function sourceInput(overrides = {}) {
  return {
    name: '测试岗位表',
    kind: 'json',
    url: 'https://example.com/jobs.json',
    schedule: '10:00,22:00',
    authProfile: 'test',
    enabled: true,
    ...overrides,
  };
}

function rawRecord(overrides = {}) {
  return {
    _id: 'rec_1',
    公司名称: '示例传媒',
    企业性质: '民企',
    行业大类: '互联网',
    批次: '秋招',
    招聘对象: '2027届',
    工作地点: '合肥',
    招聘岗位: '品牌营销管培生',
    截止时间: '2026/09/20',
    投递方式: 'https://example.com/apply',
    ...overrides,
  };
}

test('deadline reminders use the configured Brisbane calendar day', () => {
  const brisbaneMorning = Date.parse('2026-08-25T22:00:00.000Z'); // 2026-08-26 08:00 in Brisbane
  assert.equal(daysUntil('2026/08/27', brisbaneMorning, 'Australia/Brisbane'), 1);
  assert.equal(daysUntil('2026/08/26', brisbaneMorning, 'Australia/Brisbane'), 0);
});

test('cloud store persists source lifecycle, runs, snapshots and notifications', () => {
  const directory = tempDirectory();
  const store = new CloudStore({ dataDir: directory, clock: () => FIXED_NOW }).initialize();
  let recovered = null;
  try {
    const source = store.createSource(sourceInput());
    assert.match(source.id, /^src_/);
    assert.equal(store.listSources().length, 1);
    assert.throws(() => store.createSource(sourceInput({ schedule: '25:00' })), /schedule/);

    const runId = store.createRun(source.id, 'test');
    store.markRunRunning(runId);
    const first = store.upsertSourceRecords(source.id, [rawRecord()], new Date(FIXED_NOW).toISOString());
    assert.deepEqual(first, { inserted: 1, changed: 0, missing: 0, active: 1 });
    const second = store.upsertSourceRecords(source.id, [rawRecord({ 招聘岗位: '内容运营' })], new Date(FIXED_NOW + 1000).toISOString());
    assert.equal(second.changed, 1);
    store.finishRun(runId, { status: 'success', fetchedCount: 1, canonicalCount: 1, insertedCount: 1 });
    assert.equal(store.listRuns()[0].status, 'success');
    assert.equal(store.overview().records, 1);

    store.addNotification('test', '完成', '测试正文');
    assert.equal(store.listNotifications()[0].title, '完成');
    const interruptedRunId = store.createRun(source.id, 'test-restart');
    store.markRunRunning(interruptedRunId);
    store.close();
    recovered = new CloudStore({ dataDir: directory, clock: () => FIXED_NOW + 2000 }).initialize();
    assert.equal(recovered.listRuns().find(run => run.id === interruptedRunId).status, 'failed');
    assert.match(recovered.listRuns().find(run => run.id === interruptedRunId).error, /重启中断/);
    assert.equal(recovered.getSource(source.id).lastStatus, 'failed');
    assert.ok(recovered.updateSource(source.id, { enabled: false }).enabled === false);
    assert.equal(recovered.archiveSource(source.id), true);
    assert.equal(recovered.listSources().length, 0);
  } finally {
    recovered?.close();
    store.close();
    cleanup(directory);
  }
});

test('classifier keeps one canonical job, preserves locations and reproduces fit rules', () => {
  const source = { id: 'src_1', name: '飞书主表', fieldMap: {} };
  const richRecord = rawRecord({
    专业要求: '市场营销、新闻传播', 学历要求: '本科及以上', 工作经验: '应届生',
    岗位描述: '负责品牌内容策划与项目推进', 任职要求: '具备内容策划和数据分析能力',
    技能要求: '内容策划、数据分析', 工作方式: '现场', 工作类型: '全职',
    薪资待遇: '18K-25K/月', 薪资币种: 'CNY', 福利待遇: '补充医疗、年度奖金',
  });
  const result = classifyRecords([
    richRecord,
    rawRecord({ _id: 'rec_2', 投递方式: 'https://example.com/richer', 官方公告: 'https://example.com/notice' }),
    rawRecord({ _id: 'rec_3', 工作地点: '上海', 招聘岗位: '软件工程师' }),
  ], source, '2026-08-25T00:00:00.000Z');
  assert.equal(result.jobs.length, 2);
  assert.equal(result.stats.duplicates, 1);
  const fit = result.jobs.find(job => job.company === '示例传媒' && job.location === '合肥');
  assert.equal(fit.classification, '符合条件');
  assert.match(fit.priority, /高/);
  assert.equal(JSON.parse(fit.sourceRecordIds).length, 2);
  assert.equal(fit.sourceNote, '');
  assert.equal(fit.major, '市场营销、新闻传播');
  assert.equal(fit.degree, '本科及以上');
  assert.match(fit.description, /品牌内容策划/);
  assert.match(fit.requirements, /数据分析/);
  assert.equal(fit.skills, '内容策划、数据分析');
  assert.equal(fit.workMode, '现场');
  assert.equal(fit.employmentType, '全职');
  assert.equal(fit.salary, '18K-25K/月');
  assert.equal(fit.salaryCurrency, 'CNY');
  assert.match(fit.benefits, /年度奖金/);
  const technical = result.jobs.find(job => job.location === '上海');
  assert.equal(technical.classification, '全部岗位');

  const reversed = classifyRecords([
    rawRecord({ _id: 'rec_2', 投递方式: 'https://example.com/richer', 官方公告: 'https://example.com/notice' }),
    richRecord,
  ], source, '2026-08-25T00:00:00.000Z').jobs[0];
  assert.equal(reversed.url, fit.url);
  assert.equal(reversed.notice, fit.notice);
  assert.equal(reversed.sourceRecordIds, fit.sourceRecordIds);

  const withSourceNote = classifyRecords([rawRecord({ '备注/提示': '需自备作品集' })], source, '2026-08-25T00:00:00.000Z').jobs[0];
  assert.equal(withSourceNote.sourceNote, '需自备作品集');
  assert.equal(withSourceNote.note, '');
});

test('cloud merge collapses legacy classification duplicates and preserves user state', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const common = {
      company: '示例传媒', position: '品牌营销管培生', location: '合肥', deadline: '2026/09/20',
      status: '未投递', statusUpdatedAt: '',
    };
    service.applySync({ jobs: [
      { id: 'legacy-all', source: '全部岗位', ...common, note: '另一条个人备注' },
      { id: 'legacy-fit', source: '符合条件', ...common, status: '已投递', statusUpdatedAt: '2026-08-24T00:00:00.000Z', note: '保留我的备注' },
    ] });
    const classified = classifyRecords([rawRecord()], { id: 'src_main', name: '飞书主表', fieldMap: {} }, '2026-08-25T00:00:00.000Z');
    const merged = service.applyCloudSync({ sourceId: 'src_main', sourceName: '飞书主表', jobs: classified.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(active.length, 1);
    assert.equal(active[0].status, '已投递');
    assert.deepEqual(new Set(active[0].note.split('\n\n')), new Set(['另一条个人备注', '保留我的备注']));
    assert.equal(active[0].classification, '符合条件');
    assert.equal(merged.deduplicated, 1);

    const repeatedClassified = classifyRecords([rawRecord()], { id: 'src_main', name: '飞书主表', fieldMap: {} }, '2026-08-26T00:00:00.000Z');
    const repeated = service.applyCloudSync({ sourceId: 'src_main', sourceName: '飞书主表', jobs: repeatedClassified.jobs, syncAt: '2026-08-26T00:00:00.000Z' });
    assert.equal(repeated.inserted, 0);
    assert.equal(repeated.updated, 0);
    assert.equal(repeated.inactive, 0);
  } finally {
    cleanup(directory);
  }
});

test('cloud migration separates an old upstream hint from personal notes', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    service.applySync({ jobs: [{
      id: 'legacy-note', source: '符合条件', company: '示例传媒', position: '品牌营销管培生', location: '合肥',
      status: '未投递', statusUpdatedAt: '', note: '需自备作品集',
    }] });
    const classified = classifyRecords([rawRecord({ '备注/提示': '需自备作品集' })], { id: 'src_main', name: '飞书主表', fieldMap: {} }, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: 'src_main', sourceName: '飞书主表', jobs: classified.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const migrated = service.snapshot().jobs[0];
    assert.equal(migrated.sourceNote, '需自备作品集');
    assert.equal(migrated.note, '');
  } finally {
    cleanup(directory);
  }
});

test('multiple sources share one canonical job and source removal keeps surviving origins', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_feishu', name: '飞书主表', fieldMap: {} };
    const sourceB = { id: 'src_tencent', name: '腾讯补充表', fieldMap: {} };
    const first = classifyRecords([rawRecord({ _id: 'feishu_1', 工作地点: '上海市' })], sourceA, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: first.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const original = service.snapshot().jobs[0];
    assert.equal(service.applyWebEdit(original.id, { status: '已投递', note: '保留跨来源状态' }).ok, true);

    const second = classifyRecords([rawRecord({ _id: 'tencent_1', 工作地点: '上海' })], sourceB, '2026-08-25T01:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: second.jobs, syncAt: '2026-08-25T01:00:00.000Z' });
    let active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(active.length, 1);
    assert.equal(active[0].status, '已投递');
    assert.equal(active[0].note, '保留跨来源状态');
    assert.deepEqual(new Set(JSON.parse(active[0].originIds)), new Set([sourceA.id, sourceB.id]));
    assert.deepEqual(new Set(JSON.parse(active[0].sourceRecordIds)), new Set(['src_feishu:feishu_1', 'src_tencent:tencent_1']));

    const renamedA = { ...sourceA, name: '飞书主表（新版）' };
    const refreshed = classifyRecords([rawRecord({ _id: 'feishu_2', 工作地点: '上海、杭州' })], renamedA, '2026-08-25T02:00:00.000Z');
    const equivalentB = classifyRecords([rawRecord({ _id: 'tencent_2', 工作地点: '杭州/上海市' })], sourceB, '2026-08-25T02:00:00.000Z');
    assert.equal(refreshed.jobs[0].canonicalKey, equivalentB.jobs[0].canonicalKey);

    // Keep the original location-equivalent job while refreshing A, then verify stale A record IDs are replaced.
    const refreshedSameJob = classifyRecords([rawRecord({ _id: 'feishu_2', 工作地点: '上海市' })], renamedA, '2026-08-25T02:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: renamedA.name, jobs: refreshedSameJob.jobs, syncAt: '2026-08-25T02:00:00.000Z' });
    active = service.snapshot().jobs.filter(job => job.active !== '0');
    const idsAfterRefresh = JSON.parse(active[0].sourceRecordIds);
    assert.ok(!idsAfterRefresh.includes('src_feishu:feishu_1'));
    assert.ok(idsAfterRefresh.includes('src_feishu:feishu_2'));
    const originMap = new Map(JSON.parse(active[0].originIds).map((id, index) => [id, JSON.parse(active[0].origins)[index]]));
    assert.equal(originMap.get(sourceA.id), renamedA.name);
    assert.equal(originMap.get(sourceB.id), sourceB.name);

    service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: [], syncAt: '2026-08-25T03:00:00.000Z' });
    active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(active.length, 1);
    assert.deepEqual(JSON.parse(active[0].originIds), [sourceA.id]);
    assert.deepEqual(JSON.parse(active[0].origins), [renamedA.name]);
    assert.equal(active[0].status, '已投递');

    service.applyCloudSync({ sourceId: sourceA.id, sourceName: renamedA.name, jobs: [], syncAt: '2026-08-25T04:00:00.000Z' });
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 0);
  } finally {
    cleanup(directory);
  }
});

test('cross-source merge uses recruitment links plus company and location similarity', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_feishu', name: '飞书主表', fieldMap: {} };
    const sourceB = { id: 'src_tencent', name: '腾讯补充表', fieldMap: {} };
    const first = classifyRecords([rawRecord({
      _id: 'feishu_link_1', 公司名称: '示例科技有限公司', 招聘岗位: '内容运营,品牌策划,市场营销', 工作地点: '上海|杭州',
      投递方式: 'https://jobs.example.com/campus/2027',
    })], sourceA, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: first.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const oldId = service.snapshot().jobs[0].id;
    assert.equal(service.applyWebEdit(oldId, { status: '已投递', note: '保留链接去重后的状态' }).ok, true);

    const second = classifyRecords([{
      _id: 'BB08J2:row_3', 公司: '示例科技', 行业: '互联网', 性质: '民企', 类别: '秋招正式', 应届生: '27届',
      岗位: '品牌策划/内容运营/市场营销/用户增长', 地点: '杭州/上海市', 申请截止: '2026-09-20',
      '网申链接/邮箱': 'https://jobs.example.com/campus/2027',
    }], sourceB, '2026-08-25T01:00:00.000Z');
    assert.notEqual(first.jobs[0].canonicalKey, second.jobs[0].canonicalKey, 'fixture must require link-assisted matching');
    const merged = service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: second.jobs, syncAt: '2026-08-25T01:00:00.000Z' });
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(merged.crossSourceMatched, 1);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, oldId);
    assert.equal(active[0].status, '已投递');
    assert.equal(active[0].note, '保留链接去重后的状态');
    assert.deepEqual(new Set(JSON.parse(active[0].originIds)), new Set([sourceA.id, sourceB.id]));
  } finally {
    cleanup(directory);
  }
});

test('shared generic recruitment links do not merge different companies or unrelated jobs', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_a', name: '来源 A', fieldMap: {} };
    const sourceB = { id: 'src_b', name: '来源 B', fieldMap: {} };
    const shared = 'https://jobs.example.com/';
    const first = classifyRecords([rawRecord({ _id: 'a_1', 公司名称: '宁波银行苏州分行', 招聘岗位: '暑期实习生岗位', 工作地点: '苏州', 投递方式: shared })], sourceA);
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: first.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const second = classifyRecords([rawRecord({ _id: 'b_1', 公司名称: '宁波银行深圳分行', 招聘岗位: '暑期实习生', 工作地点: '深圳', 投递方式: shared })], sourceB);
    const merged = service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: second.jobs, syncAt: '2026-08-25T01:00:00.000Z' });
    assert.equal(merged.crossSourceMatched, 0);
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 2);
  } finally {
    cleanup(directory);
  }
});

test('stable source record IDs preserve identity when upstream job fields change', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const source = { id: 'src_stable', name: '稳定来源', fieldMap: {} };
    const first = classifyRecords([rawRecord({ _id: 'same_record' })], source, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: first.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const oldId = service.snapshot().jobs[0].id;
    service.applyWebEdit(oldId, { status: '一面', note: '字段变化后仍保留' });
    const changed = classifyRecords([rawRecord({ _id: 'same_record', 招聘岗位: '品牌内容运营（更新）' })], source, '2026-08-26T00:00:00.000Z');
    assert.notEqual(first.jobs[0].canonicalKey, changed.jobs[0].canonicalKey);
    const merged = service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: changed.jobs, syncAt: '2026-08-26T00:00:00.000Z' });
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(merged.inserted, 0);
    assert.equal(active.length, 1);
    assert.equal(active[0].id, oldId);
    assert.equal(active[0].position, '品牌内容运营（更新）');
    assert.equal(active[0].status, '一面');
    assert.equal(active[0].note, '字段变化后仍保留');
  } finally {
    cleanup(directory);
  }
});

test('Tencent row-number drift does not move personal state to another company', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const source = { id: 'src_tencent', name: '腾讯岗位表', fieldMap: {} };
    const first = classifyRecords([rawRecord({
      _id: 'BB08J2:row_16', 公司名称: '好未来集团', 招聘岗位: '品牌传播管培生', 投递方式: 'https://example.com/tal',
    })], source, '2026-08-24T00:00:00.000Z');
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: first.jobs, syncAt: '2026-08-24T00:00:00.000Z' });
    const originalId = service.snapshot().jobs[0].id;
    service.applyWebEdit(originalId, { status: '一面', note: '好未来个人进度' });

    const shifted = classifyRecords([
      rawRecord({ _id: 'BB08J2:row_16', 公司名称: '中国联通研究院', 招聘岗位: '品牌运营', 投递方式: 'https://example.com/unicom' }),
      rawRecord({ _id: 'BB08J2:row_146', 公司名称: '好未来集团', 招聘岗位: '品牌传播管培生', 投递方式: 'https://example.com/tal' }),
    ], source, '2026-08-25T00:00:00.000Z');
    assert.doesNotThrow(() => service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: shifted.jobs, syncAt: '2026-08-25T00:00:00.000Z' }));
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(active.length, 2);
    const tal = active.find(job => job.company === '好未来集团');
    const unicom = active.find(job => job.company === '中国联通研究院');
    assert.equal(tal.id, originalId);
    assert.equal(tal.status, '一面');
    assert.equal(tal.note, '好未来个人进度');
    assert.equal(unicom.status, '未投递');
    assert.equal(unicom.note, '');
  } finally {
    cleanup(directory);
  }
});

test('reconciliation previews and collapses historical duplicates while preserving user state', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const source = { id: 'src_current', name: '当前来源', fieldMap: {} };
    const classified = classifyRecords([rawRecord()], source, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: classified.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const current = service.snapshot().jobs[0];
    service.applySync({ jobs: [
      current,
      { ...current, id: 'legacy-duplicate', origins: '[]', originIds: '[]', sourceRecordIds: '[]', status: '已投递', statusUpdatedAt: '2026-08-24T00:00:00.000Z', note: '历史个人备注' },
      { ...current, id: 'legacy-orphan', canonicalKey: '', company: '历史孤立公司', position: '历史岗位', origins: '[]', originIds: '[]', sourceRecordIds: '[]', note: '' },
    ], syncAt: '2026-08-25T00:00:00.000Z' });

    const preview = service.reconcileCloudJobs({ sourceIds: [source.id], syncAt: '2026-08-25T00:00:00.000Z', dryRun: true });
    assert.equal(preview.duplicateGroups, 1);
    assert.equal(preview.duplicatesRemoved, 1);
    assert.equal(preview.legacyDeactivated, 1);
    assert.equal(service.snapshot().jobs.length, 3, 'dry run must not mutate jobs');

    const result = service.reconcileCloudJobs({ sourceIds: [source.id], syncAt: '2026-08-25T00:00:00.000Z' });
    assert.equal(result.after, 2);
    const merged = service.snapshot().jobs.find(job => job.company === '示例传媒');
    const orphan = service.snapshot().jobs.find(job => job.company === '历史孤立公司');
    assert.equal(merged.status, '已投递');
    assert.equal(merged.note, '历史个人备注');
    assert.equal(merged.active, '1');
    assert.equal(orphan.active, '0');
    assert.equal(result.aliases['legacy-duplicate'], merged.id);
  } finally {
    cleanup(directory);
  }
});

test('reconciliation never revives an inactive job through a reused positional source ID', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const source = { id: 'src_tencent', name: '腾讯岗位表', fieldMap: {} };
    const classified = classifyRecords([rawRecord({ _id: 'BB08J2:row_16' })], source, '2026-08-24T00:00:00.000Z');
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: classified.jobs, syncAt: '2026-08-24T00:00:00.000Z' });
    const recordId = JSON.parse(service.snapshot().jobs[0].sourceRecordIds)[0];
    service.applyCloudSync({ sourceId: source.id, sourceName: source.name, jobs: [], syncAt: '2026-08-25T00:00:00.000Z' });
    assert.equal(service.snapshot().jobs[0].active, '0');
    service.reconcileCloudJobs({
      sourceIds: [source.id], activeSourceRecordIds: [recordId], syncAt: '2026-08-25T00:00:00.000Z',
    });
    assert.equal(service.snapshot().jobs[0].active, '0');
  } finally {
    cleanup(directory);
  }
});

test('cross-source aliases cannot consume another row reserved by the source being refreshed', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_a', name: '来源 A', fieldMap: {} };
    const sourceB = { id: 'src_b', name: '来源 B', fieldMap: {} };
    const link = 'https://jobs.example.com/campus/shared';
    const recordsA = [
      rawRecord({ _id: 'a_1', 公司名称: '示例科技', 招聘岗位: '内容运营', 工作地点: '上海', 投递方式: link }),
      rawRecord({ _id: 'a_2', 公司名称: '示例科技', 招聘岗位: '品牌运营', 工作地点: '上海', 投递方式: link }),
    ];
    const firstA = classifyRecords(recordsA, sourceA, '2026-08-25T00:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: firstA.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const fromB = classifyRecords([
      rawRecord({ _id: 'b_1', 公司名称: '示例科技有限公司', 招聘岗位: '内容运营岗位', 工作地点: '上海市', 投递方式: link }),
    ], sourceB, '2026-08-25T01:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: fromB.jobs, syncAt: '2026-08-25T01:00:00.000Z' });
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 2);

    const repeatB = classifyRecords([
      rawRecord({ _id: 'b_1', 公司名称: '示例科技有限公司', 招聘岗位: '内容运营岗位', 工作地点: '上海市', 投递方式: link }),
    ], sourceB, '2026-08-25T02:00:00.000Z');
    const mergedB = service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: repeatB.jobs, syncAt: '2026-08-25T02:00:00.000Z' });
    assert.equal(mergedB.inserted, 0);
    assert.equal(mergedB.deduplicated, 0);
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 2);

    const repeatA = classifyRecords(recordsA, sourceA, '2026-08-26T00:00:00.000Z');
    const merged = service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: repeatA.jobs, syncAt: '2026-08-26T00:00:00.000Z' });
    const active = service.snapshot().jobs.filter(job => job.active !== '0');
    assert.equal(merged.inserted, 0);
    assert.equal(merged.deduplicated, 0);
    assert.equal(active.length, 2);
    assert.deepEqual(new Set(active.flatMap(job => JSON.parse(job.sourceRecordIds).filter(id => id.startsWith('src_a:')))), new Set(['src_a:a_1', 'src_a:a_2']));
  } finally {
    cleanup(directory);
  }
});

test('foreign-source identity lets diverged local rows coalesce without schedule oscillation', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_a', name: '来源 A', fieldMap: {} };
    const sourceB = { id: 'src_b', name: '来源 B', fieldMap: {} };
    const link = 'https://jobs.example.com/campus/grouped';
    const initiallyEquivalent = classifyRecords([
      rawRecord({ _id: 'a_1', 公司名称: '示例科技', 招聘岗位: '内容运营', 工作地点: '上海', 投递方式: link }),
      rawRecord({ _id: 'a_2', 公司名称: '示例科技', 招聘岗位: '内容运营', 工作地点: '上海市', 投递方式: link }),
    ], sourceA, '2026-08-25T00:00:00.000Z');
    assert.equal(initiallyEquivalent.jobs.length, 1);
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: initiallyEquivalent.jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    const fromB = classifyRecords([
      rawRecord({ _id: 'b_1', 公司名称: '示例科技有限公司', 招聘岗位: '内容运营岗位', 工作地点: '上海', 投递方式: link }),
    ], sourceB, '2026-08-25T01:00:00.000Z');
    service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: fromB.jobs, syncAt: '2026-08-25T01:00:00.000Z' });

    const divergedRecords = [
      rawRecord({ _id: 'a_1', 公司名称: '示例科技', 招聘岗位: '内容运营', 工作地点: '上海', 投递方式: link }),
      rawRecord({ _id: 'a_2', 公司名称: '示例科技', 招聘岗位: '品牌运营', 工作地点: '上海', 投递方式: link }),
    ];
    const diverged = classifyRecords(divergedRecords, sourceA, '2026-08-25T02:00:00.000Z');
    assert.equal(diverged.jobs.length, 2);
    const firstRefresh = service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: diverged.jobs, syncAt: '2026-08-25T02:00:00.000Z' });
    assert.equal(firstRefresh.inserted, 0);
    assert.equal(firstRefresh.coalesced, 1);
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 1);
    assert.deepEqual(new Set(JSON.parse(service.snapshot().jobs[0].sourceRecordIds)), new Set(['src_a:a_1', 'src_a:a_2', 'src_b:b_1']));

    const repeated = classifyRecords(divergedRecords, sourceA, '2026-08-25T03:00:00.000Z');
    const secondRefresh = service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: repeated.jobs, syncAt: '2026-08-25T03:00:00.000Z' });
    assert.equal(secondRefresh.inserted, 0);
    assert.equal(secondRefresh.updated, 0);
    assert.equal(secondRefresh.coalesced, 1);
    assert.equal(service.snapshot().jobs.filter(job => job.active !== '0').length, 1);
  } finally {
    cleanup(directory);
  }
});

test('cross-source content selection is deterministic across alternating schedules', () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  try {
    service.load();
    const sourceA = { id: 'src_a', name: '来源 A', fieldMap: {} };
    const sourceB = { id: 'src_b', name: '来源 B', fieldMap: {} };
    const link = 'https://jobs.example.com/campus/deterministic';
    const makeA = at => classifyRecords([rawRecord({
      _id: 'a_1', 公司名称: '示例科技', 招聘岗位: '内容运营', 工作地点: '上海', 投递方式: link,
    })], sourceA, at);
    const makeB = at => classifyRecords([rawRecord({
      _id: 'b_1', 公司名称: '示例科技', 招聘岗位: '内容运营/品牌运营/用户增长', 工作地点: '上海市',
      投递方式: link, 官方公告: 'https://example.com/notice',
    })], sourceB, at);
    service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: makeA('2026-08-25T00:00:00.000Z').jobs, syncAt: '2026-08-25T00:00:00.000Z' });
    service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: makeB('2026-08-25T01:00:00.000Z').jobs, syncAt: '2026-08-25T01:00:00.000Z' });
    const winner = service.snapshot().jobs.find(job => job.active !== '0');
    assert.equal(winner.contentSourceId, sourceB.id);
    assert.equal(winner.position, '内容运营/品牌运营/用户增长');

    const repeatA = service.applyCloudSync({ sourceId: sourceA.id, sourceName: sourceA.name, jobs: makeA('2026-08-25T02:00:00.000Z').jobs, syncAt: '2026-08-25T02:00:00.000Z' });
    const repeatB = service.applyCloudSync({ sourceId: sourceB.id, sourceName: sourceB.name, jobs: makeB('2026-08-25T03:00:00.000Z').jobs, syncAt: '2026-08-25T03:00:00.000Z' });
    assert.equal(repeatA.inserted, 0);
    assert.equal(repeatA.updated, 0);
    assert.equal(repeatB.inserted, 0);
    assert.equal(repeatB.updated, 0);
    assert.equal(service.snapshot().jobs.find(job => job.active !== '0').position, winner.position);
    assert.deepEqual(JSON.parse(service.snapshot().jobs.find(job => job.active !== '0').originIds), ['src_a', 'src_b']);
  } finally {
    cleanup(directory);
  }
});

test('runtime runs an injected source end to end and API exposes cloud operations', async () => {
  const directory = tempDirectory();
  const service = createService({ dataDir: directory, clock: () => FIXED_NOW });
  service.load();
  const runtime = new CloudRuntime({
    dataDir: directory,
    jobService: service,
    clock: () => FIXED_NOW,
    fetchSource: async () => [rawRecord()],
    createLoginSession: async () => { throw new Error('not used'); },
    searchInterviewExperience: async () => [],
  }).initialize({ startScheduler: false });
  const app = createApp({ service, cloud: runtime, syncToken: 'sync-secret-123456', editPassword: 'edit-secret-123456' });
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let response = await fetch(`${base}/api/cloud/sources`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456', ...sourceInput() }),
    });
    assert.equal(response.status, 201);
    const source = (await response.json()).source;
    response = await fetch(`${base}/api/cloud/sources/${source.id}/run`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456' }),
    });
    assert.equal(response.status, 202);
    await runtime.waitForIdle();
    const runs = await (await fetch(`${base}/api/cloud/runs`)).json();
    assert.equal(runs.runs[0].status, 'success');
    const jobs = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(jobs.total, 1);
    assert.equal(jobs.jobs[0].classification, '符合条件');

    response = await fetch(`${base}/api/cloud/reconcile`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456', dryRun: true }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).duplicatesRemoved, 0);

    response = await fetch(`${base}/api/cloud/sources`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456', ...sourceInput(), schedule: '25:99' }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /HH:mm/);

    response = await fetch(`${base}/api/cloud/sources/${source.id}`, {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'edit-secret-123456' }),
    });
    assert.equal(response.status, 200);
    const afterArchive = await (await fetch(`${base}/api/jobs`)).json();
    assert.equal(afterArchive.total, 0);
    assert.equal(service.snapshot().jobs[0].active, '0');
    assert.equal(runtime.overview().records, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await runtime.shutdown();
    cleanup(directory);
  }
});

test('Tencent clipboard fallback parses tab-separated sheets', () => {
  const rows = parseTabSeparated('公司名称\t招聘岗位\n甲公司\t内容运营\n');
  assert.deepEqual(rows, [
    { _id: 'row_1', 公司名称: '甲公司', 招聘岗位: '内容运营' },
  ]);
  assert.match(stabilizeTencentRecords(rows, 'BB08J2')[0]._id, /^BB08J2:content_[a-f0-9]{24}$/);
});

test('Tencent workbook rows use content-stable IDs and disambiguate duplicate headers', () => {
  const first = recordsFromTencentGrid({
    sheetId: 'BB08J2',
    headers: ['公司', '岗位', '岗位'],
    rows: [
      { rowIndex: 2, values: ['甲公司', '内容运营', '品牌运营'] },
      { rowIndex: 3, values: ['', '', ''] },
    ],
  });
  const moved = recordsFromTencentGrid({
    sheetId: 'BB08J2', headers: ['公司', '岗位', '岗位'],
    rows: [{ rowIndex: 145, values: ['甲公司', '内容运营', '品牌运营'] }],
  });
  assert.equal(first.length, 1);
  assert.match(first[0]._id, /^BB08J2:content_[a-f0-9]{24}$/);
  assert.equal(moved[0]._id, first[0]._id);
  assert.deepEqual({ 公司: first[0].公司, 岗位: first[0].岗位, 岗位_2: first[0].岗位_2 }, { 公司: '甲公司', 岗位: '内容运营', 岗位_2: '品牌运营' });
});

test('classifier recognizes Tencent document field aliases without per-source mapping', () => {
  const raw = recordsFromTencentGrid({
    sheetId: 'BB08J2',
    headers: ['公司', '行业', '性质', '录入时间', '申请截止', '岗位', '地点', '应届生', '公告链接', '网申链接/邮箱', '类别'],
    rows: [{ rowIndex: 2, values: [
      '甲公司', '互联网', '民企', '2026-08-25', '2026-10-20', '内容运营', '上海市', '27/28/29届',
      'https://example.com/notice', 'https://example.com/apply', '秋招正式',
    ] }],
  });
  const result = classifyRecords(raw, { id: 'src_tencent', name: '腾讯文档岗位表', fieldMap: {} }, '2026-08-25T00:00:00.000Z');
  assert.equal(result.stats.invalid, 0);
  assert.equal(result.jobs.length, 1);
  assert.equal(result.jobs[0].classification, '符合条件');
  assert.deepEqual({
    company: result.jobs[0].company,
    industry: result.jobs[0].industry,
    nature: result.jobs[0].nature,
    position: result.jobs[0].position,
    location: result.jobs[0].location,
    deadline: result.jobs[0].deadline,
    notice: result.jobs[0].notice,
    url: result.jobs[0].url,
  }, {
    company: '甲公司', industry: '互联网', nature: '民企', position: '内容运营', location: '上海市',
    deadline: '2026-10-20', notice: 'https://example.com/notice', url: 'https://example.com/apply',
  });
});

test('Bing RSS parser keeps only supported interview-result domains', () => {
  const xml = `<?xml version="1.0"?><rss><channel>
    <item><title><![CDATA[示例面经]]></title><link>https://www.nowcoder.com/discuss/123</link><description><![CDATA[<b>校招</b> 经验]]></description></item>
    <item><title>无关结果</title><link>https://example.com/post</link><description>skip</description></item>
  </channel></rss>`;
  assert.deepEqual(parseBingRss(xml), [{ title: '示例面经', url: 'https://www.nowcoder.com/discuss/123', snippet: '校招 经验' }]);
});

test('DuckDuckGo parser unwraps redirects and rejects unrelated domains', () => {
  const html = `<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.nowcoder.com%2Fdiscuss%2F456&amp;rut=x">某公司面经</a><a class="result__snippet">一面 &amp; 二面</a></div>
    <div class="result"><a class="result__a" href="https://example.com/post">无关</a></div>`;
  assert.deepEqual(parseDuckDuckGoHtml(html), [{ title: '某公司面经', url: 'https://www.nowcoder.com/discuss/456', snippet: '一面 & 二面' }]);
});
