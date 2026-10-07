import { stmt } from '../db.js';
import { rateLimit, verifyPassword } from '../crypto.js';
import { HttpError, readJson, sendJson } from '../http.js';

/**
 * Oeffentliche Reverse-Share-Endpunkte.
 *
 * Der eigentliche Upload laeuft ueber POST /api/transfers mit requestId +
 * requestPassword - so gibt es nur einen Upload-Codepfad.
 */
export function registerRequestRoutes(router) {
  router.get('/api/requests/:id', getRequestInfo);
  router.post('/api/requests/:id/verify', verifyRequestPassword);
}

/** Prueft das Portal-Passwort frueh, damit Uploader nicht erst am Ende scheitern. */
async function verifyRequestPassword(ctx) {
  const rl = rateLimit(`reqpw:${ctx.ipHash}:${ctx.params.id}`, 12, 15 * 60 * 1000);
  if (!rl.ok) {
    throw new HttpError(429, `Zu viele Versuche. Bitte ${rl.retryAfter} Sekunden warten.`);
  }
  const request = stmt.getRequest.get(ctx.params.id);
  if (!request) throw new HttpError(404, 'Upload-Portal nicht gefunden');
  if (!request.password_hash) {
    sendJson(ctx.res, 200, { ok: true, passwordRequired: false });
    return;
  }
  const body = await readJson(ctx.req, 4096);
  const ok = verifyPassword(String(body.password ?? ''), request.password_hash);
  if (!ok) throw new HttpError(401, 'Falsches Passwort');
  sendJson(ctx.res, 200, { ok: true, passwordRequired: true });
}

function getRequestInfo(ctx) {
  const rl = rateLimit(`req:${ctx.ipHash}:${ctx.params.id}`, 120, 5 * 60 * 1000);
  if (!rl.ok) throw new HttpError(429, 'Zu viele Versuche. Bitte kurz warten.');

  const request = stmt.getRequest.get(ctx.params.id);
  if (!request) throw new HttpError(404, 'Upload-Portal nicht gefunden');

  const expired = request.expires_at < Date.now();
  const full = request.max_submissions > 0 && request.submissions >= request.max_submissions;
  const state = expired ? 'expired' : full ? 'full' : request.state;

  sendJson(ctx.res, 200, {
    id: request.id,
    state,
    title: request.title,
    message: request.message,
    hint: request.hint,
    passwordProtected: Boolean(request.password_protected),
    maxFiles: request.max_files,
    maxTransferBytes: request.max_transfer_bytes,
    submissions: request.submissions,
    maxSubmissions: request.max_submissions,
    expiresAt: request.expires_at,
    open: state === 'open',
  });
}
