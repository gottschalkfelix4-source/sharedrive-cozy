import test from 'node:test';
import assert from 'node:assert/strict';

import { mergeFiles, missingDescriptors } from '../public/js/sr-manifest.js';

const CHUNK = 4 * 1024 * 1024;

test('Metadaten und Serverangaben werden korrekt zusammengefuehrt', () => {
  const metaFiles = [
    { idx: 0, name: 'a.bin', path: 'a.bin', size: CHUNK * 2 + 10, type: 'application/octet-stream' },
    { idx: 1, name: 'leer.txt', path: 'leer.txt', size: 0, type: 'text/plain' },
  ];
  const serverFiles = [
    { idx: 0, sizeCipher: CHUNK * 2 + 10 + 16 * 3, chunkCount: 3, chunkSize: CHUNK },
    { idx: 1, sizeCipher: 16, chunkCount: 1, chunkSize: CHUNK },
  ];

  const merged = mergeFiles(metaFiles, serverFiles, CHUNK);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].name, 'a.bin');
  assert.equal(merged[0].chunkCount, 3);
  assert.equal(merged[0].chunkSize, CHUNK);
  assert.equal(merged[1].chunkCount, 1, 'eine leere Datei hat genau einen Chunk');
});

test('Fehlende Serverangaben fuehren zu einem klaren Fehler statt zu leeren Dateien', () => {
  // Genau dieser Fall hat in der Praxis dazu gefuehrt, dass Downloads 0 Byte hatten.
  const metaFiles = [{ idx: 0, name: 'bild.png', size: 1234, type: 'image/png' }];
  assert.throws(() => mergeFiles(metaFiles, [], Number.NaN), /Chunk-Anzahl/);
});

test('Ohne Serverangaben, aber mit gueltiger Chunk-Groesse wird gerechnet', () => {
  const merged = mergeFiles([{ idx: 0, name: 'x.bin', size: CHUNK + 1 }], [], CHUNK);
  assert.equal(merged[0].chunkCount, 2);
});

test('missingDescriptors findet Dateien ohne Serverbeschreibung', () => {
  const meta = [{ idx: 0 }, { idx: 1 }, { idx: 2 }];
  const server = [{ idx: 0 }, { idx: 2 }];
  assert.deepEqual(missingDescriptors(meta, server), [1]);
  assert.deepEqual(missingDescriptors(meta, meta), []);
});

test('Die Reihenfolge der Metadaten bleibt erhalten (die Empfaengerseite verlaesst sich darauf)', () => {
  const meta = [
    { idx: 3, name: 'c' },
    { idx: 1, name: 'a' },
    { idx: 2, name: 'b' },
  ];
  const server = [
    { idx: 1, chunkCount: 1, chunkSize: CHUNK },
    { idx: 2, chunkCount: 1, chunkSize: CHUNK },
    { idx: 3, chunkCount: 1, chunkSize: CHUNK },
  ];
  assert.deepEqual(
    mergeFiles(meta, server).map((f) => f.name),
    ['c', 'a', 'b']
  );
});
