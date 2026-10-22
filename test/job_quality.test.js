'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { jobAvailability, availabilityMatches, qualitySummary, enrichSourceFacts } = require('../server/product/job-quality');

test('deadline expiry is inclusive China calendar day and unknown dates remain visible', () => {
  const job = { deadline: '2026-10-23' };
  assert.equal(jobAvailability(job, Date.parse('2026-10-23T15:59:59Z')).status, 'active');
  assert.equal(jobAvailability(job, Date.parse('2026-10-23T16:00:00Z')).status, 'expired');
  assert.equal(jobAvailability({ deadline: '2026-02-30' }).status, 'unknown');
  assert.equal(availabilityMatches({ deadline: '招满即止' }, 'active'), true);
  assert.equal(availabilityMatches(job, 'all', Date.parse('2027-01-01')), true);
});

test('source enrichment retains genuine salary fields without inferring salaries from dates or leaking private fields', () => {
  const result = enrichSourceFacts({ id: 'job', company: '公司' }, [{ 薪资: '15K-20K', 薪资币种: 'CNY', 任职要求: '本科', password: 'private', 备注: 'private' }]);
  assert.equal(result.salaryText, '15K-20K'); assert.equal(result.salaryCurrency, 'CNY');
  assert.equal(result.requirements, '本科'); assert.ok(!JSON.stringify(result).includes('private'));
  const noSalary = enrichSourceFacts({ deadline: '2026-10-23', position: '2026-2027 校招' }, [{ 招聘对象: '2026-2027' }]);
  const summary = qualitySummary([result, noSalary], Date.parse('2026-11-01'));
  assert.equal(summary.salaryKnown, 1); assert.equal(summary.salaryCurrencyKnown, 1); assert.equal(summary.expired, 1);
  assert.equal(enrichSourceFacts({}, [{ 年薪: '20万-30万 CNY' }]).salaryText, '20万-30万 CNY/年');
});

test('source compensation is atomic and conflicting sources never create a synthetic salary', () => {
  const one = enrichSourceFacts({}, [{ 年薪: '20-30万元' }, { 薪资币种: 'AUD', 计薪周期: 'month' }]);
  assert.equal(one.salaryText, '20-30万元/年'); assert.equal(one.salaryCurrency, undefined); assert.equal(one.salaryPeriod, 'year');
  const conflict = enrichSourceFacts({}, [{ 薪资: '2万元/月', 薪资币种: 'CNY' }, { 薪资: '5000澳元/月', 薪资币种: 'AUD' }]);
  assert.equal(conflict.salaryText, undefined); assert(conflict.sourceFactWarnings.length);
  const existing = enrichSourceFacts({ salaryText: '原来源薪资未公开' }, [{ 薪资: '5000澳元/月', 薪资币种: 'AUD' }]);
  assert.equal(existing.salaryText, '原来源薪资未公开'); assert.equal(existing.salaryCurrency, undefined);
  assert.equal(enrichSourceFacts({}, [{ 工作经验: '3年以上经验优先' }]).experience, '3年以上经验优先');
});

test('different explicit source cohorts cannot silently enrich one historical catalog identity', () => {
  const job = { id:'kept', audience:'2027届|2026届', major:'原专业' };
  const result = enrichSourceFacts(job,[{ 招聘对象:'2026届', 薪资:'2万元/月', 工作经验:'3年' },{ 招聘对象:'2027届', 薪资:'3万元/月', 专业要求:'另一个专业' }]);
  assert.equal(result.id,'kept'); assert.equal(result.major,'原专业'); assert.equal(result.salaryText,undefined); assert.equal(result.experience,undefined); assert(result.sourceFactWarnings[0].includes('届次'));
  assert.equal(enrichSourceFacts({audience:'2027届'},[{招聘对象:'2027届',工作经验:'不限'}]).experience,'不限');
});
