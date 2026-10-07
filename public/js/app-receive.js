/**
 * Empfaengerseite: entschluesselt im Browser und speichert die Dateien.
 *
 * Die Chunks werden mit begrenztem Vorlauf geladen und einzeln entschluesselt,
 * damit auch mehrere GB ohne Speicherprobleme funktionieren.
 */

import api, { ApiError } from './sr-api.js';
import {
  decryptChunk,
  decryptMeta,
  deriveFileKey,
  fromB64u,
  importOwnerPrivate,
  openFromSubmitter,
  unwrapMasterKey,
} from './sr-crypto.js';
import { readPortalKey } from './sr-portal.js';
import {
  fileIconSvg,
  formatBytes,
  formatDate,
  formatRemaining,
  iconForFile,
  toast,
  escapeHtml,
} from './sr-format.js';
import { mountShell, requireCrypto, showModal } from './sr-shell.js';
import { mergeFiles } from './sr-manifest.js';

const $ = (id) => document.getElementById(id);
const PREVIEW_MAX_BYTES = 40 * 1024 * 1024;
const LOOKAHEAD = 3;

const state = {
  branding: { name: 'sharedrive' },
  transferId: null,
  info: null,
  meta: null,
  masterKey: null,
  claimed: false,
  busy: false,
};

/* =========================================================================
 * Start
 * ========================================================================= */

async function init() {
  requireCrypto();

  try {
    const config = await api.config();
    state.branding = config.branding || state.branding;
  } catch {
    /* Branding ist optional */
  }
  mountShell({ branding: state.branding, active: 'receive' });

  state.transferId = location.pathname.split('/').filter(Boolean).pop();

  // Schluessel steht im URL-Fragment und wird sofort aus der Adresszeile entfernt,
  // damit er nicht in Screenshots, Verlauf oder geteilten Links auftaucht.
  const fragment = location.hash.slice(1);
  const params = new URLSearchParams(fragment);
  const keyParam = params.get('k');
  if (keyParam) {
    try {
      state.masterKey = fromB64u(keyParam);
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      showBlocked('Ungültiger Link', 'Der Schlüssel im Link ist beschädigt. Bitte den vollständigen Link kopieren.');
      return;
    }
  }

  await loadTransfer();
}

async function loadTransfer() {
  let info;
  try {
    info = await api.transferInfo(state.transferId);
  } catch (err) {
    showBlocked(
      'Transfer nicht gefunden',
      err instanceof ApiError && err.status === 429
        ? 'Zu viele Versuche. Bitte in ein paar Minuten noch einmal probieren.'
        : 'Der Link ist ungültig oder der Transfer wurde gelöscht.'
    );
    return;
  }

  if (info.state === 'uploading') {
    showBlocked('Der Upload läuft noch', 'Der Absender lädt gerade hoch. Bitte gleich noch einmal versuchen.');
    return;
  }
  if (info.state === 'expired') {
    showBlocked('Dieser Transfer ist abgelaufen', `Abgelaufen am ${formatDate(info.expiresAt)}. Dateien werden automatisch gelöscht.`);
    return;
  }
  if (info.state === 'exhausted') {
    showBlocked(
      'Alle Downloads verbraucht',
      `Dieser Transfer war auf ${info.maxDownloads} Downloads begrenzt und wurde bereits ${info.downloads}× geladen.`
    );
    return;
  }
  state.info = info;

  // Reverse-Share-Upload: nur der Eigentuemer hat den privaten Schluessel.
  if (info.keyMode === 'ecdh') {
    const portalKey = info.requestId ? readPortalKey(info.requestId) : null;
    if (!portalKey) {
      showBlocked(
        'Nur für den Eigentümer',
        ' Dieser Upload wurde mit dem öffentlichen Schlüssel eines Upload-Portals verschlüsselt. ' +
          'Öffnen kann ihn nur der Eigentümer in dem Browser, in dem das Portal erstellt wurde.'
      );
      return;
    }
    try {
      const privateKey = await importOwnerPrivate(fromB64u(portalKey.private));
      state.masterKey = await openFromSubmitter(privateKey, info.keyWrap?.eph);
    } catch {
      showBlocked(
        'Schlüssel passt nicht',
        'Der gespeicherte Portal-Schlüssel in diesem Browser kann diesen Upload nicht öffnen.'
      );
      return;
    }
    await unlock();
    return;
  }

  if (!state.masterKey) {
    showBlocked(
      'Schlüssel fehlt',
      'Diesem Link fehlt der Teil nach dem „#“. Ohne ihn lässt sich nichts entschlüsseln. Bitte den vollständigen Link verwenden.'
    );
    return;
  }

  if (info.passwordProtected) {
    showView('password');
    $('pw-input').focus();
    return;
  }

  await unlock();
}

async function unlock() {
  try {
    state.meta = await decryptMeta(state.masterKey, state.info.meta);
  } catch {
    showBlocked(
      'Entschlüsselung fehlgeschlagen',
      'Der Schlüssel im Link passt nicht zu diesem Transfer. Bitte den Link prüfen.'
    );
    return;
  }
  renderReady();
}

async function submitPassword() {
  const password = $('pw-input').value;
  if (!password) {
    $('pw-hint').textContent = 'Bitte ein Passwort eingeben.';
    return;
  }
  const button = $('pw-submit');
  button.disabled = true;
  $('pw-hint').textContent = 'Schlüssel wird abgeleitet …';

  try {
    const master = await unwrapMasterKey(state.info.keyWrap, password);
    state.masterKey = master;
    await unlock();
    if (!$('view-ready').classList.contains('hidden')) return;
    $('pw-hint').textContent = 'Falsches Passwort. Bitte noch einmal versuchen.';
  } catch {
    $('pw-hint').textContent = 'Falsches Passwort. Bitte noch einmal versuchen.';
  } finally {
    button.disabled = false;
  }
}

/* =========================================================================
 * Ansichten
 * ========================================================================= */

function showView(name) {
  for (const view of ['loading', 'password', 'ready', 'blocked']) {
    $(`view-${view}`).classList.toggle('hidden', view !== name);
  }
}

function showBlocked(title, text) {
  $('blocked-title').textContent = title;
  $('blocked-text').textContent = text;
  showView('blocked');
}

/* =========================================================================
 * Dateiliste
 * ========================================================================= */

function renderReady() {
  const info = state.info;
  // Die entschluesselten Metadaten enthalten die Namen, die Serverantwort die
  // technischen Angaben (Chunk-Anzahl). Erst die Zusammenfuehrung ergibt eine
  // vollstaendige Dateiliste - fehlt sie, entstehen leere Downloads.
  let files;
  try {
    files = mergeFiles(state.meta.files || [], info.files || [], info.files?.[0]?.chunkSize);
  } catch (err) {
    showBlocked('Dateien nicht ladbar', err.message);
    return;
  }
  state.files = files;

  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  $('file-summary').textContent =
    `${files.length} ${files.length === 1 ? 'Datei' : 'Dateien'} · ${formatBytes(totalBytes)}`;

  $('expiry-badge').textContent = `Läuft ab: ${formatRemaining(info.expiresAt)}`;

  if (state.meta.message) {
    $('sender-message').classList.remove('hidden');
    $('message-text').textContent = state.meta.message;
  }

  const host = $('filelist');
  host.innerHTML = '';
  files.forEach((file, index) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="file-row__icon">${fileIconSvg(iconForFile(file.name, file.type))}</span>
      <span class="file-row__body">
        <span class="file-row__name">${escapeHtml(file.name)}</span>
        <span class="file-row__meta">
          <span>${formatBytes(file.size)}</span>
          ${file.path && file.path !== file.name ? `<span class="file-row__path">${escapeHtml(file.path)}</span>` : ''}
        </span>
      </span>
      <button type="button" class="btn btn--sm btn--primary" data-download="${index}">Laden</button>`;
    row.querySelector('[data-download]').addEventListener('click', () => downloadOne(index));
    host.appendChild(row);
  });

  // Vorschau nur fuer kleine Bilder, Videos und Audio anbieten
  const previewable = files.filter(
    (file) => file.size <= PREVIEW_MAX_BYTES && /^(image|video|audio)\//.test(file.type || '')
  );
  if (previewable.length) {
    $('preview-area').classList.remove('hidden');
    const grid = $('preview-grid');
    grid.innerHTML = '';
    for (const file of previewable) {
      const tile = document.createElement('button');
      tile.type = 'button';
      tile.className = 'preview-tile';
      const kind = (file.type || '').split('/')[0];
      tile.innerHTML = `
        <span class="muted tiny">${kind === 'image' ? 'Bild' : kind === 'video' ? 'Video' : 'Audio'} · ${formatBytes(file.size)}</span>
        <span class="preview-tile__name">${escapeHtml(file.name)}</span>`;
      tile.addEventListener('click', () => openPreview(file));
      grid.appendChild(tile);
    }
  }

  if (window.showDirectoryPicker) {
    $('btn-folder').classList.remove('hidden');
    $('btn-folder').addEventListener('click', () => downloadAll(true));
  }
  $('btn-download-all').addEventListener('click', () => downloadAll(false));

  updateDownloadStatus();
  showView('ready');
}

function updateDownloadStatus() {
  const info = state.info;
  if (!info) return;
  const parts = [];
  if (info.maxDownloads > 0) {
    parts.push(`${info.downloads} von ${info.maxDownloads} Downloads verbraucht`);
  } else {
    parts.push(`${info.downloads}× heruntergeladen`);
  }
  if (info.alreadyDownloaded) parts.push('du hast bereits geladen');
  $('download-status').textContent = parts.join(' · ');
}

/* =========================================================================
 * Download und Entschluesselung
 * ========================================================================= */

async function claimOnce() {
  if (state.claimed) return true;
  try {
    const result = await api.claimDownload(state.transferId);
    state.claimed = true;
    state.info.downloads = result.downloads;
    state.info.maxDownloads = result.maxDownloads;
    state.info.alreadyDownloaded = true;
    updateDownloadStatus();
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 410) {
      showBlocked('Download-Limit erreicht', err.message);
      return false;
    }
    // Netzwerkfehler beim Zaehlen darf den Download nicht blockieren
    return true;
  }
}

/** Laedt und entschluesselt die Chunks einer Datei in Reihenfolge. */
async function* decryptChunks(file) {
  const total = Number(file.chunkCount);
  if (!Number.isInteger(total) || total <= 0) {
    // Ohne Chunk-Anzahl wuerde stillschweigend eine leere Datei entstehen -
    // lieber laut scheitern.
    throw new Error('Chunk-Information fehlt – die Datei kann nicht vollständig geladen werden.');
  }

  const key = await deriveFileKey(state.masterKey, file.idx);

  const load = async (index) => {
    const res = await api.fetchChunk(state.transferId, file.idx, index);
    if (res.status === 410) throw new ApiError(410, 'Das Download-Limit ist erreicht.');
    if (!res.ok) throw new ApiError(res.status, `Teil ${index + 1} konnte nicht geladen werden.`);
    const cipher = new Uint8Array(await res.arrayBuffer());
    return decryptChunk(key, index, cipher);
  };

  const pending = [];
  for (let i = 0; i < Math.min(LOOKAHEAD, total); i++) pending.push(load(i));

  for (let i = 0; i < total; i++) {
    const plain = await pending.shift();
    const nextIndex = i + LOOKAHEAD;
    if (nextIndex < total) pending.push(load(nextIndex));
    yield plain;
    if (state.abortRequested) throw new Error('abgebrochen');
  }
}

function showDownloadProgress(label, fraction) {
  $('download-progress').classList.remove('hidden');
  $('dl-label').textContent = label;
  $('dl-bar').style.width = `${Math.round(fraction * 100)}%`;
}

function hideDownloadProgress() {
  $('download-progress').classList.add('hidden');
}

async function decryptToBlob(file, onProgress) {
  const parts = [];
  let done = 0;
  for await (const plain of decryptChunks(file)) {
    parts.push(plain);
    done += plain.length;
    onProgress?.(done / Math.max(1, file.size), file);
  }
  return new Blob(parts, { type: file.type || 'application/octet-stream' });
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function downloadOne(index) {
  if (state.busy) return;
  const file = state.files[index];
  if (!file) return;
  if (!(await claimOnce())) return;

  state.busy = true;
  try {
    showDownloadProgress(`${file.name} wird entschlüsselt …`, 0);
    const blob = await decryptToBlob(file, (fraction) =>
      showDownloadProgress(
        `${file.name} · ${formatBytes(file.size * fraction)} von ${formatBytes(file.size)}`,
        fraction
      )
    );
    saveBlob(blob, file.name);
    toast(`${file.name} gespeichert.`, 'ok');
  } catch (err) {
    toast(err.message || 'Download fehlgeschlagen.', 'err', 7000);
  } finally {
    state.busy = false;
    hideDownloadProgress();
    updateDownloadStatus();
  }
}

/**
 * Laedt alle Dateien. Mit File System Access API wird direkt in einen
 * gewaehlten Ordner geschrieben (echtes Streaming, auch bei riesigen Dateien).
 * Sonst wird jede Datei nacheinander entschluesselt und einzeln gespeichert.
 */
async function downloadAll(useFolder) {
  if (state.busy) return;
  const files = state.files || [];
  if (!files.length) return;
  if (!(await claimOnce())) return;

  let directory = null;
  if (useFolder) {
    try {
      directory = await window.showDirectoryPicker({ mode: 'readwrite', id: 'sharedrive' });
    } catch {
      return; // Nutzer hat abgebrochen
    }
  }

  state.busy = true;
  state.abortRequested = false;
  let finished = 0;
  const totalBytes = files.reduce((sum, file) => sum + (file.size || 0), 0);
  let processedBytes = 0;

  try {
    for (const file of files) {
      const label = `(${finished + 1}/${files.length}) ${file.name}`;

      if (directory) {
        // In den Zielordner streamen - kein Puffer im Arbeitsspeicher
        const relative = file.path && file.path !== file.name ? file.path : file.name;
        const handle = await createNestedFile(directory, relative);
        const writable = await handle.createWritable();
        try {
          for await (const plain of decryptChunks(file)) {
            await writable.write(plain);
            processedBytes += plain.length;
            showDownloadProgress(
              `${label} · ${formatBytes(processedBytes)} von ${formatBytes(totalBytes)}`,
              totalBytes ? processedBytes / totalBytes : 0
            );
          }
        } finally {
          await writable.close();
        }
      } else {
        const blob = await decryptToBlob(file, (fraction) => {
          showDownloadProgress(
            `${label} · ${formatBytes((file.size || 0) * fraction)} von ${formatBytes(file.size)}`,
            totalBytes ? (processedBytes + (file.size || 0) * fraction) / totalBytes : fraction
          );
        });
        saveBlob(blob, file.name);
        processedBytes += file.size || 0;
      }

      finished++;
      // Browser brauchen zwischen automatischen Downloads eine kurze Pause
      if (!directory && files.length > 1) await new Promise((r) => setTimeout(r, 350));
    }
    toast(
      directory
        ? `${files.length} Dateien im gewählten Ordner gespeichert.`
        : `${files.length} Dateien gespeichert.`,
      'ok'
    );
  } catch (err) {
    toast(err.message || 'Download fehlgeschlagen.', 'err', 7000);
  } finally {
    state.busy = false;
    hideDownloadProgress();
    updateDownloadStatus();
  }
}

/** Legt bei Bedarf Unterordner an (fuer hochgeladene Ordnerstrukturen). */
async function createNestedFile(directory, relativePath) {
  const parts = String(relativePath).split('/').filter(Boolean);
  const filename = parts.pop();
  let dir = directory;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create: true });
  }
  return dir.getFileHandle(filename, { create: true });
}

/* =========================================================================
 * Vorschau
 * ========================================================================= */

async function openPreview(file) {
  if (state.busy) return;
  state.busy = true;
  try {
    const blob = await decryptToBlob(file);
    const url = URL.createObjectURL(blob);
    const kind = (file.type || '').split('/')[0];
    const media =
      kind === 'image'
        ? `<img src="${url}" alt="${escapeHtml(file.name)}" />`
        : kind === 'video'
          ? `<video src="${url}" controls autoplay playsinline></video>`
          : `<audio src="${url}" controls autoplay></audio>`;

    const dialog = showModal({
      title: file.name,
      subtitle: `${formatBytes(file.size)} · entschlüsselt im Browser`,
      html: `<div class="lightbox">${media}</div>`,
      actions: [
        {
          label: 'Herunterladen',
          variant: 'primary',
          onClick: () => saveBlob(blob, file.name),
        },
      ],
    });
    dialog.addEventListener('close', () => URL.revokeObjectURL(url));
  } catch (err) {
    toast(err.message || 'Vorschau fehlgeschlagen.', 'err');
  } finally {
    state.busy = false;
  }
}

/* =========================================================================
 * Ereignisse
 * ========================================================================= */

$('pw-submit').addEventListener('click', submitPassword);
$('pw-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitPassword();
});

init();
