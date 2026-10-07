import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';

import config from './config.js';
import { db } from './db.js';
import { hashIp, pruneRateLimiter, verifySession, SESSION_COOKIE } from './crypto.js';
import {
  HttpError,
  Router,
  clientIp,
  isSecure,
  parseCookies,
  securityHeaders,
  sendError,
  sendJson,
  sendStatic,
} from './http.js';
import { registerTransferRoutes } from './api/transfers.js';
import { registerRequestRoutes } from './api/requests.js';
import { isAdminConfigured, registerAdminRoutes } from './api/admin.js';
import { startCleanupLoop } from './cleanup.js';

const router = new Router();
registerTransferRoutes(router);
registerRequestRoutes(router);
registerAdminRoutes(router);

/* -------------------------------------------------------------------------
 * Seitenrouten
 * ---------------------------------------------------------------------- */

router.get('/', (ctx) => sendStatic(ctx.res, ctx.req, 'index.html'));
router.get('/t/:id', (ctx) => sendStatic(ctx.res, ctx.req, 't.html'));
router.get('/r/:id', (ctx) => sendStatic(ctx.res, ctx.req, 'r.html'));
router.get('/admin', (ctx) => sendStatic(ctx.res, ctx.req, 'admin.html'));
router.get('/admin/', (ctx) => sendStatic(ctx.res, ctx.req, 'admin.html'));
router.get('/impressum', (ctx) => sendStatic(ctx.res, ctx.req, 'legal.html'));
router.get('/datenschutz', (ctx) => sendStatic(ctx.res, ctx.req, 'legal.html'));

router.get('/healthz', (ctx) => {
  sendJson(ctx.res, 200, { ok: true, name: config.instanceName, adminConfigured: isAdminConfigured() });
});

/* -------------------------------------------------------------------------
 * Guards
 * ---------------------------------------------------------------------- */

/** Mutierende Anfragen muessen aus der eigenen Origin kommen (CSRF-Schutz). */
function enforceSameOrigin(req) {
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const origin = req.headers.origin;
  const site = req.headers['sec-fetch-site'];
  const host = String(req.headers.host || '');

  if (origin) {
    let originHost = '';
    try {
      originHost = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'Ungueltiger Origin');
    }
    if (originHost !== host) throw new HttpError(403, 'Cross-Origin-Anfrage abgelehnt');
    return;
  }
  // Kein Origin-Header: Browser senden dann Sec-Fetch-Site. "same-origin"/"none" ok.
  if (site && site !== 'same-origin' && site !== 'none') {
    throw new HttpError(403, 'Cross-Origin-Anfrage abgelehnt');
  }
}

function requireAdmin(ctx) {
  if (ctx.path.startsWith('/api/admin/') && ctx.path !== '/api/admin/login') {
    if (!verifySession(ctx.cookies[SESSION_COOKIE])) {
      throw new HttpError(401, 'Nicht angemeldet');
    }
  }
}

/* -------------------------------------------------------------------------
 * Kontext
 * ---------------------------------------------------------------------- */

function buildContext(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const ip = clientIp(req);
  const visitorRaw = req.headers['x-visitor-id'];
  const visitor =
    typeof visitorRaw === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(visitorRaw) ? visitorRaw : null;

  return {
    req,
    res,
    method: req.method,
    path: url.pathname,
    url,
    query: url.searchParams,
    ip,
    ipHash: hashIp(ip),
    visitorHash: hashIp(visitor ? `visitor:${visitor}` : `ip:${ip}`),
    secure: isSecure(req),
    cookies: parseCookies(req.headers.cookie),
  };
}

/* -------------------------------------------------------------------------
 * Request-Handling
 * ---------------------------------------------------------------------- */

async function handle(req, res) {
  securityHeaders(res, req);
  // Transfer-Links und Admin-Bereich gehoeren nicht in Suchmaschinen.
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.setHeader('Server', 'sharedrive');

  const ctx = buildContext(req, res);
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  if (method !== 'GET') enforceSameOrigin(req);

  const match = router.match(method, ctx.path);

  if (match && match.methodMismatch) {
    res.setHeader('Allow', 'GET, POST, PUT, PATCH, DELETE');
    throw new HttpError(405, 'Methode nicht erlaubt');
  }

  if (match) {
    requireAdmin(ctx);
    await match.handler({ ...ctx, params: match.params });
    return;
  }

  if (method === 'GET') {
    // Statische Dateien (CSS/JS/Bilder/PWA-Manifest)
    if (
      ctx.path.startsWith('/css/') ||
      ctx.path.startsWith('/js/') ||
      ctx.path.startsWith('/vendor/') ||
      ctx.path.startsWith('/assets/') ||
      ctx.path === '/favicon.svg' ||
      ctx.path === '/favicon.ico' ||
      ctx.path === '/manifest.webmanifest' ||
      ctx.path === '/robots.txt'
    ) {
      await sendStatic(res, req, ctx.path.slice(1));
      return;
    }
  }

  throw new HttpError(404, 'Nicht gefunden');
}

/** Optionales HTTPS direkt im Node-Prozess (sonst uebernimmt das ein Reverse Proxy). */
function createServer(handler) {
  if (config.tls.cert && config.tls.key) {
    const options = {
      cert: fs.readFileSync(config.tls.cert),
      key: fs.readFileSync(config.tls.key),
    };
    if (config.tls.ca) options.ca = fs.readFileSync(config.tls.ca);
    console.log('[sharedrive] HTTPS aktiv (TLS-Zertifikat geladen)');
    return https.createServer(options, handler);
  }
  return http.createServer(handler);
}

const server = createServer((req, res) => {
  // Keine Antwort darf ewig haengen (langsame Clients).
  res.setTimeout(10 * 60 * 1000, () => {
    if (!res.writableEnded) res.destroy();
  });

  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[sharedrive] Fehler:', err);
    // Ungelesenen Request-Body verwerfen, damit die Verbindung sauber schliesst.
    if (!req.readableEnded) req.resume();
    if (res.headersSent) {
      res.destroy();
      return;
    }
    try {
      securityHeaders(res, req);
      sendError(res, status, err instanceof HttpError ? err.message : 'Interner Fehler', err.extra || {});
    } catch {
      res.destroy();
    }
  });
});

server.headersTimeout = 65000;
server.requestTimeout = 0; // grosse Uploads duerfen laenger dauern
server.keepAliveTimeout = 30000;

/* -------------------------------------------------------------------------
 * Start
 * ---------------------------------------------------------------------- */

const cleanupTimer = startCleanupLoop();
const pruneTimer = setInterval(() => pruneRateLimiter(), 10 * 60 * 1000);
pruneTimer.unref?.();

server.listen(config.port, config.host, () => {
  const scheme = config.tls.cert && config.tls.key ? 'https' : 'http';
  const shown =
    config.publicUrl || `${scheme}://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`;
  console.log(`[sharedrive] ${config.instanceName} laeuft auf ${shown}`);
  if (scheme === 'http' && !config.publicUrl?.startsWith('https')) {
    console.warn(
      '[sharedrive] HINWEIS: Ohne HTTPS (TLS_CERT/TLS_KEY) oder Reverse Proxy steht im Browser\n' +
        '            kein WebCrypto zur Verfuegung. Zugriff dann nur ueber localhost moeglich.'
    );
  }
  console.log(`[sharedrive] Datenverzeichnis: ${config.dataDir}`);
  console.log(
    `[sharedrive] Upload-Limit pro Transfer: ${(config.maxTransferBytes / 1024 ** 3).toFixed(1)} GiB` +
      `, Chunk-Groesse: ${(config.clientChunkSize / 1024 ** 2).toFixed(0)} MiB`
  );
  if (!isAdminConfigured()) {
    console.warn('[sharedrive] Dashboard ist gesperrt: ADMIN_PASSWORD fehlt.');
  }
  if (config.notify.type) {
    console.log(`[sharedrive] Benachrichtigungen: ${config.notify.type}`);
  }
});

function shutdown(signal) {
  console.log(`[sharedrive] ${signal} empfangen - fahre herunter ...`);
  clearInterval(cleanupTimer);
  clearInterval(pruneTimer);
  server.close(() => {
    try {
      db.close();
    } catch {
      /* bereits geschlossen */
    }
    process.exit(0);
  });
  // Notbremse, falls offene Uploads das Schliessen blockieren
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

export { server };
