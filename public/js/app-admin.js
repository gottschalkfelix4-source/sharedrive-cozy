/**
 * Verwaltung: Anmeldung, Übersicht, Transfers, Upload-Portale, Aktivität,
 * Erscheinungsbild und Wartung.
 */

import api, { ApiError } from './sr-api.js';
import { generateOwnerKeyPair, toB64u } from './sr-crypto.js';
import {
  copyToClipboard,
  escapeHtml,
  formatBytes,
  formatDate,
  formatRelative,
  formatRemaining,
  toast,
} from './sr-format.js';
import {
  applyTheme,
  mountShell,
  showModal,
  syncThemePills,
} from './sr-shell.js';
import {
  forgetPortalKey,
  importPortalKeyFile,
  portalShareUrl,
  readPortalKey,
  savePortalKey,
} from './sr-portal.js';
import { renderQr } from './sr-qr.js';

const $ = (id) => document.getElementById(id);

const EXPIRY_CHOICES = [
  { hours: 24, label: '1 Tag' },
  { hours: 72, label: '3 Tage' },
  { hours: 168, label: '7 Tage' },
  { hours: 336, label: '14 Tage' },
  { hours: 720, label: '30 Tage' },
];

const state = {
  overview: null,
  page: 1,
  query: '',
  tab: 'transfers',
};

/* =========================================================================
 * Anmeldung
 * ========================================================================= */

async function init() {
  mountShell({ branding: { name: 'sharedrive' }, active: 'admin' });

  $('login-submit').addEventListener('click', login);
  $('login-password').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') login();
  });

  await loadDashboard();
}

async function login() {
  const password = $('login-password').value;
  if (!password) return;
  $('login-hint').textContent = 'Wird geprüft …';
  $('login-submit').disabled = true;
  try {
    await api.admin.login(password);
    $('login-password').value = '';
    $('login-hint').textContent = '';
    await loadDashboard();
  } catch (err) {
    $('login-hint').textContent =
      err instanceof ApiError && err.status === 503
        ? 'Kein Admin-Passwort gesetzt. Bitte ADMIN_PASSWORD in der .env hinterlegen.'
        : 'Falsches Passwort.';
  } finally {
    $('login-submit').disabled = false;
  }
}

async function loadDashboard() {
  let overview;
  try {
    overview = await api.admin.overview();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      $('view-login').classList.remove('hidden');
      $('view-dashboard').classList.add('hidden');
      $('login-password').focus();
      return;
    }
    toast(err.message || 'Übersicht konnte nicht geladen werden.', 'err');
    return;
  }

  state.overview = overview;
  $('view-login').classList.add('hidden');
  $('view-dashboard').classList.remove('hidden');

  if (overview.branding?.name) {
    document.title = `Verwaltung – ${overview.branding.name}`;
    mountShell({ branding: overview.branding, active: 'admin' });
  }

  $('instance-title').textContent = overview.instanceName;
  $('instance-sub').textContent = overview.notifications.configured
    ? `Benachrichtigungen aktiv (${overview.notifications.type})`
    : 'Benachrichtigungen sind nicht konfiguriert.';

  wireDashboard(overview);
  renderStats(overview);
  await Promise.all([renderTransfers(), renderChart(), renderActivity(), renderPortals(), renderBranding(overview)]);
}

function wireDashboard(overview) {
  if (state.wired) return;
  state.wired = true;

  $('btn-logout').addEventListener('click', async () => {
    await api.admin.logout().catch(() => {});
    window.location.reload();
  });

  document.querySelectorAll('[data-tab]').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      document.querySelectorAll('[data-tab]').forEach((t) =>
        t.classList.toggle('is-active', t === tab)
      );
      document.querySelectorAll('[data-panel]').forEach((panel) =>
        panel.classList.toggle('hidden', panel.dataset.panel !== state.tab)
      );
    });
  });

  $('btn-refresh').addEventListener('click', () => renderTransfers());
  $('transfer-search').addEventListener('input', (event) => {
    state.query = event.target.value.trim();
    state.page = 1;
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => renderTransfers(), 250);
  });
  $('page-prev').addEventListener('click', () => {
    if (state.page > 1) {
      state.page--;
      renderTransfers();
    }
  });
  $('page-next').addEventListener('click', () => {
    state.page++;
    renderTransfers();
  });

  $('btn-refresh-activity').addEventListener('click', () => renderActivity());
  $('btn-create-request').addEventListener('click', createPortal);
  $('btn-save-branding').addEventListener('click', saveBranding);
  $('btn-cleanup').addEventListener('click', runCleanup);
  $('btn-notify-test').addEventListener('click', testNotification);

  const maxExpiry = overview.limits.maxExpiryHours;
  $('req-expiry').innerHTML = EXPIRY_CHOICES.filter((c) => c.hours <= maxExpiry)
    .map((c) => `<option value="${c.hours}">${c.label}</option>`)
    .join('');
  $('req-size').innerHTML = [1, 5, 20, 50, 200]
    .filter((gb) => gb * 1024 ** 3 <= overview.limits.maxTransferBytes)
    .map((gb) => `<option value="${gb * 1024 ** 3}">${gb} GiB pro Upload</option>`)
    .join('');
  $('req-size').value = String(Math.min(overview.limits.maxTransferBytes, 20 * 1024 ** 3));

  renderConfig(overview);
}

/* =========================================================================
 * Übersicht
 * ========================================================================= */

function renderStats(overview) {
  const { totals, disk, limits } = overview;
  const usage = limits.storageQuotaBytes
    ? `${Math.round((disk.bytes / limits.storageQuotaBytes) * 100)} % von ${formatBytes(limits.storageQuotaBytes)}`
    : 'keine Quote gesetzt';

  const cards = [
    { label: 'Transfers', value: totals.transfers, hint: `${totals.ready} fertig · ${totals.uploading} im Upload` },
    { label: 'Belegter Speicher', value: formatBytes(disk.bytes), hint: usage, accent: true },
    { label: 'Downloads gesamt', value: totals.downloads, hint: 'pro Empfänger einmal gezählt' },
    { label: 'Upload-Portale', value: totals.requests, hint: 'Reverse-Share-Links' },
  ];

  $('stat-cards').innerHTML = cards
    .map(
      (card) => `
      <div class="stat-card ${card.accent ? 'stat-card--accent' : ''}">
        <div class="stat-card__label">${escapeHtml(card.label)}</div>
        <div class="stat-card__value">${escapeHtml(String(card.value))}</div>
        <div class="stat-card__hint">${escapeHtml(card.hint)}</div>
      </div>`
    )
    .join('');
}

async function renderChart() {
  let data;
  try {
    data = await api.admin.chart(14);
  } catch {
    return;
  }
  const max = Math.max(1, ...data.days.map((d) => d.count));
  const host = $('chart');
  host.innerHTML = '';

  for (const day of data.days) {
    const height = Math.round((day.count / max) * 78) + 3;
    const label = new Date(`${day.day}T12:00:00`).toLocaleDateString('de-DE', {
      day: '2-digit',
      month: '2-digit',
    });

    const bar = document.createElement('div');
    bar.className = `spark${day.count === 0 ? ' spark--zero' : ''}`;
    // Ueber CSSOM gesetzt - die strikte CSP verbietet nur Inline-Styles im Markup.
    bar.style.height = `${height}px`;
    bar.title = `${label}: ${day.count} Downloads`;

    const dayLabel = document.createElement('span');
    dayLabel.className = 'spark__day';
    dayLabel.textContent = label;
    bar.appendChild(dayLabel);

    host.appendChild(bar);
  }

  const total = data.days.reduce((sum, d) => sum + d.count, 0);
  $('chart-sub').textContent = `${total} Downloads in 14 Tagen · ein Download zählt einmal pro Empfänger.`;
}

/* =========================================================================
 * Transfers
 * ========================================================================= */

async function renderTransfers() {
  let data;
  try {
    data = await api.admin.transfers(state.page, state.query);
  } catch (err) {
    toast(err.message || 'Transfers konnten nicht geladen werden.', 'err');
    return;
  }
  if (data.page > data.pages) {
    state.page = data.pages;
    return renderTransfers();
  }

  const rows = $('transfer-rows');
  if (!data.transfers.length) {
    rows.innerHTML = `<tr><td colspan="7"><div class="empty">Keine Transfers gefunden.</div></td></tr>`;
  } else {
    rows.innerHTML = data.transfers
      .map((transfer) => {
        const status = transfer.expired
          ? '<span class="state-badge state-badge--err">abgelaufen</span>'
          : transfer.state === 'uploading'
            ? '<span class="state-badge state-badge--warn">Upload läuft</span>'
            : '<span class="state-badge state-badge--ok">aktiv</span>';
        const lock = transfer.passwordProtected
          ? '<span class="state-badge" title="Passwortgeschützt">🔒</span> '
          : '';
        return `
        <tr>
          <td>
            <div class="mono">${escapeHtml(transfer.id)}</div>
            <div class="tiny muted">${escapeHtml(transfer.note || 'ohne Notiz')}</div>
            ${transfer.requestId ? '<div class="tiny muted">aus Upload-Portal</div>' : ''}
          </td>
          <td>${formatBytes(transfer.bytes)}</td>
          <td>${transfer.fileCount}</td>
          <td>${transfer.downloads}${transfer.maxDownloads > 0 ? ` / ${transfer.maxDownloads}` : ''}</td>
          <td class="tiny">${formatRemaining(transfer.expiresAt)}</td>
          <td>${lock}${status}</td>
          <td>
            <button type="button" class="btn btn--sm btn--quiet" data-details="${escapeHtml(transfer.id)}">Details</button>
          </td>
        </tr>`;
      })
      .join('');

    rows.querySelectorAll('[data-details]').forEach((button) =>
      button.addEventListener('click', () => showTransferDetails(button.dataset.details))
    );
  }

  $('page-label').textContent = `Seite ${data.page} von ${data.pages} · ${data.total} Transfers`;
  $('page-prev').disabled = data.page <= 1;
  $('page-next').disabled = data.page >= data.pages;
}

async function showTransferDetails(id) {
  let data;
  try {
    data = await api.admin.transfers(1, id);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }
  const transfer = data.transfers.find((t) => t.id === id);
  if (!transfer) {
    toast('Transfer nicht gefunden.', 'err');
    return;
  }

  const expiryOptions = EXPIRY_CHOICES.filter(
    (c) => c.hours <= (state.overview?.limits.maxExpiryHours ?? 720)
  )
    .map((c) => `<option value="${c.hours}">${c.label}</option>`)
    .join('');

  const dialog = showModal({
    title: `Transfer ${transfer.id}`,
    subtitle: `Angelegt am ${formatDate(transfer.createdAt)}`,
    html: `
      <dl class="summary">
        <div class="summary__row"><dt>Größe</dt><dd>${formatBytes(transfer.bytes)}</dd></div>
        <div class="summary__row"><dt>Dateien</dt><dd>${transfer.fileCount}</dd></div>
        <div class="summary__row"><dt>Downloads</dt><dd id="d-count">${transfer.downloads}${
          transfer.maxDownloads > 0 ? ` von ${transfer.maxDownloads}` : ''
        }</dd></div>
        <div class="summary__row"><dt>Läuft ab</dt><dd>${formatDate(transfer.expiresAt)}</dd></div>
        <div class="summary__row"><dt>Verschlüsselung</dt><dd>${
          transfer.passwordProtected ? 'Link + Passwort' : 'Schlüssel im Link'
        }</dd></div>
      </dl>

      <label class="field">
        <span class="field__label">Interne Notiz (nur hier sichtbar)</span>
        <input class="input" id="d-note" value="${escapeHtml(transfer.note || '')}" maxlength="200" placeholder="z. B. Kunde Meyer, Shooting Mai" />
      </label>

      <div class="grid grid--2">
        <label class="field">
          <span class="field__label">Ablauf verlängern um</span>
          <select class="select" id="d-expiry">${expiryOptions}</select>
        </label>
        <label class="field">
          <span class="field__label">Download-Limit</span>
          <input class="input" type="number" id="d-max" min="0" max="100000" value="${transfer.maxDownloads}" />
        </label>
      </div>

      <div class="notice">
        Zum Öffnen braucht der Empfänger den vollständigen Link <em>inklusive Schlüssel</em>. Der entsteht nur
        auf der Sende-Seite – hier im Dashboard lässt sich nur die Adresse
        <span class="mono">/t/${escapeHtml(transfer.id)}</span> anzeigen.
      </div>

      <label class="field">
        <span class="field__label">Zugriffe</span>
        <div id="d-log" class="stack stack--sm tiny muted">wird geladen …</div>
      </label>`,
    actions: [
      {
        label: 'Speichern',
        variant: 'primary',
        onClick: async (d) => {
          try {
            await api.admin.updateTransfer(transfer.id, {
              note: $('d-note').value,
              expiresInHours: Number($('d-expiry').value),
              maxDownloads: Number($('d-max').value),
            });
            toast('Änderungen gespeichert.', 'ok');
            d.close();
            renderTransfers();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      },
      {
        label: 'Zähler zurücksetzen',
        onClick: async () => {
          try {
            await api.admin.updateTransfer(transfer.id, { downloads: 0 });
            toast('Download-Zähler zurückgesetzt.', 'ok');
            renderTransfers();
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      },
      {
        label: 'Löschen',
        onClick: async (d) => {
          if (!confirm(`Transfer ${transfer.id} endgültig löschen? Die verschlüsselten Daten werden entfernt.`))
            return;
          try {
            await api.admin.deleteTransfer(transfer.id);
            toast('Transfer gelöscht.', 'ok');
            d.close();
            renderTransfers();
            renderStats(state.overview);
          } catch (err) {
            toast(err.message, 'err');
          }
        },
      },
    ],
  });

  try {
    const log = await api.admin.transferDownloads(transfer.id);
    dialog.querySelector('#d-log').innerHTML = log.entries.length
      ? log.entries
          .slice(0, 12)
          .map(
            (entry) =>
              `<div>${formatDate(entry.ts)} · ${escapeHtml(
                String(entry.userAgent || '').slice(0, 60) || 'unbekannter Client'
              )}${entry.ipHash ? ` · ${escapeHtml(entry.ipHash)}` : ''}</div>`
          )
          .join('')
      : '<div>Noch keine Zugriffe.</div>';
  } catch {
    dialog.querySelector('#d-log').textContent = 'Zugriffe konnten nicht geladen werden.';
  }
}

/* =========================================================================
 * Aktivität
 * ========================================================================= */

async function renderActivity() {
  let data;
  try {
    data = await api.admin.activity(60);
  } catch {
    return;
  }
  $('activity-sub').textContent = `${data.entries.length} Ereignisse · IP-Adressen werden nur als Prüfsumme gespeichert.`;
  $('activity-list').innerHTML = data.entries.length
    ? data.entries
        .map(
          (entry) => `
        <div class="row row--between u-gap-3">
          <span>
            <strong class="mono">${escapeHtml(entry.transferId)}</strong>
            <span class="tiny muted">${escapeHtml(entry.note || '')}</span>
          </span>
          <span class="tiny muted">${formatRelative(entry.ts)} · ${formatDate(entry.ts)}</span>
        </div>`
        )
        .join('')
    : '<div class="empty">Keine Aktivität erfasst.</div>';
}

/* =========================================================================
 * Upload-Portale
 * ========================================================================= */

async function createPortal() {
  const title = $('req-title').value.trim();
  if (!title) {
    toast('Bitte einen Titel für das Portal angeben.', 'err');
    $('req-title').focus();
    return;
  }

  const button = $('btn-create-request');
  button.disabled = true;

  try {
    // Schluesselpaar entsteht hier im Browser. Der private Teil bleibt lokal.
    const pair = await generateOwnerKeyPair();
    const publicB64 = toB64u(pair.publicRaw);

    const created = await api.admin.createRequest({
      title,
      message: $('req-message').value.trim() || null,
      expiresInHours: Number($('req-expiry').value),
      maxFiles: 200,
      maxTransferBytes: Number($('req-size').value),
      password: $('req-password').value.trim() || null,
      notify: $('req-notify').checked,
    });

    const stored = savePortalKey(created.id, {
      public: publicB64,
      private: toB64u(pair.privatePkcs8),
    });
    if (!stored) {
      toast('Warnung: Der Schlüssel konnte nicht gespeichert werden. Bitte sofort sichern!', 'err', 9000);
    }

    const shareUrl = portalShareUrl(created.id, publicB64);
    $('req-title').value = '';
    $('req-message').value = '';
    $('req-password').value = '';

    showPortalDialog(created, shareUrl, publicB64);
    await renderPortals();
    if (state.overview) renderStats({ ...state.overview, totals: { ...state.overview.totals, requests: state.overview.totals.requests + 1 } });
  } catch (err) {
    toast(err.message || 'Portal konnte nicht angelegt werden.', 'err');
  } finally {
    button.disabled = false;
  }
}

function showPortalDialog(created, shareUrl, publicB64) {
  const dialog = showModal({
    title: 'Portal ist bereit',
    subtitle: created.passwordProtected
      ? 'Diesen Link plus das Passwort an die Uploader weitergeben.'
      : 'Diesen Link an die Uploader weitergeben.',
    html: `
      <div class="linkbox"><span class="linkbox__value" id="p-link"></span></div>
      <div class="qr-panel" id="p-qr"></div>
      <div class="notice notice--warn">
        <strong>Jetzt sichern:</strong> Der private Schlüssel liegt nur in diesem Browser. Ohne ihn kannst du
        später keine eingegangenen Dateien öffnen.
      </div>`,
  });

  dialog.querySelector('#p-link').textContent = shareUrl;
  renderQr(dialog.querySelector('#p-qr'), shareUrl, { scale: 8 });

  const body = dialog.querySelector('.modal__body');
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'btn btn--primary btn--full';
  copy.textContent = 'Link kopieren';
  copy.addEventListener('click', async () => {
    const ok = await copyToClipboard(shareUrl);
    toast(ok ? 'Link kopiert.' : 'Kopieren nicht möglich.', ok ? 'ok' : 'err');
  });

  const backup = document.createElement('button');
  backup.type = 'button';
  backup.className = 'btn btn--quiet btn--full';
  backup.textContent = 'Schlüssel sichern (Datei herunterladen)';
  backup.addEventListener('click', () => exportPortalKey(created.id));

  body.append(copy, backup);
  if (publicB64) dialog.dataset.public = publicB64;
}

async function renderPortals() {
  let data;
  try {
    data = await api.admin.requests(1);
  } catch {
    return;
  }

  const host = $('portal-list');
  if (!data.requests.length) {
    host.innerHTML = '<div class="empty">Noch keine Portale angelegt.</div>';
    return;
  }

  host.innerHTML = '';
  for (const portal of data.requests) {
    const key = readPortalKey(portal.id);
    const shareUrl = key ? portalShareUrl(portal.id, key.public) : null;

    const card = document.createElement('div');
    card.className = 'card card--pad stack';
    card.innerHTML = `
      <div class="row row--between row--wrap u-gap-3">
        <div>
          <strong>${escapeHtml(portal.title)}</strong>
          <div class="tiny muted">
            ${portal.submissions}${portal.maxSubmissions > 0 ? ` / ${portal.maxSubmissions}` : ''} Uploads ·
            ${portal.expired ? 'abgelaufen' : `läuft ${formatRemaining(portal.expiresAt)}`}
            ${portal.passwordProtected ? ' · 🔒 passwortgeschützt' : ''}
          </div>
        </div>
        <span class="${key ? 'state-badge state-badge--ok' : 'state-badge state-badge--warn'}">
          ${key ? 'Schlüssel vorhanden' : 'Schlüssel fehlt'}
        </span>
      </div>
      <div class="mono tiny muted">/r/${escapeHtml(portal.id)}</div>
      <div class="row row--wrap u-gap-2" data-actions></div>
      <div class="stack stack--sm" data-submissions></div>`;

    const actions = card.querySelector('[data-actions]');

    if (shareUrl) {
      actions.append(
        button('Link kopieren', 'btn--quiet', async () => {
          const ok = await copyToClipboard(shareUrl);
          toast(ok ? 'Link kopiert.' : 'Kopieren nicht möglich.', ok ? 'ok' : 'err');
        }),
        button('QR-Code', 'btn--quiet', () => {
          const dialog = showModal({
            title: portal.title,
            subtitle: 'Upload-Link zum Scannen',
            html: '<div class="qr-panel" id="pp-qr"></div>',
          });
          renderQr(dialog.querySelector('#pp-qr'), shareUrl, { scale: 8 });
        }),
        button('Schlüssel exportieren', 'btn--quiet', () => exportPortalKey(portal.id))
      );
    } else {
      const label = document.createElement('label');
      label.className = 'btn btn--quiet';
      label.textContent = 'Schlüssel importieren';
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = '.json,application/json';
      input.className = 'sr-only';
      input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
          importPortalKeyFile(portal.id, await file.text());
          toast('Schlüssel importiert.', 'ok');
          renderPortals();
        } catch (err) {
          toast(err.message || 'Import fehlgeschlagen.', 'err');
        }
      });
      label.appendChild(input);
      actions.append(label);
    }

    actions.append(
      button('Uploads anzeigen', 'btn--primary', () => showSubmissions(portal.id, portal.title)),
      button('Löschen', 'btn--danger', async () => {
        if (!confirm(`Portal "${portal.title}" samt aller eingegangenen Uploads löschen?`)) return;
        try {
          await api.admin.deleteRequest(portal.id);
          forgetPortalKey(portal.id);
          toast('Portal gelöscht.', 'ok');
          renderPortals();
        } catch (err) {
          toast(err.message, 'err');
        }
      })
    );

    host.appendChild(card);
  }
}

function button(label, variant, onClick) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `btn btn--sm ${variant}`;
  el.textContent = label;
  el.addEventListener('click', onClick);
  return el;
}

async function showSubmissions(requestId, title) {
  let data;
  try {
    data = await api.admin.requestSubmissions(requestId);
  } catch (err) {
    toast(err.message, 'err');
    return;
  }

  const key = readPortalKey(requestId);
  const dialog = showModal({
    title: `Uploads in „${title}“`,
    subtitle: key
      ? 'Klick auf Öffnen entschlüsselt die Dateien in diesem Browser.'
      : 'Der Portal-Schlüssel ist in diesem Browser nicht vorhanden – die Uploads lassen sich hier nicht öffnen.',
    html: data.transfers.length
      ? `<div class="stack stack--sm">${data.transfers
          .map(
            (transfer) => `
        <div class="row row--between u-gap-3">
          <span>
            <strong class="mono">${escapeHtml(transfer.id)}</strong>
            <span class="tiny muted">${formatBytes(transfer.bytes)} · ${transfer.fileCount} Dateien ·
            ${formatRelative(transfer.createdAt)}</span>
          </span>
          ${
            key
              ? `<a class="btn btn--sm btn--primary" href="/t/${escapeHtml(transfer.id)}">Öffnen</a>`
              : `<span class="state-badge state-badge--warn">Schlüssel fehlt</span>`
          }
        </div>`
          )
          .join('')}</div>`
      : '<div class="empty">Noch keine Uploads eingegangen.</div>',
  });
  return dialog;
}

function exportPortalKey(requestId) {
  const key = readPortalKey(requestId);
  if (!key) {
    toast('Kein Schlüssel vorhanden, der exportiert werden könnte.', 'err');
    return;
  }
  const payload = JSON.stringify(
    {
      sharedrive: 'portal-key',
      requestId,
      public: key.public,
      private: key.private,
      exportedAt: new Date().toISOString(),
      warning:
        'Diese Datei enthält den privaten Schlüssel des Upload-Portals. Ohne ihn sind eingegangene Dateien nicht lesbar. Sicher aufbewahren und nicht weitergeben.',
    },
    null,
    2
  );
  const blob = new Blob([payload], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `sharedrive-portal-${requestId}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast('Schlüssel als Datei gespeichert. Bitte sicher ablegen.', 'ok', 7000);
}

/* =========================================================================
 * Erscheinungsbild
 * ========================================================================= */

function renderBranding(overview) {
  const brand = overview.branding || {};
  $('brand-name').value = brand.name || '';
  $('brand-tagline').value = brand.tagline || '';
  $('brand-theme').value = brand.theme || 'sunset';
  $('brand-logo').value = brand.logoUrl || '';
}

async function saveBranding() {
  try {
    const result = await api.admin.updateBranding({
      name: $('brand-name').value,
      tagline: $('brand-tagline').value,
      theme: $('brand-theme').value,
      logoUrl: $('brand-logo').value,
    });
    $('brand-hint').textContent = `Gespeichert um ${new Date().toLocaleTimeString('de-DE')}`;
    if (result.branding?.theme) {
      applyTheme(result.branding.theme, null);
      syncThemePills();
    }
    mountShell({ branding: result.branding, active: 'admin' });
    toast('Erscheinungsbild gespeichert.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* =========================================================================
 * Wartung
 * ========================================================================= */

function renderConfig(overview) {
  const rows = [
    ['Maximale Größe pro Transfer', formatBytes(overview.limits.maxTransferBytes)],
    ['Speicher-Quote', overview.limits.storageQuotaBytes ? formatBytes(overview.limits.storageQuotaBytes) : 'keine'],
    ['Standard-Ablauf', `${overview.limits.defaultExpiryHours} Stunden`],
    ['Maximaler Ablauf', `${overview.limits.maxExpiryHours} Stunden`],
    ['Aufbewahrung Zugriffslog', `${overview.limits.retentionDays} Tage`],
    ['Benachrichtigungen', overview.notifications.configured ? overview.notifications.type : 'nicht konfiguriert'],
    ['E-Mail-Versand', overview.smtp.configured ? 'SMTP eingerichtet' : 'nicht eingerichtet'],
    ['Reverse Proxy', overview.trustProxy ? 'aktiv (TRUST_PROXY=1)' : 'inaktiv'],
    ['Admin-Passwort', overview.adminPasswordSet ? 'gesetzt' : 'fehlt'],
  ];
  $('config-list').innerHTML = rows
    .map(
      ([label, value]) =>
        `<div class="summary__row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(String(value))}</dd></div>`
    )
    .join('');
}

async function runCleanup() {
  const notice = $('maintenance-result');
  notice.className = 'notice';
  notice.textContent = 'Aufräumen läuft …';
  try {
    const result = await api.admin.cleanup();
    notice.className = 'notice notice--ok';
    notice.textContent =
      `Fertig: ${result.result.transfers} abgelaufen, ${result.result.staleUploads} abgebrochen, ` +
      `${result.result.orphans} verwaiste Ordner entfernt. Belegt: ${formatBytes(result.disk.bytes)}.`;
    await renderTransfers();
  } catch (err) {
    notice.className = 'notice notice--err';
    notice.textContent = err.message;
  }
}

async function testNotification() {
  const notice = $('maintenance-result');
  notice.className = 'notice';
  notice.textContent = 'Test wird verschickt …';
  try {
    const result = await api.admin.notifyTest();
    if (result.result?.skipped) {
      notice.className = 'notice notice--warn';
      notice.textContent = `Nicht verschickt: ${result.result.reason}`;
    } else {
      notice.className = 'notice notice--ok';
      notice.textContent = `Test verschickt über ${result.result.via}.`;
    }
  } catch (err) {
    notice.className = 'notice notice--err';
    notice.textContent = err.message;
  }
}

init();
