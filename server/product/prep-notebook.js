'use strict';

const { contractError } = require('./mobile-contract');
const fail = (message, status = 400, code = 'INVALID_INPUT') => { throw contractError(message, status, code); };

function initializeNotebook(platform) {
  platform.store.initialize();
  platform.store.db.exec(`CREATE TABLE IF NOT EXISTS prep_bookmarks (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    question_id TEXT NOT NULL REFERENCES prep_questions(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY(user_id,question_id)
  ); CREATE INDEX IF NOT EXISTS prep_bookmarks_user_date ON prep_bookmarks(user_id,created_at DESC,question_id);`);
  return platform.store.db;
}

function questionForUser(platform, user, id, includeAnswer = false) {
  platform.requireRole(user, ['user', 'content_editor', 'admin']);
  const question = platform.store.getPrepQuestion(id, { includeAnswer });
  if (!question) fail('题目不存在或已下架', 404, 'QUESTION_NOT_FOUND');
  platform._assertTrackAccess(user, question.trackId);
  return question;
}

function decodeCursor(value, type, userId) {
  if (!value) return null;
  try {
    if (typeof value !== 'string' || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (parsed.v !== 1 || parsed.t !== type || parsed.u !== userId || typeof parsed.at !== 'string' || typeof parsed.id !== 'string' || !Number.isFinite(Date.parse(parsed.at)) || parsed.id.length > 200) throw new Error();
    return parsed;
  } catch { fail('分页位置已无效，请从第一页重新加载', 400, 'INVALID_CURSOR'); }
}

function listNotebook(platform, user, type, query = {}) {
  const db = initializeNotebook(platform);
  platform.requireRole(user, ['user', 'content_editor', 'admin']);
  const tracks = platform.listPrepTracks(user).filter(track => !track.locked).map(track => track.id);
  const cursor = decodeCursor(query.cursor, type, user.id);
  const limit = Math.max(1, Math.min(100, Math.floor(Number(query.limit) || 24)));
  if (!tracks.length) return { items: [], total: 0, nextCursor: '', limit };
  const table = type === 'wrong' ? 'prep_progress' : 'prep_bookmarks';
  const at = type === 'wrong' ? 'updated_at' : 'created_at';
  const where = `n.user_id=? AND q.active=1 AND q.track_id IN (${tracks.map(() => '?').join(',')})${type === 'wrong' ? ' AND n.latest_score<100' : ''}`;
  const params = [user.id, ...tracks];
  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} n JOIN prep_questions q ON q.id=n.question_id WHERE ${where}`).get(...params).n);
  const after = cursor ? ` AND (n.${at}<? OR (n.${at}=? AND n.question_id>?))` : '';
  const rows = db.prepare(`SELECT n.* FROM ${table} n JOIN prep_questions q ON q.id=n.question_id WHERE ${where}${after} ORDER BY n.${at} DESC,n.question_id ASC LIMIT ?`)
    .all(...params, ...(cursor ? [cursor.at, cursor.at, cursor.id] : []), limit + 1);
  const page = rows.slice(0, limit);
  const items = page.map(row => ({ questionId: row.question_id,
    ...(type === 'wrong' ? { latestScore: Number(row.latest_score), attempts: Number(row.attempts), updatedAt: row.updated_at } : { savedAt: row.created_at }),
    question: platform.store.getPrepQuestion(row.question_id, { includeAnswer: type === 'wrong' }),
  }));
  const last = page[page.length - 1];
  return { items, total, limit, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, t: type, u: user.id, at: last[at], id: last.question_id })).toString('base64url') : '' };
}

function setBookmark(platform, user, id, saved) {
  const db = initializeNotebook(platform);
  platform.requireRole(user, ['user', 'content_editor', 'admin']);
  if (typeof saved !== 'boolean') fail('saved 必须为布尔值');
  if (!id || typeof id !== 'string' || id.length > 200) fail('题目编号无效');
  if (saved) {
    questionForUser(platform, user, id);
    // Setting state is idempotent; repeated requests do not reorder the collection.
    db.prepare('INSERT OR IGNORE INTO prep_bookmarks(user_id,question_id,created_at) VALUES(?,?,?)').run(user.id, id, new Date(platform.clock()).toISOString());
  } else db.prepare('DELETE FROM prep_bookmarks WHERE user_id=? AND question_id=?').run(user.id, id);
  return { questionId: id, saved };
}

function exportNotebook(platform, user) {
  return initializeNotebook(platform).prepare('SELECT question_id AS questionId,created_at AS savedAt FROM prep_bookmarks WHERE user_id=? ORDER BY created_at,question_id').all(user.id);
}

function registerNotebookRoutes(router, { platform, requireAuth }) {
  const db = initializeNotebook(platform);
  const route = handler => (req, res, next) => { try { res.json({ ok: true, ...handler(req) }); } catch (error) { next(error); } };
  router.get('/me/prep/bookmarks', requireAuth, route(req => listNotebook(platform, req.productUser, 'bookmarks', req.query)));
  router.get('/me/prep/wrong', requireAuth, route(req => listNotebook(platform, req.productUser, 'wrong', req.query)));
  router.get('/me/prep/questions/:id', requireAuth, route(req => ({
    question: questionForUser(platform, req.productUser, req.params.id),
    bookmarked: Boolean(db.prepare('SELECT 1 FROM prep_bookmarks WHERE user_id=? AND question_id=?').get(req.productUser.id, req.params.id)),
  })));
  router.get('/me/prep/bookmarks/:id', requireAuth, route(req => {
    questionForUser(platform, req.productUser, req.params.id);
    return { questionId: req.params.id, saved: Boolean(db.prepare('SELECT 1 FROM prep_bookmarks WHERE user_id=? AND question_id=?').get(req.productUser.id, req.params.id)) };
  }));
  router.put('/me/prep/bookmarks/:id', requireAuth, route(req => setBookmark(platform, req.productUser, req.params.id, req.body.saved)));
}

module.exports = { initializeNotebook, listNotebook, setBookmark, questionForUser, exportNotebook, registerNotebookRoutes };
