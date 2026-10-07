import config from './config.js';
import { getBranding } from './db.js';
import { sendMail } from './smtp.js';

export function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[i]}`;
}

/**
 * Verschickt eine Benachrichtigung abhaengig von NOTIFY_TYPE.
 *  - ntfy    : NOTIFY_URL = https://ntfy.sh/<topic>  (Klartext-Body + Header)
 *  - discord : NOTIFY_URL = Discord-Webhook-URL
 *  - json    : NOTIFY_URL = beliebiger Webhook, bekommt JSON
 *  - smtp    : benoetigt SMTP_* und NOTIFY_EMAIL_TO
 */
async function deliver(subject, body, context = {}) {
  const { type, url, emailTo } = config.notify;
  if (!type) return { skipped: true, reason: 'kein NOTIFY_TYPE gesetzt' };

  if (type === 'smtp') {
    if (!config.smtp.host || !emailTo) {
      return { skipped: true, reason: 'SMTP_HOST oder NOTIFY_EMAIL_TO fehlt' };
    }
    await sendMail({ to: emailTo, subject, text: body });
    return { sent: true, via: 'smtp' };
  }

  if (!url) return { skipped: true, reason: 'NOTIFY_URL fehlt' };

  let payload;
  let headers;
  if (type === 'ntfy') {
    headers = {
      'Content-Type': 'text/plain; charset=utf-8',
      Title: subject,
      Tags: 'inbox_tray',
    };
    if (context.clickUrl) headers.Click = context.clickUrl;
    payload = body;
  } else if (type === 'discord') {
    headers = { 'Content-Type': 'application/json' };
    payload = JSON.stringify({ content: `**${subject}**\n${body}`.slice(0, 1900) });
  } else {
    headers = { 'Content-Type': 'application/json' };
    payload = JSON.stringify({
      subject,
      body,
      ...context,
      timestamp: new Date().toISOString(),
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(url, { method: 'POST', headers, body: payload, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} von ${new URL(url).host}`);
    return { sent: true, via: type };
  } finally {
    clearTimeout(timer);
  }
}

/** Wird beim ersten Download eines Empfaengers aufgerufen. */
export async function notifyDownload(info) {
  const subject = `Download: ${info.transferId}`;
  const lines = [
    'Dein Transfer wurde heruntergeladen.',
    '',
    `Transfer:  ${info.transferId}`,
    `Downloads: ${info.downloads}${info.maxDownloads > 0 ? ` von ${info.maxDownloads}` : ''}`,
    `Dateien:   ${info.fileCount} (${formatBytes(info.bytes)})`,
    info.ip ? `Von IP:    ${info.ip}` : null,
    info.userAgent ? `Client:    ${String(info.userAgent).slice(0, 120)}` : null,
    '',
    `Link: ${info.baseUrl}/t/${info.transferId}`,
  ].filter(Boolean);
  return deliver(subject, lines.join('\n'), {
    kind: 'download',
    transferId: info.transferId,
    clickUrl: `${info.baseUrl}/t/${info.transferId}`,
  });
}

/** Wird aufgerufen, wenn jemand ueber ein Upload-Portal Dateien schickt. */
export async function notifySubmission(info) {
  const name = getBranding().name;
  const subject = `Neue Dateien in "${info.requestTitle}"`;
  const lines = [
    `Ueber dein Upload-Portal sind neue Dateien eingegangen (${name}).`,
    '',
    `Portal:    ${info.requestTitle}`,
    `Dateien:   ${info.fileCount} (${formatBytes(info.bytes)})`,
    info.message ? `Nachricht: ${info.message}` : null,
    '',
    `Ansehen: ${info.baseUrl}/admin/`,
  ].filter(Boolean);
  return deliver(subject, lines.join('\n'), {
    kind: 'submission',
    requestId: info.requestId,
    clickUrl: `${info.baseUrl}/admin/`,
  });
}

export async function notifyTest() {
  return deliver(
    'Testbenachrichtigung',
    'Wenn du das liest, funktionieren die Benachrichtigungen von sharedrive.'
  );
}
