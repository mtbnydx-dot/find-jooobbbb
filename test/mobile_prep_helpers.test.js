const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helpers = import(pathToFileURL(path.join(__dirname, '../web/mobile-design/src/screens/prep-helpers.js')).href);

test('mobile prep keeps string/numeric option identities and multi-select toggles correctly', async () => {
  const { optionValue, chooseAnswer, hasAnswer, answerText } = await helpers;
  const question = { type: 'multi', options: [{ value: 'A', text: '甲' }, { value: 0, text: '乙' }] };
  assert.equal(optionValue(question.options[1], 1), '0');
  assert.deepEqual(chooseAnswer(question, ['A'], '0'), ['A', '0']);
  assert.deepEqual(chooseAnswer(question, ['A', '0'], 'A'), ['0']);
  assert.equal(hasAnswer(0), true);
  assert.equal(hasAnswer([]), false);
  assert.equal(answerText(question, ['A', '0']), 'A. 甲；B. 乙');
});

test('mobile prep displays server reference formats without guessing correct choices', async () => {
  const { answerText, referenceText } = await helpers;
  assert.equal(answerText({ options: ['甲', '乙'] }, '1'), 'B. 乙');
  assert.equal(answerText({ options: ['甲'] }, null), '未作答');
  assert.equal(referenceText({ keywords: ['原理', '案例'] }), '关键词：原理、案例');
  assert.equal(referenceText({ sample: '参考论述' }), '参考论述');
});

test('mobile exam elapsed time is wall-clock based across background pauses', async () => {
  const { elapsedAt } = await helpers;
  assert.equal(elapsedAt(30, 1000, 121000), 150);
  assert.equal(elapsedAt(30, 1000, 500), 30);
});

test('mobile exam progress comparison ignores key order but catches changed work', async () => {
  const { sameProgress } = await helpers;
  assert.equal(sameProgress({ answers: { b: '1', a: '0' }, flagged: ['b', 'a'], currentIndex: 1 }, { answers: { a: '0', b: '1' }, flagged: ['a', 'b'], currentIndex: 1 }), true);
  assert.equal(sameProgress({ answers: { a: '0' } }, { answers: { a: '1' } }), false);
});

test('mobile exam drafts are account-scoped and retain only answer progress', async () => {
  const { writePrepDraft, readPrepDraft, prepDraftKey, clearPrepDrafts } = await helpers;
  const values = {};
  global.sessionStorage = {
    getItem: key => values[key] ?? null,
    setItem(key, value) { values[key] = value; this[key] = value; },
    removeItem(key) { delete values[key]; delete this[key]; },
  };
  try {
    assert.equal(writePrepDraft('alice', 'session', { answers: { q: 'A' }, expectedVersion: 2, dirty: true, elapsedSeconds: 30, question: { answer: 'B' }, sessionToken: 'never-store' }), true);
    writePrepDraft('bob', 'session', { answers: { q: 'C' }, expectedVersion: 1 });
    assert.equal(readPrepDraft('alice', 'session').answers.q, 'A');
    assert.equal(readPrepDraft('bob', 'session').answers.q, 'C');
    const serialized = values[prepDraftKey('alice', 'session')];
    assert.equal(serialized.includes('sessionToken'), false);
    assert.equal(serialized.includes('question'), false);
    clearPrepDrafts('alice');
    assert.equal(readPrepDraft('alice', 'session'), null);
    assert.equal(readPrepDraft('bob', 'session').answers.q, 'C');
  } finally { delete global.sessionStorage; }
});

test('mobile exam unavailable storage is reported, not treated as persisted', async () => {
  const { writePrepDraft, readPrepDraft } = await helpers;
  global.sessionStorage = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  try { assert.equal(writePrepDraft('a', 's', {}), false); assert.equal(readPrepDraft('a', 's'), null); }
  finally { delete global.sessionStorage; }
});
