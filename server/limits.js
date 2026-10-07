/** Zentrale Grenzwerte, die sowohl API als auch UI kennen muessen. */
export const MAX_FILES = 2000;

/** Maximale Laenge einer Nachricht an den Empfaenger (wird clientseitig verschluesselt). */
export const MAX_MESSAGE_BYTES = 4096;

/** Maximale Laenge des verschluesselten Metadaten-Blobs (Base64). */
export const MAX_META_BYTES = 64 * 1024;

export const EXPIRY_PRESETS = [
  { hours: 1, label: '1 Stunde' },
  { hours: 24, label: '1 Tag' },
  { hours: 72, label: '3 Tage' },
  { hours: 168, label: '7 Tage' },
  { hours: 336, label: '14 Tage' },
  { hours: 720, label: '30 Tage' },
];

export const DOWNLOAD_PRESETS = [
  { value: 0, label: 'Unbegrenzt' },
  { value: 1, label: '1 Download' },
  { value: 5, label: '5 Downloads' },
  { value: 25, label: '25 Downloads' },
];
