import fsp from 'node:fs/promises';
import path from 'node:path';
import config from './config.js';
import { db, stmt } from './db.js';
import { deleteTransferFiles, diskUsage } from './storage.js';

const STALE_UPLOAD_MS = 48 * 60 * 60 * 1000;

/**
 * Loescht abgelaufene Transfers samt Dateien und Log, raeumt verwaiste
 * Upload-Verzeichnisse weg und kuerzt das Download-Log auf die konfigurierte
 * Aufbewahrungsdauer (DSGVO).
 */
export async function runCleanup({ verbose = false } = {}) {
  const now = Date.now();
  const result = { transfers: 0, staleUploads: 0, requests: 0, logEntries: 0, orphans: 0 };

  const expired = stmt.expiredTransfers.all(now);
  for (const row of expired) {
    stmt.deleteTransfer.run(row.id);
    db.prepare('DELETE FROM downloads WHERE transfer_id = ?').run(row.id);
    await deleteTransferFiles(row.id);
    result.transfers++;
  }

  const stale = stmt.staleUploads.all(now - STALE_UPLOAD_MS);
  for (const row of stale) {
    stmt.deleteTransfer.run(row.id);
    db.prepare('DELETE FROM downloads WHERE transfer_id = ?').run(row.id);
    await deleteTransferFiles(row.id);
    result.staleUploads++;
  }

  // Abgelaufene Upload-Portale schliessen (die eingegangenen Transfers bleiben,
  // sie haben ihre eigene Ablaufzeit).
  const oldRequests = stmt.expiredRequests.all(now);
  for (const row of oldRequests) {
    db.prepare("UPDATE requests SET state = 'closed' WHERE id = ? AND state = 'open'").run(row.id);
    result.requests++;
  }

  const logCutoff = now - config.downloadLogRetentionDays * 24 * 60 * 60 * 1000;
  stmt.purgeDownloads.run(logCutoff);

  // Verwaiste Chunk-Verzeichnisse (ohne DB-Eintrag) entfernen
  try {
    const entries = await fsp.readdir(config.chunkDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!stmt.getTransfer.get(entry.name)) {
        await fsp.rm(path.join(config.chunkDir, entry.name), { recursive: true, force: true });
        result.orphans++;
      }
    }
  } catch {
    /* Verzeichnis existiert nicht - kein Problem */
  }

  if (verbose) {
    const usage = await diskUsage();
    console.log(
      `[sharedrive] Aufraeumen: ${result.transfers} abgelaufen, ${result.staleUploads} abgebrochen, ` +
        `${result.orphans} verwaist, Speicher ${(usage.total / 1024 / 1024).toFixed(1)} MiB`
    );
  }
  return result;
}

let timer = null;

/** Startet das Aufraeumen beim Boot und danach stuendlich. */
export function startCleanupLoop() {
  runCleanup({ verbose: true }).catch((err) => console.error('[sharedrive] Aufraeumen fehlgeschlagen:', err));
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    runCleanup().catch((err) => console.error('[sharedrive] Aufraeumen fehlgeschlagen:', err));
  }, 60 * 60 * 1000);
  timer.unref?.();
  return timer;
}
