'use strict';

const { CloudStore, AI_SCOPES } = require('./store');
const { classifyRecords } = require('./classifier');
const { DeepSeekClient, aiProfileHash, jobContentHash } = require('./ai');
const adapters = require('./adapters');

const ACTIVE_APPLICATION_STATUSES = new Set(['已投递', '笔试', '一面', '二面']);

function runtimeError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function zonedParts(nowMs, timeZone = 'Australia/Brisbane') {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(nowMs));
  const get = type => parts.find(part => part.type === type)?.value || '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

function parseDeadline(value) {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const timestamp = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isFinite(timestamp) ? timestamp : null;
}

function daysUntil(value, nowMs, timeZone = 'Australia/Brisbane') {
  const timestamp = parseDeadline(value);
  if (timestamp === null) return null;
  const localDate = zonedParts(nowMs, timeZone).date;
  const [year, month, day] = localDate.split('-').map(Number);
  const start = Date.UTC(year, month - 1, day);
  return Math.ceil((timestamp - start) / 86_400_000);
}

class CloudRuntime {
  constructor({
    dataDir,
    jobService,
    clock = () => Date.now(),
    store = null,
    fetchSource = adapters.fetchSource,
    createLoginSession = adapters.createLoginSession,
    searchInterviewExperience = adapters.searchInterviewExperience,
    aiClient = null,
    onJobAliases = null,
    env = process.env,
    logger = console,
    timeZone = 'Australia/Brisbane',
  } = {}) {
    if (!dataDir || !jobService) throw new Error('CloudRuntime 需要 dataDir 和 jobService');
    this.dataDir = dataDir;
    this.jobService = jobService;
    this.clock = clock;
    this.store = store || new CloudStore({ dataDir, clock });
    this.fetchSource = fetchSource;
    this.createLoginSession = createLoginSession;
    this.searchInterviewExperience = searchInterviewExperience;
    this.aiClient = aiClient || new DeepSeekClient();
    this.onJobAliases = typeof onJobAliases === 'function'
      ? { apply: onJobAliases }
      : onJobAliases && typeof onJobAliases === 'object' ? onJobAliases : null;
    this.env = env;
    this.logger = logger;
    this.timeZone = timeZone;
    this.queue = [];
    this.current = null;
    this.scheduler = null;
    this.loginSessions = new Map();
    this.idleWaiters = [];
  }

  initialize({ startScheduler = true } = {}) {
    this.store.initialize();
    if (startScheduler) this.startScheduler();
    return this;
  }

  startScheduler() {
    if (this.scheduler) return;
    const run = () => this.tickScheduler().catch(error => this.logger.error(`scheduler failed: ${error.message}`));
    this.scheduler = setInterval(run, 30_000);
    this.scheduler.unref?.();
    run();
  }

  stopScheduler() {
    if (this.scheduler) clearInterval(this.scheduler);
    this.scheduler = null;
  }

  async tickScheduler() {
    const now = zonedParts(this.clock(), this.timeZone);
    const mark = `${now.date}T${now.time}`;
    for (const source of this.store.listSources().filter(item => item.enabled)) {
      if (!source.schedule.split(',').includes(now.time)) continue;
      const key = `schedule:${source.id}`;
      if (this.store.getKv(key) === mark) continue;
      this.store.setKv(key, mark);
      this.enqueueSource(source.id, 'schedule');
    }
    if (now.time === '08:00' && this.store.getKv('schedule:daily-check') !== mark) {
      this.store.setKv('schedule:daily-check', mark);
      this.enqueueSystem('daily-check');
    }
    if (now.time === '21:30' && this.store.getKv('schedule:research') !== mark) {
      this.store.setKv('schedule:research', mark);
      this.enqueueSystem('research');
    }
  }

  listSources() { return this.store.listSources(); }
  getSource(id) { return this.store.getSource(id); }
  createSource(body) { return this.store.createSource(body); }
  updateSource(id, body) { return this.store.updateSource(id, body); }
  archiveSource(id) {
    const source = this.store.getSource(id);
    if (!source) return false;
    if ([this.current, ...this.queue].some(task => task?.type === 'source' && task.sourceId === id)) {
      const error = new Error('信息源正在运行或排队，请完成后再移除');
      error.statusCode = 409;
      throw error;
    }
    const syncAt = new Date(this.clock()).toISOString();
    this.jobService.applyCloudSync(
      { sourceId: source.id, sourceName: source.name, jobs: [], syncAt },
      {
        beforeCommitAliases: aliases => this._prepareAliases(aliases),
        afterCommitAliases: (aliases, context) => this._applyAliases(aliases, context),
      },
    );
    return this.store.archiveSource(id);
  }
  listRuns(options) { return this.store.listRuns(options); }
  listNotifications(limit) { return this.store.listNotifications(limit); }
  listResearch(options) { return this.store.listResearch(options); }

  reconcileJobs({ dryRun = false } = {}) {
    if (this.current || this.queue.length) throw runtimeError('云端任务正在运行或排队，请完成后再整理去重', 409);
    const sourceIds = this.store.listSources().map(source => source.id);
    const activeSourceRecordIds = this.store.listActiveSourceRecordIds();
    const preferredIds = this.store.listAiAssessments().map(assessment => assessment.jobId);
    const result = this.jobService.reconcileCloudJobs({
      sourceIds,
      activeSourceRecordIds,
      preferredIds,
      syncAt: new Date(this.clock()).toISOString(),
      dryRun: Boolean(dryRun),
      beforeCommitAliases: aliases => this._prepareAliases(aliases),
      afterCommitAliases: (aliases, context) => this._applyAliases(aliases, context),
    });
    const { aliases, aliasEffects, ...publicResult } = result;
    void aliases;
    const ai = dryRun ? { remapped: 0, dropped: 0 } : aliasEffects?.ai || { remapped: 0, dropped: 0 };
    const product = dryRun ? { remapped: 0, merged: 0 } : aliasEffects?.product || { remapped: 0, merged: 0 };
    return { ...publicResult, ai, product };
  }

  _prepareAliases(aliases) {
    return {
      productIntent: typeof this.onJobAliases?.prepare === 'function' ? this.onJobAliases.prepare(aliases) : '',
    };
  }

  _applyAliases(aliases, context = {}) {
    return {
      ai: this.store.remapAiAssessments(aliases),
      product: typeof this.onJobAliases?.apply === 'function'
        ? this.onJobAliases.apply(aliases, context?.productIntent || '')
        : { remapped: 0, merged: 0 },
    };
  }

  _resolvedAiSettings(overrides = {}) {
    const stored = this.store.getAiSettings();
    const explicitKey = typeof overrides.apiKey === 'string' && overrides.apiKey.trim() ? overrides.apiKey.trim() : '';
    const environmentKey = typeof this.env.DEEPSEEK_API_KEY === 'string' ? this.env.DEEPSEEK_API_KEY.trim() : '';
    return {
      ...stored,
      ...Object.fromEntries(Object.entries(overrides).filter(([key, value]) => key !== 'apiKey' && value !== undefined && value !== '')),
      apiKey: explicitKey || environmentKey || stored.apiKey || '',
      keySource: explicitKey ? 'request' : environmentKey ? 'environment' : stored.apiKey ? 'saved' : 'none',
    };
  }

  getAiSettings() {
    const settings = this._resolvedAiSettings();
    const { apiKey, ...publicSettings } = settings;
    return { ...publicSettings, apiKeyConfigured: Boolean(apiKey) };
  }

  updateAiSettings(body) {
    this.store.updateAiSettings(body);
    return this.getAiSettings();
  }

  _aiCandidateJobs(scope) {
    const jobs = this.jobService.snapshot().jobs.filter(job => job.active !== '0');
    if (scope === 'all') return jobs;
    return jobs.filter(job => ['符合条件', '可试试'].includes(job.classification || job.source) || job.source === '自选' || job.isCustom === '1');
  }

  _freshAssessment(job, assessment, settings, profileHash = aiProfileHash(settings)) {
    return Boolean(assessment && assessment.contentHash === jobContentHash(job) && assessment.profileHash === profileHash && assessment.model === settings.model);
  }

  aiDashboard() {
    const settings = this._resolvedAiSettings();
    const publicSettings = this.getAiSettings();
    const assessments = this.store.aiAssessmentMap();
    const allActiveJobs = this.jobService.snapshot().jobs.filter(job => job.active !== '0');
    const candidates = this._aiCandidateJobs(settings.scope);
    const profileHash = aiProfileHash(settings);
    const freshCount = candidates.filter(job => this._freshAssessment(job, assessments.get(job.id), settings, profileHash)).length;
    const assessedActive = allActiveJobs.filter(job => assessments.has(job.id)).length;
    const latestRun = this.store.listAiRuns({ limit: 1 })[0] || null;
    return {
      settings: publicSettings,
      stats: {
        ...this.store.aiStats(),
        activeJobs: allActiveJobs.length,
        candidateJobs: candidates.length,
        assessedActive,
        freshCount,
        staleCount: Math.max(0, candidates.length - freshCount),
      },
      latestRun,
      queue: {
        queued: this.queue.filter(task => task?.type === 'ai').length,
        current: this.current?.type === 'ai' ? { runId: this.current.runId, scope: this.current.scope, force: this.current.force } : null,
      },
    };
  }

  listAiRuns(options) { return this.store.listAiRuns(options); }

  listAiAssessments() {
    const settings = this._resolvedAiSettings();
    const jobs = new Map(this.jobService.snapshot().jobs.map(job => [job.id, job]));
    const profileHash = aiProfileHash(settings);
    return this.store.listAiAssessments().map(assessment => {
      const { contentHash, profileHash: storedProfileHash, ...publicAssessment } = assessment;
      const job = jobs.get(assessment.jobId);
      return { ...publicAssessment, fresh: Boolean(job && contentHash === jobContentHash(job) && storedProfileHash === profileHash && assessment.model === settings.model) };
    });
  }

  enrichJobs(jobs) {
    const settings = this._resolvedAiSettings();
    const assessments = this.store.aiAssessmentMap();
    const profileHash = aiProfileHash(settings);
    return jobs.map(job => {
      const assessment = assessments.get(job.id);
      if (!assessment) return job;
      const { contentHash, profileHash: storedProfileHash, ...publicAssessment } = assessment;
      return {
        ...job,
        aiAssessment: {
          ...publicAssessment,
          fresh: contentHash === jobContentHash(job) && storedProfileHash === profileHash && assessment.model === settings.model,
        },
      };
    });
  }

  async testAiConnection(overrides = {}) {
    const settings = this._resolvedAiSettings(overrides);
    if (!settings.apiKey) throw runtimeError('尚未配置 DeepSeek API Key', 409);
    return this.aiClient.testConnection(settings);
  }

  overview() {
    return {
      ...this.store.overview(),
      queueLength: this.queue.length,
      current: this.current ? { type: this.current.type, sourceId: this.current.sourceId || '', kind: this.current.kind || '', runId: this.current.runId || 0 } : null,
    };
  }

  enqueueSource(sourceId, trigger = 'manual', { allowAutoAi = true } = {}) {
    const source = this.store.getSource(sourceId);
    if (!source) throw runtimeError('信息源不存在', 404);
    if (!source.enabled && trigger === 'schedule') throw runtimeError('信息源已停用', 409);
    const duplicate = [this.current, ...this.queue].find(task => task?.type === 'source' && task.sourceId === sourceId);
    if (duplicate) return { queued: false, duplicate: true, runId: duplicate.runId };
    const runId = this.store.createRun(sourceId, trigger, 'queued');
    this.queue.push({ type: 'source', sourceId, trigger, runId, allowAutoAi: Boolean(allowAutoAi) });
    this._pump();
    return { queued: true, duplicate: false, runId };
  }

  enqueueAll(trigger = 'manual-all', options = {}) {
    const results = [];
    for (const source of this.store.listSources().filter(item => item.enabled)) results.push({ sourceId: source.id, ...this.enqueueSource(source.id, trigger, options) });
    return results;
  }

  enqueueAi(options = {}, trigger = 'manual-ai') {
    const settings = this._resolvedAiSettings();
    if (!settings.apiKey) throw runtimeError('尚未配置 DeepSeek API Key', 409);
    const scope = String(options.scope || settings.scope || 'candidates');
    if (!AI_SCOPES.includes(scope)) throw runtimeError(`scope 仅支持 ${AI_SCOPES.join('/')}`, 400);
    const force = options.force === true || options.force === 1 || options.force === '1';
    const limit = Number(options.limit ?? settings.maxJobs);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw runtimeError('limit 必须是 1-1000 的整数', 400);
    const duplicate = [this.current, ...this.queue].find(task => task?.type === 'ai');
    if (duplicate) return { queued: false, duplicate: true, runId: duplicate.runId };
    const runId = this.store.createAiRun({ trigger, scope, force, limit });
    this.queue.push({ type: 'ai', runId, scope, force, limit });
    this._pump();
    return { queued: true, duplicate: false, runId };
  }

  enqueueSystem(kind) {
    if (!['daily-check', 'research'].includes(kind)) throw runtimeError('系统任务非法', 400);
    const duplicate = [this.current, ...this.queue].some(task => task?.type === 'system' && task.kind === kind);
    if (duplicate) return { queued: false, duplicate: true };
    this.queue.push({ type: 'system', kind });
    this._pump();
    return { queued: true, duplicate: false };
  }

  async _pump() {
    if (this.current || !this.queue.length) return;
    this.current = this.queue.shift();
    try {
      if (this.current.type === 'source') await this._runSource(this.current);
      else if (this.current.type === 'ai') await this._runAi(this.current);
      else if (this.current.kind === 'daily-check') await this.runDailyCheck();
      else if (this.current.kind === 'research') await this.runResearch();
    } catch (error) {
      this.logger.error(`cloud task failed: ${error.message}`);
    } finally {
      this.current = null;
      if (this.queue.length) setImmediate(() => this._pump());
      else {
        const waiters = this.idleWaiters.splice(0);
        waiters.forEach(resolve => resolve());
      }
    }
  }

  async _runSource(task) {
    const source = this.store.getSource(task.sourceId);
    if (!source) {
      this.store.finishRun(task.runId, { status: 'failed', error: '信息源不存在或已归档' });
      return;
    }
    this.store.markRunRunning(task.runId);
    try {
      const runAt = new Date(this.clock()).toISOString();
      const records = await this.fetchSource(source, { dataDir: this.dataDir });
      const recordStats = this.store.upsertSourceRecords(source.id, records, runAt);
      const classified = classifyRecords(records, source, runAt);
      const merged = this.jobService.applyCloudSync({
        sourceId: source.id,
        sourceName: source.name,
        jobs: classified.jobs,
        syncAt: runAt,
      }, {
        beforeCommitAliases: aliases => this._prepareAliases(aliases),
        afterCommitAliases: (aliases, context) => this._applyAliases(aliases, context),
      });
      const aiRemap = merged.aliasEffects?.ai || { remapped: 0, dropped: 0 };
      const productRemap = merged.aliasEffects?.product || { remapped: 0, merged: 0 };
      this.store.finishRun(task.runId, {
        status: 'success',
        fetchedCount: records.length,
        canonicalCount: classified.jobs.length,
        insertedCount: merged.inserted,
        updatedCount: merged.updated,
        inactiveCount: merged.inactive,
        detail: { classifier: classified.stats, records: recordStats, merged: { deduplicated: merged.deduplicated, crossSourceMatched: merged.crossSourceMatched, coalesced: merged.coalesced, active: merged.active, aiRemap, productRemap } },
      });
      if (merged.newJobs?.length) {
        const relevant = merged.newJobs.filter(job => ['符合条件', '可试试'].includes(job.classification || job.source));
        const lines = relevant.slice(0, 40).map(job => `${job.priority || '—'}｜${job.company}｜${job.position}｜${job.location || '地点未注明'}`);
        const body = [`${source.name} 新增 ${merged.newJobs.length} 个唯一岗位，其中符合/可试 ${relevant.length} 个。`, ...lines].join('\n');
        await this._notify('new-jobs', `${source.name} 新增岗位`, body);
      }
      const aiSettings = this._resolvedAiSettings();
      if (task.allowAutoAi !== false && aiSettings.enabled && aiSettings.autoRun && aiSettings.apiKey && (merged.inserted || merged.updated)) {
        try {
          this.enqueueAi({ scope: aiSettings.scope, force: false, limit: aiSettings.maxJobs }, 'source-sync');
        } catch (error) {
          this.logger.warn(`auto ai enqueue failed: ${error.message}`);
        }
      }
    } catch (error) {
      this.store.finishRun(task.runId, { status: 'failed', error: error.message, detail: { code: error.code || '' } });
    }
  }

  async _runAi(task) {
    this.store.markAiRunRunning(task.runId);
    let candidateCount = 0;
    let cachedCount = 0;
    let assessedCount = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    try {
      const settings = this._resolvedAiSettings();
      if (!settings.apiKey) throw runtimeError('尚未配置 DeepSeek API Key', 409);
      const profileHash = aiProfileHash(settings);
      const assessments = this.store.aiAssessmentMap();
      const candidates = this._aiCandidateJobs(task.scope);
      candidateCount = candidates.length;
      const fresh = candidates.filter(job => this._freshAssessment(job, assessments.get(job.id), settings, profileHash));
      cachedCount = task.force ? 0 : fresh.length;
      const stale = task.force ? candidates : candidates.filter(job => !this._freshAssessment(job, assessments.get(job.id), settings, profileHash));
      const rank = job => {
        const classification = job.classification || job.source;
        const priority = String(job.priority || '');
        if (job.source === '自选' || job.isCustom === '1') return 0;
        if (classification === '符合条件' && priority.includes('高')) return 1;
        if (classification === '符合条件' && priority.includes('中')) return 2;
        if (classification === '符合条件') return 3;
        if (classification === '可试试') return 4;
        return 5;
      };
      const selected = stale.slice().sort((a, b) => rank(a) - rank(b) || String(b.lastSeenAt || '').localeCompare(String(a.lastSeenAt || '')) || String(a.id).localeCompare(String(b.id))).slice(0, task.limit);
      for (let offset = 0; offset < selected.length; offset += settings.batchSize) {
        const batch = selected.slice(offset, offset + settings.batchSize);
        const response = await this.aiClient.assessJobs(batch, settings);
        const assessedAt = new Date(this.clock()).toISOString();
        const byId = new Map(batch.map(job => [String(job.id), job]));
        const rows = response.results.map(result => ({
          ...result,
          contentHash: jobContentHash(byId.get(result.jobId)),
          profileHash,
          model: settings.model,
          assessedAt,
        }));
        this.store.upsertAiAssessments(rows, task.runId);
        assessedCount += rows.length;
        inputTokens += Number(response.usage?.inputTokens || 0);
        outputTokens += Number(response.usage?.outputTokens || 0);
      }
      const pendingCount = Math.max(0, stale.length - assessedCount);
      this.store.finishAiRun(task.runId, {
        status: 'success', candidateCount, cachedCount, assessedCount, inputTokens, outputTokens,
        detail: { scope: task.scope, force: task.force, pendingCount, model: settings.model },
      });
      // A manual non-force run means "finish the backlog". Keep each persisted run bounded by
      // limit, then queue the next chunk until every active candidate has a fresh assessment.
      if (!task.force && pendingCount > 0 && assessedCount > 0) {
        const runId = this.store.createAiRun({ trigger: 'ai-continuation', scope: task.scope, force: false, limit: task.limit });
        this.queue.push({ type: 'ai', runId, scope: task.scope, force: false, limit: task.limit });
      }
    } catch (error) {
      this.store.finishAiRun(task.runId, {
        status: 'failed', candidateCount, cachedCount, assessedCount,
        failedCount: Math.max(0, Math.min(task.limit, candidateCount - cachedCount) - assessedCount),
        inputTokens, outputTokens, error: error.message,
      });
    }
  }

  async _notify(kind, title, body) {
    const id = this.store.addNotification(kind, title, body);
    const { SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, EMAIL_TO } = process.env;
    if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS || !EMAIL_TO) return id;
    try {
      const nodemailer = require('nodemailer');
      const transport = nodemailer.createTransport({
        host: SMTP_HOST,
        port: Number(SMTP_PORT || 465),
        secure: SMTP_SECURE !== 'false',
        auth: { user: SMTP_USER, pass: SMTP_PASS },
      });
      await transport.sendMail({ from: SMTP_USER, to: EMAIL_TO, subject: title, text: body });
      this.store.markNotificationDelivered(id);
    } catch (error) {
      this.store.markNotificationDelivered(id, error.message);
    }
    return id;
  }

  async runDailyCheck() {
    const jobs = this.jobService.snapshot().jobs.filter(job => job.active !== '0');
    const nowMs = this.clock();
    const urgent = [];
    const stale = [];
    for (const job of jobs) {
      const days = daysUntil(job.deadline, nowMs, this.timeZone);
      if (job.status === '未投递' && [7, 3, 1].includes(days)) urgent.push({ job, days });
      if (ACTIVE_APPLICATION_STATUSES.has(job.status) && job.statusUpdatedAt) {
        const elapsed = Math.floor((nowMs - Date.parse(job.statusUpdatedAt)) / 86_400_000);
        if (Number.isFinite(elapsed) && elapsed >= 14) stale.push({ job, days: elapsed });
      }
    }
    const lines = [
      `DDL提醒 ${urgent.length} 个；投递停滞 ${stale.length} 个。`,
      ...urgent.slice(0, 40).map(item => `剩${item.days}天｜${item.job.company}｜${item.job.position}`),
      ...stale.slice(0, 40).map(item => `停滞${item.days}天｜${item.job.company}｜${item.job.position}｜${item.job.status}`),
    ];
    await this._notify('daily-check', '秋招每日提醒', lines.join('\n'));
    return { urgent: urgent.length, stale: stale.length };
  }

  async runResearch() {
    const jobs = this.jobService.snapshot().jobs.filter(job => job.active !== '0' && ACTIVE_APPLICATION_STATUSES.has(job.status));
    const companies = [...new Set(jobs.map(job => job.company).filter(Boolean))];
    let searched = 0;
    let saved = 0;
    for (const company of companies) {
      const latest = this.store.listResearch({ company, limit: 1 })[0];
      if (latest && this.clock() - Date.parse(latest.foundAt) < 7 * 86_400_000) continue;
      try {
        const results = await this.searchInterviewExperience(company, { dataDir: this.dataDir });
        saved += this.store.addResearchResults(company, 'DuckDuckGo/Bing/牛客/看准', results);
      } catch (error) {
        this.logger.warn(`research ${company} failed: ${error.message}`);
      }
      searched++;
      if (searched >= 5) break;
    }
    await this._notify('research', '笔经面经搜集完成', `本轮搜索 ${searched} 家公司，保存/刷新 ${saved} 条结果。`);
    return { searched, saved };
  }

  async startLogin(sourceId) {
    const source = this.store.getSource(sourceId);
    if (!source) throw runtimeError('信息源不存在', 404);
    await this.closeLogin(sourceId);
    const session = await this.createLoginSession(source, { dataDir: this.dataDir });
    this.loginSessions.set(sourceId, session);
    const timer = setTimeout(() => this.closeLogin(sourceId).catch(() => {}), 10 * 60_000);
    timer.unref?.();
    session.timer = timer;
    return session.status();
  }

  async loginStatus(sourceId) {
    const session = this.loginSessions.get(sourceId);
    if (!session) return { status: 'closed', message: '尚未开启登录窗口' };
    return session.status();
  }

  async loginScreenshot(sourceId) {
    const session = this.loginSessions.get(sourceId);
    if (!session) return null;
    return session.screenshot();
  }

  async closeLogin(sourceId) {
    const session = this.loginSessions.get(sourceId);
    if (!session) return false;
    this.loginSessions.delete(sourceId);
    if (session.timer) clearTimeout(session.timer);
    await session.close().catch(() => {});
    return true;
  }

  waitForIdle(timeoutMs = 120_000) {
    if (!this.current && !this.queue.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('等待云任务超时')), timeoutMs);
      timer.unref?.();
      this.idleWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }

  async shutdown() {
    this.stopScheduler();
    for (const id of [...this.loginSessions.keys()]) await this.closeLogin(id);
    this.store.close();
  }
}

module.exports = {
  CloudRuntime,
  daysUntil,
  zonedParts,
};
