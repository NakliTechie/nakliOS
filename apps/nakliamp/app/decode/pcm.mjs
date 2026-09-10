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

/** Deinterleave into one Float32Array per channel. */
function toChannels(view, dataOffset, dataLength, format) {
  // Before anything is allocated or any loop is entered.
  if (!Number.isInteger(format.channels) || format.channels < 1 || format.channels > MAX_CHANNELS) {
    throw encodingError(
      'ERR_NAKLIAMP_PCM_MALFORMED',
      `This file declares ${format.channels} channels; 1 to ${MAX_CHANNELS} is readable.`,
    );
  }
  if (!Number.isFinite(format.sampleRate) || format.sampleRate <= 0) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This file declares an impossible sample rate.');
  }

  const read = sampleReader(format);
  const bytesPerSample = Math.ceil(format.bits / 8);
  if (!(bytesPerSample >= 1)) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', `This file declares ${format.bits}-bit samples.`);
  }
  const stride = bytesPerSample * format.channels;
  // `dataLength` is declared, so it is clamped to what the file actually holds:
  // this is the bound that keeps the allocation below proportional to the file.
  const available = Math.min(dataLength, view.byteLength - dataOffset);
  const frames = Math.max(0, Math.floor(available / stride));

  const channels = Array.from({ length: format.channels }, () => new Float32Array(frames));
  for (let frame = 0; frame < frames; frame += 1) {
    const base = dataOffset + frame * stride;
    for (let channel = 0; channel < format.channels; channel += 1) {
      channels[channel][frame] = read(view, base + channel * bytesPerSample);
    }
  }
  return { channels, frames };
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

function decodeAiff(view) {
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
      requireBytes(view, body, 18, 'a COMM chunk');
      const channels = view.getUint16(body);
      declaredFrames = view.getUint32(body + 2);
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
      format = {
        channels, sampleRate, bits, signed: true, littleEndian: false,
        float: false, companding: null, ...variant,
      };
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

  const { channels, frames } = toChannels(view, dataOffset, dataLength, format);
  return { sampleRate: format.sampleRate, channels, frames: Math.min(frames, declaredFrames || frames), container: isAifc ? 'aifc' : 'aiff' };
}

// --------------------------------------------------------------- CAF ----

function decodeCaf(view) {
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
      dataLength = size === -1 ? view.byteLength - dataOffset : size - 4;
    }

    if (size === -1) break;
    cursor = body + size;
  }

  if (!format) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This CAF file has no description chunk.');
  if (!dataLength) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This CAF file has no audio data.');

  const { channels, frames } = toChannels(view, dataOffset, dataLength, format);
  return { sampleRate: format.sampleRate, channels, frames, container: 'caf' };
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

function decodeAu(view) {
  // The AU header is 24 bytes; sniffing only proved the first 12 exist.
  requireBytes(view, 0, 24, 'an AU header');
  const dataOffset = view.getUint32(4);
  const declaredLength = view.getUint32(8);
  const encoding = view.getUint32(12);
  const sampleRate = view.getUint32(16);
  const channels = view.getUint32(20);

  const variant = AU_ENCODINGS.get(encoding);
  if (!variant) throw encodingError('ERR_NAKLIAMP_PCM_UNSUPPORTED', `AU encoding ${encoding} is not supported.`);
  if (dataOffset < 24 || dataOffset > view.byteLength) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This AU file has an impossible data offset.');
  }

  const format = {
    // No `channels || 1` fallback: a header declaring 0 channels is malformed,
    // and inventing a mono layout for it hides that from the person listening.
    channels, sampleRate, signed: false, littleEndian: false,
    float: false, companding: null, ...variant,
  };
  // 0xFFFFFFFF means the writer did not know the length.
  const dataLength = declaredLength === 0xffffffff ? view.byteLength - dataOffset : declaredLength;

  const { channels: decoded, frames } = toChannels(view, dataOffset, dataLength, format);
  return { sampleRate, channels: decoded, frames, container: 'au' };
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
export function decodePcm(bytes) {
  const view = new DataView(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength ?? bytes.length);
  const container = sniffPcm(bytes);
  if (!container) throw encodingError('ERR_NAKLIAMP_PCM_UNKNOWN', 'This file is not a PCM container NakliAmp reads.');

  const decoded = container === 'caf' ? decodeCaf(view) : container === 'au' ? decodeAu(view) : decodeAiff(view);
  if (!decoded.frames) throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This file decoded to no audio.');
  // `> 0` alone lets Infinity through, and an infinite rate makes duration 0.
  if (!Number.isFinite(decoded.sampleRate) || decoded.sampleRate <= 0) {
    throw encodingError('ERR_NAKLIAMP_PCM_MALFORMED', 'This file declares no usable sample rate.');
  }

  return {
    ...decoded,
    durationS: decoded.frames / decoded.sampleRate,
    channelCount: decoded.channels.length,
  };
}
