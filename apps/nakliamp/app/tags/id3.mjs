// NakliAmp tags: lift an ID3v2.2 or ID3v2.3 tag to ID3v2.4 before a write.
//
// The vendored writer (music-metadata) edits ID3v2.4 tags in place and keeps
// every frame it is not told to change. For ID3v2.2 and ID3v2.3 it offers only
// `replaceId3`, which discards every field the patch does not name: comments,
// ReplayGain TXXX frames, lyrics, play counters. This module converts the old
// tag frame by frame instead, so the writer can merge into it. Frames that have
// no ID3v2.4 form are dropped and named, so the confirm dialog can list them.
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

// ID3v2.3 frames that ID3v2.4 renamed.
const RENAME_23 = new Map([['TORY', 'TDOR'], ['IPLS', 'TIPL']]);
// ID3v2.3 frames ID3v2.4 removed with no direct replacement. TYER, TDAT and
// TIME are not listed: they merge into TDRC below.
const REMOVED_23 = new Set(['TRDA', 'TSIZ', 'EQUA', 'RVAD']);

// ID3v2.2 three-letter frames and their ID3v2.4 names.
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
]);

const PIC_FORMATS = new Map([['JPG', 'image/jpeg'], ['PNG', 'image/png'], ['GIF', 'image/gif'], ['BMP', 'image/bmp']]);

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

/** Merge TYER (YYYY), TDAT (DDMM) and TIME (HHMM) into one TDRC timestamp. */
function timestamp(yearText, dateText, timeText) {
  const year = /^\d{4}/.exec(yearText ?? '')?.[0];
  if (!year) return null;
  let out = year;
  const date = /^(\d{2})(\d{2})$/.exec(dateText ?? '');
  if (date) {
    out += `-${date[2]}-${date[1]}`;
    const time = /^(\d{2})(\d{2})$/.exec(timeText ?? '');
    if (time) out += `T${time[1]}:${time[2]}`;
  }
  return out;
}

/** ID3v2.3 date frames that fold into one ID3v2.4 TDRC timestamp. */
const DATE_PARTS_23 = { TYER: 'year', TDAT: 'date', TIME: 'time' };

/** Convert one ID3v2.3 frame, or record it in `parts` / `dropped`. Returns the v2.4 frame or null. */
function convertFrame23(id, status, format, frameBody, parts, dropped) {
  if ((format & 0x80) || (format & 0x40)) { dropped.push(id); return null; } // compressed or encrypted
  if (id in DATE_PARTS_23) { parts[DATE_PARTS_23[id]] = textFrameValue(frameBody); return null; }
  if (REMOVED_23.has(id)) { dropped.push(id); return null; }
  // ID3v2.3 status flags abc00000 move to 0abc0000; grouping 0x20 moves to 0x40.
  return encodeFrame(RENAME_23.get(id) ?? id, (status & 0xe0) >> 1, (format & 0x20) ? 0x40 : 0, frameBody);
}

function parse23(body, dropped) {
  const frames = [];
  const parts = { year: null, date: null, time: null };
  let cursor = 0;
  while (cursor + 10 <= body.length) {
    const id = ascii(body, cursor, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = u32be(body, cursor + 4);
    if (cursor + 10 + size > body.length) break;
    const status = body[cursor + 8];
    const format = body[cursor + 9];
    const frameBody = body.subarray(cursor + 10, cursor + 10 + size);
    cursor += 10 + size;
    const frame = convertFrame23(id, status, format, frameBody, parts, dropped);
    if (frame) frames.push(frame);
  }
  const tdrc = timestamp(parts.year, parts.date, parts.time);
  if (tdrc && !frames.some((frame) => ascii(frame, 0, 4) === 'TDRC')) {
    frames.unshift(encodeFrame('TDRC', 0, 0, latin1Frame(tdrc)));
  }
  return frames;
}

function parse22(body, dropped) {
  const frames = [];
  let cursor = 0;
  while (cursor + 6 <= body.length) {
    const id = ascii(body, cursor, 3);
    if (!/^[A-Z0-9]{3}$/.test(id)) break;
    const size = u24be(body, cursor + 3);
    if (cursor + 6 + size > body.length) break;
    const frameBody = body.subarray(cursor + 6, cursor + 6 + size);
    cursor += 6 + size;
    if (id === 'TYE') {
      const tdrc = timestamp(textFrameValue(frameBody), null, null);
      if (tdrc) frames.push(encodeFrame('TDRC', 0, 0, latin1Frame(tdrc)));
      continue;
    }
    if (id === 'PIC') {
      const apic = picToApic(frameBody);
      if (apic) frames.push(encodeFrame('APIC', 0, 0, apic));
      else dropped.push(id);
      continue;
    }
    const target = RENAME_22.get(id);
    if (!target) { dropped.push(id); continue; }
    frames.push(encodeFrame(target, 0, 0, frameBody));
  }
  return frames;
}

/**
 * Convert the leading ID3v2.2 or ID3v2.3 tag of `bytes` to ID3v2.4.
 *
 * Returns `{ tag, tagLength, from, dropped }`: `tag` is the new ID3v2.4 tag
 * (no padding; the writer adds its own), `tagLength` the byte length of the
 * old tag it replaces, `from` the old major version, and `dropped` the frame
 * ids that have no ID3v2.4 form. Returns null when the file has no ID3v2.2 or
 * ID3v2.3 tag. Throws for an ID3v2.2 tag marked compressed, which the
 * standard never defined.
 */
export function upgradeId3(bytes) {
  const header = readId3Header(bytes);
  if (!header || (header.major !== 2 && header.major !== 3)) return null;
  if (header.major === 2 && (header.flags & 0x40)) {
    throw new Error('This file has a compressed ID3v2.2 tag, which NakliAmp cannot convert.');
  }
  let body = bytes.subarray(10, Math.min(bytes.length, 10 + header.size));
  if (header.flags & 0x80) body = deUnsync(body);
  if (header.major === 3 && (header.flags & 0x40) && body.length >= 4) {
    body = body.subarray(Math.min(body.length, 4 + u32be(body, 0)));
  }
  const dropped = [];
  const frames = header.major === 3 ? parse23(body, dropped) : parse22(body, dropped);
  const size = frames.reduce((sum, frame) => sum + frame.length, 0);
  const tag = new Uint8Array(10 + size);
  tag.set([0x49, 0x44, 0x33, 4, 0, 0]);
  writeSyncsafe(tag, 6, size);
  let cursor = 10;
  for (const frame of frames) { tag.set(frame, cursor); cursor += frame.length; }
  return { tag, tagLength: 10 + header.size, from: header.major, dropped: [...new Set(dropped)] };
}

/** List the frame ids of an ID3v2.4 tag at the start of `bytes` (for tests and the inspector). */
export function listId3v24Frames(bytes) {
  const header = readId3Header(bytes);
  if (!header || header.major !== 4) return [];
  const out = [];
  let cursor = 10;
  const end = Math.min(bytes.length, 10 + header.size);
  while (cursor + 10 <= end) {
    const id = ascii(bytes, cursor, 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = syncsafe(bytes, cursor + 4);
    out.push({ id, body: bytes.subarray(cursor + 10, cursor + 10 + size) });
    cursor += 10 + size;
  }
  return out;
}
