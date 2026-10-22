'use strict';

const { qualitySummary } = require('./job-quality');

function initializeOperations(platform) {
  if (platform._operationsReady) return;
  platform.store.db.exec(`CREATE TABLE IF NOT EXISTS product_activity_days (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    day TEXT NOT NULL, kind TEXT NOT NULL, PRIMARY KEY(user_id,day,kind)
  ); CREATE INDEX IF NOT EXISTS product_activity_date ON product_activity_days(day,kind);`);
  platform._operationsReady = true;
}

function activityKind(req) {
  if (req.method === 'GET' && ['/auth/me', '/dashboard', '/jobs', '/prep/library'].includes(req.path)) return 'active';
  if (req.method === 'POST' && req.path === '/prep/attempts') return 'practice';
  if (req.method === 'POST' && /^\/exams\/sessions\/[^/]+\/submit$/.test(req.path)) return 'exam';
  if (req.method === 'PUT' && /^\/me\/jobs\//.test(req.path)) return 'job_action';
  if (req.method === 'PUT' && req.path === '/me/profile') return 'profile';
  return '';
}

function registerOperationsRoutes(router, { platform, requireAuth }) {
  initializeOperations(platform);
  // Only first-party daily activity categories, no IP, fingerprint, full URL or form content.
  router.use((req, res, next) => {
    const kind = activityKind(req);
    if (kind) res.once('finish', () => {
      if (res.statusCode >= 400 || !req.productUser || req.productUser.role !== 'user' || !platform.store.db) return;
      try {
        const day = new Date(platform.clock() + 8 * 3600000).toISOString().slice(0, 10);
        platform.store.db.prepare('INSERT OR IGNORE INTO product_activity_days VALUES(?,?,?)').run(req.productUser.id, day, kind);
      } catch (_) { /* Analytics must never fail a business request or a deleted account. */ }
    });
    next();
  });
  router.get('/admin/operations', requireAuth, (req, res, next) => {
    try {
      platform.requireRole(req.productUser, ['admin']);
      const db = platform.store.db;
      const since = new Date(platform.clock() - 30 * 86400000).toISOString().slice(0, 10);
      const recent = new Date(platform.clock() - 7 * 86400000).toISOString().slice(0, 10);
      const one = sql => Number(db.prepare(sql).get().n);
      const total = one("SELECT COUNT(*) n FROM users WHERE role='user' AND status='active'");
      const profile = one("SELECT COUNT(*) n FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.role='user' AND u.status='active' AND (p.majors_json<>'[]' OR p.target_roles_json<>'[]')");
      const jobActions = one("SELECT COUNT(DISTINCT s.user_id) n FROM job_states s JOIN users u ON u.id=s.user_id WHERE u.role='user'");
      const practiced = one("SELECT COUNT(DISTINCT p.user_id) n FROM prep_attempts p JOIN users u ON u.id=p.user_id WHERE u.role='user'");
      const paid = db.prepare("SELECT COUNT(*) n FROM subscriptions s JOIN users u ON u.id=s.user_id WHERE u.role='user' AND s.plan_id<>'free' AND s.status='active' AND (s.current_period_end IS NULL OR s.current_period_end>?)").get(new Date(platform.clock()).toISOString()).n;
      const days = db.prepare('SELECT day,kind,COUNT(*) users FROM product_activity_days WHERE day>=? GROUP BY day,kind ORDER BY day').all(since);
      const active7 = db.prepare('SELECT COUNT(DISTINCT user_id) n FROM product_activity_days WHERE day>=?').get(recent).n;
      const cohorts = db.prepare(`SELECT date(u.created_at,'+8 hours') cohort,COUNT(DISTINCT u.id) registered,
        COUNT(DISTINCT CASE WHEN a.day=date(u.created_at,'+8 hours','+1 day') THEN u.id END) returnedNextDay
        FROM users u LEFT JOIN product_activity_days a ON a.user_id=u.id
        WHERE u.role='user' AND date(u.created_at,'+8 hours')>=? GROUP BY cohort ORDER BY cohort`).all(since);
      res.json({ ok: true, operations: {
        timeZone: 'Asia/Shanghai', generatedAt: new Date(platform.clock()).toISOString(),
        users: { total, withProfile: profile, withJobActions: jobActions, withPractice: practiced, activeMemberships: paid, active7Days: active7 },
        dailyActivity: days, cohorts,
        notes: ['活跃记录从此版本上线后开始累积，历史缺失不等于用户未活跃。', '漏斗是当前账户的累计覆盖，不代表同一时间段内的严格因果转化。', '运营统计不记录 IP、设备指纹或输入正文。'],
        dataQuality: qualitySummary(platform._catalogJobs(), platform.clock()),
        ai: platform.personalAi?.adminSummary(req.productUser) || null,
      } });
    } catch (error) { next(error); }
  });
}

module.exports = { initializeOperations, registerOperationsRoutes, activityKind };
