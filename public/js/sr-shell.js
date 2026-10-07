/**
 * Gemeinsame Seitenbestandteile: Kopfzeile, Branding, Themenauswahl, Fusszeile.
 * Wird von allen Seiten benutzt, damit Farbschema und Marke einheitlich sind.
 */

import { toast } from './sr-format.js';

export const THEMES = [
  { id: 'sunset', label: 'Sonnenuntergang' },
  { id: 'mint', label: 'Minze' },
  { id: 'lavender', label: 'Lavendel' },
  { id: 'ocean', label: 'Ozean' },
];

const LOGO = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6.5 10.5L12 5l5.5 5.5"/><path d="M5 19h14"/></svg>`;

export function storedTheme() {
  try {
    return {
      theme: localStorage.getItem('sharedrive.theme'),
      mode: localStorage.getItem('sharedrive.mode'),
    };
  } catch {
    return { theme: null, mode: null };
  }
}

export function applyTheme(theme, mode) {
  const root = document.documentElement;
  if (theme) {
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem('sharedrive.theme', theme);
    } catch {
      /* ignorieren */
    }
  }
  if (mode) {
    root.setAttribute('data-mode', mode);
    try {
      localStorage.setItem('sharedrive.mode', mode);
    } catch {
      /* ignorieren */
    }
  }
}

export function currentMode() {
  const stored = storedTheme().mode;
  if (stored) return stored;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/**
 * Baut Kopfzeile, Themen-Dialog und Fusszeile auf und setzt das Branding.
 * @param {{branding?: {name: string, tagline: string, theme: string, logoUrl?: string}, active?: string, showAdminLink?: boolean}} options
 */
export function mountShell(options = {}) {
  const branding = options.branding || { name: 'sharedrive', tagline: '' };
  const active = options.active || '';

  if (branding.theme && !storedTheme().theme) applyTheme(branding.theme, null);

  const header = document.querySelector('[data-shell="header"]');
  if (header) {
    header.className = 'topbar';
    header.innerHTML = `
      <a class="brand" href="/">
        <span class="brand__mark">${LOGO}</span>
        <span class="brand__text">
          <span class="brand__name">${escapeText(branding.name)}</span>
          <span class="brand__tag">${escapeText(branding.tagline || '')}</span>
        </span>
      </a>
      <div class="topbar__actions">
        ${navLink('/', 'Senden', active === 'send')}
        ${navLink('/admin', 'Dashboard', active === 'admin')}
        <button type="button" class="btn btn--icon btn--quiet" id="btn-theme" title="Darstellung" aria-label="Darstellung anpassen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18 4.5 4.5 0 0 1 0-9 4.5 4.5 0 0 0 0-9z"/></svg>
        </button>
      </div>`;
    header.querySelector('#btn-theme')?.addEventListener('click', openThemeDialog);
  }

  // Themenauswahl-Dialog (nur einmal einfuegen)
  if (!document.getElementById('theme-dialog')) {
    const dialog = document.createElement('dialog');
    dialog.className = 'modal';
    dialog.id = 'theme-dialog';
    dialog.innerHTML = `
      <div class="modal__panel">
        <div class="modal__head">
          <div>
            <h2>Darstellung</h2>
            <p class="card__sub">Farben und Helligkeit gelten nur in diesem Browser.</p>
          </div>
          <button type="button" class="btn btn--icon btn--quiet" data-close aria-label="Schliessen">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="stack">
          <div class="field">
            <span class="field__label">Farbwelt</span>
            <div class="pills" id="theme-pills">
              ${THEMES.map(
                (t) =>
                  `<button type="button" class="pill" data-theme-id="${t.id}">${t.label}</button>`
              ).join('')}
            </div>
          </div>
          <div class="field">
            <span class="field__label">Helligkeit</span>
            <div class="pills" id="mode-pills">
              <button type="button" class="pill" data-mode-id="light">Hell</button>
              <button type="button" class="pill" data-mode-id="dark">Dunkel</button>
            </div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(dialog);

    dialog.querySelectorAll('[data-close]').forEach((btn) =>
      btn.addEventListener('click', () => dialog.close())
    );
    dialog.querySelectorAll('[data-theme-id]').forEach((btn) =>
      btn.addEventListener('click', () => {
        applyTheme(btn.dataset.themeId, null);
        syncThemePills();
      })
    );
    dialog.querySelectorAll('[data-mode-id]').forEach((btn) =>
      btn.addEventListener('click', () => {
        applyTheme(null, btn.dataset.modeId);
        syncThemePills();
      })
    );
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
  }

  const footer = document.querySelector('[data-shell="footer"]');
  if (footer) {
    footer.className = 'footer';
    footer.innerHTML = `
      <span>
        Ende-zu-Ende-verschluesselt &middot; der Schluessel liegt nur in deinem Link
      </span>
      <span class="row u-gap-4">
        <a href="/impressum">Rechtliches</a>
        <a href="/datenschutz">Datenschutz</a>
        <a href="/admin">Verwaltung</a>
      </span>`;
  }

  syncThemePills();
  return branding;
}

function navLink(href, label, isActive) {
  return `<a class="btn btn--sm ${isActive ? 'btn--primary' : 'btn--quiet'}" href="${href}">${label}</a>`;
}

export function syncThemePills() {
  const dialog = document.getElementById('theme-dialog');
  if (!dialog) return;
  const theme = document.documentElement.getAttribute('data-theme');
  const mode = document.documentElement.getAttribute('data-mode') || currentMode();
  dialog.querySelectorAll('[data-theme-id]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.themeId === theme);
  });
  dialog.querySelectorAll('[data-mode-id]').forEach((btn) => {
    btn.classList.toggle('is-active', btn.dataset.modeId === mode);
  });
}

export function openThemeDialog() {
  const dialog = document.getElementById('theme-dialog');
  if (!dialog) return;
  syncThemePills();
  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
}

/** Kleiner Modal-Dialog mit beliebigem Inhalt. */
export function showModal({ title, subtitle, html, actions = [] }) {
  const existing = document.getElementById('generic-modal');
  if (existing) existing.remove();

  const dialog = document.createElement('dialog');
  dialog.className = 'modal';
  dialog.id = 'generic-modal';
  dialog.innerHTML = `
    <div class="modal__panel">
      <div class="modal__head">
        <div>
          <h2>${escapeText(title)}</h2>
          ${subtitle ? `<p class="card__sub">${escapeText(subtitle)}</p>` : ''}
        </div>
        <button type="button" class="btn btn--icon btn--quiet" data-close aria-label="Schliessen">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </div>
      <div class="modal__body stack">${html || ''}</div>
    </div>`;
  document.body.appendChild(dialog);

  dialog.querySelectorAll('[data-close]').forEach((btn) =>
    btn.addEventListener('click', () => dialog.close())
  );
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  dialog.addEventListener('close', () => {
    dialog.querySelectorAll('[data-autofocus]')?.forEach?.((el) => el.blur());
  });

  for (const action of actions) {
    const host = dialog.querySelector('.modal__body');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn ${action.variant === 'primary' ? 'btn--primary' : 'btn--quiet'}`;
    btn.textContent = action.label;
    btn.addEventListener('click', () => action.onClick?.(dialog));
    host?.appendChild(btn);
  }

  if (typeof dialog.showModal === 'function') dialog.showModal();
  else dialog.setAttribute('open', '');
  return dialog;
}

export function escapeText(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

/** Umgebungshinweis: http im LAN erlaubt keine starke Krypto in manchen Browsern. */
export function checkSecureContext() {
  const isLocal =
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1' ||
    location.hostname === '[::1]';
  if (location.protocol !== 'https:' && !isLocal) {
    console.warn(
      '[sharedrive] Kein sicherer Kontext: WebCrypto steht auf http nur in Ausnahmen bereit.'
    );
    return false;
  }
  return true;
}

export function requireCrypto() {
  if (!globalThis.crypto?.subtle) {
    toast(
      'Dieser Browser stellt die Verschluesselung nur ueber HTTPS bereit. Bitte die Seite ueber https:// oeffnen.',
      'err',
      9000
    );
    return false;
  }
  return true;
}
