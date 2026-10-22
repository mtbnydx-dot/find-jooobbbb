'use strict';

const crypto = require('node:crypto');
const { initializeContent, normalizeDraft } = require('./content-admin');

const MAX_IMPORT_RECORDS = 200;
const normalizeText = value => String(value || '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function fail(message, code = 'CONTENT_IMPORT_INVALID') {
  const error = new Error(message); error.statusCode = 400; error.code = code; throw error;
}

// Identity deliberately excludes answer, source and track: a changed answer is a
// conflict, not a new question, and another year's citation is not another item.
function questionFingerprint(question) {
  return digest([question.type, normalizeText(question.prompt), (question.options || []).map(normalizeText).sort()]);
}

function answerFingerprint(question) {
  if (question.type === 'short') {
    return digest([(question.answer.keywords || []).map(normalizeText).sort(), normalizeText(question.answer.sample)]);
  }
  return digest(question.type === 'multi' ? question.answer.map(normalizeText).sort() : normalizeText(question.answer));
}

function validateRecord(service, record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail('每条记录必须是题目对象');
  if (!record.contentKind) fail('请明确来源类别 contentKind，不推测外来题目的来源');
  const draft = normalizeDraft({ ...record, sourceType: record.sourceType || 'unverified' });
  if (!draft.prompt) fail('题干不能为空');
  if (!service.db.prepare('SELECT id FROM prep_tracks WHERE id=? AND active=1').get(draft.trackId)) fail('请选择有效的备考路径');
  if (draft.type === 'short') {
    if (!draft.answer.sample || !draft.answer.keywords.length) fail('简答题需要参考回答和评分关键词');
    if (new Set(draft.answer.keywords.map(normalizeText)).size !== draft.answer.keywords.length) fail('评分关键词不能重复');
  } else {
    if (draft.options.length < 2 || new Set(draft.options.map(normalizeText)).size !== draft.options.length) fail('至少需要两个互不重复的选项');
    const answers = draft.type === 'multi' ? draft.answer : [draft.answer];
    if (!answers.length || new Set(answers).size !== answers.length || answers.some(answer => !draft.options.includes(answer))) fail('正确答案必须与选项文字一致且不能重复');
  }
  return draft;
}

function preview(service, records) {
  const known = new Map();
  for (const stored of service.db.prepare('SELECT id,draft_json,published_json FROM content_questions').all()) {
    for (const [state, json] of [['draft', stored.draft_json], ['published', stored.published_json]]) {
      if (!json) continue;
      const question = JSON.parse(json);
      const fingerprint = questionFingerprint(question);
      if (!known.has(fingerprint)) known.set(fingerprint, []);
      known.get(fingerprint).push({ id: stored.id, state, answer: answerFingerprint(question) });
    }
  }

  const groups = new Map();
  const rows = records.map((record, index) => {
    try {
      const draft = validateRecord(service, record);
      const row = { index, status: 'ready', fingerprint: questionFingerprint(draft), draft };
      if (!groups.has(row.fingerprint)) groups.set(row.fingerprint, []);
      groups.get(row.fingerprint).push(row);
      return row;
    } catch (error) {
      if (error.statusCode !== 400) throw error;
      return { index, status: 'invalid', reason: error.message, code: error.code };
    }
  });

  for (const [fingerprint, group] of groups) {
    const matches = known.get(fingerprint) || [];
    const answers = new Set([...matches.map(item => item.answer), ...group.map(row => answerFingerprint(row.draft))]);
    const existingIds = [...new Set(matches.map(item => item.id))];
    if (answers.size > 1) {
      for (const row of group) Object.assign(row, { status: 'conflict', existingIds,
        relatedRows: group.filter(other => other !== row).map(other => other.index), reason: '同题干、同选项存在不同答案，请人工核对后重新导入' });
    } else if (matches.length) {
      for (const row of group) Object.assign(row, { status: 'duplicate', existingIds,
        reason: '已有相同题目，跳过且不覆盖已有内容或来源' });
    } else {
      for (const row of group.slice(1)) Object.assign(row, { status: 'duplicate', duplicateOf: group[0].index,
        reason: '与本批前面的题目重复，仅保留第一条' });
    }
  }
  const summary = { total: rows.length, ready: 0, duplicate: 0, conflict: 0, invalid: 0, created: 0, skipped: 0 };
  for (const row of rows) summary[row.status]++;
  return { rows, summary, canImport: !summary.invalid && !summary.conflict };
}

function importContentQuestions(platform, actor, input = {}) {
  platform.requireRole(actor, ['admin', 'content_editor']);
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('导入参数应为对象');
  if (!Array.isArray(input.records) || input.records.length < 1 || input.records.length > MAX_IMPORT_RECORDS) fail(`每批需要 1–${MAX_IMPORT_RECORDS} 道题目`);
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') fail('dryRun 必须为布尔值');
  const dryRun = input.dryRun !== false;
  const service = initializeContent(platform);
  if (dryRun) return { dryRun: true, committed: false, ...preview(service, input.records) };

  // Revalidate and compare under the same write transaction; no preview token or
  // client-provided fingerprint can bypass validation or the duplicate check.
  return service.transaction(() => {
    const result = { dryRun: false, committed: false, ...preview(service, input.records) };
    if (!result.canImport) return result;
    for (const row of result.rows) {
      if (row.status !== 'ready') continue;
      const created = service.createQuestion(actor, { ...row.draft, changeNote: '批量导入草稿，未自动发布' });
      row.createdId = created.id;
      result.summary.created++;
    }
    result.summary.skipped = result.summary.duplicate;
    result.committed = true;
    return result;
  });
}

function registerContentImportRoutes(router, { platform, requireAuth }) {
  router.post('/admin/content/import', requireAuth, (req, res, next) => {
    try { res.json({ ok: true, ...importContentQuestions(platform, req.productUser, req.body) }); }
    catch (error) { next(error); }
  });
}

module.exports = { MAX_IMPORT_RECORDS, questionFingerprint, importContentQuestions, registerContentImportRoutes };
