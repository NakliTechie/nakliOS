// NakliAmp tags: the change list a confirm dialog shows before a tag write.
// Pure: no DOM, no I/O.

import { PATCH_FIELDS } from './write.mjs';

const LABELS = Object.freeze({
  title: 'Title', artist: 'Artist', album: 'Album', albumArtist: 'Album artist',
  trackNo: 'Track', trackTotal: 'Track total', discNo: 'Disc', discTotal: 'Disc total',
  year: 'Year', genre: 'Genre', rating: 'Rating', picture: 'Cover art',
});

const NUMERIC_FIELDS = ['trackNo', 'trackTotal', 'discNo', 'discTotal', 'year'];

function normalisePicture(value) {
  const bytes = value.bytes instanceof ArrayBuffer ? new Uint8Array(value.bytes) : value.bytes;
  return bytes && bytes.length ? { mime: String(value.mime ?? '').toLowerCase(), bytes } : null;
}

function normaliseText(field, value) {
  const text = value.trim();
  if (!text.length) return null;
  return NUMERIC_FIELDS.includes(field) && /^\d+$/.test(text) ? Number(text) : text;
}

function normaliseValue(field, value) {
  if (value === undefined || value === null) return null;
  if (field === 'picture') return normalisePicture(value);
  if (field === 'rating') return Number(value) > 0 ? Number(value) : null;
  if (typeof value === 'string') return normaliseText(field, value);
  return value;
}

function samePicture(left, right) {
  if (!left || !right) return left === right;
  if (left.mime !== right.mime || left.bytes.length !== right.bytes.length) return false;
  for (let index = 0; index < left.bytes.length; index += 1) if (left.bytes[index] !== right.bytes[index]) return false;
  return true;
}

/** How a value reads in the dialog. */
export function formatTagValue(field, value) {
  if (value === null || value === undefined) return '(empty)';
  if (field === 'picture') return `${value.mime.replace('image/', '').toUpperCase()} image, ${Math.max(1, Math.round(value.bytes.length / 1024))} KB`;
  if (field === 'rating') return `${value} star${value === 1 ? '' : 's'}`;
  if (typeof value === 'string') return `"${value}"`;
  return String(value);
}

/**
 * Compare `before` (a readTags result, or a library track record) with
 * `after` (a tag patch: only the fields it names are changes). `plan`, from
 * planTagWrite, adds format notes such as the ID3v2.3 to 2.4 upgrade.
 *
 * Returns `{ changes: [{ field, label, from, to, fromText, toText }], notes,
 * unchanged: boolean, lines: string[] }`. `lines` is ready to show.
 */
export function describeTagChange(before = {}, after = {}, plan = null) {
  const changes = [];
  for (const field of PATCH_FIELDS) {
    if (!after || after[field] === undefined) continue;
    const from = normaliseValue(field, before?.[field]);
    const to = normaliseValue(field, after[field]);
    const same = field === 'picture' ? samePicture(from, to) : from === to;
    if (same) continue;
    changes.push({
      field,
      label: LABELS[field],
      from,
      to,
      fromText: formatTagValue(field, from),
      toText: formatTagValue(field, to),
    });
  }
  const notes = [...(plan?.notes ?? [])];
  const lines = changes.map((change) => `${change.label}: ${change.fromText} to ${change.toText}`);
  return { changes, notes, unchanged: changes.length === 0, lines: [...lines, ...notes] };
}

/**
 * Summarise several describeTagChange results for a many-file edit:
 * `{ files, filesChanged, fields: { [field]: count }, notes }`, with each
 * distinct note listed once.
 */
export function summariseTagChanges(diffs) {
  const fields = {};
  const notes = new Set();
  let filesChanged = 0;
  for (const diff of diffs) {
    if (!diff.unchanged) filesChanged += 1;
    for (const change of diff.changes) fields[change.field] = (fields[change.field] ?? 0) + 1;
    for (const note of diff.notes) notes.add(note);
  }
  return { files: diffs.length, filesChanged, fields, notes: [...notes] };
}
