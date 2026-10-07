import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  cipherSizeFor,
  decryptChunk,
  decryptMeta,
  deriveFileKey,
  encryptChunk,
  encryptMeta,
  generateOwnerKeyPair,
  importOwnerPrivate,
  openFromSubmitter,
  randomBytes,
  sealForOwner,
  toB64u,
  unwrapMasterKey,
  wrapMasterKey,
} from '../public/js/sr-crypto.js';

const CHUNK_SIZE = 256 * 1024;
const ADMIN_PASSWORD = 'ein-langes-test-passwort';

let child;
let base;
let dataDir;
let client;

/* -------------------------------------------------------------------------
 * Testumgebung
 * ---------------------------------------------------------------------- */

function startClient(baseUrl) {
  const cookies = new Map();
  return {
    cookies,
    async request(method, urlPath, { json, headers = {}, body } = {}) {
      const finalHeaders = { ...headers };
      if (cookies.size) {
        finalHeaders.cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join('; ');
      }
      let payload = body;
      if (json !== undefined) {
        finalHeaders['content-type'] = 'application/json';
        payload = JSON.stringify(json);
      }
      const res = await fetch(baseUrl + urlPath, {
        method,
        headers: finalHeaders,
        body: payload,
        redirect: 'manual',
      });
      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const pair = raw.split(';')[0];
        const eq = pair.indexOf('=');
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return res;
    },
    async json(method, urlPath, options) {
      const res = await this.request(method, urlPath, options);
      const text = await res.text();
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      return { status: res.status, body: parsed, text, res };
    },
  };
}

async function waitForHealth(url, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`);
      if (res.ok) return true;
    } catch {
      /* Server startet noch */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Server ist nicht rechtzeitig gestartet');
}

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sharedrive-test-'));
  const port = 3400 + Math.floor(Math.random() * 400);
  base = `http://127.0.0.1:${port}`;

  child = spawn(process.execPath, ['server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      DATA_DIR: dataDir,
      ADMIN_PASSWORD,
      SESSION_SECRET: 'test-secret-fuer-integrationstests',
      INSTANCE_NAME: 'sharedrive-test',
      MAX_TRANSFER_BYTES: String(64 * 1024 * 1024),
      DEFAULT_EXPIRY_HOURS: '2',
      MAX_EXPIRY_HOURS: '48',
      NODE_ENV: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stderr.on('data', (chunk) => {
    const text = String(chunk);
    if (!text.includes('HINWEIS') && !text.includes('WARNUNG')) {
      process.stderr.write(`[server] ${text}`);
    }
  });

  await waitForHealth(base);
  client = startClient(base);
});

after(async () => {
  if (child) {
    child.kill('SIGTERM');
    await new Promise((resolve) => {
      child.once('exit', resolve);
      setTimeout(resolve, 4000);
    });
  }
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* Windows kann Dateien kurz sperren */
  }
});

/* -------------------------------------------------------------------------
 * Hilfsfunktionen
 * ---------------------------------------------------------------------- */

function makePlain(bytes) {
  return new Uint8Array(crypto.randomBytes(bytes));
}

/** Legt einen Transfer an und laedt alle Chunks wirklich verschluesselt hoch. */
async function uploadTransfer({ files, keyMode = 'link', keyWrap = null, master, extra = {} }) {
  const descriptors = files.map((file, idx) => {
    const { chunkCount, sizeCipher } = cipherSizeFor(file.bytes.length, CHUNK_SIZE);
    return { idx, chunkCount, sizeCipher, sizePlain: file.bytes.length };
  });

  const meta = await encryptMeta(master, {
    v: 1,
    message: extra.message || '',
    files: files.map((file, idx) => ({
      idx,
      name: file.name,
      path: file.path || file.name,
      size: file.bytes.length,
      type: file.type || 'application/octet-stream',
      lastModified: Date.now(),
    })),
  });

  const created = await client.json('POST', '/api/transfers', {
    json: {
      meta,
      keyMode,
      keyWrap,
      expiresInHours: extra.expiresInHours ?? 2,
      maxDownloads: extra.maxDownloads ?? 0,
      notify: false,
      requestId: extra.requestId,
      requestPassword: extra.requestPassword,
      files: descriptors.map((d) => ({
        sizePlain: d.sizePlain,
        sizeCipher: d.sizeCipher,
        chunkCount: d.chunkCount,
        chunkSize: CHUNK_SIZE,
      })),
    },
  });
  assert.equal(created.status, 201, `Transfer anlegen: ${created.text}`);

  const { id, uploadToken } = created.body;

  for (const descriptor of descriptors) {
    const file = files[descriptor.idx];
    const key = await deriveFileKey(master, descriptor.idx);
    for (let c = 0; c < descriptor.chunkCount; c++) {
      const start = c * CHUNK_SIZE;
      const plain = file.bytes.subarray(start, Math.min(file.bytes.length, start + CHUNK_SIZE));
      const cipher = await encryptChunk(key, c, plain);
      const res = await client.request(
        'PUT',
        `/api/transfers/${id}/chunks/${descriptor.idx}/${c}?t=${encodeURIComponent(uploadToken)}`,
        { body: cipher, headers: { 'content-type': 'application/octet-stream' } }
      );
      assert.equal(res.status, 200, `Chunk ${descriptor.idx}/${c} hochladen`);
    }
  }

  if (extra.complete !== false) {
    const done = await client.json(
      'POST',
      `/api/transfers/${id}/complete?t=${encodeURIComponent(uploadToken)}`
    );
    assert.equal(done.status, 200, `Transfer abschliessen: ${done.text}`);
  }
  return { id, uploadToken, descriptors, meta };
}

async function downloadAndDecrypt(id, descriptor, master) {
  const key = await deriveFileKey(master, descriptor.idx);
  const parts = [];
  for (let c = 0; c < descriptor.chunkCount; c++) {
    const res = await client.request('GET', `/api/transfers/${id}/files/${descriptor.idx}/chunks/${c}`);
    assert.equal(res.status, 200, `Chunk ${descriptor.idx}/${c} herunterladen`);
    const cipher = new Uint8Array(await res.arrayBuffer());
    parts.push(await decryptChunk(key, c, cipher));
  }
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/* -------------------------------------------------------------------------
 * Tests
 * ---------------------------------------------------------------------- */

test('Konfiguration wird ausgeliefert und enthaelt keine Geheimnisse', async () => {
  const { status, body, text } = await client.json('GET', '/api/config');
  assert.equal(status, 200);
  assert.equal(body.limits.clientChunkSize > 0, true);
  assert.equal(typeof body.branding.name, 'string');
  assert.ok(!text.includes(ADMIN_PASSWORD), 'Konfiguration darf kein Passwort enthalten');
  assert.ok(!/session|secret/i.test(text), 'Konfiguration darf keine Geheimnisse enthalten');
});

test('Sicherheits-Header und noindex sind gesetzt', async () => {
  const res = await client.request('GET', '/healthz');
  const csp = res.headers.get('content-security-policy');
  assert.ok(csp.includes("default-src 'self'"), 'CSP muss gesetzt sein');
  assert.ok(csp.includes("script-src 'self'"), 'keine Inline-Skripte erlaubt');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
});

test('Ende-zu-Ende: verschluesselter Transfer mit mehreren Chunks', async () => {
  const master = randomBytes(32);
  const big = { name: 'Rohdaten.bin', bytes: makePlain(CHUNK_SIZE * 2 + 5000), type: 'application/octet-stream' };
  const empty = { name: 'leer.txt', bytes: new Uint8Array(0), type: 'text/plain' };
  const message = 'Streng vertraulich – bitte nur intern';

  const { id, descriptors } = await uploadTransfer({
    files: [big, empty],
    master,
    extra: { message, maxDownloads: 1 },
  });

  // Der Server darf nichts vom Inhalt wissen
  const info = await client.json('GET', `/api/transfers/${id}`);
  assert.equal(info.status, 200);
  const rawBody = info.text;
  assert.ok(!rawBody.includes('Rohdaten.bin'), 'Dateiname darf nicht im Klartext auftauchen');
  assert.ok(!rawBody.includes('Streng vertraulich'), 'Nachricht darf nicht im Klartext auftauchen');
  assert.equal(info.body.keyMode, 'link');
  assert.equal(info.body.passwordProtected, false);

  // Metadaten entschluesseln
  const meta = await decryptMeta(master, info.body.meta);
  assert.equal(meta.message, message);
  assert.deepEqual(
    meta.files.map((f) => f.name),
    ['Rohdaten.bin', 'leer.txt']
  );

  // Empfaenger brauchen zu jeder sichtbaren Datei die technische Beschreibung
  // des Servers - sonst waeren Downloads leer. Das muss zusammenpassen.
  assert.deepEqual(
    meta.files.map((f) => f.idx),
    info.body.files.map((f) => f.idx),
    'Serverbeschreibungen muessen alle Dateien abdecken'
  );
  for (const file of info.body.files) {
    assert.ok(Number.isInteger(file.chunkCount) && file.chunkCount > 0, 'Chunk-Anzahl fehlt');
    assert.ok(Number.isInteger(file.chunkSize) && file.chunkSize > 0, 'Chunk-Groesse fehlt');
  }

  // Beide Dateien Byte fuer Byte zurueck
  assert.deepEqual(await downloadAndDecrypt(id, descriptors[0], master), big.bytes);
  assert.deepEqual(await downloadAndDecrypt(id, descriptors[1], master), empty.bytes);

  // Mit einem falschen Schluessel geht nichts
  const wrongKey = await deriveFileKey(randomBytes(32), 0);
  const chunkRes = await client.request('GET', `/api/transfers/${id}/files/0/chunks/0`);
  await assert.rejects(() => decryptChunk(wrongKey, 0, new Uint8Array(0)).then(() => {
    throw new Error('nicht erwartet');
  }));
  const cipher0 = new Uint8Array(await chunkRes.arrayBuffer());
  await assert.rejects(() => decryptChunk(wrongKey, 0, cipher0));
});

test('Download-Limit zaehlt pro Empfaenger und sperrt danach', async () => {
  const master = randomBytes(32);
  const file = { name: 'eins.txt', bytes: new TextEncoder().encode('hallo') };
  const { id } = await uploadTransfer({
    files: [file],
    master,
    extra: { maxDownloads: 1 },
  });

  const first = await client.json('POST', `/api/transfers/${id}/claim`, {
    headers: { 'x-visitor-id': 'besucher-eins-1234' },
  });
  assert.equal(first.status, 200);
  assert.equal(first.body.counted, true);
  assert.equal(first.body.downloads, 1);

  // Derselbe Empfaenger erneut: zaehlt nicht doppelt
  const again = await client.json('POST', `/api/transfers/${id}/claim`, {
    headers: { 'x-visitor-id': 'besucher-eins-1234' },
  });
  assert.equal(again.status, 200);
  assert.equal(again.body.counted, false);
  assert.equal(again.body.downloads, 1, 'derselbe Empfaenger darf nicht doppelt zaehlen');

  // Anderer Empfaenger: Limit erreicht
  const second = await client.json('POST', `/api/transfers/${id}/claim`, {
    headers: { 'x-visitor-id': 'besucher-zwei-5678' },
  });
  assert.equal(second.status, 410);

  // Und die Datei selbst ist ebenfalls gesperrt
  const blocked = await client.request('GET', `/api/transfers/${id}/files/0/chunks/0`);
  assert.equal(blocked.status, 410);
});

test('Passwortschutz: der Server liefert nur den verschlossenen Schluessel', async () => {
  const master = randomBytes(32);
  const password = 'nur-ich-kenne-das';
  const keyWrap = await wrapMasterKey(master, password);
  const file = { name: 'geheim.pdf', bytes: makePlain(4096), type: 'application/pdf' };

  const { id, descriptors } = await uploadTransfer({
    files: [file],
    master,
    keyMode: 'password',
    keyWrap,
    extra: { message: 'mit Passwort' },
  });

  const info = await client.json('GET', `/api/transfers/${id}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.passwordProtected, true);
  assert.equal(info.body.keyMode, 'password');
  assert.ok(!info.text.includes(password), 'das Passwort darf nirgends auftauchen');

  // Falsches Passwort scheitert (GCM-Tag), richtiges funktioniert
  await assert.rejects(() => unwrapMasterKey(info.body.keyWrap, 'falsch-geraten'));
  const unwrapped = await unwrapMasterKey(info.body.keyWrap, password);
  assert.deepEqual(unwrapped, master);

  const meta = await decryptMeta(unwrapped, info.body.meta);
  assert.equal(meta.files[0].name, 'geheim.pdf');
  assert.deepEqual(await downloadAndDecrypt(id, descriptors[0], unwrapped), file.bytes);
});

test('Upload-Token ist Pflicht und Index-Grenzen werden geprueft', async () => {
  const master = randomBytes(32);
  const file = { name: 'a.txt', bytes: makePlain(1000) };
  // Ohne Abschluss, damit der Upload-Pfad vollstaendig geprueft wird.
  const { id, uploadToken } = await uploadTransfer({ files: [file], master, extra: { complete: false } });

  const chunk = { body: new Uint8Array([1, 2, 3]), headers: { 'content-type': 'application/octet-stream' } };

  const noToken = await client.request('PUT', `/api/transfers/${id}/chunks/0/0`, chunk);
  assert.equal(noToken.status, 403, 'ohne Token kein Upload');

  const badToken = await client.request('PUT', `/api/transfers/${id}/chunks/0/0?t=1.abc`, chunk);
  assert.equal(badToken.status, 403, 'gefaelschter Token wird abgelehnt');

  const outOfRange = await client.request(
    'PUT',
    `/api/transfers/${id}/chunks/0/99?t=${encodeURIComponent(uploadToken)}`,
    chunk
  );
  assert.equal(outOfRange.status, 400);

  const unknownFile = await client.request(
    'PUT',
    `/api/transfers/${id}/chunks/7/0?t=${encodeURIComponent(uploadToken)}`,
    chunk
  );
  assert.equal(unknownFile.status, 404);

  const noStatusToken = await client.json('GET', `/api/transfers/${id}/status`);
  assert.equal(noStatusToken.status, 403);

  // Ein abgeschlossener Transfer nimmt keine weiteren Chunks an
  const finished = await uploadTransfer({ files: [file], master });
  const late = await client.request(
    'PUT',
    `/api/transfers/${finished.id}/chunks/0/0?t=${encodeURIComponent(finished.uploadToken)}`,
    chunk
  );
  assert.equal(late.status, 409);
});

test('Wiederaufnahme: bereits hochgeladene Chunks werden gemeldet', async () => {
  const master = randomBytes(32);
  const file = { name: 'gross.bin', bytes: makePlain(CHUNK_SIZE * 2 + 10) };
  const { id, uploadToken } = await uploadTransfer({ files: [file], master });

  const status = await client.json(
    'GET',
    `/api/transfers/${id}/status?t=${encodeURIComponent(uploadToken)}`
  );
  assert.equal(status.status, 200);
  assert.equal(status.body.files[0].chunkCount, 3);
  assert.equal(status.body.files[0].received, 3);
  assert.deepEqual(status.body.files[0].present, [1, 1, 1]);
  assert.equal(status.body.state, 'ready');
});

test('Fremde Herkunft wird bei schreibenden Anfragen abgewiesen (CSRF)', async () => {
  const res = await client.request('POST', '/api/transfers', {
    json: { meta: 'x', files: [] },
    headers: { origin: 'https://boese.example.com' },
  });
  assert.equal(res.status, 403);

  const nothing = await client.json('POST', '/api/transfers', { json: { meta: 'x', files: [] } });
  assert.equal(nothing.status, 400, 'ohne Origin darf die Anfrage durchgehen, aber Daten fehlen');
});

test('Groessen-Angaben werden serverseitig geprueft', async () => {
  const master = randomBytes(32);
  const meta = await encryptMeta(master, { v: 1, files: [] });
  const base = {
    meta,
    keyMode: 'link',
    expiresInHours: 2,
    maxDownloads: 0,
    notify: false,
  };

  // Chunk-Anzahl passt nicht zur Groesse
  const mismatch = await client.json('POST', '/api/transfers', {
    json: { ...base, files: [{ sizePlain: 1000, sizeCipher: 1016, chunkCount: 5, chunkSize: CHUNK_SIZE }] },
  });
  assert.equal(mismatch.status, 400);

  // Ciphertext-Groesse passt nicht
  const wrongCipher = await client.json('POST', '/api/transfers', {
    json: { ...base, files: [{ sizePlain: 1000, sizeCipher: 1000, chunkCount: 1, chunkSize: CHUNK_SIZE }] },
  });
  assert.equal(wrongCipher.status, 400);

  // Ueber dem Limit der Instanz
  const tooBig = await client.json('POST', '/api/transfers', {
    json: {
      ...base,
      files: [
        {
          sizePlain: 200 * 1024 * 1024,
          sizeCipher: 200 * 1024 * 1024 + 16 * Math.ceil((200 * 1024 * 1024) / CHUNK_SIZE),
          chunkCount: Math.ceil((200 * 1024 * 1024) / CHUNK_SIZE),
          chunkSize: CHUNK_SIZE,
        },
      ],
    },
  });
  assert.equal(tooBig.status, 413);

  // Unbekannter Schluesselmodus
  const badMode = await client.json('POST', '/api/transfers', {
    json: { ...base, keyMode: 'zauberei', files: [] },
  });
  assert.equal(badMode.status, 400);
});

test('Verwaltung: Anmeldung, Uebersicht und Zugriffsschutz', async () => {
  const anonymous = await client.json('GET', '/api/admin/overview');
  assert.equal(anonymous.status, 401, 'ohne Anmeldung kein Zugriff');

  const wrong = await client.json('POST', '/api/admin/login', { json: { password: 'falsch' } });
  assert.equal(wrong.status, 401);

  const right = await client.json('POST', '/api/admin/login', { json: { password: ADMIN_PASSWORD } });
  assert.equal(right.status, 200);

  const overview = await client.json('GET', '/api/admin/overview');
  assert.equal(overview.status, 200);
  assert.equal(overview.body.instanceName, 'sharedrive-test');
  assert.equal(overview.body.adminPasswordSet, true);
  assert.ok(overview.body.totals.transfers >= 1);
  assert.equal(overview.body.limits.defaultExpiryHours, 2);

  const transfers = await client.json('GET', '/api/admin/transfers');
  assert.equal(transfers.status, 200);
  assert.ok(transfers.body.transfers.length >= 1);
  // Auch hier darf kein Klartext auftauchen
  assert.ok(!transfers.text.includes('Rohdaten.bin'));

  const stats = await client.json('GET', '/api/admin/chart?days=7');
  assert.equal(stats.status, 200);
  assert.equal(stats.body.days.length, 7);
});

test('Upload-Portal: Passwortschutz, ECDH und Einsicht nur fuer den Eigentuemer', async () => {
  const created = await client.json('POST', '/api/admin/requests', {
    json: {
      title: 'Fotos vom Wochenende',
      message: 'Bitte die Originale',
      expiresInHours: 24,
      maxFiles: 10,
      password: 'portal-passwort',
      notify: false,
    },
  });
  assert.equal(created.status, 201, created.text);
  const requestId = created.body.id;

  const publicInfo = await client.json('GET', `/api/requests/${requestId}`);
  assert.equal(publicInfo.status, 200);
  assert.equal(publicInfo.body.passwordProtected, true);
  assert.equal(publicInfo.body.open, true);
  assert.ok(!publicInfo.text.includes('portal-passwort'));

  const wrongPassword = await client.json('POST', `/api/requests/${requestId}/verify`, {
    json: { password: 'falsch' },
  });
  assert.equal(wrongPassword.status, 401);

  const rightPassword = await client.json('POST', `/api/requests/${requestId}/verify`, {
    json: { password: 'portal-passwort' },
  });
  assert.equal(rightPassword.status, 200);

  // Ohne Passwort darf nichts hochgeladen werden
  const masterNoPass = randomBytes(32);
  const metaNoPass = await encryptMeta(masterNoPass, { v: 1, files: [] });
  const rejected = await client.json('POST', '/api/transfers', {
    json: {
      meta: metaNoPass,
      keyMode: 'link',
      expiresInHours: 2,
      files: [{ sizePlain: 10, sizeCipher: 26, chunkCount: 1, chunkSize: CHUNK_SIZE }],
      requestId,
    },
  });
  assert.equal(rejected.status, 401);

  // Eigentuemer-Schluesselpaar erzeugen und einen Upload damit verschluesseln
  const owner = await generateOwnerKeyPair();
  const sealed = await sealForOwner(owner.publicRaw);
  const file = { name: 'IMG_0421.jpg', bytes: makePlain(9000), type: 'image/jpeg' };

  const { id, descriptors } = await uploadTransfer({
    files: [file],
    master: sealed.master,
    keyMode: 'ecdh',
    keyWrap: sealed.keyInfo,
    extra: {
      requestId,
      requestPassword: 'portal-passwort',
      message: 'Das sind meine Bilder',
    },
  });

  const info = await client.json('GET', `/api/transfers/${id}`);
  assert.equal(info.status, 200);
  assert.equal(info.body.keyMode, 'ecdh');
  assert.equal(info.body.requestId, requestId);
  assert.equal(info.body.passwordProtected, false, 'der Upload selbst braucht kein Passwort');
  assert.ok(!info.text.includes('IMG_0421.jpg'));

  // Nur mit dem privaten Schluessel des Eigentuemers laesst sich das oeffnen
  const privateKey = await importOwnerPrivate(owner.privatePkcs8);
  const master = await openFromSubmitter(privateKey, info.body.keyWrap.eph);
  assert.deepEqual(master, sealed.master);

  const meta = await decryptMeta(master, info.body.meta);
  assert.equal(meta.files[0].name, 'IMG_0421.jpg');
  assert.equal(meta.message, 'Das sind meine Bilder');
  assert.deepEqual(await downloadAndDecrypt(id, descriptors[0], master), file.bytes);

  // Ein fremdes Schluesselpaar hilft nicht
  const stranger = await generateOwnerKeyPair();
  const strangerPrivate = await importOwnerPrivate(stranger.privatePkcs8);
  const wrongMaster = await openFromSubmitter(strangerPrivate, info.body.keyWrap.eph);
  await assert.rejects(() => decryptMeta(wrongMaster, info.body.meta));

  // Der Eigentuemer sieht den Upload im Dashboard
  const submissions = await client.json('GET', `/api/admin/requests/${requestId}/submissions`);
  assert.equal(submissions.status, 200);
  assert.equal(submissions.body.transfers.length, 1);
  assert.equal(submissions.body.transfers[0].id, id);

  const portalInfo = await client.json('GET', `/api/requests/${requestId}`);
  assert.equal(portalInfo.body.submissions, 1);

  // Portal loeschen raeumt auch den Upload weg
  const removed = await client.json('DELETE', `/api/admin/requests/${requestId}`);
  assert.equal(removed.status, 200);
  const gone = await client.json('GET', `/api/transfers/${id}`);
  assert.equal(gone.status, 404);
});

test('Abgelaufene Transfers werden aufgeraeumt - Daten verschwinden von der Platte', async () => {
  const master = randomBytes(32);
  const file = { name: 'temporaer.bin', bytes: makePlain(2000) };
  const { id } = await uploadTransfer({ files: [file], master, extra: { expiresInHours: 1 } });

  const transferDir = path.join(dataDir, 'chunks', id);
  assert.equal(fs.existsSync(transferDir), true, 'Chunks muessen auf der Platte liegen');

  // Ablauf kuenstlich in die Vergangenheit setzen
  const db = new DatabaseSync(path.join(dataDir, 'sharedrive.sqlite'));
  db.prepare('UPDATE transfers SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, id);
  db.close();

  const cleanup = await client.json('POST', '/api/admin/maintenance/cleanup');
  assert.equal(cleanup.status, 200);
  assert.ok(cleanup.body.result.transfers >= 1);

  const gone = await client.json('GET', `/api/transfers/${id}`);
  assert.equal(gone.status, 404, 'abgelaufener Transfer darf nicht mehr erreichbar sein');
  assert.equal(fs.existsSync(transferDir), false, 'verschluesselte Chunks muessen geloescht sein');

  const db2 = new DatabaseSync(path.join(dataDir, 'sharedrive.sqlite'));
  const row = db2.prepare('SELECT COUNT(*) AS n FROM transfers WHERE id = ?').get(id);
  db2.close();
  assert.equal(row.n, 0, 'auch der Datenbankeintrag muss weg sein');
});

test('Unbekannte Transfer-ID liefert 404, kaputte JSON-Eingabe 400', async () => {
  const missing = await client.json('GET', '/api/transfers/gibtesnicht');
  assert.equal(missing.status, 404);

  const badJson = await client.request('POST', '/api/transfers', {
    body: '{nicht-json',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(badJson.status, 400);

  const wrongMethod = await client.request('DELETE', '/api/config');
  assert.equal(wrongMethod.status, 405);
  assert.ok(wrongMethod.headers.get('allow'));
});

test('Abmelden beendet die Sitzung', async () => {
  const out = await client.json('POST', '/api/admin/logout');
  assert.equal(out.status, 200);
  const after = await client.json('GET', '/api/admin/overview');
  assert.equal(after.status, 401);
});
