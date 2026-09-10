// NakliAmp metadata reader — D2: minimal, in-house, four parser families.
// ID3v2.3/2.4 · Vorbis comments (FLAC + Ogg) · MP4 `ilst` · FLAC pictures.
// Headless by contract: no DOM, no engine import, no network. Reads only the
// byte ranges each container needs so a 1k-track scan never reads 1k files whole.

const UTF8 = new TextDecoder('utf-8');
const LATIN1 = new TextDecoder('latin1');
const UTF16 = new TextDecoder('utf-16le');
const UTF16BE = new TextDecoder('utf-16be');

const COPYRIGHT = String.fromCharCode(0xa9); // the MP4 `©` atom-name prefix

/**
 * Budgets on what a file gets to ask this module to do.
 *
 * Every one of these is read out of a header, so every one is written by
 * whoever made the file. The header above promises a scan never reads a
 * thousand files whole; an ID3 size field of `7F 7F 7F 7F` claims 256 MB, and
 * with no cap that promise was simply false. The walk budgets bound work
 * rather than memory: an Ogg page declaring no segments, or a chain of
 * minimum-size MP4 atoms, is one asynchronous read per eight bytes of file.
 */
const MAX_ID3_BYTES = 4 * 1024 * 1024;   // comfortably past any embedded cover
const MAX_OGG_PAGES = 64;                // the comment packet is in the first few
const MAX_MP4_ATOMS = 4096;              // per level of the tree

const EMPTY = Object.freeze({
  title: null, artist: null, album: null, albumArtist: null,
  trackNo: null, trackTotal: null, discNo: null, discTotal: null,
  year: null, genre: null, durationS: null, sampleRate: null, channels: null,
  lyrics: null, picture: null, container: null,
});

/** Read `length` bytes from `blob` at `offset`. */
async function bytes(blob, offset, length) {
  if (offset < 0 || length <= 0 || offset >= blob.size) return new Uint8Array(0);
  const slice = blob.slice(offset, Math.min(blob.size, offset + length));
  return new Uint8Array(await slice.arrayBuffer());
}

function ascii(buffer, offset, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(buffer[offset + index]);
  return out;
}

function u32be(buffer, offset) {
  return ((buffer[offset] << 24) | (buffer[offset + 1] << 16) | (buffer[offset + 2] << 8) | buffer[offset + 3]) >>> 0;
}

function u32le(buffer, offset) {
  return (buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16) | (buffer[offset + 3] << 24)) >>> 0;
}

function u24be(buffer, offset) {
  return (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];
}

/** ID3 sizes are syncsafe: seven significant bits per byte. */
function syncsafe(buffer, offset) {
  return ((buffer[offset] & 0x7f) << 21) | ((buffer[offset + 1] & 0x7f) << 14)
    | ((buffer[offset + 2] & 0x7f) << 7) | (buffer[offset + 3] & 0x7f);
}

function trimNul(value) {
  const text = String(value ?? '').replace(/\0+$/, '').trim();
  return text.length ? text : null;
}

/** Split "3/12" into [3, 12]; tolerate a bare "3". */
function splitPair(value) {
  const text = trimNul(value);
  if (!text) return [null, null];
  const [left, right] = text.split('/');
  const first = Number.parseInt(left, 10);
  const second = Number.parseInt(right ?? '', 10);
  return [Number.isFinite(first) ? first : null, Number.isFinite(second) ? second : null];
}

/**
 * Assign a "number/total" pair without destroying what is already known.
 * Vorbis comments are unordered and a tag may repeat, so a later malformed or
 * partial value must never wipe a good earlier one.
 */
function assignPair(tags, numberField, totalField, value) {
  const [number, total] = splitPair(value);
  if (number !== null) tags[numberField] ??= number;
  if (total !== null) tags[totalField] ??= total;
}

function year(value) {
  const match = /(\d{4})/.exec(String(value ?? ''));
  return match ? Number.parseInt(match[1], 10) : null;
}

// ---------------------------------------------------------------- ID3v2 ----

/** Decode an ID3 text frame body, whose first byte names the encoding. */
function id3Text(body) {
  if (!body.length) return null;
  const payload = body.subarray(1);
  switch (body[0]) {
    case 0: return trimNul(LATIN1.decode(payload));
    case 1: {
      if (payload[0] === 0xff && payload[1] === 0xfe) return trimNul(UTF16.decode(payload.subarray(2)));
      if (payload[0] === 0xfe && payload[1] === 0xff) return trimNul(UTF16BE.decode(payload.subarray(2)));
      return trimNul(UTF16.decode(payload));
    }
    case 2: return trimNul(UTF16BE.decode(payload));
    default: return trimNul(UTF8.decode(payload));
  }
}

/** APIC: encoding · mime NUL · picture type · description NUL · image bytes. */
function id3Picture(body) {
  if (body.length < 4) return null;
  let cursor = 1;
  const mimeEnd = body.indexOf(0, cursor);
  if (mimeEnd < 0) return null;
  const mime = LATIN1.decode(body.subarray(cursor, mimeEnd)) || 'image/jpeg';
  cursor = mimeEnd + 1 + 1; // skip the terminator and the picture-type byte
  if (body[0] === 1 || body[0] === 2) {
    while (cursor + 1 < body.length && !(body[cursor] === 0 && body[cursor + 1] === 0)) cursor += 2;
    cursor += 2;
  } else {
    const descriptionEnd = body.indexOf(0, cursor);
    if (descriptionEnd < 0) return null;
    cursor = descriptionEnd + 1;
  }
  if (cursor >= body.length) return null;
  return { mime: mime.includes('/') ? mime : `image/${mime.toLowerCase()}`, bytes: body.slice(cursor) };
}

/** USLT/SYLT: encoding · 3-byte language · descriptor NUL · text. */
function id3Lyrics(body, synced) {
  if (body.length < 5) return null;
  const encoding = body[0];
  let cursor = 4;
  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < body.length && !(body[cursor] === 0 && body[cursor + 1] === 0)) cursor += 2;
    cursor += 2;
  } else {
    const end = body.indexOf(0, cursor);
    cursor = end < 0 ? body.length : end + 1;
  }
  const tail = body.subarray(cursor);
  const framed = new Uint8Array(tail.length + 1);
  framed[0] = encoding;
  framed.set(tail, 1);
  const text = id3Text(framed);
  return text ? { synced, text } : null;
}

const ID3_TEXT_FRAMES = new Map([
  ['TIT2', 'title'], ['TPE1', 'artist'], ['TALB', 'album'], ['TPE2', 'albumArtist'],
  ['TCON', 'genre'], ['TT2', 'title'], ['TP1', 'artist'], ['TAL', 'album'], ['TP2', 'albumArtist'],
]);

async function readId3(blob, tags) {
  const header = await bytes(blob, 0, 10);
  if (header.length < 10 || ascii(header, 0, 3) !== 'ID3') return;
  const major = header[3];
  const size = syncsafe(header, 6);
  const extended = (header[5] & 0x40) !== 0;
  // Truncating loses frames past the cap — an oversized embedded picture,
  // usually — and keeps everything before it. Reading the whole file to find
  // out is the worse trade on a thousand-track scan.
  const region = await bytes(blob, 10, Math.min(size, MAX_ID3_BYTES));
  const idLength = major === 2 ? 3 : 4;
  const headerLength = major === 2 ? 6 : 10;
  let cursor = 0;
  if (extended && major >= 3) cursor += major === 4 ? syncsafe(region, 0) : u32be(region, 0) + 4;

  while (cursor + headerLength <= region.length) {
    const id = ascii(region, cursor, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = major === 2
      ? u24be(region, cursor + 3)
      : (major === 4 ? syncsafe(region, cursor + 4) : u32be(region, cursor + 4));
    if (frameSize <= 0 || cursor + headerLength + frameSize > region.length) break;
    let bodyStart = cursor + headerLength;
    let bodyLength = frameSize;
    // ID3v2.4 frame flag 0x01 prefixes the body with a 4-byte syncsafe length.
    // Decoding without skipping it puts four junk bytes at the front of the text.
    if (major === 4 && (region[cursor + 9] & 0x01) !== 0 && bodyLength > 4) {
      bodyStart += 4;
      bodyLength -= 4;
    }
    const body = region.subarray(bodyStart, bodyStart + bodyLength);

    const textField = ID3_TEXT_FRAMES.get(id);
    if (textField) tags[textField] ??= id3Text(body);
    else if (id === 'TRCK' || id === 'TRK') assignPair(tags, 'trackNo', 'trackTotal', id3Text(body));
    else if (id === 'TPOS' || id === 'TPA') assignPair(tags, 'discNo', 'discTotal', id3Text(body));
    else if (id === 'TDRC' || id === 'TYER' || id === 'TYE') tags.year ??= year(id3Text(body));
    else if (id === 'APIC' || id === 'PIC') tags.picture ??= id3Picture(body);
    else if (id === 'USLT' || id === 'ULT') tags.lyrics ??= id3Lyrics(body, false);
    else if (id === 'SYLT') tags.lyrics ??= id3Lyrics(body, true);

    cursor += headerLength + frameSize;
  }
}

// ------------------------------------------------------- Vorbis comments ----

const VORBIS_FIELDS = new Map([
  ['TITLE', 'title'], ['ARTIST', 'artist'], ['ALBUM', 'album'],
  ['ALBUMARTIST', 'albumArtist'], ['ALBUM ARTIST', 'albumArtist'],
  ['GENRE', 'genre'],
]);

/** A Vorbis comment block: vendor string, then count, then `KEY=value` entries. */
function readVorbisComment(block, tags) {
  if (block.length < 8) return;
  let cursor = 4 + u32le(block, 0);
  if (cursor + 4 > block.length) return;
  const count = u32le(block, cursor);
  cursor += 4;
  for (let index = 0; index < count && cursor + 4 <= block.length; index += 1) {
    const length = u32le(block, cursor);
    cursor += 4;
    if (length <= 0 || cursor + length > block.length) break;
    const entry = UTF8.decode(block.subarray(cursor, cursor + length));
    cursor += length;
    const split = entry.indexOf('=');
    if (split < 0) continue;
    const key = entry.slice(0, split).toUpperCase();
    const value = entry.slice(split + 1);

    const field = VORBIS_FIELDS.get(key);
    if (field) tags[field] ??= trimNul(value);
    else if (key === 'TRACKNUMBER') assignPair(tags, 'trackNo', 'trackTotal', value);
    else if (key === 'TRACKTOTAL' || key === 'TOTALTRACKS') tags.trackTotal ??= splitPair(value)[0];
    else if (key === 'DISCNUMBER') assignPair(tags, 'discNo', 'discTotal', value);
    else if (key === 'DISCTOTAL' || key === 'TOTALDISCS') tags.discTotal ??= splitPair(value)[0];
    else if (key === 'DATE' || key === 'YEAR') tags.year ??= year(value);
    else if (key === 'METADATA_BLOCK_PICTURE') tags.pictureBase64 ??= value;
    else if (key === 'LYRICS' || key === 'UNSYNCEDLYRICS') {
      tags.lyrics ??= { synced: /^\s*\[\d+:\d+/.test(value), text: trimNul(value) };
    }
  }
}

/** FLAC METADATA_BLOCK_PICTURE, also used base64-wrapped inside Ogg comments. */
function readFlacPicture(block) {
  if (block.length < 32) return null;
  let cursor = 4; // picture type
  const mimeLength = u32be(block, cursor);
  cursor += 4;
  // The MIME type is file-supplied and ends up in `new Blob({ type })` and
  // then `createObjectURL`, so its shape is checked rather than trusted. FLAC
  // also allows `-->`, meaning the "picture" is a URL; this reader deals in
  // bytes, so that is not a picture it can show.
  const declaredMime = LATIN1.decode(block.subarray(cursor, cursor + Math.min(mimeLength, 255)));
  if (mimeLength > 255 || !/^image\/[a-z0-9.+-]{1,32}$/i.test(declaredMime)) return null;
  const mime = declaredMime;
  cursor += mimeLength;
  const descriptionLength = u32be(block, cursor);
  cursor += 4 + descriptionLength;
  cursor += 16; // width, height, depth, indexed-colour count
  if (cursor + 4 > block.length) return null;
  const dataLength = u32be(block, cursor);
  cursor += 4;
  if (dataLength <= 0 || cursor + dataLength > block.length) return null;
  return { mime, bytes: block.slice(cursor, cursor + dataLength) };
}

async function readFlac(blob, tags) {
  let cursor = 4;
  for (let guard = 0; guard < 128; guard += 1) {
    const header = await bytes(blob, cursor, 4);
    if (header.length < 4) return;
    const last = (header[0] & 0x80) !== 0;
    const type = header[0] & 0x7f;
    const length = u24be(header, 1);
    const body = length > 0 ? await bytes(blob, cursor + 4, length) : new Uint8Array(0);

    if (type === 0 && body.length >= 18) {
      // STREAMINFO: a 20-bit sample rate, 3-bit channel count, then 36 bits of total samples.
      tags.sampleRate = ((body[10] << 12) | (body[11] << 4) | (body[12] >> 4)) || null;
      tags.channels = (((body[12] >> 1) & 0x07) + 1) || null;
      const totalSamples = ((body[13] & 0x0f) * 2 ** 32) + u32be(body, 14);
      if (tags.sampleRate && totalSamples > 0) tags.durationS = totalSamples / tags.sampleRate;
    } else if (type === 4) readVorbisComment(body, tags);
    else if (type === 6) tags.picture ??= readFlacPicture(body);

    cursor += 4 + length;
    if (last) break;
  }
  // A FLAC file may carry its art as a base64 comment rather than a picture
  // block. The comment reader captures it; decoding it here is what makes the
  // two carriers equivalent.
  if (tags.pictureBase64) {
    tags.picture ??= decodePictureComment(tags.pictureBase64);
    delete tags.pictureBase64;
  }
}

// -------------------------------------------------------------- Ogg ----

/** Decode a base64 Vorbis picture comment into a picture record. */
function decodePictureComment(base64) {
  try {
    const binary = atob(base64);
    const raw = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) raw[index] = binary.charCodeAt(index);
    return readFlacPicture(raw);
  } catch {
    return null; // a malformed picture comment is not a reason to fail the track
  }
}

/**
 * Read Ogg header packets, honouring the segment-table lacing.
 *
 * A packet is a run of segments ending in one shorter than 255, and it may run
 * past the end of a page onto the next. Treating one page's payload as one
 * packet truncates any comment header larger than a page, which is the normal
 * shape once cover art is embedded.
 *
 * Pages are read one at a time rather than in one large slab, so a tagged Ogg
 * costs a few kilobytes of reads regardless of how large the file is.
 */
async function readOgg(blob, tags) {
  const PAGE_HEADER = 27;
  let offset = 0;
  let packet = [];
  let packetBytes = 0;
  let emitted = 0;

  // Two header packets carry everything: identification, then comments.
  // Bounded by pages as well as by packets: a page declaring no segments
  // advances the cursor by its header alone, so an unbounded loop is one read
  // per twenty-seven bytes of the whole file.
  for (let page = 0; page < MAX_OGG_PAGES && emitted < 2 && offset + PAGE_HEADER <= blob.size; page += 1) {
    const header = await bytes(blob, offset, PAGE_HEADER);
    if (header.length < PAGE_HEADER || ascii(header, 0, 4) !== 'OggS') return;
    const segmentCount = header[26];
    const table = await bytes(blob, offset + PAGE_HEADER, segmentCount);
    if (table.length < segmentCount) return;

    let payloadLength = 0;
    for (const size of table) payloadLength += size;
    const payload = await bytes(blob, offset + PAGE_HEADER + segmentCount, payloadLength);
    offset += PAGE_HEADER + segmentCount + payloadLength;

    let cursor = 0;
    for (const size of table) {
      packet.push(payload.subarray(cursor, cursor + size));
      packetBytes += size;
      cursor += size;
      // A segment shorter than 255 terminates the packet; 255 means it continues.
      if (size === 255) continue;
      const complete = new Uint8Array(packetBytes);
      let written = 0;
      for (const part of packet) { complete.set(part, written); written += part.length; }
      packet = [];
      packetBytes = 0;
      readOggPacket(complete, tags);
      emitted += 1;
      if (emitted >= 2) break;
    }
  }

  if (tags.pictureBase64) {
    tags.picture ??= decodePictureComment(tags.pictureBase64);
    delete tags.pictureBase64;
  }
}

/** Dispatch one reassembled Ogg packet to the right reader. */
function readOggPacket(packet, tags) {
  if (packet.length > 8 && ascii(packet, 0, 8) === 'OpusTags') {
    readVorbisComment(packet.subarray(8), tags);
  } else if (packet.length > 7 && packet[0] === 3 && ascii(packet, 1, 6) === 'vorbis') {
    readVorbisComment(packet.subarray(7), tags);
  } else if (packet.length > 16 && packet[0] === 1 && ascii(packet, 1, 6) === 'vorbis') {
    tags.channels = packet[11] || null;
    tags.sampleRate = u32le(packet, 12) || null;
  } else if (packet.length > 16 && ascii(packet, 0, 8) === 'OpusHead') {
    tags.channels = packet[9] || null;
    tags.sampleRate = u32le(packet, 12) || 48000;
  }
}

// -------------------------------------------------------------- MP4 ----

const MP4_FIELDS = new Map([
  [`${COPYRIGHT}nam`, 'title'], [`${COPYRIGHT}ART`, 'artist'], [`${COPYRIGHT}alb`, 'album'],
  ['aART', 'albumArtist'], [`${COPYRIGHT}gen`, 'genre'],
]);
const MP4_DAY = `${COPYRIGHT}day`;
const MP4_LYRICS = `${COPYRIGHT}lyr`;

/** Walk an atom list, calling `visit(type, bodyStart, bodyEnd, depth)`. */
async function mp4Walk(blob, start, end, visit, depth = 0) {
  if (depth > 8) return;
  let cursor = start;
  // Atom-count bound as well as a depth bound: a run of minimum-size atoms is
  // one asynchronous read per eight bytes of file, which is real disk I/O.
  for (let atom = 0; atom < MAX_MP4_ATOMS && cursor + 8 <= end; atom += 1) {
    const header = await bytes(blob, cursor, 8);
    if (header.length < 8) return;
    let size = u32be(header, 0);
    const type = ascii(header, 4, 4);
    let headerSize = 8;
    if (size === 1) {
      const large = await bytes(blob, cursor + 8, 8);
      size = u32be(large, 0) * 2 ** 32 + u32be(large, 4);
      headerSize = 16;
    }
    if (size === 0) size = end - cursor;
    if (size < headerSize || cursor + size > end) return;
    await visit(type, cursor + headerSize, cursor + size, depth);
    cursor += size;
  }
}

async function readMp4(blob, tags) {
  const visitIlst = async (type, bodyStart, bodyEnd) => {
    const field = MP4_FIELDS.get(type);
    const isNumeric = type === 'trkn' || type === 'disk';
    if (!field && !isNumeric && type !== MP4_DAY && type !== 'covr' && type !== MP4_LYRICS) return;
    await mp4Walk(blob, bodyStart, bodyEnd, async (dataType, dataStart, dataEnd) => {
      if (dataType !== 'data' || dataEnd - dataStart <= 8) return;
      const flags = u24be(await bytes(blob, dataStart + 1, 3), 0);
      const payload = await bytes(blob, dataStart + 8, dataEnd - dataStart - 8);
      if (isNumeric) {
        // trkn/disk payload: reserved u16, number u16, total u16.
        const number = (payload[2] << 8) | payload[3];
        const total = (payload[4] << 8) | payload[5];
        // A zero here means "absent" only when the whole payload is empty, so
        // keep 0 rather than folding it to null as `|| null` would.
        if (type === 'trkn') { tags.trackNo ??= number; tags.trackTotal ??= total || null; }
        else { tags.discNo ??= number; tags.discTotal ??= total || null; }
        return;
      }
      if (type === 'covr') {
        tags.picture ??= { mime: flags === 14 ? 'image/png' : 'image/jpeg', bytes: payload };
        return;
      }
      const text = trimNul(UTF8.decode(payload));
      if (type === MP4_DAY) tags.year ??= year(text);
      else if (type === MP4_LYRICS) tags.lyrics ??= text ? { synced: /^\s*\[\d+:\d+/.test(text), text } : null;
      else if (field) tags[field] ??= text;
    });
  };

  await mp4Walk(blob, 0, blob.size, async function descend(type, bodyStart, bodyEnd, depth) {
    if (type === 'ilst') {
      await mp4Walk(blob, bodyStart, bodyEnd, visitIlst, depth + 1);
    } else if (type === 'meta') {
      // `meta` is a full box: skip its version and flags before its children.
      await mp4Walk(blob, bodyStart + 4, bodyEnd, descend, depth + 1);
    } else if (type === 'moov' || type === 'udta' || type === 'trak' || type === 'mdia') {
      await mp4Walk(blob, bodyStart, bodyEnd, descend, depth + 1);
    } else if (type === 'mvhd') {
      const body = await bytes(blob, bodyStart, 24);
      if (body.length >= 20 && body[0] === 0) {
        const timescale = u32be(body, 12);
        const duration = u32be(body, 16);
        if (timescale > 0 && duration > 0) tags.durationS ??= duration / timescale;
      }
    }
  });
}

// ------------------------------------------------------------ WAV ----

async function readWav(blob, tags) {
  const region = await bytes(blob, 12, Math.min(blob.size - 12, 64 * 1024));
  let cursor = 0;
  while (cursor + 8 <= region.length) {
    const id = ascii(region, cursor, 4);
    const size = u32le(region, cursor + 4);
    const body = region.subarray(cursor + 8, cursor + 8 + size);
    if (id === 'fmt ' && body.length >= 16) {
      tags.channels = (body[2] | (body[3] << 8)) || null;
      tags.sampleRate = u32le(body, 4) || null;
    } else if (id === 'LIST' && ascii(body, 0, 4) === 'INFO') {
      let inner = 4;
      while (inner + 8 <= body.length) {
        const key = ascii(body, inner, 4);
        // A field declaring more length than its chunk holds used to read
        // straight through the fields after it — their four-byte binary length
        // words included — into the library index, which is where the user
        // then read it as a title. Nothing after such a field can be located,
        // so the walk stops rather than guessing.
        const declared = u32le(body, inner + 4);
        if (declared <= 0 || declared > body.length - (inner + 8)) break;
        const value = trimNul(LATIN1.decode(body.subarray(inner + 8, inner + 8 + declared)));
        if (key === 'INAM') tags.title ??= value;
        else if (key === 'IART') tags.artist ??= value;
        else if (key === 'IPRD') tags.album ??= value;
        else if (key === 'IGNR') tags.genre ??= value;
        else if (key === 'ICRD') tags.year ??= year(value);
        inner += 8 + declared + (declared % 2);
      }
    }
    if (size <= 0) break;
    cursor += 8 + size + (size % 2);
  }
}

// ---------------------------------------------------------- dispatch ----

/** Sniff the container from magic bytes rather than trusting the file name. */
function sniff(head) {
  if (head.length >= 4 && ascii(head, 0, 4) === 'fLaC') return 'flac';
  if (head.length >= 4 && ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (head.length >= 4 && ascii(head, 0, 4) === 'RIFF') return 'wav';
  if (head.length >= 8 && ascii(head, 4, 4) === 'ftyp') return 'mp4';
  if (head.length >= 4 && u32be(head, 0) === 0x1a45dfa3) return 'matroska';
  if (head.length >= 3 && ascii(head, 0, 3) === 'ID3') return 'mp3';
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

/**
 * Read tags from an audio Blob or File.
 * Never throws on malformed input — an unreadable tag block yields nulls, so a
 * damaged file still becomes a library row instead of failing the whole scan.
 */
export async function readTags(blob) {
  const tags = { ...EMPTY };
  try {
    const head = await bytes(blob, 0, 16);
    const container = sniff(head);
    tags.container = container;
    if (container === 'mp3') await readId3(blob, tags);
    else if (container === 'flac') await readFlac(blob, tags);
    else if (container === 'ogg') await readOgg(blob, tags);
    else if (container === 'mp4') await readMp4(blob, tags);
    else if (container === 'wav') await readWav(blob, tags);
    // Matroska keeps tags in an EBML tree that Reel already parses, so D2 does
    // not duplicate that parser and MKA falls back to the file name.
  } catch {
    // Deliberately swallowed: see the doc comment. The caller gets nulls.
  }
  delete tags.pictureBase64;
  return tags;
}

/** Strip the extension so a tagless file still has a readable title. */
export function titleFromName(name) {
  return String(name || '').replace(/\.[^.]+$/, '').trim() || 'Untitled track';
}

export { EMPTY as EMPTY_TAGS };
