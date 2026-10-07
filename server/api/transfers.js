import fsp from 'node:fs/promises';
import config from '../config.js';
import { stmt, getBranding } from '../db.js';
import { publicId, rateLimit, signToken, verifySignedToken } from '../crypto.js';
import { HttpError, baseUrl, readJson, sendJson, sendNoContent } from '../http.js';
import {
  chunkPath,
  deleteTransferFiles,
  ensureTransferDirs,
  receivedChunks,
  writeChunkStream,
} from '../storage.js';
import { notifyDownload } from '../notifications.js';
import { MAX_FILES } from '../limits.js';

const GCM_TAG_BYTES = 16;

/** Schonfrist, nachdem das Download-Limit erreicht wurde (2 Stunden). */
const EXHAUST_GRACE_MS = 2 * 60 * 60 * 1000;

/* -------------------------------------------------------------------------
 * Validierung
 * ---------------------------------------------------------------------- */

function requireString(value, name, maxLength = 64) {
  if (typeof value !== 'string' || !value.length) throw new HttpError(400, `${name} fehlt`);
  if (value.length > maxLength) throw new HttpError(400, `${name} zu lang`);
  return value;
}

function intInRange(value, name, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new HttpError(400, `${name} ungueltig`);
  if (n < min || n > max) throw new HttpError(400, `${name} ausserhalb des erlaubten Bereichs`);
  return n;
}

/**
 * Der Schluessel-Container ist fuer den Server ein undurchsichtiger Block.
 * Er darf nur bekannte Felder enthalten und klein bleiben.
 *
 *   link     - kein Container, der Schluessel steckt nur im URL-Fragment
 *   password - { salt, iv, ct }  der master-Schluessel ist mit dem Passwort umhuellt
 *   ecdh     - { eph }           fluechtiger oeffentlicher Schluessel des Uploads
 */
const KEY_MODES = new Set(['link', 'password', 'ecdh']);
const KEY_INFO_FIELDS = {
  password: ['salt', 'iv', 'ct', 'iterations'],
  ecdh: ['eph'],
};

function parseKeyInfo(mode, value) {
  const info = value === undefined || value === null ? null : value;
  if (mode === 'link') {
    if (info) throw new HttpError(400, 'Bei keyMode=link darf kein Schluessel-Container mitgeschickt werden');
    return null;
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    throw new HttpError(400, 'Schluessel-Container fehlt');
  }
  const allowed = KEY_INFO_FIELDS[mode] || [];
  const clean = {};
  for (const field of allowed) {
    const v = info[field];
    if (v === undefined) continue;
    if (field === 'iterations') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1000 || n > 5_000_000) {
        throw new HttpError(400, 'Ungueltige Iterationszahl');
      }
      clean[field] = n;
      continue;
    }
    if (typeof v !== 'string' || !v.length || v.length > 512) {
      throw new HttpError(400, `Schluessel-Container: Feld ${field} ungueltig`);
    }
    clean[field] = v;
  }
  const serialized = JSON.stringify(clean);
  if (serialized.length > 2048) throw new HttpError(400, 'Schluessel-Container zu gross');
  return serialized;
}

/* -------------------------------------------------------------------------
 * Routen
 * ---------------------------------------------------------------------- */

export function registerTransferRoutes(router) {
  router.get('/api/config', getPublicConfig);
  router.post('/api/transfers', createTransfer);
  router.get('/api/transfers/:id', getTransferInfo);
  router.get('/api/transfers/:id/status', getTransferStatus);
  router.put('/api/transfers/:id/chunks/:file/:chunk', uploadChunk);
  router.post('/api/transfers/:id/complete', completeTransfer);
  router.post('/api/transfers/:id/claim', claimDownload);
  router.get('/api/transfers/:id/files/:file/chunks/:chunk', downloadChunk);
  router.delete('/api/transfers/:id', abortTransfer);
}

/** Oeffentliche Konfiguration und Branding fuer die Web-UI. */
function getPublicConfig(ctx) {
  sendJson(ctx.res, 200, {
    instanceName: config.instanceName,
    branding: getBranding(),
    limits: {
      maxTransferBytes: config.maxTransferBytes,
      clientChunkSize: config.clientChunkSize,
      defaultExpiryHours: config.defaultExpiryHours,
      maxExpiryHours: config.maxExpiryHours,
      defaultMaxDownloads: config.defaultMaxDownloads,
      maxFiles: MAX_FILES,
    },
    features: {
      requests: true,
      notify: Boolean(config.notify.type),
      notifications: config.notify.type || null,
    },
  });
}

async function createTransfer(ctx) {
  const rl = rateLimit(`create:${ctx.ipHash}`, 30, 60 * 60 * 1000);
  if (!rl.ok) throw new HttpError(429, 'Zu viele Transfers. Bitte spaeter erneut versuchen.');

  const body = await readJson(ctx.req, 128 * 1024);

  const meta = requireString(body.meta, 'meta', 64 * 1024);
  const keyMode = String(body.keyMode || 'link');
  if (!KEY_MODES.has(keyMode)) throw new HttpError(400, 'Unbekannter Schluesselmodus');
  const keyWrap = parseKeyInfo(keyMode, body.keyWrap);
  const passwordProtected = keyMode === 'password';

  const expiresInHours = intInRange(
    body.expiresInHours,
    'expiresInHours',
    1,
    config.maxExpiryHours,
    config.defaultExpiryHours
  );
  const maxDownloads = intInRange(body.maxDownloads, 'maxDownloads', 0, 100000, config.defaultMaxDownloads);
  const notify = body.notify === undefined ? true : Boolean(body.notify);

  const files = Array.isArray(body.files) ? body.files : null;
  if (!files || files.length === 0) throw new HttpError(400, 'Keine Dateien uebergeben');
  if (files.length > MAX_FILES) throw new HttpError(400, `Maximal ${MAX_FILES} Dateien pro Transfer`);

  let totalCipherBytes = 0;
  const normalized = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const chunkSize = intInRange(f?.chunkSize, `files[${i}].chunkSize`, 16 * 1024, config.maxChunkBytes, null);
    if (chunkSize === null) throw new HttpError(400, `files[${i}].chunkSize fehlt`);
    const sizePlain = intInRange(f?.sizePlain, `files[${i}].sizePlain`, 0, Number.MAX_SAFE_INTEGER, null);
    const sizeCipher = intInRange(f?.sizeCipher, `files[${i}].sizeCipher`, 0, Number.MAX_SAFE_INTEGER, null);
    if (sizePlain === null || sizeCipher === null) {
      throw new HttpError(400, `files[${i}] unvollstaendig`);
    }
    // Der Client gibt beide Groessen an. Der Server prueft die Konsistenz, damit
    // spaetere Chunk-Indizes garantiert im gueltigen Bereich liegen.
    const expectedChunks = sizePlain === 0 ? 1 : Math.ceil(sizePlain / chunkSize);
    const chunkCount = intInRange(f?.chunkCount, `files[${i}].chunkCount`, 0, 10_000_000, null);
    if (chunkCount === null || chunkCount !== expectedChunks) {
      throw new HttpError(400, `files[${i}]: Chunk-Anzahl passt nicht zur Groesse`);
    }
    if (sizeCipher !== sizePlain + GCM_TAG_BYTES * chunkCount) {
      throw new HttpError(400, `files[${i}]: Ciphertext-Groesse passt nicht`);
    }
    totalCipherBytes += sizeCipher;
    normalized.push({ idx: i, sizeCipher, sizePlain, chunkCount, chunkSize });
  }

  if (totalCipherBytes > config.maxTransferBytes) {
    throw new HttpError(413, 'Transfer ueberschreitet die maximale Groesse dieser Instanz');
  }

  // Reverse-Share-Kontext pruefen
  let requestId = null;
  if (body.requestId) {
    requestId = String(body.requestId);
    const request = stmt.getRequest.get(requestId);
    if (!request || request.state !== 'open') throw new HttpError(404, 'Upload-Portal nicht gefunden');
    if (request.expires_at < Date.now()) throw new HttpError(410, 'Upload-Portal ist abgelaufen');
    if (request.max_submissions > 0 && request.submissions >= request.max_submissions) {
      throw new HttpError(410, 'Upload-Portal ist voll');
    }
    if (files.length > request.max_files) {
      throw new HttpError(400, `Maximal ${request.max_files} Dateien in diesem Portal`);
    }
    if (request.max_transfer_bytes > 0 && totalCipherBytes > request.max_transfer_bytes) {
      throw new HttpError(413, 'Transfer zu gross fuer dieses Portal');
    }
    if (request.password_hash) {
      const { verifyPassword } = await import('../crypto.js');
      if (!verifyPassword(String(body.requestPassword ?? ''), request.password_hash)) {
        throw new HttpError(401, 'Falsches Passwort fuer dieses Portal');
      }
    }
  }

  // Speicherplatz-Quota der Instanz respektieren
  if (config.storageQuotaBytes > 0) {
    const used = stmt.statTotals.get().bytes ?? 0;
    if (used + totalCipherBytes > config.storageQuotaBytes) {
      throw new HttpError(507, 'Speicher dieser Instanz ist voll');
    }
  }

  const id = publicId(10);
  const now = Date.now();
  // Deterministisch signierter Token: ueberlebt Neustarts, ohne in der DB zu liegen.
  const uploadToken = signToken('upload', id);

  stmt.insertTransfer.run({
    id,
    meta,
    key_mode: keyMode,
    key_wrap: keyWrap,
    password_protected: passwordProtected ? 1 : 0,
    created_at: now,
    expires_at: now + expiresInHours * 3600 * 1000,
    max_downloads: maxDownloads,
    notify: notify ? 1 : 0,
    total_cipher_bytes: totalCipherBytes,
    file_count: normalized.length,
    request_id: requestId,
    uploader_hash: ctx.ipHash,
  });

  for (const f of normalized) {
    stmt.insertFile.run({
      transfer_id: id,
      idx: f.idx,
      size_cipher: f.sizeCipher,
      chunk_count: f.chunkCount,
      chunk_size: f.chunkSize,
    });
  }
  await ensureTransferDirs(id, normalized.length);

  if (requestId) stmt.bumpSubmissions.run(requestId);

  sendJson(ctx.res, 201, {
    id,
    uploadToken,
    chunkSize: config.clientChunkSize,
    url: `${baseUrl(ctx.req)}/t/${id}`,
    files: normalized.map((f) => ({ idx: f.idx, chunkCount: f.chunkCount })),
  });
}

function loadTransfer(id) {
  const transfer = stmt.getTransfer.get(id);
  if (!transfer) throw new HttpError(404, 'Transfer nicht gefunden');
  return transfer;
}

function loadFiles(id) {
  return stmt.getTransferFiles.all(id);
}

async function getTransferStatus(ctx) {
  const transfer = loadTransfer(ctx.params.id);
  const token = ctx.query.get('t') || ctx.req.headers['x-upload-token'];
  if (!verifySignedToken('upload', transfer.id, token)) {
    throw new HttpError(403, 'Ungueltiger Upload-Token');
  }
  const files = loadFiles(transfer.id);
  const result = [];
  for (const f of files) {
    const { present, received } = await receivedChunks(transfer.id, f);
    result.push({ idx: f.idx, chunkCount: f.chunk_count, received, present });
  }
  sendJson(ctx.res, 200, { id: transfer.id, state: transfer.state, files: result });
}

function requireUploadToken(ctx, transfer) {
  const token = ctx.query.get('t') || ctx.req.headers['x-upload-token'] || '';
  if (!verifySignedToken('upload', transfer.id, String(token))) {
    throw new HttpError(403, 'Ungueltiger Upload-Token');
  }
}

async function uploadChunk(ctx) {
  const rl = rateLimit(`chunk:${ctx.ipHash}`, 20000, 60 * 60 * 1000);
  if (!rl.ok) throw new HttpError(429, 'Zu viele Upload-Anfragen');

  const transfer = loadTransfer(ctx.params.id);
  requireUploadToken(ctx, transfer);

  if (transfer.state !== 'uploading') throw new HttpError(409, 'Transfer ist bereits abgeschlossen');
  if (transfer.expires_at < Date.now()) throw new HttpError(410, 'Transfer ist abgelaufen');

  const fileIdx = Number(ctx.params.file);
  const chunkIdx = Number(ctx.params.chunk);
  if (!Number.isInteger(fileIdx) || !Number.isInteger(chunkIdx)) throw new HttpError(400, 'Ungueltiger Index');

  const file = loadFiles(transfer.id).find((f) => f.idx === fileIdx);
  if (!file) throw new HttpError(404, 'Datei nicht gefunden');
  if (chunkIdx < 0 || chunkIdx >= file.chunk_count) throw new HttpError(400, 'Chunk-Index ausserhalb des Bereichs');

  const declared = Number(ctx.req.headers['content-length'] ?? '');
  if (Number.isFinite(declared) && declared > config.maxChunkBytes) {
    throw new HttpError(413, 'Chunk zu gross');
  }

  const { bytes, overflow } = await writeChunkStream(
    ctx.req,
    chunkPath(transfer.id, fileIdx, chunkIdx),
    config.maxChunkBytes
  );
  if (overflow) throw new HttpError(413, 'Chunk zu gross');

  sendJson(ctx.res, 200, { ok: true, file: fileIdx, chunk: chunkIdx, bytes });
}

async function completeTransfer(ctx) {
  const transfer = loadTransfer(ctx.params.id);
  requireUploadToken(ctx, transfer);
  if (transfer.state === 'ready') {
    sendJson(ctx.res, 200, { state: 'ready', url: `${baseUrl(ctx.req)}/t/${transfer.id}` });
    return;
  }
  if (transfer.state !== 'uploading') throw new HttpError(409, 'Transfer kann nicht abgeschlossen werden');

  const files = loadFiles(transfer.id);
  let missing = 0;
  for (const f of files) {
    const { received } = await receivedChunks(transfer.id, f);
    missing += f.chunk_count - received;
  }
  if (missing > 0) throw new HttpError(409, 'Es fehlen noch Chunks', { missing });

  stmt.setState.run('ready', transfer.id);
  sendJson(ctx.res, 200, { state: 'ready', url: `${baseUrl(ctx.req)}/t/${transfer.id}` });
}

async function abortTransfer(ctx) {
  const transfer = loadTransfer(ctx.params.id);
  requireUploadToken(ctx, transfer);
  stmt.deleteTransfer.run(transfer.id);
  await deleteTransferFiles(transfer.id);
  sendNoContent(ctx.res);
}

/* -------------------------------------------------------------------------
 * Empfaengerseite
 * ---------------------------------------------------------------------- */

async function getTransferInfo(ctx) {
  const rl = rateLimit(`info:${ctx.ipHash}:${ctx.params.id}`, 60, 5 * 60 * 1000);
  if (!rl.ok) {
    throw new HttpError(429, 'Zu viele Versuche. Bitte kurz warten.');
  }
  const transfer = loadTransfer(ctx.params.id);

  if (transfer.state === 'uploading') {
    sendJson(ctx.res, 200, { state: 'uploading' });
    return;
  }
  if (transfer.state !== 'ready') throw new HttpError(404, 'Transfer nicht verfuegbar');

  const expired = transfer.expires_at < Date.now();
  const exhausted = transfer.max_downloads > 0 && transfer.downloads >= transfer.max_downloads;
  if (expired || exhausted) {
    sendJson(ctx.res, 200, {
      state: expired ? 'expired' : 'exhausted',
      expiresAt: transfer.expires_at,
      downloads: transfer.downloads,
      maxDownloads: transfer.max_downloads,
    });
    return;
  }

  const files = loadFiles(transfer.id);
  const visitor = loadVisitor(ctx, transfer);
  sendJson(ctx.res, 200, {
    state: 'ready',
    id: transfer.id,
    meta: transfer.meta,
    keyMode: transfer.key_mode || 'link',
    // Nur bei Reverse-Share-Uploads gesetzt. Der Empfaenger braucht die Portal-ID,
    // um den privaten Schluessel im eigenen Browser zu finden.
    requestId: transfer.request_id || null,
    keyWrap: transfer.key_wrap ? JSON.parse(transfer.key_wrap) : null,
    passwordProtected: Boolean(transfer.password_protected),
    createdAt: transfer.created_at,
    expiresAt: transfer.expires_at,
    downloads: transfer.downloads,
    maxDownloads: transfer.max_downloads,
    files: files.map((f) => ({
      idx: f.idx,
      sizeCipher: f.size_cipher,
      chunkCount: f.chunk_count,
      chunkSize: f.chunk_size,
    })),
    alreadyDownloaded: visitor.seen,
  });
}

async function downloadChunk(ctx) {
  const rl = rateLimit(`dl:${ctx.ipHash}`, 30000, 60 * 60 * 1000);
  if (!rl.ok) throw new HttpError(429, 'Zu viele Download-Anfragen');

  const transfer = loadTransfer(ctx.params.id);
  if (transfer.state !== 'ready') throw new HttpError(404, 'Transfer nicht verfuegbar');
  if (transfer.expires_at < Date.now()) throw new HttpError(410, 'Transfer ist abgelaufen');
  if (transfer.max_downloads > 0 && transfer.downloads >= transfer.max_downloads) {
    throw new HttpError(410, 'Download-Limit erreicht');
  }

  const fileIdx = Number(ctx.params.file);
  const chunkIdx = Number(ctx.params.chunk);
  const file = loadFiles(transfer.id).find((f) => f.idx === fileIdx);
  if (!file || !Number.isInteger(chunkIdx) || chunkIdx < 0 || chunkIdx >= file.chunk_count) {
    throw new HttpError(404, 'Chunk nicht gefunden');
  }

  const target = chunkPath(transfer.id, fileIdx, chunkIdx);
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    throw new HttpError(404, 'Chunk nicht gefunden');
  }

  ctx.res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'private, max-age=0, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  const { createReadStream } = await import('node:fs');
  createReadStream(target).pipe(ctx.res);
}

/**
 * Ein "Download" wird pro Empfaenger einmal gezaehlt (Deduplizierung ueber eine
 * clientseitig erzeugte, nur gehashte Besucher-ID). So zaehlt ein Empfaenger,
 * der drei Dateien laedt, als ein Download - so wie man es erwartet.
 */
function loadVisitor(ctx, transfer) {
  const visitorHash = ctx.visitorHash;
  const seen = visitorHash
    ? Boolean(stmt.seenVisitor.get(transfer.id, visitorHash))
    : false;
  return { seen, hash: visitorHash };
}

async function claimDownload(ctx) {
  const transfer = loadTransfer(ctx.params.id);
  if (transfer.state !== 'ready') throw new HttpError(404, 'Transfer nicht verfuegbar');
  if (transfer.expires_at < Date.now()) throw new HttpError(410, 'Transfer ist abgelaufen');

  const alreadyCounted = ctx.visitorHash
    ? Boolean(stmt.seenVisitor.get(transfer.id, ctx.visitorHash))
    : false;

  if (!alreadyCounted && transfer.max_downloads > 0 && transfer.downloads >= transfer.max_downloads) {
    throw new HttpError(410, 'Download-Limit erreicht');
  }

  let counted = false;
  if (!alreadyCounted) {
    stmt.insertDownload.run({
      transfer_id: transfer.id,
      ts: Date.now(),
      ip_hash: ctx.ipHash,
      visitor_hash: ctx.visitorHash,
      user_agent: String(ctx.req.headers['user-agent'] || '').slice(0, 200),
      kind: 'download',
      file_idx: null,
    });
    stmt.bumpDownloads.run(transfer.id);
    counted = true;
  }

  const fresh = stmt.getTransfer.get(transfer.id);

  // Ist das Limit erreicht, laeuft der Transfer kurz danach automatisch aus.
  // Die Schonfrist gibt dem letzten Empfaenger Zeit, alle Dateien zu laden.
  if (
    counted &&
    fresh.max_downloads > 0 &&
    fresh.downloads >= fresh.max_downloads &&
    fresh.expires_at > Date.now() + EXHAUST_GRACE_MS
  ) {
    stmt.extendTransfer.run(Date.now() + EXHAUST_GRACE_MS, fresh.id);
    fresh.expires_at = Date.now() + EXHAUST_GRACE_MS;
  }

  if (counted && transfer.notify) {
    notifyDownload({
      transferId: transfer.id,
      downloads: fresh.downloads,
      maxDownloads: fresh.max_downloads,
      fileCount: fresh.file_count,
      bytes: fresh.total_cipher_bytes,
      ip: ctx.ip,
      userAgent: ctx.req.headers['user-agent'],
      baseUrl: baseUrl(ctx.req),
    }).catch((err) => console.warn('[sharedrive] Benachrichtigung fehlgeschlagen:', err.message));
  }

  sendJson(ctx.res, 200, {
    counted,
    downloads: fresh.downloads,
    maxDownloads: fresh.max_downloads,
    remaining: fresh.max_downloads > 0 ? Math.max(fresh.max_downloads - fresh.downloads, 0) : null,
    allowed: fresh.max_downloads === 0 || fresh.downloads <= fresh.max_downloads,
  });
}
