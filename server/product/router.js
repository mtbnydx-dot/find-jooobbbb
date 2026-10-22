'use strict';

const express = require('express');
const { parseCookies, sessionCookie } = require('./auth');
const { ProductError } = require('./platform');
const { registerCommerceRoutes } = require('./commerce');

function requestToken(req, cookieName) {
  const authorization = String(req.headers.authorization || '');
  if (/^Bearer\s+/i.test(authorization)) return authorization.replace(/^Bearer\s+/i, '').trim();
  return parseCookies(req.headers.cookie || '')[cookieName] || '';
}

function createProductRouter({ platform, cookieName = 'job_session', secureCookies = false } = {}) {
  if (!platform) throw new Error('createProductRouter 需要 ProductPlatform');
  const router = express.Router();
  // Only the bounded editorial import endpoint accepts larger JSON batches.
  router.use('/admin/content/import', express.json({ limit: '4mb', strict: true }));
  router.use(express.json({ limit: '128kb', strict: true }));
  const authAttempts = new Map();
  router.use('/auth', (req,res,next) => {
    if (req.method !== 'POST' || !['/login','/register'].includes(req.path)) return next();
    const now = Date.now();
    for (const [key,value] of authAttempts) if (value.until <= now) authAttempts.delete(key);
    const key = `${req.ip}:${req.path}`;
    const value = authAttempts.get(key) || { count:0, until:now+600000 };
    if (value.count >= (req.path === '/register' ? 20 : 60)) {
      res.set('Retry-After',String(Math.ceil((value.until-now)/1000)));
      return res.status(429).json({ ok:false,error:'尝试次数过多，请稍后再试' });
    }
    if (authAttempts.size >= 10000 && !authAttempts.has(key)) return res.status(429).json({ ok:false,error:'服务繁忙，请稍后重试' });
    value.count++;authAttempts.set(key,value);next();
  });

  const optionalAuth = (req, res, next) => {
    try {
      req.productToken = requestToken(req, cookieName);
      req.productUser = platform.authenticate(req.productToken);
      return next();
    } catch (error) {
      return next(error);
    }
  };

  const requireAuth = (req, res, next) => {
    optionalAuth(req, res, error => {
      if (error) return next(error);
      if (!req.productUser) return next(new ProductError('请先登录', 401, 'AUTH_REQUIRED'));
      return next();
    });
  };

  const asyncRoute = handler => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
  const setSession = (req, res, result) => {
    const maxAgeSeconds = Math.max(0, Math.floor(platform.sessionTtlMs / 1000));
    res.setHeader('Set-Cookie', sessionCookie(result.token, {
      name: cookieName,
      maxAgeSeconds,
      secure: secureCookies || req.secure,
    }));
  };

  registerCommerceRoutes(router, { platform, requireAuth });
  require('./workspace').registerWorkspaceRoutes(router, { platform, requireAuth });
  require('./content-admin').registerContentRoutes(router, { platform, requireAuth });
  require('./content-import').registerContentImportRoutes(router, { platform, requireAuth });
  require('./account').registerAccountRoutes(router, { platform, requireAuth, cookieName, secureCookies });

  router.get('/health', (req, res) => {
    res.json({ ok: true, product: true, paymentConfigured: platform.isPaymentConfigured() });
  });

  router.post('/auth/register', asyncRoute(async (req, res) => {
    const result = await platform.register(req.body);
    setSession(req, res, result);
    return res.status(201).json({ ok: true, user: result.user, expiresAt: result.expiresAt, sessionToken: result.token });
  }));

  router.post('/auth/login', asyncRoute(async (req, res) => {
    const result = await platform.login(req.body);
    setSession(req, res, result);
    return res.json({ ok: true, user: result.user, expiresAt: result.expiresAt, sessionToken: result.token });
  }));

  router.post('/auth/logout', optionalAuth, (req, res) => {
    platform.logout(req.productToken);
    res.setHeader('Set-Cookie', sessionCookie('', { name: cookieName, clear: true, secure: secureCookies || req.secure }));
    return res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req, res) => {
    res.json({
      ok: true,
      user: req.productUser,
      profile: platform.getProfile(req.productUser.id),
      entitlements: platform.entitlements(req.productUser),
    });
  });

  router.get('/jobs', optionalAuth, (req, res) => {
    const result = platform.listJobs({
      user: req.productUser,
      cursor: req.query.cursor || '',
      limit: req.query.limit,
      filters: {
        q: req.query.q,
        major: req.query.major,
        role: req.query.role,
        location: req.query.location,
        industry: req.query.industry,
        salaryMin: req.query.salaryMin,
        salaryMax: req.query.salaryMax,
        salaryPeriod: req.query.salaryPeriod,
        currency: req.query.currency,
        sort: req.query.sort,
      },
    });
    res.json({ ok: true, jobs: result.items, total: result.total, nextCursor: result.nextCursor, limit: result.limit });
  });

  router.get('/jobs/:id/exam-packs', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.examPacksForJob(req.productUser, req.params.id) }); } catch (error) { return next(error); }
  });

  router.get('/jobs/:id', optionalAuth, (req, res, next) => {
    try { return res.json({ ok: true, job: platform.getJob(req.params.id, req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/dashboard', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.dashboard(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/salary/insights', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.salaryInsights(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/me/profile', requireAuth, (req, res) => {
    res.json({ ok: true, profile: platform.getProfile(req.productUser.id) });
  });

  router.get('/me/notifications', requireAuth, (req,res,next) => {
    try { res.json({ok:true,...platform.notifications(req.productUser)}); } catch(error) {next(error);}
  });
  router.get('/me/export',requireAuth,(req,res,next)=>{
    try {res.json({ok:true,...platform.exportAccount(req.productUser)});}catch(error){next(error);}
  });
  router.delete('/me/account',requireAuth,asyncRoute(async(req,res)=>{
    const result=await platform.deleteAccount(req.productUser,req.body);
    res.setHeader('Set-Cookie',sessionCookie('',{name:cookieName,clear:true,secure:secureCookies || req.secure}));
    res.json({ok:true,...result});
  }));
  router.post('/me/notifications/read', requireAuth, (req,res,next) => {
    try { res.json({ok:true,...platform.readNotifications(req.productUser)}); } catch(error) {next(error);}
  });

  router.put('/me/profile', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, profile: platform.updateProfile(req.productUser, req.body) }); } catch (error) { return next(error); }
  });

  router.put('/me/jobs/:id', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, state: platform.updateJobState(req.productUser, req.params.id, req.body) }); } catch (error) { return next(error); }
  });

  router.get('/me/pipeline', requireAuth, (req, res, next) => {
    try {
      const pipeline = platform.pipeline(req.productUser);
      return res.json({ ok: true, pipeline, counts: pipeline.counts, items: pipeline.items });
    } catch (error) { return next(error); }
  });

  router.get('/me/entitlements', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.entitlements(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/me/prep/progress', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, progress: platform.prepProgress(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/prep/tracks', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, tracks: platform.listPrepTracks(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/prep/library', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.prepLibrary(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/prep/questions', requireAuth, (req, res, next) => {
    try {
      const result = platform.listPrepQuestions(req.productUser, {
        trackId: req.query.trackId || '', cursor: req.query.cursor || '', limit: req.query.limit,
        examType: req.query.examType || '', section: req.query.section || '', contentKind: req.query.contentKind || '',
      });
      return res.json({ ok: true, questions: result.items, total: result.total, nextCursor: result.nextCursor, limit: result.limit });
    } catch (error) { return next(error); }
  });

  router.post('/prep/attempts', requireAuth, (req, res, next) => {
    try { return res.status(201).json({ ok: true, ...platform.submitPrepAttempts(req.productUser, req.body) }); } catch (error) { return next(error); }
  });

  router.get('/exams/packs', requireAuth, (req, res, next) => {
    try {
      const result = platform.listExamPacks(req.productUser, {
        q: req.query.q,
        company: req.query.company,
        role: req.query.role,
        major: req.query.major,
        year: req.query.year,
        type: req.query.type,
        difficulty: req.query.difficulty,
      });
      return res.json({ ok: true, packs: result.items, total: result.total, facets: result.facets });
    } catch (error) { return next(error); }
  });

  router.get('/exams/packs/:id', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.getExamPack(req.productUser, req.params.id) }); } catch (error) { return next(error); }
  });

  router.post('/exams/sessions', requireAuth, (req, res, next) => {
    try { return res.status(201).json({ ok: true, ...platform.startExamSession(req.productUser, req.body) }); } catch (error) { return next(error); }
  });

  router.get('/exams/sessions/:id', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.getExamSession(req.productUser, req.params.id) }); } catch (error) { return next(error); }
  });

  router.put('/exams/sessions/:id', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, session: platform.saveExamSession(req.productUser, req.params.id, req.body) }); } catch (error) { return next(error); }
  });

  router.post('/exams/sessions/:id/submit', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, ...platform.submitExamSession(req.productUser, req.params.id, req.body) }); } catch (error) { return next(error); }
  });

  router.get('/me/exams/summary', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, summary: platform.examSummary(req.productUser) }); } catch (error) { return next(error); }
  });

  router.get('/me/exams/wrong', requireAuth, (req, res, next) => {
    try {
      return res.json({
        ok: true,
        items: platform.examWrongAnswers(req.productUser, {
          includeMastered: ['1', 'true', 'yes'].includes(String(req.query.includeMastered || '').toLowerCase()),
          limit: req.query.limit,
        }),
      });
    } catch (error) { return next(error); }
  });

  router.post('/billing/checkout', requireAuth, asyncRoute(async (req, res) => {
    const checkout = await platform.checkout(req.productUser, req.body);
    return res.status(201).json({ ok: true, checkout });
  }));

  router.get('/admin/users', requireAuth, (req, res, next) => {
    try { return res.json({ ok: true, users: platform.listUsers(req.productUser, req.query.limit) }); } catch (error) { return next(error); }
  });

  router.post('/admin/prep/questions', requireAuth, (req, res, next) => {
    try { return res.status(201).json({ ok: true, question: require('./content-admin').initializeContent(platform).createQuestion(req.productUser, req.body) }); } catch (error) { return next(error); }
  });

  router.use((error, req, res, next) => {
    void req; void next;
    const status = Number(error.statusCode) || 500;
    const productError = error instanceof ProductError || status < 500;
    const body = {
      ok: false,
      error: productError ? error.message : '产品服务暂时不可用',
      code: error.code || (status >= 500 ? 'INTERNAL_ERROR' : 'PRODUCT_ERROR'),
    };
    if (error.detail !== null && error.detail !== undefined) body.detail = error.detail;
    return res.status(status).json(body);
  });

  return router;
}

module.exports = {
  createProductRouter,
};
