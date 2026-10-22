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
