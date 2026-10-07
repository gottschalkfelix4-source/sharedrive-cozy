/**
 * QR-Code-Helfer. Nutzt die mitgelieferte Bibliothek
 * public/vendor/qrcode.js (MIT, Kazuhiko Arase) - sie wird als klassisches
 * Script geladen und stellt das globale `qrcode` bereit.
 */

/**
 * Erzeugt eine SVG-Darstellung des QR-Codes.
 * @param {string} text
 * @param {{scale?: number, margin?: number, dark?: string, light?: string}} [options]
 * @returns {string} SVG-Markup
 */
export function qrSvg(text, options = {}) {
  const { scale = 8, margin = 4, dark = '#1b1233', light = '#ffffff' } = options;
  if (typeof globalThis.qrcode !== 'function') {
    throw new Error('QR-Bibliothek nicht geladen');
  }
  // Fehlerkorrektur "M" reicht fuer Bildschirm-Scans und haelt den Code klein.
  const qr = globalThis.qrcode(0, 'M');
  qr.addData(text, 'Byte');
  qr.make();

  const count = qr.getModuleCount();
  const size = (count + margin * 2) * scale;
  const cells = [];
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (!qr.isDark(row, col)) continue;
      cells.push(
        `<rect x="${(col + margin) * scale}" y="${(row + margin) * scale}" width="${scale}" height="${scale}" rx="${scale * 0.22}"/>`
      );
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" ` +
    `shape-rendering="geometricPrecision" role="img" aria-label="QR-Code zum Teilen">` +
    `<rect width="${size}" height="${size}" fill="${light}"/>` +
    `<g fill="${dark}">${cells.join('')}</g></svg>`
  );
}

/** Rendert den QR-Code in ein bestehendes Element. */
export function renderQr(container, text, options) {
  container.innerHTML = qrSvg(text, options);
}

export function downloadQrPng(text, filename = 'qr-code.png', pixelSize = 640) {
  const svg = qrSvg(text, { scale: pixelSize / 40, margin: 2 });
  const blob = new Blob([svg], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = pixelSize;
    canvas.height = pixelSize;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.drawImage(img, 0, 0, pixelSize, pixelSize);
    URL.revokeObjectURL(url);
    canvas.toBlob((pngBlob) => {
      if (!pngBlob) return;
      const pngUrl = URL.createObjectURL(pngBlob);
      const a = document.createElement('a');
      a.href = pngUrl;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(pngUrl), 5000);
    }, 'image/png');
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}
