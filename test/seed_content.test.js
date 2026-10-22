'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PREP_TRACKS, PREP_QUESTIONS, EXAM_PACKS } = require('../server/product/catalog');

test('catalog preserves 72 general questions and adds 120 xingce originals on an additional track', () => {
  assert.equal(PREP_TRACKS.length, 13);
  assert.equal(new Set(PREP_TRACKS.map(track => track.id)).size, 13);
  assert.equal(PREP_QUESTIONS.length, 192);
  assert.equal(new Set(PREP_QUESTIONS.map(question => question.id)).size, 192);
  for (const track of PREP_TRACKS) {
    assert.equal(PREP_QUESTIONS.filter(question => question.trackId === track.id).length, track.id === 'track_xingce' ? 120 : 6, track.id);
  }
});

test('published seed answers and short-answer rubrics are internally consistent', () => {
  const tracks = new Set(PREP_TRACKS.map(track => track.id));
  for (const question of PREP_QUESTIONS) {
    const label = question.id;
    assert.ok(tracks.has(question.trackId), `${label}: unknown track`);
    assert.ok(question.prompt.trim().length > 10, `${label}: meaningful prompt`);
    assert.ok(question.explanation.trim().length > 10, `${label}: substantive explanation`);
    assert.ok(question.difficulty, `${label}: difficulty required`);
    assert.ok(['single', 'multi', 'short'].includes(question.type), `${label}: supported type`);
    if (question.type === 'short') {
      assert.ok(question.answer.sample?.trim(), `${label}: sample answer required`);
      assert.ok(question.answer.keywords?.length > 0, `${label}: rubric required`);
      assert.equal(new Set(question.answer.keywords).size, question.answer.keywords.length, `${label}: duplicate rubric`);
      for (const keyword of question.answer.keywords) {
        assert.ok(keyword.trim(), `${label}: empty rubric keyword`);
        assert.ok(question.answer.sample.includes(keyword), `${label}: sample does not satisfy keyword ${keyword}`);
      }
    } else {
      assert.ok(question.options?.length >= 2, `${label}: options required`);
      assert.equal(new Set(question.options).size, question.options.length, `${label}: duplicate options`);
      assert.ok(question.options.every(option => option.trim()), `${label}: empty option`);
      const answers = question.type === 'single' ? [question.answer] : question.answer;
      assert.ok(Array.isArray(answers) && answers.length > 0, `${label}: answer required`);
      assert.equal(new Set(answers).size, answers.length, `${label}: duplicate answers`);
      assert.ok(answers.every(answer => question.options.includes(answer)), `${label}: answer must match option`);
    }
  }
});

test('existing exam packs only reference valid retained question IDs', () => {
  const questions = new Set(PREP_QUESTIONS.map(question => question.id));
  for (const pack of EXAM_PACKS) {
    assert.ok(pack.questionIds.length > 0, pack.id);
    assert.equal(new Set(pack.questionIds).size, pack.questionIds.length, `${pack.id}: duplicate question`);
    assert.ok(pack.questionIds.every(id => questions.has(id)), `${pack.id}: missing question`);
  }
});

test('generic original questions are not labelled as a migrated company paper', () => {
  const pack = EXAM_PACKS.find(item => item.id === 'exam_huzhou_cloud');
  assert.ok(pack.title.includes('原创'));
  assert.equal(pack.type, '模拟');
  assert.ok(pack.sourceLabel.includes('非企业真题'));
  assert.equal(pack.title.includes('湖州城投'), false);
  assert.equal(pack.legacyUrl, '/exam/');
});
