'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

test('rule score display never falls back to personal AI scores or renders missing values as zero', async () => {
  const { matchScore } = await import('../web/src/lib/format.js');
  assert.equal(matchScore({ aiAssessment: { score: 95 } }), null);
  assert.equal(matchScore({ matchScore: null }), null);
  assert.equal(matchScore({ match: { score: 60 }, aiAssessment: { score: 95 } }), 60);
  assert.equal(matchScore({ match: { label: '待完善画像', score: 0 } }), null);
});

test('salary labels retain explicitly supplied annual, monthly and hourly periods', async () => {
  const { salaryText } = await import('../web/src/lib/format.js');
  assert.equal(salaryText({ salaryText: '20-30万', salaryPeriod: 'year' }), '20-30万/年');
  assert.equal(salaryText({ salaryText: '20-30万/年', salaryPeriod: 'year' }), '20-30万/年');
  assert.equal(salaryText({ salaryText: '15000元', salaryPeriod: 'month' }), '15000元/月');
  assert.equal(salaryText({ salaryText: '20-30万' }), '20-30万');
  assert.equal(salaryText({}), '薪资未公开');
});
