'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { PREP_TRACKS, PREP_QUESTIONS, EXAM_PACKS } = require('../server/product/catalog');

test('original practice catalog has 12 unique tracks and 72 unique questions, six per track', () => {
  assert.equal(PREP_TRACKS.length, 12);
  assert.equal(new Set(PREP_TRACKS.map(track => track.id)).size, 12);
  assert.equal(PREP_QUESTIONS.length, 72);
  assert.equal(new Set(PREP_QUESTIONS.map(question => question.id)).size, 72);
  for (const track of PREP_TRACKS) {
    assert.equal(PREP_QUESTIONS.filter(question => question.trackId === track.id).length, 6, track.id);
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
