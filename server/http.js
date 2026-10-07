import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, ROOT } from './config.js';

/** Mini-Router mit :param-Platzhaltern. */
export class Router {
  constructor() {
    this.routes = [];
  }

  add(method, pattern, handler) {
    this.routes.push({ method, segments: pattern.split('/').filter(Boolean), handler });
    return this;
  }

  get(p, h) {
    return this.add('GET', p, h);
  }
  post(p, h) {
    return this.add('POST', p, h);
  }
  put(p, h) {
    return this.add('PUT', p, h);
  }
  patch(p, h) {
    return this.add('PATCH', p, h);
  }
  delete(p, h) {
    return this.add('DELETE', p, h);
  }

  match(method, pathname) {
    const parts = pathname.split('/').filter(Boolean);
    let methodMismatch = false;
    for (const route of this.routes) {
      if (route.segments.length !== parts.length) continue;
      if (route.method !== method) {
        // gleicher Pfad, andere Methode -> 405 statt 404
        let same = true;
        for (let i = 0; i < parts.length; i++) {
          if (!route.segments[i].startsWith(':') && route.segments[i] !== parts[i]) {
            same = false;
            break;
          }
        }
        if (same) methodMismatch = true;
        continue;
      }
      const params = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const seg = route.segments[i];
        if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(parts[i]);
        else if (seg !== parts[i]) {
          ok = false;
          break;
        }
      }
      if (ok) return { handler: route.handler, params };
    }
    return methodMismatch ? { methodMismatch: true } : null;
  }
}

/* -------------------------------------------------------------------------
 * Request-Kontext
 * ---------------------------------------------------------------------- */

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

export function clientIp(req) {
  if (config.trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (fwd) return String(fwd).split(',')[0].trim();
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return req.socket?.remoteAddress || '';
}

export function isSecure(req) {
  if (config.trustProxy) {
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
    if (proto) return proto === 'https';
  }
  return Boolean(req.socket?.encrypted);
}

export function baseUrl(req) {
  if (config.publicUrl) return config.publicUrl;
  const secure = isSecure(req);
  const host = String(req.headers.host || `localhost:${config.port}`);
  return `${secure ? 'https' : 'http'}://${host}`;
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      out[key] = part.slice(eq + 1).trim();
    }
  }
  return out;
}

/** Liest einen JSON-Body mit harter Obergrenze (Schutz vor Speicher-Overflow). */
export async function readJson(req, limit = config.maxJsonBodyBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new HttpError(413, 'Anfrage zu gross');
    chunks.push(chunk);
  }
  if (!total) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Ungueltiges JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'Ungueltiges JSON');
  }
  return parsed;
}

/* -------------------------------------------------------------------------
 * Responses
 * ---------------------------------------------------------------------- */

export function securityHeaders(res, req) {
  // Keine externen Ressourcen -> sehr strikte CSP ist moeglich.
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data: blob:",
      "font-src 'self'",
      "connect-src 'self'",
      "media-src 'self' blob:",
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=(), interest-cohort=()');
  res.setHeader('X-Frame-Options', 'DENY');
  if (isSecure(req)) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
}

export function sendJson(res, status, data, headers = {}) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendText(res, status, text, headers = {}) {
  const body = Buffer.from(text);
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, status, message, extra = {}) {
  sendJson(res, status, { error: message, ...extra });
}

export function sendNoContent(res) {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/* -------------------------------------------------------------------------
 * Statische Dateien
 * ---------------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

export const PUBLIC_DIR = path.join(ROOT, 'public');

export async function sendStatic(res, req, relativePath, { immutable = false } = {}) {
  const clean = path
    .normalize(relativePath)
    .replace(/^([/\\]|\.\.[/\\])+/, '')
    .replace(/\\/g, '/');
  const target = path.join(PUBLIC_DIR, clean);
  if (!target.startsWith(PUBLIC_DIR)) {
    sendError(res, 403, 'Verboten');
    return;
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    sendError(res, 404, 'Nicht gefunden');
    return;
  }
  if (stat.isDirectory()) {
    sendError(res, 404, 'Nicht gefunden');
    return;
  }

  const etag = `W/"${stat.size}-${Math.round(stat.mtimeMs)}"`;
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag });
    res.end();
    return;
  }
  const ext = path.extname(target).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    ETag: etag,
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(target).pipe(res);
}
