/**
 * sharedrive - verschluesselter Upload
 * ====================================
 *
 * Die Datei wird chunkweise gelesen, im Browser verschluesselt und erst danach
 * hochgeladen. Zu keinem Zeitpunkt liegt eine komplette Datei im Speicher:
 * der Speicherbedarf liegt bei (Concurrency + 1) * Chunk-Groesse, also rund
 * 20 MiB bei den Standardwerten.
 *
 * Eigenschaften: Parallele Chunks, automatische Wiederholversuche mit
 * Backoff, Pause/Fortsetzen, Fortschritt pro Datei und gesamt.
 */

import { encryptChunk, deriveFileKey, cipherSizeFor } from './sr-crypto.js';
import api, { ApiError } from './sr-api.js';

const DEFAULT_CONCURRENCY = 4;
const MAX_ATTEMPTS = 4;

export class UploadError extends Error {
  constructor(message, cause) {
    super(message);
    this.cause = cause;
  }
}

export class UploadSession {
  /**
   * @param {object} options
   * @param {Array<File>} options.files
   * @param {Uint8Array} options.masterKey
   * @param {object} options.meta        Klartext-Metadaten (Nachricht + Dateiliste)
   * @param {string} options.keyMode      'link' | 'password' | 'ecdh'
   * @param {object|null} options.keyWrap Schluessel-Container (Passwort-Wrap oder ECDH-Metadaten)
   * @param {number} options.chunkSize
   * @param {number} options.expiresInHours
   * @param {number} options.maxDownloads
   * @param {boolean} options.notify
   * @param {string|null} options.requestId
   * @param {string|null} options.requestPassword
   * @param {(state: object) => void} options.onChange
   */
  constructor(options) {
    this.opts = options;
    this.chunkSize = options.chunkSize || 4 * 1024 * 1024;
    this.concurrency = options.concurrency || DEFAULT_CONCURRENCY;
    this.onChange = options.onChange || (() => {});

    this.state = 'idle';
    this.paused = false;
    this.canceled = false;
    this.error = null;

    this.transferId = null;
    this.uploadToken = null;
    this.shareUrl = null;

    this.items = options.files.map((file, idx) => {
      const { chunkCount, sizeCipher } = cipherSizeFor(file.size, this.chunkSize);
      return {
        file,
        idx,
        name: file.name,
        size: file.size,
        sizeCipher,
        chunkCount,
        received: new Set(),
        bytesSent: 0,
        failedAttempts: 0,
      };
    });

    this.totalCipherBytes = this.items.reduce((sum, i) => sum + i.sizeCipher, 0);
    this.sentBytes = 0;
    this.startedAt = 0;
    this.speedSamples = [];
    this._keyCache = new Map();
    this._controller = new AbortController();
    this._active = new Set();
  }

  get progress() {
    const total = this.totalCipherBytes || 1;
    return Math.min(1, this.sentBytes / total);
  }

  get speed() {
    if (this.speedSamples.length < 2) return 0;
    const first = this.speedSamples[0];
    const last = this.speedSamples[this.speedSamples.length - 1];
    const dt = (last.t - first.t) / 1000;
    if (dt <= 0) return 0;
    return (last.bytes - first.bytes) / dt;
  }

  get eta() {
    const speed = this.speed;
    if (speed <= 0) return Infinity;
    return (this.totalCipherBytes - this.sentBytes) / speed;
  }

  snapshot() {
    return {
      state: this.state,
      progress: this.progress,
      sentBytes: this.sentBytes,
      totalBytes: this.totalCipherBytes,
      speed: this.speed,
      eta: this.eta,
      error: this.error,
      shareUrl: this.shareUrl,
      transferId: this.transferId,
      files: this.items.map((i) => ({
        name: i.name,
        size: i.size,
        bytesSent: i.bytesSent,
        sizeCipher: i.sizeCipher,
        progress: i.sizeCipher ? Math.min(1, i.bytesSent / i.sizeCipher) : 1,
        done: i.received.size >= i.chunkCount,
      })),
    };
  }

  _emit() {
    this.onChange(this.snapshot());
  }

  async _fileKey(idx) {
    if (!this._keyCache.has(idx)) {
      this._keyCache.set(idx, await deriveFileKey(this.opts.masterKey, idx));
    }
    return this._keyCache.get(idx);
  }

  async start() {
    if (this.state !== 'idle') return;
    this.startedAt = Date.now();
    this.speedSamples = [{ t: Date.now(), bytes: 0 }];
    try {
      this.state = 'creating';
      this._emit();

      const created = await api.createTransfer({
        meta: this.opts.meta,
        keyMode: this.opts.keyMode || 'link',
        keyWrap: this.opts.keyWrap || null,
        expiresInHours: this.opts.expiresInHours,
        maxDownloads: this.opts.maxDownloads,
        notify: this.opts.notify,
        requestId: this.opts.requestId || undefined,
        requestPassword: this.opts.requestPassword || undefined,
        files: this.items.map((i) => ({
          sizePlain: i.size,
          sizeCipher: i.sizeCipher,
          chunkCount: i.chunkCount,
          chunkSize: this.chunkSize,
        })),
      });

      this.transferId = created.id;
      this.uploadToken = created.uploadToken;

      // Bereits vorhandene Chunks ueberspringen (z. B. nach einem Abbrich)
      try {
        const status = await api.transferStatus(this.transferId, this.uploadToken);
        for (const file of status.files || []) {
          const item = this.items[file.idx];
          if (!item) continue;
          for (let c = 0; c < file.chunkCount; c++) {
            if (file.present?.[c]) {
              item.received.add(c);
              item.bytesSent += this.chunkPlainSize(item, c) + 16;
            }
          }
        }
        this.sentBytes = this.items.reduce((sum, i) => sum + i.bytesSent, 0);
      } catch {
        /* Resume-Info ist optional */
      }

      this.state = 'uploading';
      this._emit();
      await this._pump();
    } catch (err) {
      if (this.canceled) {
        this.state = 'canceled';
      } else {
        this.state = 'error';
        this.error = err instanceof ApiError ? err.message : err.message || 'Unbekannter Fehler';
      }
      this._emit();
      throw err;
    }
  }

  chunkPlainSize(item, chunkIdx) {
    const start = chunkIdx * this.chunkSize;
    return Math.min(this.chunkSize, Math.max(0, item.size - start));
  }

  _pendingJobs() {
    const jobs = [];
    for (const item of this.items) {
      for (let c = 0; c < item.chunkCount; c++) {
        if (!item.received.has(c)) jobs.push({ item, chunkIdx: c });
      }
    }
    return jobs;
  }

  async _pump() {
    const jobs = this._pendingJobs();
    let cursor = 0;
    const errors = [];

    const worker = async () => {
      while (cursor < jobs.length) {
        if (this.canceled) return;
        while (this.paused && !this.canceled) {
          this.state = 'paused';
          this._emit();
          await new Promise((r) => setTimeout(r, 200));
        }
        if (this.canceled) return;
        if (this.state === 'paused') {
          this.state = 'uploading';
          this._emit();
        }
        const job = jobs[cursor++];
        try {
          await this._uploadChunk(job.item, job.chunkIdx);
        } catch (err) {
          errors.push(err);
          if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
            // Fachlicher Fehler (Limit, abgelaufen, ...) - nicht weiter versuchen
            this.canceled = true;
            throw err;
          }
        }
      }
    };

    const workers = Array.from({ length: Math.min(this.concurrency, jobs.length || 1) }, worker);
    await Promise.all(workers);

    if (this.canceled) {
      if (this.error || errors.length) {
        const err = errors[0] || new UploadError(this.error || 'Abgebrochen');
        this.state = 'error';
        this.error = err.message;
        this._emit();
        throw err;
      }
      return;
    }

    // Fehlgeschlagene Chunks erneut versuchen, sofern welche uebrig sind
    const remaining = this._pendingJobs();
    if (remaining.length) {
      if (this._retryRound === undefined) this._retryRound = 0;
      this._retryRound++;
      if (this._retryRound <= 3) {
        await new Promise((r) => setTimeout(r, 700 * this._retryRound));
        return this._pump();
      }
      this.state = 'error';
      this.error = `Es konnten nicht alle Teile hochgeladen werden (${remaining.length} offen).`;
      this._emit();
      throw new UploadError(this.error);
    }

    this.state = 'finalizing';
    this._emit();
    await api.completeTransfer(this.transferId, this.uploadToken);
    this.state = 'done';
    this._emit();
  }

  async _uploadChunk(item, chunkIdx) {
    const start = chunkIdx * this.chunkSize;
    const end = Math.min(item.size, start + this.chunkSize);
    const key = await this._fileKey(item.idx);

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      if (this.canceled) throw new UploadError('Abgebrochen');
      try {
        const slice = item.file.slice(start, end);
        const plain = new Uint8Array(await slice.arrayBuffer());
        const cipher = await encryptChunk(key, chunkIdx, plain);

        await api.uploadChunk(
          this.transferId,
          this.uploadToken,
          item.idx,
          chunkIdx,
          cipher,
          this._controller.signal
        );

        item.received.add(chunkIdx);
        item.bytesSent += cipher.length;
        this.sentBytes += cipher.length;
        this.speedSamples.push({ t: Date.now(), bytes: this.sentBytes });
        if (this.speedSamples.length > 24) this.speedSamples.shift();
        this._emit();
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 429) {
          throw err;
        }
        if (attempt === MAX_ATTEMPTS - 1) throw err;
        await new Promise((r) => setTimeout(r, 600 * 2 ** attempt + Math.random() * 300));
      }
    }
  }

  pause() {
    if (this.state === 'uploading') {
      this.paused = true;
      this._emit();
    }
  }

  resume() {
    if (this.paused) {
      this.paused = false;
      this.state = 'uploading';
      this._emit();
    }
  }

  async cancel() {
    this.canceled = true;
    this.paused = false;
    this._controller.abort();
    if (this.transferId && this.uploadToken) {
      try {
        await api.abortTransfer(this.transferId, this.uploadToken);
      } catch {
        /* serverseitiges Aufraeumen uebernimmt spaetestens der Cleanup-Job */
      }
    }
    this.state = 'canceled';
    this._emit();
  }
}
