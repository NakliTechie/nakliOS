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
  replayGain: null, rating: null, cuesheet: null,
});

/**
 * The version of what this reader extracts. The scanner re-reads a file whose
 * stored `parserVersion` is older, even when its size and time are unchanged,
 * so a new field (ReplayGain and ratings arrived in 2, embedded cue sheets in
 * 3) reaches old rows.
 */
export const PARSER_VERSION = 3;

// ------------------------------------------------- ReplayGain, rating ----

const REPLAY_GAIN_KEYS = new Map([
  ['REPLAYGAIN_TRACK_GAIN', 'trackGainDb'], ['REPLAYGAIN_TRACK_PEAK', 'trackPeak'],
  ['REPLAYGAIN_ALBUM_GAIN', 'albumGainDb'], ['REPLAYGAIN_ALBUM_PEAK', 'albumPeak'],
]);

/** "-6.50 dB" to -6.5. A gain outside +-60 dB is not a real gain and is dropped. */
function parseGainDb(text) {
  const match = /^\s*([+-]?\d+(?:[.,]\d+)?)/.exec(String(text ?? ''));
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && Math.abs(value) <= 60 ? value : null;
}

/** A linear sample peak. Float sources can exceed 1; past 100 it is junk. */
function parsePeak(text) {
  const match = /^\s*(\d+(?:[.,]\d+)?)/.exec(String(text ?? ''));
  if (!match) return null;
  const value = Number(match[1].replace(',', '.'));
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

/** Record one REPLAYGAIN_* value. Returns true when `key` was a ReplayGain key. */
function assignReplayGain(tags, key, value) {
  const field = REPLAY_GAIN_KEYS.get(String(key).toUpperCase());
  if (!field) return false;
  const number = field.endsWith('Db') ? parseGainDb(value) : parsePeak(value);
  if (number === null) return true;
  tags.replayGain ??= { trackGainDb: null, trackPeak: null, albumGainDb: null, albumPeak: null };
  tags.replayGain[field] ??= number;
  return true;
}

/** Opus R128_*_GAIN: a Q7.8 integer, -32768..32767. */
function assignR128(tags, key, value) {
  const upper = String(key).toUpperCase();
  if (upper !== 'R128_TRACK_GAIN' && upper !== 'R128_ALBUM_GAIN') return false;
  const text = String(value ?? '').trim();
  if (!/^[+-]?\d{1,5}$/.test(text)) return true;
  const q78 = Number(text);
  if (q78 < -32768 || q78 > 32767) return true;
  tags.r128 ??= { track: null, album: null };
  tags.r128[upper === 'R128_TRACK_GAIN' ? 'track' : 'album'] ??= q78;
  return true;
}

/**
 * Fold Opus R128 gains into the ReplayGain record where no REPLAYGAIN_* value
 * exists. R128 is relative to -23 LUFS; adding 5 dB puts it on the ReplayGain
 * 2.0 reference of -18 LUFS, which is what the engine expects.
 */
function finishR128(tags) {
  if (!tags.r128) return;
  const { track, album } = tags.r128;
  delete tags.r128;
  const toDb = q78 => Math.round((q78 / 256 + 5) * 10000) / 10000;
  if (track === null && album === null) return;
  tags.replayGain ??= { trackGainDb: null, trackPeak: null, albumGainDb: null, albumPeak: null };
  if (track !== null) tags.replayGain.trackGainDb ??= toDb(track);
  if (album !== null) tags.replayGain.albumGainDb ??= toDb(album);
}

/** ID3 POPM rating byte to 0..5 stars, on the Windows Media Player scale. */
export function popmStars(byte) {
  if (!Number.isInteger(byte) || byte <= 0) return 0;
  if (byte < 64) return 1;
  if (byte < 128) return 2;
  if (byte < 196) return 3;
  if (byte < 255) return 4;
  return 5;
}

/**
 * A text rating to 0..5 stars. FMPS_RATING is a fraction 0..1. RATING has no
 * single standard: a decimal up to 1 is a fraction, a whole number up to 5 is
 * stars, and anything up to 100 is a percentage.
 */
export function ratingFromText(value, fraction = false) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text);
  if (fraction || (number <= 1 && text.includes('.'))) return number <= 1 ? Math.round(number * 5) : null;
  if (number <= 5 && Number.isInteger(number)) return number;
  if (number <= 100) return Math.round(number / 20);
  return null;
}

function assignRating(tags, key, value) {
  const upper = String(key).toUpperCase();
  if (upper !== 'RATING' && upper !== 'FMPS_RATING') return false;
  const stars = ratingFromText(value, upper === 'FMPS_RATING');
  if (stars !== null) tags.rating ??= stars;
  return true;
}

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

/** Skip one encoding-aware NUL-terminated string from `cursor`; returns the next index. */
function skipId3String(body, cursor, encoding) {
  if (encoding === 1 || encoding === 2) {
    while (cursor + 1 < body.length && !(body[cursor] === 0 && body[cursor + 1] === 0)) cursor += 2;
    return cursor + 2;
  }
  const end = body.indexOf(0, cursor);
  return end < 0 ? body.length : end + 1;
}

/** Decode `bytes` in an ID3 encoding by prefixing the encoding byte. */
function id3Decode(encoding, bytes) {
  const framed = new Uint8Array(bytes.length + 1);
  framed[0] = encoding;
  framed.set(bytes, 1);
  return id3Text(framed);
}

/** TXXX: encoding · description NUL · value. */
function id3UserText(body) {
  if (body.length < 2) return null;
  const encoding = body[0];
  const end = skipId3String(body, 1, encoding);
  const terminator = encoding === 1 || encoding === 2 ? 2 : 1;
  const description = id3Decode(encoding, body.subarray(1, Math.max(1, end - terminator)));
  const value = id3Decode(encoding, body.subarray(Math.min(end, body.length)));
  return description ? { description, value } : null;
}

/** POPM: email NUL · rating byte · optional play counter. */
function id3Popularimeter(body) {
  const end = body.indexOf(0);
  if (end < 0 || end + 1 >= body.length) return null;
  return popmStars(body[end + 1]);
}

/**
 * SYLT: encoding · language(3) · timestamp format · content type · descriptor
 * NUL · then repeated (text NUL · 4-byte time). Rendered as LRC text so one
 * lyrics parser serves every source. Only millisecond stamps (format 2) can be
 * placed in time; anything else returns null and the caller falls back.
 */
const MAX_SYLT_LINES = 5000;
function id3SyncedLyrics(body) {
  if (body.length < 8) return null;
  const encoding = body[0];
  if (encoding > 3 || body[4] !== 2) return null;
  let cursor = skipId3String(body, 6, encoding);
  const lines = [];
  const terminator = encoding === 1 || encoding === 2 ? 2 : 1;
  while (cursor < body.length && lines.length < MAX_SYLT_LINES) {
    const end = skipId3String(body, cursor, encoding);
    if (end + 4 > body.length) break;
    const text = id3Decode(encoding, body.subarray(cursor, end - terminator)) ?? '';
    const ms = u32be(body, end);
    const minutes = Math.floor(ms / 60000);
    const seconds = ((ms % 60000) / 1000).toFixed(2).padStart(5, '0');
    lines.push(`[${String(minutes).padStart(2, '0')}:${seconds}]${text.replace(/^\n/, '')}`);
    cursor = end + 4;
  }
  return lines.length ? { synced: true, text: lines.join('\n') } : null;
}

const ID3_TEXT_FRAMES = new Map([
  ['TIT2', 'title'], ['TPE1', 'artist'], ['TALB', 'album'], ['TPE2', 'albumArtist'],
  ['TCON', 'genre'], ['TT2', 'title'], ['TP1', 'artist'], ['TAL', 'album'], ['TP2', 'albumArtist'],
]);

/** Apply a frame's value with `??=`, so the first frame of a kind wins. */
const id3Once = (field, read) => (tags, body) => { tags[field] ??= read(body); };

/** SYLT: synced lyrics win over unsynced ones, whichever frame came first. */
function applySyncedLyricsFrame(tags, body) {
  if (!tags.lyrics?.synced) tags.lyrics = id3SyncedLyrics(body) ?? tags.lyrics ?? id3Lyrics(body, true);
}

function applyUserTextFrame(tags, body) {
  const pair = id3UserText(body);
  if (pair && !assignReplayGain(tags, pair.description, pair.value)) assignRating(tags, pair.description, pair.value);
}

function applyPopularimeterFrame(tags, body) {
  const stars = id3Popularimeter(body);
  if (stars !== null) tags.rating ??= stars;
}

const applyTrackFrame = (tags, body) => assignPair(tags, 'trackNo', 'trackTotal', id3Text(body));
const applyDiscFrame = (tags, body) => assignPair(tags, 'discNo', 'discTotal', id3Text(body));
const applyYearFrame = id3Once('year', body => year(id3Text(body)));
const applyPictureFrame = id3Once('picture', id3Picture);
const applyLyricsFrame = id3Once('lyrics', body => id3Lyrics(body, false));

/** Non-text ID3 frames by id, v2.2 three-letter ids alongside v2.3/v2.4 ones. */
const ID3_FRAME_READERS = new Map([
  ['TRCK', applyTrackFrame], ['TRK', applyTrackFrame],
  ['TPOS', applyDiscFrame], ['TPA', applyDiscFrame],
  ['TDRC', applyYearFrame], ['TYER', applyYearFrame], ['TYE', applyYearFrame],
  ['APIC', applyPictureFrame], ['PIC', applyPictureFrame],
  ['USLT', applyLyricsFrame], ['ULT', applyLyricsFrame],
  ['SYLT', applySyncedLyricsFrame],
  ['TXXX', applyUserTextFrame], ['TXX', applyUserTextFrame],
  ['POPM', applyPopularimeterFrame], ['POP', applyPopularimeterFrame],
]);

function applyId3Frame(tags, id, body) {
  const textField = ID3_TEXT_FRAMES.get(id);
  if (textField) tags[textField] ??= id3Text(body);
  else ID3_FRAME_READERS.get(id)?.(tags, body);
}

/** A frame's declared size: 24-bit in v2.2, syncsafe in v2.4, plain 32-bit in v2.3. */
function id3FrameSize(region, cursor, major) {
  if (major === 2) return u24be(region, cursor + 3);
  return major === 4 ? syncsafe(region, cursor + 4) : u32be(region, cursor + 4);
}

/**
 * A frame's body. ID3v2.4 frame flag 0x01 prefixes the body with a 4-byte
 * syncsafe length. Decoding without skipping it puts four junk bytes at the
 * front of the text.
 */
function id3FrameBody(region, cursor, major, headerLength, frameSize) {
  let bodyStart = cursor + headerLength;
  let bodyLength = frameSize;
  if (major === 4 && (region[cursor + 9] & 0x01) !== 0 && bodyLength > 4) {
    bodyStart += 4;
    bodyLength -= 4;
  }
  return region.subarray(bodyStart, bodyStart + bodyLength);
}

/** Bytes to skip for an extended header (v2.3 and v2.4 only). */
function id3ExtendedSkip(region, major, extended) {
  if (!extended || major < 3) return 0;
  return major === 4 ? syncsafe(region, 0) : u32be(region, 0) + 4;
}

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
  let cursor = id3ExtendedSkip(region, major, extended);

  while (cursor + headerLength <= region.length) {
    const id = ascii(region, cursor, idLength);
    if (!/^[A-Z0-9]+$/.test(id)) break;
    const frameSize = id3FrameSize(region, cursor, major);
    if (frameSize <= 0 || cursor + headerLength + frameSize > region.length) break;
    applyId3Frame(tags, id, id3FrameBody(region, cursor, major, headerLength, frameSize));
    cursor += headerLength + frameSize;
  }
}

// ------------------------------------------------------- Vorbis comments ----

const VORBIS_FIELDS = new Map([
  ['TITLE', 'title'], ['ARTIST', 'artist'], ['ALBUM', 'album'],
  ['ALBUMARTIST', 'albumArtist'], ['ALBUM ARTIST', 'albumArtist'],
  ['GENRE', 'genre'],
]);

const vorbisOnce = (field, read) => (tags, value) => { tags[field] ??= read(value); };
const firstOfPair = value => splitPair(value)[0];
const applyVorbisTrackTotal = vorbisOnce('trackTotal', firstOfPair);
const applyVorbisDiscTotal = vorbisOnce('discTotal', firstOfPair);
const applyVorbisYear = vorbisOnce('year', year);
const applyVorbisLyrics = vorbisOnce('lyrics', value => ({ synced: /^\s*\[\d+:\d+/.test(value), text: trimNul(value) }));

/** Keys checked before the ReplayGain, R128 and rating helpers. */
const VORBIS_EARLY_KEYS = new Map([
  ['TRACKNUMBER', (tags, value) => assignPair(tags, 'trackNo', 'trackTotal', value)],
  ['TRACKTOTAL', applyVorbisTrackTotal], ['TOTALTRACKS', applyVorbisTrackTotal],
  ['DISCNUMBER', (tags, value) => assignPair(tags, 'discNo', 'discTotal', value)],
  ['DISCTOTAL', applyVorbisDiscTotal], ['TOTALDISCS', applyVorbisDiscTotal],
  ['DATE', applyVorbisYear], ['YEAR', applyVorbisYear],
  ['METADATA_BLOCK_PICTURE', vorbisOnce('pictureBase64', value => value)],
]);

/** Keys checked after those helpers. */
const VORBIS_LATE_KEYS = new Map([
  ['CUESHEET', vorbisOnce('cuesheet', trimNul)],
  ['LYRICS', applyVorbisLyrics], ['UNSYNCEDLYRICS', applyVorbisLyrics],
]);

/** Record one `KEY=value` comment on `tags`. */
function applyVorbisEntry(tags, key, value) {
  const field = VORBIS_FIELDS.get(key);
  if (field) { tags[field] ??= trimNul(value); return; }
  const early = VORBIS_EARLY_KEYS.get(key);
  if (early) { early(tags, value); return; }
  // The helpers record the value themselves when the key is theirs.
  if (assignReplayGain(tags, key, value) || assignR128(tags, key, value) || assignRating(tags, key, value)) return;
  VORBIS_LATE_KEYS.get(key)?.(tags, value);
}

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
    applyVorbisEntry(tags, entry.slice(0, split).toUpperCase(), entry.slice(split + 1));
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

/** STREAMINFO: a 20-bit sample rate, 3-bit channel count, then 36 bits of total samples. */
function readFlacStreamInfo(body, tags) {
  tags.sampleRate = ((body[10] << 12) | (body[11] << 4) | (body[12] >> 4)) || null;
  tags.channels = (((body[12] >> 1) & 0x07) + 1) || null;
  const totalSamples = ((body[13] & 0x0f) * 2 ** 32) + u32be(body, 14);
  if (tags.sampleRate && totalSamples > 0) tags.durationS = totalSamples / tags.sampleRate;
}

function applyFlacBlock(type, body, tags) {
  if (type === 0 && body.length >= 18) readFlacStreamInfo(body, tags);
  else if (type === 4) readVorbisComment(body, tags);
  else if (type === 6) tags.picture ??= readFlacPicture(body);
}

/**
 * A file may carry its art as a base64 comment rather than a picture block.
 * The comment reader captures it; decoding it here is what makes the two
 * carriers equivalent.
 */
function finishPictureComment(tags) {
  if (!tags.pictureBase64) return;
  tags.picture ??= decodePictureComment(tags.pictureBase64);
  delete tags.pictureBase64;
}

async function readFlac(blob, tags) {
  let cursor = 4;
  for (let guard = 0; guard < 128; guard += 1) {
    const header = await bytes(blob, cursor, 4);
    if (header.length < 4) return;
    const last = (header[0] & 0x80) !== 0;
    const length = u24be(header, 1);
    const body = length > 0 ? await bytes(blob, cursor + 4, length) : new Uint8Array(0);
    applyFlacBlock(header[0] & 0x7f, body, tags);
    cursor += 4 + length;
    if (last) break;
  }
  finishPictureComment(tags);
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
const OGG_PAGE_HEADER = 27;

/** One Ogg page's segment table and payload, or null when the page is not readable. */
async function readOggPage(blob, offset) {
  const header = await bytes(blob, offset, OGG_PAGE_HEADER);
  if (header.length < OGG_PAGE_HEADER || ascii(header, 0, 4) !== 'OggS') return null;
  const segmentCount = header[26];
  const table = await bytes(blob, offset + OGG_PAGE_HEADER, segmentCount);
  if (table.length < segmentCount) return null;

  let payloadLength = 0;
  for (const size of table) payloadLength += size;
  const payload = await bytes(blob, offset + OGG_PAGE_HEADER + segmentCount, payloadLength);
  return { table, payload, next: offset + OGG_PAGE_HEADER + segmentCount + payloadLength };
}

function joinParts(parts, length) {
  const complete = new Uint8Array(length);
  let written = 0;
  for (const part of parts) { complete.set(part, written); written += part.length; }
  return complete;
}

/** Feed one page's segments into the packet being built; read each packet that completes. */
function feedOggPage({ table, payload }, state, tags) {
  let cursor = 0;
  for (const size of table) {
    state.packet.push(payload.subarray(cursor, cursor + size));
    state.packetBytes += size;
    cursor += size;
    // A segment shorter than 255 terminates the packet; 255 means it continues.
    if (size === 255) continue;
    const complete = joinParts(state.packet, state.packetBytes);
    state.packet = [];
    state.packetBytes = 0;
    readOggPacket(complete, tags);
    state.emitted += 1;
    if (state.emitted >= 2) break;
  }
}

async function readOgg(blob, tags) {
  let offset = 0;
  const state = { packet: [], packetBytes: 0, emitted: 0 };

  // Two header packets carry everything: identification, then comments.
  // Bounded by pages as well as by packets: a page declaring no segments
  // advances the cursor by its header alone, so an unbounded loop is one read
  // per twenty-seven bytes of the whole file.
  for (let page = 0; page < MAX_OGG_PAGES && state.emitted < 2 && offset + OGG_PAGE_HEADER <= blob.size; page += 1) {
    const read = await readOggPage(blob, offset);
    if (!read) return;
    offset = read.next;
    feedOggPage(read, state, tags);
  }

  finishPictureComment(tags);
}

const isOpusTags = packet => packet.length > 8 && ascii(packet, 0, 8) === 'OpusTags';
const isVorbisPacket = (packet, type, minLength) => packet.length > minLength && packet[0] === type && ascii(packet, 1, 6) === 'vorbis';
const isOpusHead = packet => packet.length > 16 && ascii(packet, 0, 8) === 'OpusHead';

/** Header packet kinds, each with its test and its reader, in the order they are tried. */
const OGG_PACKETS = [
  [isOpusTags, (packet, tags) => readVorbisComment(packet.subarray(8), tags)],
  [packet => isVorbisPacket(packet, 3, 7), (packet, tags) => readVorbisComment(packet.subarray(7), tags)],
  [packet => isVorbisPacket(packet, 1, 16), (packet, tags) => {
    tags.channels = packet[11] || null;
    tags.sampleRate = u32le(packet, 12) || null;
  }],
  [isOpusHead, (packet, tags) => {
    tags.channels = packet[9] || null;
    tags.sampleRate = u32le(packet, 12) || 48000;
  }],
];

/** Dispatch one reassembled Ogg packet to the right reader. */
function readOggPacket(packet, tags) {
  OGG_PACKETS.find(([test]) => test(packet))?.[1](packet, tags);
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

const MP4_FREEFORM_PARTS = new Set(['mean', 'name', 'data']);
const MP4_CONTAINERS = new Set(['moov', 'udta', 'trak', 'mdia']);

/** iTunes freeform atom: mean (namespace) · name (key) · data (value). */
async function readMp4Freeform(blob, bodyStart, bodyEnd, tags) {
  const parts = {};
  await mp4Walk(blob, bodyStart, bodyEnd, async (partType, partStart, partEnd) => {
    if (!MP4_FREEFORM_PARTS.has(partType) || partEnd - partStart > 4096) return;
    const skip = partType === 'data' ? 8 : 4;
    if (partEnd - partStart <= skip) return;
    parts[partType] ??= trimNul(UTF8.decode(await bytes(blob, partStart + skip, partEnd - partStart - skip)));
  });
  if (parts.mean !== 'com.apple.iTunes' || !parts.name || parts.data === undefined) return;
  if (!assignReplayGain(tags, parts.name, parts.data)) assignRating(tags, parts.name, parts.data);
}

/** trkn/disk payload: reserved u16, number u16, total u16. */
function applyMp4Numeric(tags, type, payload) {
  const number = (payload[2] << 8) | payload[3];
  const total = (payload[4] << 8) | payload[5];
  // A zero here means "absent" only when the whole payload is empty, so
  // keep 0 rather than folding it to null as `|| null` would.
  if (type === 'trkn') { tags.trackNo ??= number; tags.trackTotal ??= total || null; }
  else { tags.discNo ??= number; tags.discTotal ??= total || null; }
}

function applyMp4Text(tags, type, field, text) {
  if (type === MP4_DAY) tags.year ??= year(text);
  else if (type === MP4_LYRICS) tags.lyrics ??= text ? { synced: /^\s*\[\d+:\d+/.test(text), text } : null;
  else if (field) tags[field] ??= text;
}

/** Whether an ilst item is one this reader records. */
function isWantedIlstItem(type, field, isNumeric) {
  return Boolean(field) || isNumeric || type === MP4_DAY || type === 'covr' || type === MP4_LYRICS;
}

/** Read the `data` atoms of one ilst item into `tags`. */
async function readIlstItem(blob, type, bodyStart, bodyEnd, tags) {
  const field = MP4_FIELDS.get(type);
  const isNumeric = type === 'trkn' || type === 'disk';
  if (!isWantedIlstItem(type, field, isNumeric)) return;
  await mp4Walk(blob, bodyStart, bodyEnd, async (dataType, dataStart, dataEnd) => {
    if (dataType !== 'data' || dataEnd - dataStart <= 8) return;
    const flags = u24be(await bytes(blob, dataStart + 1, 3), 0);
    const payload = await bytes(blob, dataStart + 8, dataEnd - dataStart - 8);
    if (isNumeric) applyMp4Numeric(tags, type, payload);
    else if (type === 'covr') tags.picture ??= { mime: flags === 14 ? 'image/png' : 'image/jpeg', bytes: payload };
    else applyMp4Text(tags, type, field, trimNul(UTF8.decode(payload)));
  });
}

async function readMvhd(blob, bodyStart, tags) {
  const body = await bytes(blob, bodyStart, 24);
  if (body.length < 20 || body[0] !== 0) return;
  const timescale = u32be(body, 12);
  const duration = u32be(body, 16);
  if (timescale > 0 && duration > 0) tags.durationS ??= duration / timescale;
}

async function readMp4(blob, tags) {
  const visitIlst = async (type, bodyStart, bodyEnd) => {
    if (type === '----') await readMp4Freeform(blob, bodyStart, bodyEnd, tags);
    else await readIlstItem(blob, type, bodyStart, bodyEnd, tags);
  };

  await mp4Walk(blob, 0, blob.size, async function descend(type, bodyStart, bodyEnd, depth) {
    if (type === 'ilst') {
      await mp4Walk(blob, bodyStart, bodyEnd, visitIlst, depth + 1);
    } else if (type === 'meta') {
      // `meta` is a full box: skip its version and flags before its children.
      await mp4Walk(blob, bodyStart + 4, bodyEnd, descend, depth + 1);
    } else if (MP4_CONTAINERS.has(type)) {
      await mp4Walk(blob, bodyStart, bodyEnd, descend, depth + 1);
    } else if (type === 'mvhd') {
      await readMvhd(blob, bodyStart, tags);
    }
  });
}

// ------------------------------------------------------------ WAV ----

const WAV_INFO_FIELDS = new Map([['INAM', 'title'], ['IART', 'artist'], ['IPRD', 'album'], ['IGNR', 'genre']]);

function applyWavInfo(tags, key, value) {
  const field = WAV_INFO_FIELDS.get(key);
  if (field) tags[field] ??= value;
  else if (key === 'ICRD') tags.year ??= year(value);
}

/** A LIST/INFO chunk: four-byte keys, each with a length and a Latin-1 value. */
function readWavInfo(body, tags) {
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
    applyWavInfo(tags, key, trimNul(LATIN1.decode(body.subarray(inner + 8, inner + 8 + declared))));
    inner += 8 + declared + (declared % 2);
  }
}

function applyWavChunk(id, body, tags) {
  if (id === 'fmt ' && body.length >= 16) {
    tags.channels = (body[2] | (body[3] << 8)) || null;
    tags.sampleRate = u32le(body, 4) || null;
  } else if (id === 'LIST' && ascii(body, 0, 4) === 'INFO') {
    readWavInfo(body, tags);
  }
}

async function readWav(blob, tags) {
  const region = await bytes(blob, 12, Math.min(blob.size - 12, 64 * 1024));
  let cursor = 0;
  while (cursor + 8 <= region.length) {
    const id = ascii(region, cursor, 4);
    const size = u32le(region, cursor + 4);
    applyWavChunk(id, region.subarray(cursor + 8, cursor + 8 + size), tags);
    if (size <= 0) break;
    cursor += 8 + size + (size % 2);
  }
}

// ---------------------------------------------------------- dispatch ----

/** Magic-byte tests, each with the header length it needs, in the order they are tried. */
const CONTAINER_MAGIC = [
  [4, head => ascii(head, 0, 4) === 'fLaC', 'flac'],
  [4, head => ascii(head, 0, 4) === 'OggS', 'ogg'],
  [4, head => ascii(head, 0, 4) === 'RIFF', 'wav'],
  [8, head => ascii(head, 4, 4) === 'ftyp', 'mp4'],
  [4, head => u32be(head, 0) === 0x1a45dfa3, 'matroska'],
  [3, head => ascii(head, 0, 3) === 'ID3', 'mp3'],
  [2, head => head[0] === 0xff && (head[1] & 0xe0) === 0xe0, 'mp3'],
];

/** Sniff the container from magic bytes rather than trusting the file name. */
function sniff(head) {
  const match = CONTAINER_MAGIC.find(([minLength, test]) => head.length >= minLength && test(head));
  return match ? match[2] : null;
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
  finishR128(tags);
  return tags;
}

/**
 * The embedded lyrics of an audio Blob, read on demand: USLT, SYLT (rendered
 * as LRC lines), Vorbis LYRICS or UNSYNCEDLYRICS, MP4 lyr. The scanner keeps
 * only a flag, so the text costs one tag read when the lyrics view opens.
 * Returns text or null; never throws.
 */
export async function readLyricsText(blob) {
  const tags = await readTags(blob);
  return tags.lyrics?.text ?? null;
}

/** Strip the extension so a tagless file still has a readable title. */
export function titleFromName(name) {
  return String(name || '').replace(/\.[^.]+$/, '').trim() || 'Untitled track';
}

export { EMPTY as EMPTY_TAGS };
