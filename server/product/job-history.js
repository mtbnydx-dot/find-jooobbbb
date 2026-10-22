'use strict';

// A private, last-seen copy of public facts keeps saved opportunities useful after
// their source disappears. Never archive legacy notes, global AI, or raw records.
const FIELDS = ['id', 'company', 'companyName', 'position', 'title', 'role', 'nature', 'industry', 'location', 'locations', 'deadline', 'exam', 'degree', 'educationLevel', 'major', 'majors', 'audience', 'batch', 'experience', 'workMode', 'employmentType', 'salary', 'salaryText', 'salaryCurrency', 'salaryMin', 'salaryMax', 'salaryPeriod', 'salaryMonths', 'benefits', 'requirements', 'description', 'skills', 'skillTags', 'url', 'notice', 'sourceNote', 'source', 'sourceName', 'sourceNames', 'origins', 'sourceUrl', 'publishedAt', 'firstSeenAt', 'lastSeenAt'];

function initializeHistory(platform) {
  if (platform._jobHistoryInitialized) return;
  platform.store.db.exec(`CREATE TABLE IF NOT EXISTS personal_job_history (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_id TEXT NOT NULL, facts_json TEXT NOT NULL, captured_at TEXT NOT NULL,
    PRIMARY KEY(user_id,job_id)
  )`);
  platform._jobHistoryInitialized = true;
}

function rememberJob(platform, user, job) {
  if (!user?.id || !job?.id || job.available === false) return;
  initializeHistory(platform);
  const facts = {};
  for (const key of [...FIELDS, 'pay']) {
    const value = job[key];
    if (typeof value === 'string') facts[key] = value.slice(0, 12000);
    else if (typeof value === 'number' && Number.isFinite(value)) facts[key] = value;
    else if (Array.isArray(value)) facts[key] = value.filter(item => typeof item === 'string').slice(0, 100).map(item => item.slice(0, 2000));
  }
  platform.store.db.prepare(`INSERT INTO personal_job_history VALUES(?,?,?,?)
    ON CONFLICT(user_id,job_id) DO UPDATE SET facts_json=excluded.facts_json,captured_at=excluded.captured_at`)
    .run(user.id, String(job.id), JSON.stringify(facts), new Date(platform.clock()).toISOString());
}

function historicalJob(platform, user, jobId) {
  if (!user?.id) return null;
  initializeHistory(platform);
  const row = platform.store.db.prepare('SELECT facts_json,captured_at FROM personal_job_history WHERE user_id=? AND job_id=?').get(user.id, String(jobId));
  if (!row) return null;
  return { ...JSON.parse(row.facts_json), id: String(jobId), active: '0', available: false, historical: true, capturedAt: row.captured_at };
}

function remapHistory(platform, aliases) {
  initializeHistory(platform);
  for (const [oldId, newId] of Object.entries(aliases || {})) {
    if (!oldId || !newId || oldId === newId) continue;
    // Preserve the newer copy if both source IDs were saved by the same person.
    const rows = platform.store.db.prepare('SELECT * FROM personal_job_history WHERE job_id=?').all(oldId);
    for (const row of rows) {
      const facts = { ...JSON.parse(row.facts_json), id: newId };
      platform.store.db.prepare(`INSERT INTO personal_job_history VALUES(?,?,?,?)
        ON CONFLICT(user_id,job_id) DO UPDATE SET facts_json=excluded.facts_json,captured_at=excluded.captured_at
        WHERE excluded.captured_at>personal_job_history.captured_at`).run(row.user_id, newId, JSON.stringify(facts), row.captured_at);
    }
    platform.store.db.prepare('DELETE FROM personal_job_history WHERE job_id=?').run(oldId);
  }
}

function exportHistory(platform, user) {
  initializeHistory(platform);
  return platform.store.db.prepare('SELECT job_id,facts_json,captured_at FROM personal_job_history WHERE user_id=? ORDER BY captured_at,job_id').all(user.id)
    .map(row => ({ jobId: row.job_id, facts: JSON.parse(row.facts_json), capturedAt: row.captured_at }));
}

module.exports = { rememberJob, historicalJob, remapHistory, exportHistory };
