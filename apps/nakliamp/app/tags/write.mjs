// NakliAmp tags: write tags into an audio file and return a new Blob.
//
// The container work is done by the vendored music-metadata write API
// (vendor/music-metadata, MIT), which rewrites only the metadata region and
// copies the audio unchanged: the ID3v2 tag before MP3 frames, the FLAC
// VORBIS_COMMENT and PICTURE blocks, the Ogg comment header pages, and the MP4
// moov/udta/meta/ilst box with stco/co64 offsets fixed. This module adds what
// NakliAmp needs around it: one patch shape for the whole app, a refusal by
// name for every other format, an ID3v2.2/2.3 to 2.4 upgrade that keeps
// the frames the patch does not touch (see id3.mjs), a new cover that keeps
// the other embedded pictures (see pictures.mjs), a trailing ID3v1 tag kept
// in step (see id3v1.mjs), and a check that every frame the patch does not
// replace is still in the output byte for byte.
//
// Pure: Blob in, Blob out. No DOM, no network.

import {
  updateBuffer, InvalidFileError, InvalidPatchError, UnsupportedFormatError,
} from '../../vendor/music-metadata/music-metadata-12.5.0-write.min.mjs';
import { readId3Header, upgradeId3, listId3v24Frames, Id3UpgradeError } from './id3.mjs';
import { listPictures, describePictures, apicBody, mp4DataAtom, FRONT_COVER } from './pictures.mjs';
import { isId3v1, patchId3v1, touchesId3v1, ID3V1_SIZE } from './id3v1.mjs';

export class TagWriteError extends Error {
  /** `code` is one of: unsupported, invalid-patch, invalid-file, write-failed. */
  constructor(code, message, options) {
    super(message, options);
    this.name = 'TagWriteError';
    this.code = code;
  }
}

export const TEXT_FIELDS = Object.freeze(['title', 'artist', 'album', 'albumArtist', 'genre']);
export const NUMBER_FIELDS = Object.freeze(['trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'rating']);
export const PATCH_FIELDS = Object.freeze([...TEXT_FIELDS, ...NUMBER_FIELDS, 'picture']);

const WRITABLE = new Set(['mp3', 'flac', 'ogg-vorbis', 'ogg-opus', 'mp4']);

const LABELS = Object.freeze({
  mp3: 'MP3', flac: 'FLAC', 'ogg-vorbis': 'Ogg Vorbis', 'ogg-opus': 'Ogg Opus', mp4: 'MP4',
  wav: 'WAV', aiff: 'AIFF', ape: "Monkey's Audio (APE)", wavpack: 'WavPack', musepack: 'Musepack',
  tta: 'TTA', wma: 'WMA', dsf: 'DSD (DSF)', dsdiff: 'DSD (DFF)', caf: 'CAF', au: 'AU',
  matroska: 'Matroska (MKA/WebM)', aac: 'raw AAC (ADTS)', 'ogg-flac': 'Ogg FLAC', 'ogg-speex': 'Ogg Speex',
  ogg: 'this kind of Ogg', unknown: 'this file type',
});

async function read(blob, offset, length) {
  if (offset < 0 || length <= 0 || offset >= blob.size) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer());
}

function ascii(buffer, offset, length) {
  let out = '';
  for (let index = 0; index < length && offset + index < buffer.length; index += 1) {
    out += String.fromCharCode(buffer[offset + index]);
  }
  return out;
}

const bytesAre = (head, ...expected) => expected.every((byte, index) => head[index] === byte);

/** Ordered container signatures: the first test that matches names the format. */
const HEAD_SIGNATURES = [
  [(head, four) => four === 'fLaC', 'flac'],
  [(head, four) => four === 'OggS', 'ogg'],
  [(head, four) => four === 'RIFF' && ascii(head, 8, 4) === 'WAVE', 'wav'],
  [(head, four) => four === 'FORM' && /^AIF[FC]$/.test(ascii(head, 8, 4)), 'aiff'],
  [(head, four) => four === 'FRM8', 'dsdiff'],
  [(head) => ascii(head, 4, 4) === 'ftyp', 'mp4'],
  [(head, four) => four === 'MAC ', 'ape'],
  [(head, four) => four === 'wvpk', 'wavpack'],
  [(head, four) => four === 'MPCK' || ascii(head, 0, 3) === 'MP+', 'musepack'],
  [(head, four) => four === 'TTA1', 'tta'],
  [(head, four) => four === 'DSD ', 'dsf'],
  [(head, four) => four === 'caff', 'caf'],
  [(head, four) => four === '.snd', 'au'],
  [(head) => bytesAre(head, 0x30, 0x26, 0xb2, 0x75), 'wma'],
  [(head) => bytesAre(head, 0x1a, 0x45, 0xdf, 0xa3), 'matroska'],
];

function sniffHead(head) {
  const four = ascii(head, 0, 4);
  const match = HEAD_SIGNATURES.find(([test]) => test(head, four));
  if (match) return match[1];
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
    return (head[1] & 0x06) === 0 ? 'aac' : 'mp3'; // layer bits 00 mark ADTS AAC
  }
  return 'unknown';
}

/** Which codec the first Ogg page carries. */
function oggCodec(head) {
  if (head.length < 28) return 'ogg';
  const segments = head[26];
  const packet = 27 + segments;
  if (ascii(head, packet, 7) === '\u0001vorbis') return 'ogg-vorbis';
  if (ascii(head, packet, 8) === 'OpusHead') return 'ogg-opus';
  if (ascii(head, packet, 5) === '\u007fFLAC') return 'ogg-flac';
  if (ascii(head, packet, 5) === 'Speex') return 'ogg-speex';
  return 'ogg';
}

/**
 * Identify the container and whether NakliAmp can write its tags.
 * Returns `{ format, label, writable, reason, id3Version, leadingId3 }`.
 * `id3Version` is 2, 3 or 4 for an ID3v2 tag at the start of the file.
 */
export async function inspectTagFormat(file) {
  const head = await read(file, 0, 512);
  const id3 = readId3Header(head);
  let format;
  if (id3) {
    const after = await read(file, id3.totalSize, 512);
    format = sniffHead(after);
    if (format === 'unknown') format = 'mp3'; // padding or junk after the tag: let the writer judge
  } else {
    format = sniffHead(head);
  }
  if (format === 'ogg') format = oggCodec(head);
  const label = LABELS[format] ?? LABELS.unknown;
  const writable = WRITABLE.has(format);
  return {
    format,
    label,
    writable,
    reason: writable ? null : `Tag editing is not available for ${label} files yet.`,
    id3Version: id3 ? id3.major : null,
    leadingId3: Boolean(id3),
  };
}

function cleanText(field, value) {
  if (value === null) return null;
  if (typeof value !== 'string') throw new TagWriteError('invalid-patch', `${field} must be text.`);
  const text = value.trim();
  return text.length ? text : null;
}

function cleanNumber(field, value, max) {
  if (value === null || value === '') return null;
  const number = typeof value === 'string' ? Number(value.trim()) : value;
  if (!Number.isInteger(number) || number < 0 || number > max) {
    throw new TagWriteError('invalid-patch', `${field} must be a whole number from 0 to ${max}.`);
  }
  return number;
}

function cleanPicture(value) {
  if (value === null) return null;
  const mime = value?.mime;
  let data = value?.bytes;
  if (data instanceof ArrayBuffer) data = new Uint8Array(data);
  if (typeof mime !== 'string' || !/^image\/[a-z0-9.+-]+$/i.test(mime) || !(data instanceof Uint8Array) || !data.length) {
    throw new TagWriteError('invalid-patch', 'picture must be { mime: "image/...", bytes: Uint8Array }.');
  }
  return { mime: mime.toLowerCase(), bytes: data };
}

/**
 * Validate and normalise a NakliAmp tag patch. Absent fields stay absent
 * (left untouched); empty text and `null` mean "remove this field"; a rating
 * of 0 removes the rating.
 */
export function normalisePatch(patch) {
  if (!patch || typeof patch !== 'object') throw new TagWriteError('invalid-patch', 'The tag patch must be an object.');
  const out = {};
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (!PATCH_FIELDS.includes(field)) throw new TagWriteError('invalid-patch', `Unknown tag field: ${field}.`);
    if (TEXT_FIELDS.includes(field)) out[field] = cleanText(field, value);
    else if (field === 'picture') out[field] = cleanPicture(value);
    else if (field === 'year') out[field] = cleanNumber(field, value, 9999);
    else if (field === 'rating') out[field] = cleanNumber(field, value, 5) || null;
    else out[field] = cleanNumber(field, value, 9999);
  }
  return out;
}

function pairPatch(clean, numberField, totalField) {
  if (!(numberField in clean) && !(totalField in clean)) return undefined;
  if (clean[numberField] === null && clean[totalField] === null) return null;
  const pair = {};
  if (numberField in clean) pair.no = clean[numberField];
  if (totalField in clean) pair.of = clean[totalField];
  return pair;
}

/** NakliAmp text fields and the music-metadata TagPatch key each maps to. */
const WRITER_TEXT_KEYS = [
  ['title', 'title'], ['artist', 'artist'], ['album', 'album'],
  ['albumArtist', 'albumartist'], ['genre', 'genre'],
];

function writerPicture(picture) {
  return picture === null
    ? null
    : [{ format: picture.mime, data: picture.bytes, type: 'Cover (front)', description: '' }];
}

function addWriterPairs(out, clean) {
  const track = pairPatch(clean, 'trackNo', 'trackTotal');
  if (track !== undefined) out.track = track;
  const disk = pairPatch(clean, 'discNo', 'discTotal');
  if (disk !== undefined) out.disk = disk;
}

/** Map a normalised NakliAmp patch to the music-metadata TagPatch for `format`. */
export function toWriterPatch(clean, format) {
  const out = {};
  const skipped = [];
  for (const [field, key] of WRITER_TEXT_KEYS) if (field in clean) out[key] = clean[field];
  if ('year' in clean) out.date = clean.year === null ? null : String(clean.year).padStart(4, '0');
  addWriterPairs(out, clean);
  if ('rating' in clean) {
    // music-metadata has no MP4 rating atom; the rating stays in the library index.
    if (format === 'mp4') skipped.push('rating');
    else out.rating = clean.rating === null ? null : [{ rating: clean.rating / 5 }];
  }
  if ('picture' in clean) out.picture = writerPicture(clean.picture);
  return { patch: out, skipped };
}

/** The leading ID3v2 tag an MP3 is written from, plus the upgrade report for ID3v2.2/2.3. */
async function sourceId3(file, info) {
  if (info.format !== 'mp3' || !info.id3Version) return { upgraded: null, id3Bytes: null };
  const header = readId3Header(await read(file, 0, 10));
  const bytes = await read(file, 0, header.totalSize);
  if (info.id3Version === 4) return { upgraded: null, id3Bytes: bytes };
  const upgraded = upgradeId3(bytes);
  return { upgraded, id3Bytes: upgraded?.tag ?? null };
}

function upgradeNotes(version, upgraded) {
  const notes = [`This file's ID3v2.${version} tag will be saved as ID3v2.4. Some older players and car stereos read only ID3v2.3.`];
  if (upgraded.renamed.length) notes.push(`These frames get their ID3v2.4 names: ${upgraded.renamed.join(', ')}.`);
  if (upgraded.legacy.length) notes.push(`These ID3v2.${version} frames have no ID3v2.4 form and are kept under their old names: ${upgraded.legacy.join(', ')}.`);
  if (upgraded.wrapped.length) notes.push(`These frames have ids ID3v2.4 cannot hold and are kept unchanged inside a private (PRIV) frame: ${upgraded.wrapped.join(', ')}.`);
  if (upgraded.dropped.length) notes.push(`These empty frames hold no data and are removed: ${upgraded.dropped.join(', ')}.`);
  return notes;
}

/** Which embedded pictures a new cover keeps, and the note that says so. */
async function picturePlan(file, info, patch, id3Bytes) {
  if (!patch || patch.picture === undefined) return { kept: [], note: null };
  const pictures = await listPictures(file, info.format, { id3Bytes, flacOffset: info.leadingId3 && info.format === 'flac' ? readId3Header(await read(file, 0, 10)).totalSize : 0 });
  if (patch.picture === null) {
    return { kept: [], note: pictures && pictures.length > 1 ? `Removing the cover art removes all ${pictures.length} pictures in this file.` : null };
  }
  if (pictures === null) return { kept: [], note: "NakliAmp could not list this file's other pictures, so the new cover replaces every embedded picture." };
  const kept = pictures.filter((picture) => picture.typeId !== FRONT_COVER);
  return { kept, note: kept.length ? `The new cover replaces the front cover; ${describePictures(kept)} stay in the file.` : null };
}

async function hasId3v1(file, info, patch) {
  if (info.format !== 'mp3' || file.size < ID3V1_SIZE || !touchesId3v1(patch ?? {})) return false;
  return isId3v1(await read(file, file.size - ID3V1_SIZE, ID3V1_SIZE));
}

/**
 * Describe what a write will do to this file beyond the field changes:
 * format conversions, kept and renamed frames, pictures, fields that cannot
 * be stored. Returns the inspectTagFormat result plus
 * `{ notes, dropped, skipped }`; a file whose old ID3 tag is damaged comes
 * back not writable, with the reason.
 */
export async function planTagWrite(file, patch = {}) {
  const info = await inspectTagFormat(file);
  if (!info.writable) return { ...info, notes: [info.reason], dropped: [], skipped: [] };
  let source;
  try {
    source = await sourceId3(file, info);
  } catch (error) {
    if (!(error instanceof Id3UpgradeError)) throw error;
    return { ...info, writable: false, reason: error.message, notes: [error.message], dropped: [], skipped: [] };
  }
  const { upgraded, id3Bytes } = source;
  const { notes, skipped } = formatNotes(info, patch, upgraded);
  const pictures = await picturePlan(file, info, patch, id3Bytes);
  if (pictures.note) notes.push(pictures.note);
  const id3v1 = await hasId3v1(file, info, patch);
  if (id3v1) notes.push('The old ID3v1 tag at the end of the file is updated too; it holds 30 Latin-1 characters per field.');
  const plan = { ...info, notes, dropped: upgraded?.dropped ?? [], skipped, id3v1 };
  // Large byte arrays stay off the enumerable plan, which callers log and compare.
  Object.defineProperty(plan, 'keptPictures', { enumerable: false, value: pictures.kept });
  Object.defineProperty(plan, 'sourceTag', { enumerable: false, value: upgraded ? { tag: upgraded.tag, tagLength: upgraded.tagLength } : null });
  Object.defineProperty(plan, 'id3Bytes', { enumerable: false, value: id3Bytes });
  return plan;
}

/** Notes about the container: the ID3 upgrade, a FLAC's stray ID3 tag, MP4 ratings. */
function formatNotes(info, patch, upgraded) {
  const notes = upgraded ? upgradeNotes(info.id3Version, upgraded) : [];
  const skipped = [];
  if (info.format === 'flac' && info.leadingId3) {
    notes.push('This FLAC file starts with a non-standard ID3 tag, which will be removed.');
  }
  if (info.format === 'mp4' && patch && patch.rating !== undefined) {
    skipped.push('rating');
    notes.push('MP4 files keep the rating in the NakliAmp library only; it is not written to the file.');
  }
  return { notes, skipped };
}

/** An ID3v2.2 or 2.3 MP3 is written from a copy whose tag is upgraded to 2.4. */
function upgradedSource(file, plan) {
  if (!plan.sourceTag) return file;
  return new Blob([plan.sourceTag.tag, file.slice(plan.sourceTag.tagLength)]);
}

/** Hand the writer the new front cover plus every other picture, unchanged. */
function keepOtherPictures(writerPatch, clean, plan) {
  const kept = plan.keptPictures ?? [];
  if (!clean.picture || !kept.length) return;
  const { mime, bytes } = clean.picture;
  if (plan.format === 'mp3') {
    delete writerPatch.picture;
    writerPatch.native = { ...writerPatch.native, APIC: [apicBody(mime, FRONT_COVER, bytes), ...kept.map((picture) => picture.raw)] };
  } else if (plan.format === 'mp4') {
    const front = mp4DataAtom(mime, bytes);
    if (!front) throw new TagWriteError('invalid-patch', 'MP4 artwork must be JPEG or PNG.');
    delete writerPatch.picture;
    const parts = [front, ...kept.map((picture) => picture.raw)];
    const body = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let cursor = 0;
    for (const part of parts) { body.set(part, cursor); cursor += part.length; }
    writerPatch.native = { ...writerPatch.native, covr: body };
  } else {
    writerPatch.picture = [...writerPatch.picture, ...kept.map((picture) => picture.picture)];
  }
}

/** ID3v2.4 frame ids each writer patch key replaces. */
const WRITER_ID3_IDS = Object.freeze({
  title: 'TIT2', artist: 'TPE1', album: 'TALB', albumartist: 'TPE2', genre: 'TCON',
  date: 'TDRC', track: 'TRCK', disk: 'TPOS', rating: 'POPM', picture: 'APIC',
});

/**
 * The ID3v2.4 frames that must still be in the file after the write: every
 * frame of the source tag the patch does not replace, plus the pictures the
 * patch keeps. Each is `{ id, body }` and must come back byte for byte.
 */
export function expectedId3Frames(sourceTag, writerPatch) {
  if (!sourceTag) return [];
  const replaced = new Set(Object.keys(writerPatch).map((key) => WRITER_ID3_IDS[key]).filter(Boolean));
  for (const id of Object.keys(writerPatch.native ?? {})) replaced.add(id);
  const expected = listId3v24Frames(sourceTag).filter((frame) => !replaced.has(frame.id)).map(({ id, body }) => ({ id, body }));
  for (const body of writerPatch.native?.APIC?.slice(1) ?? []) expected.push({ id: 'APIC', body });
  return expected;
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/** The ids of `expected` frames that `bytes` (a file or its head) does not hold byte for byte. */
export function missingId3Frames(bytes, expected) {
  const actual = listId3v24Frames(bytes);
  const used = new Set();
  const missing = [];
  for (const frame of expected) {
    const index = actual.findIndex((candidate, position) => !used.has(position) && candidate.id === frame.id && sameBytes(candidate.body, frame.body));
    if (index < 0) missing.push(frame.id);
    else used.add(index);
  }
  return [...new Set(missing)];
}

/** Bring a trailing ID3v1 tag in step with the patch. */
function updateId3v1(bytes, source, clean, plan) {
  if (!plan.id3v1 || bytes.length < ID3V1_SIZE) return bytes;
  const tail = bytes.subarray(bytes.length - ID3V1_SIZE);
  if (!isId3v1(tail) || source.size < ID3V1_SIZE) return bytes;
  const out = new Uint8Array(bytes);
  out.set(patchId3v1(tail, clean), bytes.length - ID3V1_SIZE);
  return out;
}

function writerErrorCode(error) {
  if (error instanceof InvalidPatchError) return 'invalid-patch';
  if (error instanceof InvalidFileError || error instanceof UnsupportedFormatError) return 'invalid-file';
  return 'write-failed';
}

/**
 * Write `patch` into `file` and return `{ blob, format, label, notes, dropped, skipped }`.
 * The input is never modified. Audio bytes are copied unchanged.
 */
export async function writeTagsDetailed(file, patch) {
  const clean = normalisePatch(patch);
  const plan = await planTagWrite(file, clean);
  if (!plan.writable) throw new TagWriteError('unsupported', plan.reason);

  const source = upgradedSource(file, plan);

  const { patch: writerPatch, skipped } = toWriterPatch(clean, plan.format);
  keepOtherPictures(writerPatch, clean, plan);
  const options = plan.format === 'flac' && plan.leadingId3 ? { stripFlacId3: true } : {};
  let bytes;
  try {
    bytes = Object.keys(writerPatch).length
      ? await updateBuffer(source, writerPatch, options)
      : new Uint8Array(await source.arrayBuffer());
  } catch (error) {
    throw new TagWriteError(writerErrorCode(error), `Could not write tags to this ${plan.label} file: ${error?.message ?? error}`, { cause: error });
  }
  const expectFrames = plan.format === 'mp3' ? expectedId3Frames(plan.id3Bytes, writerPatch) : [];
  const missing = missingId3Frames(bytes, expectFrames);
  if (missing.length) {
    throw new TagWriteError('write-failed', `Writing this ${plan.label} file would lose these frames: ${missing.join(', ')}. Nothing was written.`);
  }
  bytes = updateId3v1(bytes, source, clean, plan);
  const result = {
    blob: new Blob([bytes], { type: file.type || '' }),
    format: plan.format,
    label: plan.label,
    notes: plan.notes,
    dropped: plan.dropped,
    skipped: [...new Set([...plan.skipped, ...skipped])],
  };
  // The frames save.mjs checks again after re-reading the written file.
  Object.defineProperty(result, 'expectFrames', { enumerable: false, value: expectFrames });
  return result;
}

/** Contract entry point: write `patch` into `file`, return the new Blob. */
export async function writeTags(file, patch) {
  return (await writeTagsDetailed(file, patch)).blob;
}
