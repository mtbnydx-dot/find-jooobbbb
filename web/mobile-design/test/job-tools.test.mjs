import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityMessage, changedProgress, jobDeadlineLabel, jobFilterParams, mergeJobs, progressDraft, progressPatch, readJobFilters, safeJobReturn, safePublicLink, salaryText, stageLabel, toLocalDateTime, validateJobFilters } from '../src/lib/job-tools.js';

test('saved searches retain all supported filter fields and weekly salary', () => {
  const query = new URLSearchParams('q=工程师&location=上海&major=计算机&role=研发&industry=软件&nature=校招&source=官方&currency=CNY&salaryPeriod=week&salaryMin=2000&salaryMax=5000&sort=salary&availability=all&qualification=no_conflict&minMatch=60&view=saved&deadlineWithin=30');
  assert.equal(jobFilterParams(readJobFilters(query)).toString(), query.toString());
});
test('currency and numeric validations prevent misleading comparisons', () => {
  const filters = readJobFilters(new URLSearchParams('salaryMin=1000'));
  assert.match(validateJobFilters(filters), /币种/);
  assert.match(validateJobFilters({ ...filters, currency: 'CNY', salaryMax: '10' }), /最低薪资/);
  assert.equal(validateJobFilters({ ...filters, currency: 'CNY' }), '');
});
test('cursor pages merge by stable job identity', () => {
  assert.deepEqual(mergeJobs([{ id: 'a', title: 'old' }], [{ id: 'a', title: 'new' }, { id: 'b' }]), [{ id: 'a', title: 'new' }, { id: 'b' }]);
});
test('progress changes never include bookmark, hidden or unchanged notes', () => {
  const initial = progressDraft({ saved: true, hidden: true, note: 'private', status: 'applied' });
  assert.deepEqual(changedProgress(initial, { ...initial, nextAction: '跟进' }), { nextAction: '跟进' });
});
test('editing a note preserves timestamp seconds rather than rewriting local minute display', () => {
  const initial = progressDraft({ appliedAt: '2026-10-23T00:01:23.456Z', followUpAt: '2026-10-25T10:10:10.123Z', note: 'a' });
  const draft = { ...initial, appliedAt: toLocalDateTime(initial.appliedAt), followUpAt: toLocalDateTime(initial.followUpAt), note: 'b' };
  assert.deepEqual(progressPatch(initial, draft), { note: 'b' });
  assert.deepEqual(progressPatch(initial, { ...draft, note: 'a', followUpAt: '' }), { followUpAt: '' });
});
test('invalid reminder dates are rejected before mutation', () => {
  assert.throws(() => progressPatch(progressDraft(), { ...progressDraft(), followUpAt: '2026-02-30T10:00' }), /无效/);
});
test('stage changes do not invent an application date', () => {
  assert.deepEqual(progressPatch(progressDraft(), { ...progressDraft(), status: 'applied' }), { status: 'applied' });
  assert.equal(stageLabel({ status: 'interview' }), '面试');
});
test('availability preserves unknown, rolling, expired and historical distinctions', () => {
  assert.match(availabilityMessage({}), /不能据此认定/);
  assert.match(availabilityMessage({ availability: { status: 'rolling' } }), /空缺需/);
  assert.match(availabilityMessage({ availability: { status: 'active' } }), /不代表名额/);
  assert.match(availabilityMessage({ availability: { status: 'expired' } }), /历史信息/);
  assert.match(availabilityMessage({ available: false }), /旧投递入口已停用/);
  assert.match(jobDeadlineLabel({ availability: { status: 'rolling' } }), /名额需核实/);
});
test('public links and return contexts cannot execute script or redirect off-site', () => {
  assert.equal(safePublicLink('javascript:alert(1)'), '');
  assert.equal(safePublicLink('https://user:secret@example.com'), '');
  assert.equal(safeJobReturn('//example.com'), '/discover');
  assert.equal(safeJobReturn('/pipeline?tab=interview'), '/pipeline?tab=interview');
  assert.equal(safeJobReturn('/discover?location=上海'), '/discover?location=上海');
});
test('salary retains published currency/period and does not fabricate missing value', () => {
  assert.equal(salaryText({}), '薪资未公开');
  assert.equal(salaryText({ salaryText: '2000', salaryPeriod: 'week' }), '2000/周');
});
