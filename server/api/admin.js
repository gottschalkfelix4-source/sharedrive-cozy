import config from '../config.js';
import { db, stmt, getBranding, getSetting, setSetting } from '../db.js';
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  createSession,
  hashIp,
  hashPassword,
  publicId,
  rateLimit,
  verifyPassword,
} from '../crypto.js';
import { HttpError, baseUrl, isSecure, readJson, sendJson } from '../http.js';
import { deleteTransferFiles, diskUsage } from '../storage.js';
import { runCleanup } from '../cleanup.js';
import { notifyTest } from '../notifications.js';

/** Der Admin-Passwort-Hash wird einmal beim Start berechnet und nie geloggt. */
const adminHash = config.adminPassword ? hashPassword(config.adminPassword) : null;

export function isAdminConfigured() {
  return Boolean(adminHash);
}

export function registerAdminRoutes(router) {
  router.post('/api/admin/login', login);
  router.post('/api/admin/logout', logout);
  router.get('/api/admin/overview', overview);
  router.get('/api/admin/transfers', listTransfers);
  router.patch('/api/admin/transfers/:id', updateTransfer);
  router.delete('/api/admin/transfers/:id', deleteTransfer);
  router.get('/api/admin/transfers/:id/downloads', transferDownloads);
  router.get('/api/admin/activity', activity);
  router.get('/api/admin/chart', chart);
  router.get('/api/admin/requests', listRequests);
  router.post('/api/admin/requests', createRequest);
  router.delete('/api/admin/requests/:id', deleteRequest);
  router.get('/api/admin/requests/:id/submissions', requestSubmissions);
  router.patch('/api/admin/branding', updateBranding);
  router.post('/api/admin/maintenance/cleanup', maintenanceCleanup);
  router.post('/api/admin/notify-test', testNotification);
}

/* -------------------------------------------------------------------------
 * Login
 * ---------------------------------------------------------------------- */

async function login(ctx) {
  const rl = rateLimit(`login:${ctx.ipHash}`, 8, 15 * 60 * 1000);
  if (!rl.ok) {
    throw new HttpError(429, `Zu viele Login-Versuche. Bitte ${rl.retryAfter} Sekunden warten.`);
  }
  if (!adminHash) {
    throw new HttpError(503, 'Kein ADMIN_PASSWORD gesetzt. Bitte in der .env konfigurieren und neu starten.');
  }
  const body = await readJson(ctx.req, 4096);
  const password = typeof body.password === 'string' ? body.password : '';
  if (!password || !verifyPassword(password, adminHash)) {
    // absichtlich unspezifisch
    throw new HttpError(401, 'Falsches Passwort');
  }
  res_setSessionCookie(ctx, createSession());
  sendJson(ctx.res, 200, { authenticated: true });
}

function res_setSessionCookie(ctx, value) {
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (isSecure(ctx.req)) parts.push('Secure');
  ctx.res.setHeader('Set-Cookie', parts.join('; '));
}

function logout(ctx) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecure(ctx.req)) parts.push('Secure');
  ctx.res.setHeader('Set-Cookie', parts.join('; '));
  sendJson(ctx.res, 200, { authenticated: false });
}

/* -------------------------------------------------------------------------
 * Uebersicht und Statistiken
 * ---------------------------------------------------------------------- */

async function overview(ctx) {
  const totals = stmt.statTotals.get();
  const usage = await diskUsage();
  const totals2 = {
    transfers: Number(totals.transfers ?? 0),
    ready: Number(totals.ready ?? 0),
    uploading: Number(totals.uploading ?? 0),
    files: Number(totals.files ?? 0),
    bytes: Number(totals.bytes ?? 0),
    downloads: Number(totals.downloads ?? 0),
    requests: Number(stmt.countRequests.get().n ?? 0),
  };
  sendJson(ctx.res, 200, {
    instanceName: config.instanceName,
    branding: getBranding(),
    totals: totals2,
    disk: { bytes: usage.total, transfers: usage.transfers },
    limits: {
      maxTransferBytes: config.maxTransferBytes,
      storageQuotaBytes: config.storageQuotaBytes,
      defaultExpiryHours: config.defaultExpiryHours,
      maxExpiryHours: config.maxExpiryHours,
      retentionDays: config.downloadLogRetentionDays,
    },
    notifications: {
      type: config.notify.type || null,
      configured: Boolean(config.notify.type && (config.notify.url || config.smtp.host)),
      emailTo: config.notify.emailTo || null,
    },
    smtp: { configured: Boolean(config.smtp.host) },
    trustProxy: config.trustProxy,
    adminPasswordSet: Boolean(adminHash),
  });
}

function listTransfers(ctx) {
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') || '1', 10) || 1);
  const perPage = 25;
  const q = (ctx.query.get('q') || '').trim();
  const offset = (page - 1) * perPage;

  let rows;
  let total;
  if (q) {
    const like = `%${q}%`;
    rows = stmt.listTransfersFiltered.all({ q: like, limit: perPage, offset });
    total = Number(stmt.countTransfersFiltered.get({ q: like }).n);
  } else {
    rows = stmt.listTransfers.all(perPage, offset);
    total = Number(stmt.countTransfers.get().n);
  }

  sendJson(ctx.res, 200, {
    page,
    perPage,
    total,
    pages: Math.max(1, Math.ceil(total / perPage)),
    transfers: rows.map(shapeTransfer),
  });
}

function shapeTransfer(row) {
  return {
    id: row.id,
    state: row.state,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    downloads: row.downloads,
    maxDownloads: row.max_downloads,
    bytes: row.total_cipher_bytes,
    fileCount: row.file_count,
    passwordProtected: Boolean(row.password_protected),
    notify: Boolean(row.notify),
    note: row.note,
    requestId: row.request_id,
    expired: row.expires_at < Date.now(),
  };
}

async function updateTransfer(ctx) {
  const transfer = stmt.getTransfer.get(ctx.params.id);
  if (!transfer) throw new HttpError(404, 'Transfer nicht gefunden');
  const body = await readJson(ctx.req, 4096);

  if (body.note !== undefined) {
    const note = body.note === null ? null : String(body.note).slice(0, 200);
    db.prepare('UPDATE transfers SET note = ? WHERE id = ?').run(note, transfer.id);
  }
  if (body.expiresInHours !== undefined) {
    const hours = Number(body.expiresInHours);
    if (!Number.isFinite(hours) || hours < 1 || hours > config.maxExpiryHours) {
      throw new HttpError(400, 'Ungueltige Ablaufzeit');
    }
    stmt.extendTransfer.run(Date.now() + hours * 3600 * 1000, transfer.id);
  }
  if (body.maxDownloads !== undefined) {
    const value = Number(body.maxDownloads);
    if (!Number.isInteger(value) || value < 0 || value > 100000) {
      throw new HttpError(400, 'Ungueltiges Download-Limit');
    }
    db.prepare('UPDATE transfers SET max_downloads = ? WHERE id = ?').run(value, transfer.id);
  }
  if (body.downloads !== undefined) {
    const value = Number(body.downloads);
    if (!Number.isInteger(value) || value < 0 || value > 1000000) {
      throw new HttpError(400, 'Ungueltiger Zaehler');
    }
    db.prepare('UPDATE transfers SET downloads = ? WHERE id = ?').run(value, transfer.id);
  }

  const fresh = stmt.getTransfer.get(transfer.id);
  sendJson(ctx.res, 200, shapeTransfer(fresh));
}

async function deleteTransfer(ctx) {
  const transfer = stmt.getTransfer.get(ctx.params.id);
  if (!transfer) throw new HttpError(404, 'Transfer nicht gefunden');
  stmt.deleteTransfer.run(transfer.id);
  db.prepare('DELETE FROM downloads WHERE transfer_id = ?').run(transfer.id);
  await deleteTransferFiles(transfer.id);
  sendJson(ctx.res, 200, { deleted: transfer.id });
}

function transferDownloads(ctx) {
  const transfer = stmt.getTransfer.get(ctx.params.id);
  if (!transfer) throw new HttpError(404, 'Transfer nicht gefunden');
  const rows = stmt.listDownloads.all(transfer.id, 100);
  sendJson(ctx.res, 200, {
    total: Number(stmt.countDownloadsByTransfer.get(transfer.id).n),
    entries: rows.map((r) => ({
      ts: r.ts,
      kind: r.kind,
      userAgent: r.user_agent,
      ipHash: r.ip_hash ? `${r.ip_hash.slice(0, 6)}...` : null,
      fileIdx: r.file_idx,
    })),
  });
}

function activity(ctx) {
  const limit = Math.min(200, Math.max(1, Number.parseInt(ctx.query.get('limit') || '50', 10) || 50));
  const rows = stmt.recentDownloads.all(limit);
  sendJson(ctx.res, 200, {
    entries: rows.map((r) => ({
      ts: r.ts,
      kind: r.kind,
      transferId: r.transfer_id,
      note: r.transfer_note,
      userAgent: r.user_agent,
    })),
  });
}

function chart(ctx) {
  const days = Math.min(90, Math.max(1, Number.parseInt(ctx.query.get('days') || '14', 10) || 14));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const rows = stmt.downloadsPerDay.all(since);
  const buckets = new Map();
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    buckets.set(day, 0);
  }
  for (const row of rows) {
    const day = new Date(row.ts).toISOString().slice(0, 10);
    if (buckets.has(day)) buckets.set(day, buckets.get(day) + 1);
  }
  sendJson(ctx.res, 200, {
    days: [...buckets.entries()].map(([day, count]) => ({ day, count })),
  });
}

/* -------------------------------------------------------------------------
 * Reverse-Share-Portale
 * ---------------------------------------------------------------------- */

function listRequests(ctx) {
  const page = Math.max(1, Number.parseInt(ctx.query.get('page') || '1', 10) || 1);
  const perPage = 25;
  const rows = stmt.listRequests.all(perPage, (page - 1) * perPage);
  sendJson(ctx.res, 200, {
    page,
    total: Number(stmt.countRequests.get().n),
    requests: rows.map((r) => ({
      id: r.id,
      state: r.state,
      title: r.title,
      message: r.message,
      hint: r.hint,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      maxFiles: r.max_files,
      maxTransferBytes: r.max_transfer_bytes,
      submissions: r.submissions,
      maxSubmissions: r.max_submissions,
      passwordProtected: Boolean(r.password_protected),
      notify: Boolean(r.notify),
      expired: r.expires_at < Date.now(),
    })),
  });
}

async function createRequest(ctx) {
  const body = await readJson(ctx.req, 8192);
  const title = String(body.title || '').trim().slice(0, 120);
  if (!title) throw new HttpError(400, 'Titel fehlt');

  const expiresInHours = Number(body.expiresInHours ?? config.defaultExpiryHours);
  if (!Number.isFinite(expiresInHours) || expiresInHours < 1 || expiresInHours > config.maxExpiryHours) {
    throw new HttpError(400, 'Ungueltige Ablaufzeit');
  }
  const maxFiles = Math.min(2000, Math.max(1, Number(body.maxFiles ?? 20) || 20));
  const maxTransferBytes = Math.min(
    config.maxTransferBytes,
    Math.max(0, Number(body.maxTransferBytes ?? config.maxTransferBytes) || 0)
  );
  const maxSubmissions = Math.min(1000, Math.max(0, Number(body.maxSubmissions ?? 0) || 0));
  const password = typeof body.password === 'string' && body.password ? body.password : null;
  if (password && password.length < 4) throw new HttpError(400, 'Passwort zu kurz (min. 4 Zeichen)');

  const id = publicId(9);
  const now = Date.now();
  stmt.insertRequest.run({
    id,
    title,
    message: body.message ? String(body.message).slice(0, 1000) : null,
    hint: body.hint ? String(body.hint).slice(0, 200) : null,
    created_at: now,
    expires_at: now + expiresInHours * 3600 * 1000,
    max_files: maxFiles,
    max_transfer_bytes: maxTransferBytes,
    max_submissions: maxSubmissions,
    password_hash: password ? hashPassword(password) : null,
    password_protected: password ? 1 : 0,
    notify: body.notify === false ? 0 : 1,
  });

  const fresh = stmt.getRequest.get(id);
  sendJson(ctx.res, 201, {
    id,
    url: `${baseUrl(ctx.req)}/r/${id}`,
    title: fresh.title,
    expiresAt: fresh.expires_at,
    passwordProtected: Boolean(fresh.password_protected),
  });
}

async function deleteRequest(ctx) {
  const request = stmt.getRequest.get(ctx.params.id);
  if (!request) throw new HttpError(404, 'Portal nicht gefunden');
  const submissions = db
    .prepare('SELECT id FROM transfers WHERE request_id = ?')
    .all(request.id);
  for (const row of submissions) {
    stmt.deleteTransfer.run(row.id);
    db.prepare('DELETE FROM downloads WHERE transfer_id = ?').run(row.id);
    await deleteTransferFiles(row.id);
  }
  stmt.deleteRequest.run(request.id);
  sendJson(ctx.res, 200, { deleted: request.id, submissions: submissions.length });
}

function requestSubmissions(ctx) {
  const request = stmt.getRequest.get(ctx.params.id);
  if (!request) throw new HttpError(404, 'Portal nicht gefunden');
  const rows = db
    .prepare('SELECT * FROM transfers WHERE request_id = ? ORDER BY created_at DESC')
    .all(request.id);
  sendJson(ctx.res, 200, {
    request: { id: request.id, title: request.title, submissions: request.submissions },
    transfers: rows.map(shapeTransfer),
  });
}

/* -------------------------------------------------------------------------
 * Branding und Wartung
 * ---------------------------------------------------------------------- */

async function updateBranding(ctx) {
  const body = await readJson(ctx.req, 8192);
  const allowed = {
    brand_name: body.name,
    brand_tagline: body.tagline,
    brand_theme: body.theme,
    brand_logo_url: body.logoUrl,
  };
  for (const [key, value] of Object.entries(allowed)) {
    if (value === undefined) continue;
    setSetting(key, String(value).slice(0, 300));
  }
  sendJson(ctx.res, 200, { branding: getBranding() });
}

async function maintenanceCleanup(ctx) {
  const result = await runCleanup();
  const usage = await diskUsage();
  sendJson(ctx.res, 200, { result, disk: { bytes: usage.total, transfers: usage.transfers } });
}

async function testNotification(ctx) {
  const result = await notifyTest();
  sendJson(ctx.res, 200, { result });
}

export { hashIp };
