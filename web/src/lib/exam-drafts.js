const PREFIX = 'zhilu-exam-draft:v2:';
const clearedUsers = new Set();
export function enableExamDrafts(userId) { clearedUsers.delete(userId); }
export const draftKey = (userId, sessionId) => `${PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(sessionId)}`;
export function readExamDraft(userId, sessionId) {
  try {
    const value = JSON.parse(localStorage.getItem(draftKey(userId, sessionId)) || 'null');
    return value?.userId === userId && value?.sessionId === sessionId ? value : null;
  } catch { return null; }
}
export function writeExamDraft(userId, sessionId, progress) {
  if (clearedUsers.has(userId)) return true;
  try { localStorage.setItem(draftKey(userId, sessionId), JSON.stringify({ ...progress, userId, sessionId, savedAt: Date.now() })); return true; } catch { return false; }
}
export function removeExamDraft(userId, sessionId) { try { localStorage.removeItem(draftKey(userId, sessionId)); } catch { /* Storage may be disabled. */ } }
export function clearExamDrafts(userId) {
  clearedUsers.add(userId);
  try {
    const prefix = `${PREFIX}${encodeURIComponent(userId)}:`;
    Object.keys(localStorage).filter(key => key.startsWith(prefix)).forEach(key => localStorage.removeItem(key));
  } catch { /* Storage may be disabled. */ }
}
