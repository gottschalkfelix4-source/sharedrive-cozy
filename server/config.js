import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* -------------------------------------------------------------------------
 * Minimaler .env-Loader (kein npm-Paket noetig).
 * ---------------------------------------------------------------------- */
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function int(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

loadEnvFile();

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || './data');
const chunkDir = path.join(dataDir, 'chunks');

for (const dir of [dataDir, chunkDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Das Session-Secret wird beim ersten Start erzeugt und in dataDir abgelegt,
 * damit Login-Sessions einen Neustart ueberleben. Es liegt bewusst nicht im
 * Repository und nicht in der .env.
 */
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const secretFile = path.join(dataDir, 'session.secret');
  try {
    if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim();
  } catch {
    /* faellt auf Neuerzeugung zurueck */
  }
  const secret = crypto.randomBytes(48).toString('base64url');
  fs.writeFileSync(secretFile, secret, { mode: 0o600 });
  return secret;
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: int(process.env.PORT, 3000),
  trustProxy: bool(process.env.TRUST_PROXY, false),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),

  dataDir,
  chunkDir,
  dbFile: path.join(dataDir, 'sharedrive.sqlite'),
  sessionSecret: sessionSecret(),

  // Optionales HTTPS. Wichtig: Browser stellen WebCrypto (crypto.subtle) nur in
  // sicheren Kontexten bereit - also unter https:// oder auf localhost. Fuer den
  // Zugriff ueber eine LAN-IP ist HTTPS daher Pflicht.
  tls: {
    cert: (process.env.TLS_CERT || '').trim(),
    key: (process.env.TLS_KEY || '').trim(),
    ca: (process.env.TLS_CA || '').trim(),
  },

  adminPassword: process.env.ADMIN_PASSWORD || '',
  instanceName: process.env.INSTANCE_NAME || 'sharedrive',

  // Chunk-Groesse der Clients (4 MiB) und harte Obergrenze pro Chunk-Request.
  clientChunkSize: 4 * MiB,
  maxChunkBytes: 8 * MiB,
  // Ab dieser Groesse wird beim HTTP-Log nicht mehr gepuffert, sondern gestreamt.
  maxJsonBodyBytes: 256 * 1024,

  maxTransferBytes: int(process.env.MAX_TRANSFER_BYTES, 20 * GiB),
  storageQuotaBytes: int(process.env.STORAGE_QUOTA_BYTES, 0),
  defaultExpiryHours: int(process.env.DEFAULT_EXPIRY_HOURS, 168),
  maxExpiryHours: int(process.env.MAX_EXPIRY_HOURS, 720),
  defaultMaxDownloads: int(process.env.DEFAULT_MAX_DOWNLOADS, 0),
  downloadLogRetentionDays: int(process.env.DOWNLOAD_LOG_RETENTION_DAYS, 30),

  notify: {
    type: (process.env.NOTIFY_TYPE || '').trim().toLowerCase(),
    url: (process.env.NOTIFY_URL || '').trim(),
    emailTo: (process.env.NOTIFY_EMAIL_TO || '').trim(),
  },

  smtp: {
    host: (process.env.SMTP_HOST || '').trim(),
    port: int(process.env.SMTP_PORT, 587),
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || '',
    mode: (process.env.SMTP_SECURE || 'starttls').trim().toLowerCase(),
  },

  brand: {
    name: process.env.BRAND_NAME || 'sharedrive',
    tagline: process.env.BRAND_TAGLINE || 'Dateien teilen, die nur ihr sehen koennt.',
    theme: process.env.BRAND_THEME || 'sunset',
    logoUrl: process.env.BRAND_LOGO_URL || '',
  },
};

if (!config.adminPassword) {
  console.warn(
    '[sharedrive] WARNUNG: ADMIN_PASSWORD ist nicht gesetzt. Das Dashboard bleibt gesperrt.\n' +
      '            Setze ADMIN_PASSWORD in der .env und starte neu.'
  );
}

export default config;
