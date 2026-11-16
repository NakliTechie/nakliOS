// NakliAmp tags: lift an ID3v2.2 or ID3v2.3 tag to ID3v2.4 before a write.
//
// The vendored writer (music-metadata) edits ID3v2.4 tags in place and keeps
// every frame it is not told to change. For ID3v2.2 and ID3v2.3 it offers only
// `replaceId3`, which discards every field the patch does not name: comments,
// ReplayGain TXXX frames, lyrics, play counters. This module converts the old
// tag frame by frame instead, so the writer can merge into it. No frame is
// lost: renamed frames take their ID3v2.4 id, removed ones keep their old id,
// and a frame whose id ID3v2.4 cannot hold is kept byte for byte in a PRIV
// frame. A damaged frame that hides the frames after it refuses the upgrade.
//
// Pure: bytes in, bytes out. No DOM.

const LATIN1 = new TextDecoder('latin1');

function ascii(buffer, offset, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(buffer[offset + index]);
  return out;
}

function u32be(buffer, offset) {
  return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function u24be(buffer, offset) {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

function syncsafe(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);
}

function writeSyncsafe(target, offset, value) {
  target[offset] = (value >>> 21) & 0x7f;
  target[offset + 1] = (value >>> 14) & 0x7f;
  target[offset + 2] = (value >>> 7) & 0x7f;
  target[offset + 3] = value & 0x7f;
}

/** Undo ID3 unsynchronisation: every 0xFF 0x00 pair loses its 0x00. */
function deUnsync(body) {
  const out = new Uint8Array(body.length);
  let length = 0;
  for (let index = 0; index < body.length; index += 1) {
    out[length++] = body[index];
    if (body[index] === 0xff && body[index + 1] === 0x00) index += 1;
  }
  return out.subarray(0, length);
}

/**
 * Read the ID3v2 header at the start of `head` (at least 10 bytes).
 * Returns null when there is no ID3v2 tag.
 */
export function readId3Header(head) {
  if (!head || head.length < 10 || ascii(head, 0, 3) !== 'ID3') return null;
  const major = head[3];
  const flags = head[5];
  const size = syncsafe(head, 6);
  const footer = major === 4 && (flags & 0x10) !== 0;
  return { major, revision: head[4], flags, size, totalSize: 10 + size + (footer ? 10 : 0) };
}

/** Thrown when an old tag cannot be converted without losing frames. */
export class Id3UpgradeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'Id3UpgradeError';
    this.code = 'invalid-file';
  }
}

// ID3v2.3 frames that ID3v2.4 renamed.
const RENAME_23 = new Map([['TORY', 'TDOR'], ['IPLS', 'TIPL']]);
// ID3v2.3 frames ID3v2.4 removed with no direct replacement. They are carried
// into the ID3v2.4 tag under their old names, byte for byte: an ID3v2.4 reader
// skips a frame id it does not know, and the data stays in the file.
const LEGACY_23 = new Set(['TRDA', 'TSIZ', 'EQUA', 'RVAD']);

// ID3v2.2 three-letter frames and their ID3v2.4 (or ID3v2.3) names. Every body
// here has the same layout in both versions. The same table maps the
// three-letter ids that old iTunes versions wrote into ID3v2.3 tags padded
// with a zero byte or a space (`TCP\0`).
const RENAME_22 = new Map([
  ['TT1', 'TIT1'], ['TT2', 'TIT2'], ['TT3', 'TIT3'], ['TP1', 'TPE1'], ['TP2', 'TPE2'],
  ['TP3', 'TPE3'], ['TP4', 'TPE4'], ['TAL', 'TALB'], ['TRK', 'TRCK'], ['TPA', 'TPOS'],
  ['TCO', 'TCON'], ['TCM', 'TCOM'], ['TXT', 'TEXT'], ['TEN', 'TENC'], ['TSS', 'TSSE'],
  ['TBP', 'TBPM'], ['TCR', 'TCOP'], ['TPB', 'TPUB'], ['TRC', 'TSRC'], ['TLA', 'TLAN'],
  ['TLE', 'TLEN'], ['TKE', 'TKEY'], ['TMT', 'TMED'], ['TOA', 'TOPE'], ['TOT', 'TOAL'],
  ['TOL', 'TOLY'], ['TOF', 'TOFN'], ['TOR', 'TDOR'], ['TFT', 'TFLT'], ['TDY', 'TDLY'],
  ['TXX', 'TXXX'], ['COM', 'COMM'], ['ULT', 'USLT'], ['WXX', 'WXXX'], ['WAR', 'WOAR'],
  ['WAS', 'WOAS'], ['WAF', 'WOAF'], ['WCM', 'WCOM'], ['WCP', 'WCOP'], ['WPB', 'WPUB'],
  ['CNT', 'PCNT'], ['POP', 'POPM'], ['UFI', 'UFID'], ['GEO', 'GEOB'], ['MCI', 'MCDI'],
  ['IPL', 'TIPL'], ['SLT', 'SYLT'], ['REV', 'RVRB'], ['BUF', 'RBUF'], ['CRA', 'AENC'],
  ['ETC', 'ETCO'], ['MLL', 'MLLT'], ['STC', 'SYTC'], ['RVA', 'RVAD'], ['EQU', 'EQUA'],
  ['TSI', 'TSIZ'], ['TRD', 'TRDA'],
  // iTunes extensions: compilation and sort-order frames.
  ['TCP', 'TCMP'], ['TST', 'TSOT'], ['TSA', 'TSOA'], ['TSP', 'TSOP'], ['TS2', 'TSO2'], ['TSC', 'TSOC'],
]);

const PIC_FORMATS = new Map([['JPG', 'image/jpeg'], ['PNG', 'image/png'], ['GIF', 'image/gif'], ['BMP', 'image/bmp']]);

/** PRIV owner ids for frames whose id ID3v2.4 cannot hold; the data keeps the whole old frame. */
export const PRIV_OWNER_23 = 'NakliAmp: ID3v2.3 frame';
export const PRIV_OWNER_22 = 'NakliAmp: ID3v2.2 frame';

function textFrameValue(body) {
  // Date frames are digits; Latin-1 decoding is exact for encodings 0 and 3
  // and good enough to recover digits from the others.
  if (!body.length) return '';
  const payload = body.subarray(1);
  if (body[0] === 1 || body[0] === 2) {
    let out = '';
    for (let index = 0; index + 1 < payload.length; index += 2) {
      const code = body[0] === 2 || (payload[0] === 0xfe && payload[1] === 0xff)
        ? (payload[index] << 8) | payload[index + 1]
        : payload[index] | (payload[index + 1] << 8);
      if (code !== 0xfeff) out += String.fromCharCode(code);
    }
    return out.replace(/\0+$/, '').trim();
  }
  return LATIN1.decode(payload).replace(/\0+$/, '').trim();
}

function latin1Frame(text) {
  const out = new Uint8Array(text.length + 1);
  out[0] = 0;
  for (let index = 0; index < text.length; index += 1) out[index + 1] = text.charCodeAt(index) & 0xff;
  return out;
}

/** ID3v2.2 PIC body to an ID3v2.4 APIC body: the 3-letter format becomes a MIME type. */
function picToApic(body) {
  if (body.length < 5) return null;
  const format = ascii(body, 1, 3).toUpperCase();
  const mime = PIC_FORMATS.get(format) ?? `image/${format.toLowerCase()}`;
  const out = new Uint8Array(1 + mime.length + 1 + body.length - 4);
  out[0] = body[0];
  for (let index = 0; index < mime.length; index += 1) out[1 + index] = mime.charCodeAt(index);
  out[1 + mime.length] = 0;
  out.set(body.subarray(4), 2 + mime.length);
  return out;
}

function encodeFrame(id, statusFlags, formatFlags, body) {
  const out = new Uint8Array(10 + body.length);
  for (let index = 0; index < 4; index += 1) out[index] = id.charCodeAt(index);
  writeSyncsafe(out, 4, body.length);
  out[8] = statusFlags;
  out[9] = formatFlags;
  out.set(body, 10);
  return out;
}

/** A PRIV frame that holds an old frame byte for byte, so nothing is lost. */
function privFrame(owner, rawFrame) {
  const body = new Uint8Array(owner.length + 1 + rawFrame.length);
  for (let index = 0; index < owner.length; index += 1) body[index] = owner.charCodeAt(index);
  body.set(rawFrame, owner.length + 1);
  return encodeFrame('PRIV', 0, 0, body);
}

/** Merge TYER (YYYY), TDAT (DDMM) and TIME (HHMM) into one TDRC timestamp. */
function timestamp(yearText, dateText, timeText) {
  const year = /^\d{4}$/.exec(yearText ?? '')?.[0];
  if (!year) return null;
  let out = year;
  let usedDate = false;
  let usedTime = false;
  const date = /^(\d{2})(\d{2})$/.exec(dateText ?? '');
  if (date) {
    out += `-${date[2]}-${date[1]}`;
    usedDate = true;
    const time = /^(\d{2})(\d{2})$/.exec(timeText ?? '');
    if (time) { out += `T${time[1]}:${time[2]}`; usedTime = true; }
  }
  return { text: out, usedDate, usedTime };
}

/**
 * Fold the old date frames into one TDRC frame where that loses nothing; every
 * date frame whose text did not fit the timestamp is carried as it was.
 * `parts` maps year/date/time to `{ value, frame }`, where `frame` is the
 * frame to carry when the part is not folded.
 */
function foldDates(frames, parts) {
  const hasTdrc = frames.some((frame) => ascii(frame, 0, 4) === 'TDRC');
  const stamp = hasTdrc ? null : timestamp(parts.year?.value, parts.date?.value, parts.time?.value);
  const folded = { year: Boolean(stamp), date: Boolean(stamp?.usedDate), time: Boolean(stamp?.usedTime) };
  const carried = ['year', 'date', 'time'].filter((key) => parts[key] && !folded[key]).map((key) => parts[key].frame);
  const out = [...frames, ...carried];
  if (stamp) out.unshift(encodeFrame('TDRC', 0, 0, latin1Frame(stamp.text)));
  return out;
}

/** ID3v2.3 date frames that fold into one ID3v2.4 TDRC timestamp. */
const DATE_PARTS_23 = { TYER: 'year', TDAT: 'date', TIME: 'time' };
const DATE_PARTS_22 = { TYE: 'year', TDA: 'date', TIM: 'time' };

/**
 * Move an ID3v2.3 frame's flags and the bytes they add to ID3v2.4 order.
 * ID3v2.3 puts the decompressed size (4), encryption method (1) and group (1)
 * before the data; ID3v2.4 puts group (1), encryption method (1) and a
 * syncsafe data length (4). Returns null when the frame is too short for the
 * flags it claims, so the caller keeps it whole instead.
 */
function convertFlags23(status, format, frameBody) {
  const has = { compressed: (format & 0x80) !== 0, encrypted: (format & 0x40) !== 0, grouped: (format & 0x20) !== 0 };
  const extra = (has.compressed ? 4 : 0) + Number(has.encrypted) + Number(has.grouped);
  if (frameBody.length < extra) return null;
  const decompressed = has.compressed ? u32be(frameBody, 0) : null;
  if (decompressed !== null && decompressed >= 2 ** 28) return null;
  let cursor = has.compressed ? 4 : 0;
  const method = has.encrypted ? frameBody[cursor++] : null;
  const group = has.grouped ? frameBody[cursor++] : null;
  const { flags, head } = flagHead24(has, group, method, decompressed);
  const data = frameBody.subarray(cursor);
  const body = new Uint8Array(head.length + data.length);
  body.set(head, 0);
  body.set(data, head.length);
  // ID3v2.3 status flags abc00000 move to 0abc0000.
  return { status: (status & 0xe0) >> 1, format: flags, body };
}

/** The ID3v2.4 format flags and the bytes they put before the frame data. */
function flagHead24(has, group, method, decompressed) {
  const head = [];
  let flags = 0;
  if (has.grouped) { flags |= 0x40; head.push(group); }
  if (has.encrypted) { flags |= 0x04; head.push(method); }
  if (has.compressed) {
    flags |= 0x08 | 0x01;
    const length = new Uint8Array(4);
    writeSyncsafe(length, 0, decompressed);
    head.push(...length);
  }
  return { flags, head };
}

function allZero(bytes, from) {
  for (let index = from; index < bytes.length; index += 1) if (bytes[index] !== 0) return false;
  return true;
}

const FRAME_START = /^[A-Z0-9]{3}[A-Z0-9 \0]$/;

/**
 * The size of the ID3v2.3 frame at `cursor`. Some writers stored a syncsafe
 * size in ID3v2.3; that reading is accepted only when the plain one runs past
 * the tag and the syncsafe one lands on the next frame, padding or the end.
 * Returns null when neither reading fits.
 */
function frameSize23(body, cursor) {
  const plain = u32be(body, cursor + 4);
  if (cursor + 10 + plain <= body.length) return plain;
  const safe = syncsafe(body, cursor + 4);
  const next = cursor + 10 + safe;
  if (next > body.length) return null;
  if (next === body.length || body[next] === 0 || (next + 4 <= body.length && FRAME_START.test(ascii(body, next, 4)))) return safe;
  return null;
}

function damaged(major, cursor, why) {
  return new Id3UpgradeError(`This file's ID3v2.${major} tag has a damaged frame at byte ${10 + cursor} (${why}). NakliAmp will not rewrite it, because the frames after that point would be lost.`);
}

function printable(id) {
  return id.replace(/[^\x21-\x7e]/g, (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

/** The ID3v2.4 id for an ID3v2.3 frame id, or null when it has none. */
function targetId23(rawId) {
  if (/^[A-Z0-9]{4}$/.test(rawId)) return RENAME_23.get(rawId) ?? rawId;
  if (/^[A-Z0-9]{3}[\0 ]$/.test(rawId)) return RENAME_22.get(rawId.slice(0, 3)) ?? null;
  return null;
}

/** Convert one ID3v2.3 frame: returns a v2.4 frame or null (folded into a date). */
function convertFrame23(rawId, rawFrame, frameBody, parts, report) {
  const status = rawFrame[8];
  const format = rawFrame[9];
  if (!frameBody.length) { report.dropped.push(`${printable(rawId)} (empty)`); return null; }
  const id = targetId23(rawId);
  const flags = id ? convertFlags23(status, format, frameBody) : null;
  if (!id || !flags) {
    report.wrapped.push(printable(rawId));
    return privFrame(PRIV_OWNER_23, rawFrame);
  }
  if (id !== rawId) report.renamed.push(`${printable(rawId)} as ${id}`);
  if (LEGACY_23.has(id)) report.legacy.push(id);
  const frame = encodeFrame(id, flags.status, flags.format, flags.body);
  if (id in DATE_PARTS_23 && !format) {
    parts[DATE_PARTS_23[id]] = { value: textFrameValue(frameBody), frame };
    return null;
  }
  return frame;
}

function parse23(body, report) {
  const frames = [];
  const parts = {};
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] === 0) {
      if (allZero(body, cursor)) break;
      throw damaged(3, cursor, 'bytes after the padding');
    }
    if (cursor + 10 > body.length) throw damaged(3, cursor, 'truncated frame header');
    const rawId = ascii(body, cursor, 4);
    const size = frameSize23(body, cursor);
    if (size === null) throw damaged(3, cursor, `frame ${printable(rawId)} runs past the end of the tag`);
    const rawFrame = body.subarray(cursor, cursor + 10 + size);
    cursor += 10 + size;
    const frame = convertFrame23(rawId, rawFrame, rawFrame.subarray(10), parts, report);
    if (frame) frames.push(frame);
  }
  const out = foldDates(frames, parts);
  for (const [id, key] of Object.entries(DATE_PARTS_23)) {
    if (parts[key] && out.includes(parts[key].frame)) report.legacy.push(id);
  }
  return out;
}

/** Convert one ID3v2.2 frame: returns a v2.4 frame or null (folded into a date). */
function convertFrame22(id, rawFrame, frameBody, parts, report) {
  if (!frameBody.length) { report.dropped.push(`${printable(id)} (empty)`); return null; }
  const wrap = () => { report.wrapped.push(printable(id)); return privFrame(PRIV_OWNER_22, rawFrame); };
  if (id in DATE_PARTS_22) {
    parts[DATE_PARTS_22[id]] = { value: textFrameValue(frameBody), frame: privFrame(PRIV_OWNER_22, rawFrame), id };
    return null;
  }
  if (id === 'PIC') {
    const apic = picToApic(frameBody);
    return apic ? encodeFrame('APIC', 0, 0, apic) : wrap();
  }
  const target = RENAME_22.get(id);
  if (!target) return wrap();
  if (LEGACY_23.has(target)) report.legacy.push(target);
  return encodeFrame(target, 0, 0, frameBody);
}

function parse22(body, report) {
  const frames = [];
  const parts = {};
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] === 0) {
      if (allZero(body, cursor)) break;
      throw damaged(2, cursor, 'bytes after the padding');
    }
    if (cursor + 6 > body.length) throw damaged(2, cursor, 'truncated frame header');
    const id = ascii(body, cursor, 3);
    const size = u24be(body, cursor + 3);
    if (cursor + 6 + size > body.length) throw damaged(2, cursor, `frame ${printable(id)} runs past the end of the tag`);
    const rawFrame = body.subarray(cursor, cursor + 6 + size);
    cursor += 6 + size;
    const frame = convertFrame22(id, rawFrame, rawFrame.subarray(6), parts, report);
    if (frame) frames.push(frame);
  }
  const out = foldDates(frames, parts);
  for (const part of Object.values(parts)) {
    if (out.includes(part.frame)) report.wrapped.push(part.id);
  }
  return out;
}

/**
 * Convert the leading ID3v2.2 or ID3v2.3 tag of `bytes` to ID3v2.4 without
 * losing a frame.
 *
 * Returns `{ tag, tagLength, from, dropped, renamed, legacy, wrapped }`:
 * - `tag` is the new ID3v2.4 tag (no padding; the writer adds its own) and
 *   `tagLength` the byte length of the old tag it replaces;
 * - `renamed` lists old ids written under their ID3v2.4 names (`TCP\0 as TCMP`);
 * - `legacy` lists ID3v2.3 frames ID3v2.4 removed, carried under their old ids;
 * - `wrapped` lists frames whose id ID3v2.4 cannot hold, kept byte for byte in
 *   a PRIV frame owned by `NakliAmp: ID3v2.3 frame` (or 2.2);
 * - `dropped` lists only empty frames, which hold no data.
 * Returns null when the file has no ID3v2.2 or ID3v2.3 tag. Throws
 * Id3UpgradeError when a frame is damaged so that the frames after it cannot
 * be found: the write is refused rather than losing them.
 */
export function upgradeId3(bytes) {
  const header = readId3Header(bytes);
  if (!header || (header.major !== 2 && header.major !== 3)) return null;
  const body = tagBody(bytes, header);
  const report = { dropped: [], renamed: [], legacy: [], wrapped: [] };
  const frames = header.major === 3 ? parse23(body, report) : parse22(body, report);
  const size = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
  writeSyncsafe(tag, 6, size);
  let cursor = 10;
  for (const frame of frames) { tag.set(frame, cursor); cursor += frame.length; }
  return {
    tag,
    tagLength: 10 + header.size,
    from: header.major,
    dropped: unique(report.dropped),
    renamed: unique(report.renamed),
    legacy: unique(report.legacy),
    wrapped: unique(report.wrapped),
  };
}

const unique = (list) => [...new Set(list)];

/** The frame bytes of an old tag: unsynchronisation undone, extended header skipped. */
function tagBody(bytes, header) {
  if (header.major === 2 && (header.flags & 0x40)) {
    throw new Id3UpgradeError('This file has a compressed ID3v2.2 tag, which NakliAmp cannot convert.');
  }
  if (bytes.length < 10 + header.size) throw new Id3UpgradeError('This file ends inside its ID3 tag.');
  let body = bytes.subarray(10, 10 + header.size);
  if (header.flags & 0x80) body = deUnsync(body);
  if (header.major === 3 && (header.flags & 0x40) && body.length >= 4) {
    body = body.subarray(Math.min(body.length, 4 + u32be(body, 0)));
  }
  return body;
}

/**
 * List the frames of an ID3v2.4 tag at the start of `bytes` as
 * `{ id, flags, body }` (for the write check, tests and the inspector).
 */
export function listId3v24Frames(bytes) {
  const header = readId3Header(bytes);
  if (!header || header.major !== 4) return [];
  const out = [];
  const end = Math.min(bytes.length, 10 + header.size);
  let cursor = 10;
  if ((header.flags & 0x40) && cursor + 4 <= end) cursor += syncsafe(bytes, cursor);
  while (cursor + 10 <= end) {
    const id = ascii(bytes, cursor, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = syncsafe(bytes, cursor + 4);
    out.push({ id, flags: (bytes[cursor + 8] << 8) | bytes[cursor + 9], body: bytes.subarray(cursor + 10, cursor + 10 + size) });
    cursor += 10 + size;
  }
  return out;
}
