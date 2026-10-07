import crypto from 'node:crypto';
import { config } from './config.js';

/* -------------------------------------------------------------------------
 * Passwort-Hashing (scrypt, aus node:crypto - kein Zusatzpaket noetig)
 * ---------------------------------------------------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [scheme, N, r, p, saltB64, hashB64] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(N),
      r: Number(r),
      p: Number(p),
      maxmem: 256 * 1024 * 1024,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------
 * Tokens und IDs
 * ---------------------------------------------------------------------- */

/** Oeffentliche, gut lesbare Transfer-ID (ohne 0/O/1/l, damit sie vorlesbar bleibt). */
const ID_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';

export function publicId(length = 10) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ID_ALPHABET[bytes[i] % ID_ALPHABET.length];
  return out;
}

/** Geheimer Token fuer Upload-Autorisierung. */
export function secretToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualStrings(a, b) {
  const ba = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

/** IP-Adressen werden nur als HMAC gespeichert - DSGVO-freundlich und trotzdem rate-limitierbar. */
export function hashIp(ip) {
  if (!ip) return null;
  return crypto
    .createHmac('sha256', config.sessionSecret)
    .update(String(ip))
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Token fuer Client-Autorisierung (Upload-Token, Reverse-Share-Schluessel).
 * Format:  <id>.<base64url(hmac)>   - wird nie im Klartext in der DB abgelegt.
 */
export function signToken(kind, id, ttlSeconds = 0) {
  const exp = ttlSeconds > 0 ? Math.floor(Date.now() / 1000) + ttlSeconds : 0;
  const payload = `${kind}:${id}:${exp}`;
  const mac = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(payload)
    .digest('base64url');
  return `${exp}.${mac}`;
}

export function verifySignedToken(kind, id, token) {
  if (typeof token !== 'string') return false;
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const exp = Number.parseInt(token.slice(0, dot), 10);
  const mac = token.slice(dot + 1);
  if (!Number.isFinite(exp)) return false;
  if (exp > 0 && exp * 1000 < Date.now()) return false;
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(`${kind}:${id}:${exp}`)
    .digest('base64url');
  return timingSafeEqualStrings(mac, expected);
}

/* -------------------------------------------------------------------------
 * Admin-Session (signiertes Cookie, kein Server-State noetig)
 * ---------------------------------------------------------------------- */

const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function createSession() {
  const issued = Math.floor(Date.now() / 1000);
  const nonce = crypto.randomBytes(12).toString('base64url');
  const body = `admin.${issued}.${nonce}`;
  const mac = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(body)
    .digest('base64url');
  return `${body}.${mac}`;
}

export function verifySession(cookieValue) {
  if (typeof cookieValue !== 'string') return false;
  const idx = cookieValue.lastIndexOf('.');
  if (idx <= 0) return false;
  const body = cookieValue.slice(0, idx);
  const mac = cookieValue.slice(idx + 1);
  const expected = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(body)
    .digest('base64url');
  if (!timingSafeEqualStrings(mac, expected)) return false;
  const parts = body.split('.');
  if (parts.length !== 3 || parts[0] !== 'admin') return false;
  const issued = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(issued)) return false;
  return issued + SESSION_TTL_SECONDS > Math.floor(Date.now() / 1000);
}

export const SESSION_COOKIE = 'sr_session';
export const SESSION_MAX_AGE = SESSION_TTL_SECONDS;

/* -------------------------------------------------------------------------
 * Einfacher In-Memory Rate-Limiter (Sliding Window)
 * ---------------------------------------------------------------------- */

const buckets = new Map();

/**
 * @returns {{ok: boolean, retryAfter: number, remaining: number}}
 */
export function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let hits = buckets.get(key);
  if (!hits) {
    hits = [];
    buckets.set(key, hits);
  }
  // abgelaufene Treffer entfernen
  while (hits.length && hits[0] <= now - windowMs) hits.shift();

  if (hits.length >= limit) {
    const retryAfter = Math.ceil((hits[0] + windowMs - now) / 1000);
    return { ok: false, retryAfter: Math.max(retryAfter, 1), remaining: 0 };
  }
  hits.push(now);
  return { ok: true, retryAfter: 0, remaining: limit - hits.length };
}

/** Alte Buckets regelmaessig verwerfen, damit der Speicher nicht waechst. */
export function pruneRateLimiter(maxAgeMs = 15 * 60 * 1000) {
  const now = Date.now();
  for (const [key, hits] of buckets) {
    if (!hits.length || hits[hits.length - 1] <= now - maxAgeMs) buckets.delete(key);
  }
}
