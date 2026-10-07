import config from './config.js';

/**
 * node:sqlite ist erst ab Node 22.13 ohne Schalter verfuegbar. Aeltere Versionen
 * liefern sonst nur "Cannot find module 'node:sqlite'" - hier gibt es stattdessen
 * eine verstaendliche Anleitung.
 */
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch {
  const major = Number.parseInt(process.versions.node.split('.')[0], 10);
  const minor = Number.parseInt(process.versions.node.split('.')[1], 10);
  const tooOld = major < 22 || (major === 22 && minor < 13);
  console.error(
    `\n[sharedrive] Die eingebaute SQLite-Unterstuetzung ist nicht verfuegbar.\n` +
      `             Node-Version: ${process.versions.node}\n` +
      (tooOld
        ? `             Bitte auf Node 24 (oder mindestens 22.13) aktualisieren.\n` +
          `             Fuer Node 22.5-22.12 ginge auch: node --experimental-sqlite server/index.js\n`
        : `             Bitte Node neu installieren - 'node:sqlite' sollte enthalten sein.\n`)
  );
  process.exit(1);
}

/**
 * Schema-Uebersicht
 * ------------------
 * transfers  - ein Transfer (eine Sammlung verschluesselter Dateien)
 * files      - Dateien eines Transfers, inkl. Chunk-Anzahl (alle Metadaten sind
 *              ausschliesslich clientseitig verschluesselt; hier stehen nur Zahlen)
 * requests   - Reverse-Share-Portale ("schick mir Dateien")
 * submissions- je ein Upload ueber ein Reverse-Share-Portal (ist selbst ein Transfer)
 * downloads  - Download-Log fuer Tracking/Benachrichtigung (IP nur als HMAC)
 * settings   - Laufzeit-Branding, das im Dashboard geaendert werden kann
 */
const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS transfers (
  id                 TEXT PRIMARY KEY,
  state              TEXT NOT NULL DEFAULT 'uploading',
  meta               TEXT NOT NULL,
  key_mode           TEXT NOT NULL DEFAULT 'link',
  key_wrap           TEXT,
  password_protected INTEGER NOT NULL DEFAULT 0,
  created_at         INTEGER NOT NULL,
  expires_at         INTEGER NOT NULL,
  max_downloads      INTEGER NOT NULL DEFAULT 0,
  downloads          INTEGER NOT NULL DEFAULT 0,
  total_cipher_bytes INTEGER NOT NULL DEFAULT 0,
  file_count         INTEGER NOT NULL DEFAULT 0,
  notify             INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  request_id         TEXT REFERENCES requests(id) ON DELETE SET NULL,
  uploader_hash      TEXT
);
CREATE INDEX IF NOT EXISTS idx_transfers_expires ON transfers(expires_at);
CREATE INDEX IF NOT EXISTS idx_transfers_request ON transfers(request_id);

CREATE TABLE IF NOT EXISTS files (
  transfer_id TEXT NOT NULL REFERENCES transfers(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  size_cipher INTEGER NOT NULL,
  chunk_count INTEGER NOT NULL,
  chunk_size  INTEGER NOT NULL,
  PRIMARY KEY (transfer_id, idx)
);

CREATE TABLE IF NOT EXISTS requests (
  id               TEXT PRIMARY KEY,
  state            TEXT NOT NULL DEFAULT 'open',
  title            TEXT NOT NULL,
  message          TEXT,
  hint             TEXT,
  created_at       INTEGER NOT NULL,
  expires_at       INTEGER NOT NULL,
  max_files        INTEGER NOT NULL DEFAULT 20,
  max_transfer_bytes INTEGER NOT NULL DEFAULT 0,
  max_submissions  INTEGER NOT NULL DEFAULT 0,
  submissions      INTEGER NOT NULL DEFAULT 0,
  password_hash    TEXT,
  password_protected INTEGER NOT NULL DEFAULT 0,
  notify           INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_requests_expires ON requests(expires_at);

CREATE TABLE IF NOT EXISTS downloads (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  ip_hash     TEXT,
  visitor_hash TEXT,
  user_agent  TEXT,
  kind        TEXT NOT NULL DEFAULT 'download',
  file_idx    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_downloads_transfer ON downloads(transfer_id, ts);
CREATE INDEX IF NOT EXISTS idx_downloads_ts ON downloads(ts);
CREATE INDEX IF NOT EXISTS idx_downloads_visitor ON downloads(transfer_id, visitor_hash);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const db = new DatabaseSync(config.dbFile);
db.exec(SCHEMA);

/* -------------------------------------------------------------------------
 * Migrationen
 * -------------------------------------------------------------------------
 * SQLite kann Spalten nicht umbenennen/ergaenzen, wenn die Tabelle schon
 * existiert. Damit ein Update einer laufenden Instanz nicht scheitert, werden
 * fehlende Spalten hier nachgezogen. Das ist idempotent und laeuft bei jedem
 * Start. Neue Felder einfach unten ergaenzen.
 */

function ensureColumn(table, column, definition) {
  let columns;
  try {
    columns = db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return; // Tabelle existiert (noch) nicht
  }
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`[sharedrive] Datenbank aktualisiert: ${table}.${column}`);
}

function migrate() {
  // v1.1: Schluesselmodus fuer Link-, Passwort- und Portal-Verschluesselung
  ensureColumn('transfers', 'key_mode', "TEXT NOT NULL DEFAULT 'link'");
  // v1.1: Deduplizierung der Download-Zaehlung pro Empfaenger
  ensureColumn('downloads', 'visitor_hash', 'TEXT');
  // v1.0: interne Notiz und Reverse-Share-Verknuepfung
  ensureColumn('transfers', 'note', 'TEXT');
  ensureColumn('transfers', 'request_id', 'TEXT');
  ensureColumn('transfers', 'uploader_hash', 'TEXT');

  // Bestehende Transfers ohne Schluesselmodus sind Passwort-Transfers,
  // wenn ein Wrap vorhanden ist - sonst reine Link-Transfers.
  try {
    db.exec(
      "UPDATE transfers SET key_mode = 'password' WHERE key_wrap IS NOT NULL AND key_mode = 'link'"
    );
  } catch {
    /* Spalte fehlt in sehr alten Staenden - dann gibt es auch keine Wraps */
  }
}

migrate();

/* -------------------------------------------------------------------------
 * Vorbereitete Statements
 * ---------------------------------------------------------------------- */

export const stmt = {
  insertTransfer: db.prepare(`
    INSERT INTO transfers
      (id, state, meta, key_mode, key_wrap, password_protected, created_at, expires_at,
       max_downloads, notify, total_cipher_bytes, file_count, request_id, uploader_hash)
    VALUES
      (:id, 'uploading', :meta, :key_mode, :key_wrap, :password_protected, :created_at, :expires_at,
       :max_downloads, :notify, :total_cipher_bytes, :file_count, :request_id, :uploader_hash)
  `),
  insertFile: db.prepare(`
    INSERT INTO files (transfer_id, idx, size_cipher, chunk_count, chunk_size)
    VALUES (:transfer_id, :idx, :size_cipher, :chunk_count, :chunk_size)
  `),
  getTransfer: db.prepare('SELECT * FROM transfers WHERE id = ?'),
  getTransferFiles: db.prepare('SELECT * FROM files WHERE transfer_id = ? ORDER BY idx'),
  setState: db.prepare('UPDATE transfers SET state = ? WHERE id = ?'),
  setMeta: db.prepare('UPDATE transfers SET meta = ? WHERE id = ?'),
  bumpDownloads: db.prepare('UPDATE transfers SET downloads = downloads + 1 WHERE id = ?'),
  deleteTransfer: db.prepare('DELETE FROM transfers WHERE id = ?'),
  extendTransfer: db.prepare('UPDATE transfers SET expires_at = ? WHERE id = ?'),
  listTransfers: db.prepare(`
    SELECT * FROM transfers
    WHERE state != 'deleted'
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `),
  listTransfersFiltered: db.prepare(`
    SELECT * FROM transfers
    WHERE state != 'deleted'
      AND (id LIKE :q OR note LIKE :q)
    ORDER BY created_at DESC
    LIMIT :limit OFFSET :offset
  `),
  countTransfers: db.prepare("SELECT COUNT(*) AS n FROM transfers WHERE state != 'deleted'"),
  countTransfersFiltered: db.prepare(`
    SELECT COUNT(*) AS n FROM transfers
    WHERE state != 'deleted' AND (id LIKE :q OR note LIKE :q)
  `),
  statTotals: db.prepare(`
    SELECT
      COUNT(*) AS transfers,
      COALESCE(SUM(total_cipher_bytes), 0) AS bytes,
      COALESCE(SUM(file_count), 0) AS files,
      COALESCE(SUM(downloads), 0) AS downloads,
      COALESCE(SUM(CASE WHEN state = 'ready' THEN 1 ELSE 0 END), 0) AS ready,
      COALESCE(SUM(CASE WHEN state = 'uploading' THEN 1 ELSE 0 END), 0) AS uploading
    FROM transfers WHERE state != 'deleted'
  `),
  expiredTransfers: db.prepare(
    "SELECT id FROM transfers WHERE expires_at < ? AND state != 'deleted'"
  ),
  overLimitTransfers: db.prepare(
    "SELECT id FROM transfers WHERE max_downloads > 0 AND downloads >= max_downloads AND state = 'ready'"
  ),
  staleUploads: db.prepare(
    "SELECT id FROM transfers WHERE state = 'uploading' AND created_at < ?"
  ),

  insertRequest: db.prepare(`
    INSERT INTO requests
      (id, state, title, message, hint, created_at, expires_at, max_files,
       max_transfer_bytes, max_submissions, password_hash, password_protected, notify)
    VALUES
      (:id, 'open', :title, :message, :hint, :created_at, :expires_at, :max_files,
       :max_transfer_bytes, :max_submissions, :password_hash, :password_protected, :notify)
  `),
  getRequest: db.prepare('SELECT * FROM requests WHERE id = ?'),
  bumpSubmissions: db.prepare(
    'UPDATE requests SET submissions = submissions + 1 WHERE id = ?'
  ),
  deleteRequest: db.prepare('DELETE FROM requests WHERE id = ?'),
  listRequests: db.prepare('SELECT * FROM requests ORDER BY created_at DESC LIMIT ? OFFSET ?'),
  countRequests: db.prepare('SELECT COUNT(*) AS n FROM requests'),
  expiredRequests: db.prepare('SELECT id FROM requests WHERE expires_at < ?'),

  insertDownload: db.prepare(`
    INSERT INTO downloads (transfer_id, ts, ip_hash, visitor_hash, user_agent, kind, file_idx)
    VALUES (:transfer_id, :ts, :ip_hash, :visitor_hash, :user_agent, :kind, :file_idx)
  `),
  seenVisitor: db.prepare(
    "SELECT id FROM downloads WHERE transfer_id = ? AND visitor_hash = ? AND visitor_hash IS NOT NULL AND kind = 'download' LIMIT 1"
  ),
  listVisitorDownloads: db.prepare(
    "SELECT * FROM downloads WHERE transfer_id = ? AND kind = 'download' ORDER BY ts DESC LIMIT ?"
  ),
  listDownloads: db.prepare(
    'SELECT * FROM downloads WHERE transfer_id = ? ORDER BY ts DESC LIMIT ?'
  ),
  countDownloadsByTransfer: db.prepare(
    'SELECT COUNT(*) AS n FROM downloads WHERE transfer_id = ?'
  ),
  purgeDownloads: db.prepare('DELETE FROM downloads WHERE ts < ?'),

  recentDownloads: db.prepare(`
    SELECT d.*, t.note AS transfer_note
    FROM downloads d LEFT JOIN transfers t ON t.id = d.transfer_id
    ORDER BY d.ts DESC LIMIT ?
  `),
  downloadsPerDay: db.prepare(`
    SELECT ts, kind FROM downloads WHERE ts > ? ORDER BY ts ASC
  `),

  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ),
  allSettings: db.prepare('SELECT key, value FROM settings'),
};

/* -------------------------------------------------------------------------
 * Kleine Helfer
 * ---------------------------------------------------------------------- */

export function getSetting(key, fallback = null) {
  const row = stmt.getSetting.get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  stmt.setSetting.run(key, String(value));
}

export function getBranding() {
  const row = stmt.allSettings.all();
  const map = Object.fromEntries(row.map((r) => [r.key, r.value]));
  return {
    name: map.brand_name || config.brand.name,
    tagline: map.brand_tagline || config.brand.tagline,
    theme: map.brand_theme || config.brand.theme,
    logoUrl: map.brand_logo_url || config.brand.logoUrl,
  };
}

export default db;
