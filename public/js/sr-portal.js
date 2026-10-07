/**
 * Lokale Schluesselablage fuer Upload-Portale (Reverse Share).
 *
 * Der private Schluessel eines Portals verlaesst den Browser des Eigentuemers
 * nie - er liegt ausschliesslich hier im localStorage. Das ist bewusst so:
 * gaebe man ihn an den Server, waere die Ende-zu-Ende-Verschluesselung hin.
 *
 * Folge: Wird der Browserspeicher geloescht, koennen bereits eingegangene
 * Uploads nicht mehr geoeffnet werden. Das Dashboard erinnert daran und bietet
 * einen Export des Schluessels an.
 */

import { toB64u } from './sr-crypto.js';

export const PORTAL_KEY_PREFIX = 'sharedrive.portal.';

export function readPortalKey(requestId) {
  if (!requestId) return null;
  try {
    const raw = localStorage.getItem(PORTAL_KEY_PREFIX + requestId);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed?.public || !parsed?.private) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function savePortalKey(requestId, { public: publicKey, private: privateKey }) {
  try {
    localStorage.setItem(
      PORTAL_KEY_PREFIX + requestId,
      JSON.stringify({ public: publicKey, private: privateKey, savedAt: Date.now() })
    );
    return true;
  } catch {
    return false;
  }
}

export function forgetPortalKey(requestId) {
  try {
    localStorage.removeItem(PORTAL_KEY_PREFIX + requestId);
  } catch {
    /* ignorieren */
  }
}

export function portalShareUrl(requestId, ownerPublicRaw) {
  const value = typeof ownerPublicRaw === 'string' ? ownerPublicRaw : toB64u(ownerPublicRaw);
  return `${location.origin}/r/${requestId}#p=${value}`;
}

/** Laedt einen exportierten Schluessel wieder in den Speicher. */
export function importPortalKeyFile(requestId, text) {
  const parsed = JSON.parse(text);
  if (!parsed?.public || !parsed?.private) throw new Error('Datei enthält keinen gültigen Schlüssel');
  savePortalKey(requestId, parsed);
  return parsed;
}
