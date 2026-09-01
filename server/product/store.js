'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const { EXAM_PACKS, PLANS, PREP_QUESTIONS, PREP_TRACKS } = require('./catalog');

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function parseJson(value, fallback) {
  try { return JSON.parse(value); } catch (_) { return fallback; }
}

function publicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function profileFromRow(row) {
  if (!row) return null;
  const extras = parseJson(row.extras_json, {});
  const majors = parseJson(row.majors_json, []);
  const targetRoles = parseJson(row.target_roles_json, []);
  const locations = parseJson(row.locations_json, []);
  const industries = parseJson(row.industries_json, []);
  return {
    ...extras,
    userId: row.user_id,
    displayName: row.display_name || extras.displayName || '',
    majors,
    major: extras.major || majors[0] || '',
    targetRoles,
    locations,
    preferredLocations: locations,
    industries,
    targetIndustries: industries,
    salaryCurrency: row.salary_currency,
    currency: row.salary_currency,
    salaryMin: row.salary_min === null ? null : Number(row.salary_min),
    salaryMax: row.salary_max === null ? null : Number(row.salary_max),
    salaryPeriod: row.salary_period,
    version: Number(row.version),
    profileHash: row.profile_hash,
    updatedAt: row.updated_at,
  };
}

function stateFromRow(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    jobId: row.job_id,
    status: row.status,
    saved: Boolean(row.saved),
    favorite: Boolean(row.favorite),
    hidden: Boolean(row.hidden),
    note: row.note,
    nextAction: row.next_action || '',
    appliedAt: row.applied_at || '',
    followUpAt: row.follow_up_at || '',
    updatedAt: row.updated_at,
  };
}

function prepTrackFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    order: Number(row.sort_order),
    title: row.title,
    icon: row.icon,
    description: row.description,
    majors: parseJson(row.majors_json, []),
    roles: parseJson(row.roles_json, []),
    difficulty: row.difficulty,
  };
}

function prepQuestionFromRow(row, { includeAnswer = false } = {}) {
  if (!row) return null;
  const question = {
    id: row.id,
    trackId: row.track_id,
    type: row.type,
    difficulty: row.difficulty,
    prompt: row.prompt,
    options: parseJson(row.options_json, []),
  };
  if (includeAnswer) {
    question.answer = parseJson(row.answer_json, null);
    question.explanation = row.explanation;
  }
  return question;
}

function examPackFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    order: Number(row.sort_order),
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    company: row.company,
    roles: parseJson(row.roles_json, []),
    majors: parseJson(row.majors_json, []),
    year: Number(row.year),
    type: row.type,
    difficulty: row.difficulty,
    durationMinutes: Number(row.duration_minutes),
    questionIds: parseJson(row.question_ids_json, []),
    sourceLabel: row.source_label,
    legacyUrl: row.legacy_url,
    featured: Boolean(row.featured),
  };
}

function examSessionFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    packId: row.pack_id,
    status: row.status,
    answers: parseJson(row.answers_json, {}),
    flagged: parseJson(row.flagged_json, []),
    currentIndex: Number(row.current_index),
    elapsedSeconds: Number(row.elapsed_seconds),
    score: row.score === null ? null : Number(row.score),
    correctCount: row.correct_count === null ? null : Number(row.correct_count),
    totalQuestions: Number(row.total_questions),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    submittedAt: row.submitted_at || '',
  };
}

class ProductStore {
  constructor({ dataDir, clock = () => Date.now() } = {}) {
    if (!dataDir) throw new Error('ProductStore 需要 dataDir');
    this.dataDir = path.resolve(dataDir);
    this.file = path.join(this.dataDir, 'product.db');
    this.clock = clock;
    this.db = null;
  }

  initialize() {
    if (this.db) return this;
    fs.mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','content_editor','admin')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended','deleted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY,
        majors_json TEXT NOT NULL DEFAULT '[]',
        target_roles_json TEXT NOT NULL DEFAULT '[]',
        locations_json TEXT NOT NULL DEFAULT '[]',
        industries_json TEXT NOT NULL DEFAULT '[]',
        salary_currency TEXT NOT NULL DEFAULT 'CNY',
        salary_min REAL,
        salary_max REAL,
        salary_period TEXT NOT NULL DEFAULT 'month',
        extras_json TEXT NOT NULL DEFAULT '{}',
        version INTEGER NOT NULL DEFAULT 1,
        profile_hash TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        tagline TEXT NOT NULL,
        price_monthly INTEGER NOT NULL,
        currency TEXT NOT NULL,
        entitlements_json TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        user_id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        source TEXT NOT NULL DEFAULT 'free',
        current_period_start TEXT NOT NULL,
        current_period_end TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(plan_id) REFERENCES plans(id)
      );
      CREATE TABLE IF NOT EXISTS usage_counters (
        user_id TEXT NOT NULL,
        entitlement_key TEXT NOT NULL,
        period_key TEXT NOT NULL,
        used INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, entitlement_key, period_key),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS job_states (
        user_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'not_applied',
        saved INTEGER NOT NULL DEFAULT 0,
        favorite INTEGER NOT NULL DEFAULT 0,
        hidden INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        next_action TEXT NOT NULL DEFAULT '',
        applied_at TEXT,
        follow_up_at TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, job_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS user_custom_jobs (
        user_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        job_json TEXT NOT NULL,
        source_file TEXT NOT NULL DEFAULT '',
        source_hash TEXT NOT NULL DEFAULT '',
        migrated_at TEXT NOT NULL,
        PRIMARY KEY(user_id,job_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS user_custom_jobs_user_idx ON user_custom_jobs(user_id,migrated_at);
      CREATE INDEX IF NOT EXISTS job_states_pipeline_idx ON job_states(user_id, status, updated_at DESC);
      CREATE TABLE IF NOT EXISTS job_alias_intents (
        id TEXT PRIMARY KEY,
        aliases_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','applied')),
        created_at TEXT NOT NULL,
        applied_at TEXT
      );
      CREATE INDEX IF NOT EXISTS job_alias_intents_status_idx ON job_alias_intents(status, created_at);
      CREATE TABLE IF NOT EXISTS prep_tracks (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        icon TEXT NOT NULL,
        description TEXT NOT NULL,
        majors_json TEXT NOT NULL,
        roles_json TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS prep_questions (
        id TEXT PRIMARY KEY,
        track_id TEXT NOT NULL,
        type TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        prompt TEXT NOT NULL,
        options_json TEXT NOT NULL DEFAULT '[]',
        answer_json TEXT NOT NULL,
        explanation TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1,
        FOREIGN KEY(track_id) REFERENCES prep_tracks(id)
      );
      CREATE INDEX IF NOT EXISTS prep_questions_track_idx ON prep_questions(track_id, id);
      CREATE TABLE IF NOT EXISTS prep_attempts (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        response_json TEXT NOT NULL,
        score INTEGER NOT NULL,
        correct INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(question_id) REFERENCES prep_questions(id)
      );
      CREATE INDEX IF NOT EXISTS prep_attempts_user_idx ON prep_attempts(user_id, created_at DESC);
      CREATE TABLE IF NOT EXISTS prep_progress (
        user_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        best_score INTEGER NOT NULL DEFAULT 0,
        latest_score INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, question_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(question_id) REFERENCES prep_questions(id)
      );
      CREATE TABLE IF NOT EXISTS exam_packs (
        id TEXT PRIMARY KEY,
        sort_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        subtitle TEXT NOT NULL,
        description TEXT NOT NULL,
        company TEXT NOT NULL,
        roles_json TEXT NOT NULL DEFAULT '[]',
        majors_json TEXT NOT NULL DEFAULT '[]',
        year INTEGER NOT NULL,
        type TEXT NOT NULL,
        difficulty TEXT NOT NULL,
        duration_minutes INTEGER NOT NULL,
        question_ids_json TEXT NOT NULL DEFAULT '[]',
        source_label TEXT NOT NULL,
        legacy_url TEXT NOT NULL DEFAULT '',
        featured INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS exam_packs_active_idx ON exam_packs(active,sort_order,id);
      CREATE TABLE IF NOT EXISTS exam_sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'in_progress' CHECK(status IN ('in_progress','submitted','abandoned')),
        answers_json TEXT NOT NULL DEFAULT '{}',
        flagged_json TEXT NOT NULL DEFAULT '[]',
        current_index INTEGER NOT NULL DEFAULT 0,
        elapsed_seconds INTEGER NOT NULL DEFAULT 0,
        score INTEGER,
        correct_count INTEGER,
        total_questions INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        submitted_at TEXT,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(pack_id) REFERENCES exam_packs(id)
      );
      CREATE INDEX IF NOT EXISTS exam_sessions_user_idx ON exam_sessions(user_id,updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS exam_sessions_open_idx ON exam_sessions(user_id,pack_id) WHERE status='in_progress';
      CREATE TABLE IF NOT EXISTS exam_wrong_answers (
        user_id TEXT NOT NULL,
        question_id TEXT NOT NULL,
        pack_id TEXT NOT NULL,
        latest_response_json TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        last_wrong_at TEXT NOT NULL,
        mastered_at TEXT,
        PRIMARY KEY(user_id,question_id),
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY(question_id) REFERENCES prep_questions(id),
        FOREIGN KEY(pack_id) REFERENCES exam_packs(id)
      );
      CREATE INDEX IF NOT EXISTS exam_wrong_user_idx ON exam_wrong_answers(user_id,mastered_at,last_wrong_at DESC);
    `);
    const profileColumns = new Set(this.db.prepare('PRAGMA table_info(profiles)').all().map(row => row.name));
    if (!profileColumns.has('extras_json')) this.db.exec("ALTER TABLE profiles ADD COLUMN extras_json TEXT NOT NULL DEFAULT '{}'");
    const stateColumns = new Set(this.db.prepare('PRAGMA table_info(job_states)').all().map(row => row.name));
    if (!stateColumns.has('saved')) this.db.exec('ALTER TABLE job_states ADD COLUMN saved INTEGER NOT NULL DEFAULT 0');
    if (!stateColumns.has('next_action')) this.db.exec("ALTER TABLE job_states ADD COLUMN next_action TEXT NOT NULL DEFAULT ''");
    this._seedCatalog();
    return this;
  }

  _seedCatalog() {
    const planStatement = this.db.prepare(`INSERT INTO plans(id,name,tagline,price_monthly,currency,entitlements_json,active)
      VALUES(?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name,tagline=excluded.tagline,price_monthly=excluded.price_monthly,
      currency=excluded.currency,entitlements_json=excluded.entitlements_json,active=1`);
    const trackStatement = this.db.prepare(`INSERT INTO prep_tracks(id,sort_order,title,icon,description,majors_json,roles_json,difficulty,active)
      VALUES(?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order,title=excluded.title,icon=excluded.icon,
      description=excluded.description,majors_json=excluded.majors_json,roles_json=excluded.roles_json,difficulty=excluded.difficulty,active=1`);
    const questionStatement = this.db.prepare(`INSERT INTO prep_questions(id,track_id,type,difficulty,prompt,options_json,answer_json,explanation,active)
      VALUES(?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET track_id=excluded.track_id,type=excluded.type,difficulty=excluded.difficulty,
      prompt=excluded.prompt,options_json=excluded.options_json,answer_json=excluded.answer_json,explanation=excluded.explanation,active=1`);
    const examPackStatement = this.db.prepare(`INSERT INTO exam_packs
      (id,sort_order,title,subtitle,description,company,roles_json,majors_json,year,type,difficulty,duration_minutes,question_ids_json,source_label,legacy_url,featured,active)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)
      ON CONFLICT(id) DO UPDATE SET sort_order=excluded.sort_order,title=excluded.title,subtitle=excluded.subtitle,
      description=excluded.description,company=excluded.company,roles_json=excluded.roles_json,majors_json=excluded.majors_json,
      year=excluded.year,type=excluded.type,difficulty=excluded.difficulty,duration_minutes=excluded.duration_minutes,
      question_ids_json=excluded.question_ids_json,source_label=excluded.source_label,legacy_url=excluded.legacy_url,
      featured=excluded.featured,active=1`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const plan of PLANS) {
        planStatement.run(plan.id, plan.name, plan.tagline, plan.priceMonthly, plan.currency, JSON.stringify(plan.entitlements));
      }
      for (const track of PREP_TRACKS) {
        trackStatement.run(track.id, track.order, track.title, track.icon, track.description, JSON.stringify(track.majors), JSON.stringify(track.roles), track.difficulty);
      }
      for (const question of PREP_QUESTIONS) {
        questionStatement.run(question.id, question.trackId, question.type, question.difficulty, question.prompt,
          JSON.stringify(question.options || []), JSON.stringify(question.answer), question.explanation);
      }
      for (const pack of EXAM_PACKS) {
        examPackStatement.run(pack.id, pack.order, pack.title, pack.subtitle, pack.description, pack.company,
          JSON.stringify(pack.roles || []), JSON.stringify(pack.majors || []), pack.year, pack.type, pack.difficulty,
          pack.durationMinutes, JSON.stringify(pack.questionIds || []), pack.sourceLabel, pack.legacyUrl || '', pack.featured ? 1 : 0);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  close() {
    if (this.db) this.db.close();
    this.db = null;
  }

  createUser({ id, email, passwordHash, displayName, role = 'user' }) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT INTO users(id,email,password_hash,display_name,role,status,created_at,updated_at) VALUES(?,?,?,?,?,\'active\',?,?)')
        .run(id, email, passwordHash, displayName, role, timestamp, timestamp);
      this.db.prepare(`INSERT INTO profiles(user_id,profile_hash,updated_at) VALUES(?,?,?)`)
        .run(id, '', timestamp);
      this.db.prepare(`INSERT INTO subscriptions(user_id,plan_id,status,source,current_period_start,updated_at)
        VALUES(?,'free','active','free',?,?)`).run(id, timestamp, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return this.getUser(id);
  }

  getUser(id) {
    this.initialize();
    return publicUser(this.db.prepare('SELECT * FROM users WHERE id=?').get(String(id)));
  }

  getUserWithPasswordByEmail(email) {
    this.initialize();
    const row = this.db.prepare('SELECT * FROM users WHERE email=? COLLATE NOCASE').get(String(email));
    if (!row) return null;
    return { ...publicUser(row), passwordHash: row.password_hash };
  }

  listUsers({ limit = 100 } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare('SELECT * FROM users WHERE status<>\'deleted\' ORDER BY created_at DESC LIMIT ?').all(bounded).map(publicUser);
  }

  setUserRole(id, role) {
    this.initialize();
    const result = this.db.prepare('UPDATE users SET role=?,updated_at=? WHERE id=? AND status<>\'deleted\'')
      .run(role, nowIso(this.clock), String(id));
    return result.changes > 0 ? this.getUser(id) : null;
  }

  createSession({ id, userId, tokenHash, expiresAt }) {
    this.initialize();
    this.db.prepare('INSERT INTO sessions(id,user_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)')
      .run(id, userId, tokenHash, nowIso(this.clock), expiresAt);
  }

  sessionUser(tokenHash) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    const row = this.db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id
      WHERE s.token_hash=? AND s.revoked_at IS NULL AND s.expires_at>? AND u.status='active'`).get(String(tokenHash), timestamp);
    return publicUser(row);
  }

  revokeSession(tokenHash) {
    this.initialize();
    return this.db.prepare('UPDATE sessions SET revoked_at=? WHERE token_hash=? AND revoked_at IS NULL')
      .run(nowIso(this.clock), String(tokenHash)).changes > 0;
  }

  getProfile(userId) {
    this.initialize();
    return profileFromRow(this.db.prepare(`SELECT p.*,u.display_name FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=?`).get(String(userId)));
  }

  updateUserDisplayName(userId, displayName) {
    this.initialize();
    this.db.prepare('UPDATE users SET display_name=?,updated_at=? WHERE id=?')
      .run(String(displayName), nowIso(this.clock), String(userId));
    return this.getUser(userId);
  }

  updateProfile(userId, profile) {
    this.initialize();
    const existing = this.getProfile(userId);
    const version = Math.max(1, Number(existing?.version || 0) + 1);
    const timestamp = nowIso(this.clock);
    this.db.prepare(`INSERT INTO profiles
      (user_id,majors_json,target_roles_json,locations_json,industries_json,salary_currency,salary_min,salary_max,salary_period,extras_json,version,profile_hash,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET majors_json=excluded.majors_json,target_roles_json=excluded.target_roles_json,
      locations_json=excluded.locations_json,industries_json=excluded.industries_json,salary_currency=excluded.salary_currency,
      salary_min=excluded.salary_min,salary_max=excluded.salary_max,salary_period=excluded.salary_period,extras_json=excluded.extras_json,
      version=excluded.version,profile_hash=excluded.profile_hash,updated_at=excluded.updated_at`)
      .run(userId, JSON.stringify(profile.majors), JSON.stringify(profile.targetRoles), JSON.stringify(profile.locations),
        JSON.stringify(profile.industries), profile.salaryCurrency, profile.salaryMin, profile.salaryMax,
        profile.salaryPeriod, JSON.stringify(profile.extras || {}), version, profile.profileHash, timestamp);
    return this.getProfile(userId);
  }

  listPlans() {
    this.initialize();
    return this.db.prepare('SELECT * FROM plans WHERE active=1 ORDER BY price_monthly,id').all().map(row => ({
      id: row.id,
      name: row.name,
      tagline: row.tagline,
      priceMonthly: Number(row.price_monthly),
      currency: row.currency,
      entitlements: parseJson(row.entitlements_json, {}),
    }));
  }

  getPlan(id) {
    return this.listPlans().find(plan => plan.id === id) || null;
  }

  getUserPlan(userId) {
    this.initialize();
    const row = this.db.prepare(`SELECT p.*,s.status AS subscription_status,s.source AS subscription_source,
      s.current_period_start,s.current_period_end FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.user_id=?`).get(String(userId));
    if (!row) return this.getPlan('free');
    const expired = row.current_period_end && String(row.current_period_end) <= nowIso(this.clock);
    if (!['active', 'trialing'].includes(String(row.subscription_status)) || expired) {
      return {
        ...this.getPlan('free'),
        subscription: {
          status: row.subscription_status,
          source: row.subscription_source,
          currentPeriodStart: row.current_period_start,
          currentPeriodEnd: row.current_period_end || '',
        },
      };
    }
    return {
      id: row.id,
      name: row.name,
      tagline: row.tagline,
      priceMonthly: Number(row.price_monthly),
      currency: row.currency,
      entitlements: parseJson(row.entitlements_json, {}),
      subscription: {
        status: row.subscription_status,
        source: row.subscription_source,
        currentPeriodStart: row.current_period_start,
        currentPeriodEnd: row.current_period_end || '',
      },
    };
  }

  setUserPlan(userId, planId, source = 'manual') {
    this.initialize();
    if (!this.getUser(userId) || !this.getPlan(planId)) return null;
    const timestamp = nowIso(this.clock);
    this.db.prepare(`INSERT INTO subscriptions(user_id,plan_id,status,source,current_period_start,updated_at)
      VALUES(?,?,'active',?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET plan_id=excluded.plan_id,status='active',source=excluded.source,
      current_period_start=excluded.current_period_start,current_period_end=NULL,updated_at=excluded.updated_at`)
      .run(String(userId), String(planId), String(source), timestamp, timestamp);
    return this.getUserPlan(userId);
  }

  usage(userId, entitlementKey, periodKey) {
    this.initialize();
    return Number(this.db.prepare('SELECT used FROM usage_counters WHERE user_id=? AND entitlement_key=? AND period_key=?')
      .get(String(userId), String(entitlementKey), String(periodKey))?.used || 0);
  }

  consumeUsage(userId, entitlementKey, periodKey, quantity = 1) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    this.db.prepare(`INSERT INTO usage_counters(user_id,entitlement_key,period_key,used,updated_at)
      VALUES(?,?,?,?,?) ON CONFLICT(user_id,entitlement_key,period_key)
      DO UPDATE SET used=used+excluded.used,updated_at=excluded.updated_at`)
      .run(String(userId), String(entitlementKey), String(periodKey), Number(quantity), timestamp);
    return this.usage(userId, entitlementKey, periodKey);
  }

  consumeUsageWithinLimit(userId, entitlementKey, periodKey, quantity, limit) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    const boundedQuantity = Math.max(1, Number(quantity) || 1);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const used = Number(this.db.prepare('SELECT used FROM usage_counters WHERE user_id=? AND entitlement_key=? AND period_key=?')
        .get(String(userId), String(entitlementKey), String(periodKey))?.used || 0);
      if (Number(limit) >= 0 && used + boundedQuantity > Number(limit)) {
        this.db.exec('ROLLBACK');
        return { accepted: false, used, limit: Number(limit) };
      }
      this.db.prepare(`INSERT INTO usage_counters(user_id,entitlement_key,period_key,used,updated_at)
        VALUES(?,?,?,?,?) ON CONFLICT(user_id,entitlement_key,period_key)
        DO UPDATE SET used=used+excluded.used,updated_at=excluded.updated_at`)
        .run(String(userId), String(entitlementKey), String(periodKey), boundedQuantity, timestamp);
      this.db.exec('COMMIT');
      return { accepted: true, used: used + boundedQuantity, limit: Number(limit) };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
      throw error;
    }
  }

  getJobState(userId, jobId) {
    this.initialize();
    return stateFromRow(this.db.prepare('SELECT * FROM job_states WHERE user_id=? AND job_id=?').get(String(userId), String(jobId)));
  }

  updateJobState(userId, jobId, state) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    this.db.prepare(`INSERT INTO job_states(user_id,job_id,status,saved,favorite,hidden,note,next_action,applied_at,follow_up_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(user_id,job_id) DO UPDATE SET status=excluded.status,saved=excluded.saved,favorite=excluded.favorite,
      hidden=excluded.hidden,note=excluded.note,next_action=excluded.next_action,applied_at=excluded.applied_at,
      follow_up_at=excluded.follow_up_at,updated_at=excluded.updated_at`)
      .run(String(userId), String(jobId), state.status, state.saved ? 1 : 0, state.favorite ? 1 : 0, state.hidden ? 1 : 0,
        state.note, state.nextAction || '', state.appliedAt || null, state.followUpAt || null, timestamp);
    return this.getJobState(userId, jobId);
  }

  remapJobAliases(aliases) {
    this.initialize();
    const input = aliases instanceof Map ? Object.fromEntries(aliases) : { ...(aliases || {}) };
    const resolved = new Map();
    const finalTarget = oldId => {
      let current = String(oldId || '');
      const seen = new Set();
      while (input[current]) {
        if (seen.has(current)) return '';
        seen.add(current);
        current = String(input[current] || '');
      }
      return current;
    };
    for (const [oldValue] of Object.entries(input)) {
      const oldId = String(oldValue || '').trim();
      const targetId = finalTarget(oldId).trim();
      if (oldId && targetId && oldId !== targetId) resolved.set(oldId, targetId);
    }
    const lookup = this.db.prepare('SELECT * FROM job_states WHERE user_id=? AND job_id=?');
    const sourceRows = this.db.prepare('SELECT * FROM job_states WHERE job_id=?');
    const move = this.db.prepare('UPDATE job_states SET job_id=? WHERE user_id=? AND job_id=?');
    const remove = this.db.prepare('DELETE FROM job_states WHERE user_id=? AND job_id=?');
    const merge = this.db.prepare(`UPDATE job_states SET status=?,saved=?,favorite=?,hidden=?,note=?,next_action=?,
      applied_at=?,follow_up_at=?,updated_at=? WHERE user_id=? AND job_id=?`);
    let remapped = 0;
    let merged = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [oldId, targetId] of resolved) {
        for (const source of sourceRows.all(oldId)) {
          const target = lookup.get(source.user_id, targetId);
          if (!target) {
            move.run(targetId, source.user_id, oldId);
            remapped++;
            continue;
          }
          const sourceIsNewer = String(source.updated_at || '') > String(target.updated_at || '');
          const newer = sourceIsNewer ? source : target;
          const noteParts = [];
          const noteSet = new Set();
          for (const value of [target.note, source.note]) {
            for (const part of String(value || '').split(/\n{2,}/).map(item => item.trim()).filter(Boolean)) {
              if (!noteSet.has(part)) {
                noteSet.add(part);
                noteParts.push(part);
              }
            }
          }
          merge.run(
            newer.status,
            source.saved || target.saved ? 1 : 0,
            source.favorite || target.favorite ? 1 : 0,
            newer.hidden ? 1 : 0,
            noteParts.join('\n\n'),
            newer.next_action || '',
            newer.applied_at || null,
            newer.follow_up_at || null,
            newer.updated_at,
            source.user_id,
            targetId,
          );
          remove.run(source.user_id, oldId);
          merged++;
        }
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { aliases: resolved.size, remapped, merged };
  }

  createJobAliasIntent(aliases) {
    this.initialize();
    const normalized = Object.fromEntries(Object.entries(aliases || {})
      .map(([oldId, targetId]) => [String(oldId || '').trim(), String(targetId || '').trim()])
      .filter(([oldId, targetId]) => oldId && targetId && oldId !== targetId)
      .sort(([left], [right]) => left.localeCompare(right)));
    if (!Object.keys(normalized).length) return null;
    const canonical = JSON.stringify(normalized);
    const id = `jai_${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
    this.db.prepare(`INSERT INTO job_alias_intents(id,aliases_json,status,created_at)
      VALUES(?,?,'pending',?) ON CONFLICT(id) DO NOTHING`).run(id, canonical, nowIso(this.clock));
    return this.getJobAliasIntent(id);
  }

  getJobAliasIntent(id) {
    this.initialize();
    const row = this.db.prepare('SELECT * FROM job_alias_intents WHERE id=?').get(String(id));
    return row ? {
      id: row.id,
      aliases: parseJson(row.aliases_json, {}),
      status: row.status,
      createdAt: row.created_at,
      appliedAt: row.applied_at || '',
    } : null;
  }

  listPendingJobAliasIntents() {
    this.initialize();
    return this.db.prepare("SELECT * FROM job_alias_intents WHERE status='pending' ORDER BY created_at,id").all().map(row => ({
      id: row.id,
      aliases: parseJson(row.aliases_json, {}),
      status: row.status,
      createdAt: row.created_at,
      appliedAt: row.applied_at || '',
    }));
  }

  markJobAliasIntentApplied(id) {
    this.initialize();
    return this.db.prepare("UPDATE job_alias_intents SET status='applied',applied_at=? WHERE id=? AND status='pending'")
      .run(nowIso(this.clock), String(id)).changes > 0;
  }

  listJobStates(userId) {
    this.initialize();
    return this.db.prepare('SELECT * FROM job_states WHERE user_id=? ORDER BY updated_at DESC').all(String(userId)).map(stateFromRow);
  }

  listUserCustomJobs(userId) {
    this.initialize();
    return this.db.prepare('SELECT job_id,job_json,migrated_at FROM user_custom_jobs WHERE user_id=? ORDER BY migrated_at DESC,job_id')
      .all(String(userId)).map(row => ({
        ...parseJson(row.job_json, {}),
        id: row.job_id,
        active: '1',
        isCustom: '1',
        source: '自选',
        migratedAt: row.migrated_at,
      }));
  }

  pipelineCounts(userId) {
    this.initialize();
    const counts = {};
    for (const row of this.db.prepare('SELECT status,COUNT(*) AS n FROM job_states WHERE user_id=? GROUP BY status').all(String(userId))) {
      counts[row.status] = Number(row.n);
    }
    return counts;
  }

  listPrepTracks() {
    this.initialize();
    return this.db.prepare('SELECT * FROM prep_tracks WHERE active=1 ORDER BY sort_order,id').all().map(prepTrackFromRow);
  }

  getPrepTrack(id) {
    this.initialize();
    return prepTrackFromRow(this.db.prepare('SELECT * FROM prep_tracks WHERE id=? AND active=1').get(String(id)));
  }

  listPrepQuestions({ trackId = '', limit = 100, offset = 0, includeAnswer = false } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(200, Number(limit) || 100));
    const start = Math.max(0, Number(offset) || 0);
    const rows = trackId
      ? this.db.prepare('SELECT * FROM prep_questions WHERE active=1 AND track_id=? ORDER BY id LIMIT ? OFFSET ?').all(String(trackId), bounded, start)
      : this.db.prepare('SELECT * FROM prep_questions WHERE active=1 ORDER BY track_id,id LIMIT ? OFFSET ?').all(bounded, start);
    return rows.map(row => prepQuestionFromRow(row, { includeAnswer }));
  }

  countPrepQuestions(trackId = '') {
    this.initialize();
    const row = trackId
      ? this.db.prepare('SELECT COUNT(*) AS n FROM prep_questions WHERE active=1 AND track_id=?').get(String(trackId))
      : this.db.prepare('SELECT COUNT(*) AS n FROM prep_questions WHERE active=1').get();
    return Number(row.n);
  }

  getPrepQuestion(id, { includeAnswer = false } = {}) {
    this.initialize();
    const row = this.db.prepare('SELECT * FROM prep_questions WHERE id=? AND active=1').get(String(id));
    return prepQuestionFromRow(row, { includeAnswer });
  }

  addPrepQuestion(question) {
    this.initialize();
    this.db.prepare(`INSERT INTO prep_questions(id,track_id,type,difficulty,prompt,options_json,answer_json,explanation,active)
      VALUES(?,?,?,?,?,?,?,?,1)`).run(question.id, question.trackId, question.type, question.difficulty, question.prompt,
      JSON.stringify(question.options || []), JSON.stringify(question.answer), question.explanation);
    return this.getPrepQuestion(question.id);
  }

  addPrepAttempt({ id, userId, questionId, response, score, correct }) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(`INSERT INTO prep_attempts(id,user_id,question_id,response_json,score,correct,created_at)
        VALUES(?,?,?,?,?,?,?)`).run(id, userId, questionId, JSON.stringify(response), score, correct ? 1 : 0, timestamp);
      this.db.prepare(`INSERT INTO prep_progress(user_id,question_id,attempts,best_score,latest_score,updated_at)
        VALUES(?,?,1,?,?,?)
        ON CONFLICT(user_id,question_id) DO UPDATE SET attempts=attempts+1,best_score=MAX(best_score,excluded.best_score),
        latest_score=excluded.latest_score,updated_at=excluded.updated_at`)
        .run(userId, questionId, score, score, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { id, userId, questionId, response, score, correct: Boolean(correct), createdAt: timestamp };
  }

  addPrepAttemptsBatch({ userId, attempts, entitlementKey, periodKey, limit }) {
    this.initialize();
    const timestamp = nowIso(this.clock);
    const boundedAttempts = Array.isArray(attempts) ? attempts : [];
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const used = Number(this.db.prepare('SELECT used FROM usage_counters WHERE user_id=? AND entitlement_key=? AND period_key=?')
        .get(String(userId), String(entitlementKey), String(periodKey))?.used || 0);
      if (Number(limit) >= 0 && used + boundedAttempts.length > Number(limit)) {
        this.db.exec('ROLLBACK');
        return { accepted: false, used, limit: Number(limit), attempts: [] };
      }
      const insertAttempt = this.db.prepare(`INSERT INTO prep_attempts(id,user_id,question_id,response_json,score,correct,created_at)
        VALUES(?,?,?,?,?,?,?)`);
      const updateProgress = this.db.prepare(`INSERT INTO prep_progress(user_id,question_id,attempts,best_score,latest_score,updated_at)
        VALUES(?,?,1,?,?,?)
        ON CONFLICT(user_id,question_id) DO UPDATE SET attempts=attempts+1,best_score=MAX(best_score,excluded.best_score),
        latest_score=excluded.latest_score,updated_at=excluded.updated_at`);
      for (const attempt of boundedAttempts) {
        insertAttempt.run(attempt.id, userId, attempt.questionId, JSON.stringify(attempt.response), attempt.score, attempt.correct ? 1 : 0, timestamp);
        updateProgress.run(userId, attempt.questionId, attempt.score, attempt.score, timestamp);
      }
      if (boundedAttempts.length) {
        this.db.prepare(`INSERT INTO usage_counters(user_id,entitlement_key,period_key,used,updated_at)
          VALUES(?,?,?,?,?) ON CONFLICT(user_id,entitlement_key,period_key)
          DO UPDATE SET used=used+excluded.used,updated_at=excluded.updated_at`)
          .run(String(userId), String(entitlementKey), String(periodKey), boundedAttempts.length, timestamp);
      }
      this.db.exec('COMMIT');
      return {
        accepted: true,
        used: used + boundedAttempts.length,
        limit: Number(limit),
        attempts: boundedAttempts.map(attempt => ({ ...attempt, userId, createdAt: timestamp, correct: Boolean(attempt.correct) })),
      };
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
      throw error;
    }
  }

  prepProgress(userId) {
    this.initialize();
    return this.db.prepare(`SELECT p.*,q.track_id FROM prep_progress p JOIN prep_questions q ON q.id=p.question_id
      WHERE p.user_id=? ORDER BY p.updated_at DESC`).all(String(userId)).map(row => ({
      questionId: row.question_id,
      trackId: row.track_id,
      attempts: Number(row.attempts),
      bestScore: Number(row.best_score),
      latestScore: Number(row.latest_score),
      updatedAt: row.updated_at,
    }));
  }

  prepAttemptDays(userId) {
    this.initialize();
    return this.db.prepare(`SELECT DISTINCT substr(created_at,1,10) AS day FROM prep_attempts
      WHERE user_id=? ORDER BY day DESC`).all(String(userId)).map(row => row.day).filter(Boolean);
  }

  prepAttemptTimestamps(userId) {
    this.initialize();
    return this.db.prepare(`SELECT created_at FROM prep_attempts WHERE user_id=? ORDER BY created_at DESC`)
      .all(String(userId)).map(row => row.created_at).filter(Boolean);
  }

  listExamPacks() {
    this.initialize();
    return this.db.prepare('SELECT * FROM exam_packs WHERE active=1 ORDER BY featured DESC,sort_order,id')
      .all().map(examPackFromRow);
  }

  getExamPack(id) {
    this.initialize();
    return examPackFromRow(this.db.prepare('SELECT * FROM exam_packs WHERE id=? AND active=1').get(String(id)));
  }

  listExamSessions(userId, { limit = 100 } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    return this.db.prepare('SELECT * FROM exam_sessions WHERE user_id=? ORDER BY updated_at DESC LIMIT ?')
      .all(String(userId), bounded).map(examSessionFromRow);
  }

  getExamSession(id, userId) {
    this.initialize();
    const row = this.db.prepare('SELECT * FROM exam_sessions WHERE id=? AND user_id=?').get(String(id), String(userId));
    return examSessionFromRow(row);
  }

  createOrResumeExamSession({ id, userId, packId, totalQuestions }) {
    this.initialize();
    const existing = this.db.prepare(`SELECT * FROM exam_sessions
      WHERE user_id=? AND pack_id=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1`)
      .get(String(userId), String(packId));
    if (existing) return { session: examSessionFromRow(existing), resumed: true };
    const timestamp = nowIso(this.clock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const raced = this.db.prepare(`SELECT * FROM exam_sessions
        WHERE user_id=? AND pack_id=? AND status='in_progress' ORDER BY updated_at DESC LIMIT 1`)
        .get(String(userId), String(packId));
      if (raced) {
        this.db.exec('COMMIT');
        return { session: examSessionFromRow(raced), resumed: true };
      }
      this.db.prepare(`INSERT INTO exam_sessions
        (id,user_id,pack_id,status,answers_json,flagged_json,current_index,elapsed_seconds,total_questions,started_at,updated_at)
        VALUES(?,?,?,'in_progress','{}','[]',0,0,?,?,?)`)
        .run(String(id), String(userId), String(packId), Number(totalQuestions), timestamp, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    return { session: this.getExamSession(id, userId), resumed: false };
  }

  saveExamSession({ id, userId, answers, flagged, currentIndex, elapsedSeconds }) {
    this.initialize();
    const result = this.db.prepare(`UPDATE exam_sessions SET answers_json=?,flagged_json=?,current_index=?,elapsed_seconds=?,updated_at=?
      WHERE id=? AND user_id=? AND status='in_progress'`)
      .run(JSON.stringify(answers || {}), JSON.stringify(flagged || []), Number(currentIndex) || 0,
        Math.max(0, Number(elapsedSeconds) || 0), nowIso(this.clock), String(id), String(userId));
    return result.changes > 0 ? this.getExamSession(id, userId) : null;
  }

  submitExamSession({ id, userId, answers, flagged, currentIndex, elapsedSeconds, score, correctCount, totalQuestions, results }) {
    this.initialize();
    const before = this.getExamSession(id, userId);
    if (!before) return null;
    if (before.status === 'submitted') return { session: before, submittedNow: false };
    const timestamp = nowIso(this.clock);
    const insertAttempt = this.db.prepare(`INSERT INTO prep_attempts(id,user_id,question_id,response_json,score,correct,created_at)
      VALUES(?,?,?,?,?,?,?)`);
    const updateProgress = this.db.prepare(`INSERT INTO prep_progress(user_id,question_id,attempts,best_score,latest_score,updated_at)
      VALUES(?,?,1,?,?,?)
      ON CONFLICT(user_id,question_id) DO UPDATE SET attempts=attempts+1,best_score=MAX(best_score,excluded.best_score),
      latest_score=excluded.latest_score,updated_at=excluded.updated_at`);
    const upsertWrong = this.db.prepare(`INSERT INTO exam_wrong_answers
      (user_id,question_id,pack_id,latest_response_json,attempts,last_wrong_at,mastered_at)
      VALUES(?,?,?,?,1,?,NULL)
      ON CONFLICT(user_id,question_id) DO UPDATE SET pack_id=excluded.pack_id,
      latest_response_json=excluded.latest_response_json,attempts=attempts+1,last_wrong_at=excluded.last_wrong_at,mastered_at=NULL`);
    const markMastered = this.db.prepare(`UPDATE exam_wrong_answers SET mastered_at=? WHERE user_id=? AND question_id=?`);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = examSessionFromRow(this.db.prepare('SELECT * FROM exam_sessions WHERE id=? AND user_id=?').get(String(id), String(userId)));
      if (!current) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (current.status === 'submitted') {
        this.db.exec('COMMIT');
        return { session: current, submittedNow: false };
      }
      this.db.prepare(`UPDATE exam_sessions SET status='submitted',answers_json=?,flagged_json=?,current_index=?,elapsed_seconds=?,
        score=?,correct_count=?,total_questions=?,submitted_at=?,updated_at=? WHERE id=? AND user_id=? AND status='in_progress'`)
        .run(JSON.stringify(answers || {}), JSON.stringify(flagged || []), Number(currentIndex) || 0,
          Math.max(0, Number(elapsedSeconds) || 0), Number(score) || 0, Number(correctCount) || 0,
          Number(totalQuestions) || 0, timestamp, timestamp, String(id), String(userId));
      for (const item of results || []) {
        insertAttempt.run(item.attemptId, String(userId), item.questionId, JSON.stringify(item.response),
          Number(item.score) || 0, item.correct ? 1 : 0, timestamp);
        updateProgress.run(String(userId), item.questionId, Number(item.score) || 0, Number(item.score) || 0, timestamp);
        if (item.correct) markMastered.run(timestamp, String(userId), item.questionId);
        else upsertWrong.run(String(userId), item.questionId, before.packId, JSON.stringify(item.response), timestamp);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch (_) { /* transaction may already be closed */ }
      throw error;
    }
    return { session: this.getExamSession(id, userId), submittedNow: true };
  }

  listExamWrongAnswers(userId, { includeMastered = false, limit = 100 } = {}) {
    this.initialize();
    const bounded = Math.max(1, Math.min(500, Number(limit) || 100));
    const where = includeMastered ? 'w.user_id=?' : 'w.user_id=? AND w.mastered_at IS NULL';
    return this.db.prepare(`SELECT w.*,q.*,p.title AS pack_title FROM exam_wrong_answers w
      JOIN prep_questions q ON q.id=w.question_id JOIN exam_packs p ON p.id=w.pack_id
      WHERE ${where} ORDER BY w.last_wrong_at DESC LIMIT ?`).all(String(userId), bounded).map(row => ({
        questionId: row.question_id,
        packId: row.pack_id,
        packTitle: row.pack_title,
        latestResponse: parseJson(row.latest_response_json, null),
        attempts: Number(row.attempts),
        lastWrongAt: row.last_wrong_at,
        masteredAt: row.mastered_at || '',
        question: prepQuestionFromRow(row, { includeAnswer: true }),
      }));
  }

  examSummary(userId) {
    this.initialize();
    const aggregate = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status='in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status='submitted' THEN 1 ELSE 0 END) AS submitted,
      AVG(CASE WHEN status='submitted' THEN score END) AS average_score
      FROM exam_sessions WHERE user_id=?`).get(String(userId));
    const wrong = this.db.prepare(`SELECT COUNT(*) AS n FROM exam_wrong_answers WHERE user_id=? AND mastered_at IS NULL`).get(String(userId));
    const recent = this.db.prepare(`SELECT s.*,p.title AS pack_title FROM exam_sessions s JOIN exam_packs p ON p.id=s.pack_id
      WHERE s.user_id=? ORDER BY s.updated_at DESC LIMIT 5`).all(String(userId)).map(row => ({
        ...examSessionFromRow(row),
        packTitle: row.pack_title,
      }));
    return {
      totalSessions: Number(aggregate.total || 0),
      inProgress: Number(aggregate.in_progress || 0),
      submitted: Number(aggregate.submitted || 0),
      averageScore: aggregate.average_score === null ? null : Math.round(Number(aggregate.average_score)),
      wrongCount: Number(wrong.n || 0),
      recent,
    };
  }

  dashboard(userId) {
    const pipeline = this.pipelineCounts(userId);
    const progress = this.prepProgress(userId);
    return {
      trackedJobs: Object.values(pipeline).reduce((sum, value) => sum + value, 0),
      favorites: Number(this.db.prepare('SELECT COUNT(*) AS n FROM job_states WHERE user_id=? AND favorite=1').get(String(userId)).n),
      activeApplications: ['applied', 'assessment', 'interview'].reduce((sum, key) => sum + Number(pipeline[key] || 0), 0),
      offers: Number(pipeline.offer || 0),
      prepQuestionsCompleted: progress.length,
      prepAverageBestScore: progress.length ? Math.round(progress.reduce((sum, item) => sum + item.bestScore, 0) / progress.length) : 0,
    };
  }
}

module.exports = {
  ProductStore,
};
