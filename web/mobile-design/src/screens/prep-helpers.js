export const sourceLabels = { original_mock: '原创模拟', official_sample: '官方样题', past_paper: '真题' };
export const hasAnswer = value => Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null && String(value).trim() !== '';
export const optionValue = (option, index) => String(typeof option === 'object' ? option.value ?? index : index);
export const optionText = option => typeof option === 'string' ? option : option?.text || option?.label || '';
export function chooseAnswer(question, previous, value) {
  if (question.type !== 'multi') return value;
  const values = Array.isArray(previous) ? previous.map(String) : [];
  return values.includes(value) ? values.filter(item => item !== value) : [...values, value];
}
export function referenceText(value) {
  if (Array.isArray(value)) return value.join('、');
  if (value && typeof value === 'object') return value.sample || (value.keywords ? `关键词：${value.keywords.join('、')}` : JSON.stringify(value));
  return String(value ?? '未作答');
}
export function answerText(question, value) {
  const options = question?.options || [];
  if (!options.length) return referenceText(value);
  const render = item => {
    const index = options.findIndex((option, i) => optionValue(option, i) === String(item));
    return index < 0 ? String(item) : `${String.fromCharCode(65 + index)}. ${optionText(options[index])}`;
  };
  return Array.isArray(value) ? value.map(render).join('；') : hasAnswer(value) ? render(value) : '未作答';
}
export const progressOf = value => ({ answers: value?.answers || {}, flagged: value?.flagged || [], currentIndex: Number(value?.currentIndex) || 0 });
export const elapsedAt = (seconds, anchor, now = Date.now()) => Math.max(0, Number(seconds) || 0) + Math.max(0, Math.floor((now - anchor) / 1000));
export function sameProgress(left, right) {
  const canonical = value => {
    const item = progressOf(value);
    return JSON.stringify({ ...item, answers: Object.fromEntries(Object.entries(item.answers).sort(([a], [b]) => a.localeCompare(b))), flagged: [...item.flagged].sort() });
  };
  return canonical(left) === canonical(right);
}
const PREFIX = 'zhilu-mobile-exam:v1:';
export const prepDraftKey = (userId, sessionId) => `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
export function readPrepDraft(userId, sessionId) {
  try {
    const item = JSON.parse(sessionStorage.getItem(prepDraftKey(userId, sessionId)) || 'null');
    return item?.userId === userId && item?.sessionId === sessionId ? item : null;
  } catch { return null; }
}
export function writePrepDraft(userId, sessionId, progress) {
  try {
    sessionStorage.setItem(prepDraftKey(userId, sessionId), JSON.stringify({ ...progressOf(progress), elapsedSeconds: progress.elapsedSeconds, expectedVersion: progress.expectedVersion, dirty: Boolean(progress.dirty), savedAt: Date.now(), userId, sessionId }));
    return true;
  } catch { return false; }
}
export function removePrepDraft(userId, sessionId) { try { sessionStorage.removeItem(prepDraftKey(userId, sessionId)); } catch { /* Storage may be disabled. */ } }
export function clearPrepDrafts(userId) {
  try { Object.keys(sessionStorage).filter(key => key.startsWith(`${PREFIX}${encodeURIComponent(userId)}:`)).forEach(key => sessionStorage.removeItem(key)); } catch { /* Storage may be disabled. */ }
}
