// R3 software decode, in-house tier: uncompressed PCM containers.
//
// Chrome decodes none of AIFF, AIFC, CAF, or AU — verified against real files
// through both `<audio>.canPlayType` and `decodeAudioData`. They are not exotic:
// AIFF is what a Mac rips to, CAF is what Logic and QuickTime write, AU is what
// decades of Unix audio is stored in. They are also *uncompressed*, so closing
// this gap needs a header parser and a sample converter, not a codec.
//
// That is why this tier exists separately from the wasm tier: it costs about
// three hundred lines and no download, so it ships in the lean build. The
// compressed long tail — WMA, APE, WavPack, Musepack, DSD — needs a real
// decoder and belongs in the full build.
//
// Headless by contract: no DOM, no network, no Web Audio. Returns plain arrays
// so the caller decides what to build from them.
//
// Size (review finding N20): a whole decode holds the file plus four bytes of
// Float32 per sample. A one-hour CD-quality AIFF is 635 MB in and about
// 1.27 GB out, before the caller copies it into an AudioBuffer. So files above
// PCM_STREAM_MIN_BYTES play streamed (`streamPcm`, half a second per read,
// never read whole), and `decodePcm` refuses, from the header and before any
// allocation, a decode larger than PCM_MAX_DECODED_BYTES.

const encodingError = (code, message) => {
  const error = new Error(message);
  error.name = 'PcmDecodeError';
  error.code = code;
  return error;
};

/**
 * Hard limits on anything a file gets to declare.
 *
 * Every field below is read straight out of a header, so every one of them is
 * attacker-controlled. A channel count of 0 makes the frame stride 0 and the
 * decode loop runs forever on the main thread; a channel count of 4 billion
 * asks for that many Float32Arrays before a single sample is read. Neither is
 * a decode failure the caller can catch — the first hangs the tab and the
 * second kills it — so both are rejected as malformed before any allocation.
 */
const MAX_CHANNELS = 64;

/**
 * Sample rates an AudioBuffer accepts in Chrome, Firefox and Safari. A header
 * outside this range decodes to samples nothing can play (review finding N40).
 */
export const PCM_MIN_RATE = 3000;
export const PCM_MAX_RATE = 768000;

/** Files above this size play streamed; the same bound the libav tier uses. */
export const PCM_STREAM_MIN_BYTES = 64 * 1024 * 1024;

/** The largest whole decode, in bytes of Float32 output. */
export const PCM_MAX_DECODED_BYTES = 512 * 1024 * 1024;

/** Seconds of PCM one streamed `read()` returns. */
const STREAM_CHUNK_S = 0.5;

/** Head bytes read to find the format and the data chunk; grown up to the cap when chunks before the audio are large. */
const STREAM_HEAD_BYTES = 256 * 1024;
const STREAM_HEAD_MAX_BYTES = 16 * 1024 * 1024;

/** True when `length` bytes actually exist at `offset`. */
function has(view, offset, length) {
  return offset >= 0 && length >= 0 && offset + length <= view.byteLength;
}

/**
 * Every chunk header states a size. That size is a claim about the file, not a
 * fact about the bytes present, and a truncated or hostile file makes the two
 * disagree. Reading on the claim alone throws a raw `RangeError` out of
 * DataView, which is not the named refusal this module promises.
 */
function requireBytes(view, offset, length, what) {
  if (!has(view, offset, length)) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', `This file claims ${what} that runs past the end of the file.`);
  }
}

function ascii(view, offset, length) {
  let out = '';
  for (let index = 0; index < length; index += 1) out += String.fromCharCode(view.getUint8(offset + index));
  return out;
}

/**
 * AIFF stores its sample rate as an 80-bit IEEE 754 extended float, a format
 * no JavaScript number type maps to, so it is decoded by hand.
 */
function extendedFloat(view, offset) {
  const exponent = view.getUint16(offset);
  const high = view.getUint32(offset + 2);
  const low = view.getUint32(offset + 6);
  const sign = exponent & 0x8000 ? -1 : 1;
  const unbiased = (exponent & 0x7fff) - 16383;
  if (unbiased === -16383 && high === 0 && low === 0) return 0;
  return sign * (high * 2 ** (unbiased - 31) + low * 2 ** (unbiased - 63));
}

// ------------------------------------------------------ sample readers ----

const MULAW = new Int16Array(256);
const ALAW = new Int16Array(256);
for (let byte = 0; byte < 256; byte += 1) {
  // G.711 mu-law: invert, then expand the sign, exponent and mantissa fields.
  const muInverted = ~byte & 0xff;
  const muMantissa = muInverted & 0x0f;
  const muExponent = (muInverted >> 4) & 0x07;
  let muValue = ((muMantissa << 3) + 0x84) << muExponent;
  muValue -= 0x84;
  MULAW[byte] = (muInverted & 0x80) ? -muValue : muValue;

  // G.711 A-law: the even bits are inverted on the wire.
  const aInverted = byte ^ 0x55;
  const aMantissa = aInverted & 0x0f;
  const aExponent = (aInverted >> 4) & 0x07;
  let aValue = aExponent === 0 ? (aMantissa << 4) + 8 : ((aMantissa << 4) + 0x108) << (aExponent - 1);
  ALAW[byte] = (aInverted & 0x80) ? aValue : -aValue;
}

/** Build a reader that turns one sample at `offset` into a float in [-1, 1]. */
function sampleReader(format) {
  const { bits, float, signed, littleEndian, companding } = format;
  if (companding === 'mulaw') return (view, offset) => MULAW[view.getUint8(offset)] / 32768;
  if (companding === 'alaw') return (view, offset) => ALAW[view.getUint8(offset)] / 32768;
  if (float) {
    if (bits === 32) return (view, offset) => view.getFloat32(offset, littleEndian);
    if (bits === 64) return (view, offset) => view.getFloat64(offset, littleEndian);
    throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `${bits}-bit float audio is not supported.`);
  }
  switch (bits) {
    case 8:
      return signed
        ? (view, offset) => view.getInt8(offset) / 128
        : (view, offset) => (view.getUint8(offset) - 128) / 128;
    case 16:
      return (view, offset) => view.getInt16(offset, littleEndian) / 32768;
    case 24:
      return (view, offset) => {
        const a = view.getUint8(offset);
        const b = view.getUint8(offset + 1);
        const c = view.getUint8(offset + 2);
        const raw = littleEndian ? (c << 16) | (b << 8) | a : (a << 16) | (b << 8) | c;
        // Sign-extend from 24 bits before scaling.
        return ((raw << 8) >> 8) / 8388608;
      };
    case 32:
      return (view, offset) => view.getInt32(offset, littleEndian) / 2147483648;
    default:
      throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `${bits}-bit audio is not supported.`);
  }
}

/**
 * Check a format before anything is allocated or any loop is entered, and
 * return the sample reader and frame stride for it.
 */
function readerFor(format) {
  if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > MAX_CHANNELS) {
    throw encodingError(
      'ERR_NAKLIAMP_PCM_MALFORMED',
      `This file declares ${format.channels} channels; 1 to ${MAX_CHANNELS} is readable.`,
    );
  }
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This file declares an impossible sample rate.');
  }
  if (format.sampleRate < PCM_MIN_RATE || format.sampleRate > PCM_MAX_RATE) {
    throw encodingError(
      'ERR_NAKLIAMP_PCM_UNSUPPORTED',
      `This file declares a sample rate of ${format.sampleRate} Hz; ${PCM_MIN_RATE} to ${PCM_MAX_RATE} Hz is playable.`,
    );
  }

  const read = sampleReader(format);
  const bytesPerSample = Math.ceil(format.bits / 8);
  if (!(bytesPerSample >= 1)) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', `This file declares ${format.bits}-bit samples.`);
  }
  return { read, bytesPerSample, stride: bytesPerSample * format.channels };
}

/** Deinterleave `frames` frames starting at `dataOffset` into one Float32Array per channel. */
function deinterleave(view, dataOffset, frames, format, { read, bytesPerSample, stride }) {
  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataOffset + frame * stride;
    for (let channel = 0; channel < format.channels; channel += 1) {
      channels[channel][frame] = read(view, base + channel * bytesPerSample);
    }
  }
  return channels;
}

/**
 * Frames a layout holds: the declared data length clamped to the bytes that
 * exist (`totalBytes`), then to the declared frame count when there is one.
 * This is the bound that keeps every allocation proportional to the file.
 */
function layoutFrames(layout, stride, totalBytes) {
  const available = Math.max(0, Math.min(layout.dataLength, totalBytes - layout.dataOffset));
  const frames = Math.floor(available / stride);
  return layout.maxFrames ? Math.min(frames, layout.maxFrames) : frames;
}

// -------------------------------------------------------------- AIFF ----

/** AIFC compression types this tier understands. AIFF proper is big-endian PCM. */
const AIFC_FORMATS = new Map([
  ['NONE', {}],
  ['sowt', { littleEndian: true }],
  ['twos', {}],
  ['fl32', { float: true, bits: 32 }],
  ['FL32', { float: true, bits: 32 }],
  ['fl64', { float: true, bits: 64 }],
  ['ulaw', { companding: 'mulaw', bits: 8 }],
  ['ULAW', { companding: 'mulaw', bits: 8 }],
  ['alaw', { companding: 'alaw', bits: 8 }],
  ['ALAW', { companding: 'alaw', bits: 8 }],
]);

/** Read an AIFF or AIFC COMM chunk into a PCM format and its declared frame count. */
function parseAiffComm(view, body, size, isAifc) {
  requireBytes(view, body, 18, 'a COMM chunk');
  const channels = view.getUint16(body);
  const declaredFrames = view.getUint32(body + 2);
  const bits = view.getUint16(body + 6);
  const sampleRate = extendedFloat(view, body + 8);
  let variant = {};
  if (isAifc && size >= 22) {
    requireBytes(view, body + 18, 4, 'an AIFC compression type');
    const compression = ascii(view, body + 18, 4);
    variant = AIFC_FORMATS.get(compression);
    if (!variant) {
      throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `AIFC compression ${compression} is not supported.`);
    }
  }
  const format = {
    channels, sampleRate, bits, signed: true, littleEndian: false,
    float: false, companding: null, ...variant,
  };
  return { format, declaredFrames };
}

function aiffLayout(view) {
  const isAifc = ascii(view, 8, 4) === 'AIFC';
  let format = null;
  let dataOffset = 0;
  let dataLength = 0;
  let declaredFrames = 0;
  let cursor = 12;

  while (cursor + 8 <= view.byteLength) {
    const id = ascii(view, cursor, 4);
    const size = view.getUint32(cursor + 4);
    const body = cursor + 8;

    if (id === 'COMM' && size >= 18) {
      ({ format, declaredFrames } = parseAiffComm(view, body, size, isAifc));
    } else if (id === 'SSND' && size >= 8) {
      // SSND begins with an offset and a block size before the samples.
      requireBytes(view, body, 8, 'an SSND chunk');
      dataOffset = body + 8 + view.getUint32(body);
      dataLength = size - 8 - view.getUint32(body);
    }

    cursor = body + size + (size % 2); // chunks are word-aligned
  }

  if (!format) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This AIFF file has no COMM chunk.');
  if (!dataLength) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This AIFF file has no sound data.');

  return { format, dataOffset, dataLength, maxFrames: declaredFrames || 0, container: isAifc ? 'aifc' : 'aiff' };
}

// --------------------------------------------------------------- CAF ----

function cafLayout(view, totalBytes) {
  let format = null;
  let dataOffset = 0;
  let dataLength = 0;
  let cursor = 8; // 'caff' plus version and flags

  while (cursor + 12 <= view.byteLength) {
    const id = ascii(view, cursor, 4);
    // CAF chunk sizes are signed 64-bit; a size of -1 means "to end of file".
    // Only that one sentinel is honoured. Every other value is read *unsigned*:
    // a signed high word lets a file declare, say, -12, which misses the
    // sentinel and sends `cursor = body + size` back to where it started —
    // the walk below then spins forever on the main thread.
    const high = view.getUint32(cursor + 4);
    const low = view.getUint32(cursor + 8);
    const size = high === 0xffffffff && low === 0xffffffff ? -1 : high * 2 ** 32 + low;
    const body = cursor + 12;

    if (id === 'desc' && size >= 32) {
      requireBytes(view, body, 32, 'a description chunk');
      const sampleRate = view.getFloat64(body);
      const formatId = ascii(view, body + 8, 4);
      if (formatId !== 'lpcm') {
        throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `CAF format ${formatId} is not uncompressed audio.`);
      }
      const flags = view.getUint32(body + 12);
      format = {
        sampleRate,
        channels: view.getUint32(body + 24),
        bits: view.getUint32(body + 28),
        // Flag bit 0 marks float samples, bit 1 marks little-endian.
        float: (flags & 1) !== 0,
        littleEndian: (flags & 2) !== 0,
        signed: true,
        companding: null,
      };
    } else if (id === 'data') {
      // The data chunk opens with a four-byte edit count.
      dataOffset = body + 4;
      dataLength = size === -1 ? totalBytes - dataOffset : size - 4;
    }

    if (size === -1) break;
    cursor = body + size;
  }

  if (!format) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This CAF file has no description chunk.');
  if (!dataLength) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This CAF file has no audio data.');

  return { format, dataOffset, dataLength, maxFrames: 0, container: 'caf' };
}

// ---------------------------------------------------------------- AU ----

/** Sun/NeXT AU encodings this tier understands. */
const AU_ENCODINGS = new Map([
  [1, { bits: 8, companding: 'mulaw' }],
  [2, { bits: 8, signed: true }],
  [3, { bits: 16, signed: true }],
  [4, { bits: 24, signed: true }],
  [5, { bits: 32, signed: true }],
  [6, { bits: 32, float: true }],
  [7, { bits: 64, float: true }],
  [27, { bits: 8, companding: 'alaw' }],
]);

function auLayout(view, totalBytes) {
  // The AU header is 24 bytes; sniffing only proved the first 12 exist.
  requireBytes(view, 0, 24, 'an AU header');
  const dataOffset = view.getUint32(4);
  const declaredLength = view.getUint32(8);
  const encoding = view.getUint32(12);
  const sampleRate = view.getUint32(16);
  const channels = view.getUint32(20);

  const variant = AU_ENCODINGS.get(encoding);
  if (!variant) throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `AU encoding ${encoding} is not supported.`);
  if (dataOffset < 24 || dataOffset > totalBytes) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This AU file has an impossible data offset.');
  }

  const format = {
    // No `channels || 1` fallback: a header declaring 0 channels is malformed,
    // and inventing a mono layout for it hides that from the person listening.
    channels, sampleRate, signed: false, littleEndian: false,
    float: false, companding: null, ...variant,
  };
  // 0xFFFFFFFF means the writer did not know the length.
  const dataLength = declaredLength === 0xffffffff ? totalBytes - dataOffset : declaredLength;

  return { format, dataOffset, dataLength, maxFrames: 0, container: 'au' };
}

// ----------------------------------------------------------- dispatch ----

/** Containers this tier handles, for the ladder to consult before trying. */
export const PCM_CONTAINERS = Object.freeze(['aiff', 'aifc', 'caf', 'au']);

/** Sniff by magic bytes. Returns null when this tier does not apply. */
export function sniffPcm(bytes) {
  if (!bytes || bytes.length < 12) return null;
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const head = ascii(view, 0, 4);
  if (head === 'FORM') {
    const form = ascii(view, 8, 4);
    if (form === 'AIFF') return 'aiff';
    if (form === 'AIFC') return 'aifc';
    return null;
  }
  if (head === 'caff') return 'caf';
  if (head === '.snd') return 'au';
  return null;
}

/**
 * Decode a whole PCM file into per-channel Float32Arrays.
 *
 * Whole-file decode is deliberate: these containers are uncompressed, so the
 * work is a copy rather than a decode, and the caller wants one buffer anyway.
 * Throws a named error rather than returning null, so a refusal stays specific.
 */
/**
 * Where the audio is and how it is encoded, from the bytes given. `totalBytes`
 * is the whole file's size when `bytes` is only its head (streamed reads), so
 * "to end of file" lengths resolve against the file, not the head.
 */
function pcmLayout(bytes, totalBytes = bytes.byteLength ?? bytes.length) {
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const container = sniffPcm(bytes);
  if (!container) throw encodingError('ERR_NAKLIAMP_PCM_UNKNOWN', 'This file is not a PCM container NakliAmp reads.');
  const layout = container === 'caf' ? cafLayout(view, totalBytes) : container === 'au' ? auLayout(view, totalBytes) : aiffLayout(view);
  const reader = readerFor(layout.format);
  const frames = layoutFrames(layout, reader.stride, totalBytes);
  if (!frames) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This file decoded to no audio.');
  return { ...layout, view, reader, frames };
}

/** Whether a PCM file of this size plays streamed rather than decoded whole. */
export function streamsPcm(container, size) {
  return PCM_CONTAINERS.includes(container) && Number(size) > PCM_STREAM_MIN_BYTES;
}

/**
 * Decode a whole PCM file into per-channel Float32Arrays.
 *
 * `maxDecodedBytes` bounds the Float32 output; a file over it is refused from
 * its header, before anything is allocated (callers stream such files).
 */
export function decodePcm(bytes, { maxDecodedBytes = PCM_MAX_DECODED_BYTES } = {}) {
  const { format, dataOffset, view, reader, frames, container } = pcmLayout(bytes);
  const decodedBytes = frames * format.channels * 4;
  if (decodedBytes > maxDecodedBytes) {
    throw encodingError(
      'ERR_NAKLIAMP_PCM_TOO_LARGE',
      `This file decodes to ${Math.round(decodedBytes / 1024 / 1024)} MB of audio; NakliAmp decodes up to ${Math.round(maxDecodedBytes / 1024 / 1024)} MB whole and streams larger files.`,
    );
  }
  const channels = deinterleave(view, dataOffset, frames, format, reader);
  return {
    sampleRate: format.sampleRate,
    channels,
    frames,
    container,
    durationS: frames / format.sampleRate,
    channelCount: channels.length,
  };
}

/** The layout of a Blob read from its head, growing the head when large chunks sit before the audio. */
async function blobLayout(blob) {
  let headBytes = Math.min(blob.size, STREAM_HEAD_BYTES);
  for (;;) {
    const head = new Uint8Array(await blob.slice(0, headBytes).arrayBuffer());
    try {
      return pcmLayout(head, blob.size);
    } catch (error) {
      const grow = error?.code === 'ERR_NAKLIAMP_PCM_MALFORMED' && headBytes < blob.size && headBytes < STREAM_HEAD_MAX_BYTES;
      if (!grow) throw error;
      headBytes = Math.min(blob.size, STREAM_HEAD_MAX_BYTES, headBytes * 4);
    }
  }
}

/**
 * Open a PCM file for streamed decode. The file is never read whole: each
 * `read()` reads one half-second slice of the Blob and converts it.
 *
 * Returns `{ sampleRate, channelCount, durationS, container, read(), seek(s), close() }`,
 * the contract the engine's streamed software route uses (see libav-stream.mjs).
 * `read()` resolves to `{ channels: Float32Array[], frames, startS }` or null at
 * the end. Samples stay at the file's own rate; an AudioBuffer at that rate
 * plays on a context at any other.
 */
export async function streamPcm(blob, { container = null } = {}) {
  const layout = await blobLayout(blob);
  if (container && container !== layout.container) {
    throw encodingError('ERR_NAKLIAMP_PCM_UNKNOWN', `This file is ${layout.container}, not ${container}.`);
  }
  const { format, dataOffset, reader, frames } = layout;
  const rate = format.sampleRate;
  const chunkFrames = Math.max(1, Math.round(STREAM_CHUNK_S * rate));
  let cursor = 0;
  let closed = false;
  return {
    sampleRate: rate,
    channelCount: format.channels,
    durationS: frames / rate,
    container: layout.container,
    async read() {
      if (closed || cursor >= frames) return null;
      const count = Math.min(chunkFrames, frames - cursor);
      const start = dataOffset + cursor * reader.stride;
      const bytes = new Uint8Array(await blob.slice(start, start + count * reader.stride).arrayBuffer());
      if (closed) return null;
      const got = Math.floor(bytes.byteLength / reader.stride);
      if (!got) { cursor = frames; return null; }
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const startS = cursor / rate;
      cursor += got;
      return { channels: deinterleave(view, 0, got, format, reader), frames: got, startS };
    },
    async seek(seconds) {
      cursor = Math.max(0, Math.min(frames, Math.round((Number(seconds) || 0) * rate)));
    },
    async close() {
      closed = true;
    },
  };
}

/**
 * The decoder entry the engine's `softwareDecoders` list expects: whole
 * decode for files up to PCM_STREAM_MIN_BYTES, streamed above it.
 */
export const pcmDecoder = Object.freeze({
  name: 'in-house PCM',
  sniff: sniffPcm,
  decode: decodePcm,
  streams: streamsPcm,
  stream: streamPcm,
});
