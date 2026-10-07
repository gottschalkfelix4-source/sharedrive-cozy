/**
 * Upload-Portal (Reverse Share).
 *
 * Uploader bekommen einen Link, der den *oeffentlichen* Schluessel des
 * Eigentuemers enthaelt. Jeder Upload erzeugt ein eigenes fluechtiges
 * Schluesselpaar, leitet per ECDH einen gemeinsamen Schluessel ab und
 * verschluesselt damit seine Dateien. Nur der Eigentuemer - der den privaten
 * Schluessel besitzt - kann sie wieder oeffnen.
 */

import api, { ApiError } from './sr-api.js';
import { encryptMeta, fromB64u, sealForOwner } from './sr-crypto.js';
import { UploadSession } from './sr-upload.js';
import { FilePicker, renderProgress, renderSelection, showView, wireUploadControls } from './sr-picker.js';
import { copyToClipboard, formatBytes, toast } from './sr-format.js';
import { mountShell, requireCrypto, showModal } from './sr-shell.js';
import { readPortalKey, portalShareUrl } from './sr-portal.js';
import { renderQr } from './sr-qr.js';

const $ = (id) => document.getElementById(id);
const VIEWS = ['loading', 'password', 'compose', 'progress', 'done', 'blocked'];

const state = {
  branding: { name: 'sharedrive' },
  requestId: null,
  request: null,
  ownerPublic: null,
  password: null,
  picker: null,
  session: null,
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
    /* optional */
  }
  mountShell({ branding: state.branding, active: 'request' });

  state.requestId = location.pathname.split('/').filter(Boolean).pop();
  const params = new URLSearchParams(location.hash.slice(1));
  const publicParam = params.get('p');
  if (publicParam) {
    try {
      state.ownerPublic = fromB64u(publicParam);
      // Der oeffentliche Schluessel muss nicht geheim bleiben, wird aber
      // aus der Adresszeile entfernt, damit der Link nicht beschaedigt wirkt.
    } catch {
      showBlocked('Ungültiger Link', 'Im Link fehlt ein gültiger Schlüssel. Bitte den vollständigen Link kopieren.');
      return;
    }
  }

  let request;
  try {
    request = await api.requestInfo(state.requestId);
  } catch (err) {
    showBlocked(
      'Portal nicht gefunden',
      err instanceof ApiError && err.status === 429
        ? 'Zu viele Versuche. Bitte kurz warten.'
        : 'Dieser Upload-Link ist ungültig oder wurde gelöscht.'
    );
    return;
  }

  state.request = request;

  if (request.state === 'expired') {
    showBlocked('Dieses Portal ist abgelaufen', 'Der Eigentümer nimmt darüber keine Dateien mehr an.');
    return;
  }
  if (request.state === 'full') {
    showBlocked('Dieses Portal ist voll', 'Es wurden bereits alle vorgesehenen Uploads abgegeben.');
    return;
  }
  if (request.state !== 'open') {
    showBlocked('Portal geschlossen', 'Der Eigentümer hat dieses Portal geschlossen.');
    return;
  }

  if (!state.ownerPublic) {
    // Ohne Schluessel im Link: ist das der Eigentuemer selbst?
    const stored = readPortalKey(state.requestId);
    if (stored) {
      showOwnerNotice(stored);
      return;
    }
    showBlocked(
      'Schlüssel fehlt',
      'Diesem Link fehlt der Teil nach dem „#“. Ohne ihn kann nichts verschlüsselt werden. Bitte den vollständigen Link verwenden.'
    );
    return;
  }

  if (request.passwordProtected) {
    showView(VIEWS, 'password');
    $('pw-input').focus();
    return;
  }

  renderCompose();
}

/** Hinweis fuer den Eigentuemer, der sein eigenes Portal oeffnet. */
function showOwnerNotice(stored) {
  const shareUrl = portalShareUrl(state.requestId, stored.public);
  const dialog = showModal({
    title: 'Das ist dein Upload-Portal',
    subtitle: 'Diesen Link verschickst du an die Personen, die dir Dateien schicken sollen.',
    html:
      '<div class="linkbox"><span class="linkbox__value" id="portal-link"></span></div>' +
      '<div class="qr-panel" id="portal-qr"></div>' +
      '<p class="tiny muted">Der Link enthält den öffentlichen Schlüssel dieses Portals. Deine eingegangenen Dateien entschlüsselst du im Dashboard – dort liegt auch der private Schlüssel.',
  });
  dialog.querySelector('#portal-link').textContent = shareUrl;

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'btn btn--primary btn--full';
  copyButton.textContent = 'Link kopieren';
  copyButton.addEventListener('click', async () => {
    const ok = await copyToClipboard(shareUrl);
    toast(ok ? 'Link kopiert.' : 'Kopieren nicht möglich.', ok ? 'ok' : 'err');
  });
  dialog.querySelector('.modal__body').appendChild(copyButton);
  renderQr(dialog.querySelector('#portal-qr'), shareUrl, { scale: 8 });

  showView(VIEWS, 'blocked');
  $('blocked-title').textContent = 'Du bist der Eigentümer';
  $('blocked-text').textContent =
    'Zum Hochladen ist dieser Link für andere gedacht. Deine eingegangenen Dateien findest du im Dashboard.';
}

async function submitPassword() {
  const password = $('pw-input').value;
  if (!password) {
    $('pw-hint').textContent = 'Bitte ein Passwort eingeben.';
    return;
  }
  const button = $('pw-submit');
  button.disabled = true;
  $('pw-hint').textContent = 'Wird geprüft …';
  try {
    await api.verifyRequestPassword(state.requestId, password);
    state.password = password;
    renderCompose();
  } catch (err) {
    $('pw-hint').textContent =
      err instanceof ApiError && err.status === 429
        ? err.message
        : 'Falsches Passwort. Bitte noch einmal versuchen.';
  } finally {
    button.disabled = false;
  }
}

/* =========================================================================
 * Ansicht
 * ========================================================================= */

function renderCompose() {
  const request = state.request;
  $('request-title').textContent = request.title || 'Dateien hochladen';

  const parts = [];
  if (request.maxFiles) parts.push(`bis zu ${request.maxFiles} Dateien`);
  if (request.maxTransferBytes) parts.push(`bis zu ${formatBytes(request.maxTransferBytes)} pro Upload`);
  parts.push(`offen bis ${new Date(request.expiresAt).toLocaleDateString('de-DE')}`);
  $('request-meta').textContent = parts.join(' · ');

  if (request.message) {
    $('request-message').classList.remove('hidden');
    $('request-message').textContent = request.message;
  }
  if (request.hint) {
    $('request-message').classList.remove('hidden');
    $('request-message').textContent = `${request.message ? `${request.message}\n\n` : ''}${request.hint}`;
  }

  state.picker = new FilePicker({
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    maxFiles: request.maxFiles || 2000,
    onChange: refreshSelection,
  });

  $('btn-clear').addEventListener('click', () => state.picker.clear());
  $('btn-upload').addEventListener('click', startUpload);

  wireUploadControls({
    pauseButton: $('btn-pause'),
    abortButton: $('btn-abort'),
    getSession: () => state.session,
    onAborted: () => {
      showView(VIEWS, 'compose');
      toast('Upload wurde verworfen.', 'info');
    },
  });

  $('btn-again').addEventListener('click', () => window.location.reload());

  if (!globalThis.crypto?.subtle) {
    $('crypto-warning').textContent = 'Ohne HTTPS steht die Browser-Verschlüsselung nicht bereit.';
  }

  refreshSelection();
  showView(VIEWS, 'compose');
}

function progressNodes() {
  return {
    ringEl: $('ring'),
    ringLabelEl: $('ring-label'),
    transferredEl: $('p-transferred'),
    speedEl: $('p-speed'),
    etaEl: $('p-eta'),
    stateEl: $('progress-state'),
    filesEl: $('progress-files'),
    titleEl: null,
    subEl: null,
  };
}

function refreshSelection() {
  if (!state.picker) return;
  const result = renderSelection({
    nodes: {
      selectionEl: $('selection'),
      summaryEl: $('selection-summary'),
      listEl: $('filelist'),
      hintEl: null,
    },
    picker: state.picker,
    maxTransferBytes: state.request?.maxTransferBytes || 0,
  });
  $('btn-upload').disabled = !result.allowed || !globalThis.crypto?.subtle;
}

/* =========================================================================
 * Upload
 * ========================================================================= */

async function startUpload() {
  if (!state.picker?.selection.length) {
    toast('Bitte zuerst Dateien auswählen.', 'err');
    return;
  }

  let master;
  let keyInfo;
  try {
    const sealed = await sealForOwner(state.ownerPublic);
    master = sealed.master;
    keyInfo = sealed.keyInfo;
  } catch (err) {
    toast(`Verschlüsselung fehlgeschlagen: ${err.message}`, 'err');
    return;
  }

  const metaPayload = {
    v: 1,
    message: $('message').value.trim(),
    createdAt: Date.now(),
    files: state.picker.selection.map((item, idx) => ({
      idx,
      name: item.file.name,
      path: item.relPath,
      size: item.file.size,
      type: item.file.type || 'application/octet-stream',
      lastModified: item.file.lastModified,
    })),
  };

  const meta = await encryptMeta(master, metaPayload);

  const session = new UploadSession({
    files: state.picker.files,
    masterKey: master,
    meta,
    keyMode: 'ecdh',
    keyWrap: keyInfo,
    chunkSize: 4 * 1024 * 1024,
    expiresInHours: Math.max(1, Math.round((state.request.expiresAt - Date.now()) / 3_600_000)),
    maxDownloads: 0,
    notify: true,
    requestId: state.requestId,
    requestPassword: state.password,
    onChange: (snapshot) => renderProgress(progressNodes(), snapshot),
  });
  state.session = session;

  showView(VIEWS, 'progress');
  renderProgress(progressNodes(), session.snapshot());

  try {
    await session.start();
    const totalBytes = session.items.reduce((sum, item) => sum + item.size, 0);
    $('done-summary').textContent =
      `${session.items.length} ${session.items.length === 1 ? 'Datei' : 'Dateien'} · ${formatBytes(totalBytes)} · ` +
      'nur der Eigentümer kann sie öffnen.';
    state.session = null;
    showView(VIEWS, 'done');
  } catch (err) {
    if (session.state === 'canceled') {
      showView(VIEWS, 'compose');
      toast('Upload abgebrochen.', 'info');
      return;
    }
    renderProgress(progressNodes(), session.snapshot());
    toast(err.message || 'Upload fehlgeschlagen.', 'err', 8000);
  }
}

function showBlocked(title, text) {
  $('blocked-title').textContent = title;
  $('blocked-text').textContent = text;
  showView(VIEWS, 'blocked');
}

$('pw-submit').addEventListener('click', submitPassword);
$('pw-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') submitPassword();
});

init();
