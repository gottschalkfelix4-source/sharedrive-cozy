import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  cipherSizeFor,
  decryptChunk,
  decryptMeta,
  deriveFileKey,
  encryptChunk,
  encryptMeta,
  fromB64u,
  generateOwnerKeyPair,
  importOwnerPrivate,
  openFromSubmitter,
  randomBytes,
  sealForOwner,
  TAG_BYTES,
  toB64u,
  unwrapMasterKey,
  wrapMasterKey,
} from '../public/js/sr-crypto.js';

/** Zufaellige Klartextdaten in der gewuenschten Groesse. */
function randomPlain(bytes) {
  return new Uint8Array(crypto.randomBytes(bytes));
}

test('Base64url-Kodierung ist verlustfrei, auch bei Sonderzeichen', () => {
  const samples = [
    new Uint8Array([]),
    new Uint8Array([0, 1, 2, 253, 254, 255]),
    randomBytes(1000),
    new TextEncoder().encode('Grüße aus München – 100 % sicher 🎉'),
  ];
  for (const sample of samples) {
    const encoded = toB64u(sample);
    assert.match(encoded, /^[A-Za-z0-9_-]*$/, 'darf nur URL-sichere Zeichen enthalten');
    assert.deepEqual(fromB64u(encoded), sample);
  }
});

test('Chunk-Groessen stimmen mit der Server-Validierung ueberein', () => {
  const chunkSize = 4 * 1024 * 1024;
  const cases = [
    [0, 1],
    [1, 1],
    [chunkSize, 1],
    [chunkSize + 1, 2],
    [chunkSize * 3, 3],
    [chunkSize * 3 + 12345, 4],
  ];
  for (const [sizePlain, expectedChunks] of cases) {
    const { chunkCount, sizeCipher } = cipherSizeFor(sizePlain, chunkSize);
    assert.equal(chunkCount, expectedChunks, `Chunk-Anzahl fuer ${sizePlain} Bytes`);
    // exakt die Regel, die der Server prueft:
    assert.equal(sizeCipher, sizePlain + TAG_BYTES * chunkCount);
  }
});

test('Chunks lassen sich ver- und entschluesseln', async () => {
  const master = randomBytes(32);
  const key = await deriveFileKey(master, 0);

  for (const size of [0, 1, 1024, 128 * 1024]) {
    const plain = randomPlain(size);
    const cipher = await encryptChunk(key, 5, plain);
    assert.equal(cipher.length, size + TAG_BYTES, 'GCM-Tag wird angehaengt');
    const back = await decryptChunk(key, 5, cipher);
    assert.deepEqual(back, plain, `Rundlauf fuer ${size} Bytes`);
  }
});

test('Manipulierte Chunks und falsche Indizes werden erkannt', async () => {
  const master = randomBytes(32);
  const key = await deriveFileKey(master, 0);
  const plain = randomPlain(2048);
  const cipher = await encryptChunk(key, 0, plain);

  const tampered = cipher.slice();
  tampered[10] ^= 0x01;
  await assert.rejects(() => decryptChunk(key, 0, tampered), /operation failed|error/i);

  // Falscher Chunk-Index -> anderer IV -> Tag passt nicht
  await assert.rejects(() => decryptChunk(key, 1, cipher), /operation failed|error/i);
});

test('Jede Datei und jeder Transfer bekommt einen eigenen Schluessel', async () => {
  const masterA = randomBytes(32);
  const masterB = randomBytes(32);
  const plain = randomPlain(512);

  const keyA0 = await deriveFileKey(masterA, 0);
  const keyA1 = await deriveFileKey(masterA, 1);
  const keyB0 = await deriveFileKey(masterB, 0);

  const cipherA0 = await encryptChunk(keyA0, 0, plain);
  await assert.rejects(() => decryptChunk(keyA1, 0, cipherA0));
  await assert.rejects(() => decryptChunk(keyB0, 0, cipherA0));
  assert.deepEqual(await decryptChunk(keyA0, 0, cipherA0), plain);
});

test('Metadaten mit Umlauten und Ordnernamen bleiben unversehrt - und lesbar fuer den Server nicht', async () => {
  const master = randomBytes(32);
  const payload = {
    v: 1,
    message: 'Bitte nicht weitergeben – Grüße, Felix',
    createdAt: Date.now(),
    files: [
      { idx: 0, name: 'Urlaub am Königssee.jpg', path: 'Fotos/2026/Urlaub am Königssee.jpg', size: 123456, type: 'image/jpeg' },
      { idx: 1, name: 'Notizen.txt', path: 'Notizen.txt', size: 42, type: 'text/plain' },
    ],
  };

  const blob = await encryptMeta(master, payload);
  // Der Server sieht nur diesen Block - kein Klartext darf enthalten sein.
  const raw = Buffer.from(fromB64u(blob)).toString('binary');
  assert.ok(!raw.includes('Urlaub'), 'Dateiname darf nicht im Klartext vorkommen');
  assert.ok(!raw.includes('Felix'), 'Nachricht darf nicht im Klartext vorkommen');

  const back = await decryptMeta(master, blob);
  assert.deepEqual(back, payload);

  await assert.rejects(() => decryptMeta(randomBytes(32), blob));
});

test('Passwortschutz: nur das richtige Passwort entpackt den Schluessel', async () => {
  const master = randomBytes(32);
  const wrap = await wrapMasterKey(master, 'ein-sehr-gutes-passwort');

  assert.equal(typeof wrap.salt, 'string');
  assert.equal(wrap.iterations >= 100000, true, 'KDF muss teuer genug sein');

  const unwrapped = await unwrapMasterKey(wrap, 'ein-sehr-gutes-passwort');
  assert.deepEqual(unwrapped, master);

  await assert.rejects(() => unwrapMasterKey(wrap, 'falsches-passwort'));
  await assert.rejects(() => unwrapMasterKey(wrap, 'ein-sehr-gutes-passwor'));
});

test('Jede Passworteingabe erzeugt einen eigenen Salt', async () => {
  const master = randomBytes(32);
  const a = await wrapMasterKey(master, 'gleiches-passwort');
  const b = await wrapMasterKey(master, 'gleiches-passwort');
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.ct, b.ct, 'gleicher Klartext darf nicht dasselbe Chiffrat ergeben');
});

test('Reverse Share: nur der Eigentuemer kann Uploads oeffnen', async () => {
  const owner = await generateOwnerKeyPair();
  const privateKey = await importOwnerPrivate(owner.privatePkcs8);

  const first = await sealForOwner(owner.publicRaw);
  const second = await sealForOwner(owner.publicRaw);

  assert.notDeepEqual(first.master, second.master, 'jeder Upload bekommt einen eigenen Schluessel');

  const opened = await openFromSubmitter(privateKey, first.keyInfo.eph);
  assert.deepEqual(opened, first.master, 'Eigentuemer leitet denselben Schluessel ab');

  // Ein anderer Uploader-Schluessel passt nicht zu diesem Upload
  const otherOwner = await generateOwnerKeyPair();
  const otherPrivate = await importOwnerPrivate(otherOwner.privatePkcs8);
  const wrong = await openFromSubmitter(otherPrivate, first.keyInfo.eph);
  assert.notDeepEqual(wrong, first.master);

  // Und mit dem falschen Schluessel laesst sich nichts entschluesseln
  const plain = randomPlain(256);
  const key = await deriveFileKey(first.master, 0);
  const cipher = await encryptChunk(key, 0, plain);
  const wrongKey = await deriveFileKey(wrong, 0);
  await assert.rejects(() => decryptChunk(wrongKey, 0, cipher));
});

test('Reverse Share: oeffentlicher Schluessel allein genuegt nicht', async () => {
  const owner = await generateOwnerKeyPair();
  const submission = await sealForOwner(owner.publicRaw);
  // Wer nur den oeffentlichen Schluessel hat, kann den Upload nicht aufschliessen:
  // es fehlt der private Schluessel des Eigentuemers.
  const attacker = await generateOwnerKeyPair();
  const attackerPrivate = await importOwnerPrivate(attacker.privatePkcs8);
  const guess = await openFromSubmitter(attackerPrivate, submission.keyInfo.eph);
  assert.notDeepEqual(guess, submission.master);
});
