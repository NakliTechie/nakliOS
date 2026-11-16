// NakliAmp tags: list the pictures already embedded in a file.
//
// The vendored writer replaces every embedded picture when it is given a new
// cover. NakliAmp replaces only the front cover: this module finds the other
// pictures (back cover, booklet pages, artist photos) so the writer can be
// handed them again unchanged.
//
// - MP3: APIC frames of the ID3v2.4 tag (after any ID3v2.2/2.3 upgrade); each
//   kept picture is its raw APIC body, written back byte for byte.
// - FLAC: PICTURE metadata blocks, rebuilt from every field they hold.
// - Ogg Vorbis and Opus: METADATA_BLOCK_PICTURE comments, the same structure.
// - MP4: the `data` atoms of `covr`. MP4 has no picture types, so the first
//   atom counts as the front cover and the rest are kept raw.
//
// Pure: Blob or bytes in, plain objects out. No DOM.

import { listId3v24Frames } from './id3.mjs';

export const FRONT_COVER = 3;

/** The 21 picture types ID3v2 and FLAC share, by number. */
export const PICTURE_TYPES = Object.freeze([
  'Other', "32x32 pixels 'file icon' (PNG only)", 'Other file icon', 'Cover (front)', 'Cover (back)',
  'Leaflet page', 'Media (e.g. label side of CD)', 'Lead artist/lead performer/soloist', 'Artist/performer',
  'Conductor', 'Band/Orchestra', 'Composer', 'Lyricist/text writer', 'Recording Location', 'During recording',
  'During performance', 'Movie/video screen capture', 'A bright coloured fish', 'Illustration',
  'Band/artist logotype', 'Publisher/Studio logotype',
]);

const UTF8 = new TextDecoder('utf-8');

function u32be(bytes, offset) {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function u32le(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

function ascii(bytes, offset, length) {
  let out = '';
  for (let index = 0; index < length && offset + index < bytes.length; index += 1) out += String.fromCharCode(bytes[offset + index]);
  return out;
}

async function read(blob, offset, length) {
  if (offset < 0 || length <= 0 || offset >= blob.size) return new Uint8Array(0);
  return new Uint8Array(await blob.slice(offset, Math.min(blob.size, offset + length)).arrayBuffer());
}

/** The picture type byte of an ID3v2.4 APIC body, or null when the body is too short. */
export function apicType(body) {
  const encoding = body[0];
  let cursor = 1;
  while (cursor < body.length && body[cursor] !== 0) cursor += 1;
  if (cursor + 1 >= body.length || encoding > 3) return null;
  return body[cursor + 1];
}

/** Build an ID3v2.4 APIC body: Latin-1 MIME type, picture type, empty description. */
export function apicBody(mime, typeId, data) {
  const out = new Uint8Array(1 + mime.length + 1 + 1 + 1 + data.length);
  out[0] = 0;
  for (let index = 0; index < mime.length; index += 1) out[1 + index] = mime.charCodeAt(index) & 0xff;
  out[1 + mime.length] = 0;
  out[2 + mime.length] = typeId;
  out[3 + mime.length] = 0;
  out.set(data, 4 + mime.length);
  return out;
}

/** Parse a FLAC PICTURE structure into the writer's picture object, or null. */
export function parseFlacPicture(bytes) {
  try {
    let cursor = 0;
    const need = (count) => { if (cursor + count > bytes.length) throw new RangeError('short'); };
    need(8);
    const typeId = u32be(bytes, cursor); cursor += 4;
    const mimeLength = u32be(bytes, cursor); cursor += 4;
    need(mimeLength + 4);
    const format = ascii(bytes, cursor, mimeLength); cursor += mimeLength;
    const descriptionLength = u32be(bytes, cursor); cursor += 4;
    need(descriptionLength + 20);
    const description = UTF8.decode(bytes.subarray(cursor, cursor + descriptionLength)); cursor += descriptionLength;
    const width = u32be(bytes, cursor);
    const height = u32be(bytes, cursor + 4);
    const colourDepth = u32be(bytes, cursor + 8);
    const colours = u32be(bytes, cursor + 12);
    const dataLength = u32be(bytes, cursor + 16);
    cursor += 20;
    need(dataLength);
    const data = bytes.slice(cursor, cursor + dataLength);
    return { typeId, type: PICTURE_TYPES[typeId] ?? 'Other', format, description, width, height, colourDepth, colours, data };
  } catch {
    return null;
  }
}

function mp3Pictures(id3Bytes) {
  return listId3v24Frames(id3Bytes)
    .filter((frame) => frame.id === 'APIC')
    .map((frame) => ({ typeId: apicType(frame.body), raw: frame.body }));
}

async function flacPictures(file, offset) {
  const pictures = [];
  let cursor = offset + 4;
  for (let count = 0; count < 1024; count += 1) {
    const head = await read(file, cursor, 4);
    if (head.length < 4) return null;
    const last = (head[0] & 0x80) !== 0;
    const type = head[0] & 0x7f;
    const length = (head[1] << 16) | (head[2] << 8) | head[3];
    if (type === 6) {
      const picture = parseFlacPicture(await read(file, cursor + 4, length));
      if (!picture) return null;
      pictures.push({ typeId: picture.typeId, picture });
    }
    cursor += 4 + length;
    if (last) return pictures;
  }
  return null;
}

function joinParts(parts) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

/** The second packet of the first Ogg stream (the comment header), or null. */
function oggCommentPacket(bytes) {
  const state = { packets: 0, parts: [] };
  let cursor = 0;
  for (let pages = 0; pages < 1024 && cursor + 27 <= bytes.length && ascii(bytes, cursor, 4) === 'OggS'; pages += 1) {
    const page = oggPageSegments(bytes, cursor, state);
    if (page.done || page.broken) return page.packet ?? null;
    cursor = page.next;
  }
  return null;
}

/** Walk one page's lacing values; returns the comment packet once it ends. */
function oggPageSegments(bytes, cursor, state) {
  const segments = bytes[cursor + 26];
  let body = cursor + 27 + segments;
  for (let index = 0; index < segments; index += 1) {
    const lace = bytes[cursor + 27 + index];
    if (body + lace > bytes.length) return { broken: true };
    if (state.packets === 1) state.parts.push(bytes.subarray(body, body + lace));
    body += lace;
    if (lace === 255) continue;
    if (state.packets === 1) return { done: true, packet: joinParts(state.parts) };
    state.packets += 1;
    state.parts = [];
  }
  return { next: body };
}

function base64Bytes(text) {
  try {
    const binary = atob(text.replace(/\s/g, ''));
    const out = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
    return out;
  } catch {
    return null;
  }
}

async function oggPictures(file) {
  const packet = oggCommentPacket(await read(file, 0, 64 * 1024 * 1024));
  if (!packet) return null;
  let cursor = ascii(packet, 0, 8) === 'OpusTags' ? 8 : 7;
  if (cursor + 4 > packet.length) return null;
  cursor += 4 + u32le(packet, cursor);
  if (cursor + 4 > packet.length) return null;
  const count = u32le(packet, cursor);
  cursor += 4;
  const pictures = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 4 > packet.length) return null;
    const length = u32le(packet, cursor);
    cursor += 4;
    if (cursor + length > packet.length) return null;
    const comment = UTF8.decode(packet.subarray(cursor, cursor + length));
    cursor += length;
    const equals = comment.indexOf('=');
    if (equals < 0 || comment.slice(0, equals).toUpperCase() !== 'METADATA_BLOCK_PICTURE') continue;
    const bytes = base64Bytes(comment.slice(equals + 1));
    const picture = bytes ? parseFlacPicture(bytes) : null;
    if (!picture) return null;
    pictures.push({ typeId: picture.typeId, picture });
  }
  return pictures;
}

function mp4Children(bytes, start, end) {
  const out = [];
  let cursor = start;
  while (cursor + 8 <= end) {
    const size = u32be(bytes, cursor);
    if (size < 8 || cursor + size > end) return null;
    out.push({ type: ascii(bytes, cursor + 4, 4), start: cursor, body: cursor + 8, end: cursor + size });
    cursor += size;
  }
  return out;
}

async function mp4Moov(file) {
  let cursor = 0;
  for (let count = 0; count < 4096 && cursor + 8 <= file.size; count += 1) {
    const head = await read(file, cursor, 16);
    let size = u32be(head, 0);
    const type = ascii(head, 4, 4);
    if (size === 1) size = Number(new DataView(head.buffer, head.byteOffset, 16).getBigUint64(8));
    else if (size === 0) size = file.size - cursor;
    if (size < 8) return null;
    if (type === 'moov') return size > 256 * 1024 * 1024 ? null : read(file, cursor, size);
    cursor += size;
  }
  return null;
}

function findChild(bytes, boxes, type) {
  return boxes?.find((box) => box.type === type) ?? null;
}

async function mp4Pictures(file) {
  const moov = await mp4Moov(file);
  if (!moov) return [];
  const udta = findChild(moov, mp4Children(moov, 8, moov.length), 'udta');
  const meta = udta && findChild(moov, mp4Children(moov, udta.body, udta.end), 'meta');
  const ilst = meta && findChild(moov, mp4Children(moov, meta.body + 4, meta.end), 'ilst');
  const covr = ilst && findChild(moov, mp4Children(moov, ilst.body, ilst.end), 'covr');
  if (!covr) return [];
  const atoms = mp4Children(moov, covr.body, covr.end);
  if (!atoms) return null;
  return atoms.filter((atom) => atom.type === 'data')
    .map((atom, index) => ({ typeId: index === 0 ? FRONT_COVER : 0, raw: moov.slice(atom.start, atom.end) }));
}

/** An MP4 `data` atom holding a JPEG (13) or PNG (14) image. */
export function mp4DataAtom(mime, data) {
  const kind = mime === 'image/png' ? 14 : /^image\/jpe?g$/.test(mime) ? 13 : 0;
  if (!kind) return null;
  const out = new Uint8Array(16 + data.length);
  const size = out.length;
  out.set([size >>> 24 & 0xff, size >> 16 & 0xff, size >> 8 & 0xff, size & 0xff, 0x64, 0x61, 0x74, 0x61, 0, 0, 0, kind, 0, 0, 0, 0]);
  out.set(data, 16);
  return out;
}

/**
 * List the pictures embedded in `file`. `format` is an inspectTagFormat
 * format; `id3Bytes` is the ID3v2.4 tag an MP3 will be written from.
 * Returns an array of `{ typeId, raw? , picture? }`, or null when the file's
 * pictures cannot be listed (then nothing can be kept, and the caller says so).
 */
export async function listPictures(file, format, { id3Bytes = null, flacOffset = 0 } = {}) {
  if (format === 'mp3') return id3Bytes ? mp3Pictures(id3Bytes) : [];
  if (format === 'flac') return flacPictures(file, flacOffset);
  if (format === 'ogg-vorbis' || format === 'ogg-opus') return oggPictures(file);
  if (format === 'mp4') return mp4Pictures(file);
  return null;
}

/** "1 other picture (Cover (back))" for the confirm dialog. */
export function describePictures(pictures) {
  const names = [...new Set(pictures.map((picture) => PICTURE_TYPES[picture.typeId] ?? 'Other'))];
  return `${pictures.length} other picture${pictures.length === 1 ? '' : 's'} (${names.join(', ')})`;
}
