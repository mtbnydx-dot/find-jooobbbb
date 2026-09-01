'use strict';

const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);
const PASSWORD_SCHEME = 'scrypt-v1';
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (!email || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const error = new Error('请输入有效邮箱');
    error.statusCode = 400;
    error.code = 'INVALID_EMAIL';
    throw error;
  }
  return email;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 256) {
    const error = new Error('密码长度需为 8-256 个字符');
    error.statusCode = 400;
    error.code = 'INVALID_PASSWORD';
    throw error;
  }
  return value;
}

async function derivePassword(password, salt) {
  return scrypt(password, salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
}

async function hashPassword(value) {
  const password = validatePassword(value);
  const salt = crypto.randomBytes(16);
  const key = await derivePassword(password, salt);
  return [
    PASSWORD_SCHEME,
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    salt.toString('base64url'),
    Buffer.from(key).toString('base64url'),
  ].join('$');
}

async function verifyPassword(value, encoded) {
  if (typeof value !== 'string' || typeof encoded !== 'string') return false;
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== PASSWORD_SCHEME) return false;
  const [scheme, nText, rText, pText, saltText, keyText] = parts;
  void scheme;
  if (Number(nText) !== SCRYPT_N || Number(rText) !== SCRYPT_R || Number(pText) !== SCRYPT_P) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(saltText, 'base64url');
    expected = Buffer.from(keyText, 'base64url');
  } catch (_) {
    return false;
  }
  if (salt.length !== 16 || expected.length !== SCRYPT_KEY_LENGTH) return false;
  const actual = Buffer.from(await derivePassword(value, salt));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function newOpaqueToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function randomId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '')}`;
}

function parseCookies(header) {
  const result = {};
  for (const chunk of String(header || '').split(';')) {
    const index = chunk.indexOf('=');
    if (index <= 0) continue;
    const key = chunk.slice(0, index).trim();
    const value = chunk.slice(index + 1).trim();
    if (!key) continue;
    try { result[key] = decodeURIComponent(value); } catch (_) { result[key] = value; }
  }
  return result;
}

function sessionCookie(token, {
  name = 'job_session',
  maxAgeSeconds = 30 * 24 * 60 * 60,
  secure = false,
  clear = false,
} = {}) {
  const attributes = [
    `${name}=${clear ? '' : encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${clear ? 0 : Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

module.exports = {
  hashPassword,
  hashSessionToken,
  newOpaqueToken,
  normalizeEmail,
  parseCookies,
  randomId,
  sessionCookie,
  validatePassword,
  verifyPassword,
};
