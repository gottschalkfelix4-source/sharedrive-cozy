/**
 * Senden-Seite: Dateien auswaehlen, Optionen setzen, verschluesselt hochladen.
 */

import api from './sr-api.js';
import { encryptMeta, randomBytes, toB64u, wrapMasterKey } from './sr-crypto.js';
import { UploadSession } from './sr-upload.js';
import { FilePicker, renderProgress, renderSelection, showView, wireUploadControls } from './sr-picker.js';
import { copyToClipboard, formatBytes, toast } from './sr-format.js';
import { mountShell, openThemeDialog, requireCrypto, showModal } from './sr-shell.js';
import { renderQr } from './sr-qr.js';

const $ = (id) => document.getElementById(id);

const MAX_TRANSFER_FALLBACK = 20 * 1024 ** 3;
const EXPIRY_CHOICES = [
  { hours: 1, label: '1 Stunde' },
  { hours: 24, label: '1 Tag' },
  { hours: 72, label: '3 Tage' },
  { hours: 168, label: '7 Tage' },
  { hours: 336, label: '14 Tage' },
  { hours: 720, label: '30 Tage' },
];
const DOWNLOAD_CHOICES = [
  { value: 0, label: 'Unbegrenzt' },
  { value: 1, label: '1 Download' },
  { value: 5, label: '5 Downloads' },
  { value: 25, label: '25 Downloads' },
];

const VIEWS = ['compose', 'progress', 'done'];

const state = {
  config: null,
  branding: { name: 'sharedrive', tagline: '' },
  picker: null,
  session: null,
  shareUrl: '',
  masterKey: null,
};

/* =========================================================================
 * Aufbau
 * ========================================================================= */

async function init() {
  const secure = requireCrypto();
  $('crypto-warning').textContent = secure
    ? ''
    : 'Ohne HTTPS steht die Browser-Verschlüsselung nicht bereit. Bitte die Seite über https:// aufrufen.';

  try {
    state.config = await api.config();
  } catch {
    state.config = null;
  }

  state.branding = state.config?.branding || { name: 'sharedrive', tagline: '' };
  mountShell({ branding: state.branding, active: 'send' });
  if (state.branding.name) document.title = `${state.branding.name} – Dateien teilen`;

  buildSelects();

  state.picker = new FilePicker({
    dropzone: $('dropzone'),
    fileInput: $('file-input'),
    folderInput: $('folder-input'),
    maxFiles: state.config?.limits?.maxFiles ?? 2000,
    onChange: refreshSelection,
  });

  $('btn-clear').addEventListener('click', () => state.picker.clear());
  wireOptions();
  wireDone();
  wireUploadControls({
    pauseButton: $('btn-pause'),
    abortButton: $('btn-abort'),
    getSession: () => state.session,
    onAborted: () => {
      showView(VIEWS, 'compose');
      toast('Transfer wurde verworfen.', 'info');
    },
  });

  refreshSelection();
}

function buildSelects() {
  const maxExpiry = state.config?.limits?.maxExpiryHours ?? 720;
  const defaultExpiry = state.config?.limits?.defaultExpiryHours ?? 168;
  const choices = EXPIRY_CHOICES.filter((c) => c.hours <= maxExpiry);

  $('expiry').innerHTML = choices
    .map((c) => `<option value="${c.hours}">${c.label}</option>`)
    .join('');
  $('expiry').value = String(
    choices.some((c) => c.hours === defaultExpiry) ? defaultExpiry : choices.at(-1)?.hours ?? 24
  );

  $('max-downloads').innerHTML = DOWNLOAD_CHOICES.map(
    (c) => `<option value="${c.value}">${c.label}</option>`
  ).join('');
  $('max-downloads').value = String(state.config?.limits?.defaultMaxDownloads ?? 0);

  // Ohne konfigurierten Versandweg waere der Schalter irrefuehrend. Ausblenden
  // statt entfernen, damit die Auswertung beim Senden unveraendert bleibt.
  const notifySwitch = $('notify')?.closest('.switch');
  if (notifySwitch && !state.config?.features?.notify) notifySwitch.classList.add('hidden');
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
    titleEl: $('progress-title'),
    subEl: $('progress-sub'),
  };
}

function refreshSelection() {
  const result = renderSelection({
    nodes: {
      selectionEl: $('selection'),
      summaryEl: $('selection-summary'),
      listEl: $('filelist'),
      hintEl: $('size-hint'),
    },
    picker: state.picker,
    maxTransferBytes: state.config?.limits?.maxTransferBytes ?? MAX_TRANSFER_FALLBACK,
  });
  $('btn-upload').disabled = !result.allowed || !globalThis.crypto?.subtle;
}

/* =========================================================================
 * Optionen
 * ========================================================================= */

function wireOptions() {
  const usePassword = $('use-password');
  const passwordWrap = $('password-wrap');
  const password = $('password');

  usePassword.addEventListener('change', () => {
    passwordWrap.classList.toggle('hidden', !usePassword.checked);
    if (usePassword.checked) password.focus();
  });

  $('btn-reveal').addEventListener('click', () => {
    const revealed = password.type === 'text';
    password.type = revealed ? 'password' : 'text';
    $('btn-reveal').textContent = revealed ? 'Zeigen' : 'Verbergen';
  });

  $('btn-upload').addEventListener('click', startUpload);
}

/* =========================================================================
 * Upload
 * ========================================================================= */

async function startUpload() {
  const usePassword = $('use-password').checked;
  const password = $('password').value;

  if (usePassword && password.length < 8) {
    toast('Bitte ein Passwort mit mindestens 8 Zeichen wählen.', 'err');
    $('password').focus();
    return;
  }
  if (!state.picker.selection.length) {
    toast('Bitte zuerst Dateien auswählen.', 'err');
    return;
  }

  const masterKey = randomBytes(32);
  state.masterKey = masterKey;

  let keyWrap = null;
  if (usePassword) {
    try {
      keyWrap = await wrapMasterKey(masterKey, password);
    } catch (err) {
      toast(`Passwortschutz konnte nicht eingerichtet werden: ${err.message}`, 'err');
      return;
    }
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

  let meta;
  try {
    meta = await encryptMeta(masterKey, metaPayload);
  } catch (err) {
    toast(`Metadaten konnten nicht verschlüsselt werden: ${err.message}`, 'err');
    return;
  }

  const session = new UploadSession({
    files: state.picker.files,
    masterKey,
    meta,
    keyMode: usePassword ? 'password' : 'link',
    keyWrap,
    chunkSize: state.config?.limits?.clientChunkSize || 4 * 1024 * 1024,
    expiresInHours: Number($('expiry').value),
    maxDownloads: Number($('max-downloads').value),
    notify: $('notify').checked,
    onChange: (snapshot) => renderProgress(progressNodes(), snapshot),
  });
  state.session = session;

  showView(VIEWS, 'progress');
  renderProgress(progressNodes(), session.snapshot());

  try {
    await session.start();
    finishUpload(session);
  } catch (err) {
    if (session.state === 'canceled') {
      showView(VIEWS, 'compose');
      toast('Upload abgebrochen. Der Transfer wurde gelöscht.', 'info');
      return;
    }
    renderProgress(progressNodes(), session.snapshot());
    toast(err.message || 'Upload fehlgeschlagen', 'err', 8000);
    const retry = $('btn-pause');
    retry.textContent = 'Neu laden';
    retry.onclick = () => window.location.reload();
  }
}

/* =========================================================================
 * Fertig
 * ========================================================================= */

function finishUpload(session) {
  const fragment = toB64u(state.masterKey);
  state.shareUrl = `${location.origin}/t/${session.transferId}#k=${fragment}`;
  state.session = null;

  const totalBytes = session.items.reduce((sum, item) => sum + item.size, 0);
  const expiryLabel = $('expiry').selectedOptions[0]?.textContent || '';
  $('done-summary').textContent =
    `${session.items.length} ${session.items.length === 1 ? 'Datei' : 'Dateien'} · ` +
    `${formatBytes(totalBytes)} · ${expiryLabel} verfügbar`;

  $('share-link').textContent = state.shareUrl;
  $('share-link').title = state.shareUrl;

  const subject = `${state.branding.name}: ${session.items.length} ${
    session.items.length === 1 ? 'Datei' : 'Dateien'
  } für dich`;
  const passwordNote =
    session.keyMode === 'password'
      ? 'Das Passwort sende ich dir separat – ohne das lässt sich nichts öffnen.\n\n'
      : '';
  $('btn-mail').href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(
    `Hallo,\n\nhier sind die Dateien:\n${state.shareUrl}\n\n` +
      passwordNote +
      'Der Link funktioniert nur, solange er nicht abgelaufen ist.'
  )}`;

  if (navigator.share) $('btn-native-share').classList.remove('hidden');
  showView(VIEWS, 'done');
  toast('Transfer fertig – Link kopieren und teilen.', 'ok');
}

function wireDone() {
  $('btn-copy').addEventListener('click', async () => {
    const ok = await copyToClipboard(state.shareUrl);
    toast(ok ? 'Link kopiert.' : 'Kopieren nicht möglich – bitte manuell markieren.', ok ? 'ok' : 'err');
  });

  $('btn-qr').addEventListener('click', () => {
    const dialog = showModal({
      title: 'Zum Scannen',
      subtitle: 'Mit der Handy-Kamera öffnen – der Schlüssel steckt im Code.',
      html:
        '<div class="qr-panel" id="qr-panel"></div>' +
        '<p class="tiny muted center">Der QR-Code enthält den vollständigen Link inklusive Schlüssel. Nicht öffentlich zeigen.</p>',
    });
    renderQr(dialog.querySelector('#qr-panel'), state.shareUrl, { scale: 9 });
  });

  $('btn-native-share').addEventListener('click', async () => {
    try {
      await navigator.share({
        title: state.branding.name,
        text: 'Dateien für dich',
        url: state.shareUrl,
      });
    } catch {
      /* abgebrochen */
    }
  });

  $('btn-new').addEventListener('click', () => window.location.reload());
}

document.addEventListener('keydown', (event) => {
  if (event.key.toLowerCase() === 't' && (event.metaKey || event.ctrlKey) && event.shiftKey) {
    event.preventDefault();
    openThemeDialog();
  }
});

init();
