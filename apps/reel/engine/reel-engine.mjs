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
const SUPPORTED_EXTENSIONS = Object.freeze(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.ts']);

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

  function refuseDetectedFormat(bytes) {
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
    });
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
    const decoder = new TextDecoder('utf-8', { fatal: true });

    class Reader {
      constructor(file, {
        deadline = null,
        timeoutMs = CONFIG.demux.subtitleScanTimeoutMs,
        timeoutLabel = 'Matroska scan',
      } = {}) {
        this.file = file;
        this.size = file.size;
        this.deadline = deadline;
        this.timeoutMs = timeoutMs;
        this.timeoutLabel = timeoutLabel;
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
        if (this.elementsRead > CONFIG.demux.maxEbmlElements) {
          throw fail(
            'EbmlElementLimitError',
            'ERR_DEMUX_EBML_LIMIT',
            `The Matroska scan exceeded ${CONFIG.demux.maxEbmlElements} elements.`,
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
      try {
        return decoder.decode(await reader.bytes(element.dataOffset, element.dataSize)).replace(/\0+$/, '');
      } catch (error) {
        throw fail('MalformedSubtitleTextError', 'ERR_DEMUX_SUBTITLE_UTF8', 'Subtitle metadata is not valid UTF-8.', error);
      }
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
          default: break;
        }
      });
      if (entry.type !== 17 || !TEXT_CODECS.has(entry.codecId)) return null;
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
      await children(reader, element, async child => {
        if (child.id !== ID.TRACK_ENTRY) return;
        const track = await parseTrackEntry(reader, child);
        if (track) tracks.push(track);
      });
      return tracks;
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
        if ([ID.INFO, ID.TRACKS, ID.CHAPTERS].includes(element.id)) found.set(element.id, element);
        offset = requireKnown(element, 'A top-level Matroska element');
      }

      for (const id of [ID.INFO, ID.TRACKS, ID.CHAPTERS]) {
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
      const tracks = found.has(ID.TRACKS) ? await parseTracks(reader, found.get(ID.TRACKS)) : [];
      const chapters = found.has(ID.CHAPTERS) ? await parseChapters(reader, found.get(ID.CHAPTERS)) : [];
      return { file, segment, timestampScale, tracks, chapters, cueCache: new Map() };
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
      let text;
      try {
        text = decoder.decode(await reader.bytes(payloadOffset, payloadSize)).replace(/\0+$/, '');
      } catch (error) {
        throw fail('MalformedSubtitleTextError', 'ERR_DEMUX_SUBTITLE_UTF8', 'A subtitle cue is not valid UTF-8.', error);
      }
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
      return { relativeTimestamp, text, id, settings, payloadSize };
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
        id: block.id,
        settings: block.settings,
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

    function normalizeCueDurations(cues, mediaDuration) {
      cues.sort((left, right) => left.startS - right.startS);
      for (let index = 0; index < cues.length; index += 1) {
        const cue = cues[index];
        if (cue.endS === null) {
          const nextStart = cues[index + 1]?.startS;
          cue.endS = Number.isFinite(nextStart) ? nextStart : Math.max(cue.startS, mediaDuration);
        }
        cue.startS = Math.max(0, cue.startS);
        cue.endS = Math.max(cue.startS, cue.endS);
      }
      return cues;
    }

    async function readCues(state, track, mediaDuration) {
      const reader = new Reader(state.file, {
        deadline: performance.now() + CONFIG.demux.subtitleScanTimeoutMs,
        timeoutMs: CONFIG.demux.subtitleScanTimeoutMs,
        timeoutLabel: 'Subtitle extraction',
      });
      const scan = { cues: [], textBytes: 0 };
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
      return normalizeCueDurations(scan.cues, mediaDuration);
    }

    function descriptor(track, sessionId, duration) {
      const codec = TEXT_CODECS.get(track.codecId);
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
      };
    }

    async function inspect(file, sessionId, duration) {
      const state = await metadata(file);
      const descriptors = state.tracks.map(track => descriptor(track, sessionId, duration));
      const trackById = new Map(descriptors.map((item, index) => [item.id, state.tracks[index]]));
      return { state, descriptors, trackById, chapters: state.chapters };
    }

    function cues(state, track, mediaDuration) {
      if (!state.cueCache.has(track.number)) {
        state.cueCache.set(track.number, readCues(state, track, mediaDuration));
      }
      return state.cueCache.get(track.number);
    }

    return { inspect, cues };
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

    let file = handle;
    if (handle && typeof handle.getFile === 'function') file = await handle.getFile();
    if (!(file instanceof Blob)) {
      throw fail(
        'InvalidMediaHandleError',
        'ERR_DEMUX_HANDLE',
        'Expected a File, Blob, or file handle.',
      );
    }
    if (file.size === 0) {
      throw fail('EmptyMediaError', 'ERR_DEMUX_EMPTY', 'The selected file is empty.');
    }
    const name = file.name || 'untitled';
    const signature = new Uint8Array(await file.slice(0, ASF_SIGNATURE.byteLength).arrayBuffer());
    refuseDetectedFormat(signature);
    return {
      source: new BlobSource(file),
      name,
      size: file.size,
      file,
    };
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
    const nativeById = new Map(nativeDescriptors.map((track, index) => [track.id, nativeTracks[index]]));
    const textInspection = sourceInfo.file && ['mkv', 'webm'].includes(container)
      ? await MatroskaText.inspect(sourceInfo.file, sessionId, duration)
      : null;
    const tracks = nativeDescriptors.concat(textInspection?.descriptors || []);
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
        duration,
        tracks,
        chapters: textInspection?.chapters || [],
      },
      nativeById,
      textInspection,
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
        duration: inspected.result.duration,
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
    if (previous) previous.input.dispose();
    return candidate.result;
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
          const packet = step.value;
          if (!Number.isFinite(packet.timestamp) || !Number.isFinite(packet.duration)) {
            throw fail('MalformedPacketError', 'ERR_DEMUX_PACKET_TIME', 'A packet has invalid timing metadata.');
          }
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
      const cues = await MatroskaText.cues(active.textInspection.state, textTrack, active.duration);
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
      iterator = new AudioSampleSink(nativeTrack).samples(fromS)[Symbol.asyncIterator]();
      while (true) {
        const step = await withTimeout(iterator.next(), 'Software audio decode', { timeoutMs });
        if (step.done) break;
        yield step.value;
      }
    } catch (error) {
      throw wrapFailure(error, `Software decode of audio track ${track.number} failed.`);
    } finally {
      if (iterator) Promise.resolve(iterator.return?.()).catch(() => {});
    }
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

    async function consent(item) {
      const threshold = CONFIG.askDownloadOverBytes ?? 5 * 1024 * 1024;
      if (item.bytes <= threshold) return true;
      // Read at call time: the host may install the hook after creating the engine.
      const request = CONFIG.requestDownload;
      if (typeof request !== 'function') return false;
      return (await request({ name: item.name, bytes: item.bytes, licence: item.licence })) === true;
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
    if (active) active.input.dispose();
    active = null;
  }

  return {
    prepare,
    activate,
    discard,
    probe,
    packets,
    audioSamples,
    canDecodeAudio,
    softwareAudio: SoftwareAudio,
    subtitleCues,
    close,
    vendorVersion: MEDIABUNNY_VERSION,
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

  /* The software audio route paces Mediabunny's decoded samples the way stream()
     paces WebCodecs packets. Sample timestamps are in seconds. */
  async function streamSoftwareAudio(track, fromS, onOutput, options = {}) {
    const shouldContinue = options.shouldContinue || (() => true);
    const currentTimeS = options.currentTimeS || (() => fromS);
    const decodeAheadS = Number.isFinite(options.decodeAheadS) ? Math.max(0, options.decodeAheadS) : 0.5;
    let sampleCount = 0;
    try {
      for await (const sample of Demux.audioSamples(track, fromS)) {
        while (sample.timestamp > currentTimeS() + decodeAheadS && shouldContinue()) {
          await new Promise(resolve => setTimeout(resolve, 4));
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

  function streamAudio(track, route, fromS, onOutput, options = {}) {
    if (route === 'software') return streamSoftwareAudio(track, fromS, onOutput, options);
    return stream(track, fromS, onOutput, options);
  }

  /**
   * Decode video from the key frame at or before `fromS` until a packet reaches
   * `stopUs`, and keep the one frame `better(candidate, best)` prefers. The caller
   * owns the returned VideoFrame; every other frame is closed here.
   */
  async function pickFrame(track, fromS, stopUs, better) {
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
        if (packet.timestamp >= stopUs) break;
        if (packetCount >= CONFIG.decode.maxPacketsPerSample) {
          throw fail(
            'DecodePacketLimitError',
            'ERR_DECODE_PACKET_LIMIT',
            `A frame step exceeded ${CONFIG.decode.maxPacketsPerSample} packets.`,
          );
        }
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
        while (packetTimeS > currentTimeS() + decodeAheadS && shouldContinue()) {
          await new Promise(resolve => setTimeout(resolve, 4));
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
    this.silenceFrames = 0;
    this.phase = 0;
    this.rate = 1;
    this.sourceRate = sampleRate;
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
      this.silenceFrames = Math.max(0, message.leadFrames | 0);
      this.phase = 0;
      this.rate = message.rate || 1;
      this.sourceRate = message.sourceRate || sampleRate;
      this.playing = false;
      this.report();
      return;
    }
    if (message.type === 'enqueue') {
      this.enqueue(message.planes || []);
      return;
    }
    if (message.type === 'play') this.playing = true;
    if (message.type === 'pause') this.playing = false;
    if (message.type === 'rate') this.rate = message.rate || 1;
    this.report();
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
    this.droppedFrames += frameCount - writable;
    this.report();
  }

  report() {
    this.port.postMessage({
      type: 'state',
      availableFrames: this.availableFrames,
      consumedFrames: this.consumedFrames,
      droppedFrames: this.droppedFrames,
      underrunFrames: this.underrunFrames,
      silenceFrames: this.silenceFrames,
      playing: this.playing,
    });
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

    const step = (this.sourceRate / sampleRate) * this.rate;
    for (let outputFrame = 0; outputFrame < output[0].length; outputFrame += 1) {
      if (this.silenceFrames > 0) {
        // Lead silence for a positive audio delay: counts as consumed source time.
        this.phase += step;
        const requested = Math.floor(this.phase);
        if (requested > 0) {
          const consumed = Math.min(requested, this.silenceFrames);
          this.silenceFrames -= consumed;
          this.phase -= consumed;
          this.consumedFrames += consumed;
        }
        continue;
      }
      if (this.availableFrames <= 0) {
        this.underrunFrames += 1;
        this.phase = 0;
        continue;
      }
      const nextIndex = this.availableFrames > 1
        ? (this.readIndex + 1) % this.capacity
        : this.readIndex;
      for (let channel = 0; channel < output.length; channel += 1) {
        const source = this.channels[Math.min(channel, this.channels.length - 1)];
        const first = source[this.readIndex];
        output[channel][outputFrame] = first + (source[nextIndex] - first) * this.phase;
      }
      this.phase += step;
      const requested = Math.floor(this.phase);
      if (requested > 0) {
        const consumed = Math.min(requested, this.availableFrames);
        this.phase -= consumed;
        this.readIndex = (this.readIndex + consumed) % this.capacity;
        this.availableFrames -= consumed;
        this.consumedFrames += consumed;
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
  let active = false;
  let stateAtContextS = 0;
  let prepareCount = 0;
  let route = null;
  let downmix = false;
  let drainedAt = null;
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
    lastError = error instanceof PlaybackError
      ? error
      : fail('AudioPlaybackError', 'ERR_AUDIO_PLAYBACK', 'Decoded audio playback failed.', error);
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
     numberOfChannels, numberOfFrames, copyTo(f32-planar) and close(). */
  function copyAudioData(audioData, localNode) {
    let planes = [];
    for (let channel = 0; channel < audioData.numberOfChannels; channel += 1) {
      const plane = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(plane, { planeIndex: channel, format: 'f32-planar' });
      planes.push(plane);
    }
    audioData.close();
    if (downmix && planes.length > 2) planes = stereoFold(planes);
    if (!planes.length || !planes[0].length) return true;
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
    };
    localNode.port.postMessage({
      type: 'configure',
      channels,
      sourceRate,
      rate,
      capacityFrames: Math.ceil(sourceRate * CONFIG.sync.audioRingSeconds),
      leadFrames,
    });

    decoderActive = true;
    const task = Decode.streamAudio(track, route, decodeFromS, audioData => copyAudioData(audioData, localNode), {
      shouldContinue: () => localSession === session && shouldContinue(),
      currentTimeS: current,
      decodeAheadS: CONFIG.sync.audioRingSeconds * 0.75,
    });
    decoderTask = task;
    task.catch(error => setFailure(error, localSession)).finally(() => {
      if (localSession === session) decoderActive = false;
      if (decoderTask === task) decoderTask = null;
    });

    const prebufferFrames = Math.min(Math.ceil(sourceRate * 0.08), Math.ceil(sourceRate * CONFIG.sync.audioRingSeconds));
    const deadline = performance.now() + 5_000;
    while (stats.bufferedFrames < prebufferFrames && decoderActive && !lastError && performance.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    if (lastError) {
      const error = lastError;
      stopNode();
      throw error;
    }
    if (stats.bufferedFrames === 0) {
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

  function setVolume(volume, muted = false) {
    if (gain && context) gain.gain.setValueAtTime(muted ? 0 : volume, context.currentTime);
  }

  function state() {
    return {
      active,
      contextState: context?.state || 'uninitialized',
      sourceRate,
      rate,
      route,
      downmix,
      prepareCount,
      ...stats,
      decoderActive,
      lastError: lastError ? { name: lastError.name, code: lastError.code, message: lastError.message } : null,
    };
  }

  /** The final gain stage and its context, for a host that wants to tap them. */
  function audioGraph() {
    return context && gain ? { context, output: gain } : null;
  }

  return { unlock, prepare, play, stop, current, setRate, setVolume, state, audioGraph };
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
    const crop = view.crop === 'none' || !view.crop
      ? { top: 0, right: 0, bottom: 0, left: 0 }
      : view.crop;
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
    };
  }

  function attach(canvas) {
    if (!canvas || typeof canvas.getContext !== 'function') {
      throw new TypeError('Renderer.attach requires a canvas.');
    }
    const context = canvas.getContext('2d', { alpha: false, desynchronized: true });
    if (!context) throw new Error('The browser could not create a 2D rendering context.');

    const queue = [];
    let animationFrame = 0;
    let clock = null;
    let renderedFrames = 0;
    let droppedFrames = 0;
    let lastTimestamp = null;
    // The frame on screen stays open so a view change can redraw it while paused.
    let shownFrame = null;
    let view = { rotation: 0, aspect: 'auto', crop: 'none' };
    let output = { width: null, height: null };

    function closeQueue() {
      while (queue.length) queue.shift().close();
    }
    function paint(frame) {
      const g = geometry(frame.displayWidth, frame.displayHeight, view);
      if (canvas.width !== g.outputWidth || canvas.height !== g.outputHeight) {
        canvas.width = g.outputWidth;
        canvas.height = g.outputHeight;
      }
      output = { width: g.outputWidth, height: g.outputHeight };
      if (g.radians === 0) {
        context.drawImage(frame, g.sx, g.sy, g.sw, g.sh, 0, 0, g.drawWidth, g.drawHeight);
        return;
      }
      context.save();
      context.translate(g.outputWidth / 2, g.outputHeight / 2);
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
    function enqueue(frame, currentTimeS = 0, { key = false } = {}) {
      if (!(frame instanceof VideoFrame)) return false;
      const lateByUs = Math.round(currentTimeS * 1_000_000) - frame.timestamp;
      if (lateByUs > CONFIG.sync.videoDropGraceMs * 1000 && !key) {
        droppedFrames += 1;
        return false;
      }
      queue.push(frame);
      return true;
    }
    /** Draw one frame now (frame step). The renderer takes ownership. */
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
      if (!animationFrame) animationFrame = requestAnimationFrame(tick);
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
      context.clearRect(0, 0, canvas.width, canvas.height);
      lastTimestamp = null;
    }
    function snapshot() {
      return canvas.toDataURL('image/png');
    }
    function stats() {
      return { renderedFrames, droppedFrames, queuedFrames: queue.length, lastTimestamp };
    }
    function outputSize() {
      return { ...output };
    }
    function destroy() {
      stop();
      clear();
      clock = null;
    }
    return { enqueue, show, setView, start, stop, clear, snapshot, stats, outputSize, destroy };
  }
  return { attach, geometry };
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
  let view = { aspect: 'auto', crop: 'none' };
  const MAX_AUDIO_DELAY_S = 10;
  const MAX_CROP = 0.45;

  store.clock.audioDelayS ??= 0;
  store.clock.loop ??= null;

  function publish() {
    store.clock.positionS = clock.current();
    store.clock.playing = clock.playing;
    store.clock.rate = clock.rate;
  }
  function stopMonitor() {
    if (monitorFrame) cancelAnimationFrame(monitorFrame);
    monitorFrame = 0;
  }
  function monitor() {
    monitorFrame = 0;
    publish();
    if (!clock.playing) return;
    const now = clock.current();
    const loop = store.clock.loop;
    if (loop && now >= loop.bS) {
      if (!loopWrapping) {
        loopWrapping = true;
        seek(loop.aS)
          .catch(error => { lastError = error; })
          .finally(() => { loopWrapping = false; });
      }
      return;
    }
    if (Number.isFinite(clock.duration) && now >= clock.duration) {
      pause();
      clock.seek(clock.duration);
      publish();
      emit('playback:ended', { positionS: clock.current() });
      return;
    }
    monitorFrame = requestAnimationFrame(monitor);
  }
  function selectedVideoTrack() {
    return store.tracks.video[store.tracks.selected.video ?? 0] || null;
  }
  function applyRotation() {
    renderer?.setView({ ...view, rotation: selectedVideoTrack()?.rotation || 0 });
  }
  function load(nextMetadata) {
    generation += 1;
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
    applyRotation();
    publish();
    emit('playback:loaded', {
      name: nextMetadata?.name || null,
      duration: nextMetadata?.duration ?? null,
    });
  }
  function attach(canvas) {
    renderer?.destroy();
    renderer = Renderer.attach(canvas);
    applyRotation();
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
  async function beginPlay() {
    if (!metadata) throw new Error('Load media before playback.');
    if (clock.playing) return;
    const localGeneration = ++generation;
    const videoTrack = selectedVideoTrack();
    const audioTrack = store.tracks.audio[store.tracks.selected.audio ?? 0];
    if (!videoTrack && !audioTrack) throw new Error('The selected media has no playable audio or video track.');
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
      } catch (error) {
        if (localGeneration !== generation) return;
        throw error;
      }
      if (localGeneration !== generation) return;
      clock.bind(audioMaster());
      AudioOutput.play();
    } else {
      clock.bind(null);
    }
    clock.play();
    renderer?.start(clock);
    publish();
    emit('playback:play', { positionS: clock.current(), rate: clock.rate });
    if (!monitorFrame) monitorFrame = requestAnimationFrame(monitor);

    if (!videoTrack) {
      streamTask = null;
      return;
    }
    const task = Decode.stream(
      videoTrack,
      clock.current(),
      (frame, frameInfo) => renderer.enqueue(frame, clock.current(), frameInfo),
      {
      shouldContinue: () => localGeneration === generation && clock.playing,
      currentTimeS: () => clock.current(),
      decodeAheadS: CONFIG.sync.decodeAheadMs / 1000,
      },
    );
    streamTask = task;
    task.catch(error => {
      if (localGeneration !== generation) return;
      lastError = error;
      pause();
    }).finally(() => {
      if (streamTask === task) streamTask = null;
    });
  }
  function play() {
    if (clock.playing) return Promise.resolve();
    if (playTask) return playTask;
    const task = beginPlay();
    playTask = task;
    return task.finally(() => {
      if (playTask === task) playTask = null;
    });
  }
  function pause() {
    generation += 1;
    clock.pause();
    AudioOutput.stop();
    clock.bind(null);
    renderer?.stop();
    stopMonitor();
    publish();
    emit('playback:pause', { positionS: clock.current() });
  }
  async function seek(positionS) {
    if (!metadata) throw new Error('Load media before seeking.');
    if (!Number.isFinite(positionS)) throw new TypeError('Seek time must be finite.');
    const wasPlaying = clock.playing;
    pause();
    clock.seek(positionS);
    renderer?.clear();
    publish();
    if (wasPlaying) await play();
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
    if (!metadata || !videoTrack || !renderer || clock.playing) return false;
    const localGeneration = generation;
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
    if (!clock.playing) return;
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
    view = updated;
    applyRotation();
    const current = viewState();
    emit('playback:view', current);
    return current;
  }
  function viewState() {
    const output = renderer?.outputSize() || { width: null, height: null };
    return {
      aspect: view.aspect,
      crop: view.crop === 'none' ? 'none' : { ...view.crop },
      rotation: selectedVideoTrack()?.rotation || 0,
      width: output.width,
      height: output.height,
    };
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
    if (!renderer) throw new Error('Attach a renderer before stepping frames.');
    const localGeneration = ++generation;
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
  function setVolume(volume) {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      throw new RangeError('Volume must be between 0 and 1.');
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
    };
  }
  function snapshot() {
    if (!renderer) throw new Error('Attach a renderer before taking a snapshot.');
    return renderer.snapshot();
  }
  function audioGraph() {
    return AudioOutput.audioGraph();
  }

  return {
    load,
    attach,
    play,
    pause,
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
    state,
    snapshot,
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
async function subtitleCueList(trackIndex) {
  const track = subtitleTrackAt(trackIndex);
  const cues = [];
  for await (const cue of Demux.subtitleCues(track)) {
    cues.push({ startS: cue.startS, endS: cue.endS, text: cue.text });
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

const Engine = {
  version: CONFIG.version,
  /** Lowercase extensions the engine opens; each passes the golden gate. */
  supportedExtensions: [...SUPPORTED_EXTENSIONS],
  caps() {
    const navigatorApi = globalThis.navigator || {};
    const videoDecoder = 'VideoDecoder' in globalThis;
    const audioDecoder = 'AudioDecoder' in globalThis;
    return {
      webCodecs: videoDecoder && audioDecoder,
      videoDecoder,
      audioDecoder,
      // The canvas path runs with VideoDecoder alone: audio then goes through the
      // software rung where it covers the codec, or is refused by name.
      enginePlayback: videoDecoder && 'AudioWorkletNode' in globalThis,
      softwareAudio: Demux.softwareAudio.state(),
      fsa: 'showOpenFilePicker' in globalThis,
      opfs: !!(navigatorApi.storage && navigatorApi.storage.getDirectory),
      webgpu: 'gpu' in navigatorApi,
    };
  },
  async probe(handle) { return Demux.probe(handle); },
  async load(handle) {
    const loadId = ++latestLoadId;
    const candidate = await Demux.prepare(handle);
    let fingerprint = null;
    let nextFingerprintError = null;
    try {
      const file = handle instanceof Blob
        ? handle
        : handle && typeof handle.getFile === 'function' ? await handle.getFile() : null;
      if (file) fingerprint = await Storage.fingerprint(file);
    } catch (error) {
      nextFingerprintError = error;
    }
    if (loadId !== latestLoadId) {
      Demux.discard(candidate);
      throw new PlaybackError(
        'SupersededLoadError',
        'ERR_ENGINE_LOAD_SUPERSEDED',
        'A newer media load replaced this request.',
      );
    }
    fingerprintError = nextFingerprintError;
    const metadata = Demux.activate(candidate);
    store.media = {
      handle,
      name: metadata.name,
      fingerprint,
      duration: metadata.duration,
      size: metadata.size,
      container: metadata.container,
      mimeType: metadata.mimeType,
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
  attach(canvas) { Playback.attach(canvas); },
  play() { return Playback.play(); },
  pause() { Playback.pause(); },
  seek(s) { return Playback.seek(s); },
  setRate(rate) { Playback.setRate(rate); },
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
  subtitles: { export: exportSubtitles, cues: subtitleCueList },
  _internals: { Storage, Demux, Decode, AudioOutput, Clock, Renderer, Playback, CONFIG }, // for the harness
};

  return Engine;
}
