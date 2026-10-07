/**
 * sharedrive - Kryptografie im Browser
 * ====================================
 *
 * Alle Verschluesselung passiert ausschliesslich hier, im Browser. Der Server
 * bekommt nur Chiffrate zu sehen - niemals Datei-Inhalte, niemals Dateinamen,
 * niemals die Nachricht an den Empfaenger und niemals den Schluessel.
 *
 * Schluesselmodell
 * ----------------
 *
 *   master       32 zufaellige Bytes. Liegt NUR im URL-Fragment (#k=...) und
 *                damit nie in einem HTTP-Request, Log oder Referer.
 *
 *   Datei-Schluessel
 *                HKDF-SHA256(master, info="file:<index>") -> AES-256-GCM.
 *                Ein eigener Schluessel pro Datei.
 *
 *   Chunk-IV     4 Nullbytes + 8 Byte Zaehler (Big Endian). Da jeder
 *                Datei-Schluessel nur einmal vorkommt, kann sich kein
 *                (Schluessel, IV)-Paar wiederholen - ein Nonce-Reuse-Fehler
 *                ist damit strukturell ausgeschlossen.
 *
 *   Metadaten    HKDF-SHA256(master, info="meta") -> AES-256-GCM mit
 *                zufaelligem IV. Enthaelt Dateinamen, Groessen, Typen und
 *                die Nachricht des Absenders.
 *
 *   Passwort     optional: PBKDF2-SHA256 (600.000 Runden) -> Schluessel, der
 *                den master-Schluessel umhüllt (wrap). Ohne richtiges Passwort
 *                ist der master-Schluessel nicht entpackbar.
 *
 * Dieser Code ist bewusst ohne Build-Schritt und ohne Abhaengigkeiten - er
 * laeuft unveraendert im Browser und (fuer die Tests) in Node.
 */

export const CRYPTO_VERSION = 1;
const subtle = globalThis.crypto.subtle;

export const TAG_BYTES = 16;
export const IV_BYTES = 12;
export const PBKDF2_ITERATIONS = 600000;

const enc = new TextEncoder();
const dec = new TextDecoder();

/* -------------------------------------------------------------------------
 * Kodierung
 * ---------------------------------------------------------------------- */

export function toB64u(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < view.length; i += step) {
    binary += String.fromCharCode(...view.subarray(i, i + step));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function utf8(text) {
  return enc.encode(text);
}

export function fromUtf8(bytes) {
  return dec.decode(bytes);
}

export function randomBytes(n) {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function concatBytes(...parts) {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/* -------------------------------------------------------------------------
 * Schluesselableitung
 * ---------------------------------------------------------------------- */

async function importMasterForHkdf(masterBytes) {
  return subtle.importKey('raw', masterBytes, 'HKDF', false, ['deriveKey', 'deriveBits']);
}

/** Leitet den AES-GCM-Schluessel einer Datei ab. */
export async function deriveFileKey(masterBytes, fileIdx) {
  const base = await importMasterForHkdf(masterBytes);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8('sharedrive/v1/aes-gcm'),
      info: utf8(`file:${fileIdx}`),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function deriveMetaKey(masterBytes) {
  const base = await importMasterForHkdf(masterBytes);
  return subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: utf8('sharedrive/v1/aes-gcm'),
      info: utf8('meta'),
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

function chunkIv(chunkIdx) {
  const iv = new Uint8Array(IV_BYTES);
  const view = new DataView(iv.buffer);
  view.setUint32(0, 0, false);
  view.setBigUint64(4, BigInt(chunkIdx), false);
  return iv;
}

/* -------------------------------------------------------------------------
 * Chunks ver- und entschluesseln
 * ---------------------------------------------------------------------- */

/** Verschluesselt einen Klartext-Chunk. Ergebnis ist 16 Byte laenger (GCM-Tag). */
export async function encryptChunk(fileKey, chunkIdx, plainBytes) {
  const buffer = await subtle.encrypt(
    { name: 'AES-GCM', iv: chunkIv(chunkIdx), tagLength: 128 },
    fileKey,
    plainBytes
  );
  return new Uint8Array(buffer);
}

/** Entschluesselt einen Chunk. Wirft, wenn das GCM-Tag nicht passt (Manipulation). */
export async function decryptChunk(fileKey, chunkIdx, cipherBytes) {
  const buffer = await subtle.decrypt(
    { name: 'AES-GCM', iv: chunkIv(chunkIdx), tagLength: 128 },
    fileKey,
    cipherBytes
  );
  return new Uint8Array(buffer);
}

/* -------------------------------------------------------------------------
 * Metadaten
 * ---------------------------------------------------------------------- */

/**
 * @param {Uint8Array} masterBytes
 * @param {object} payload  { message, files: [{ idx, name, size, type, lastModified, path }] }
 * @returns {Promise<string>} base64url(iv || ciphertext)
 */
export async function encryptMeta(masterBytes, payload) {
  const key = await deriveMetaKey(masterBytes);
  const iv = randomBytes(IV_BYTES);
  const cipher = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, utf8(JSON.stringify(payload)))
  );
  return toB64u(concatBytes(iv, cipher));
}

export async function decryptMeta(masterBytes, blob) {
  const raw = fromB64u(blob);
  if (raw.length < IV_BYTES + TAG_BYTES) throw new Error('Metadaten sind beschaedigt');
  const iv = raw.subarray(0, IV_BYTES);
  const cipher = raw.subarray(IV_BYTES);
  const key = await deriveMetaKey(masterBytes);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, cipher);
  return JSON.parse(fromUtf8(new Uint8Array(plain)));
}

/* -------------------------------------------------------------------------
 * Passwortschutz (umhuellt den master-Schluessel)
 * ---------------------------------------------------------------------- */

async function derivePasswordKey(password, salt) {
  const base = await subtle.importKey('raw', utf8(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    base,
    256
  );
  return new Uint8Array(bits);
}

/**
 * Erzeugt den Schluessel-Wrap fuer einen bestehenden master-Schluessel.
 * @returns {Promise<{salt: string, iv: string, ct: string}>}
 */
export async function wrapMasterKey(masterBytes, password) {
  const salt = randomBytes(16);
  const pwKey = await derivePasswordKey(password, salt);
  const wrappingKey = await subtle.importKey('raw', pwKey, 'AES-GCM', false, ['encrypt']);
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, wrappingKey, masterBytes)
  );
  return { salt: toB64u(salt), iv: toB64u(iv), ct: toB64u(ct), iterations: PBKDF2_ITERATIONS };
}

/**
 * Entpackt den master-Schluessel. Wirft bei falschem Passwort (GCM-Tag faellt).
 */
export async function unwrapMasterKey(keyWrap, password) {
  const salt = fromB64u(keyWrap.salt);
  const iv = fromB64u(keyWrap.iv);
  const ct = fromB64u(keyWrap.ct);
  const pwKey = await derivePasswordKey(password, salt);
  const wrappingKey = await subtle.importKey('raw', pwKey, 'AES-GCM', false, ['decrypt']);
  const plain = await subtle.decrypt({ name: 'AES-GCM', iv, tagLength: 128 }, wrappingKey, ct);
  return new Uint8Array(plain);
}

/* -------------------------------------------------------------------------
 * Reverse Share: Verschluesselung an den Eigentuemer (ECDH P-256)
 * -------------------------------------------------------------------------
 *
 * Damit kann jeder Uploader Dateien an den Portal-Eigentuemer schicken, ohne
 * dass untereinander mitgelesen werden kann und ohne dass der Server den
 * Schluessel kennt:
 *
 *   - Der Eigentuemer erzeugt ein Schluesselpaar. Der oeffentliche Teil steht
 *     im Link fuer die Uploader, der private Teil bleibt ausschliesslich im
 *     Browser des Eigentuemers.
 *   - Jeder Upload erzeugt ein eigenes, fluechtiges Schluesselpaar und leitet
 *     per ECDH einen gemeinsamen Schluessel ab. Dieser wird per HKDF zu einem
 *     master-Schluessel, mit dem die Dateien verschluesselt werden.
 *   - Der oeffentliche Teil des fluechtigen Schluessels wird im Klartext
 *     mitgeschickt - das ist ungefaehrlich, denn ohne den privaten Schluessel
 *     des Eigentuemers ist er wertlos.
 * ---------------------------------------------------------------------- */

const ECDH_CURVE = 'P-256';

async function hkdf(secretBytes, saltText, infoText) {
  const base = await subtle.importKey('raw', secretBytes, 'HKDF', false, ['deriveBits']);
  const bits = await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: utf8(saltText), info: utf8(infoText) },
    base,
    256
  );
  return new Uint8Array(bits);
}

/** Erzeugt das Schluesselpaar des Portal-Eigentuemers. */
export async function generateOwnerKeyPair() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: ECDH_CURVE }, true, [
    'deriveBits',
  ]);
  const publicRaw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const privatePkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', pair.privateKey));
  return { publicRaw, privatePkcs8 };
}

export async function importOwnerPublic(publicRaw) {
  return subtle.importKey('raw', publicRaw, { name: 'ECDH', namedCurve: ECDH_CURVE }, false, []);
}

export async function importOwnerPrivate(privatePkcs8) {
  return subtle.importKey(
    'pkcs8',
    privatePkcs8,
    { name: 'ECDH', namedCurve: ECDH_CURVE },
    false,
    ['deriveBits']
  );
}

/**
 * Uploader-Seite: erzeugt einen master-Schluessel, der nur dem Eigentuemer
 * zugaenglich ist.
 * @param {Uint8Array|string} ownerPublic  roher oeffentlicher Schluessel (oder base64url)
 * @returns {Promise<{master: Uint8Array, keyInfo: {eph: string, mode: string}}>}
 */
export async function sealForOwner(ownerPublic) {
  const raw = typeof ownerPublic === 'string' ? fromB64u(ownerPublic) : ownerPublic;
  const ephemeral = await subtle.generateKey({ name: 'ECDH', namedCurve: ECDH_CURVE }, true, [
    'deriveBits',
  ]);
  const ownerKey = await importOwnerPublic(raw);
  const secret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: ownerKey }, ephemeral.privateKey, 256)
  );
  const ephRaw = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));
  const master = await hkdf(secret, 'sharedrive/v1/ecdh', 'submission-key');
  return { master, keyInfo: { eph: toB64u(ephRaw) } };
}

/**
 * Eigentuemer-Seite: leitet denselben master-Schluessel aus dem fluechtigen
 * oeffentlichen Schluessel des Uploads ab.
 */
export async function openFromSubmitter(privateKey, ephBase64u) {
  const ephPublic = await importOwnerPublic(fromB64u(ephBase64u));
  const secret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: ephPublic }, privateKey, 256)
  );
  return hkdf(secret, 'sharedrive/v1/ecdh', 'submission-key');
}

/* -------------------------------------------------------------------------
 * Hilfsfunktionen fuer Anzeige und Download
 * ---------------------------------------------------------------------- */

/** Muss exakt zur Server-Validierung passen: sizeCipher = sizePlain + 16 * chunkCount */
export function cipherSizeFor(sizePlain, chunkSize) {
  const chunkCount = sizePlain === 0 ? 1 : Math.ceil(sizePlain / chunkSize);
  return { chunkCount, sizeCipher: sizePlain + TAG_BYTES * chunkCount };
}

export async function sha256Hex(bytes) {
  const digest = await subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Basis-URL des Servers, unabhaengig vom aktuellen Pfad. */
export function siteBase() {
  return `${location.origin}`;
}
