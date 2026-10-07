/** Formatierung und kleine UI-Helfer, die alle Seiten benutzen. */

export function formatBytes(bytes, decimals = 1) {
  const n = Number(bytes) || 0;
  if (n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const value = n / 1024 ** i;
  const digits = i === 0 ? 0 : value >= 100 ? 0 : decimals;
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '–';
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ${m % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}

export function formatSpeed(bytesPerSecond) {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '–';
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatDate(ts, withTime = true) {
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '–';
  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  if (!withTime) return date;
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return `${date}, ${time}`;
}

export function formatRelative(ts) {
  const diff = Date.now() - Number(ts);
  if (!Number.isFinite(diff)) return '–';
  const abs = Math.abs(diff);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const past = diff >= 0;
  let text;
  if (abs < minute) text = 'gerade eben';
  else if (abs < hour) text = `${Math.round(abs / minute)} Min.`;
  else if (abs < day) text = `${Math.round(abs / hour)} Std.`;
  else text = `${Math.round(abs / day)} Tage`;
  if (text === 'gerade eben') return text;
  return past ? `vor ${text}` : `in ${text}`;
}

export function formatRemaining(expiresAt) {
  const diff = Number(expiresAt) - Date.now();
  if (!Number.isFinite(diff)) return '–';
  if (diff <= 0) return 'abgelaufen';
  const hours = diff / 3_600_000;
  if (hours < 1) return `noch ${Math.max(1, Math.round(diff / 60_000))} Minuten`;
  if (hours < 48) return `noch ${Math.round(hours)} Stunden`;
  return `noch ${Math.round(hours / 24)} Tage`;
}

export function shortId(id) {
  return String(id || '').replace(/[^a-z0-9]/gi, '').slice(0, 10);
}

export function iconForFile(name, type = '') {
  const ext = String(name).toLowerCase().split('.').pop();
  const kind = String(type).split('/')[0];
  if (kind === 'image' || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'svg'].includes(ext))
    return 'image';
  if (kind === 'video' || ['mp4', 'mov', 'mkv', 'webm', 'avi'].includes(ext)) return 'video';
  if (kind === 'audio' || ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz'].includes(ext)) return 'archive';
  if (['pdf'].includes(ext)) return 'pdf';
  if (['doc', 'docx', 'odt', 'rtf', 'txt', 'md'].includes(ext)) return 'doc';
  if (['xls', 'xlsx', 'ods', 'csv'].includes(ext)) return 'sheet';
  if (['ppt', 'pptx', 'odp'].includes(ext)) return 'slides';
  if (['js', 'ts', 'json', 'html', 'css', 'py', 'sh', 'yaml', 'yml', 'toml', 'xml'].includes(ext))
    return 'code';
  return 'file';
}

/** Erzeugt ein SVG-Icon (inline, ohne externe Abhaengigkeiten). */
export function fileIconSvg(kind) {
  const paths = {
    image:
      '<rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="2"/><path d="M4 18l4.5-4.5a2 2 0 0 1 2.8 0L15 17"/>',
    video: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9.5l5 2.5-5 2.5z"/>',
    audio:
      '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
    archive:
      '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 4v6m0 0l-2-2m2 2l2-2M12 13v3"/>',
    pdf: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
    doc: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M9 12h6M9 16h4"/>',
    sheet:
      '<rect x="4" y="3" width="16" height="18" rx="2"/><path d="M4 9h16M4 15h16M10 3v18"/>',
    slides: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M12 16v4m-3 0h6"/>',
    code: '<path d="M9 8l-4 4 4 4M15 8l4 4-4 4M13 5l-2 14"/>',
    file: '<path d="M7 3h7l5 5v13a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z"/><path d="M14 3v5h5"/>',
  };
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[kind] || paths.file}</svg>`;
}

/** Kurze Toast-Meldungen. */
export function toast(message, kind = 'info', timeout = 4200) {
  let host = document.getElementById('toast-host');
  if (!host) {
    host = document.createElement('div');
    host.id = 'toast-host';
    host.className = 'toast-host';
    host.setAttribute('role', 'status');
    host.setAttribute('aria-live', 'polite');
    document.body.appendChild(host);
  }
  const el = document.createElement('div');
  el.className = `toast toast--${kind}`;
  el.textContent = message;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add('is-visible'));
  setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => el.remove(), 300);
  }, timeout);
}

export async function copyToClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback fuer unsichere Kontexte (z. B. http im LAN)
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}
