/**
 * Zusammenfuehren der beiden Dateiquellen
 * ======================================
 *
 * Beim Empfangen liegen die Angaben zu einer Datei an zwei Orten:
 *
 *   1. in den entschluesselten Metadaten (nur der Client kann sie lesen):
 *      Name, Pfad, Groesse, Typ
 *   2. in der Antwort des Servers (nur Zahlen, nie Klartext):
 *      Index, Chunk-Anzahl, Chunk-Groesse, Ciphertext-Groesse
 *
 * Erst beide zusammen ergeben eine ladbare Datei. Fehlt die Chunk-Anzahl,
 * laesst sich nicht sagen, wie viele Teile geholt werden muessen - deshalb
 * prueft mergeFiles das Ergebnis und meldet Unstimmigkeiten, statt eine leere
 * Datei zu erzeugen.
 *
 * Dieses Modul ist bewusst frei von DOM-Zugriffen, damit es auch in Node
 * getestet werden kann.
 */

export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024;

export function mergeFiles(metaFiles = [], serverFiles = [], fallbackChunkSize = DEFAULT_CHUNK_SIZE) {
  const byIdx = new Map();
  for (const file of serverFiles) byIdx.set(file.idx, file);

  const merged = [];
  for (const metaFile of metaFiles) {
    const serverFile = byIdx.get(metaFile.idx);
    const chunkSize = serverFile?.chunkSize || fallbackChunkSize;
    const size = Number(metaFile.size ?? serverFile?.sizeCipher ?? 0);

    const chunkCount =
      serverFile?.chunkCount ?? (size === 0 ? 1 : Math.ceil(size / chunkSize));

    if (!Number.isInteger(chunkCount) || chunkCount <= 0) {
      throw new Error(
        `Für "${metaFile.name || metaFile.idx}" fehlt die Chunk-Anzahl – die Datei kann nicht geladen werden.`
      );
    }

    merged.push({
      ...metaFile,
      size,
      chunkCount,
      chunkSize,
      sizeCipher: serverFile?.sizeCipher,
    });
  }

  return merged;
}

/** Prueft, ob jede im Client sichtbare Datei eine Serverbeschreibung hat. */
export function missingDescriptors(metaFiles = [], serverFiles = []) {
  const known = new Set(serverFiles.map((file) => file.idx));
  return metaFiles.filter((file) => !known.has(file.idx)).map((file) => file.idx);
}
