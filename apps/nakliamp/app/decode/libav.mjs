// R3 software decode, wasm tier: the compressed formats no browser decodes.
//
// WMA (v1, v2, Pro, Lossless), WavPack, Monkey's Audio, Musepack (SV7 and SV8),
// TTA, DSD and Apple Lossless (ALAC in MP4/M4A), through a custom libav.js
// build carrying exactly those decoders and their demuxers, not a
// general-purpose ffmpeg. See
// VENDOR.md for the build and its LGPL terms.
//
// This tier is separate from the in-house PCM tier because it costs a download.
// The lean build ships only the PCM tier; the full build appends this one.
//
// Loading is lazy and happens once: the module is only instantiated when a file
// actually needs it, so a library of MP3s never pays for it.

import { createStreamOpener, shouldStream } from './libav-stream.mjs';

const VENDOR_DIR = '../../vendor/libav/';
const LOADER_FILE = 'libav-6.10.9.0-nakliamp.loader.mjs';
const FACTORY_FILE = 'libav-6.10.9.0-nakliamp.wasm.mjs';

/**
 * Where the vendored files live, when they live anywhere.
 *
 * Computed lazily and never at module scope. In the single-file build
 * `import.meta.url` is a blob URL, and a blob URL cannot be the base of a
 * relative `new URL(...)` — doing it at the top level threw before any app
 * code ran and killed the whole page, not just this tier. There, the loader
 * publishes blob URLs instead and these are never needed.
 */
function vendorUrls() {
  try {
    const base = new URL(VENDOR_DIR, import.meta.url);
    return { loader: new URL(LOADER_FILE, base).href, factory: new URL(FACTORY_FILE, base).href, base: base.href };
  } catch {
    return null;
  }
}

// libav reads packets up to a byte budget. There is no "read everything"
// sentinel: `-1` silently yields a single packet and therefore zero frames.
const READ_LIMIT = 256 * 1024 * 1024;

/** Containers this tier claims. Sniffed by magic bytes, never by file name. */
const SIGNATURES = [
  // ASF/WMA: the ASF header GUID.
  { container: 'wma', bytes: [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11] },
  { container: 'wavpack', bytes: [0x77, 0x76, 0x70, 0x6b] },          // 'wvpk'
  { container: 'ape', bytes: [0x4d, 0x41, 0x43, 0x20] },              // 'MAC '
  { container: 'musepack', bytes: [0x4d, 0x50, 0x43, 0x4b] },         // 'MPCK' (SV8)
  { container: 'musepack', bytes: [0x4d, 0x50, 0x2b] },               // 'MP+'  (SV7)
  { container: 'tta', bytes: [0x54, 0x54, 0x41, 0x31] },              // 'TTA1'
  { container: 'dsd', bytes: [0x44, 0x53, 0x44, 0x20] },              // 'DSD '
];

function startsWith(data, signature) {
  if (data.length < signature.length) return false;
  return signature.every((byte, index) => data[index] === byte);
}

const fourcc = (data, at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
const u32 = (data, at) => ((data[at] << 24) | (data[at + 1] << 16) | (data[at + 2] << 8) | data[at + 3]) >>> 0;

// The boxes on the path from the top of an MP4 to its sample descriptions.
const MP4_PATH = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl']);
const MP4_MAX_BOXES = 4096;

/**
 * True when an MP4/M4A carries an Apple Lossless track.
 *
 * Only ALAC is claimed, so an AAC M4A stays with the faster rungs: the engine
 * and the native element play AAC, and neither plays ALAC everywhere. The test
 * is the 'alac' sample entry inside stsd, not the 'M4A ' brand, which iTunes
 * writes for AAC and ALAC alike. The walk follows box sizes, so a moov written
 * after the media data is found too, and it is bounded by a box count.
 */
function mp4HasAlac(data) {
  if (data.length < 16 || fourcc(data, 4) !== 'ftyp') return false;
  return mp4WalkHasAlac(data, 0, data.length, { left: MP4_MAX_BOXES });
}

/** Read one box header at `at`: its size, header length and type, or null when it does not fit. */
function mp4Box(data, at, end) {
  let size = u32(data, at);
  const type = fourcc(data, at + 4);
  let header = 8;
  if (size === 1) {
    // 64-bit size; anything beyond 2^53 is not a file this tier reads.
    if (at + 16 > end) return null;
    size = u32(data, at + 8) * 2 ** 32 + u32(data, at + 12);
    header = 16;
  } else if (size === 0) {
    size = end - at;
  }
  if (size < header || at + size > end) return null;
  return { size, type, header };
}

/** True when an stsd box lists an 'alac' sample entry. */
function stsdHasAlac(data, at, box, end) {
  // Version and flags (4), entry count (4), then sample entries.
  const count = at + box.header + 8 <= end ? u32(data, at + box.header + 4) : 0;
  let entry = at + box.header + 8;
  for (let index = 0; index < count && entry + 8 <= at + box.size; index += 1) {
    if (fourcc(data, entry + 4) === 'alac') return true;
    const entrySize = u32(data, entry);
    if (entrySize < 8) break;
    entry += entrySize;
  }
  return false;
}

/** Walk the boxes in [start, end), descending along MP4_PATH, within the shared box budget. */
function mp4WalkHasAlac(data, start, end, budget) {
  let at = start;
  while (at + 8 <= end && budget.left-- > 0) {
    const box = mp4Box(data, at, end);
    if (!box) return false;
    if (box.type === 'stsd') {
      if (stsdHasAlac(data, at, box, end)) return true;
    } else if (MP4_PATH.has(box.type) && mp4WalkHasAlac(data, at + box.header, at + box.size, budget)) {
      return true;
    }
    at += box.size;
  }
  return false;
}

/** Returns the container name this tier can decode, or null. */
export function sniffLibav(data) {
  if (!data || data.length < 8) return null;
  const signed = SIGNATURES.find(entry => startsWith(data, entry.bytes))?.container ?? null;
  if (signed) return signed;
  return mp4HasAlac(data) ? 'alac' : null;
}

let modulePromise = null;

/**
 * Instantiate libav once and reuse it.
 * Held as a promise rather than a value so concurrent callers share one
 * instantiation instead of racing to build several.
 */
async function libav() {
  modulePromise ??= (async () => {
    // The high-level frontend is what carries ff_init_demuxer_file and the rest.
    // The raw emscripten factory alone exposes only the C symbols, so it is
    // passed in rather than used directly.
    // In the single-file build these are blob URLs the loader publishes; the
    // module graph cannot see a dynamic import built from a URL.
    const inlined = globalThis.__nakliampLibavUrls;
    const vendored = inlined ? null : vendorUrls();
    if (!inlined && !vendored) {
      throw decodeError('ERR_NAKLIAMP_LIBAV_UNAVAILABLE', 'This build carries no software decoder.');
    }
    const LibAV = (await import(inlined?.loader ?? vendored.loader)).default;
    const emscripten = (await import(inlined?.factory ?? vendored.factory)).default;
    // ffmpeg writes to stderr, and emscripten routes stderr to console.error.
    // A file this tier cannot read is a refusal the caller reports, not a page
    // error, so the stream is routed to console.debug: still there for anyone
    // looking, no longer indistinguishable from something being broken.
    // `av_log_set_level` does not cover it — these lines come from libav.js's
    // own wrappers, not from the ffmpeg log. libav.js passes the factory only
    // `wasmurl` and `variant`, so the hook is added by wrapping it here.
    const factory = options => emscripten({
      ...options,
      print: (...parts) => console.debug('libav:', ...parts),
      printErr: (...parts) => console.debug('libav:', ...parts),
    });
    // The single-file build embeds the wasm bytes rather than a URL, so the
    // artifact fetches nothing. Everywhere else the file sits beside the glue.
    // `wasmurl` is libav's own supported hook. Threading the binary through
    // `factory` looked equivalent and was not: the loader never passed it on,
    // so emscripten fell back to streaming a URL that does not exist in a
    // single-file artifact.
    const wasmUrl = globalThis.__nakliampWasmUrl;
    const instance = await LibAV.LibAV({
      noworker: true,
      nothreads: true,
      variant: 'nakliamp',
      base: vendored?.base ?? '',
      ...(wasmUrl ? { wasmurl: wasmUrl } : {}),
      factory,
    });
    // ffmpeg logs informational lines to stderr, which emscripten routes to
    // console.error. The harness fails a run on any console error, and an
    // estimated-duration notice is not one.
    await instance.av_log_set_level(instance.AV_LOG_QUIET);
    return instance;
  })();
  return modulePromise;
}

const decodeError = (code, message, cause) => {
  const error = new Error(message);
  error.name = 'LibavDecodeError';
  error.code = code;
  if (cause) error.cause = cause;
  return error;
};

/**
 * The largest file this tier will take in.
 *
 * A decode costs the ArrayBuffer, a full copy inside the wasm filesystem, and
 * the decoded Float32 output — several times the file, all at once, in the
 * page's own heap. There was no bound at all, so a large enough file killed
 * the tab instead of being refused. This is comfortably above any real
 * lossless music track.
 */
const MAX_INPUT_BYTES = 256 * 1024 * 1024;

// MEMFS is one flat namespace shared by every decode. A fixed name meant two
// concurrent decodes of the same container wrote over each other mid-demux —
// and the engine's supersede logic cancels the *caller*, not the decode
// already running inside wasm.
let decodeSequence = 0;

/**
 * Decode a whole file to per-channel Float32Arrays.
 *
 * Whole-file decode matches the in-house tier's contract and suits the sizes
 * involved: these are music tracks, not streams. Interleaved output is
 * deinterleaved here so the caller sees one shape from every R3 decoder.
 *
 * `readLimit` is the byte budget of one demuxer batch. The default reads a
 * whole track in one batch; the gates pass a small one so that a batch can
 * hold only another stream's packets, which is the case that once truncated
 * a track with cover art.
 */
export async function decodeLibav(data, { readLimit = READ_LIMIT } = {}) {
  const container = acceptInput(data);
  const instance = await startLibav();

  decodeSequence += 1;
  const name = `input-${decodeSequence}.${container}`;
  // Every handle below is freed in the finally. They used to be freed only on
  // the success path, so each refused file left a decoder context, a packet, a
  // frame and an open demuxer inside the wasm heap for the life of the tab.
  const handles = { format: null, context: null, packet: null, frame: null };
  try {
    await instance.writeFile(name, data);
    let streams;
    [handles.format, streams] = await instance.ff_init_demuxer_file(name);
    const audio = streams.find(stream => stream.codec_type === instance.AVMEDIA_TYPE_AUDIO);
    if (!audio) throw decodeError('ERR_NAKLIAMP_LIBAV_NO_AUDIO', 'This file has no audio stream.');

    [, handles.context, handles.packet, handles.frame] = await instance.ff_init_decoder(audio.codec_id, audio.codecpar);

    const frames = await readAllFrames(instance, handles, audio.index, readLimit);
    if (!frames.length) throw decodeError('ERR_NAKLIAMP_LIBAV_EMPTY', 'The software decoder produced no audio.');

    return collect(frames);
  } catch (error) {
    if (error?.code?.startsWith?.('ERR_NAKLIAMP_')) throw error;
    throw decodeError('ERR_NAKLIAMP_LIBAV_FAILED', `The software decoder could not read this file: ${error?.message ?? error}`, error);
  } finally {
    await releaseDecode(instance, name, handles);
  }
}

/** Refuse a file this tier cannot read or should not take in; returns its container name. */
function acceptInput(data) {
  const container = sniffLibav(data);
  if (!container) {
    throw decodeError('ERR_NAKLIAMP_LIBAV_UNKNOWN', 'This file is not a container the wasm decoder reads.');
  }
  if (data.length > MAX_INPUT_BYTES) {
    throw decodeError(
      'ERR_NAKLIAMP_LIBAV_TOO_LARGE',
      `This file is ${Math.round(data.length / 1024 / 1024)} MB; the software decoder reads up to ${MAX_INPUT_BYTES / 1024 / 1024} MB.`,
    );
  }
  return container;
}

/** The shared libav instance, or a decode error when it cannot start. */
async function startLibav() {
  try {
    return await libav();
  } catch (error) {
    throw decodeError('ERR_NAKLIAMP_LIBAV_UNAVAILABLE', 'The software decoder could not start.', error);
  }
}

/**
 * Read to end of file and decode every packet of one stream.
 * ff_read_frame_multi returns a batch and a status; one call yields a single
 * batch, which decodes to a few milliseconds.
 */
async function readAllFrames(instance, { format, context, packet, frame }, streamIndex, readLimit) {
  const frames = [];
  let emptyBatches = 0;
  for (let guard = 0; guard < 100_000; guard += 1) {
    const [status, batch] = await instance.ff_read_frame_multi(format, packet, { limit: readLimit });
    const stream = batch[streamIndex] ?? [];
    const done = status === instance.AVERROR_EOF;
    if (stream.length || done) {
      frames.push(...await instance.ff_decode_multi(context, packet, frame, stream, done));
    }
    if (done) break;
    // A batch carrying packets for other streams only is ordinary in a file
    // with cover art or a video stream; ending the read there truncated the
    // track. What must end the read is a demuxer that has stopped advancing,
    // which is a batch with no packets for any stream at all.
    if (Object.values(batch).some(list => list.length)) emptyBatches = 0;
    else if ((emptyBatches += 1) >= 3) break;
  }
  return frames;
}

/** Free the decoder, close the demuxer and remove the input file; each may already be gone. */
async function releaseDecode(instance, name, { format, context, packet, frame }) {
  if (context) { try { await instance.ff_free_decoder(context, packet, frame); } catch { /* already gone */ } }
  if (format) { try { await instance.avformat_close_input_js(format); } catch { /* already gone */ } }
  try { await instance.unlink(name); } catch { /* the file may never have been written */ }
}

/** libav frames arrive planar or packed depending on the codec; normalise both. */
function collect(frames) {
  const first = frames[0];
  const channelCount = first.channels ?? first.channel_layout?.nb_channels ?? 1;
  const sampleRate = first.sample_rate;
  // Planar frames are an array of per-channel buffers. Those buffers are typed
  // arrays, so `Array.isArray` on them is false — testing it that way counts
  // every frame as one sample.
  const planar = Array.isArray(first.data) && ArrayBuffer.isView(first.data[0]);

  let total = 0;
  for (const frame of frames) {
    total += planar ? frame.data[0].length : frame.data.length / channelCount;
  }

  const channels = Array.from({ length: channelCount }, () => new Float32Array(total));
  let offset = 0;
  for (const frame of frames) {
    offset += planar
      ? copyPlanar(channels, frame, offset)
      : copyInterleaved(channels, frame, offset);
  }

  return { sampleRate, channels, frames: total };
}

/** Copy one planar frame into the channel buffers at `offset`; returns its sample count. */
function copyPlanar(channels, frame, offset) {
  for (let channel = 0; channel < channels.length; channel += 1) {
    channels[channel].set(toFloat(frame.data[channel] ?? frame.data[0]), offset);
  }
  return frame.data[0].length;
}

/** Deinterleave one packed frame into the channel buffers at `offset`; returns its sample count. */
function copyInterleaved(channels, frame, offset) {
  const channelCount = channels.length;
  const interleaved = toFloat(frame.data);
  const length = interleaved.length / channelCount;
  for (let index = 0; index < length; index += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      channels[channel][offset + index] = interleaved[index * channelCount + channel];
    }
  }
  return length;
}

/** Integer sample formats arrive as typed integer arrays; scale them to [-1, 1]. */
function toFloat(samples) {
  if (samples instanceof Float32Array) return samples;
  if (samples instanceof Float64Array) return Float32Array.from(samples);
  const scale = samples instanceof Int16Array ? 32768
    : samples instanceof Int32Array ? 2147483648
    : samples instanceof Uint8Array ? 128
    : 1;
  const out = new Float32Array(samples.length);
  const bias = samples instanceof Uint8Array ? 128 : 0;
  for (let index = 0; index < samples.length; index += 1) out[index] = (samples[index] - bias) / scale;
  return out;
}

/**
 * The shared libav instance, started on first use.
 * Exported for the gates, which read the wasm heap's allocated byte count
 * (`mallinfo_uordblks`) before and after a run of decodes to prove every
 * handle is freed. The app itself never calls it.
 */
export function libavInstance() {
  return startLibav();
}

/**
 * Open a file for streamed decode: DSD always, other containers above 64 MB.
 *
 * The whole-file path above holds the input, its copy in the wasm filesystem
 * and the decoded output at once, which a long DSD track cannot afford. This
 * one reads the file a slice at a time and resamples inside libav; see
 * libav-stream.mjs. Its input has no size bound, because nothing is read whole.
 */
export const streamLibav = createStreamOpener({ instance: startLibav, error: decodeError });

/**
 * The decoder entry the engine's `softwareDecoders` list expects.
 * `streams` and `stream` are optional for a decoder; the engine uses them for
 * the files `streams(container, size)` claims and decodes the rest whole.
 */
export const libavDecoder = Object.freeze({
  name: 'libav wasm',
  sniff: sniffLibav,
  decode: decodeLibav,
  streams: shouldStream,
  stream: streamLibav,
});
