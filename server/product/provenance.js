'use strict';

const CONTENT_KINDS = Object.freeze({ original_mock: '原创模拟', official_sample: '官方样题', past_paper: '历年真题' });
const XINGCE_SECTIONS = Object.freeze([
  { value: 'political_theory', label: '政治理论' },
  { value: 'general_knowledge', label: '常识判断' },
  { value: 'verbal', label: '言语理解与表达' },
  { value: 'quantitative', label: '数量关系' },
  { value: 'reasoning', label: '判断推理' },
  { value: 'data_analysis', label: '资料分析' },
]);
const EXAM_TYPES = Object.freeze([
  { value: 'xingce', label: '公务员行测', sections: XINGCE_SECTIONS },
  { value: 'vocational', label: '事业单位职测', sections: [] },
  { value: 'job_general', label: '通用求职练习', sections: [{ value: 'general', label: '通用能力' }] },
]);

function invalid(message) {
  const error = new Error(message); error.statusCode = 400; error.code = 'CONTENT_PROVENANCE_INVALID'; throw error;
}
function shortText(value, name, max = 200) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string' || value.includes('\0') || value.length > max) invalid(`${name}格式错误或过长`);
  return value.trim();
}

// Editorial drafts may omit evidence, but publication checks it separately. The
// default describes the existing original catalog, never an inferred past paper.
function normalizeProvenance(value = {}) {
  const contentKind = shortText(value.contentKind || 'original_mock', '来源类别', 40);
  if (!Object.hasOwn(CONTENT_KINDS, contentKind)) invalid('来源类别无效');
  const examType = shortText(value.examType || 'job_general', '考试类别', 80);
  if (!EXAM_TYPES.some(item => item.value === examType)) invalid('考试类别无效');
  const section = shortText(value.section || (examType === 'job_general' ? 'general' : ''), '考试板块', 80);
  if (examType === 'xingce' && section && !XINGCE_SECTIONS.some(item => item.value === section)) invalid('行测板块无效');
  if (section && !/^[a-z][a-z0-9_]*$/.test(section)) invalid('考试板块标识无效');
  if (value.year !== undefined && value.year !== null && typeof value.year !== 'number' && typeof value.year !== 'string') invalid('年份应为 1900-2100 的整数');
  const year = value.year === undefined || value.year === null || value.year === '' ? null : Number(value.year);
  if (year !== null && (!Number.isInteger(year) || year < 1900 || year > 2100)) invalid('年份应为 1900-2100 的整数');
  return {
    contentKind, examType, section, year,
    region: shortText(value.region, '地区', 100),
    questionNumber: shortText(value.questionNumber, '原卷题号', 80),
    sourceTitle: shortText(value.sourceTitle, '来源标题', 500),
    sourcePublisher: shortText(value.sourcePublisher, '发布机构', 200),
    sourceUrl: shortText(value.sourceUrl, '来源链接', 2000),
    sourceEvidence: shortText(value.sourceEvidence, '来源核验依据', 5000),
  };
}

function safePublicUrl(value) {
  if (!value) return '';
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch (_) { return ''; }
}

function publicProvenance(value = {}, { legacySnapshot = false } = {}) {
  const source = value.provenance && typeof value.provenance === 'object' ? value.provenance : value;
  // Historical snapshots without provenance must not inherit today's metadata.
  if (source.recorded === false || (legacySnapshot && !source.contentKind)) return {
    contentKind: null, label: '历史记录未记录来源', examType: '', section: '', year: null,
    region: '', questionNumber: '', sourceTitle: '', sourcePublisher: '', sourceUrl: '', recorded: false,
  };
  const contentKind = Object.hasOwn(CONTENT_KINDS, source.contentKind) ? source.contentKind : 'original_mock';
  return {
    contentKind, label: CONTENT_KINDS[contentKind], examType: source.examType || 'job_general',
    section: source.section || (source.examType && source.examType !== 'job_general' ? '' : 'general'),
    year: Number.isInteger(source.year) ? source.year : null, region: source.region || '',
    questionNumber: source.questionNumber || '', sourceTitle: source.sourceTitle || '',
    sourcePublisher: source.sourcePublisher || '', sourceUrl: safePublicUrl(source.sourceUrl), recorded: true,
  };
}

function questionProvenance(value, options) {
  const provenance = publicProvenance(value, options);
  return { contentKind: provenance.contentKind, examType: provenance.examType, section: provenance.section, provenance };
}

// Parameterised query construction is shared by count and page queries so the
// cursor traverses the full permitted library, not a first-200-per-track sample.
function prepQuestionFilter({ trackId = '', trackIds, examType = '', section = '', contentKind = '' } = {}) {
  const clauses = ['active=1'], params = [];
  if (trackId) { clauses.push('track_id=?'); params.push(String(trackId)); }
  if (Array.isArray(trackIds)) {
    if (!trackIds.length) clauses.push('0=1');
    else { clauses.push(`track_id IN (${trackIds.map(() => '?').join(',')})`); params.push(...trackIds.map(String)); }
  }
  for (const [key, value, fallback] of [['examType', examType, 'job_general'], ['section', section, 'general'], ['contentKind', contentKind, 'original_mock']]) {
    if (value) { clauses.push(`COALESCE(json_extract(provenance_json,'$.${key}'),'${fallback}')=?`); params.push(String(value)); }
  }
  return { where: clauses.join(' AND '), params };
}

module.exports = { CONTENT_KINDS, EXAM_TYPES, XINGCE_SECTIONS, normalizeProvenance, publicProvenance, questionProvenance, safePublicUrl, prepQuestionFilter };
