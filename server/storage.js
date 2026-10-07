import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import config from './config.js';

/**
 * Ablage der verschluesselten Chunks:
 *
 *   data/chunks/<transferId>/<fileIdx>/<chunkIdx>.bin
 *
 * Es liegen ausschliesslich Ciphertext-Bytes auf der Platte. Ob ein Chunk
 * bereits hochgeladen wurde, wird ueber das Dateisystem geprueft - das spart
 * eine DB-Schreiboperation pro Chunk (bei grossen Dateien sind das Tausende).
 */

export function transferDir(transferId) {
  // transferId stammt immer aus publicId() (nur [a-z0-9]) - zusaetzlich absichern:
  const safe = String(transferId).replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(config.chunkDir, safe);
}

export function fileDir(transferId, fileIdx) {
  return path.join(transferDir(transferId), String(Number(fileIdx)));
}

export function chunkPath(transferId, fileIdx, chunkIdx) {
  return path.join(fileDir(transferId, fileIdx), `${Number(chunkIdx)}.bin`);
}

export async function ensureTransferDirs(transferId, fileCount) {
  await fsp.mkdir(transferDir(transferId), { recursive: true });
  for (let i = 0; i < fileCount; i++) {
    await fsp.mkdir(fileDir(transferId, i), { recursive: true });
  }
}

/**
 * Schreibt einen Chunk aus dem Request-Stream auf die Platte.
 * Bricht ab, sobald mehr als `maxBytes` ankommen (Schutz vor vollem Datentraeger).
 *
 * @returns {Promise<{bytes: number, overflow: boolean}>}
 */
export function writeChunkStream(readable, targetPath, maxBytes) {
  return new Promise((resolve, reject) => {
    // eindeutiger Temp-Name: parallele Uploads desselben Chunks kollidieren nicht
    const tmpPath = `${targetPath}.${crypto.randomUUID()}.part`;
    const out = fs.createWriteStream(tmpPath, { mode: 0o600 });
    let bytes = 0;
    let overflow = false;
    let settled = false;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      out.destroy();
      fsp.rm(tmpPath, { force: true }).catch(() => {});
      reject(err);
    };

    readable.on('data', (buf) => {
      bytes += buf.length;
      if (bytes > maxBytes) {
        overflow = true;
        readable.pause();
        out.end(() => {
          if (settled) return;
          settled = true;
          fsp
            .rm(tmpPath, { force: true })
            .catch(() => {})
            .finally(() => resolve({ bytes, overflow: true }));
        });
      }
    });
    readable.on('error', fail);
    out.on('error', fail);
    out.on('finish', async () => {
      if (settled || overflow) return;
      settled = true;
      try {
        await fsp.rename(tmpPath, targetPath);
        resolve({ bytes, overflow: false });
      } catch (err) {
        reject(err);
      }
    });

    readable.pipe(out);
  });
}

export async function chunkExists(transferId, fileIdx, chunkIdx) {
  try {
    const st = await fsp.stat(chunkPath(transferId, fileIdx, chunkIdx));
    return st.size;
  } catch {
    return 0;
  }
}

/** Liste der bereits vorhandenen Chunk-Indizes einer Datei (fuer Resume). */
export async function receivedChunks(transferId, file) {
  const dir = fileDir(transferId, file.idx);
  const present = new Uint8Array(file.chunk_count);
  let entries;
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return { present: Array.from(present), received: 0 };
  }
  let received = 0;
  for (const name of entries) {
    if (!name.endsWith('.bin')) continue;
    const idx = Number.parseInt(name.slice(0, -4), 10);
    if (Number.isInteger(idx) && idx >= 0 && idx < file.chunk_count) {
      present[idx] = 1;
      received++;
    }
  }
  return { present: Array.from(present), received };
}

export async function deleteTransferFiles(transferId) {
  await fsp.rm(transferDir(transferId), { recursive: true, force: true });
}

/** Belegter Speicher aller Transfers (Ciphertext-Bytes). */
export async function diskUsage() {
  let total = 0;
  let count = 0;
  let entries = [];
  try {
    entries = await fsp.readdir(config.chunkDir);
  } catch {
    return { total: 0, transfers: 0 };
  }
  for (const entry of entries) {
    const stat = await dirSize(path.join(config.chunkDir, entry));
    if (stat > 0) {
      total += stat;
      count++;
    }
  }
  return { total, transfers: count };
}

async function dirSize(dir) {
  let sum = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sum += await dirSize(full);
    else {
      try {
        sum += (await fsp.stat(full)).size;
      } catch {
        /* Datei verschwand - ignorieren */
      }
    }
  }
  return sum;
}
