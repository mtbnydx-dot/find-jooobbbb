'use strict';

const crypto = require('crypto');

function contractError(message, statusCode, code, detail) {
  return Object.assign(new Error(message), { statusCode, code, detail });
}

function expectedVersion(value) {
  if (value === undefined) return null; // Older clients remain compatible.
  if (!Number.isSafeInteger(value) || value < 1) throw contractError('expectedVersion 必须为正整数', 400, 'INVALID_VERSION');
  return value;
}

function assertVersion(resource, expected, current) {
  if (expected !== null && expected !== Number(current)) {
    throw contractError('内容已在其他设备更新，请重新加载后再修改', 409, 'VERSION_CONFLICT', { resource, expectedVersion: expected, currentVersion: Number(current) });
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value === undefined ? null : value;
}

function fingerprint(value) { return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex'); }

function idempotencyKey(value) {
  if (value === undefined || value === '') return '';
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw contractError('幂等键格式无效', 400, 'INVALID_IDEMPOTENCY_KEY');
  return value;
}

function corsMiddleware(origins = []) {
  const values = Array.isArray(origins) ? origins : String(origins || '').split(',').filter(Boolean);
  const allowed = new Set(values.map(value => {
    const url = new URL(String(value).trim());
    if (!['https:', 'http:'].includes(url.protocol) || url.origin !== String(value).trim()) throw new Error('CORS origins must be exact HTTP(S) origins');
    return url.origin;
  }));
  return (req, res, next) => {
    res.setHeader('X-Api-Contract', '2026-10-mobile-v1');
    const origin = req.headers.origin;
    if (!origin) return next(); // Native clients do not implement browser CORS.
    const sameOrigin = origin === `${req.protocol}://${req.get('host')}`;
    if (!sameOrigin && !allowed.has(origin)) return next(contractError('此来源未获授权', 403, 'ORIGIN_NOT_ALLOWED'));
    res.vary('Origin');
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Expose-Headers', 'X-Api-Contract, Retry-After');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Idempotency-Key, X-Job-Client');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
    return next();
  };
}

function capabilities(platform) {
  const configured = Boolean(platform.authMessageSender && platform.publicAppUrl);
  return {
    contractVersion: '2026-10-mobile-v1',
    authentication: { schemes: ['cookie', 'bearer'], tokenStorage: 'native_secure_storage_or_memory', refreshRequiresValidSession: true },
    session: { ttlSeconds: Math.floor(platform.sessionTtlMs / 1000), rotation: true, deviceMetadata: true },
    recovery: { passwordResetConfigured: configured, emailVerificationConfigured: configured },
    features: { prepIdempotency: true, profileVersion: true, examVersion: true, submittedExamResults: true, uploads: true, nativePush: false },
  };
}

module.exports = { contractError, expectedVersion, assertVersion, fingerprint, idempotencyKey, corsMiddleware, capabilities };
