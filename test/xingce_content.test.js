'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { XINGCE_QUESTIONS, QUANTITATIVE, DATA_ANALYSIS } = require('../server/product/xingce-seeds');
const { EXAM_SOURCES } = require('../server/product/exam-sources');
const tidyNumber = value => value.replace(/^\d+(?:\.\d+)?/, number => String(Number(Number(number).toFixed(6))));

test('xingce originals have 120 unique answerable questions across four supported sections, not fake past papers', () => {
  assert.equal(XINGCE_QUESTIONS.length, 120);
  assert.equal(new Set(XINGCE_QUESTIONS.map(item => item.id)).size, 120);
  assert.equal(new Set(XINGCE_QUESTIONS.map(item => item.prompt.normalize('NFKC').trim())).size, 120);
  for (const section of ['verbal', 'quantitative', 'reasoning', 'data_analysis']) assert.equal(XINGCE_QUESTIONS.filter(item => item.section === section).length, 30);
  for (const item of XINGCE_QUESTIONS) {
    assert.equal(item.contentKind, 'original_mock'); assert.equal(item.examType, 'xingce');
    assert.equal(item.trackId, 'track_xingce'); assert.equal(item.type, 'single');
    assert.equal(item.options.length, 4); assert.equal(new Set(item.options).size, 4);
    assert.ok(item.options.includes(item.answer)); assert.ok(item.explanation.length >= 25, item.id);
    assert.ok(item.sourceTitle.includes('原创')); assert.equal(item.sourceUrl || '', '');
    assert.ok(!/真题|官方/.test(item.sourceTitle));
  }
  for (const item of DATA_ANALYSIS) assert.ok(item.prompt.startsWith('【原创模拟资料，非现实统计】'));
});

test('all quantitative keyed answers match independent arithmetic calculations', () => {
  const lcm = (a, b) => { const gcd = (x, y) => y ? gcd(y, x % y) : x; return a * b / gcd(a, b); };
  const expected = [
    `${1 / (1 / 12 + 1 / 18)}天`, `${Math.round(1 / (1 / 6 - 1 / 9))}小时`, `${90 / (12 + 18)}小时`,
    `${120 / (60 / 30 + 60 / 60)}千米/小时`, `${(180 + 420) / 20}秒`, `${36 / (15 + 3) + 36 / (15 - 3)}小时`,
    `${((80 * 1.25 * 0.9 - 80) / 80) * 100}%`, `${(150 - 120) / 120 * 100}%`, `${(200 * 0.1 + 300 * 0.2) / 500 * 100}%`,
    `${300 * 0.2 / 0.12 - 300}克`, '3/10', '3/8', `${5 * 4 * 3 / 6}种`, `${2 * 3 * 2}种`, `${38 + 35 - 60}人`,
    `${8 / (3 - 2)}岁`, String([31, 32, 33, 34, 35, 36, 37, 38, 39, 40].find(n => n % 5 === 3 && n % 7 === 3)),
    `${lcm(lcm(12, 18), 20)}秒`, `${(34 / 2 - 5) * 5}平方米`, `${6 * 6 / 4}π`, `${4 * 2 + 1}只`,
    `${[2, 9, 16, 23, 30].length}个`, `${(300 - 12 * 20) / (18 - 12)}本`,
    `${Math.min(...Array.from({ length: 7 }, (_, a) => Array.from({ length: 7 }, (_, b) => a * 20 + b * 8 >= 47 ? a * 300 + b * 150 : Infinity)).flat())}元`,
    String(Array.from({ length: 10 }, (_, i) => 3 + i * 4).reduce((a, b) => a + b, 0)), `${7 - 1}种`,
    String(18 / (5 - 3) * (3 + 5)), `${2 + (1 - 2 / 10) * 15}小时`, `${6 * (6 - 3) / 2}条`, `${82 * 5 - 80 * 4}分`,
  ];
  assert.equal(expected.length, 30);
  for (let i = 0; i < expected.length; i++) assert.equal(QUANTITATIVE[i].answer, tidyNumber(expected[i]), QUANTITATIVE[i].id);
  assert.equal(3 / 5 * 2 / 4, 3 / 10); assert.equal(3 / 2 ** 3, 3 / 8);
});

test('all data-analysis keyed answers agree with fictional passage arithmetic and units', () => {
  const expected = [
    `${12 + 15 + 18}万人次`, `${(15 - 12) / 12 * 100}%`, `${5.4 / 18 * 100}%`, `${((3 + 4.5 + 5.4) / 45 * 100).toFixed(1)}%`, '三月非少儿到馆人次为12.6万',
    `${(1000 - 800) / 800 * 100}%`, `${1000 - 720}万元`, `${500 / 1000 * 100}%`, `${((1000 - 720) - (800 - 600)) / (800 - 600) * 100}%`, `${(500 - 400) / (1000 - 800) * 100}%`,
    `${(150 + 84 + 56) / 400 * 100}%`, `${Math.round((150 / 200 - 84 / 120) * 100)}个百分点`, `${80 - 56}人`, `${120 / 400 * 100}%`, `${(290 + 8) / 400 * 100}%`,
    `${1200 + 1500 + 1800 + 1700 + 1800}件`, `${(1800 - 1500) / 1500 * 100}%`, '周三', `${(24 + 30 + 27 + 34 + 45) / 8000 * 100}%`, `${[1200, 1500, 1800, 1700, 1800].sort((a, b) => a - b)[2]}件`,
    `${300 + 330}百万人次`, `${(300 - 240) / 240 * 100}%`, `${((360 - 330) / 360 * 100).toFixed(1)}%`, `${(630 - 600) / 600 * 100}%`, `${((300 / 630 - 240 / 600) * 100).toFixed(1)}个百分点`,
    `${(1800 - 1500) / 1500 * 100}%`, `${1200 * 0.9 + 600 * 0.8}人`, `${((1200 * 0.9 + 600 * 0.8) / 1800 * 100).toFixed(1)}%`, `${(1200 * 500 + 600 * 800) / 10000}万元`, `${(1200 * 500 + 600 * 800) / 1800}元`,
  ];
  for (let i = 0; i < expected.length; i++) assert.equal(tidyNumber(DATA_ANALYSIS[i].answer), tidyNumber(expected[i]), DATA_ANALYSIS[i].id);
  assert.equal(18 - 5.4, 12.6);
  assert.ok(27 / 1800 < Math.min(24 / 1200, 30 / 1500, 34 / 1700, 45 / 1800));
});

test('official sources are external references only, never licensed bank items or included in answerable counts', () => {
  assert.ok(EXAM_SOURCES.length >= 3);
  for (const source of EXAM_SOURCES) {
    assert.equal(source.availability, 'external_reference'); assert.equal(source.kind, 'syllabus_with_samples');
    assert.ok(['permission_not_confirmed', 'permission_required'].includes(source.rightsStatus));
    assert.ok(source.rightsNote); assert.ok(source.publisher); assert.ok(/^https?:$/.test(new URL(source.url).protocol));
  }
});
