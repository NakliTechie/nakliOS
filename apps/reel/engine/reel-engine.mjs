import {
  AudioSampleSink,
  BlobSource,
  EncodedPacketSink,
  FLAC,
  Input,
  MATROSKA,
  MP3,
  MP4,
  MPEG_TS,
  OGG,
  QTFF,
  StreamSource,
  WAVE,
  WEBM,
} from '../vendor/mediabunny/mediabunny-1.66.0.min.mjs';

const MEDIABUNNY_VERSION = '1.66.0';

/* The software audio rung: Mediabunny's own extension packages, vendored unmodified
   and imported lazily by the Demux wrapper only when a file needs them. */
const SOFTWARE_AUDIO_PACKAGES = Object.freeze([
  Object.freeze({
    id: 'ac3',
    codecs: Object.freeze(['ac3', 'eac3']),
    path: '../vendor/mediabunny-ac3/mediabunny-ac3-1.66.0.min.mjs',
    bytes: 1_177_625,
    sha256: '6a0befc4f1a4f8f0cfab40e027509da5a07f2dfd9c6b9c71905245ce9839e409',
    register: 'registerAc3Decoder',
    name: 'AC-3 and E-AC-3 audio decoder (@mediabunny/ac3 1.66.0)',
    licence: 'MPL-2.0; contains FFmpeg under LGPL-2.1-or-later',
  }),
  Object.freeze({
    id: 'dts',
    codecs: Object.freeze(['dts']),
    path: '../vendor/mediabunny-dts/mediabunny-dts-1.66.0.min.mjs',
    bytes: 1_655_248,
    sha256: '0d90039f92b802a65ce575803ca7fee35ba1a6623ce4a8d5a010d8d0a35a5293',
    register: 'registerDtsDecoder',
    name: 'DTS audio decoder (@mediabunny/dts 1.66.0)',
    licence: 'MPL-2.0; contains FFmpeg under LGPL-2.1-or-later',
  }),
]);

/** File extensions the engine opens; each one passes the golden gate. */
const SUPPORTED_EXTENSIONS = Object.freeze([
  '.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts',
  // Opened through engine/libav-rung.mjs (rows O7, E7); refused by name without it.
  '.avi', '.flv', '.wmv', '.asf', '.mpg', '.mpeg', '.vob',
]);

/* Ranged readers (batch 3, additive): `load`, `probe`, thumbnails and audioPcm also accept
   `{ name, size, type?, read(offset, length) -> Promise<Uint8Array | ArrayBuffer> }`, for hosts
   that serve bytes on request (NakliOS `naklios.fs.readBinary` with an offset). The engine never
   asks a reader for more than RANGED_READ_LIMIT bytes in one call and never holds the whole file. */
export const RANGED_READ_LIMIT = 16 * 1024 * 1024;

export function isRangedReader(value) {
  return !!value && typeof value === 'object'
    && !(typeof Blob === 'function' && value instanceof Blob)
    && !(value instanceof RangedFile)
    && typeof value.getFile !== 'function'
    && typeof value.read === 'function'
    && Number.isSafeInteger(value.size) && value.size >= 0;
}

/* Exactly `length` bytes from `offset` (clamped to the reader's size), in calls of at most
   RANGED_READ_LIMIT bytes. A reader that returns the wrong length is a read error, not EOF. */
export async function readRanged(reader, offset, length) {
  const start = Math.max(0, Math.min(reader.size, Math.floor(offset)));
  const end = Math.max(start, Math.min(reader.size, start + Math.max(0, Math.floor(length))));
  const out = new Uint8Array(end - start);
  let at = start;
  while (at < end) {
    const want = Math.min(RANGED_READ_LIMIT, end - at);
    let bytes = await reader.read(at, want);
    if (bytes instanceof ArrayBuffer) bytes = new Uint8Array(bytes);
    else if (ArrayBuffer.isView(bytes) && !(bytes instanceof Uint8Array)) {
      bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    }
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== want) {
      throw new DemuxError(
        'RangedReadError',
        'ERR_DEMUX_RANGED_READ',
        `Reading ${reader.name || 'the file'} at byte ${at} returned ${bytes?.byteLength ?? 'nothing'} of ${want} bytes.`,
      );
    }
    out.set(bytes, at - start);
    at += want;
  }
  return out;
}

/* A Blob-shaped view over a ranged reader: `slice(a, b)` and `arrayBuffer()` as Blob has them,
   so the engine's scanners (Matroska cues, MP4 text, fingerprint) read it like a File. It is
   not a Blob: code that must post bytes to a worker (the libav rung) refuses it by name. */
export class RangedFile {
  constructor(reader, start = 0, end = reader.size, type = reader.type || '') {
    this.reader = reader;
    this.start = start;
    this.end = end;
    this.type = type;
  }

  get name() { return this.reader.name || 'untitled'; }

  get size() { return this.end - this.start; }

  slice(start = 0, end = this.size, contentType = this.type) {
    const relative = (value, fallback) => {
      const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
      return n < 0 ? Math.max(this.size + n, 0) : Math.min(n, this.size);
    };
    const from = relative(start, 0);
    const to = Math.max(from, relative(end, this.size));
    return new RangedFile(this.reader, this.start + from, this.start + to, contentType);
  }

  async bytes() { return readRanged(this.reader, this.start, this.size); }

  async arrayBuffer() { return (await this.bytes()).buffer; }
}

/* Embedded subtitle text (review V18): UTF-8 when it decodes cleanly, otherwise
   Windows-1252 (older Matroska files hold Latin-1 SRT), so one bad byte costs one
   cue's accents rather than the whole track. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });
const legacyText = (() => {
  try { return new TextDecoder('windows-1252'); } catch (_) { return new TextDecoder('utf-8'); }
})();
export function decodeSubtitleText(bytes) {
  try {
    return strictUtf8.decode(bytes);
  } catch (_) {
    return legacyText.decode(bytes);
  }
}

/* A cue with no duration ends where the next cue starts, at most 5 s after its own
   start (review V52), so a last cue without a duration does not stay to the end. */
export const MAX_FILLED_CUE_S = 5;
export function fillCueEnds(cues, mediaDuration) {
  cues.sort((left, right) => left.startS - right.startS);
  for (let index = 0; index < cues.length; index += 1) {
    const cue = cues[index];
    if (cue.endS === null || cue.endS === undefined) {
      const nextStart = cues[index + 1]?.startS;
      const limit = Number.isFinite(nextStart) ? nextStart : Math.max(cue.startS, mediaDuration);
      cue.endS = Math.min(limit, cue.startS + MAX_FILLED_CUE_S);
    }
    cue.startS = Math.max(0, cue.startS);
    cue.endS = Math.max(cue.startS, cue.endS);
  }
  return cues;
}

/* Bitmap tracks: FFmpeg writes one block per PGS segment, so blocks sharing a timestamp
   form one display set. The parts are joined once per set (review V15: joining as each
   block arrived copied the growing buffer every time), a set over `maxBytes` is dropped,
   and each set ends where the next later set starts. */
export function joinDisplaySets(blocks, mediaDuration, maxBytes = 8 * 1024 * 1024) {
  blocks.sort((left, right) => left.startS - right.startS);
  const groups = [];
  for (const block of blocks) {
    const last = groups.at(-1);
    if (last && Math.abs(last.startS - block.startS) < 1e-6) {
      last.parts.push(block.data);
      last.bytes += block.data.byteLength;
      if (block.endS !== null && block.endS !== undefined) last.endS = Math.max(last.endS ?? block.endS, block.endS);
    } else {
      groups.push({ startS: block.startS, endS: block.endS ?? null, parts: [block.data], bytes: block.data.byteLength });
    }
  }
  const sets = [];
  for (const group of groups) {
    if (group.bytes > maxBytes) continue;
    let data = group.parts[0];
    if (group.parts.length > 1) {
      data = new Uint8Array(group.bytes);
      let at = 0;
      for (const part of group.parts) {
        data.set(part, at);
        at += part.byteLength;
      }
    }
    sets.push({ startS: group.startS, endS: group.endS, data });
  }
  for (let index = 0; index < sets.length; index += 1) {
    const set = sets[index];
    set.startS = Math.max(0, set.startS);
    if (set.endS === null || set.endS <= set.startS) {
      const next = sets[index + 1]?.startS;
      set.endS = Number.isFinite(next) ? next : Math.max(set.startS, mediaDuration);
    }
  }
  return sets;
}

/* Which Matroska attachments to read as fonts (review V17): font types only, by MIME type
   or file extension; an oversize font or one past the count or total cap is skipped by
   name, never thrown, so one large cover image no longer removes every font. */
const FONT_MIME_TYPES = new Set([
  'font/ttf', 'font/otf', 'font/sfnt', 'font/woff', 'font/woff2', 'font/collection',
  'application/x-truetype-font', 'application/x-font-ttf', 'application/x-font-truetype',
  'application/x-font-otf', 'application/x-font-opentype', 'application/vnd.ms-opentype',
  'application/font-sfnt', 'application/font-woff', 'application/x-font',
]);
const FONT_EXTENSION = /\.(ttf|otf|ttc|otc|woff2?)$/i;
export function isFontAttachment({ name = '', mimeType = '' } = {}) {
  return FONT_MIME_TYPES.has(String(mimeType).toLowerCase()) || FONT_EXTENSION.test(String(name));
}
export function planFontAttachments(entries, {
  maxFileBytes = 32 * 1024 * 1024,
  maxTotalBytes = 64 * 1024 * 1024,
  maxFiles = 64,
} = {}) {
  const fonts = [];
  const skipped = [];
  let total = 0;
  for (const entry of entries) {
    const summary = { name: entry.name, mimeType: entry.mimeType, bytes: entry.bytes };
    if (!isFontAttachment(entry)) skipped.push({ ...summary, reason: 'not-font' });
    else if (entry.bytes > maxFileBytes) skipped.push({ ...summary, reason: 'too-large' });
    else if (fonts.length >= maxFiles) skipped.push({ ...summary, reason: 'too-many' });
    else if (total + entry.bytes > maxTotalBytes) skipped.push({ ...summary, reason: 'total-too-large' });
    else {
      fonts.push(entry);
      total += entry.bytes;
    }
  }
  return { fonts, skipped };
}

/* Where a decoded audio sample goes on the ring's timeline (review V4, V43). `expectedS`
   is the source time the next sample should start at; `timestampS` is where this one
   does. A later sample leaves a gap, played as silence; an earlier one overlaps, and its
   first `skip` frames are dropped. The first sample after a seek is placed to the frame,
   so the packet at or before the target does not play whole; later samples move only
   when they drift by more than `toleranceS`, so timestamp rounding never adds clicks. A
   jump over `maxGapS` is a broken timestamp, not a pause, and plays on contiguously. */
export function alignAudioSample({
  expectedS,
  timestampS,
  frames,
  rate,
  first = false,
  toleranceS = 0.02,
  maxGapS = 30,
}) {
  const base = Number.isFinite(expectedS) ? expectedS : timestampS;
  if (!Number.isFinite(timestampS) || !Number.isFinite(base)) {
    return { gap: 0, skip: 0, nextExpectedS: (Number.isFinite(base) ? base : 0) + frames / rate };
  }
  const delta = timestampS - base;
  const tolerance = first ? 0.5 / rate : toleranceS;
  let gap = 0;
  let skip = 0;
  if (delta > tolerance && delta <= maxGapS) gap = Math.round(delta * rate);
  else if (delta < -tolerance) skip = Math.min(frames, Math.round(-delta * rate));
  return { gap, skip, nextExpectedS: base + (gap + frames - skip) / rate };
}

/* Pitch-preserving speed for the audio worklet (review V42): a time-domain stretch in the
   WSOLA family, shaped like SoundTouch's TDStretch. Each step takes a 40 ms sequence of
   input, finds within a 15 ms seek window the offset whose start best matches the tail
   kept from the previous step (normalised cross-correlation over the 8 ms overlap),
   cross-fades the two, and advances the input by (sequence - overlap) x tempo. Output
   keeps the input's pitch at any tempo. The class is self-contained, because the worklet
   source embeds it as text; Node tests import it from here. */
export class ReelStretch {
  constructor(channels, sampleRate, tempo = 1) {
    this.channels = Math.max(1, channels | 0);
    this.tempo = tempo > 0 ? tempo : 1;
    this.sequence = Math.max(64, Math.round(sampleRate * 0.04));
    this.overlap = Math.max(16, Math.round(sampleRate * 0.008));
    this.seek = Math.max(16, Math.round(sampleRate * 0.015));
    this.need = this.sequence + this.seek;
    this.input = Array.from({ length: this.channels }, () => new Float32Array(this.need));
    this.mid = Array.from({ length: this.channels }, () => new Float32Array(this.overlap));
    this.out = Array.from({ length: this.channels }, () => new Float32Array(this.sequence));
    this.inLength = 0;
    this.haveMid = false;
    this.outLength = 0;
    this.outRead = 0;
    this.skipCarry = 0;
    this.skipPending = 0;
  }

  ready() {
    return this.outRead < this.outLength;
  }

  /** Input samples taken but not yet heard (in input samples). */
  pending() {
    return Math.max(0, this.inLength + (this.outLength - this.outRead) * this.tempo - this.skipPending);
  }

  push(frame) {
    if (this.skipPending > 0) {
      this.skipPending -= 1;
      return;
    }
    for (let channel = 0; channel < this.channels; channel += 1) {
      this.input[channel][this.inLength] = frame[Math.min(channel, frame.length - 1)];
    }
    this.inLength += 1;
    if (this.inLength >= this.need && !this.ready()) this.step();
  }

  read(output, index) {
    for (let channel = 0; channel < output.length; channel += 1) {
      output[channel][index] = this.out[Math.min(channel, this.channels - 1)][this.outRead];
    }
    this.outRead += 1;
  }

  score(offset) {
    let dot = 0;
    let energy = 0;
    for (let index = 0; index < this.overlap; index += 1) {
      let kept = 0;
      let candidate = 0;
      for (let channel = 0; channel < this.channels; channel += 1) {
        kept += this.mid[channel][index];
        candidate += this.input[channel][offset + index];
      }
      dot += kept * candidate;
      energy += candidate * candidate;
    }
    return dot / Math.sqrt(energy + 1e-12);
  }

  bestOffset() {
    if (!this.haveMid) return 0;
    let best = 0;
    let bestScore = -Infinity;
    for (let offset = 0; offset < this.seek; offset += 4) {
      const value = this.score(offset);
      if (value > bestScore) {
        bestScore = value;
        best = offset;
      }
    }
    const from = Math.max(0, best - 3);
    const to = Math.min(this.seek - 1, best + 3);
    for (let offset = from; offset <= to; offset += 1) {
      const value = this.score(offset);
      if (value > bestScore) {
        bestScore = value;
        best = offset;
      }
    }
    return best;
  }

  step() {
    const offset = this.bestOffset();
    const overlap = this.overlap;
    const sequence = this.sequence;
    for (let channel = 0; channel < this.channels; channel += 1) {
      const input = this.input[channel];
      const out = this.out[channel];
      const mid = this.mid[channel];
      for (let index = 0; index < overlap; index += 1) {
        const weight = index / overlap;
        out[index] = this.haveMid
          ? mid[index] * (1 - weight) + input[offset + index] * weight
          : input[offset + index];
      }
      for (let index = overlap; index < sequence - overlap; index += 1) out[index] = input[offset + index];
      for (let index = 0; index < overlap; index += 1) mid[index] = input[offset + sequence - overlap + index];
    }
    this.haveMid = true;
    this.outLength = sequence - overlap;
    this.outRead = 0;
    this.skipCarry += (sequence - overlap) * this.tempo;
    const skip = Math.floor(this.skipCarry);
    this.skipCarry -= skip;
    const drop = Math.min(skip, this.inLength);
    for (let channel = 0; channel < this.channels; channel += 1) {
      this.input[channel].copyWithin(0, drop, this.inLength);
    }
    this.inLength -= drop;
    this.skipPending = skip - drop;
  }
}

const rangedFiles = new WeakMap();

/* One RangedFile per reader, so the engine's per-file caches see one identity. */
export function rangedFileFor(reader) {
  let file = rangedFiles.get(reader);
  if (!file) {
    file = new RangedFile(reader);
    rangedFiles.set(reader, file);
  }
  return file;
}

/* File, Blob or RangedFile for a media input, or null; a FileSystemFileHandle opens its File. */
async function mediaFileOf(handle) {
  if (handle instanceof RangedFile) return handle;
  if (typeof Blob === 'function' && handle instanceof Blob) return handle;
  if (isRangedReader(handle)) return rangedFileFor(handle);
  if (handle && typeof handle.getFile === 'function') return handle.getFile();
  return null;
}

/**
 * Create Reel's vendorable layers 2–5 engine and its playback coordinator.
 *
 * The factory has no UI imports. Hosts inject the shared state, storage façade,
 * and metadata-state service used by the public agent face.
 */
export class DemuxError extends Error {
  constructor(name, code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

export class DecodeError extends Error {
  constructor(name, code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

export class PlaybackError extends Error {
  constructor(name, code, message, cause) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

export function createReelEngine({
  config: CONFIG,
  store,
  storage: Storage,
  metadataSync: MetadataSync,
  events: Events = null,
}) {
  if (!CONFIG || !store || !Storage || !MetadataSync) {
    throw new TypeError('createReelEngine requires config, store, storage, and metadataSync.');
  }
  const emit = (type, detail = {}) => Events?.emit?.(type, detail);

  /* Ask before any download over the host's threshold (5 MB by default). The hook is
     read at call time, because the host may install it after creating the engine. */
  async function askDownload(info) {
    const threshold = CONFIG.askDownloadOverBytes ?? 5 * 1024 * 1024;
    if (Number(info?.bytes) <= threshold) return true;
    const request = CONFIG.requestDownload;
    if (typeof request !== 'function') return false;
    return (await request({ name: info.name, bytes: info.bytes, licence: info.licence })) === true;
  }

/* Layer 2 — Demux. This is the ONLY Mediabunny ingress in Reel.
   The vendored module stays unmodified; see VENDOR.md. */
const Demux = (() => {
  const FORMATS = [MP4, QTFF, MATROSKA, WEBM, MP3, FLAC, OGG, WAVE, MPEG_TS];
  let active = null;
  let nextSessionId = 1;

  function fail(name, code, message, cause) {
    return new DemuxError(name, code, message, cause);
  }

  function wrapFailure(error, message = 'The media container could not be read.') {
    if (error instanceof DemuxError) return error;
    const detail = error && error.message ? error.message : String(error);
    return fail('MalformedMediaError', 'ERR_DEMUX_MALFORMED', `${message} ${detail}`, error);
  }

  async function withTimeout(operation, label, {
    timeoutMs = CONFIG.demux.probeTimeoutMs,
    onTimeout = null,
  } = {}) {
    let timer;
    try {
      return await Promise.race([
        operation,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            try { onTimeout?.(); } catch (_) {}
            reject(fail(
              'DemuxTimeoutError',
              'ERR_DEMUX_TIMEOUT',
              `${label} exceeded ${timeoutMs} ms.`,
            ));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  function normalizeInternalCodecId(value) {
    if (value instanceof Uint8Array) {
      return [...value].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }
    return value;
  }

  function finiteOrNull(value) {
    return Number.isFinite(value) ? value : null;
  }

  const ASF_SIGNATURE = Uint8Array.from([
    0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11,
    0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C,
  ]);
  const APE_SIGNATURE = Uint8Array.from([0x4D, 0x41, 0x43, 0x20]);

  function startsWith(bytes, signature) {
    return bytes.byteLength >= signature.byteLength
      && signature.every((byte, index) => bytes[index] === byte);
  }

  // ASF_Video_Media stream type GUID (BC19EFC0-5B4D-11CF-A8FD-00805F5C442B) as stored.
  const ASF_VIDEO_MEDIA = Uint8Array.from([
    0xC0, 0xEF, 0x19, 0xBC, 0x4D, 0x5B, 0xCF, 0x11,
    0xA8, 0xFD, 0x00, 0x80, 0x5F, 0x5C, 0x44, 0x2B,
  ]);

  function containsBytes(haystack, needle) {
    outer: for (let index = 0; index + needle.byteLength <= haystack.byteLength; index += 1) {
      for (let offset = 0; offset < needle.byteLength; offset += 1) {
        if (haystack[index + offset] !== needle[offset]) continue outer;
      }
      return true;
    }
    return false;
  }

  function refuseDetectedFormat(bytes, header = bytes) {
    if (startsWith(bytes, ASF_SIGNATURE) && containsBytes(header, ASF_VIDEO_MEDIA)) {
      // WMV and other ASF video: Mediabunny cannot read it; the libav rung may.
      throw fail(
        'UnsupportedContainerError',
        'ERR_DEMUX_ASF_VIDEO',
        'ASF/WMV video needs the libav software decoder.',
      );
    }
    if (startsWith(bytes, ASF_SIGNATURE)) {
      throw fail(
        'UnsupportedCodecError',
        'ERR_DEMUX_WMA_REFUSED',
        'WMA audio is not supported because Reel has no licensed WMA decoder.',
      );
    }
    if (startsWith(bytes, APE_SIGNATURE)) {
      throw fail(
        'UnsupportedCodecError',
        'ERR_DEMUX_APE_REFUSED',
        'Monkey\'s Audio is not supported because Reel has no APE decoder.',
      );
    }
  }

  /* Mediabunny omits input subtitle tracks and Matroska chapters. Keep the targeted
     EBML extension inside this wrapper: ranged reads, text tracks, and chapters. */
  const MatroskaText = (() => {
    const ID = Object.freeze({
      SEGMENT: 0x18538067,
      SEEK_HEAD: 0x114D9B74,
      SEEK: 0x4DBB,
      SEEK_ID: 0x53AB,
      SEEK_POSITION: 0x53AC,
      INFO: 0x1549A966,
      TIMESTAMP_SCALE: 0x2AD7B1,
      TRACKS: 0x1654AE6B,
      TRACK_ENTRY: 0xAE,
      TRACK_NUMBER: 0xD7,
      TRACK_TYPE: 0x83,
      FLAG_DEFAULT: 0x88,
      FLAG_FORCED: 0x55AA,
      FLAG_HEARING_IMPAIRED: 0x55AB,
      FLAG_VISUAL_IMPAIRED: 0x55AC,
      FLAG_DESCRIPTIONS: 0x55AD,
      FLAG_ORIGINAL: 0x55AE,
      FLAG_COMMENTARY: 0x55AF,
      DEFAULT_DURATION: 0x23E383,
      TRACK_TIMESTAMP_SCALE: 0x23314F,
      NAME: 0x536E,
      LANGUAGE: 0x22B59C,
      LANGUAGE_BCP47: 0x22B59D,
      CODEC_ID: 0x86,
      CODEC_PRIVATE: 0x63A2,
      CODEC_DELAY: 0x56AA,
      CLUSTER: 0x1F43B675,
      CLUSTER_TIMESTAMP: 0xE7,
      SIMPLE_BLOCK: 0xA3,
      BLOCK_GROUP: 0xA0,
      BLOCK: 0xA1,
      BLOCK_DURATION: 0x9B,
      CHAPTERS: 0x1043A770,
      EDITION_ENTRY: 0x45B9,
      CHAPTER_ATOM: 0xB6,
      CHAPTER_TIME_START: 0x91,
      CHAPTER_TIME_END: 0x92,
      CHAPTER_FLAG_HIDDEN: 0x98,
      CHAPTER_FLAG_ENABLED: 0x4598,
      CHAPTER_DISPLAY: 0x80,
      CHAPTER_STRING: 0x85,
      CHAPTER_LANGUAGE: 0x437C,
      CHAPTER_LANGUAGE_BCP47: 0x437D,
      CUES: 0x1C53BB6B,
      CUE_POINT: 0xBB,
      CUE_TIME: 0xB3,
      CUE_TRACK_POSITIONS: 0xB7,
      CUE_TRACK: 0xF7,
      CUE_CLUSTER_POSITION: 0xF1,
      CUE_RELATIVE_POSITION: 0xF0,
      REFERENCE_BLOCK: 0xFB,
      ATTACHMENTS: 0x1941A469,
      ATTACHED_FILE: 0x61A7,
      FILE_NAME: 0x466E,
      FILE_MIME_TYPE: 0x4660,
      FILE_DATA: 0x465C,
      VIDEO: 0xE0,
      FLAG_INTERLACED: 0x9A,
      FIELD_ORDER: 0x9D,
    });
    // Matroska FieldOrder: 1 and 14 put the top field first, 6 and 9 the bottom field.
    const FIELD_ORDERS = new Map([[1, 'tff'], [14, 'tff'], [6, 'bff'], [9, 'bff']]);
    const TOP_LEVEL_IDS = new Set([
      ID.SEEK_HEAD,
      ID.INFO,
      ID.TRACKS,
      0x1C53BB6B, // Cues
      0x1941A469, // Attachments
      ID.CHAPTERS,
      0x1254C367, // Tags
      ID.CLUSTER,
    ]);
    const TEXT_CODECS = new Map([
      ['S_TEXT/UTF8', 'srt'],
      ['S_TEXT/WEBVTT', 'webvtt'],
      ['D_WEBVTT/SUBTITLES', 'webvtt'],
      ['S_TEXT/ASS', 'ass'],
      ['S_TEXT/SSA', 'ssa'],
    ]);
    // Bitmap subtitle codecs: blocks are returned as raw bytes, never decoded as text.
    const BITMAP_CODECS = new Map([
      ['S_HDMV/PGS', 'pgs'],
    ]);
    const subtitleCodec = codecId => TEXT_CODECS.get(codecId) || BITMAP_CODECS.get(codecId) || null;
    // Fonts for ASS (review V17): only font attachments are read, each at most 32 MB
    // and 64 MB and 64 files in all; anything else is listed as skipped, never read.
    const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
    const MAX_ATTACHMENTS_TOTAL_BYTES = 64 * 1024 * 1024;
    const MAX_ATTACHMENT_FILES = 64;
    const MAX_INDEX_CLUSTERS = 200_000;
    const INDEX_SCAN_TIMEOUT_MS = 15_000;
    // One PGS display set is a few hundred kilobytes at 1080p; a larger set is dropped (V15).
    const MAX_DISPLAY_SET_BYTES = 8 * 1024 * 1024;

    class Reader {
      constructor(file, {
        deadline = null,
        timeoutMs = CONFIG.demux.subtitleScanTimeoutMs,
        timeoutLabel = 'Matroska scan',
        maxElements = CONFIG.demux.maxEbmlElements,
      } = {}) {
        this.file = file;
        this.size = file.size;
        this.deadline = deadline;
        this.timeoutMs = timeoutMs;
        this.timeoutLabel = timeoutLabel;
        this.maxElements = maxElements;
        this.cacheStart = -1;
        this.cache = new Uint8Array();
        this.elementsRead = 0;
      }

      checkBudget() {
        if (this.deadline !== null && performance.now() > this.deadline) {
          throw fail(
            'DemuxTimeoutError',
            'ERR_DEMUX_TIMEOUT',
            `${this.timeoutLabel} exceeded ${this.timeoutMs} ms.`,
          );
        }
        if (this.elementsRead > this.maxElements) {
          throw fail(
            'EbmlElementLimitError',
            'ERR_DEMUX_EBML_LIMIT',
            `The Matroska scan exceeded ${this.maxElements} elements.`,
          );
        }
      }

      async bytes(offset, length) {
        this.checkBudget();
        if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length)
          || offset < 0 || length < 0 || offset + length > this.size) {
          throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_RANGE', 'An EBML element points outside the file.');
        }
        if (length === 0) return new Uint8Array();
        const cacheEnd = this.cacheStart + this.cache.byteLength;
        if (offset >= this.cacheStart && offset + length <= cacheEnd) {
          return this.cache.subarray(offset - this.cacheStart, offset - this.cacheStart + length);
        }
        const fetchLength = Math.min(
          Math.max(length, CONFIG.demux.ebmlWindowBytes),
          this.size - offset,
        );
        const bytes = new Uint8Array(await this.file.slice(offset, offset + fetchLength).arrayBuffer());
        if (bytes.byteLength !== fetchLength) {
          throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_READ', 'A ranged EBML read ended early.');
        }
        this.cacheStart = offset;
        this.cache = bytes;
        return bytes.subarray(0, length);
      }
    }

    function vintLength(firstByte, maximum, label) {
      let marker = 0x80;
      for (let length = 1; length <= maximum; length += 1, marker >>= 1) {
        if (firstByte & marker) return { length, marker };
      }
      throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_VINT', `The ${label} VINT is invalid.`);
    }

    async function elementAt(reader, offset, limit = reader.size) {
      reader.elementsRead += 1;
      reader.checkBudget();
      if (offset >= limit) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_HEADER', 'An EBML element header is missing.');
      }
      const available = Math.min(12, limit - offset);
      const prefix = await reader.bytes(offset, available);
      const idVint = vintLength(prefix[0], 4, 'element ID');
      if (available <= idVint.length) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_HEADER', 'An EBML size header is missing.');
      }
      let id = 0;
      for (let index = 0; index < idVint.length; index += 1) id = (id * 256) + prefix[index];

      const sizeFirst = prefix[idVint.length];
      const sizeVint = vintLength(sizeFirst, 8, 'element size');
      const headerSize = idVint.length + sizeVint.length;
      if (headerSize > available) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_HEADER', 'An EBML element header is truncated.');
      }
      let value = BigInt(sizeFirst & (sizeVint.marker - 1));
      for (let index = 1; index < sizeVint.length; index += 1) {
        value = (value << 8n) | BigInt(prefix[idVint.length + index]);
      }
      const unknownValue = (1n << BigInt(7 * sizeVint.length)) - 1n;
      const unknown = value === unknownValue;
      if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw fail('EbmlSizeLimitError', 'ERR_DEMUX_EBML_SIZE', 'An EBML element exceeds JavaScript safe addressing.');
      }
      const dataOffset = offset + headerSize;
      const dataSize = unknown ? null : Number(value);
      const end = unknown ? null : dataOffset + dataSize;
      if (dataOffset > limit || (end !== null && end > limit)) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_RANGE', 'An EBML element exceeds its parent.');
      }
      return { id, offset, headerSize, dataOffset, dataSize, end, unknown };
    }

    function requireKnown(element, context) {
      if (element.end === null) {
        throw fail('UnsupportedEbmlError', 'ERR_DEMUX_EBML_UNKNOWN_SIZE', `${context} uses an unknown element size.`);
      }
      return element.end;
    }

    async function unsigned(reader, element) {
      if (element.dataSize < 1 || element.dataSize > 8) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_UINT', 'An EBML unsigned integer has an invalid width.');
      }
      const bytes = await reader.bytes(element.dataOffset, element.dataSize);
      let value = 0n;
      for (const byte of bytes) value = (value << 8n) | BigInt(byte);
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
        throw fail('EbmlValueLimitError', 'ERR_DEMUX_EBML_VALUE', 'An EBML integer exceeds JavaScript numeric precision.');
      }
      return Number(value);
    }

    async function float(reader, element) {
      if (element.dataSize !== 4 && element.dataSize !== 8) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_FLOAT', 'An EBML float has an invalid width.');
      }
      const bytes = await reader.bytes(element.dataOffset, element.dataSize);
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return element.dataSize === 4 ? view.getFloat32(0) : view.getFloat64(0);
    }

    async function textValue(reader, element, limit = CONFIG.demux.maxCodecPrivateBytes) {
      if (element.dataSize > limit) {
        throw fail('EbmlTextLimitError', 'ERR_DEMUX_EBML_TEXT_LIMIT', `An EBML text value exceeds ${limit} bytes.`);
      }
      return decodeSubtitleText(await reader.bytes(element.dataOffset, element.dataSize)).replace(/\0+$/, '');
    }

    async function binaryId(reader, element) {
      if (element.dataSize < 1 || element.dataSize > 4) return null;
      const bytes = await reader.bytes(element.dataOffset, element.dataSize);
      let value = 0;
      for (const byte of bytes) value = (value * 256) + byte;
      return value;
    }

    async function children(reader, parent, visit) {
      const end = requireKnown(parent, 'A Matroska master element');
      let offset = parent.dataOffset;
      while (offset < end) {
        const child = await elementAt(reader, offset, end);
        await visit(child);
        offset = requireKnown(child, 'A child element');
      }
    }

    async function locateSegment(reader) {
      const searchEnd = Math.min(reader.size, 1024 * 1024);
      let offset = 0;
      while (offset < searchEnd) {
        const element = await elementAt(reader, offset, reader.size);
        if (element.id === ID.SEGMENT) {
          return { ...element, end: element.end ?? reader.size };
        }
        offset = requireKnown(element, 'An EBML header element');
      }
      throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_SEGMENT', 'The Matroska Segment element was not found.');
    }

    async function parseSeekHead(reader, element, segment) {
      const positions = new Map();
      await children(reader, element, async child => {
        if (child.id !== ID.SEEK) return;
        let targetId = null;
        let position = null;
        await children(reader, child, async field => {
          if (field.id === ID.SEEK_ID) targetId = await binaryId(reader, field);
          if (field.id === ID.SEEK_POSITION) position = await unsigned(reader, field);
        });
        if (targetId !== null && position !== null) {
          const absolute = segment.dataOffset + position;
          if (absolute >= segment.dataOffset && absolute < segment.end) positions.set(targetId, absolute);
        }
      });
      return positions;
    }

    async function parseInfo(reader, element) {
      let timestampScale = 1_000_000;
      await children(reader, element, async child => {
        if (child.id === ID.TIMESTAMP_SCALE) timestampScale = await unsigned(reader, child);
      });
      if (!Number.isFinite(timestampScale) || timestampScale <= 0) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_EBML_TIMESCALE', 'The Matroska timestamp scale is invalid.');
      }
      return timestampScale;
    }

    async function parseTrackEntry(reader, element) {
      let codecPrivateElement = null;
      const entry = {
        number: null,
        type: null,
        codecId: null,
        name: null,
        language: 'eng',
        languageBcp47: null,
        codecPrivate: null,
        defaultDurationNs: null,
        timestampScale: 1,
        codecDelayNs: 0,
        disposition: {
          default: true,
          forced: false,
          hearingImpaired: false,
          visualImpaired: false,
          descriptions: false,
          original: false,
          commentary: false,
        },
      };
      await children(reader, element, async child => {
        switch (child.id) {
          case ID.TRACK_NUMBER: entry.number = await unsigned(reader, child); break;
          case ID.TRACK_TYPE: entry.type = await unsigned(reader, child); break;
          case ID.CODEC_ID: entry.codecId = await textValue(reader, child); break;
          case ID.NAME: entry.name = await textValue(reader, child); break;
          case ID.LANGUAGE: entry.language = await textValue(reader, child); break;
          case ID.LANGUAGE_BCP47: entry.languageBcp47 = await textValue(reader, child); break;
          case ID.CODEC_PRIVATE: codecPrivateElement = child; break;
          case ID.DEFAULT_DURATION: entry.defaultDurationNs = await unsigned(reader, child); break;
          case ID.TRACK_TIMESTAMP_SCALE: entry.timestampScale = await float(reader, child); break;
          case ID.CODEC_DELAY: entry.codecDelayNs = await unsigned(reader, child); break;
          case ID.FLAG_DEFAULT: entry.disposition.default = !!await unsigned(reader, child); break;
          case ID.FLAG_FORCED: entry.disposition.forced = !!await unsigned(reader, child); break;
          case ID.FLAG_HEARING_IMPAIRED: entry.disposition.hearingImpaired = !!await unsigned(reader, child); break;
          case ID.FLAG_VISUAL_IMPAIRED: entry.disposition.visualImpaired = !!await unsigned(reader, child); break;
          case ID.FLAG_DESCRIPTIONS: entry.disposition.descriptions = !!await unsigned(reader, child); break;
          case ID.FLAG_ORIGINAL: entry.disposition.original = !!await unsigned(reader, child); break;
          case ID.FLAG_COMMENTARY: entry.disposition.commentary = !!await unsigned(reader, child); break;
          case ID.VIDEO:
            await children(reader, child, async field => {
              if (field.id === ID.FLAG_INTERLACED) entry.flagInterlaced = await unsigned(reader, field);
              if (field.id === ID.FIELD_ORDER) entry.fieldOrder = await unsigned(reader, field);
            });
            break;
          default: break;
        }
      });
      if (entry.type !== 17 || !subtitleCodec(entry.codecId)) {
        if (!Number.isSafeInteger(entry.number)) return null;
        const interlaced = entry.flagInterlaced === 1;
        return {
          number: entry.number,
          type: entry.type,
          media: true,
          interlaced,
          fieldOrder: interlaced ? FIELD_ORDERS.get(entry.fieldOrder) || 'unknown' : null,
        };
      }
      if (!Number.isSafeInteger(entry.number) || entry.number <= 0) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_SUBTITLE_TRACK', 'A subtitle track number is invalid.');
      }
      if (!Number.isFinite(entry.timestampScale) || entry.timestampScale <= 0) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_SUBTITLE_TIMESCALE', 'A subtitle track scale is invalid.');
      }
      if (['S_TEXT/WEBVTT', 'S_TEXT/ASS', 'S_TEXT/SSA'].includes(entry.codecId) && codecPrivateElement) {
        entry.codecPrivate = await textValue(reader, codecPrivateElement);
      }
      entry.language = entry.languageBcp47 || entry.language || null;
      return entry;
    }

    async function parseTracks(reader, element) {
      const tracks = [];
      const mediaTracks = [];
      await children(reader, element, async child => {
        if (child.id !== ID.TRACK_ENTRY) return;
        const track = await parseTrackEntry(reader, child);
        if (track?.media) mediaTracks.push(track);
        else if (track) tracks.push(track);
      });
      return { tracks, mediaTracks };
    }

    async function parseChapterDisplay(reader, element) {
      const display = { title: null, language: 'eng', languageBcp47: null };
      await children(reader, element, async child => {
        if (child.id === ID.CHAPTER_STRING) display.title = await textValue(reader, child);
        if (child.id === ID.CHAPTER_LANGUAGE) display.language = await textValue(reader, child);
        if (child.id === ID.CHAPTER_LANGUAGE_BCP47) display.languageBcp47 = await textValue(reader, child);
      });
      display.language = display.languageBcp47 || display.language || null;
      return display;
    }

    async function parseChapterAtom(reader, element, depth, output) {
      if (depth > 16) {
        throw fail('EbmlDepthLimitError', 'ERR_DEMUX_EBML_DEPTH', 'Matroska chapters exceed 16 nested levels.');
      }
      const atom = { startNs: null, endNs: null, hidden: false, enabled: true, displays: [] };
      const nested = [];
      await children(reader, element, async child => {
        if (child.id === ID.CHAPTER_TIME_START) atom.startNs = await unsigned(reader, child);
        if (child.id === ID.CHAPTER_TIME_END) atom.endNs = await unsigned(reader, child);
        if (child.id === ID.CHAPTER_FLAG_HIDDEN) atom.hidden = !!await unsigned(reader, child);
        if (child.id === ID.CHAPTER_FLAG_ENABLED) atom.enabled = !!await unsigned(reader, child);
        if (child.id === ID.CHAPTER_DISPLAY) atom.displays.push(await parseChapterDisplay(reader, child));
        if (child.id === ID.CHAPTER_ATOM) nested.push(child);
      });
      if (!atom.hidden && atom.enabled && atom.startNs !== null) {
        const display = atom.displays.find(item => item.title) || { title: '', language: null };
        output.push({
          startS: atom.startNs / 1e9,
          endS: atom.endNs === null ? null : atom.endNs / 1e9,
          title: display.title,
          language: display.language,
          depth,
        });
      }
      for (const child of nested) await parseChapterAtom(reader, child, depth + 1, output);
    }

    async function parseChapters(reader, element) {
      const output = [];
      await children(reader, element, async edition => {
        if (edition.id !== ID.EDITION_ENTRY) return;
        await children(reader, edition, async child => {
          if (child.id === ID.CHAPTER_ATOM) await parseChapterAtom(reader, child, 0, output);
        });
      });
      return output.sort((left, right) => left.startS - right.startS || left.depth - right.depth);
    }

    async function soughtElement(reader, segment, positions, id) {
      const offset = positions.get(id);
      if (offset === undefined) return null;
      const element = await elementAt(reader, offset, segment.end);
      return element.id === id ? element : null;
    }

    async function metadata(file) {
      const reader = new Reader(file, {
        deadline: performance.now() + CONFIG.demux.probeTimeoutMs,
        timeoutMs: CONFIG.demux.probeTimeoutMs,
        timeoutLabel: 'Matroska metadata scan',
      });
      const segment = await locateSegment(reader);
      const positions = new Map();
      const found = new Map();
      let offset = segment.dataOffset;
      const initialEnd = Math.min(segment.end, segment.dataOffset + (16 * 1024 * 1024));
      while (offset < initialEnd) {
        const element = await elementAt(reader, offset, segment.end);
        if (element.id === ID.CLUSTER) break;
        if (element.id === ID.SEEK_HEAD) {
          for (const [id, position] of await parseSeekHead(reader, element, segment)) positions.set(id, position);
        }
        if ([ID.INFO, ID.TRACKS, ID.CHAPTERS, ID.CUES, ID.ATTACHMENTS].includes(element.id)) found.set(element.id, element);
        offset = requireKnown(element, 'A top-level Matroska element');
      }

      for (const id of [ID.INFO, ID.TRACKS, ID.CHAPTERS, ID.CUES, ID.ATTACHMENTS]) {
        if (!found.has(id)) {
          const element = await soughtElement(reader, segment, positions, id);
          if (element) found.set(id, element);
        }
      }

      if (!found.has(ID.CHAPTERS)) {
        while (offset < segment.end) {
          const element = await elementAt(reader, offset, segment.end);
          if (element.id === ID.CHAPTERS) {
            found.set(ID.CHAPTERS, element);
            break;
          }
          if (element.id === ID.CLUSTER && element.end === null) {
            let childOffset = element.dataOffset;
            while (childOffset < segment.end) {
              const child = await elementAt(reader, childOffset, segment.end);
              if (TOP_LEVEL_IDS.has(child.id)) break;
              childOffset = requireKnown(child, 'A Cluster child element');
            }
            offset = childOffset;
          } else {
            offset = requireKnown(element, 'A top-level Matroska element');
          }
        }
      }

      const timestampScale = found.has(ID.INFO) ? await parseInfo(reader, found.get(ID.INFO)) : 1_000_000;
      const parsed = found.has(ID.TRACKS) ? await parseTracks(reader, found.get(ID.TRACKS)) : { tracks: [], mediaTracks: [] };
      const chapters = found.has(ID.CHAPTERS) ? await parseChapters(reader, found.get(ID.CHAPTERS)) : [];
      return {
        file,
        segment,
        timestampScale,
        tracks: parsed.tracks,
        mediaTracks: parsed.mediaTracks,
        chapters,
        cuesElement: found.get(ID.CUES) || null,
        attachmentsElement: found.get(ID.ATTACHMENTS) || null,
        cueCache: new Map(),
        keyframeCache: new Map(),
        attachmentCache: null,
      };
    }

    async function blockData(reader, element, targetTrack) {
      const prefixLength = Math.min(element.dataSize, 12);
      const prefix = await reader.bytes(element.dataOffset, prefixLength);
      if (!prefix.length) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_SUBTITLE_BLOCK', 'A subtitle Block is empty.');
      }
      const trackVint = vintLength(prefix[0], 8, 'Block track number');
      if (trackVint.length + 3 > prefix.length) {
        throw fail('MalformedEbmlError', 'ERR_DEMUX_SUBTITLE_BLOCK', 'A subtitle Block header is truncated.');
      }
      let trackNumber = prefix[0] & (trackVint.marker - 1);
      for (let index = 1; index < trackVint.length; index += 1) {
        trackNumber = (trackNumber * 256) + prefix[index];
      }
      if (trackNumber !== targetTrack.number) return null;

      const timeOffset = trackVint.length;
      const rawTimestamp = (prefix[timeOffset] << 8) | prefix[timeOffset + 1];
      const relativeTimestamp = rawTimestamp & 0x8000 ? rawTimestamp - 0x10000 : rawTimestamp;
      const flags = prefix[timeOffset + 2];
      if ((flags & 0x06) !== 0) {
        throw fail(
          'UnsupportedSubtitleLacingError',
          'ERR_DEMUX_SUBTITLE_LACING',
          `Subtitle track ${targetTrack.number} uses unsupported Block lacing.`,
        );
      }
      const payloadOffset = element.dataOffset + trackVint.length + 3;
      const payloadSize = element.dataSize - trackVint.length - 3;
      if (payloadSize > CONFIG.demux.maxSubtitleCueBytes) {
        throw fail(
          'SubtitleCueLimitError',
          'ERR_DEMUX_SUBTITLE_CUE_LIMIT',
          `A subtitle cue exceeds ${CONFIG.demux.maxSubtitleCueBytes} bytes.`,
        );
      }
      if (BITMAP_CODECS.has(targetTrack.codecId)) {
        const data = (await reader.bytes(payloadOffset, payloadSize)).slice();
        return { relativeTimestamp, text: null, data, id: null, settings: '', payloadSize, at: element.offset };
      }
      let text = decodeSubtitleText(await reader.bytes(payloadOffset, payloadSize)).replace(/\0+$/, '');
      let id = null;
      let settings = '';
      if (targetTrack.codecId === 'D_WEBVTT/SUBTITLES') {
        const firstBreak = text.indexOf('\n');
        const secondBreak = firstBreak < 0 ? -1 : text.indexOf('\n', firstBreak + 1);
        if (firstBreak < 0 || secondBreak < 0) {
          throw fail(
            'MalformedSubtitleTextError',
            'ERR_DEMUX_WEBVTT_BLOCK',
            'A WebM-style WebVTT cue lacks its identifier or settings line.',
          );
        }
        id = text.slice(0, firstBreak).replace(/\r$/, '') || null;
        settings = text.slice(firstBreak + 1, secondBreak).replace(/\r$/, '');
        text = text.slice(secondBreak + 1);
      }
      return { relativeTimestamp, text, id, settings, payloadSize, at: element.offset };
    }

    function timedCue(block, clusterTimestamp, blockDuration, track, timestampScale) {
      const startNs = ((clusterTimestamp + (block.relativeTimestamp * track.timestampScale)) * timestampScale)
        - track.codecDelayNs;
      const durationNs = blockDuration === null
        ? track.defaultDurationNs
        : blockDuration * track.timestampScale * timestampScale;
      const startS = startNs / 1e9;
      return {
        startS,
        endS: durationNs === null ? null : startS + (durationNs / 1e9),
        text: block.text,
        data: block.data || null,
        id: block.id,
        settings: block.settings,
        at: block.at,
      };
    }

    function appendCue(scan, cue, payloadSize) {
      if (scan.cues.length >= CONFIG.demux.maxSubtitleCues) {
        throw fail(
          'SubtitleCueCountLimitError',
          'ERR_DEMUX_SUBTITLE_CUE_COUNT',
          `A subtitle track exceeds ${CONFIG.demux.maxSubtitleCues} cues.`,
        );
      }
      const nextTextBytes = scan.textBytes + payloadSize;
      if (nextTextBytes > CONFIG.demux.maxSubtitleTextBytes) {
        throw fail(
          'SubtitleTextLimitError',
          'ERR_DEMUX_SUBTITLE_TEXT_LIMIT',
          `A subtitle track exceeds ${CONFIG.demux.maxSubtitleTextBytes} text bytes.`,
        );
      }
      scan.textBytes = nextTextBytes;
      scan.cues.push(cue);
    }

    async function parseBlockGroup(reader, element, clusterTimestamp, targetTrack, timestampScale, scan) {
      let blockElement = null;
      let blockDuration = null;
      await children(reader, element, async child => {
        if (child.id === ID.BLOCK) blockElement = child;
        if (child.id === ID.BLOCK_DURATION) blockDuration = await unsigned(reader, child);
      });
      if (!blockElement) return;
      const block = await blockData(reader, blockElement, targetTrack);
      if (block) {
        appendCue(
          scan,
          timedCue(block, clusterTimestamp, blockDuration, targetTrack, timestampScale),
          block.payloadSize,
        );
      }
    }

    async function parseCluster(reader, element, targetTrack, timestampScale, scan, segmentEnd) {
      const knownEnd = element.end;
      const limit = knownEnd ?? segmentEnd;
      let offset = element.dataOffset;
      let clusterTimestamp = null;
      while (offset < limit) {
        const child = await elementAt(reader, offset, limit);
        if (knownEnd === null && TOP_LEVEL_IDS.has(child.id)) return offset;
        if (child.id === ID.CLUSTER_TIMESTAMP) clusterTimestamp = await unsigned(reader, child);
        if ((child.id === ID.SIMPLE_BLOCK || child.id === ID.BLOCK_GROUP) && clusterTimestamp === null) {
          throw fail('MalformedEbmlError', 'ERR_DEMUX_CLUSTER_TIME', 'A Matroska Cluster Block precedes its timestamp.');
        }
        if (child.id === ID.SIMPLE_BLOCK) {
          const block = await blockData(reader, child, targetTrack);
          if (block) {
            appendCue(
              scan,
              timedCue(block, clusterTimestamp, null, targetTrack, timestampScale),
              block.payloadSize,
            );
          }
        }
        if (child.id === ID.BLOCK_GROUP) {
          await parseBlockGroup(reader, child, clusterTimestamp, targetTrack, timestampScale, scan);
        }
        offset = requireKnown(child, 'A Cluster child element');
      }
      return knownEnd ?? limit;
    }

    /* The scan budget grows with the file (review V10): a three-hour film with several
       audio tracks holds millions of blocks, each one EBML element. The deadline grows
       with the duration, at least the configured subtitle scan timeout. */
    function scanBudget(state, mediaDuration) {
      const timeoutMs = Math.max(
        CONFIG.demux.subtitleScanTimeoutMs,
        Number.isFinite(mediaDuration) ? Math.ceil(mediaDuration * 20) : 0,
      );
      return {
        deadline: performance.now() + timeoutMs,
        timeoutMs,
        maxElements: Math.max(CONFIG.demux.maxEbmlElements, Math.ceil(state.file.size / 64)),
      };
    }

    /* Cue points of `trackNumber`: [{ cluster, relative }] absolute cluster offsets and the
       block's offset inside the cluster's data (null when the muxer wrote none). */
    async function trackCuePoints(reader, state, trackNumber) {
      const points = [];
      await children(reader, state.cuesElement, async point => {
        if (point.id !== ID.CUE_POINT) return;
        await children(reader, point, async field => {
          if (field.id !== ID.CUE_TRACK_POSITIONS) return;
          let track = null;
          let cluster = null;
          let relative = null;
          await children(reader, field, async position => {
            if (position.id === ID.CUE_TRACK) track = await unsigned(reader, position);
            if (position.id === ID.CUE_CLUSTER_POSITION) cluster = await unsigned(reader, position);
            if (position.id === ID.CUE_RELATIVE_POSITION) relative = await unsigned(reader, position);
          });
          if (track === trackNumber && cluster !== null) {
            const absolute = state.segment.dataOffset + cluster;
            if (absolute < state.segment.end) points.push({ cluster: absolute, relative });
          }
        });
      });
      return points;
    }

    /* Read only the blocks the Cues point at (review V10): the cluster's timestamp, then the
       block at its relative position; a cluster without a usable relative position is
       scanned whole. Returns null when the Cues hold no entry for this track. */
    async function cuedScan(reader, state, track, scan) {
      if (!state.cuesElement) return null;
      const points = await trackCuePoints(reader, state, track.number);
      if (!points.length) return null;
      const scanned = new Set();
      const seenBlocks = new Set();
      for (const point of points) {
        const cluster = await elementAt(reader, point.cluster, state.segment.end);
        if (cluster.id !== ID.CLUSTER) return null;
        const limit = cluster.end ?? state.segment.end;
        let clusterTimestamp = null;
        let child = cluster.dataOffset;
        for (let guard = 0; child < limit && guard < 8 && clusterTimestamp === null; guard += 1) {
          const field = await elementAt(reader, child, limit);
          if (field.id === ID.CLUSTER_TIMESTAMP) clusterTimestamp = await unsigned(reader, field);
          child = requireKnown(field, 'A Cluster child element');
        }
        // PGS display sets span several blocks and the Cues name only the first, so
        // bitmap tracks scan each cued cluster whole.
        const blockOffset = point.relative === null || BITMAP_CODECS.has(track.codecId)
          ? null
          : cluster.dataOffset + point.relative;
        if (clusterTimestamp !== null && blockOffset !== null && blockOffset < limit) {
          if (seenBlocks.has(blockOffset)) continue;
          const element = await elementAt(reader, blockOffset, limit);
          if (element.id === ID.SIMPLE_BLOCK) {
            const block = await blockData(reader, element, track);
            if (block) {
              seenBlocks.add(blockOffset);
              appendCue(scan, timedCue(block, clusterTimestamp, null, track, state.timestampScale), block.payloadSize);
              continue;
            }
          } else if (element.id === ID.BLOCK_GROUP) {
            const before = scan.cues.length;
            await parseBlockGroup(reader, element, clusterTimestamp, track, state.timestampScale, scan);
            if (scan.cues.length > before) {
              seenBlocks.add(blockOffset);
              continue;
            }
          }
        }
        if (scanned.has(point.cluster)) continue;
        scanned.add(point.cluster);
        // Without a relative position, or when it does not lead to this track's block.
        const before = scan.cues.length;
        await parseCluster(reader, cluster, track, state.timestampScale, scan, state.segment.end);
        if (scan.cues.length === before) return null;
      }
      return scan;
    }

    async function readCues(state, track, mediaDuration) {
      const budget = scanBudget(state, mediaDuration);
      const readerFor = label => new Reader(state.file, { ...budget, timeoutLabel: label });
      let scan = null;
      try {
        scan = await cuedScan(readerFor('Subtitle extraction'), state, track, { cues: [], textBytes: 0 });
      } catch (error) {
        if (error?.code === 'ERR_DEMUX_TIMEOUT') throw error;
        scan = null;
      }
      if (scan) {
        // A cluster scanned whole and a cued block can both yield one cue; keep one.
        const unique = new Map();
        for (const cue of scan.cues) unique.set(cue.at, cue);
        scan.cues = [...unique.values()];
      } else {
        scan = { cues: [], textBytes: 0 };
        const reader = readerFor('Subtitle extraction');
        let offset = state.segment.dataOffset;
        while (offset < state.segment.end) {
          const element = await elementAt(reader, offset, state.segment.end);
          if (element.id === ID.CLUSTER) {
            offset = await parseCluster(
              reader,
              element,
              track,
              state.timestampScale,
              scan,
              state.segment.end,
            );
          } else {
            offset = requireKnown(element, 'A top-level Matroska element');
          }
        }
      }
      if (BITMAP_CODECS.has(track.codecId)) return joinDisplaySets(scan.cues, mediaDuration, MAX_DISPLAY_SET_BYTES);
      return fillCueEnds(scan.cues, mediaDuration);
    }

    /* Key frame times for Matroska track `trackNumber`: from Cues when the file has
       them, otherwise from a bounded scan that reads each Cluster's timestamp and its
       first block of that track (row E8's cluster index). Cached per file and track. */
    async function cueIndex(state, trackNumber) {
      const reader = new Reader(state.file, {
        deadline: performance.now() + INDEX_SCAN_TIMEOUT_MS,
        timeoutMs: INDEX_SCAN_TIMEOUT_MS,
        timeoutLabel: 'Matroska Cues read',
      });
      const times = [];
      await children(reader, state.cuesElement, async point => {
        if (point.id !== ID.CUE_POINT) return;
        let time = null;
        let matches = false;
        await children(reader, point, async field => {
          if (field.id === ID.CUE_TIME) time = await unsigned(reader, field);
          if (field.id === ID.CUE_TRACK_POSITIONS) {
            await children(reader, field, async position => {
              if (position.id === ID.CUE_TRACK && await unsigned(reader, position) === trackNumber) matches = true;
            });
          }
        });
        if (matches && time !== null) times.push((time * state.timestampScale) / 1e9);
      });
      return times;
    }

    async function clusterIndex(state, trackNumber) {
      const reader = new Reader(state.file, {
        deadline: performance.now() + INDEX_SCAN_TIMEOUT_MS,
        timeoutMs: INDEX_SCAN_TIMEOUT_MS,
        timeoutLabel: 'Matroska cluster scan',
      });
      const times = [];
      let clusters = 0;
      let offset = state.segment.dataOffset;
      while (offset < state.segment.end && clusters < MAX_INDEX_CLUSTERS) {
        const element = await elementAt(reader, offset, state.segment.end);
        if (element.id !== ID.CLUSTER) {
          offset = requireKnown(element, 'A top-level Matroska element');
          continue;
        }
        clusters += 1;
        const limit = element.end ?? state.segment.end;
        let child = element.dataOffset;
        let clusterTimestamp = null;
        let decided = false;
        while (child < limit) {
          const field = await elementAt(reader, child, limit);
          if (element.end === null && TOP_LEVEL_IDS.has(field.id)) break;
          if (field.id === ID.CLUSTER_TIMESTAMP) clusterTimestamp = await unsigned(reader, field);
          if (!decided && clusterTimestamp !== null && (field.id === ID.SIMPLE_BLOCK || field.id === ID.BLOCK_GROUP)) {
            const key = await blockKey(reader, field, trackNumber);
            if (key !== null) {
              decided = true;
              if (key.key) times.push(((clusterTimestamp + key.relativeTimestamp) * state.timestampScale) / 1e9);
              if (element.end !== null) break;
            }
          }
          child = requireKnown(field, 'A Cluster child element');
        }
        offset = element.end ?? child;
      }
      return times;
    }

    /* For a SimpleBlock or BlockGroup of `trackNumber`: its relative time and whether
       it is a key frame. Null for another track. */
    async function blockKey(reader, element, trackNumber) {
      let blockElement = element;
      let referenced = false;
      if (element.id === ID.BLOCK_GROUP) {
        blockElement = null;
        await children(reader, element, async child => {
          if (child.id === ID.BLOCK) blockElement = child;
          if (child.id === ID.REFERENCE_BLOCK) referenced = true;
        });
        if (!blockElement) return null;
      }
      const prefix = await reader.bytes(blockElement.dataOffset, Math.min(blockElement.dataSize, 12));
      if (!prefix.length) return null;
      const trackVint = vintLength(prefix[0], 8, 'Block track number');
      if (trackVint.length + 3 > prefix.length) return null;
      let number = prefix[0] & (trackVint.marker - 1);
      for (let index = 1; index < trackVint.length; index += 1) number = (number * 256) + prefix[index];
      if (number !== trackNumber) return null;
      const raw = (prefix[trackVint.length] << 8) | prefix[trackVint.length + 1];
      const relativeTimestamp = raw & 0x8000 ? raw - 0x10000 : raw;
      const key = element.id === ID.SIMPLE_BLOCK ? (prefix[trackVint.length + 2] & 0x80) !== 0 : !referenced;
      return { relativeTimestamp, key };
    }

    /** Key frame times for the nth video track (1-based, in file order). */
    function keyframes(state, videoNumber) {
      const video = state.mediaTracks.filter(track => track.type === 1)[videoNumber - 1];
      if (!video) return Promise.resolve([]);
      if (!state.keyframeCache.has(video.number)) {
        const task = (state.cuesElement ? cueIndex(state, video.number) : clusterIndex(state, video.number))
          .then(times => [...new Set(times.map(time => Math.max(0, time)))].sort((left, right) => left - right));
        state.keyframeCache.set(video.number, task);
        task.catch(() => {
          if (state.keyframeCache.get(video.number) === task) state.keyframeCache.delete(video.number);
        });
      }
      return state.keyframeCache.get(video.number);
    }

    /* Matroska attachments (fonts for ASS). The index (names, types, offsets) is cached;
       the bytes are read on each call and never held by the engine, so the caller's copy
       is the only one and goes when the caller drops it (review V17). */
    function attachmentIndex(state) {
      state.attachmentCache ??= (async () => {
        const reader = new Reader(state.file, {
          deadline: performance.now() + INDEX_SCAN_TIMEOUT_MS,
          timeoutMs: INDEX_SCAN_TIMEOUT_MS,
          timeoutLabel: 'Matroska attachment read',
        });
        const entries = [];
        await children(reader, state.attachmentsElement, async entry => {
          if (entry.id !== ID.ATTACHED_FILE) return;
          const item = { name: null, mimeType: null, dataOffset: null, bytes: 0 };
          await children(reader, entry, async field => {
            if (field.id === ID.FILE_NAME) item.name = await textValue(reader, field);
            if (field.id === ID.FILE_MIME_TYPE) item.mimeType = await textValue(reader, field);
            if (field.id === ID.FILE_DATA) {
              item.dataOffset = field.dataOffset;
              item.bytes = field.dataSize;
            }
          });
          if (item.dataOffset !== null) {
            entries.push({
              name: item.name || 'attachment',
              mimeType: item.mimeType || 'application/octet-stream',
              dataOffset: item.dataOffset,
              bytes: item.bytes,
            });
          }
        });
        return planFontAttachments(entries, {
          maxFileBytes: MAX_ATTACHMENT_BYTES,
          maxTotalBytes: MAX_ATTACHMENTS_TOTAL_BYTES,
          maxFiles: MAX_ATTACHMENT_FILES,
        });
      })();
      state.attachmentCache.catch(() => { state.attachmentCache = null; });
      return state.attachmentCache;
    }

    /** Font attachments [{ name, mimeType, data }] with a `skipped` list [{ name, mimeType, bytes, reason }]. */
    async function attachments(state) {
      if (!state.attachmentsElement) return Object.assign([], { skipped: [] });
      const plan = await attachmentIndex(state);
      const files = [];
      for (const item of plan.fonts) {
        const data = new Uint8Array(await state.file.slice(item.dataOffset, item.dataOffset + item.bytes).arrayBuffer());
        files.push({ name: item.name, mimeType: item.mimeType, data });
      }
      return Object.assign(files, { skipped: plan.skipped.map(item => ({ ...item })) });
    }

    function descriptor(track, sessionId, duration) {
      const codec = subtitleCodec(track.codecId);
      return {
        id: `${sessionId}:subtitle:${track.number}`,
        sessionId,
        sourceId: track.number,
        number: track.number,
        type: 'subtitle',
        codec,
        codecParameter: track.codecId,
        internalCodecId: track.codecId,
        name: track.name,
        language: track.language,
        disposition: track.disposition,
        bitrate: null,
        averageBitrate: null,
        duration,
        startTimestamp: null,
        decoderConfig: null,
        initialization: track.codecPrivate,
        embedded: true,
        bitmap: BITMAP_CODECS.has(track.codecId),
      };
    }

    async function inspect(file, sessionId, duration) {
      const state = await metadata(file);
      const descriptors = state.tracks.map(track => descriptor(track, sessionId, duration));
      const trackById = new Map(descriptors.map((item, index) => [item.id, state.tracks[index]]));
      return {
        state,
        descriptors,
        trackById,
        chapters: state.chapters,
        cues: (track, mediaDuration) => cues(state, track, mediaDuration),
        keyframes: videoNumber => keyframes(state, videoNumber),
        attachments: () => attachments(state),
        videoTrackCount: state.mediaTracks.filter(track => track.type === 1).length,
        videoInterlace: state.mediaTracks.filter(track => track.type === 1)
          .map(track => ({ interlaced: track.interlaced, fieldOrder: track.fieldOrder })),
      };
    }

    /* A rejected scan is not kept (review V50), so the next request reads again. */
    function cues(state, track, mediaDuration) {
      if (!state.cueCache.has(track.number)) {
        const task = readCues(state, track, mediaDuration);
        state.cueCache.set(track.number, task);
        task.catch(() => {
          if (state.cueCache.get(track.number) === task) state.cueCache.delete(track.number);
        });
      }
      return state.cueCache.get(track.number);
    }

    return { inspect, cues };
  })();

  /* Mediabunny does not expose MP4 timed-text tracks (tx3g, FFmpeg's mov_text). This
     reader finds them in the moov box and reads their samples with ranged reads:
     each sample is a 16-bit length and the text (UTF-8, or UTF-16 with a BOM). */
  const Mp4Text = (() => {
    const MAX_MOOV_BYTES = 64 * 1024 * 1024;
    const MAX_SAMPLE_SPAN_BYTES = 16 * 1024 * 1024;
    const utf8 = new TextDecoder('utf-8');
    const utf16 = new TextDecoder('utf-16be');

    function fourcc(view, offset) {
      return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
    }

    function* boxes(view, start, end) {
      let offset = start;
      while (offset + 8 <= end) {
        let size = view.getUint32(offset);
        const type = fourcc(view, offset + 4);
        let header = 8;
        if (size === 1) {
          if (offset + 16 > end) return;
          size = Number(view.getBigUint64(offset + 8));
          header = 16;
        } else if (size === 0) {
          size = end - offset;
        }
        if (size < header || offset + size > end) return;
        yield { type, start: offset + header, end: offset + size };
        offset += size;
      }
    }

    function child(view, box, type) {
      for (const item of boxes(view, box.start, box.end)) if (item.type === type) return item;
      return null;
    }

    function path(view, box, types) {
      let current = box;
      for (const type of types) {
        current = current && child(view, current, type);
      }
      return current;
    }

    async function readMoov(file) {
      let offset = 0;
      for (let guard = 0; guard < 10_000 && offset + 8 <= file.size; guard += 1) {
        const head = new DataView(await file.slice(offset, Math.min(file.size, offset + 16)).arrayBuffer());
        let size = head.getUint32(0);
        const type = fourcc(head, 4);
        if (size === 1 && head.byteLength >= 16) size = Number(head.getBigUint64(8));
        else if (size === 0) size = file.size - offset;
        if (size < 8) return null;
        if (type === 'moov') {
          if (size > MAX_MOOV_BYTES) {
            throw fail('Mp4TextLimitError', 'ERR_DEMUX_MP4_MOOV_LIMIT', `The MP4 moov box exceeds ${MAX_MOOV_BYTES} bytes.`);
          }
          return new DataView(await file.slice(offset, offset + size).arrayBuffer());
        }
        offset += size;
      }
      return null;
    }

    function language(code) {
      if (!code) return null;
      const chars = [(code >> 10) & 31, (code >> 5) & 31, code & 31].map(value => String.fromCharCode(value + 0x60));
      const text = chars.join('');
      return /^[a-z]{3}$/.test(text) && text !== 'und' ? text : null;
    }

    // QuickTime 'fiel': field count, then detail (1 and 14 top first; 6 and 9 bottom first).
    /* A tkhd matrix with a negative determinant mirrors the picture (review V46). FFmpeg's
       display_hflip negates the first column, a flip applied after the rotation, which
       Mediabunny reports unchanged. */
    function mirrored(view, trak) {
      const tkhd = child(view, trak, 'tkhd');
      if (!tkhd) return false;
      const at = tkhd.start + (view.getUint8(tkhd.start) === 1 ? 52 : 40);
      if (at + 20 > tkhd.end) return false;
      const a = view.getInt32(at);
      const b = view.getInt32(at + 4);
      const c = view.getInt32(at + 12);
      const d = view.getInt32(at + 16);
      return (a * d) - (b * c) < 0;
    }

    function videoInterlace(view, trak) {
      const handler = path(view, trak, ['mdia', 'hdlr']);
      if (!handler || fourcc(view, handler.start + 8) !== 'vide') return null;
      const flip = mirrored(view, trak);
      const plain = videoFields(view, trak);
      return { ...plain, flip };
    }

    function videoFields(view, trak) {
      const stsd = path(view, trak, ['mdia', 'minf', 'stbl', 'stsd']);
      if (!stsd || view.getUint32(stsd.start + 4) < 1) return { interlaced: false, fieldOrder: null };
      const entryStart = stsd.start + 8;
      const entrySize = view.getUint32(entryStart);
      const entry = { start: entryStart + 8 + 78, end: Math.min(stsd.end, entryStart + entrySize) };
      const fiel = entry.start < entry.end ? child(view, entry, 'fiel') : null;
      if (!fiel || fiel.end - fiel.start < 2 || view.getUint8(fiel.start) !== 2) return { interlaced: false, fieldOrder: null };
      const detail = view.getUint8(fiel.start + 1);
      return { interlaced: true, fieldOrder: [1, 14].includes(detail) ? 'tff' : [6, 9].includes(detail) ? 'bff' : 'unknown' };
    }

    function trackIdOf(view, trak) {
      const tkhd = child(view, trak, 'tkhd');
      if (!tkhd) return null;
      return view.getUint32(tkhd.start + (view.getUint8(tkhd.start) === 1 ? 20 : 12));
    }

    /* Track ids named by any track's tref/chap: QuickTime chapter tracks (review V39). */
    function chapterTrackIds(view, moov) {
      const ids = new Set();
      for (const box of boxes(view, moov.start, moov.end)) {
        if (box.type !== 'trak') continue;
        const chap = path(view, box, ['tref', 'chap']);
        if (!chap) continue;
        for (let at = chap.start; at + 4 <= chap.end; at += 4) ids.add(view.getUint32(at));
      }
      return ids;
    }

    /* Nero chapters, moov/udta/chpl: version, flags, (version 1: 4 reserved bytes), a count,
       then per chapter a 64-bit start in 100 ns units and a length-prefixed UTF-8 title. */
    function neroChapters(view, moov) {
      const chpl = path(view, moov, ['udta', 'chpl']);
      if (!chpl) return [];
      let at = chpl.start + 4 + (view.getUint8(chpl.start) === 1 ? 4 : 0);
      if (at >= chpl.end) return [];
      const count = view.getUint8(at);
      at += 1;
      const chapters = [];
      for (let index = 0; index < count && at + 9 <= chpl.end; index += 1) {
        const startS = Number(view.getBigUint64(at)) / 10_000_000;
        const length = view.getUint8(at + 8);
        at += 9;
        if (at + length > chpl.end) break;
        const title = utf8.decode(new Uint8Array(view.buffer, view.byteOffset + at, length));
        at += length;
        chapters.push({ startS, endS: null, title, language: null, depth: 0 });
      }
      return chapters;
    }

    function endChapters(chapters, duration) {
      chapters.sort((left, right) => left.startS - right.startS);
      chapters.forEach((chapter, index) => {
        if (chapter.endS === null) chapter.endS = chapters[index + 1]?.startS ?? (Number.isFinite(duration) ? duration : null);
      });
      return chapters;
    }

    function parseTrack(view, trak, { chapter = false } = {}) {
      const handler = path(view, trak, ['mdia', 'hdlr']);
      if (!handler || !['sbtl', 'text'].includes(fourcc(view, handler.start + 8))) return null;
      const stbl = path(view, trak, ['mdia', 'minf', 'stbl']);
      const stsd = stbl && child(view, stbl, 'stsd');
      const entry = stsd && view.getUint32(stsd.start + 4) >= 1 ? fourcc(view, stsd.start + 12) : null;
      // Chapter tracks may be QuickTime 'text' as well as 'tx3g'; both store a 16-bit length and the text.
      if (entry !== 'tx3g' && !(chapter && entry === 'text')) return null;
      const tkhd = child(view, trak, 'tkhd');
      const mdhd = path(view, trak, ['mdia', 'mdhd']);
      if (!tkhd || !mdhd) return null;
      const tkhdVersion = view.getUint8(tkhd.start);
      const trackId = view.getUint32(tkhd.start + (tkhdVersion === 1 ? 20 : 12));
      const mdhdVersion = view.getUint8(mdhd.start);
      const timescale = view.getUint32(mdhd.start + (mdhdVersion === 1 ? 20 : 12));
      const lang = view.getUint16(mdhd.start + (mdhdVersion === 1 ? 32 : 20));
      if (!timescale) return null;

      const stts = child(view, stbl, 'stts');
      const stsc = child(view, stbl, 'stsc');
      const stsz = child(view, stbl, 'stsz');
      const stco = child(view, stbl, 'stco');
      const co64 = child(view, stbl, 'co64');
      if (!stts || !stsc || !stsz || (!stco && !co64)) return null;

      const durations = [];
      for (let index = 0, count = view.getUint32(stts.start + 4); index < count; index += 1) {
        const entry = stts.start + 8 + (index * 8);
        const samples = view.getUint32(entry);
        const delta = view.getUint32(entry + 4);
        for (let sample = 0; sample < samples && durations.length < CONFIG.demux.maxSubtitleCues; sample += 1) durations.push(delta);
      }
      const uniformSize = view.getUint32(stsz.start + 4);
      const sampleCount = Math.min(view.getUint32(stsz.start + 8), durations.length);
      const sizes = Array.from({ length: sampleCount }, (_, index) => (
        uniformSize || view.getUint32(stsz.start + 12 + (index * 4))
      ));
      const chunkBox = co64 || stco;
      const chunkCount = view.getUint32(chunkBox.start + 4);
      const chunkOffsets = Array.from({ length: chunkCount }, (_, index) => (co64
        ? Number(view.getBigUint64(chunkBox.start + 8 + (index * 8)))
        : view.getUint32(chunkBox.start + 8 + (index * 4))));
      const runs = [];
      for (let index = 0, count = view.getUint32(stsc.start + 4); index < count; index += 1) {
        const entry = stsc.start + 8 + (index * 12);
        runs.push({ firstChunk: view.getUint32(entry), perChunk: view.getUint32(entry + 4) });
      }
      const offsets = [];
      for (let run = 0; run < runs.length && offsets.length < sampleCount; run += 1) {
        const lastChunk = (runs[run + 1]?.firstChunk ?? chunkCount + 1) - 1;
        for (let chunk = runs[run].firstChunk; chunk <= lastChunk && offsets.length < sampleCount; chunk += 1) {
          let position = chunkOffsets[chunk - 1];
          for (let sample = 0; sample < runs[run].perChunk && offsets.length < sampleCount; sample += 1) {
            offsets.push(position);
            position += sizes[offsets.length - 1];
          }
        }
      }
      return { trackId, timescale, language: language(lang), durations, sizes, offsets };
    }

    async function inspect(file, sessionId, duration) {
      const view = await readMoov(file);
      if (!view) return null;
      const moov = { start: 8, end: view.byteLength };
      const tracks = [];
      const interlace = [];
      const chapterIds = chapterTrackIds(view, moov);
      let chapterTrack = null;
      for (const box of boxes(view, moov.start, moov.end)) {
        if (box.type !== 'trak') continue;
        const video = videoInterlace(view, box);
        if (video) interlace.push(video);
        if (chapterIds.has(trackIdOf(view, box))) {
          chapterTrack ??= parseTrack(view, box, { chapter: true });
          continue;
        }
        const track = parseTrack(view, box);
        if (track) tracks.push(track);
      }
      let chapters = neroChapters(view, moov);
      if (!chapters.length && chapterTrack) {
        chapters = (await readCues(file, chapterTrack).catch(() => []))
          .map(cue => ({ startS: cue.startS, endS: cue.endS, title: cue.text, language: chapterTrack.language, depth: 0 }));
      }
      chapters = endChapters(chapters, duration);
      if (!tracks.length && !chapters.length && !interlace.some(item => item.interlaced || item.flip)) return null;
      const descriptors = tracks.map(track => ({
        id: `${sessionId}:subtitle:mp4-${track.trackId}`,
        sessionId,
        sourceId: track.trackId,
        number: track.trackId,
        type: 'subtitle',
        codec: 'tx3g',
        codecParameter: 'tx3g',
        internalCodecId: 'tx3g',
        name: null,
        language: track.language,
        disposition: { default: false, forced: false, hearingImpaired: false, visualImpaired: false, descriptions: false, original: false, commentary: false },
        bitrate: null,
        averageBitrate: null,
        duration,
        startTimestamp: null,
        decoderConfig: null,
        initialization: null,
        embedded: true,
        bitmap: false,
      }));
      const trackById = new Map(descriptors.map((item, index) => [item.id, tracks[index]]));
      const cueCache = new Map();
      return {
        state: null,
        descriptors,
        trackById,
        chapters,
        cues: track => {
          if (!cueCache.has(track.trackId)) {
            const task = readCues(file, track);
            cueCache.set(track.trackId, task);
            task.catch(() => {
              if (cueCache.get(track.trackId) === task) cueCache.delete(track.trackId);
            });
          }
          return cueCache.get(track.trackId);
        },
        keyframes: null,
        attachments: () => Promise.resolve([]),
        videoTrackCount: null,
        videoInterlace: interlace,
      };
    }

    /* Sample sizes come from the file, so each is capped at the subtitle cue limit and the
       whole read has the subtitle scan deadline (review V53). */
    async function readCues(file, track) {
      const count = track.offsets.length;
      if (!count) return [];
      const maxSample = CONFIG.demux.maxSubtitleCueBytes;
      const deadline = performance.now() + CONFIG.demux.subtitleScanTimeoutMs;
      let low = Infinity;
      let high = 0;
      for (let index = 0; index < count; index += 1) {
        if (track.sizes[index] > maxSample) continue;
        low = Math.min(low, track.offsets[index]);
        high = Math.max(high, track.offsets[index] + track.sizes[index]);
      }
      const span = high > low && high - low <= MAX_SAMPLE_SPAN_BYTES && high <= file.size
        ? new Uint8Array(await file.slice(low, high).arrayBuffer())
        : null;
      const cues = [];
      let textBytes = 0;
      let time = 0;
      for (let index = 0; index < count; index += 1) {
        const start = time / track.timescale;
        time += track.durations[index];
        const size = track.sizes[index];
        if (size < 2 || size > maxSample || track.offsets[index] + size > file.size) continue;
        if (!span && performance.now() > deadline) {
          throw fail('DemuxTimeoutError', 'ERR_DEMUX_TIMEOUT', `MP4 timed text read exceeded ${CONFIG.demux.subtitleScanTimeoutMs} ms.`);
        }
        const bytes = span
          ? span.subarray(track.offsets[index] - low, track.offsets[index] - low + size)
          : new Uint8Array(await file.slice(track.offsets[index], track.offsets[index] + size).arrayBuffer());
        const length = Math.min((bytes[0] << 8) | bytes[1], bytes.byteLength - 2);
        if (length <= 0) continue;
        textBytes += length;
        if (textBytes > CONFIG.demux.maxSubtitleTextBytes) {
          throw fail('SubtitleTextLimitError', 'ERR_DEMUX_SUBTITLE_TEXT_LIMIT', `A subtitle track exceeds ${CONFIG.demux.maxSubtitleTextBytes} text bytes.`);
        }
        const body = bytes.subarray(2, 2 + length);
        const text = body[0] === 0xFE && body[1] === 0xFF ? utf16.decode(body.subarray(2)) : utf8.decode(body);
        cues.push({ startS: start, endS: time / track.timescale, text: text.replace(/\r\n?/g, '\n'), data: null, id: null, settings: '' });
      }
      return cues;
    }

    return { inspect };
  })();

  async function sourceFor(handle) {
    const isUrl = typeof handle === 'string'
      || Object.prototype.toString.call(handle) === '[object URL]';
    if (isUrl) {
      throw fail(
        'RemoteMediaUrlError',
        'ERR_DEMUX_REMOTE_URL',
        'Reel M0 accepts local Files, Blobs, and file handles. Media URLs are deferred.',
      );
    }

    const file = await mediaFileOf(handle);
    if (!(file instanceof Blob) && !(file instanceof RangedFile)) {
      throw fail(
        'InvalidMediaHandleError',
        'ERR_DEMUX_HANDLE',
        'Expected a File, Blob, file handle, or ranged reader.',
      );
    }
    if (file.size === 0) {
      throw fail('EmptyMediaError', 'ERR_DEMUX_EMPTY', 'The selected file is empty.');
    }
    const name = file.name || 'untitled';
    const signature = new Uint8Array(await file.slice(0, ASF_SIGNATURE.byteLength).arrayBuffer());
    const header = startsWith(signature, ASF_SIGNATURE)
      ? new Uint8Array(await file.slice(0, Math.min(file.size, 64 * 1024)).arrayBuffer())
      : signature;
    refuseDetectedFormat(signature, header);
    return {
      source: file instanceof RangedFile
        ? new StreamSource({
          getSize: () => file.size,
          read: (start, end) => readRanged(file.reader, file.start + start, end - start),
          prefetchProfile: 'fileSystem',
        })
        : new BlobSource(file),
      name,
      size: file.size,
      file,
    };
  }

  /* Cues and chapters in the container's time, moved onto Reel's timeline (see startOffsetS). */
  function shiftTimes(items, offsetS) {
    if (!(offsetS > 0)) return items;
    return items.map(item => ({
      ...item,
      startS: Math.max(0, item.startS - offsetS),
      endS: Number.isFinite(item.endS) ? Math.max(0, item.endS - offsetS) : item.endS,
    }));
  }

  async function describeTrack(nativeTrack, sessionId) {
    const [
      codec,
      codecParameter,
      internalCodecId,
      name,
      language,
      disposition,
      bitrate,
      averageBitrate,
      duration,
      startTimestamp,
      decoderConfig,
    ] = await Promise.all([
      nativeTrack.getCodec(),
      nativeTrack.getCodecParameterString(),
      nativeTrack.getInternalCodecId(),
      nativeTrack.getName(),
      nativeTrack.getLanguageCode(),
      nativeTrack.getDisposition(),
      nativeTrack.getBitrate(),
      nativeTrack.getAverageBitrate(),
      nativeTrack.getDurationFromMetadata({ skipLiveWait: true }),
      nativeTrack.getFirstTimestamp(),
      nativeTrack.getDecoderConfig(),
    ]);

    const descriptor = {
      id: `${sessionId}:${nativeTrack.type}:${nativeTrack.id}`,
      sessionId,
      sourceId: nativeTrack.id,
      number: nativeTrack.number,
      type: nativeTrack.type,
      codec,
      codecParameter,
      internalCodecId: normalizeInternalCodecId(internalCodecId),
      name,
      language,
      disposition,
      bitrate: finiteOrNull(bitrate),
      averageBitrate: finiteOrNull(averageBitrate),
      duration: finiteOrNull(duration),
      startTimestamp: finiteOrNull(startTimestamp),
      decoderConfig,
    };

    if (nativeTrack.isVideoTrack()) {
      const [codedWidth, codedHeight, displayWidth, displayHeight, rotation] = await Promise.all([
        nativeTrack.getCodedWidth(),
        nativeTrack.getCodedHeight(),
        nativeTrack.getDisplayWidth(),
        nativeTrack.getDisplayHeight(),
        nativeTrack.getRotation(),
      ]);
      Object.assign(descriptor, { codedWidth, codedHeight, displayWidth, displayHeight, rotation });
    } else if (nativeTrack.isAudioTrack()) {
      const [channels, sampleRate] = await Promise.all([
        nativeTrack.getNumberOfChannels(),
        nativeTrack.getSampleRate(),
      ]);
      Object.assign(descriptor, { channels, sampleRate });
    }

    return descriptor;
  }

  const CONTAINER_NAMES = new Map([
    [MP4, 'mp4'],
    [QTFF, 'mov'],
    [WEBM, 'webm'],
    [MATROSKA, 'mkv'],
    [MP3, 'mp3'],
    [FLAC, 'flac'],
    [OGG, 'ogg'],
    [WAVE, 'wav'],
    [MPEG_TS, 'ts'],
  ]);

  /* Mediabunny's Ogg reader skips video streams, so an .ogv would otherwise play as
     sound with no picture. Every Ogg stream opens with a beginning-of-stream page
     before any data page; read those pages and refuse video by name. */
  const OGG_VIDEO_SIGNATURES = [
    { codec: 'Theora', bytes: [0x80, 0x74, 0x68, 0x65, 0x6F, 0x72, 0x61] },
    { codec: 'VP8', bytes: [0x4F, 0x56, 0x50, 0x38, 0x30] },
    { codec: 'Daala', bytes: [0x80, 0x64, 0x61, 0x61, 0x6C, 0x61] },
    { codec: 'OGM video', bytes: [0x01, 0x76, 0x69, 0x64, 0x65, 0x6F] },
  ];

  async function refuseOggVideo(file) {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 256 * 1024)).arrayBuffer());
    let offset = 0;
    for (let page = 0; page < 64 && offset + 27 <= head.byteLength; page += 1) {
      if (head[offset] !== 0x4F || head[offset + 1] !== 0x67 || head[offset + 2] !== 0x67 || head[offset + 3] !== 0x53) return;
      const beginsStream = (head[offset + 5] & 0x02) !== 0;
      if (!beginsStream) return;
      const segments = head[offset + 26];
      const bodyOffset = offset + 27 + segments;
      if (bodyOffset > head.byteLength) return;
      let bodySize = 0;
      for (let index = 0; index < segments; index += 1) bodySize += head[offset + 27 + index];
      const body = head.subarray(bodyOffset, Math.min(head.byteLength, bodyOffset + bodySize));
      for (const signature of OGG_VIDEO_SIGNATURES) {
        if (startsWith(body, Uint8Array.from(signature.bytes))) {
          throw fail(
            'UnsupportedCodecError',
            'ERR_DEMUX_OGG_VIDEO',
            `${signature.codec} video inside Ogg is not supported, because Reel's demuxer reads only Ogg audio.`,
          );
        }
      }
      offset = bodyOffset + bodySize;
    }
  }

  async function inspect(input, sourceInfo, sessionId) {
    if (!await input.canRead()) {
      throw fail(
        'UnsupportedContainerError',
        'ERR_DEMUX_UNSUPPORTED_CONTAINER',
        'Reel supports MP4, MOV, MKV, WebM, MPEG-TS, MP3, FLAC, Ogg, and WAV containers.',
      );
    }

    const [format, nativeTracks, metadataDuration, mimeType] = await Promise.all([
      input.getFormat(),
      input.getTracks(),
      input.getDurationFromMetadata(undefined, { skipLiveWait: true }),
      input.getMimeType(),
    ]);
    if (!nativeTracks.length) {
      throw fail('NoMediaTracksError', 'ERR_DEMUX_NO_TRACKS', 'The container has no readable media tracks.');
    }
    if (nativeTracks.length > CONFIG.demux.maxTrackCount) {
      throw fail(
        'TrackLimitError',
        'ERR_DEMUX_TRACK_LIMIT',
        `The container declares ${nativeTracks.length} tracks; Reel accepts at most ${CONFIG.demux.maxTrackCount}.`,
      );
    }

    const duration = metadataDuration ?? await input.computeDuration(nativeTracks, { skipLiveWait: true });
    if (!Number.isFinite(duration) || duration < 0) {
      throw fail('InvalidDurationError', 'ERR_DEMUX_DURATION', 'The container reports an invalid duration.');
    }

    const container = CONTAINER_NAMES.get(format) || 'wav';
    if (container === 'ogg' && sourceInfo.file) await refuseOggVideo(sourceInfo.file);
    const nativeDescriptors = await Promise.all(nativeTracks.map(track => describeTrack(track, sessionId)));
    // Position 0 is the first presented frame or sample of any track. MPEG-TS (and any
    // container whose timestamps start late) carries a start offset, for example 1.4 s;
    // packets, samples, cues, chapters and key frames are shifted by it at this boundary,
    // and the duration becomes end minus start. A start at or below 0 (MP4 edit lists,
    // AAC priming) keeps today's timeline, so the offset is never negative.
    const starts = nativeDescriptors.map(track => track.startTimestamp).filter(Number.isFinite);
    const startOffsetS = starts.length ? Math.max(0, Math.min(...starts)) : 0;
    if (startOffsetS > 0) {
      for (const track of nativeDescriptors) {
        if (Number.isFinite(track.startTimestamp)) track.startTimestamp -= startOffsetS;
        if (Number.isFinite(track.duration)) track.duration = Math.max(0, track.duration - startOffsetS);
      }
    }
    const mediaDuration = Math.max(0, duration - startOffsetS);
    const nativeById = new Map(nativeDescriptors.map((track, index) => [track.id, nativeTracks[index]]));
    let textInspection = null;
    const warnings = [];
    if (sourceInfo.file && ['mkv', 'webm'].includes(container)) {
      // A damaged subtitle, chapter or attachment element must not refuse a file whose
      // video and audio Mediabunny read (review V12): drop the text tracks and warn.
      textInspection = await MatroskaText.inspect(sourceInfo.file, sessionId, duration).catch(error => {
        warnings.push({
          code: error?.code || 'ERR_DEMUX_TEXT_TRACKS',
          message: `Subtitles, chapters and attachments were skipped: ${error?.message || error}`,
        });
        return null;
      });
    } else if (sourceInfo.file && ['mp4', 'mov'].includes(container)) {
      // A damaged text track must not stop the video, so MP4 text errors drop the track list.
      textInspection = await Mp4Text.inspect(sourceInfo.file, sessionId, duration).catch(error => {
        warnings.push({
          code: error?.code || 'ERR_DEMUX_TEXT_TRACKS',
          message: `Timed text and chapters were skipped: ${error?.message || error}`,
        });
        return null;
      });
    }
    // Mark interlaced video from the container (nth video track in file order).
    const interlace = textInspection?.videoInterlace || [];
    nativeDescriptors.filter(track => track.type === 'video').forEach((track, index) => {
      track.interlaced = !!interlace[index]?.interlaced;
      track.fieldOrder = interlace[index]?.fieldOrder || null;
      if (interlace[index]?.flip) track.flip = true;
    });
    const textDescriptors = (textInspection?.descriptors || []).map(track => (
      startOffsetS > 0 ? { ...track, duration: mediaDuration } : track
    ));
    const tracks = nativeDescriptors.concat(textDescriptors);
    if (tracks.length > CONFIG.demux.maxTrackCount) {
      throw fail(
        'TrackLimitError',
        'ERR_DEMUX_TRACK_LIMIT',
        `The container declares ${tracks.length} tracks; Reel accepts at most ${CONFIG.demux.maxTrackCount}.`,
      );
    }
    return {
      result: {
        sessionId,
        name: sourceInfo.name,
        size: sourceInfo.size,
        container,
        format: format.name,
        mimeType,
        duration: mediaDuration,
        tracks,
        chapters: shiftTimes(textInspection?.chapters || [], startOffsetS),
        warnings,
      },
      nativeById,
      textInspection,
      startOffsetS,
      rawDuration: duration,
    };
  }

  async function prepare(handle) {
    let input = null;
    try {
      const sourceInfo = await sourceFor(handle);
      input = new Input({ formats: FORMATS, source: sourceInfo.source });
      const sessionId = `demux-${nextSessionId++}`;
      const inspected = await withTimeout(inspect(input, sourceInfo, sessionId), 'Container probe', {
        onTimeout: () => input?.dispose(),
      });
      const candidate = {
        result: inspected.result,
        session: {
        input,
        nativeById: inspected.nativeById,
        textInspection: inspected.textInspection,
        sessionId,
        container: inspected.result.container,
        // The container's own end time: the text readers close open cues against it.
        duration: inspected.rawDuration,
        startOffsetS: inspected.startOffsetS,
        },
      };
      input = null;
      return candidate;
    } catch (error) {
      if (input) input.dispose();
      throw wrapFailure(error);
    }
  }

  function discard(candidate) {
    if (!candidate?.session) return;
    candidate.session.input.dispose();
    candidate.session = null;
  }

  function activate(candidate) {
    if (!candidate?.session) {
      throw fail('InvalidDemuxCandidateError', 'ERR_DEMUX_CANDIDATE', 'The demux candidate is unavailable.');
    }
    const previous = active;
    active = candidate.session;
    candidate.session = null;
    if (previous) previous.input?.dispose();
    return candidate.result;
  }

  /* A file the libav rung reopens (review V11) keeps what Mediabunny and Reel's own
     readers found in the container: subtitle tracks, chapters, attachments, and track
     names and languages. The Mediabunny input closes; the text readers stay active for
     subtitles.cues(), packets() and attachments(). `startOffsetS` is the rung's own
     timeline offset, so cue times match the frames it decodes. */
  function activateText(candidate, { startOffsetS = null } = {}) {
    if (!candidate?.session) return null;
    const session = candidate.session;
    candidate.session = null;
    session.input.dispose();
    const previous = active;
    active = {
      ...session,
      input: null,
      nativeById: new Map(),
      startOffsetS: Number.isFinite(startOffsetS) ? Math.max(0, startOffsetS) : session.startOffsetS,
    };
    if (previous) previous.input?.dispose();
    const shift = active.startOffsetS - (session.startOffsetS || 0);
    const result = candidate.result;
    return {
      sessionId: active.sessionId,
      chapters: shiftTimes(result.chapters || [], shift),
      subtitles: result.tracks.filter(track => track.type === 'subtitle'),
      named: result.tracks.filter(track => track.type === 'video' || track.type === 'audio'),
    };
  }

  async function probe(handle) {
    const candidate = await prepare(handle);
    try {
      return candidate.result;
    } finally {
      discard(candidate);
    }
  }

  async function* packets(track, fromPts = 0) {
    if (!active || !track || track.sessionId !== active.sessionId) {
      throw fail('StaleTrackError', 'ERR_DEMUX_STALE_TRACK', 'The track does not belong to the active media session.');
    }
    if (!Number.isFinite(fromPts) || fromPts < 0) {
      throw fail('InvalidTimestampError', 'ERR_DEMUX_TIMESTAMP', 'Packet start time must be a finite non-negative number.');
    }
    const nativeTrack = active.nativeById.get(track.id);
    if (!nativeTrack) {
      throw fail('UnknownTrackError', 'ERR_DEMUX_TRACK', 'The requested track was not found.');
    }
    if (!nativeTrack.isVideoTrack() && !nativeTrack.isAudioTrack()) {
      throw fail('UnsupportedTrackError', 'ERR_DEMUX_TRACK_TYPE', `Packets are unavailable for ${nativeTrack.type} tracks.`);
    }

    const offsetS = active.startOffsetS || 0;
    fromPts += offsetS;
    try {
      const sink = new EncodedPacketSink(nativeTrack);
      const packetTimeoutMs = CONFIG.demux.packetReadTimeoutMs ?? CONFIG.demux.probeTimeoutMs;
      const timedPacketRead = (operation, label) => withTimeout(operation, label, { timeoutMs: packetTimeoutMs });
      const firstTimestamp = await timedPacketRead(nativeTrack.getFirstTimestamp(), `${track.type} first timestamp`);
      let startPacket;
      if (nativeTrack.isVideoTrack()) {
        startPacket = fromPts <= firstTimestamp
          ? await timedPacketRead(sink.getFirstKeyPacket({ verifyKeyPackets: true }), 'Video packet seek')
          : await timedPacketRead(sink.getKeyPacket(fromPts, { verifyKeyPackets: true }), 'Video packet seek');
        startPacket ??= await timedPacketRead(
          sink.getFirstKeyPacket({ verifyKeyPackets: true }),
          'Video first-packet fallback',
        );
      } else {
        startPacket = fromPts <= firstTimestamp
          ? await timedPacketRead(sink.getFirstPacket(), 'Audio packet seek')
          : await timedPacketRead(sink.getPacket(fromPts), 'Audio packet seek');
        startPacket ??= await timedPacketRead(sink.getFirstPacket(), 'Audio first-packet fallback');
      }
      if (!startPacket) return;

      const iterator = sink.packets(startPacket)[Symbol.asyncIterator]();
      try {
        while (true) {
          const step = await timedPacketRead(iterator.next(), `${track.type} packet read`);
          if (step.done) break;
          let packet = step.value;
          if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration)) {
            throw fail('MalformedPacketError', 'ERR_DEMUX_PACKET_TIME', 'A packet has invalid timing metadata.');
          }
          if (offsetS > 0) packet = packet.clone({ timestamp: packet.timestamp - offsetS });
          yield nativeTrack.isVideoTrack()
            ? packet.toEncodedVideoChunk()
            : packet.toEncodedAudioChunk();
        }
      } finally {
        Promise.resolve(iterator.return?.()).catch(() => {});
      }
    } catch (error) {
      throw wrapFailure(error, `Packets for ${track.type} track ${track.number} could not be read.`);
    }
  }

  async function* subtitleCues(track, fromPts = 0) {
    if (!active || !track || track.sessionId !== active.sessionId) {
      throw fail('StaleTrackError', 'ERR_DEMUX_STALE_TRACK', 'The track does not belong to the active media session.');
    }
    if (!Number.isFinite(fromPts) || fromPts < 0) {
      throw fail('InvalidTimestampError', 'ERR_DEMUX_TIMESTAMP', 'Cue start time must be a finite non-negative number.');
    }
    const textTrack = active.textInspection?.trackById.get(track.id);
    if (!textTrack) {
      throw fail('UnknownTrackError', 'ERR_DEMUX_TRACK', 'The requested embedded text track was not found.');
    }
    try {
      const cues = shiftTimes(await active.textInspection.cues(textTrack, active.duration), active.startOffsetS);
      for (const cue of cues) {
        if (cue.endS >= fromPts) yield { ...cue };
      }
    } catch (error) {
      throw wrapFailure(error, `Cues for subtitle track ${track.number} could not be read.`);
    }
  }

  /* Decoded audio through Mediabunny's own decode path. Reel uses it when WebCodecs
     refuses a codec that Mediabunny can still decode: PCM, or AC-3, E-AC-3 and DTS
     once the software rung is registered. The caller closes every sample. */
  async function* audioSamples(track, fromS = 0) {
    if (!active || !track || track.sessionId !== active.sessionId) {
      throw fail('StaleTrackError', 'ERR_DEMUX_STALE_TRACK', 'The track does not belong to the active media session.');
    }
    if (!Number.isFinite(fromS) || fromS < 0) {
      throw fail('InvalidTimestampError', 'ERR_DEMUX_TIMESTAMP', 'Sample start time must be a finite non-negative number.');
    }
    const nativeTrack = active.nativeById.get(track.id);
    if (!nativeTrack || !nativeTrack.isAudioTrack()) {
      throw fail('UnknownTrackError', 'ERR_DEMUX_TRACK', 'The requested audio track was not found.');
    }
    const timeoutMs = CONFIG.demux.packetReadTimeoutMs ?? CONFIG.demux.probeTimeoutMs;
    let iterator = null;
    try {
      const offsetS = active.startOffsetS || 0;
      iterator = new AudioSampleSink(nativeTrack).samples(fromS + offsetS)[Symbol.asyncIterator]();
      while (true) {
        const step = await withTimeout(iterator.next(), 'Software audio decode', { timeoutMs });
        if (step.done) break;
        if (offsetS > 0) step.value.setTimestamp(step.value.timestamp - offsetS);
        yield step.value;
      }
    } catch (error) {
      throw wrapFailure(error, `Software decode of audio track ${track.number} failed.`);
    } finally {
      if (iterator) Promise.resolve(iterator.return?.()).catch(() => {});
    }
  }

  /**
   * Key frame times in seconds for `track` (a video track of the active session):
   * Matroska Cues or a bounded cluster scan; the MP4/MOV sample table through
   * Mediabunny's metadata-only key packet walk. Empty when no cheap index exists.
   */
  async function keyframes(track) {
    if (!active || !track || track.sessionId !== active.sessionId || track.type !== 'video') return [];
    if (active.textInspection?.keyframes && active.container !== 'mp4' && active.container !== 'mov') {
      const offsetS = active.startOffsetS || 0;
      const times = await active.textInspection.keyframes(track.number);
      return offsetS > 0 ? times.map(time => Math.max(0, time - offsetS)) : times;
    }
    if (!['mp4', 'mov'].includes(active.container)) return [];
    const nativeTrack = active.nativeById.get(track.id);
    if (!nativeTrack) return [];
    const sink = new EncodedPacketSink(nativeTrack);
    const deadline = performance.now() + 5_000;
    const times = [];
    let packet = await sink.getFirstKeyPacket({ metadataOnly: true });
    while (packet && times.length < 100_000 && performance.now() < deadline) {
      times.push(Math.max(0, packet.timestamp - (active.startOffsetS || 0)));
      packet = await sink.getNextKeyPacket(packet, { metadataOnly: true });
    }
    return times;
  }

  function attachments() {
    return active?.textInspection?.attachments ? active.textInspection.attachments() : Promise.resolve([]);
  }

  /** Whether the Matroska track list holds more video tracks than Mediabunny reads. */
  function hiddenVideo(candidate) {
    const inspection = candidate?.session?.textInspection;
    const read = candidate?.result?.tracks.filter(track => track.type === 'video').length ?? 0;
    return Number.isInteger(inspection?.videoTrackCount) && inspection.videoTrackCount > read;
  }

  /** Whether a prepare() failure is one the libav rung may open instead. */
  function libavEligible(error) {
    return ['ERR_DEMUX_UNSUPPORTED_CONTAINER', 'ERR_DEMUX_ASF_VIDEO'].includes(error?.code);
  }

  /* Whether a readable file's video needs the libav rung: a video codec Mediabunny
     does not know (MPEG-2, MPEG-4 Part 2, VC-1), Matroska video tracks Mediabunny
     skipped, or an MPEG-TS with no readable video. Known WebCodecs codecs stay here. */
  function needsLibavVideo(candidate) {
    const tracks = candidate?.result?.tracks || [];
    if (tracks.some(track => track.type === 'video' && (!track.codec || !track.decoderConfig))) return true;
    if (hiddenVideo(candidate)) return true;
    return candidate?.result?.container === 'ts' && !tracks.some(track => track.type === 'video');
  }

  /** Whether Mediabunny can decode this audio track with what is registered now. */
  async function canDecodeAudio(track) {
    const nativeTrack = active && track?.sessionId === active.sessionId ? active.nativeById.get(track.id) : null;
    if (!nativeTrack || !nativeTrack.isAudioTrack()) return false;
    try {
      return await nativeTrack.canDecode();
    } catch (_) {
      return false;
    }
  }

  /* The software audio rung. Each package is vendored unmodified; its bundle imports
     the bare specifier "mediabunny", which a page cannot resolve without an import
     map. The loader verifies the file's SHA-256, points that specifier at the exact
     core module this engine imports (so both share one decoder registry), and
     imports the result from a blob URL. */
  const SoftwareAudio = (() => {
    const loaded = new Map();
    const pending = new Map();
    const coreUrl = () => new URL('../vendor/mediabunny/mediabunny-1.66.0.min.mjs', import.meta.url).href;

    function packageFor(codec) {
      return SOFTWARE_AUDIO_PACKAGES.find(item => item.codecs.includes(codec)) || null;
    }

    function runnable() {
      return typeof globalThis.Worker === 'function'
        && typeof globalThis.WebAssembly === 'object'
        && !!globalThis.crypto?.subtle
        && typeof globalThis.fetch === 'function'
        && typeof URL.createObjectURL === 'function';
    }

    function state() {
      if (loaded.size) return 'loaded';
      return runnable() ? 'available' : 'absent';
    }

    function hex(buffer) {
      return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    }

    function consent(item) {
      return askDownload(item);
    }

    async function load(item) {
      if (!runnable()) {
        throw fail(
          'SoftwareAudioUnavailableError',
          'ERR_RUNG_UNAVAILABLE',
          'The software audio decoder needs Web Workers, WebAssembly and Web Crypto, which this browser lacks.',
        );
      }
      // The decoder compiles WebAssembly in a worker that inherits the page's Content
      // Security Policy. Compile an empty module here first, so a policy without
      // 'wasm-unsafe-eval' becomes a named refusal instead of a failed playback.
      try {
        new WebAssembly.Module(Uint8Array.of(0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00));
      } catch (error) {
        throw fail(
          'SoftwareAudioBlockedError',
          'ERR_RUNG_CSP',
          "This page's Content Security Policy blocks WebAssembly, which the software audio decoder needs ('wasm-unsafe-eval').",
          error,
        );
      }
      if (!await consent(item)) {
        throw fail(
          'SoftwareAudioDeclinedError',
          'ERR_RUNG_DECLINED',
          `The ${item.name} download was declined, so this audio track stays silent.`,
        );
      }
      const url = new URL(item.path, import.meta.url).href;
      let response;
      try {
        response = await fetch(url, { credentials: 'same-origin' });
      } catch (error) {
        throw fail('SoftwareAudioFetchError', 'ERR_RUNG_FETCH', `The ${item.name} could not be downloaded.`, error);
      }
      if (!response.ok) {
        throw fail('SoftwareAudioFetchError', 'ERR_RUNG_FETCH', `The ${item.name} download failed with HTTP ${response.status}.`);
      }
      const bytes = await response.arrayBuffer();
      const digest = hex(await globalThis.crypto.subtle.digest('SHA-256', bytes));
      if (bytes.byteLength !== item.bytes || digest !== item.sha256) {
        throw fail(
          'SoftwareAudioIntegrityError',
          'ERR_RUNG_INTEGRITY',
          `The ${item.name} file does not match its pinned SHA-256, so Reel did not run it.`,
        );
      }
      const source = new TextDecoder().decode(bytes).replaceAll('from"mediabunny"', `from${JSON.stringify(coreUrl())}`);
      const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      try {
        const module = await import(blobUrl);
        module[item.register]();
      } catch (error) {
        throw fail('SoftwareAudioLoadError', 'ERR_RUNG_LOAD', `The ${item.name} could not start.`, error);
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      loaded.set(item.id, item);
    }

    /** Load and register the package that decodes `codec`. Returns false when no package covers it. */
    async function ensure(codec) {
      const item = packageFor(codec);
      if (!item) return false;
      if (loaded.has(item.id)) return true;
      if (!pending.has(item.id)) {
        const task = load(item).finally(() => pending.delete(item.id));
        pending.set(item.id, task);
      }
      await pending.get(item.id);
      return true;
    }

    return {
      state,
      covers: codec => !!packageFor(codec),
      ensure,
      loaded: () => [...loaded.keys()],
    };
  })();

  function close() {
    if (active) active.input?.dispose();
    active = null;
  }

  return {
    prepare,
    activate,
    activateText,
    discard,
    probe,
    packets,
    audioSamples,
    keyframes,
    attachments,
    hiddenVideo,
    libavEligible,
    needsLibavVideo,
    canDecodeAudio,
    softwareAudio: SoftwareAudio,
    subtitleCues,
    close,
    vendorVersion: MEDIABUNNY_VERSION,
  };
})();
/* Legacy containers and video codecs through engine/libav-rung.mjs (libav area).
   A separate ingress from Mediabunny: it opens whole files Mediabunny cannot, and
   yields decoded VideoFrame and AudioData. Imported lazily and guarded, so the
   engine still runs when a host does not ship that file. */
const Libav = (() => {
  let modulePromise = null;
  let active = null;
  let nextSessionId = 1;

  function loadModule() {
    modulePromise ??= import('./libav-rung.mjs').catch(() => null);
    return modulePromise;
  }

  /* Only files that start like a format the rung opens go there, so an unknown file
     is refused at once instead of triggering a download (and its consent prompt). */
  async function sniff(file) {
    const head = new Uint8Array(await file.slice(0, Math.min(file.size, 192)).arrayBuffer());
    const at = (offset, ...bytes) => bytes.every((byte, index) => head[offset + index] === byte);
    if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x41, 0x56, 0x49, 0x20)) return true; // RIFF AVI
    if (at(0, 0x46, 0x4C, 0x56, 0x01)) return true; // FLV
    if (at(0, 0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11)) return true; // ASF (video checked earlier)
    if (at(0, 0x00, 0x00, 0x01, 0xBA) || at(0, 0x00, 0x00, 0x01, 0xB3)) return true; // MPEG-PS, MPEG video
    if (head[0] === 0x47 && head.byteLength >= 189 && head[188] === 0x47) return true; // MPEG-TS
    return false;
  }

  /* MPEG program streams (.mpg, .mpeg, .vob) go to the rung first: Mediabunny reads
     their MPEG audio as a bare MP3 stream and the picture would be lost. */
  async function preferred(file) {
    const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
    const programStream = head[0] === 0x00 && head[1] === 0x00 && head[2] === 0x01 && (head[3] === 0xBA || head[3] === 0xB3);
    return programStream || /\.(mpg|mpeg|vob)$/i.test(file.name || '');
  }

  /**
   * Open `file` through the rung, or null when it cannot. `sniff` (default true)
   * first requires a signature the rung reads; callers that already know the file
   * holds video Mediabunny cannot decode pass false. LibavRungError (declined,
   * unavailable, integrity) propagates so the load names it.
   */
  async function open(file, { sniff: checkSignature = true } = {}) {
    if (checkSignature && !await sniff(file)) return null;
    // A RangedFile passes through: the rung answers libav's block reads with its slices.
    const module = await loadModule();
    if (typeof module?.openLibavSource !== 'function') return null;
    const source = await module.openLibavSource(file, {
      requestDownload: info => askDownload(info),
      log: (...parts) => emit('engine:libav-log', { message: parts.map(String).join(' ') }),
    });
    return source && Array.isArray(source.tracks) ? source : null;
  }

  function describe(source, file, sessionId) {
    const counts = { video: 0, audio: 0 };
    const tracks = source.tracks
      .filter(track => track.type === 'video' || track.type === 'audio')
      .map(track => {
        counts[track.type] += 1;
        const base = {
          id: `${sessionId}:${track.type}:${track.id}`,
          sessionId,
          sourceId: track.id,
          number: counts[track.type],
          type: track.type,
          codec: track.codec || null,
          codecParameter: track.codec || null,
          internalCodecId: track.codec || null,
          name: null,
          language: null,
          disposition: { default: true, forced: false, hearingImpaired: false, visualImpaired: false, descriptions: false, original: false, commentary: false },
          bitrate: null,
          averageBitrate: null,
          duration: Number.isFinite(track.durationS) ? track.durationS : source.duration,
          startTimestamp: 0,
          decoderConfig: null,
          backend: 'libav',
        };
        return track.type === 'video'
          ? {
            ...base,
            codedWidth: track.width,
            codedHeight: track.height,
            displayWidth: track.width,
            displayHeight: track.height,
            rotation: 0,
            interlaced: !!track.interlaced,
            fieldOrder: ['tff', 'bff'].includes(track.fieldOrder) ? track.fieldOrder : (track.interlaced ? 'unknown' : null),
          }
          : { ...base, channels: track.channels, sampleRate: track.sampleRate };
      });
    const name = file.name || 'untitled';
    const extension = /\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase() || 'libav';
    return {
      sessionId,
      name,
      size: file.size,
      container: extension,
      format: 'libav',
      mimeType: null,
      duration: Number.isFinite(source.duration) ? source.duration : 0,
      tracks,
      chapters: [],
      backend: 'libav',
    };
  }

  /* Metadata for a file the rung opens, without activating it (the library's duration and
     track list, capture defect 5). A background probe never asks the person: it opens the
     rung only when its download is under the host's consent threshold, and returns null
     otherwise or when the rung cannot read the file. The probe's own source closes here;
     a source that playback holds on the same instance is not touched. */
  async function probe(file) {
    if (!file || !await sniff(file)) return null;
    const module = await loadModule();
    if (typeof module?.openLibavSource !== 'function') return null;
    const threshold = CONFIG.askDownloadOverBytes ?? 5 * 1024 * 1024;
    const source = await module.openLibavSource(file, {
      requestDownload: async info => Number(info?.bytes) <= threshold,
      log: (...parts) => emit('engine:libav-log', { message: parts.map(String).join(' ') }),
    }).catch(() => null);
    if (!source || !Array.isArray(source.tracks)) return null;
    try {
      return describe(source, file, `libav-probe-${nextSessionId++}`);
    } finally {
      try { await source.close(); } catch (_) {}
    }
  }

  function activate(source, file) {
    close();
    const sessionId = `libav-${nextSessionId++}`;
    active = { source, sessionId };
    return describe(source, file, sessionId);
  }

  /** Decoded VideoFrame (video) or AudioData (audio) from `fromS`; the caller closes each. */
  function iterate(track, fromS) {
    if (!active || track?.sessionId !== active.sessionId) {
      throw new DemuxError('StaleTrackError', 'ERR_DEMUX_STALE_TRACK', 'The track does not belong to the active media session.');
    }
    const options = { trackId: track.sourceId };
    return track.type === 'video' ? active.source.videoFrames(fromS, options) : active.source.audioData(fromS, options);
  }

  function close() {
    if (active) {
      try { active.source.close(); } catch (_) {}
    }
    active = null;
  }

  function setDeinterlace(on) {
    try { active?.source.setDeinterlace?.(!!on); } catch (_) {}
  }

  /* Audio for a Mediabunny session in a browser without AudioDecoder (review V29), as in
     Safari 17.4 to 18.x: the rung opens the same file a second time and decodes only the
     audio track, while the video stays on WebCodecs. Its build holds AAC, MP3, AC-3 and
     E-AC-3 decoders and the MP4/MOV (M4V reads as mp4), Matroska, MPEG-TS and MP3 demuxers
     (vendor/libav/mkconfig-reel.json); where the browser also lacks AudioData it yields
     plain f32-planar blocks, which copyAudioData reads the same way. */
  const AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3']);
  const AUDIO_CONTAINERS = new Set(['mp4', 'mov', 'mkv', 'webm', 'ts', 'mp3']);
  let audioSource = null;
  function audioEligible(track, container) {
    return AUDIO_CODECS.has(track?.codec) && AUDIO_CONTAINERS.has(container);
  }
  async function openAudio(file, sessionId) {
    if (audioSource?.sessionId !== sessionId) {
      closeAudio();
      // A rung refusal (timeout, abort, declined download) is kept by name and not cached,
      // so the next play asks the restarted rung again.
      const pending = open(file, { sniff: false }).catch(error => {
        if (error?.name !== 'LibavRungError') return null;
        if (audioSource?.pending === pending) audioSource = null;
        throw error;
      });
      audioSource = { sessionId, pending };
    }
    return audioSource.pending;
  }
  function closeAudio() {
    const previous = audioSource;
    audioSource = null;
    previous?.pending.then(source => { try { source?.close(); } catch (_) {} }, () => {});
  }

  return {
    audioEligible,
    openAudio,
    closeAudio,
    open,
    probe,
    preferred,
    activate,
    iterate,
    close,
    setDeinterlace,
    isActive: () => !!active,
    available: async () => typeof (await loadModule())?.openLibavSource === 'function',
  };
})();

/* Layer 3 — Decode graph (WebCodecs; interface admits R2 wasm later). */
const Decode = (() => {
  function fail(name, code, message, cause) {
    return new DecodeError(name, code, message, cause);
  }

  function validateTrack(track) {
    if (!track || !['video', 'audio'].includes(track.type)) {
      throw fail('UnsupportedDecodeTrackError', 'ERR_DECODE_TRACK', 'WebCodecs accepts video and audio tracks only.');
    }
    if (!track.decoderConfig || typeof track.decoderConfig.codec !== 'string') {
      throw fail(
        'MissingDecoderConfigError',
        'ERR_DECODE_CONFIG',
        `The ${track.type} track does not provide a WebCodecs decoder configuration.`,
      );
    }
  }

  function decoderClass(track) {
    return track.type === 'video' ? globalThis.VideoDecoder : globalThis.AudioDecoder;
  }

  async function supportedConfig(track) {
    if (track?.backend === 'libav') return {};
    validateTrack(track);
    const Decoder = decoderClass(track);
    if (!Decoder || typeof Decoder.isConfigSupported !== 'function') {
      throw fail(
        'WebCodecsUnavailableError',
        'ERR_DECODE_UNAVAILABLE',
        `${track.type === 'video' ? 'VideoDecoder' : 'AudioDecoder'} is unavailable in this browser.`,
      );
    }
    // Reel applies rotation in its renderer, so the decoder always returns upright-coded frames.
    const { rotation: _rotation, flip: _flip, ...decoderConfig } = track.decoderConfig;
    let support;
    try {
      support = await Decoder.isConfigSupported(decoderConfig);
    } catch (error) {
      throw fail(
        'InvalidDecoderConfigError',
        'ERR_DECODE_CONFIG',
        `The ${track.codecParameter || track.codec} decoder configuration is invalid.`,
        error,
      );
    }
    if (!support.supported) {
      throw fail(
        'UnsupportedCodecError',
        'ERR_DECODE_UNSUPPORTED_CODEC',
        `${track.codecParameter || track.codec} is not available through WebCodecs on this device.`,
      );
    }
    const { rotation: _supportedRotation, flip: _supportedFlip, ...config } = support.config;
    return config;
  }

  /**
   * Choose how an audio track decodes: WebCodecs first, then Mediabunny's software
   * path (PCM, or AC-3, E-AC-3 and DTS through the software rung). A refusal is
   * returned, not thrown, so the caller can still play the video.
   */
  async function audioRoute(track) {
    if (track?.backend === 'libav') return { route: 'libav', config: null, error: null };
    let webCodecsError = null;
    try {
      const config = await supportedConfig(track);
      return { route: 'webcodecs', config, error: null };
    } catch (error) {
      webCodecsError = error;
    }
    const codec = track?.codec || null;
    if (codec && Demux.softwareAudio.covers(codec)) {
      try {
        await Demux.softwareAudio.ensure(codec);
      } catch (error) {
        return { route: null, config: null, error };
      }
    }
    if (await Demux.canDecodeAudio(track)) return { route: 'software', config: null, error: null };
    const label = track?.codecParameter || codec || 'This';
    if (!globalThis.AudioDecoder && Libav.audioEligible(track, store.media.container)) {
      let rungError = null;
      const source = await libavAudioSource(track).catch(error => {
        if (error?.name === 'LibavRungError') rungError = error;
        return null;
      });
      if (source) return { route: 'libav', config: null, error: null };
      if (rungError) return { route: null, config: null, error: rungError };
    }
    if (!globalThis.AudioDecoder) {
      return {
        route: null,
        config: null,
        error: fail(
          'AudioDecoderUnavailableError',
          'ERR_DECODE_AUDIO_UNAVAILABLE',
          `${label} audio needs the browser's AudioDecoder, which this browser lacks, and Reel's software decoder does not cover it.`,
          webCodecsError,
        ),
      };
    }
    return { route: null, config: null, error: webCodecsError };
  }

  const pause4 = () => new Promise(resolve => setTimeout(resolve, 4));

  /* The software audio route paces Mediabunny's decoded samples the way stream()
     paces WebCodecs packets. Sample timestamps are in seconds. */
  async function streamSoftwareAudio(track, fromS, onOutput, options = {}) {
    const shouldContinue = options.shouldContinue || (() => true);
    const currentTimeS = options.currentTimeS || (() => fromS);
    const decodeAheadS = Number.isFinite(options.decodeAheadS) ? Math.max(0, options.decodeAheadS) : 0.5;
    const wait = options.wait || pause4;
    let sampleCount = 0;
    try {
      for await (const sample of Demux.audioSamples(track, fromS)) {
        // The first sample always goes through, so audio that starts after the position
        // can fill its lead silence before the clock runs (review V4).
        while (sampleCount > 0 && sample.timestamp > currentTimeS() + decodeAheadS && shouldContinue()) {
          await wait();
        }
        if (!shouldContinue()) {
          sample.close();
          break;
        }
        try {
          if (onOutput(sample) === false) sample.close();
        } catch (error) {
          sample.close();
          throw error;
        }
        sampleCount += 1;
      }
      return { packetCount: sampleCount };
    } catch (error) {
      if (error instanceof DecodeError) throw error;
      throw fail(
        'DecodeFailureError',
        'ERR_DECODE_FAILURE',
        `${track.codecParameter || track.codec} software audio decode failed.`,
        error,
      );
    }
  }

  /* The rung's source for this session's file and its matching audio stream: the nth
     audio track in Reel's list is the nth audio stream the rung found. */
  async function libavAudioSource(track) {
    const file = await mediaFileOf(store.media.handle);
    if (!file) return null;
    const source = await Libav.openAudio(file, track.sessionId);
    const index = store.tracks.audio.indexOf(track);
    const streams = (source?.tracks || []).filter(item => item.type === 'audio');
    const stream = streams[index];
    if (!stream || stream.codec !== track.codec && !(track.codec === 'aac' && /aac/.test(stream.codec))) return null;
    return { source, trackId: stream.id };
  }

  async function streamLibavAudio(track, fromS, onOutput, options = {}) {
    const found = await libavAudioSource(track);
    if (!found) throw fail('DecodeFailureError', 'ERR_DECODE_FAILURE', `${track.codec} audio could not be opened by the libav rung.`);
    const shouldContinue = options.shouldContinue || (() => true);
    const currentTimeS = options.currentTimeS || (() => fromS);
    const decodeAheadS = Number.isFinite(options.decodeAheadS) ? Math.max(0, options.decodeAheadS) : 0.5;
    const wait = options.wait || pause4;
    let count = 0;
    try {
      for await (const item of found.source.audioData(fromS, { trackId: found.trackId })) {
        while (count > 0 && item.timestamp / 1_000_000 > currentTimeS() + decodeAheadS && shouldContinue()) await wait();
        if (!shouldContinue()) {
          item.close();
          break;
        }
        try {
          if (onOutput(item) === false) item.close();
        } catch (error) {
          item.close();
          throw error;
        }
        count += 1;
      }
      return { packetCount: count };
    } catch (error) {
      if (error instanceof DecodeError || error?.name === 'LibavRungError') throw error;
      throw fail('DecodeFailureError', 'ERR_DECODE_FAILURE', `${track.codec} libav audio decode failed.`, error);
    }
  }

  function streamAudio(track, route, fromS, onOutput, options = {}) {
    if (route === 'software') return streamSoftwareAudio(track, fromS, onOutput, options);
    if (route === 'libav' && track?.backend !== 'libav') return streamLibavAudio(track, fromS, onOutput, options);
    return stream(track, fromS, onOutput, options);
  }

  /* The libav rung yields decoded frames and audio already; pace them like packets.
     Timestamps are microseconds, as WebCodecs uses. */
  async function streamLibav(track, fromS, onOutput, options = {}) {
    const shouldContinue = options.shouldContinue || (() => true);
    const currentTimeS = options.currentTimeS || (() => fromS);
    const decodeAheadS = Number.isFinite(options.decodeAheadS) ? Math.max(0, options.decodeAheadS) : 0.5;
    const wait = options.wait || pause4;
    let count = 0;
    try {
      for await (const item of Libav.iterate(track, fromS)) {
        while (count > 0 && item.timestamp / 1_000_000 > currentTimeS() + decodeAheadS && shouldContinue()) {
          await wait();
        }
        if (!shouldContinue()) {
          item.close();
          break;
        }
        try {
          const key = count === 0;
          if (onOutput(item, { key, packetType: key ? 'key' : 'delta' }) === false) item.close();
        } catch (error) {
          item.close();
          throw error;
        }
        count += 1;
      }
      return { packetCount: count };
    } catch (error) {
      // The rung's own refusals (ERR_LIBAV_TIMEOUT, ERR_LIBAV_ABORTED, ERR_LIBAV_FRAME_TOO_LARGE, ...) keep their name.
      if (error instanceof DecodeError || error?.name === 'LibavRungError') throw error;
      throw fail('DecodeFailureError', 'ERR_DECODE_FAILURE', `${track.codec || 'libav'} ${track.type} decode failed.`, error);
    }
  }

  /**
   * Decode video from the key frame at or before `fromS` until a packet reaches
   * `stopUs`, and keep the one frame `better(candidate, best)` prefers. The caller
   * owns the returned VideoFrame; every other frame is closed here.
   */
  async function pickFrame(track, fromS, stopUs, better, { shouldContinue = () => true } = {}) {
    if (track?.backend === 'libav') {
      let best = null;
      try {
        for await (const frame of Libav.iterate(track, fromS)) {
          const timestamp = frame.timestamp;
          if (better(frame, best)) {
            best?.close();
            best = frame;
          } else {
            frame.close();
          }
          if (timestamp >= stopUs || !shouldContinue()) break;
        }
      } catch (error) {
        best?.close();
        if (error?.name === 'LibavRungError') throw error;
        throw fail('DecodeFailureError', 'ERR_DECODE_FAILURE', `${track.codec || 'libav'} frame decode failed.`, error);
      }
      if (!shouldContinue()) {
        best?.close();
        return null;
      }
      return best;
    }
    const config = await supportedConfig(track);
    let best = null;
    let decoderFailure = null;
    let decoder = null;
    let packetCount = 0;
    try {
      decoder = new globalThis.VideoDecoder({
        output: frame => {
          if (better(frame, best)) {
            best?.close();
            best = frame;
          } else {
            frame.close();
          }
        },
        error: error => { decoderFailure = error; },
      });
      decoder.configure(config);
      for await (const packet of Demux.packets(track, fromS)) {
        if (decoderFailure) throw decoderFailure;
        decoder.decode(packet);
        packetCount += 1;
        while (decoder.decodeQueueSize >= CONFIG.decode.queueFlushSize) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (decoderFailure) throw decoderFailure;
        }
        if (packet.timestamp >= stopUs || !shouldContinue()) break;
        if (packetCount >= CONFIG.decode.maxPacketsPerSample) {
          throw fail(
            'DecodePacketLimitError',
            'ERR_DECODE_PACKET_LIMIT',
            `A frame step exceeded ${CONFIG.decode.maxPacketsPerSample} packets.`,
          );
        }
      }
      if (!shouldContinue()) {
        best?.close();
        best = null;
        return null;
      }
      await decoder.flush();
      if (decoderFailure) throw decoderFailure;
      const output = best;
      best = null;
      return output;
    } catch (error) {
      best?.close();
      best = null;
      if (error instanceof DecodeError) throw error;
      throw fail(
        'DecodeFailureError',
        'ERR_DECODE_FAILURE',
        `${track.codecParameter || track.codec} frame step decode failed.`,
        error,
      );
    } finally {
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  }

  function sampleReport(track, sample, targetUs, packetCount) {
    const base = {
      type: track.type,
      codec: track.codec,
      codecParameter: track.codecParameter,
      requestedTimestamp: targetUs,
      timestamp: sample.timestamp,
      duration: sample.duration,
      packetCount,
    };
    if (track.type === 'video') {
      return {
        ...base,
        codedWidth: sample.codedWidth,
        codedHeight: sample.codedHeight,
        displayWidth: sample.displayWidth,
        displayHeight: sample.displayHeight,
        colorSpace: sample.colorSpace ? {
          primaries: sample.colorSpace.primaries,
          transfer: sample.colorSpace.transfer,
          matrix: sample.colorSpace.matrix,
          fullRange: sample.colorSpace.fullRange,
        } : null,
      };
    }
    return {
      ...base,
      numberOfFrames: sample.numberOfFrames,
      numberOfChannels: sample.numberOfChannels,
      sampleRate: sample.sampleRate,
      format: sample.format,
    };
  }

  function closestSample(outputs, targetUs) {
    const atOrAfter = outputs.find(sample => sample.timestamp >= targetUs);
    if (atOrAfter) return atOrAfter;
    return outputs.at(-1) || null;
  }

  async function sample(track, atS = 0) {
    if (!Number.isFinite(atS) || atS < 0) {
      throw fail('InvalidDecodeTimestampError', 'ERR_DECODE_TIMESTAMP', 'Decode time must be a finite non-negative number.');
    }

    const config = await supportedConfig(track);
    const Decoder = decoderClass(track);
    const outputs = [];
    let decoderFailure = null;
    let decoder = null;
    let packetCount = 0;
    const targetUs = Math.round(atS * 1_000_000);
    const lookaheadUs = track.type === 'video'
      ? CONFIG.decode.videoLookaheadUs
      : CONFIG.decode.audioLookaheadUs;

    try {
      decoder = new Decoder({
        output: output => outputs.push(output),
        error: error => { decoderFailure = error; },
      });
      decoder.configure(config);

      for await (const packet of Demux.packets(track, atS)) {
        if (decoderFailure) throw decoderFailure;
        decoder.decode(packet);
        packetCount += 1;

        while (decoder.decodeQueueSize >= CONFIG.decode.queueFlushSize) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (decoderFailure) throw decoderFailure;
        }
        const packetEndUs = packet.timestamp + (packet.duration || 0);
        if (packetEndUs >= targetUs + lookaheadUs) break;
        if (packetCount >= CONFIG.decode.maxPacketsPerSample) {
          throw fail(
            'DecodePacketLimitError',
            'ERR_DECODE_PACKET_LIMIT',
            `A sample decode exceeded ${CONFIG.decode.maxPacketsPerSample} packets.`,
          );
        }
      }

      await decoder.flush();
      if (decoderFailure) throw decoderFailure;
      const output = closestSample(outputs, targetUs);
      if (!output) {
        throw fail('DecodeOutputError', 'ERR_DECODE_OUTPUT', `The ${track.type} decoder produced no output.`);
      }
      return sampleReport(track, output, targetUs, packetCount);
    } catch (error) {
      if (error instanceof DecodeError) throw error;
      throw fail(
        'DecodeFailureError',
        'ERR_DECODE_FAILURE',
        `${track.codecParameter || track.codec} ${track.type} decode failed.`,
        error,
      );
    } finally {
      for (const output of outputs) output.close();
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  }

  async function stream(track, fromS, onOutput, options = {}) {
    if (track?.backend === 'libav') return streamLibav(track, fromS, onOutput, options);
    if (!Number.isFinite(fromS) || fromS < 0) {
      throw fail('InvalidDecodeTimestampError', 'ERR_DECODE_TIMESTAMP', 'Decode time must be a finite non-negative number.');
    }
    if (typeof onOutput !== 'function') {
      throw new TypeError('Decode.stream requires an output callback.');
    }

    const config = await supportedConfig(track);
    const Decoder = decoderClass(track);
    let decoderFailure = null;
    let outputFailure = null;
    let decoder = null;
    let packetCount = 0;
    const packetTypes = new Map();
    const shouldContinue = options.shouldContinue || (() => true);
    const currentTimeS = options.currentTimeS || (() => fromS);
    const decodeAheadS = Number.isFinite(options.decodeAheadS)
      ? Math.max(0, options.decodeAheadS)
      : CONFIG.sync.decodeAheadMs / 1000;
    const wait = options.wait || pause4;

    try {
      decoder = new Decoder({
        output: output => {
          if (!shouldContinue()) {
            output.close();
            return;
          }
          try {
            const packetType = packetTypes.get(output.timestamp) || null;
            packetTypes.delete(output.timestamp);
            if (onOutput(output, { key: packetType === 'key', packetType }) === false) output.close();
          } catch (error) {
            output.close();
            outputFailure = error;
          }
        },
        error: error => { decoderFailure = error; },
      });
      decoder.configure(config);

      for await (const packet of Demux.packets(track, fromS)) {
        if (!shouldContinue()) break;
        if (decoderFailure) throw decoderFailure;
        if (outputFailure) throw outputFailure;

        const packetTimeS = packet.timestamp / 1_000_000;
        while (packetCount > 0 && packetTimeS > currentTimeS() + decodeAheadS && shouldContinue()) {
          await wait();
          if (decoderFailure) throw decoderFailure;
          if (outputFailure) throw outputFailure;
        }
        if (!shouldContinue()) break;

        if (track.type === 'video') packetTypes.set(packet.timestamp, packet.type);
        decoder.decode(packet);
        packetCount += 1;
        while (decoder.decodeQueueSize >= CONFIG.decode.queueFlushSize && shouldContinue()) {
          await new Promise(resolve => setTimeout(resolve, 0));
          if (decoderFailure) throw decoderFailure;
          if (outputFailure) throw outputFailure;
        }
      }

      if (shouldContinue()) await decoder.flush();
      if (decoderFailure) throw decoderFailure;
      if (outputFailure) throw outputFailure;
      return { packetCount };
    } catch (error) {
      if (error instanceof DecodeError) throw error;
      throw fail(
        'DecodeFailureError',
        'ERR_DECODE_FAILURE',
        `${track.codecParameter || track.codec} ${track.type} decode failed.`,
        error,
      );
    } finally {
      if (decoder && decoder.state !== 'closed') decoder.close();
    }
  }

  return { sample, stream, streamAudio, supportedConfig, audioRoute, pickFrame };
})();

/* Layer 4 — bounded PCM ring inside an AudioWorklet. */
const AudioOutput = (() => {
  const PROCESSOR = 'reel-pcm-ring';
  const WORKLET_SOURCE = String.raw`
${ReelStretch.toString()}
class ReelPcmRingProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.capacity = 0;
    this.channels = [];
    this.readIndex = 0;
    this.writeIndex = 0;
    this.availableFrames = 0;
    this.consumedFrames = 0;
    this.droppedFrames = 0;
    this.underrunFrames = 0;
    // Silence runs: { at, frames } plays 'frames' of silence once every ring frame written
    // before 'at' (an absolute count) has been read. Lead silence is a run at 0.
    this.gaps = [];
    this.writtenFrames = 0;
    this.readFrames = 0;
    this.phase = 0;
    this.rate = 1;
    this.sourceRate = sampleRate;
    this.preservePitch = true;
    this.stretch = null;
    this.frame = [];
    this.playing = false;
    this.reportCountdown = 0;
    this.port.onmessage = event => this.receive(event.data || {});
  }

  receive(message) {
    if (message.type === 'configure') {
      this.capacity = Math.max(1, message.capacityFrames | 0);
      this.channels = Array.from(
        { length: Math.max(1, message.channels | 0) },
        () => new Float32Array(this.capacity),
      );
      this.readIndex = 0;
      this.writeIndex = 0;
      this.availableFrames = 0;
      this.consumedFrames = 0;
      this.droppedFrames = 0;
      this.underrunFrames = 0;
      this.writtenFrames = 0;
      this.readFrames = 0;
      const lead = Math.max(0, message.leadFrames | 0);
      this.gaps = lead > 0 ? [{ at: 0, frames: lead }] : [];
      this.phase = 0;
      this.rate = message.rate || 1;
      this.sourceRate = message.sourceRate || sampleRate;
      this.preservePitch = message.preservePitch !== false;
      this.frame = new Array(this.channels.length).fill(0);
      this.resetStretch();
      this.playing = false;
      this.report();
      return;
    }
    if (message.type === 'enqueue') {
      this.enqueue(message.planes || []);
      return;
    }
    if (message.type === 'gap') {
      const frames = Math.max(0, message.frames | 0);
      const last = this.gaps[this.gaps.length - 1];
      if (frames > 0 && last && last.at === this.writtenFrames) last.frames += frames;
      else if (frames > 0) this.gaps.push({ at: this.writtenFrames, frames });
      this.report();
      return;
    }
    if (message.type === 'play') this.playing = true;
    if (message.type === 'pause') this.playing = false;
    if (message.type === 'rate') {
      this.rate = message.rate || 1;
      this.resetStretch();
    }
    if (message.type === 'pitch') {
      this.preservePitch = message.preservePitch !== false;
      this.resetStretch();
    }
    this.report();
  }

  stretching() {
    return this.preservePitch && this.rate !== 1;
  }

  // Samples held inside the stretch stage are dropped on a mode change; their source frames
  // were already counted, so the clock moves on by that much, as the sound does.
  resetStretch() {
    this.stretch = this.stretching() && this.channels.length
      ? new ReelStretch(this.channels.length, sampleRate, this.rate)
      : null;
  }

  enqueue(planes) {
    if (!this.capacity || !planes.length) return;
    const frameCount = planes[0].length;
    const writable = Math.min(frameCount, this.capacity - this.availableFrames);
    for (let channel = 0; channel < this.channels.length; channel += 1) {
      const source = planes[Math.min(channel, planes.length - 1)];
      const target = this.channels[channel];
      for (let frame = 0; frame < writable; frame += 1) {
        target[(this.writeIndex + frame) % this.capacity] = source[frame];
      }
    }
    this.writeIndex = (this.writeIndex + writable) % this.capacity;
    this.availableFrames += writable;
    this.writtenFrames += writable;
    this.droppedFrames += frameCount - writable;
    this.report();
  }

  silenceFrames() {
    let total = 0;
    for (const gap of this.gaps) total += gap.frames;
    return total;
  }

  report() {
    // Source frames still inside the stretch stage have not been heard yet.
    const held = this.stretch ? Math.round(this.stretch.pending() * (this.sourceRate / sampleRate)) : 0;
    this.port.postMessage({
      type: 'state',
      availableFrames: this.availableFrames + held,
      consumedFrames: Math.max(0, this.consumedFrames - held),
      droppedFrames: this.droppedFrames,
      underrunFrames: this.underrunFrames,
      silenceFrames: this.silenceFrames(),
      playing: this.playing,
    });
  }

  // One output-rate frame into this.frame from the silence runs or the ring, advancing by
  // 'step' source frames with linear interpolation. False on underrun.
  pull(step) {
    const gap = this.gaps[0];
    if (gap && gap.at <= this.readFrames) {
      this.frame.fill(0);
      this.phase += step;
      const requested = Math.floor(this.phase);
      if (requested > 0) {
        const consumed = Math.min(requested, gap.frames);
        gap.frames -= consumed;
        this.phase -= consumed;
        this.consumedFrames += consumed;
        if (gap.frames <= 0) this.gaps.shift();
      }
      return true;
    }
    if (this.availableFrames <= 0) {
      this.underrunFrames += 1;
      this.phase = 0;
      return false;
    }
    const nextIndex = this.availableFrames > 1
      ? (this.readIndex + 1) % this.capacity
      : this.readIndex;
    for (let channel = 0; channel < this.frame.length; channel += 1) {
      const source = this.channels[channel];
      const first = source[this.readIndex];
      this.frame[channel] = first + (source[nextIndex] - first) * this.phase;
    }
    this.phase += step;
    let requested = Math.floor(this.phase);
    // Stop at the next silence run so it starts on time.
    const next = this.gaps[0];
    if (next) requested = Math.min(requested, Math.max(0, next.at - this.readFrames));
    if (requested > 0) {
      const consumed = Math.min(requested, this.availableFrames);
      this.phase -= consumed;
      this.readIndex = (this.readIndex + consumed) % this.capacity;
      this.availableFrames -= consumed;
      this.consumedFrames += consumed;
      this.readFrames += consumed;
    } else if (next && next.at <= this.readFrames) {
      this.phase = 0;
    }
    return true;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    for (const channel of output) channel.fill(0);
    if (!this.playing || !this.capacity) {
      if (--this.reportCountdown <= 0) {
        this.reportCountdown = 4;
        this.report();
      }
      return true;
    }

    const resample = this.sourceRate / sampleRate;
    const stretch = this.stretch;
    for (let outputFrame = 0; outputFrame < output[0].length; outputFrame += 1) {
      if (stretch) {
        // Pitch-preserving speed: resample at 1x into the stretch stage, which changes
        // the tempo by overlapping matched segments (WSOLA), then play its output.
        while (!stretch.ready()) {
          if (!this.pull(resample)) break;
          stretch.push(this.frame);
        }
        if (!stretch.ready()) continue;
        stretch.read(output, outputFrame);
        continue;
      }
      if (!this.pull(resample * this.rate)) continue;
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][outputFrame] = this.frame[Math.min(channel, this.frame.length - 1)];
      }
    }
    if (--this.reportCountdown <= 0) {
      this.reportCountdown = 4;
      this.report();
    }
    return true;
  }
}
registerProcessor('${PROCESSOR}', ReelPcmRingProcessor);
`;

  let context = null;
  let moduleReady = null;
  let node = null;
  let gain = null;
  let session = 0;
  let decoderTask = null;
  let decoderActive = false;
  let errorHandler = null;
  let lastError = null;
  let startPositionS = 0;
  let sourceRate = 48_000;
  let rate = 1;
  let preservePitch = true;
  let active = false;
  let stateAtContextS = 0;
  let prepareCount = 0;
  let route = null;
  let downmix = false;
  let drainedAt = null;
  // Where the next decoded sample belongs on the source timeline (seconds), and whether
  // it is the first sample since prepare: see alignAudioSample (review V4, V43).
  let expectedS = null;
  let firstSample = true;
  let gapFrames = 0;
  let trimmedFrames = 0;
  const progressWaiters = new Set();
  // PCM frames posted to the worklet in this prepare, counted on the main thread. The
  // worklet's own `state` report can arrive after the decoder has finished (Firefox),
  // so the prebuffer check reads this count instead. Port messages keep their order, so
  // every posted frame is in the ring before the later `play` message.
  let enqueuedFrames = 0;
  let stats = {
    bufferedFrames: 0,
    consumedFrames: 0,
    droppedFrames: 0,
    underrunFrames: 0,
  };

  function fail(name, code, message, cause) {
    return new PlaybackError(name, code, message, cause);
  }

  async function unlock() {
    const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextClass || !globalThis.AudioWorkletNode) {
      throw fail('WebAudioUnavailableError', 'ERR_AUDIO_UNAVAILABLE', 'AudioWorklet playback is unavailable in this browser.');
    }
    if (!context || context.state === 'closed') {
      context = new AudioContextClass({ latencyHint: 'playback' });
      moduleReady = null;
    }
    const resume = context.state === 'running' ? Promise.resolve() : context.resume();
    if (!moduleReady) {
      const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'text/javascript' }));
      moduleReady = context.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    }
    let timer = 0;
    try {
      await Promise.race([
        Promise.all([resume, moduleReady]),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('AudioContext startup timed out.')), 5_000);
        }),
      ]);
    } catch (error) {
      moduleReady = null;
      throw fail('AudioWorkletLoadError', 'ERR_AUDIO_WORKLET', 'The PCM audio worklet could not start.', error);
    } finally {
      clearTimeout(timer);
    }
    if (context.state !== 'running') {
      throw fail('AudioContextSuspendedError', 'ERR_AUDIO_SUSPENDED', 'Audio playback requires a user interaction.');
    }
  }

  function wakeWaiters() {
    for (const wake of [...progressWaiters]) wake();
  }

  function stopNode() {
    session += 1;
    active = false;
    decoderActive = false;
    if (node) {
      try { node.port.postMessage({ type: 'pause' }); } catch (_) {}
      try { node.port.close(); } catch (_) {}
      try { node.disconnect(); } catch (_) {}
    }
    if (gain) {
      try { gain.disconnect(); } catch (_) {}
    }
    node = null;
    gain = null;
    decoderTask = null;
    errorHandler = null;
    drainedAt = null;
    wakeWaiters();
  }

  /* Pacing waits for the worklet's next state report (about every 11 ms while it plays),
     with a timer as the fallback. Port messages are not throttled in a hidden tab, where
     timers run once a second, so the decoder keeps the ring fed there (review V2). */
  function waitForProgress(maxMs = 50) {
    return new Promise(resolve => {
      let timer = 0;
      const wake = () => {
        clearTimeout(timer);
        progressWaiters.delete(wake);
        resolve();
      };
      progressWaiters.add(wake);
      timer = setTimeout(wake, maxMs);
    });
  }

  function current() {
    // Once the track has ended and the ring is empty, time keeps moving on the audio
    // context clock, so video longer than its audio still reaches the end.
    if (active && context && drainedAt) {
      return drainedAt.positionS + Math.max(0, context.currentTime - drainedAt.contextS) * rate;
    }
    const reported = startPositionS + (stats.consumedFrames / sourceRate);
    if (!active || !context || stats.bufferedFrames <= 0) return reported;
    const elapsed = Math.max(0, context.currentTime - stateAtContextS) * rate;
    return reported + Math.min(elapsed, stats.bufferedFrames / sourceRate);
  }

  function setFailure(error, localSession) {
    if (localSession !== session || lastError) return;
    // A decode or libav rung failure keeps its reason in the message, so the toast and
    // state().playback.lastError name what stopped the sound (capture defect 11).
    const reason = error?.message ? ` ${error.code ? `(${error.code}) ` : ''}${error.message}` : '';
    lastError = error instanceof PlaybackError
      ? error
      : fail('AudioPlaybackError', 'ERR_AUDIO_PLAYBACK', `Decoded audio playback failed.${reason}`, error);
    errorHandler?.(lastError);
  }

  /* Web Audio defines speaker down-mixing for 1, 2, 4 and 6 channels (5.1), and the
     destination node applies it. Other layouts (3.0, 5.0, 6.1, 7.1) would fall back to
     discrete mixing and drop channels, so Reel folds them to stereo itself: front
     left and right, centre at -3 dB, LFE dropped, the rest alternating left and right. */
  const SPEAKER_LAYOUTS = new Set([1, 2, 4, 6]);

  function stereoFold(planes) {
    const count = planes.length;
    const frames = planes[0].length;
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const sides = [];
    const firstSurround = count >= 7 ? 4 : 3;
    for (let index = firstSurround; index < count; index += 1) sides.push(index);
    const scale = 1 / (1 + Math.SQRT1_2 * (1 + Math.ceil(sides.length / 2)));
    for (let frame = 0; frame < frames; frame += 1) {
      let l = planes[0][frame];
      let r = planes[1][frame];
      if (count >= 3) {
        const centre = planes[2][frame] * Math.SQRT1_2;
        l += centre;
        r += centre;
      }
      for (let side = 0; side < sides.length; side += 1) {
        const value = planes[sides[side]][frame] * Math.SQRT1_2;
        if (side % 2 === 0) l += value;
        else r += value;
      }
      left[frame] = l * scale;
      right[frame] = r * scale;
    }
    return [left, right];
  }

  /* Works for WebCodecs AudioData and Mediabunny AudioSample alike: both expose
     numberOfChannels, numberOfFrames, copyTo(f32-planar) and close(). AudioData times are
     microseconds; Mediabunny samples (which carry microsecondTimestamp) are seconds. The
     sample is placed by its timestamp: a gap before it becomes silence and an overlap is
     trimmed, so sound stays on the picture's timeline (review V4, V43). */
  function copyAudioData(audioData, localNode) {
    const timestampS = 'microsecondTimestamp' in audioData
      ? audioData.timestamp
      : audioData.timestamp / 1_000_000;
    let planes = [];
    for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
      const plane = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      planes.push(plane);
    }
    audioData.close();
    if (localNode !== node) return true;
    if (downmix && planes.length > 2) planes = stereoFold(planes);
    if (!planes.length || !planes[0].length) return true;
    const plan = alignAudioSample({
      expectedS,
      timestampS,
      frames: planes[0].length,
      rate: sourceRate,
      first: firstSample,
    });
    firstSample = false;
    expectedS = plan.nextExpectedS;
    if (plan.gap > 0) {
      gapFrames += plan.gap;
      enqueuedFrames += plan.gap;
      localNode.port.postMessage({ type: 'gap', frames: plan.gap });
    }
    if (plan.skip > 0) {
      trimmedFrames += plan.skip;
      if (plan.skip >= planes[0].length) return true;
      planes = planes.map(plane => plane.slice(plan.skip));
    }
    enqueuedFrames += planes[0].length;
    localNode.port.postMessage({ type: 'enqueue', planes }, planes.map(plane => plane.buffer));
    return true;
  }

  /**
   * Start decoding `track` into the ring. `fromS` is the audio time to start at; a
   * negative value (a positive audio delay near the start) plays that much silence
   * first. `audioRoute` comes from Decode.audioRoute.
   */
  async function prepare(track, audioRoute, fromS, playbackRate, shouldContinue, onError) {
    await unlock();
    stopNode();
    if (!audioRoute?.route) {
      throw audioRoute?.error || fail('AudioRouteError', 'ERR_AUDIO_ROUTE', 'No decoder is available for this audio track.');
    }
    prepareCount += 1;

    const declared = Math.max(1, track.channels || track.decoderConfig?.numberOfChannels || 1);
    downmix = !SPEAKER_LAYOUTS.has(declared);
    const channels = downmix ? 2 : declared;
    route = audioRoute.route;
    sourceRate = track.sampleRate || track.decoderConfig?.sampleRate || context.sampleRate;
    rate = playbackRate;
    startPositionS = fromS;
    const decodeFromS = Math.max(0, fromS);
    const leadFrames = fromS < 0 ? Math.round(-fromS * sourceRate) : 0;
    stateAtContextS = context.currentTime;
    stats = { bufferedFrames: 0, consumedFrames: 0, droppedFrames: 0, underrunFrames: 0 };
    enqueuedFrames = 0;
    expectedS = decodeFromS;
    firstSample = true;
    gapFrames = 0;
    trimmedFrames = 0;
    drainedAt = null;
    lastError = null;
    errorHandler = onError;
    const localSession = session;
    const localNode = new AudioWorkletNode(context, PROCESSOR, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [channels],
      channelCount: channels,
      channelCountMode: 'explicit',
    });
    node = localNode;
    gain = context.createGain();
    gain.gain.value = store.clock.muted ? 0 : store.clock.volume;
    localNode.connect(gain).connect(context.destination);
    localNode.port.onmessage = event => {
      if (localSession !== session || event.data?.type !== 'state') return;
      stats = {
        bufferedFrames: event.data.availableFrames + (event.data.silenceFrames || 0),
        consumedFrames: event.data.consumedFrames,
        droppedFrames: event.data.droppedFrames,
        underrunFrames: event.data.underrunFrames,
      };
      stateAtContextS = context.currentTime;
      if (!drainedAt && active && !decoderActive && stats.bufferedFrames <= 0) {
        drainedAt = {
          contextS: context.currentTime,
          positionS: startPositionS + (stats.consumedFrames / sourceRate),
        };
      }
      if (stats.droppedFrames > 0) {
        setFailure(fail('AudioBufferOverflowError', 'ERR_AUDIO_BUFFER_OVERFLOW', 'The PCM ring buffer overflowed.'), localSession);
      }
      wakeWaiters();
    };
    localNode.port.postMessage({
      type: 'configure',
      channels,
      sourceRate,
      rate,
      preservePitch,
      capacityFrames: Math.ceil(sourceRate * CONFIG.sync.audioRingSeconds),
      leadFrames,
    });

    decoderActive = true;
    const task = Decode.streamAudio(track, route, decodeFromS, audioData => copyAudioData(audioData, localNode), {
      shouldContinue: () => localSession === session && shouldContinue(),
      currentTimeS: current,
      decodeAheadS: CONFIG.sync.audioRingSeconds * 0.75,
      wait: () => waitForProgress(),
    });
    decoderTask = task;
    task.catch(error => setFailure(error, localSession)).finally(() => {
      if (localSession === session) decoderActive = false;
      if (decoderTask === task) decoderTask = null;
    });

    const prebufferFrames = Math.min(Math.ceil(sourceRate * 0.08), Math.ceil(sourceRate * CONFIG.sync.audioRingSeconds));
    const deadline = performance.now() + 5_000;
    // Lead silence (a positive audio delay) and silence before a late first sample count
    // as buffered, as the worklet reports them.
    const bufferedFrames = () => enqueuedFrames + leadFrames;
    while (localSession === session && bufferedFrames() < prebufferFrames && decoderActive && !lastError
      && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    // A newer prepare (a seek or play that superseded this one) owns the node and the
    // counters now; stopping here would silence it.
    if (localSession !== session) {
      throw fail('AudioPrepareSupersededError', 'ERR_AUDIO_SUPERSEDED', 'A newer audio start replaced this one.');
    }
    if (lastError) {
      const error = lastError;
      stopNode();
      throw error;
    }
    // Every decoded sample lay before the position (a seek into the last packet of the
    // track): the audio has ended there, which is not a decode failure. The clock then
    // runs on the audio context, as it does after the track drains.
    if (bufferedFrames() === 0 && !decoderActive && trimmedFrames > 0) return;
    if (bufferedFrames() === 0) {
      stopNode();
      throw fail('AudioPrebufferError', 'ERR_AUDIO_PREBUFFER', 'The audio decoder produced no playable PCM data.');
    }
  }

  function play() {
    if (!node) throw fail('AudioNotPreparedError', 'ERR_AUDIO_NOT_PREPARED', 'Prepare audio before playback.');
    active = true;
    stateAtContextS = context.currentTime;
    node.port.postMessage({ type: 'play' });
  }

  function stop() {
    stopNode();
  }

  function setRate(value) {
    if (drainedAt && context) drainedAt = { contextS: context.currentTime, positionS: current() };
    rate = value;
    stateAtContextS = context?.currentTime || 0;
    node?.port.postMessage({ type: 'rate', rate: value });
  }

  function setPreservePitch(value) {
    preservePitch = !!value;
    node?.port.postMessage({ type: 'pitch', preservePitch });
  }

  function setVolume(volume, muted = false) {
    if (gain && context) gain.gain.setValueAtTime(muted ? 0 : volume, context.currentTime);
  }

  /* The start screen holds no sound, so the context stops pulling the audio thread
     (review V44); the next play() resumes it. */
  function suspend() {
    stopNode();
    if (context && context.state === 'running') context.suspend().catch(() => {});
  }

  /* Page hide: close the context so no audio thread outlives the page; the next play()
     makes a new one. */
  function close() {
    stopNode();
    const closing = context;
    context = null;
    moduleReady = null;
    if (closing && closing.state !== 'closed') closing.close().catch(() => {});
  }

  function state() {
    return {
      active,
      contextState: context?.state || 'uninitialized',
      sourceRate,
      rate,
      preservePitch,
      route,
      downmix,
      prepareCount,
      ...stats,
      gapFrames,
      trimmedFrames,
      decoderActive,
      lastError: lastError ? { name: lastError.name, code: lastError.code, message: lastError.message } : null,
    };
  }

  /** The final gain stage and its context, for a host that wants to tap them. */
  function audioGraph() {
    return context && gain ? { context, output: gain } : null;
  }

  return {
    unlock, prepare, play, stop, current, setRate, setPreservePitch, setVolume, suspend, close, state, audioGraph,
    waitForProgress,
  };
})();

/* Layer 5 — monotonic clock with optional audio master. */
const Clock = (() => {
  function create(durationS = Infinity) {
    let positionS = 0;
    let playing = false;
    let rate = 1;
    let startedAtMs = 0;
    let master = null;

    function clamp(value) {
      return Math.max(0, Math.min(Number.isFinite(durationS) ? durationS : Infinity, value));
    }
    function current() {
      if (!playing) return positionS;
      if (master) return clamp(master.current());
      return clamp(positionS + ((performance.now() - startedAtMs) / 1000) * rate);
    }
    function bind(nextMaster) {
      positionS = current();
      master = nextMaster;
      startedAtMs = performance.now();
    }
    function play() {
      if (playing) return;
      startedAtMs = performance.now();
      playing = true;
    }
    function pause() {
      if (!playing) return;
      positionS = current();
      playing = false;
    }
    function seek(value) {
      positionS = clamp(value);
      if (playing) startedAtMs = performance.now();
      return positionS;
    }
    function setRate(value) {
      if (!Number.isFinite(value) || value < 0.25 || value > 4) {
        throw new RangeError('Playback rate must be between 0.25 and 4.');
      }
      positionS = current();
      startedAtMs = performance.now();
      rate = value;
      master?.setRate(value);
    }
    return {
      current,
      play,
      pause,
      seek,
      setRate,
      bind,
      get playing() { return playing; },
      get rate() { return rate; },
      get duration() { return durationS; },
    };
  }
  return { create };
})();

/* Layer 6 — canvas renderer with strict VideoFrame ownership. */
const Renderer = (() => {
  /**
   * Draw geometry for one frame. `rotation` is the track's clockwise rotation; crop
   * fractions refer to the picture as displayed (after rotation); `aspect` is the
   * displayed width ÷ height, or 'auto' for the cropped picture's own shape.
   */
  function geometry(frameWidth, frameHeight, view) {
    const rotation = [90, 180, 270].includes(view.rotation) ? view.rotation : 0;
    const flip = view.flip === true;
    const shown = view.crop === 'none' || !view.crop
      ? { top: 0, right: 0, bottom: 0, left: 0 }
      : view.crop;
    // A mirrored track (review V46) is rotated, then flipped left to right, so the
    // displayed left edge is the rotated picture's right edge.
    const crop = flip ? { top: shown.top, bottom: shown.bottom, left: shown.right, right: shown.left } : shown;
    // Map the displayed edges back onto the frame's own edges.
    const frameCrop = rotation === 90
      ? { left: crop.top, top: crop.left, right: crop.bottom, bottom: crop.right }
      : rotation === 180
        ? { left: crop.right, right: crop.left, top: crop.bottom, bottom: crop.top }
        : rotation === 270
          ? { right: crop.top, top: crop.right, left: crop.bottom, bottom: crop.left }
          : crop;
    const sx = frameWidth * frameCrop.left;
    const sy = frameHeight * frameCrop.top;
    const sw = Math.max(1, frameWidth * (1 - frameCrop.left - frameCrop.right));
    const sh = Math.max(1, frameHeight * (1 - frameCrop.top - frameCrop.bottom));
    const quarterTurn = rotation === 90 || rotation === 270;
    const croppedWidth = quarterTurn ? sh : sw;
    const croppedHeight = quarterTurn ? sw : sh;
    const outputHeight = Math.max(1, Math.round(croppedHeight));
    const outputWidth = Math.max(1, Math.round(
      typeof view.aspect === 'number' ? croppedHeight * view.aspect : croppedWidth,
    ));
    return {
      sx,
      sy,
      sw,
      sh,
      outputWidth,
      outputHeight,
      drawWidth: quarterTurn ? outputHeight : outputWidth,
      drawHeight: quarterTurn ? outputWidth : outputHeight,
      radians: (rotation * Math.PI) / 180,
      flip,
    };
  }

  const NEUTRAL_ADJUST = Object.freeze({ brightness: 0, contrast: 1, saturation: 1, gamma: 1 });
  const NO_ZOOM = Object.freeze({ scale: 1, x: 0.5, y: 0.5 });

  /* Canvas2D has no gamma filter; contrast and saturation map to CSS filters, and the
     additive brightness (-1 to 1) maps to CSS brightness(1 + b), an approximation of
     the GPU renderer's offset. Neutral values give 'none', so the default path is unchanged. */
  function cssFilter(adjust) {
    const parts = [];
    if (adjust.brightness !== 0) parts.push(`brightness(${Math.max(0, 1 + adjust.brightness)})`);
    if (adjust.contrast !== 1) parts.push(`contrast(${adjust.contrast})`);
    if (adjust.saturation !== 1) parts.push(`saturate(${adjust.saturation})`);
    return parts.length ? parts.join(' ') : 'none';
  }

  /**
   * `gpu` is a renderer from engine/gpu-renderer.mjs, or null for Canvas2D. A canvas
   * holds one kind of context for life, so the caller chooses before attaching.
   */
  function attach(canvas, gpu = null, { onLost = null } = {}) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Renderer.attach requires a canvas.');
    }
    const context = gpu ? null : canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!gpu && !context) throw new Error('The browser could not create a 2D rendering context.');
    const backend = gpu ? 'webgpu' : 'canvas2d';

    const queue = [];
    let animationFrame = 0;
    let clock = null;
    let renderedFrames = 0;
    let droppedFrames = 0;
    let lastTimestamp = null;
    // The frame on screen stays open so a view change can redraw it while paused.
    let shownFrame = null;
    let view = {
      rotation: 0,
      aspect: 'auto',
      crop: 'none',
      zoom: NO_ZOOM,
      adjust: NEUTRAL_ADJUST,
      deinterlace: 'off',
      tonemap: 'auto',
    };
    let output = { width: null, height: null };
    let lastTickMs = performance.now();
    let lost = false;
    const MAX_QUEUE = 64;

    /* A lost GPU device (review V26) draws nothing again. The renderer says so once; the
       host gives the engine a fresh canvas through attach(), because a canvas keeps one
       context kind for life and Canvas2D cannot take over this one. */
    function markLost(reason) {
      if (lost) return;
      lost = true;
      closeQueue();
      try { onLost?.({ reason: reason || 'device-lost' }); } catch (_) {}
    }
    if (gpu) {
      try {
        if (typeof gpu.onLost === 'function') gpu.onLost(info => markLost(info?.reason || info?.message));
        else gpu.addEventListener?.('lost', event => markLost(event?.detail?.reason));
      } catch (_) {}
    }

    function closeQueue() {
      while (queue.length) queue.shift().close();
    }
    function paintGpu(frame, g) {
      if (lost) return;
      if (output.width !== g.outputWidth || output.height !== g.outputHeight) gpu.size(g.outputWidth, g.outputHeight);
      output = { width: g.outputWidth, height: g.outputHeight };
      const drawn = gpu.draw(frame, { ...view });
      if (drawn === false) {
        let state = null;
        try { state = gpu.state?.(); } catch (_) {}
        if (state?.lost) markLost('device-lost');
      }
    }
    function paint(frame) {
      const g = geometry(frame.displayWidth, frame.displayHeight, view);
      if (gpu) {
        paintGpu(frame, g);
        return;
      }
      if (canvas.width !== g.outputWidth || canvas.height !== g.outputHeight) {
        canvas.width = g.outputWidth;
        canvas.height = g.outputHeight;
      }
      output = { width: g.outputWidth, height: g.outputHeight };
      const zoom = view.zoom || NO_ZOOM;
      const filter = cssFilter(view.adjust || NEUTRAL_ADJUST);
      if (g.radians === 0 && zoom.scale === 1 && filter === 'none' && !g.flip) {
        context.drawImage(frame, g.sx, g.sy, g.sw, g.sh, 0, 0, g.drawWidth, g.drawHeight);
        return;
      }
      context.save();
      if (zoom.scale !== 1) {
        context.fillStyle = '#000';
        context.fillRect(0, 0, g.outputWidth, g.outputHeight);
      }
      if (filter !== 'none' && 'filter' in context) context.filter = filter;
      // Put picture point (x, y), in 0 to 1 of the cropped picture, at the view centre.
      context.translate(g.outputWidth / 2, g.outputHeight / 2);
      context.scale(zoom.scale, zoom.scale);
      context.translate(-(zoom.x - 0.5) * g.outputWidth, -(zoom.y - 0.5) * g.outputHeight);
      if (g.flip) context.scale(-1, 1);
      context.rotate(g.radians);
      context.drawImage(frame, g.sx, g.sy, g.sw, g.sh, -g.drawWidth / 2, -g.drawHeight / 2, g.drawWidth, g.drawHeight);
      context.restore();
    }
    function draw(frame) {
      paint(frame);
      lastTimestamp = frame.timestamp;
      renderedFrames += 1;
      if (shownFrame && shownFrame !== frame) shownFrame.close();
      shownFrame = frame;
    }
    function tick() {
      animationFrame = 0;
      lastTickMs = performance.now();
      if (!clock || !clock.playing) return;
      const nowUs = Math.round(clock.current() * 1_000_000);
      let candidate = null;
      while (queue.length && queue[0].timestamp <= nowUs + 2_000) {
        if (candidate) {
          candidate.close();
          droppedFrames += 1;
        }
        candidate = queue.shift();
      }
      if (candidate) draw(candidate);
      animationFrame = requestAnimationFrame(tick);
    }
    /* A frame is dropped when its whole display time has passed, key frames included
       (review V40: a late key frame drawn after a seek showed the old picture under the
       new sound). The queue keeps at most one frame at or before the clock and at most
       MAX_QUEUE frames, so it stays bounded when animation frames stop in a hidden tab
       (review V2). */
    function enqueue(frame, currentTimeS = 0) {
      if (!(frame instanceof VideoFrame) || lost) return false;
      const nowUs = Math.round(currentTimeS * 1_000_000);
      const lateByUs = nowUs - frame.timestamp;
      const endUs = frame.duration ? frame.timestamp + frame.duration : frame.timestamp;
      if (lateByUs > CONFIG.sync.videoDropGraceMs * 1000 && endUs <= nowUs) {
        droppedFrames += 1;
        return false;
      }
      queue.push(frame);
      while (queue.length > 1 && (queue[1].timestamp <= nowUs || queue.length > MAX_QUEUE)) {
        queue.shift().close();
        droppedFrames += 1;
      }
      return true;
    }
    /** Draw one frame now (frame step, paused seek). The renderer takes ownership. */
    function show(frame) {
      closeQueue();
      draw(frame);
    }
    function setView(next) {
      view = { ...view, ...next };
      if (shownFrame) paint(shownFrame);
    }
    function start(mediaClock) {
      clock = mediaClock;
      lastTickMs = performance.now();
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
    }
    /** Milliseconds since the last animation frame while started (hidden tabs stop them). */
    function idleMs() {
      return animationFrame ? performance.now() - lastTickMs : 0;
    }
    function stop({ clear = true } = {}) {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      animationFrame = 0;
      if (clear) closeQueue();
    }
    function clear() {
      closeQueue();
      shownFrame?.close();
      shownFrame = null;
      if (gpu) {
        try { gpu.clear?.(); } catch (_) {}
      } else {
        context.clearRect(0, 0, canvas.width, canvas.height);
      }
      lastTimestamp = null;
    }
    function rendererState() {
      if (!gpu || typeof gpu.state !== 'function') return null;
      try { return gpu.state(); } catch (_) { return null; }
    }
    /* A WebGPU canvas keeps its image readable only until the frame is presented, so
       redraw the shown frame and read it in the same task. */
    function snapshot() {
      if (gpu && shownFrame) paintGpu(shownFrame, geometry(shownFrame.displayWidth, shownFrame.displayHeight, view));
      return canvas.toDataURL('image/png');
    }
    function snapshotBlob() {
      if (gpu) return gpu.snapshot();
      if (typeof canvas.convertToBlob === 'function') return canvas.convertToBlob({ type: 'image/png' });
      return new Promise((resolve, reject) => {
        canvas.toBlob(blob => (blob ? resolve(blob) : reject(new Error('The canvas produced no image.'))), 'image/png');
      });
    }
    function stats() {
      return {
        renderedFrames,
        droppedFrames,
        lost,
        queuedFrames: queue.length,
        lastTimestamp,
        queuedUntilUs: queue.length ? queue[queue.length - 1].timestamp : null,
      };
    }
    function outputSize() {
      return { ...output };
    }
    function destroy() {
      stop();
      clear();
      clock = null;
      if (gpu) {
        try { gpu.destroy(); } catch (_) {}
      }
    }
    return {
      backend, enqueue, show, setView, start, stop, clear, snapshot, snapshotBlob, stats, outputSize, rendererState, destroy,
      idleMs, isLost: () => lost, flush: closeQueue,
    };
  }

  /* engine/gpu-renderer.mjs (gpu area), imported lazily and guarded: a missing file,
     no WebGPU, or a failed device all give null, and the caller uses Canvas2D. */
  let gpuModule = null;
  async function createGpu(canvas) {
    if (!globalThis.navigator?.gpu) return null;
    gpuModule ??= import('./gpu-renderer.mjs').catch(() => null);
    const module = await gpuModule;
    if (typeof module?.createGpuRenderer !== 'function') return null;
    try {
      return (await module.createGpuRenderer(canvas)) || null;
    } catch (_) {
      return null;
    }
  }

  return { attach, geometry, createGpu };
})();

/* Layer 7 — playback coordinator over decode, audio, clock, and renderer. */
const Playback = (() => {
  let metadata = null;
  let clock = Clock.create();
  let renderer = null;
  let generation = 0;
  let monitorFrame = 0;
  let streamTask = null;
  let playTask = null;
  let lastError = null;
  let loopWrapping = false;
  let audioRefusal = null;
  let lastAudioRouteKey = null;
  let view = {
    aspect: 'auto',
    crop: 'none',
    zoom: { scale: 1, x: 0.5, y: 0.5 },
    adjust: { brightness: 0, contrast: 1, saturation: 1, gamma: 1 },
    deinterlace: 'off',
    tonemap: 'auto',
  };
  let rendererReady = Promise.resolve();
  let attachToken = 0;
  let keyframeTimes = [];
  let thumbnailToken = 0;
  // The person's (or a command's) wish to play, set by play() and cleared only by
  // pause(), the end of the file or an error. seek() restarts from it, not from the clock,
  // which runs only after the audio prebuffer (review V3).
  let intendsToPlay = false;
  let playGeneration = -1;
  // The video decode stream's own token: bumping it stops that stream alone (hidden tab,
  // renderer swap) while the audio plays on.
  let videoToken = 0;
  let videoSuspended = false;
  let monitorTimer = 0;
  let rendererLosses = 0;
  const MAX_VOLUME = 2;
  const MAX_PCM_SECONDS = 3600;
  const MAX_AUDIO_DELAY_S = 10;
  const MAX_CROP = 0.45;

  store.clock.audioDelayS ??= 0;
  store.clock.loop ??= null;
  store.clock.preservePitch ??= true;
  AudioOutput.setPreservePitch(store.clock.preservePitch);

  function publish() {
    store.clock.positionS = clock.current();
    store.clock.playing = clock.playing;
    store.clock.rate = clock.rate;
  }
  function stopMonitor() {
    if (monitorFrame) cancelAnimationFrame(monitorFrame);
    monitorFrame = 0;
    if (monitorTimer) clearInterval(monitorTimer);
    monitorTimer = 0;
  }
  /* End of file and the A-B loop are checked on every animation frame for precision and
     on a 250 ms timer, which still runs in a hidden tab where animation frames stop
     (review V2). Returns whether playback goes on. */
  function checkPosition() {
    publish();
    if (!clock.playing) return false;
    const now = clock.current();
    const loop = store.clock.loop;
    if (loop && now >= loop.bS) {
      if (!loopWrapping) {
        loopWrapping = true;
        seek(loop.aS)
          .catch(error => { lastError = error; })
          .finally(() => { loopWrapping = false; });
      }
      return false;
    }
    if (Number.isFinite(clock.duration) && now >= clock.duration) {
      pause();
      clock.seek(clock.duration);
      publish();
      emit('playback:ended', { positionS: clock.current() });
      return false;
    }
    return true;
  }
  function monitor() {
    monitorFrame = 0;
    if (checkPosition()) monitorFrame = requestAnimationFrame(monitor);
  }
  /* A hidden tab stops animation frames, so nothing draws: stop the video decode there
     and restart it at the clock when frames come back. Sound plays on. A Picture-in-
     Picture window keeps animation frames running, so it keeps its picture. */
  function backgroundVideo() {
    const videoTrack = selectedVideoTrack();
    if (!clock.playing || !videoTrack || !renderer || renderer.isLost()) return;
    const idle = renderer.idleMs();
    if (!videoSuspended && idle > 1000) {
      videoSuspended = true;
      videoToken += 1;
      renderer.flush();
      emit('playback:video-suspended', { positionS: clock.current() });
    } else if (videoSuspended && idle < 500) {
      startVideoStream(generation, videoTrack);
      emit('playback:video-resumed', { positionS: clock.current() });
    }
  }
  function startMonitor() {
    if (!monitorFrame) monitorFrame = requestAnimationFrame(monitor);
    if (!monitorTimer) {
      monitorTimer = setInterval(() => {
        if (checkPosition()) backgroundVideo();
      }, 250);
    }
  }
  function selectedVideoTrack() {
    return store.tracks.video[store.tracks.selected.video ?? 0] || null;
  }
  /* Deinterlacing runs in the GPU renderer when there is one. A libav session on
     Canvas2D deinterlaces in the decoder (yadif) instead, since Canvas2D cannot. */
  function decoderDeinterlace() {
    return selectedVideoTrack()?.backend === 'libav'
      && view.deinterlace !== 'off'
      && !!renderer && renderer.backend !== 'webgpu';
  }
  function applyRotation() {
    const track = selectedVideoTrack();
    renderer?.setView({
      ...view,
      rotation: track?.rotation || 0,
      flip: track?.flip === true,
      field: track?.fieldOrder === 'bff' ? 'bottom' : 'top',
      deinterlace: decoderDeinterlace() ? 'off' : view.deinterlace,
    });
  }
  async function readyRenderer() {
    await rendererReady.catch(() => {});
    return renderer;
  }
  function load(nextMetadata) {
    generation += 1;
    videoToken += 1;
    intendsToPlay = false;
    videoSuspended = false;
    stopMonitor();
    clock.pause();
    AudioOutput.stop();
    renderer?.stop();
    renderer?.clear();
    metadata = nextMetadata;
    clock = Clock.create(nextMetadata?.duration ?? Infinity);
    streamTask = null;
    lastError = null;
    audioRefusal = null;
    lastAudioRouteKey = null;
    store.clock.loop = null;
    store.clock.audioDelayS = 0;
    keyframeTimes = [];
    applyRotation();
    if (decoderDeinterlace()) Libav.setDeinterlace(true);
    publish();
    const loadedMetadata = metadata;
    const videoTrack = selectedVideoTrack();
    if (videoTrack && videoTrack.backend !== 'libav') {
      Demux.keyframes(videoTrack).then(times => {
        if (metadata !== loadedMetadata) return;
        keyframeTimes = times;
        emit('playback:keyframes', { count: times.length });
      }).catch(() => {});
    }
    emit('playback:loaded', {
      name: nextMetadata?.name || null,
      duration: nextMetadata?.duration ?? null,
    });
  }
  /* The renderer is chosen asynchronously (WebGPU when engine/gpu-renderer.mjs gives
     one, else Canvas2D); everything that draws waits for `rendererReady`. */
  /* After a lost GPU device (event playback:renderer-lost) the host passes a new canvas
     here: the engine tries a new WebGPU device once, and uses Canvas2D after a second
     loss or when `{ renderer: 'canvas2d' }` is passed. Playback continues on the new
     canvas at the clock; a paused file shows its frame again. */
  function attach(canvas, { renderer: kind = 'auto' } = {}) {
    const token = ++attachToken;
    const previous = renderer;
    renderer = null;
    videoToken += 1;
    previous?.destroy();
    const canvasOnly = kind === 'canvas2d' || rendererLosses >= 2;
    rendererReady = (async () => {
      const gpu = canvasOnly ? null : await Renderer.createGpu(canvas);
      if (token !== attachToken) {
        try { gpu?.destroy(); } catch (_) {}
        return;
      }
      renderer = Renderer.attach(canvas, gpu, { onLost: info => rendererLost(token, info) });
      applyRotation();
      emit('playback:renderer', { backend: renderer.backend });
      const videoTrack = selectedVideoTrack();
      if (metadata && videoTrack && clock.playing) {
        renderer.start(clock);
        startVideoStream(generation, videoTrack);
      } else if (metadata && videoTrack && !playTask) {
        present().catch(() => {});
      }
    })();
    return rendererReady;
  }
  function rendererLost(token, info) {
    if (token !== attachToken) return;
    rendererLosses += 1;
    videoToken += 1;
    emit('playback:renderer-lost', {
      reason: info?.reason || 'device-lost',
      backend: renderer?.backend || 'webgpu',
      positionS: clock.current(),
      playing: clock.playing,
      next: rendererLosses >= 2 ? 'canvas2d' : 'webgpu',
    });
  }
  /** The audio master shifted by the audio delay: the clock reads picture time. */
  function audioMaster() {
    const delayS = store.clock.audioDelayS;
    return {
      current: () => AudioOutput.current() + delayS,
      setRate: value => AudioOutput.setRate(value),
    };
  }
  function reportAudioRoute(audioTrack, route) {
    const index = store.tracks.audio.indexOf(audioTrack);
    if (route.route) {
      audioRefusal = null;
      const key = `${audioTrack.id}:${route.route}`;
      if (key !== lastAudioRouteKey) {
        lastAudioRouteKey = key;
        emit('playback:audio-route', { trackIndex: index, codec: audioTrack.codec, route: route.route });
      }
      return;
    }
    const error = route.error;
    const key = `${audioTrack.id}:refused`;
    audioRefusal = {
      trackIndex: index,
      codec: audioTrack.codecParameter || audioTrack.codec || null,
      name: error?.name || 'AudioRefusedError',
      code: error?.code || 'ERR_AUDIO_REFUSED',
      message: error?.message || 'This audio track cannot be decoded in this browser.',
    };
    if (key !== lastAudioRouteKey) {
      lastAudioRouteKey = key;
      emit('playback:audio-refused', { ...audioRefusal });
    }
  }
  function startVideoStream(localGeneration, videoTrack) {
    const token = ++videoToken;
    videoSuspended = false;
    const task = Decode.stream(
      videoTrack,
      clock.current(),
      (frame, frameInfo) => (renderer ? renderer.enqueue(frame, clock.current(), frameInfo) : false),
      {
        shouldContinue: () => localGeneration === generation && token === videoToken,
        currentTimeS: () => clock.current(),
        decodeAheadS: CONFIG.sync.decodeAheadMs / 1000,
      },
    );
    streamTask = task;
    task.catch(error => {
      if (localGeneration !== generation || token !== videoToken) return;
      lastError = error;
      pause();
    }).finally(() => {
      if (streamTask === task) streamTask = null;
    });
    return task;
  }
  /* Before the clock runs, wait (at most 1.5 s) until the first frame at or after the
     position is queued, so sound does not start under an old key frame (review V40). */
  async function firstFrameQueued(localGeneration) {
    const deadline = performance.now() + 1_500;
    while (localGeneration === generation && performance.now() < deadline) {
      if (!renderer || renderer.isLost() || !streamTask) return;
      if (renderer.stats().queuedFrames > 0) return;
      await new Promise(resolve => setTimeout(resolve, 8));
    }
  }
  async function beginPlay() {
    if (!metadata) throw new Error('Load media before playback.');
    if (clock.playing) return;
    const localGeneration = ++generation;
    const videoTrack = selectedVideoTrack();
    const audioTrack = store.tracks.audio[store.tracks.selected.audio ?? 0];
    if (!videoTrack && !audioTrack) throw new Error('The selected media has no playable audio or video track.');
    if (videoTrack) await readyRenderer();
    if (localGeneration !== generation) return;
    if (videoTrack && !renderer) throw new Error('Attach a renderer before video playback.');

    const audioUnlock = audioTrack ? AudioOutput.unlock() : Promise.resolve();
    const [, audioRoute] = await Promise.all([
      videoTrack ? Decode.supportedConfig(videoTrack) : Promise.resolve(),
      audioTrack ? Decode.audioRoute(audioTrack) : Promise.resolve(null),
      audioUnlock,
    ]);
    if (localGeneration !== generation) return;
    // Audio-only media keeps its old contract: an undecodable track is an error.
    if (audioTrack && !audioRoute.route && !videoTrack) throw audioRoute.error;
    if (audioTrack) reportAudioRoute(audioTrack, audioRoute);
    lastError = null;
    if (videoTrack && !renderer.isLost()) startVideoStream(localGeneration, videoTrack);
    let audioReady = false;
    if (audioTrack && audioRoute.route) {
      const delayS = store.clock.audioDelayS;
      try {
        await AudioOutput.prepare(
          audioTrack,
          audioRoute,
          clock.current() - delayS,
          clock.rate,
          () => localGeneration === generation,
          error => {
            if (localGeneration !== generation) return;
            lastError = error;
            pause();
          },
        );
        audioReady = true;
      } catch (error) {
        if (localGeneration !== generation) return;
        // A file with video plays on without sound and names the refusal (review V4).
        if (!videoTrack) throw error;
        reportAudioRoute(audioTrack, { route: null, error });
      }
      if (localGeneration !== generation) return;
    }
    if (videoTrack) await firstFrameQueued(localGeneration);
    if (localGeneration !== generation) return;
    if (audioReady) {
      clock.bind(audioMaster());
      AudioOutput.play();
    } else {
      clock.bind(null);
    }
    clock.play();
    renderer?.start(clock);
    publish();
    emit('playback:play', { positionS: clock.current(), rate: clock.rate });
    startMonitor();
    if (!videoTrack) streamTask = null;
  }
  function play() {
    intendsToPlay = true;
    if (clock.playing) return Promise.resolve();
    if (playTask && playGeneration === generation) return playTask;
    const task = beginPlay();
    playGeneration = generation;
    playTask = task;
    return task.catch(error => {
      if (playTask === task) intendsToPlay = false;
      throw error;
    }).finally(() => {
      if (playTask === task) playTask = null;
    });
  }
  /* Stop every pipeline; the play intent stays as it was. */
  function halt() {
    generation += 1;
    videoToken += 1;
    videoSuspended = false;
    clock.pause();
    AudioOutput.stop();
    clock.bind(null);
    renderer?.stop();
    stopMonitor();
    publish();
  }
  function pause() {
    intendsToPlay = false;
    halt();
    emit('playback:pause', { positionS: clock.current() });
  }
  /* Pause and blank the picture: the renderer closes its queued frames, the frame on
     screen, and the WebGPU renderer's snapshot clone, so no VideoFrame stays open while
     the host shows its start screen. The file stays loaded; the next load replaces it.
     The audio context is suspended until the next play (review V44). */
  function clearPicture() {
    pause();
    renderer?.clear();
    AudioOutput.suspend();
  }
  /* Page hide (close, navigation, back-forward cache): stop and close the audio context. */
  function pageHidden() {
    if (clock.playing || intendsToPlay) pause();
    AudioOutput.close();
  }
  async function seek(positionS) {
    if (!metadata) throw new Error('Load media before seeking.');
    if (!Number.isFinite(positionS)) throw new TypeError('Seek time must be finite.');
    const resume = intendsToPlay || clock.playing;
    halt();
    if (!resume) emit('playback:pause', { positionS: clock.current() });
    clock.seek(positionS);
    renderer?.clear();
    publish();
    if (resume) await play();
    else await present();
    emit('playback:seek', { positionS: clock.current() });
    return clock.current();
  }
  /**
   * While paused, show the frame at the clock position: decode from the key frame at
   * or before it and keep the latest frame at or before the position (the earliest
   * frame when the position precedes every frame). Failures leave the canvas as it
   * was; playback reports decode errors itself. Returns whether a frame was drawn.
   */
  async function present() {
    const videoTrack = selectedVideoTrack();
    const localGeneration = generation;
    if (videoTrack) await readyRenderer();
    if (!metadata || !videoTrack || !renderer || clock.playing || localGeneration !== generation) return false;
    const targetUs = Math.round(clock.current() * 1_000_000);
    const toleranceUs = 500;
    const fits = frame => frame.timestamp <= targetUs + toleranceUs;
    let frame = null;
    try {
      frame = await Decode.pickFrame(videoTrack, Math.max(0, targetUs / 1_000_000), targetUs + 250_000, (candidate, best) => {
        if (!best) return true;
        if (fits(candidate) !== fits(best)) return fits(candidate);
        return fits(candidate) ? candidate.timestamp > best.timestamp : candidate.timestamp < best.timestamp;
      });
    } catch (_) {
      return false;
    }
    if (!frame) return false;
    if (localGeneration !== generation || clock.playing || selectedVideoTrack() !== videoTrack) {
      frame.close();
      return false;
    }
    renderer.show(frame);
    return true;
  }
  /** Rebuild the running pipelines at the current position (track or delay change). */
  async function restartIfPlaying() {
    if (playTask) await playTask.catch(() => {});
    if (!clock.playing && !intendsToPlay) return;
    await seek(clock.current());
  }
  async function selectAudioTrack(index) {
    if (!metadata) throw new Error('Load media before choosing an audio track.');
    if (!Number.isInteger(index) || !store.tracks.audio[index]) {
      throw new PlaybackError(
        'AudioTrackUnavailableError',
        'ERR_AUDIO_TRACK',
        `Audio track ${index} does not exist; this file has ${store.tracks.audio.length}.`,
      );
    }
    if (store.tracks.selected.audio !== index) {
      store.tracks.selected.audio = index;
      audioRefusal = null;
      emit('playback:audio-track', { index, trackId: store.tracks.audio[index].id });
      await restartIfPlaying();
    }
    return index;
  }
  function setAudioDelay(seconds) {
    if (!Number.isFinite(seconds) || Math.abs(seconds) > MAX_AUDIO_DELAY_S) {
      throw new RangeError(`Audio delay must be between -${MAX_AUDIO_DELAY_S} and ${MAX_AUDIO_DELAY_S} seconds.`);
    }
    const delayS = Math.round(seconds * 1000) / 1000;
    if (delayS === store.clock.audioDelayS) return delayS;
    store.clock.audioDelayS = delayS;
    emit('playback:audio-delay', { seconds: delayS });
    if (metadata) restartIfPlaying().catch(error => { lastError = error; });
    return delayS;
  }
  function setLoop(range) {
    if (range === null || range === undefined) {
      store.clock.loop = null;
    } else {
      const aS = Number(range.aS);
      const end = Number.isFinite(clock.duration) ? clock.duration : Infinity;
      const bS = Math.min(Number(range.bS), end);
      if (!Number.isFinite(aS) || !Number.isFinite(bS) || aS < 0 || bS <= aS) {
        throw new RangeError('A loop needs finite times with 0 <= A < B.');
      }
      store.clock.loop = { aS, bS };
    }
    emit('playback:loop', { loop: store.clock.loop ? { ...store.clock.loop } : null });
    return store.clock.loop ? { ...store.clock.loop } : null;
  }
  function normalizeCrop(crop) {
    if (crop === 'none' || crop === null || crop === undefined) return 'none';
    const sides = ['top', 'right', 'bottom', 'left'];
    const output = {};
    for (const side of sides) {
      const value = Number(crop[side] ?? 0);
      if (!Number.isFinite(value) || value < 0 || value > MAX_CROP) {
        throw new RangeError(`Crop ${side} must be a fraction from 0 to ${MAX_CROP}.`);
      }
      output[side] = value;
    }
    return sides.every(side => output[side] === 0) ? 'none' : output;
  }
  function setView(next = {}) {
    const updated = { ...view };
    if ('aspect' in next) {
      if (next.aspect === 'auto') updated.aspect = 'auto';
      else if (Number.isFinite(next.aspect) && next.aspect >= 0.1 && next.aspect <= 10) updated.aspect = next.aspect;
      else throw new RangeError("Aspect must be 'auto' or a width ÷ height ratio from 0.1 to 10.");
    }
    if ('crop' in next) updated.crop = normalizeCrop(next.crop);
    if ('zoom' in next) updated.zoom = normalizeZoom(next.zoom, updated.zoom);
    if ('adjust' in next) updated.adjust = normalizeAdjust(next.adjust, updated.adjust);
    if ('deinterlace' in next) {
      if (!['off', 'blend', 'bob'].includes(next.deinterlace)) throw new RangeError("Deinterlace must be 'off', 'blend' or 'bob'.");
      updated.deinterlace = next.deinterlace;
    }
    if ('tonemap' in next) {
      if (!['auto', 'off'].includes(next.tonemap)) throw new RangeError("Tone mapping must be 'auto' or 'off'.");
      updated.tonemap = next.tonemap;
    }
    const before = decoderDeinterlace();
    view = updated;
    applyRotation();
    const after = decoderDeinterlace();
    if (before !== after) {
      // The rung applies the change to the next videoFrames() call, so restart it.
      Libav.setDeinterlace(after);
      restartIfPlaying().catch(error => { lastError = error; });
    }
    const current = viewState();
    emit('playback:view', current);
    return current;
  }
  /* The GPU renderer's conventions (engine/gpu-renderer.mjs): zoom.scale 1 to 16; x and
     y are the centre of the view in the cropped picture, 0 to 1 (0.5 is centred),
     clamped here so the zoomed view stays inside the picture. */
  function normalizeZoom(next, current) {
    if (next === null || next === 'reset') return { scale: 1, x: 0.5, y: 0.5 };
    const merged = { ...current, ...next };
    const scale = Number(merged.scale);
    if (!Number.isFinite(scale) || scale < 1 || scale > 16) throw new RangeError('Zoom scale must be from 1 to 16.');
    const low = 0.5 / scale;
    const clampCentre = value => {
      const number = Number(value);
      if (!Number.isFinite(number)) throw new RangeError('Zoom centre must be a finite fraction from 0 to 1.');
      return Math.max(low, Math.min(1 - low, number));
    };
    return { scale, x: clampCentre(merged.x ?? 0.5), y: clampCentre(merged.y ?? 0.5) };
  }
  // brightness is an offset (0 unchanged); the others are factors (1 unchanged).
  const ADJUST_RANGES = {
    brightness: [-1, 1, 0],
    contrast: [0, 2, 1],
    saturation: [0, 2, 1],
    gamma: [0.2, 5, 1],
  };
  function normalizeAdjust(next, current) {
    if (next === null || next === 'reset') return { brightness: 0, contrast: 1, saturation: 1, gamma: 1 };
    const merged = { ...current, ...next };
    const output = {};
    for (const [key, [low, high, neutral]] of Object.entries(ADJUST_RANGES)) {
      const value = Number(merged[key] ?? neutral);
      if (!Number.isFinite(value) || value < low || value > high) {
        throw new RangeError(`${key} must be from ${low} to ${high} (${neutral} is unchanged).`);
      }
      output[key] = value;
    }
    return output;
  }
  function viewState() {
    const output = renderer?.outputSize() || { width: null, height: null };
    const backend = renderer?.backend || null;
    const gpu = backend === 'webgpu';
    return {
      aspect: view.aspect,
      crop: view.crop === 'none' ? 'none' : { ...view.crop },
      rotation: selectedVideoTrack()?.rotation || 0,
      zoom: { ...view.zoom },
      adjust: { ...view.adjust },
      // Canvas2D cannot deinterlace or tone map; it reports that instead of the request.
      deinterlace: gpu || decoderDeinterlace() || view.deinterlace === 'off' && selectedVideoTrack()?.backend === 'libav'
        ? view.deinterlace
        : 'unsupported',
      tonemap: gpu ? view.tonemap : 'unsupported',
      backend,
      unsupported: gpu || !backend ? [] : ['deinterlace', 'tonemap', 'gamma'],
      interlaced: !!selectedVideoTrack()?.interlaced,
      fieldOrder: selectedVideoTrack()?.fieldOrder || null,
      renderer: renderer?.rendererState() || null,
      width: output.width,
      height: output.height,
    };
  }
  /**
   * The frame nearest `timeS` as an upright ImageBitmap at most `maxWidth` wide, from
   * its own decoder; a newer request cancels an older one, which resolves to null.
   */
  async function thumbnail(timeS, { maxWidth = 160 } = {}) {
    const token = ++thumbnailToken;
    const track = selectedVideoTrack();
    // libav sessions decode thumbnails through the rung too (review V63); they share its worker.
    if (!metadata || !track || typeof globalThis.OffscreenCanvas !== 'function') return null;
    if (!Number.isFinite(timeS)) throw new RangeError('Thumbnail time must be finite.');
    if (!Number.isFinite(maxWidth) || maxWidth < 1) throw new RangeError('maxWidth must be a positive number.');
    const end = Number.isFinite(clock.duration) ? clock.duration : timeS;
    const targetUs = Math.round(Math.max(0, Math.min(end, timeS)) * 1_000_000);
    const live = () => token === thumbnailToken;
    let frame = null;
    try {
      frame = await Decode.pickFrame(
        track,
        targetUs / 1_000_000,
        targetUs + 250_000,
        (candidate, best) => !best
          || Math.abs(candidate.timestamp - targetUs) < Math.abs(best.timestamp - targetUs),
        { shouldContinue: live },
      );
    } catch (_) {
      return null;
    }
    if (!frame) return null;
    try {
      if (!live()) return null;
      const g = Renderer.geometry(frame.displayWidth, frame.displayHeight, { rotation: track.rotation || 0, flip: track.flip === true, aspect: 'auto', crop: 'none' });
      const scale = Math.min(1, maxWidth / g.outputWidth);
      const width = Math.max(1, Math.round(g.outputWidth * scale));
      const height = Math.max(1, Math.round(g.outputHeight * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      const quarterTurn = g.drawWidth !== g.outputWidth;
      const drawWidth = quarterTurn ? height : width;
      const drawHeight = quarterTurn ? width : height;
      context.translate(width / 2, height / 2);
      if (g.flip) context.scale(-1, 1);
      context.rotate(g.radians);
      context.drawImage(frame, g.sx, g.sy, g.sw, g.sh, -drawWidth / 2, -drawHeight / 2, drawWidth, drawHeight);
      return canvas.transferToImageBitmap();
    } finally {
      frame.close();
    }
  }
  function keyframes() {
    return [...keyframeTimes];
  }
  /** Decoded-ahead range: from the clock to the newest queued frame or buffered audio. */
  function buffered() {
    if (!metadata || !clock.playing) return [];
    const now = clock.current();
    let end = now;
    const queuedUntilUs = renderer?.stats().queuedUntilUs;
    if (Number.isFinite(queuedUntilUs)) end = Math.max(end, queuedUntilUs / 1_000_000);
    const audio = AudioOutput.state();
    if (audio.active && audio.sourceRate) end = Math.max(end, now + (audio.bufferedFrames / audio.sourceRate));
    if (Number.isFinite(clock.duration)) end = Math.min(end, clock.duration);
    return [{ startS: now, endS: end }];
  }
  /**
   * Mono PCM of the selected audio track from `fromS` to `toS` at `sampleRate`,
   * decoded by its own decoder (playback continues untouched). At most an hour a call.
   */
  async function audioPcm({ fromS = 0, toS = null, sampleRate = 16000 } = {}) {
    if (!metadata) throw new Error('Load media before reading audio.');
    const track = store.tracks.audio[store.tracks.selected.audio ?? 0];
    if (!track) throw new PlaybackError('AudioPcmNoAudioError', 'ERR_AUDIO_PCM_NO_AUDIO', 'This media has no audio track.');
    const duration = Number.isFinite(clock.duration) ? clock.duration : Infinity;
    const endS = Math.min(toS ?? duration, duration);
    if (!Number.isFinite(fromS) || fromS < 0 || !Number.isFinite(endS) || endS <= fromS) {
      throw new RangeError('audioPcm needs 0 <= fromS < toS within the media.');
    }
    if (endS - fromS > MAX_PCM_SECONDS) throw new RangeError(`audioPcm reads at most ${MAX_PCM_SECONDS} s a call.`);
    if (!Number.isInteger(sampleRate) || sampleRate < 3000 || sampleRate > 192000) {
      throw new RangeError('sampleRate must be an integer from 3000 to 192000.');
    }
    const route = await Decode.audioRoute(track);
    if (!route.route) throw route.error;
    const pieces = [];
    let sourceRate = track.sampleRate || 48000;
    let done = false;
    await Decode.streamAudio(track, route.route, fromS, data => {
      const startS = 'microsecondTimestamp' in data ? data.timestamp : data.timestamp / 1_000_000;
      sourceRate = data.sampleRate || sourceRate;
      if (startS > endS + 0.5) {
        done = true;
        data.close();
        return true;
      }
      const frames = data.numberOfFrames;
      const mono = new Float32Array(frames);
      const plane = new Float32Array(frames);
      for (let channel = 0; channel < data.numberOfChannels; channel += 1) {
        data.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
        for (let index = 0; index < frames; index += 1) mono[index] += plane[index] / data.numberOfChannels;
      }
      data.close();
      pieces.push({ startS, mono });
      return true;
    }, { shouldContinue: () => !done, currentTimeS: () => Infinity, decodeAheadS: 0 });
    const length = Math.max(1, Math.round((endS - fromS) * sourceRate));
    const source = new Float32Array(length);
    for (const piece of pieces) {
      const offset = Math.round((piece.startS - fromS) * sourceRate);
      const from = Math.max(0, -offset);
      const to = Math.min(piece.mono.length, length - offset);
      if (to > from) source.set(piece.mono.subarray(from, to), offset + from);
    }
    if (sourceRate === sampleRate) return source;
    const outputLength = Math.max(1, Math.round((endS - fromS) * sampleRate));
    const Offline = globalThis.OfflineAudioContext;
    if (typeof Offline === 'function') {
      const offline = new Offline(1, outputLength, sampleRate);
      const buffer = offline.createBuffer(1, source.length, sourceRate);
      buffer.copyToChannel(source, 0);
      const node = offline.createBufferSource();
      node.buffer = buffer;
      node.connect(offline.destination);
      node.start();
      return (await offline.startRendering()).getChannelData(0);
    }
    const output = new Float32Array(outputLength);
    const ratio = sourceRate / sampleRate;
    for (let index = 0; index < outputLength; index += 1) {
      const position = index * ratio;
      const left = Math.floor(position);
      const right = Math.min(source.length - 1, left + 1);
      output[index] = source[left] + ((source[right] - source[left]) * (position - left));
    }
    return output;
  }
  async function stepFrame(direction) {
    if (direction !== 1 && direction !== -1) throw new RangeError('Frame step direction must be 1 or -1.');
    if (!metadata) throw new Error('Load media before stepping frames.');
    if (clock.playing || playTask) {
      throw new PlaybackError('FrameStepWhilePlayingError', 'ERR_FRAME_STEP_PLAYING', 'Pause playback before stepping frames.');
    }
    const videoTrack = selectedVideoTrack();
    if (!videoTrack) {
      throw new PlaybackError('FrameStepNoVideoError', 'ERR_FRAME_STEP_NO_VIDEO', 'This media has no video frames to step through.');
    }
    const localGeneration = ++generation;
    await readyRenderer();
    if (localGeneration !== generation) return clock.current();
    if (!renderer) throw new Error('Attach a renderer before stepping frames.');
    const toleranceUs = 500;
    const clockUs = Math.round(clock.current() * 1_000_000);
    // Step from the frame on screen when it belongs to the clock position; when it is
    // missing or stale (the position moved without a draw), step from the position.
    let shownUs = renderer.stats().lastTimestamp;
    if (shownUs !== null && (shownUs > clockUs + toleranceUs || clockUs - shownUs > 250_000)) shownUs = null;
    const currentUs = shownUs ?? clockUs;
    const stopUs = currentUs + CONFIG.decode.videoLookaheadUs;
    let frame = null;
    if (direction > 0) {
      const afterUs = currentUs;
      frame = await Decode.pickFrame(
        videoTrack,
        Math.max(0, currentUs / 1_000_000),
        stopUs,
        (candidate, best) => candidate.timestamp > afterUs + toleranceUs
          && (!best || candidate.timestamp < best.timestamp),
      );
    } else if (currentUs > 0) {
      frame = await Decode.pickFrame(
        videoTrack,
        Math.max(0, (currentUs - 1) / 1_000_000),
        stopUs,
        (candidate, best) => candidate.timestamp < currentUs - toleranceUs
          && (!best || candidate.timestamp > best.timestamp),
      );
    }
    if (localGeneration !== generation || !frame) {
      frame?.close();
      return clock.current();
    }
    clock.seek(Math.max(0, frame.timestamp / 1_000_000));
    renderer.show(frame);
    publish();
    emit('playback:seek', { positionS: clock.current(), frameStep: direction });
    return clock.current();
  }
  function chapters() {
    const duration = Number.isFinite(clock.duration) ? clock.duration : null;
    const top = (metadata?.chapters || []).filter(chapter => (chapter.depth ?? 0) === 0);
    return top.map((chapter, index) => ({
      startS: chapter.startS,
      endS: Number.isFinite(chapter.endS) ? chapter.endS : (top[index + 1]?.startS ?? duration),
      title: chapter.title || '',
    }));
  }
  function setRate(rate) {
    clock.setRate(rate);
    publish();
    emit('playback:rate', { rate: clock.rate });
  }
  /* Speed changes keep the pitch by default, as VLC, mpv and QuickTime do (review V42). */
  function setPreservePitch(value) {
    store.clock.preservePitch = value !== false;
    AudioOutput.setPreservePitch(store.clock.preservePitch);
    emit('playback:pitch', { preservePitch: store.clock.preservePitch });
    return store.clock.preservePitch;
  }
  function setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > MAX_VOLUME) {
      throw new RangeError(`Volume must be between 0 and ${MAX_VOLUME}.`);
    }
    store.clock.volume = volume;
    if (volume > 0) store.clock.muted = false;
    AudioOutput.setVolume(store.clock.volume, store.clock.muted);
    emit('playback:volume', { volume: store.clock.volume, muted: store.clock.muted });
  }
  function setMuted(muted) {
    store.clock.muted = !!muted;
    AudioOutput.setVolume(store.clock.volume, store.clock.muted);
    emit('playback:volume', { volume: store.clock.volume, muted: store.clock.muted });
  }
  function state() {
    publish();
    return {
      generation,
      attached: !!renderer,
      streamActive: clock.playing && (!!streamTask || AudioOutput.state().decoderActive),
      lastError: lastError ? { name: lastError.name, code: lastError.code, message: lastError.message } : null,
      audio: AudioOutput.state(),
      audioRefusal: audioRefusal ? { ...audioRefusal } : null,
      renderer: renderer?.stats() || null,
      intendsToPlay,
      videoSuspended,
      rendererLosses,
    };
  }
  function snapshot() {
    if (!renderer) throw new Error('Attach a renderer before taking a snapshot.');
    return renderer.snapshot();
  }
  async function snapshotBlob() {
    if (!await readyRenderer()) throw new Error('Attach a renderer before taking a snapshot.');
    return renderer.snapshotBlob();
  }
  function audioGraph() {
    return AudioOutput.audioGraph();
  }

  return {
    load,
    attach,
    play,
    pause,
    clearPicture,
    pageHidden,
    setPreservePitch,
    seek,
    setRate,
    setVolume,
    setMuted,
    selectAudioTrack,
    setAudioDelay,
    setLoop,
    setView,
    viewState,
    stepFrame,
    present,
    chapters,
    thumbnail,
    keyframes,
    buffered,
    audioPcm,
    state,
    snapshot,
    snapshotBlob,
    audioGraph,
  };
})();

/* Layer 8 — the one mechanism the human UI and the headless harness both drive. */
let latestLoadId = 0;
let fingerprintError = null;

function subtitleTimestamp(seconds, separator) {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

/* ASS and SSA cue payloads are "ReadOrder,Layer,Style,Name,MarginL,MarginR,MarginV,
   Effect,Text": the text follows the eighth comma. Strip override tags for plain text. */
function plainAssText(payload) {
  let commas = 0;
  let index = 0;
  for (; index < payload.length && commas < 8; index += 1) {
    if (payload[index] === ',') commas += 1;
  }
  const text = commas === 8 ? payload.slice(index) : payload;
  return text.replace(/\{[^}]*\}/g, '').replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
}

function subtitleTrackAt(trackIndex) {
  const track = Number.isInteger(trackIndex) ? store.tracks.subtitle[trackIndex] : null;
  if (!track) {
    throw new PlaybackError(
      'SubtitleTrackUnavailableError',
      'ERR_SUBTITLE_TRACK',
      `Embedded subtitle track ${trackIndex} does not exist; this file has ${store.tracks.subtitle.length}.`,
    );
  }
  return track;
}

/** Cues for embedded subtitle track `trackIndex`: [{ startS, endS, text }] sorted by start. */
function refuseBitmap(track) {
  if (track.bitmap) {
    throw new PlaybackError(
      'SubtitleBitmapTrackError',
      'ERR_SUBTITLE_BITMAP',
      `Subtitle track ${track.number} is a ${String(track.codec).toUpperCase()} bitmap track; read it with subtitles.packets().`,
    );
  }
}

/** Raw packets of bitmap track `trackIndex` (PGS display sets): [{ startS, endS, data }]. */
async function subtitlePacketList(trackIndex) {
  const track = subtitleTrackAt(trackIndex);
  if (!track.bitmap) {
    throw new PlaybackError(
      'SubtitleTextTrackError',
      'ERR_SUBTITLE_NOT_BITMAP',
      `Subtitle track ${track.number} is text; read it with subtitles.cues().`,
    );
  }
  const packets = [];
  for await (const cue of Demux.subtitleCues(track)) {
    packets.push({ startS: cue.startS, endS: cue.endS, data: cue.data });
  }
  return packets;
}

async function subtitleCueList(trackIndex) {
  const track = subtitleTrackAt(trackIndex);
  refuseBitmap(track);
  const cues = [];
  for await (const cue of Demux.subtitleCues(track)) {
    // WebVTT cue settings (line, position, align) and identifiers come through (review V48).
    cues.push({ startS: cue.startS, endS: cue.endS, text: cue.text, id: cue.id ?? null, settings: cue.settings || '' });
  }
  return cues;
}

async function exportSubtitles({ trackId = null, trackIndex = null, format = null } = {}) {
  const tracks = store.tracks.subtitle;
  const selectedIndex = Number.isInteger(trackIndex)
    ? trackIndex
    : store.tracks.selected.subtitle >= 0 ? store.tracks.selected.subtitle : 0;
  const track = trackId ? tracks.find(candidate => candidate.id === trackId) : tracks[selectedIndex];
  if (!track) {
    throw new PlaybackError(
      'SubtitleTrackUnavailableError',
      'ERR_SUBTITLE_TRACK',
      'No subtitle track is available for export.',
    );
  }
  refuseBitmap(track);
  const outputFormat = format || (track.codec === 'webvtt' ? 'vtt' : 'srt');
  if (!['srt', 'vtt'].includes(outputFormat)) {
    throw new PlaybackError(
      'SubtitleFormatError',
      'ERR_SUBTITLE_FORMAT',
      `Subtitle export format ${outputFormat} is unsupported.`,
    );
  }
  const cues = [];
  for await (const cue of Demux.subtitleCues(track)) cues.push(cue);
  const separator = outputFormat === 'srt' ? ',' : '.';
  const blocks = cues.map((cue, index) => {
    const timing = `${subtitleTimestamp(cue.startS, separator)} --> ${subtitleTimestamp(cue.endS, separator)}`;
    const text = ['ass', 'ssa'].includes(track.codec) ? plainAssText(cue.text) : cue.text;
    if (outputFormat === 'srt') return `${index + 1}\n${timing}\n${text}`;
    const id = cue.id ? `${cue.id}\n` : '';
    const settings = cue.settings ? ` ${cue.settings}` : '';
    return `${id}${timing}${settings}\n${text}`;
  });
  const stem = String(store.media.name || 'subtitles').replace(/\.[^.]*$/, '');
  return {
    format: outputFormat,
    mimeType: outputFormat === 'srt' ? 'application/x-subrip' : 'text/vtt',
    filename: `${stem}.${outputFormat}`,
    text: `${outputFormat === 'vtt' ? 'WEBVTT\n\n' : ''}${blocks.join('\n\n')}\n`,
    cueCount: cues.length,
    trackId: track.id,
  };
}

/* Names, languages and dispositions of the container's video and audio tracks go onto
   the rung's tracks of the same type and order when both list the same count; subtitle
   tracks and chapters come over whole (review V11). */
function mergeContainerText(metadata, kept) {
  const tracks = metadata.tracks.map(track => ({ ...track }));
  for (const type of ['video', 'audio']) {
    const ours = tracks.filter(track => track.type === type);
    const theirs = kept.named.filter(track => track.type === type);
    if (ours.length !== theirs.length) continue;
    ours.forEach((track, index) => {
      const source = theirs[index];
      if (source.name) track.name = source.name;
      if (source.language && source.language !== 'und') track.language = source.language;
      if (source.disposition) track.disposition = { ...source.disposition };
    });
  }
  return {
    ...metadata,
    tracks: tracks.concat(kept.subtitles),
    chapters: metadata.chapters?.length ? metadata.chapters : kept.chapters,
  };
}

globalThis.addEventListener?.('pagehide', () => Playback.pageHidden());

const Engine = {
  version: CONFIG.version,
  /** Lowercase extensions the engine opens; each passes the golden gate. */
  supportedExtensions: [...SUPPORTED_EXTENSIONS],
  caps() {
    const navigatorApi = globalThis.navigator || {};
    // A constructor, not just a name: playback tests the same (review V29).
    const videoDecoder = typeof globalThis.VideoDecoder === 'function';
    const audioDecoder = typeof globalThis.AudioDecoder === 'function';
    return {
      webCodecs: videoDecoder && audioDecoder,
      videoDecoder,
      audioDecoder,
      // The canvas path runs with VideoDecoder alone: audio then goes through the
      // software rung where it covers the codec, or is refused by name.
      enginePlayback: videoDecoder && 'AudioWorkletNode' in globalThis,
      softwareAudio: Demux.softwareAudio.state(),
      maxVolume: 2,
      fsa: 'showOpenFilePicker' in globalThis,
      opfs: !!(navigatorApi.storage && navigatorApi.storage.getDirectory),
      webgpu: 'gpu' in navigatorApi,
    };
  },
  /* Container metadata without loading. Files that Engine.load sends to the libav rung
     (AVI, FLV, WMV, MPEG program streams) are probed there too, so their duration is
     known before they open (capture defect 5). */
  async probe(handle) {
    const file = await mediaFileOf(handle).catch(() => null);
    if (file && await Libav.preferred(file).catch(() => false)) {
      const metadata = await Libav.probe(file).catch(() => null);
      if (metadata) return metadata;
    }
    try {
      return await Demux.probe(handle);
    } catch (error) {
      if (!file || !Demux.libavEligible(error)) throw error;
      const metadata = await Libav.probe(file).catch(() => null);
      if (!metadata) throw error;
      return metadata;
    }
  },
  async load(handle) {
    const loadId = ++latestLoadId;
    const fileOf = () => mediaFileOf(handle);
    let candidate = null;
    let libavSource = null;
    // The rung's own failures (declined, unavailable, integrity) name the load error;
    // anything else means the rung cannot open this file.
    const tryLibav = async (options) => {
      const file = await fileOf().catch(() => null);
      if (!file) return null;
      try {
        return await Libav.open(file, options);
      } catch (error) {
        if (error?.name === 'LibavRungError') throw error;
        return null;
      }
    };
    const preferLibav = await fileOf().then(file => (file ? Libav.preferred(file) : false)).catch(() => false);
    if (preferLibav) libavSource = await tryLibav({ sniff: false });
    if (!libavSource) {
      try {
        candidate = await Demux.prepare(handle);
      } catch (error) {
        // Containers Mediabunny cannot read (AVI, FLV, ASF/WMV video) go to the libav rung.
        if (!Demux.libavEligible(error)) throw error;
        libavSource = await tryLibav();
        if (!libavSource) throw error;
      }
    }
    let textCandidate = null;
    if (candidate && Demux.needsLibavVideo(candidate)) {
      // Video WebCodecs cannot configure (MPEG-2, MPEG-4 Part 2, VC-1): reopen through libav,
      // keeping the container's text tracks, chapters and track languages (review V11).
      const source = await tryLibav({ sniff: false }).catch(error => {
        Demux.discard(candidate);
        throw error;
      });
      if (source) {
        textCandidate = candidate;
        candidate = null;
        libavSource = source;
      }
    }
    let fingerprint = null;
    let nextFingerprintError = null;
    try {
      const file = await mediaFileOf(handle);
      if (file) fingerprint = await Storage.fingerprint(file);
    } catch (error) {
      nextFingerprintError = error;
    }
    if (loadId !== latestLoadId) {
      Demux.discard(candidate);
      Demux.discard(textCandidate);
      try { libavSource?.close(); } catch (_) {}
      throw new PlaybackError(
        'SupersededLoadError',
        'ERR_ENGINE_LOAD_SUPERSEDED',
        'A newer media load replaced this request.',
      );
    }
    fingerprintError = nextFingerprintError;
    Libav.closeAudio();
    let metadata;
    if (candidate) {
      Libav.close();
      metadata = Demux.activate(candidate);
    } else {
      const kept = Demux.activateText(textCandidate, { startOffsetS: libavSource.startOffsetS });
      if (!kept) Demux.close();
      metadata = Libav.activate(libavSource, await fileOf());
      if (kept) metadata = mergeContainerText(metadata, kept);
    }
    store.media = {
      handle,
      name: metadata.name,
      fingerprint,
      duration: metadata.duration,
      size: metadata.size,
      container: metadata.container,
      mimeType: metadata.mimeType,
      backend: metadata.backend || 'mediabunny',
    };
    store.tracks.video = metadata.tracks.filter(track => track.type === 'video');
    store.tracks.audio = metadata.tracks.filter(track => track.type === 'audio');
    store.tracks.subtitle = metadata.tracks.filter(track => track.type === 'subtitle');
    store.tracks.selected = { video: 0, audio: 0, subtitle: -1 };
    Playback.load(metadata);
    // Show the first frame, as players do on open; a later resume seek replaces it.
    await Playback.present();
    emit('media:loaded', {
      name: metadata.name,
      container: metadata.container,
      duration: metadata.duration,
      trackCount: metadata.tracks.length,
      fingerprint,
    });
    return metadata;
  },
  /** Attach (or, after `playback:renderer-lost`, replace) the canvas; `{ renderer: 'canvas2d' }` skips WebGPU. */
  attach(canvas, options) { return Playback.attach(canvas, options); },
  play() { return Playback.play(); },
  pause() { Playback.pause(); },
  /** Pause and blank the picture, closing every VideoFrame the engine holds (call on "close file"). */
  clearPicture() { Playback.clearPicture(); },
  seek(s) { return Playback.seek(s); },
  setRate(rate) { Playback.setRate(rate); },
  /** Keep the pitch when the speed changes (default true). */
  setPreservePitch(value) { return Playback.setPreservePitch(value); },
  /** 0 to 2; above 1 the gain stage boosts (200% at 2). */
  setVolume(volume) { Playback.setVolume(volume); },
  setMuted(muted) { Playback.setMuted(muted); },
  /** Switch to audio track `index` in store.tracks.audio, keeping position and play state. */
  selectAudioTrack(index) { return Playback.selectAudioTrack(index); },
  /** Offset audio against video in seconds (positive = audio later), within ±10 s. */
  setAudioDelay(seconds) { return Playback.setAudioDelay(seconds); },
  /** Show the next (+1) or previous (-1) frame while paused. */
  stepFrame(direction) { return Playback.stepFrame(direction); },
  /** Loop between A and B seconds while playing, or clear with null. */
  setLoop(range) { return Playback.setLoop(range); },
  /** aspect: 'auto' or width ÷ height; crop: 'none' or { top, right, bottom, left } fractions to 0.45. */
  setView(options) { return Playback.setView(options); },
  chapters() { return Playback.chapters(); },
  /** The frame nearest timeS as an ImageBitmap, from its own decoder; null when unavailable or superseded. */
  thumbnail(timeS, options) { return Playback.thumbnail(timeS, options); },
  /** Key frame times in seconds from the container index (empty until read, or when unknown). */
  keyframes() { return Playback.keyframes(); },
  /** Decoded-ahead ranges [{ startS, endS }]. */
  buffered() { return Playback.buffered(); },
  /** Matroska attachments [{ name, mimeType, data }]; empty for other containers. */
  attachments() { return Demux.attachments(); },
  /** Mono Float32Array PCM of the selected audio track, decoded independently of playback. */
  audioPcm(options) { return Playback.audioPcm(options); },
  /** PNG Blob of the shown frame (WebGPU or Canvas2D). */
  snapshotBlob() { return Playback.snapshotBlob(); },
  state() {
    const { handle: _handle, ...media } = store.media;
    return structuredClone({
      version: CONFIG.version,
      ...store,
      media,
      playback: Playback.state(),
      view: Playback.viewState(),
      metadata: MetadataSync.state(),
      persistenceWarning: fingerprintError ? {
        name: fingerprintError.name,
        message: fingerprintError.message,
      } : null,
    });
  },
  /**
   * The audio output node and its context, or null when nothing is playing.
   *
   * Exposed so a host can insert its own node — an AnalyserNode for a
   * visualiser, a filter chain for an equaliser — between the engine's output
   * and the destination. Without it a consumer has to patch the engine to
   * build anything on top of the audio it already produces.
   *
   * The node returned is the engine's final gain stage. A host that connects
   * it elsewhere is responsible for reconnecting the destination.
   */
  audioGraph() { return Playback.audioGraph(); },
  snapshot() { return Playback.snapshot(); },
  subtitles: { export: exportSubtitles, cues: subtitleCueList, packets: subtitlePacketList },
  _internals: { Storage, Demux, Decode, AudioOutput, Clock, Renderer, Playback, CONFIG }, // for the harness
};

  return Engine;
}
