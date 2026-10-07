/**
 * Gemeinsame Bausteine fuer die Sende-Seite und das Upload-Portal:
 * Dateiauswahl (inkl. Ordner per Drag&Drop) und die Fortschrittsanzeige.
 */

import { escapeHtml, fileIconSvg, formatBytes, formatDuration, formatSpeed, iconForFile, toast } from './sr-format.js';

/** Liest per Drag&Drop auch ganze Ordner rekursiv aus. */
export async function collectFromDataTransfer(dataTransfer) {
  const items = dataTransfer.items ? Array.from(dataTransfer.items) : [];
  const entries = items.map((item) => item.webkitGetAsEntry?.()).filter(Boolean);

  if (!entries.length) {
    return Array.from(dataTransfer.files || []).map((file) => ({ file, relPath: file.name }));
  }

  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      out.push({ file, relPath: prefix + file.name });
      return;
    }
    if (entry.isDirectory) {
      const reader = entry.createReader();
      const readBatch = () => new Promise((resolve, reject) => reader.readEntries(resolve, reject));
      let batch = await readBatch();
      while (batch.length) {
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
        batch = await readBatch();
      }
    }
  };

  for (const entry of entries) await walk(entry, '');
  return out;
}

export class FilePicker {
  /**
   * @param {{dropzone: HTMLElement, fileInput: HTMLInputElement, folderInput?: HTMLInputElement, maxFiles?: number, onChange: () => void}} options
   */
  constructor({ dropzone, fileInput, folderInput, maxFiles = 2000, onChange }) {
    this.dropzone = dropzone;
    this.fileInput = fileInput;
    this.folderInput = folderInput;
    this.maxFiles = maxFiles;
    this.onChange = onChange || (() => {});
    this.selection = [];
    this._wire();
  }

  _wire() {
    const { dropzone, fileInput, folderInput } = this;

    dropzone.addEventListener('click', (event) => {
      if (event.target.closest('[data-folder-button]')) return;
      fileInput.click();
    });

    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        fileInput.click();
      }
    });

    dropzone.querySelector('[data-folder-button]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      folderInput?.click();
    });

    const absorb = (input) => (event) => {
      void event;
      this.add(
        Array.from(input.files || []).map((file) => ({
          file,
          relPath: file.webkitRelativePath || file.name,
        }))
      );
      input.value = '';
    };
    fileInput.addEventListener('change', absorb(fileInput));
    folderInput?.addEventListener('change', absorb(folderInput));

    let dragDepth = 0;
    window.addEventListener('dragenter', (event) => {
      if (!event.dataTransfer?.types?.includes('Files')) return;
      dragDepth++;
      dropzone.classList.add('is-dragging');
    });
    window.addEventListener('dragover', (event) => {
      if (event.dataTransfer?.types?.includes('Files')) event.preventDefault();
    });
    window.addEventListener('dragleave', () => {
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) dropzone.classList.remove('is-dragging');
    });
    window.addEventListener('drop', async (event) => {
      if (!event.dataTransfer) return;
      event.preventDefault();
      dragDepth = 0;
      dropzone.classList.remove('is-dragging');
      try {
        const collected = await collectFromDataTransfer(event.dataTransfer);
        if (collected.length) this.add(collected);
      } catch (err) {
        toast(`Ordner konnte nicht gelesen werden: ${err.message}`, 'err');
      }
    });
  }

  add(entries) {
    let skipped = 0;
    for (const { file, relPath } of entries) {
      if (this.selection.length >= this.maxFiles) {
        skipped++;
        continue;
      }
      const path = relPath || file.name;
      const duplicate = this.selection.some(
        (item) =>
          item.relPath === path &&
          item.file.size === file.size &&
          item.file.lastModified === file.lastModified
      );
      if (duplicate) continue;
      this.selection.push({ file, relPath: path });
    }
    if (skipped) toast(`Maximal ${this.maxFiles} Dateien pro Transfer.`, 'err');
    this.selection.sort((a, b) => a.relPath.localeCompare(b.relPath, 'de'));
    this.onChange();
  }

  remove(index) {
    this.selection.splice(index, 1);
    this.onChange();
  }

  clear() {
    this.selection = [];
    this.onChange();
  }

  get totalBytes() {
    return this.selection.reduce((sum, item) => sum + item.file.size, 0);
  }

  get files() {
    return this.selection.map((item) => item.file);
  }
}

/**
 * Zeichnet die Auswahlliste. Gibt zurueck, ob der Upload erlaubt ist.
 */
export function renderSelection({ nodes, picker, maxTransferBytes }) {
  const { selectionEl, summaryEl, listEl, hintEl } = nodes;
  const total = picker.totalBytes;

  if (!picker.selection.length) {
    selectionEl.classList.add('hidden');
    listEl.innerHTML = '';
    if (hintEl) hintEl.textContent = '';
    return { allowed: false, total, tooBig: false };
  }

  selectionEl.classList.remove('hidden');
  summaryEl.textContent = `${picker.selection.length} ${
    picker.selection.length === 1 ? 'Datei' : 'Dateien'
  } · ${formatBytes(total)}`;

  const tooBig = maxTransferBytes ? total > maxTransferBytes : false;
  if (hintEl) {
    hintEl.textContent = tooBig
      ? `Zu groß: maximal ${formatBytes(maxTransferBytes)} pro Transfer.`
      : `Maximal ${formatBytes(maxTransferBytes)} pro Transfer.`;
    hintEl.style.color = tooBig ? 'var(--err)' : '';
  }

  listEl.innerHTML = '';
  picker.selection.forEach((item, index) => {
    const row = document.createElement('div');
    row.className = 'file-row';
    row.innerHTML = `
      <span class="file-row__icon">${fileIconSvg(iconForFile(item.file.name, item.file.type))}</span>
      <span class="file-row__body">
        <span class="file-row__name">${escapeHtml(item.file.name)}</span>
        <span class="file-row__meta">
          <span>${formatBytes(item.file.size)}</span>
          ${
            item.relPath !== item.file.name
              ? `<span class="file-row__path">${escapeHtml(item.relPath)}</span>`
              : ''
          }
        </span>
      </span>
      <button type="button" class="btn btn--icon btn--quiet" aria-label="Datei entfernen">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>`;
    row.querySelector('button').addEventListener('click', () => picker.remove(index));
    listEl.appendChild(row);
  });

  return { allowed: !tooBig, total, tooBig };
}

const FILE_GLYPH =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/></svg>';

/** Aktualisiert die Fortschrittsansicht (Ring, Kennzahlen, Dateiliste). */
export function renderProgress(nodes, snapshot) {
  const { ringEl, ringLabelEl, transferredEl, speedEl, etaEl, stateEl, filesEl, titleEl, subEl } = nodes;

  if (ringEl) ringEl.style.setProperty('--value', String(snapshot.progress));
  if (ringLabelEl) ringLabelEl.textContent = `${Math.round(snapshot.progress * 100)} %`;
  if (transferredEl) {
    transferredEl.textContent = `${formatBytes(snapshot.sentBytes)} von ${formatBytes(snapshot.totalBytes)}`;
  }
  if (speedEl) speedEl.textContent = formatSpeed(snapshot.speed);
  if (etaEl) etaEl.textContent = snapshot.state === 'done' ? 'fertig' : formatDuration(snapshot.eta);

  if (stateEl) {
    const map = {
      creating: ['wird vorbereitet', ''],
      uploading: ['läuft', ''],
      paused: ['pausiert', 'state-badge--warn'],
      finalizing: ['wird abgeschlossen', ''],
      done: ['fertig', 'state-badge--ok'],
      error: ['Fehler', 'state-badge--err'],
      canceled: ['abgebrochen', 'state-badge--warn'],
    };
    const [label, modifier] = map[snapshot.state] || ['läuft', ''];
    stateEl.textContent = label;
    stateEl.className = `state-badge ${modifier}`.trim();
  }

  if (titleEl && snapshot.state === 'error') {
    titleEl.textContent = 'Upload fehlgeschlagen';
    if (subEl) subEl.textContent = snapshot.error || 'Unbekannter Fehler';
  }

  if (!filesEl) return;
  if (filesEl.children.length !== snapshot.files.length) {
    filesEl.innerHTML = snapshot.files
      .map(
        (file) => `
        <div class="file-row">
          <span class="file-row__icon">${FILE_GLYPH}</span>
          <span class="file-row__body">
            <span class="file-row__name">${escapeHtml(file.name)}</span>
            <span class="progress progress--thin"><span class="progress__fill" data-bar></span></span>
          </span>
          <span class="tiny muted u-progress-label" data-label></span>
        </div>`
      )
      .join('');
  }

  Array.from(filesEl.children).forEach((row, index) => {
    const file = snapshot.files[index];
    if (!file) return;
    row.querySelector('[data-bar]').style.width = `${Math.round(file.progress * 100)}%`;
    row.querySelector('[data-label]').textContent = file.done
      ? 'fertig'
      : `${Math.round(file.progress * 100)} %`;
  });
}

/** Zeigt genau eine der Ansichten. */
export function showView(names, active) {
  for (const name of names) {
    document.getElementById(`view-${name}`)?.classList.toggle('hidden', name !== active);
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/** Verdrahtet Pause/Abbrechen und warnt beim Verlassen waehrend des Uploads. */
export function wireUploadControls({ pauseButton, abortButton, getSession, onAborted }) {
  pauseButton?.addEventListener('click', () => {
    const session = getSession();
    if (!session) return;
    if (session.paused) {
      session.resume();
      pauseButton.textContent = 'Pause';
    } else {
      session.pause();
      pauseButton.textContent = 'Fortsetzen';
    }
  });

  abortButton?.addEventListener('click', async () => {
    const session = getSession();
    if (!session) return;
    if (!confirm('Upload wirklich abbrechen? Der Transfer wird verworfen.')) return;
    await session.cancel();
    onAborted?.();
  });

  window.addEventListener('beforeunload', (event) => {
    const session = getSession();
    if (session && (session.state === 'uploading' || session.state === 'creating') && !session.paused) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}
