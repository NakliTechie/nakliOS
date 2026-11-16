// libav rung: software demux and decode for the formats Mediabunny and WebCodecs refuse.
//
// Containers: AVI, FLV, ASF/WMV, MPEG program stream (.mpg/.vob), MPEG-TS, Matroska, and MP4/MOV
// (for browsers without AudioDecoder, whose MP4 audio has no other route).
// Video: MPEG-1/2, MPEG-4 Part 2 (Xvid, DivX), MS-MPEG-4 v1/v2/v3, WMV 7/8/9, VC-1,
// H.263, Sorenson Spark (FLV1) and H.264. Audio: MP1/2/3, AC-3, E-AC-3, AAC, WMA v1/v2,
// Nellymoser, ADPCM (MS, IMA, SWF) and PCM.
//
// The decoder is a custom libav.js 6.10.9.0 build (variant "reel", FFmpeg 9.0, LGPL-2.1,
// no --enable-gpl); see VENDOR.md, section "libav.js". It is loaded lazily after a SHA-256
// check of every file against vendor/libav/pins.json, and runs in its own Web Worker without
// threads, so it needs no COOP/COEP inside the NakliOS iframe. The worker runs from a blob of the
// checked glue and checks the wasm's hash itself. The worker stops when the last source closes,
// and is replaced when a call makes no progress for 30 s or the wasm aborts. H.264 goes to WebCodecs when the browser accepts
// the configuration, because hardware decode is far faster than wasm; wasm is the fallback.
//
// Reading: the input is never read whole. Each demuxer opens a libav.js block reader device
// (mkblockreaderdev). Its block requests arrive in `onblockread` on this thread and are
// answered from the input: File/Blob slices, or `read(offset, length)` on a ranged reader
// (NakliOS-hosted media). Each answer is at least 1 MiB and at most 16 MiB, and the next
// block is prefetched, so a multi-GB input costs only the blocks in flight.
//
// Contract (docs/build/reel-v1-contract.md, "libav rung interface"):
//   openLibavSource(input, { requestDownload, log }) -> source, or null when libav cannot
//   (input: File, Blob, a Blob-shaped view with slice(), or a ranged reader
//   { name, size, read(offset, length) -> Promise<Uint8Array | ArrayBuffer> });
//   open the file or finds no decodable track. Loading failures and refusals throw a
//   LibavRungError with a code: ERR_LIBAV_DECLINED, ERR_LIBAV_UNAVAILABLE, ERR_LIBAV_INTEGRITY,
//   ERR_LIBAV_FRAME_TOO_LARGE (a video frame above 8192 pixels a side, refused from the
//   container headers before any decoder runs), ERR_LIBAV_TIMEOUT (a call made no progress for
//   `callTimeoutMs`, default 30 s), ERR_LIBAV_ABORTED (the wasm aborted). After a timeout or an
//   abort the instance is retired and the next open starts a fresh one; calls on sources of the
//   retired instance fail with the same error. libavRungState() gives { live, instancesCreated }.
//   source.tracks, source.duration, source.videoFrames(fromS), source.audioData(fromS),
//   source.close(). audioData yields WebCodecs AudioData, or, where the browser has no AudioData
//   (Safari 17.4 to 18.x), plain f32-planar blocks with the same reading surface (audioBlock).
//
// Self-contained ES module: relative imports only, no DOM, no UI.

const VENDOR_DIR = '../vendor/libav/';
// The SHA-256 pins live beside the binaries, so the LGPL library can be replaced by replacing its
// files and editing this JSON, with no edit to this module (review V37; VENDOR.md, "libav.js").
const PINS_FILE = 'pins.json';
const FILE_KEYS = Object.freeze(['loader', 'factory', 'wasm']);
const ASK_OVER_BYTES = 5 * 1024 * 1024;
const DOWNLOAD_NAME = 'libav.js video decoder (Reel variant)';
const LICENCE = 'LGPL-2.1';

// libav constants used here (FFmpeg 9.0 values, as libav.js exports them).
const AVMEDIA_TYPE_VIDEO = 0;
const AVMEDIA_TYPE_AUDIO = 1;
const AVERROR_EOF = -541478725;
const AVSEEK_FLAG_BACKWARD = 1;
const AVDISCARD_ALL = 48;
const AV_PIX_FMT_YUV420P = 0;
const AV_FRAME_FLAG_KEY = 2;
const AV_PICTURE_TYPE_I = 1;
const AV_LOG_QUIET = -8;
const NOPTS_HI = -2147483648;

const VIDEO_READ_BYTES = 128 * 1024; // demux batch: a few frames, so the lock is held briefly
const AUDIO_READ_BYTES = 32 * 1024;
const KEY_WAIT_FRAMES = 300; // after a seek, frames dropped while waiting for a key frame
const WEBCODECS_QUEUE = 8;
const BLOCK_BYTES = 1024 * 1024; // smallest answer to a block request
const MAX_READ_BYTES = 16 * 1024 * 1024; // largest single read from the input (hosts cap here)
// How far before the target to retry when a seek lands after it; the last step is the start.
const SEEK_BACKOFF_S = Object.freeze([0.5, 1, 2, 4, Infinity]);

export class LibavRungError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'LibavRungError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

/* ---------------------------------------------------------------- loading */

const WORKER_START_MS = 20_000;
// Watchdog for one call into libav: how long it may run without progress (a block answered to the
// demuxer counts as progress, so a slow input is not mistaken for a hung decoder).
const CALL_TIMEOUT_MS = 30_000;
// Largest frame the rung accepts, checked from the container headers before any decoder runs and
// again on every decoded frame (review V27): 8192 pixels a side, which also bounds it at 64 MiP.
const MAX_FRAME_SIDE = 8192;

let instancePromise = null; // Promise<host> for the live instance, or null
let instancesCreated = 0; // for libavRungState(): a retired instance is never reused

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function loadPins() {
  const url = new URL(VENDOR_DIR + PINS_FILE, import.meta.url).href;
  let pins;
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    pins = await response.json();
  } catch (error) {
    throw new LibavRungError('ERR_LIBAV_UNAVAILABLE', `${PINS_FILE} did not load (${error?.message ?? error}).`, error);
  }
  const files = {};
  for (const file of Array.isArray(pins?.files) ? pins.files : []) {
    if (FILE_KEYS.includes(file?.key) && typeof file.name === 'string' && /^[0-9a-f]{64}$/.test(file.sha256 || '')
      && !file.name.includes('/') && Number.isFinite(file.bytes)) {
      files[file.key] = Object.freeze({ ...file, url: new URL(VENDOR_DIR + file.name, import.meta.url).href });
    }
  }
  const missing = FILE_KEYS.filter(key => !files[key]);
  if (missing.length || typeof pins.variant !== 'string') {
    throw new LibavRungError('ERR_LIBAV_INTEGRITY', `${PINS_FILE} lacks a valid entry for ${missing.join(', ') || 'variant'}.`);
  }
  const bytes = FILE_KEYS.reduce((sum, key) => sum + files[key].bytes, 0);
  return { version: String(pins.version || ''), variant: pins.variant, files, bytes };
}

async function fetchVerified(file) {
  const response = await fetch(file.url);
  if (!response.ok) throw new LibavRungError('ERR_LIBAV_UNAVAILABLE', `${file.name} did not load (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== file.sha256) {
    throw new LibavRungError('ERR_LIBAV_INTEGRITY', `${file.name} failed its SHA-256 check (got ${digest.slice(0, 12)}).`);
  }
  return bytes;
}

const blobUrl = (parts, type) => URL.createObjectURL(new Blob(parts, { type }));

/* Appended to the hash-checked glue, which then runs as the worker from a blob URL (review V72).
 * The worker inherits the page's Content-Security-Policy, whose connect-src does not list blob:, so
 * the worker fetches the wasm from its vendored URL and checks its SHA-256 itself before compiling.
 * When that check fails the worker start is rejected, and the page thread takes over with the
 * bytes the page checked. */
function workerGuard(wasm) {
  return `
;{
  const REEL_WASM = ${JSON.stringify({ url: wasm.url, sha256: wasm.sha256, name: wasm.name })};
  const plainFetch = self.fetch.bind(self);
  self.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    if (url !== REEL_WASM.url) return plainFetch(input, init);
    const bytes = await (await plainFetch(url, init)).arrayBuffer();
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
      .map(b => b.toString(16).padStart(2, '0')).join('');
    if (digest !== REEL_WASM.sha256) throw new Error(REEL_WASM.name + ' failed its SHA-256 check in the worker');
    return new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } });
  };
  // Emscripten falls back to a synchronous XMLHttpRequest when its fetch fails; that read could not
  // be hash-checked, so it is refused for the wasm and the failed fetch stands.
  if (self.XMLHttpRequest) {
    const plainOpen = self.XMLHttpRequest.prototype.open;
    self.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      if (String(url) === REEL_WASM.url) throw new Error(REEL_WASM.name + ' may only load through the checked fetch');
      return plainOpen.call(this, method, url, ...rest);
    };
  }
  // libav.js reports a failed start as ["error", "error", false, ex], which its page side handles
  // with a missing reject function: the page throws an uncaught TypeError and the start promise
  // never settles (a page paused on exceptions then hangs). Sent with the success flag, the same
  // message reaches the start promise's reject, so the page thread takes over at once.
  const plainPost = self.postMessage.bind(self);
  self.postMessage = (message, ...rest) => {
    if (Array.isArray(message) && message[0] === 'error' && message[1] === 'error' && message[2] === false) {
      return plainPost(['error', 'error', true, String(message[3] && message[3].message || message[3])], ...rest);
    }
    return plainPost(message, ...rest);
  };
}
`;
}

/** libav.js leaves its promise pending when the worker fails to load, so bound the wait. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** A wasm abort leaves the instance unusable: these are Emscripten's and the engine's words for it. */
function isAbort(error) {
  return error?.name === 'RuntimeError' || /\bAborted\(|RuntimeError|unreachable|out of bounds|out of memory/i.test(String(error?.message ?? error));
}

/* Retire an instance: stop its worker, forget it, and fail every later call into it. The next
 * openLibavSource() starts a fresh instance. */
function retire(host, reason) {
  if (host.dead) return;
  host.dead = reason instanceof Error ? reason : new LibavRungError('ERR_LIBAV_RETIRED', String(reason));
  try { host.lib.terminate?.(); } catch { /* already stopped */ }
  host.devices.clear();
  if (host.promise && instancePromise === host.promise) instancePromise = null;
}

/**
 * Serialise every call into one libav instance (libav.js uses Asyncify, which is not re-entrant)
 * and guard each one: a call that makes no progress for `timeoutMs`, or that aborts the wasm,
 * retires the instance (review V27).
 */
function guardedRunner(host) {
  let tail = Promise.resolve();
  return (fn, timeoutMs = CALL_TIMEOUT_MS) => {
    const call = tail.then(async () => {
      if (host.dead) throw host.dead;
      host.progressAt = Date.now();
      let timer;
      const watchdog = new Promise((_, reject) => {
        const step = Math.max(50, Math.min(1000, timeoutMs / 4));
        const tick = () => {
          if (host.dead) { reject(host.dead); return; }
          if (Date.now() - host.progressAt >= timeoutMs) {
            reject(new LibavRungError('ERR_LIBAV_TIMEOUT', `A libav call made no progress for ${Math.round(timeoutMs / 1000)} s; the decoder was restarted.`));
            return;
          }
          timer = setTimeout(tick, step);
        };
        timer = setTimeout(tick, step);
      });
      try {
        return await Promise.race([fn(), watchdog]);
      } catch (error) {
        if (error?.code === 'ERR_LIBAV_TIMEOUT') { retire(host, error); throw error; }
        if (host.dead) throw host.dead;
        if (isAbort(error)) {
          retire(host, new LibavRungError('ERR_LIBAV_ABORTED', `The libav decoder stopped (${error?.message ?? error}); it was restarted.`, error));
          throw host.dead;
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    });
    tail = call.catch(() => {});
    return call;
  };
}

async function createInstance(requestDownload, log) {
  if (typeof WebAssembly !== 'object' || !globalThis.crypto?.subtle || typeof fetch !== 'function') {
    throw new LibavRungError('ERR_LIBAV_UNAVAILABLE', 'The software video decoder needs WebAssembly, Web Crypto and fetch.');
  }
  const pins = await loadPins();
  if (pins.bytes > ASK_OVER_BYTES) {
    const yes = typeof requestDownload === 'function'
      && (await requestDownload({ name: DOWNLOAD_NAME, bytes: pins.bytes, licence: LICENCE })) === true;
    if (!yes) throw new LibavRungError('ERR_LIBAV_DECLINED', `The ${DOWNLOAD_NAME} download was declined.`);
  }
  const { loader, factory, wasm } = pins.files;
  const loaderBytes = await fetchVerified(loader);
  const glueBytes = await fetchVerified(factory);
  // The page checks the wasm too, so a mismatch fails here by name before any worker starts; the
  // worker checks its own copy again (workerGuard), and the page-thread fallback compiles these bytes.
  const wasmBytes = await fetchVerified(wasm);
  const module = await import(blobUrl([loaderBytes], loader.type));
  const LibAV = module.default ?? module;
  let lib;
  let mode = 'worker';
  try {
    if (typeof Worker !== 'function') throw new Error('no Worker');
    const glue = blobUrl([glueBytes, workerGuard(wasm)], factory.type);
    lib = await withTimeout(
      LibAV.LibAV({ variant: pins.variant, toImport: glue, wasmurl: wasm.url, nothreads: true }),
      WORKER_START_MS, 'the libav worker did not start');
  } catch (error) {
    // A page without module workers, or a worker that failed to start, decodes on this thread.
    log?.(`libav worker unavailable (${error?.message ?? error}); decoding on the page thread`);
    const pageFactory = (await import(blobUrl([glueBytes], factory.type))).default;
    // The checked bytes go in as wasmBinary, so nothing is fetched again (connect-src has no blob:).
    const withBinary = options => pageFactory({ ...options, wasmBinary: new Uint8Array(wasmBytes) });
    lib = await LibAV.LibAV({ variant: pins.variant, factory: withBinary, noworker: true, nothreads: true });
    mode = 'direct';
  }
  const host = { lib, mode, sequence: 0, devices: new Map(), users: 0, dead: null, progressAt: Date.now(), promise: null };
  host.run = guardedRunner(host);
  instancesCreated += 1;
  await host.run(() => lib.av_log_set_level(AV_LOG_QUIET));
  // Block requests come back to this thread in both modes. They are answered directly, never
  // through the call queue: the call that asked is suspended inside libav until the answer lands.
  lib.onblockread = (name, position, length) => {
    host.progressAt = Date.now();
    const device = host.devices.get(name);
    if (host.dead || !device) return lib.ff_block_reader_dev_send(name, position, null, { errorCode: 5 /* EIO */ });
    return serveBlock(lib, device, name, position, length, host);
  };
  return host;
}

async function instance(requestDownload, log) {
  for (;;) {
    if (!instancePromise) {
      const promise = createInstance(requestDownload, log).then(host => { host.promise = promise; return host; });
      promise.catch(() => { if (instancePromise === promise) instancePromise = null; }); // a decline or a network failure may be retried later
      instancePromise = promise;
    }
    const host = await instancePromise;
    if (!host.dead) { host.users += 1; return host; } // retired while this caller waited: start another
  }
}

/** For checks and the host's diagnostics: whether an instance is alive, and how many were made. */
export function libavRungState() {
  return { live: !!instancePromise, instancesCreated };
}

/* ---------------------------------------------------------------- input reading */

/** One `read(offset, length) -> Uint8Array` over any supported input, or null. */
function readerFor(input) {
  if (!input || !Number.isFinite(input.size) || input.size < 0) return null;
  if (typeof input.read === 'function') {
    return async (offset, length) => {
      const value = await input.read(offset, length);
      return value instanceof Uint8Array ? value : new Uint8Array(value);
    };
  }
  if (typeof input.slice === 'function') {
    return async (offset, length) => {
      const part = input.slice(offset, offset + length);
      return typeof part.bytes === 'function' ? new Uint8Array(await part.bytes()) : new Uint8Array(await part.arrayBuffer());
    };
  }
  return null;
}

async function readExactly(device, offset) {
  const length = Math.min(MAX_READ_BYTES, Math.max(0, device.size - offset), Math.max(BLOCK_BYTES, device.want));
  if (length <= 0) return new Uint8Array(0);
  const data = await device.read(offset, length);
  if (data.length < length) throw new Error(`short read at ${offset}: ${data.length} of ${length} bytes`);
  return data.length > length ? data.subarray(0, length) : data;
}

async function serveBlock(lib, device, name, position, length, host) {
  device.want = length;
  try {
    let data = null;
    if (device.ahead && device.ahead.offset === position) data = await device.ahead.promise.catch(() => null);
    data ??= await readExactly(device, position);
    if (host.dead) return;
    host.progressAt = Date.now();
    await lib.ff_block_reader_dev_send(name, position, data);
    const next = position + data.length;
    if (data.length && next < device.size) {
      const promise = readExactly(device, next);
      promise.catch(() => {}); // a failed prefetch is retried on demand
      device.ahead = { offset: next, promise };
    } else {
      device.ahead = null;
    }
  } catch (error) {
    device.ahead = null;
    if (!host.dead) await lib.ff_block_reader_dev_send(name, position, null, { error }).catch(() => {});
  }
}

/**
 * WebCodecs AudioData where the browser has it; otherwise (Safari 17.4 to 18.x) a plain object with
 * the same reading surface the engine uses: format, sampleRate, numberOfFrames, numberOfChannels,
 * timestamp (microseconds), copyTo(dest, { planeIndex, format: 'f32-planar' }) and close().
 */
function audioBlock(init) {
  if (typeof globalThis.AudioData === 'function') return new globalThis.AudioData(init);
  const { data, numberOfFrames, numberOfChannels } = init;
  let closed = false;
  return {
    format: 'f32-planar',
    sampleRate: init.sampleRate,
    numberOfFrames,
    numberOfChannels,
    timestamp: init.timestamp,
    duration: Math.round((numberOfFrames * 1e6) / init.sampleRate),
    allocationSize: () => numberOfFrames * 4,
    copyTo(dest, { planeIndex = 0, format = 'f32-planar', frameOffset = 0, frameCount } = {}) {
      if (closed) throw new DOMException('The audio block is closed.', 'InvalidStateError');
      if (format !== 'f32-planar') throw new DOMException(`Only f32-planar copies are supported, not ${format}.`, 'NotSupportedError');
      if (!(planeIndex >= 0 && planeIndex < numberOfChannels)) throw new RangeError(`No plane ${planeIndex}.`);
      const count = frameCount ?? numberOfFrames - frameOffset;
      const start = planeIndex * numberOfFrames + frameOffset;
      const target = dest instanceof Float32Array ? dest : new Float32Array(dest.buffer ?? dest, dest.byteOffset ?? 0, count);
      target.set(data.subarray(start, start + count));
    },
    close() { closed = true; },
  };
}

/* ---------------------------------------------------------------- demuxer */

function tooLarge(width, height) {
  return width > MAX_FRAME_SIDE || height > MAX_FRAME_SIDE;
}

function frameTooLargeError(name, width, height) {
  return new LibavRungError('ERR_LIBAV_FRAME_TOO_LARGE',
    `${name || 'The file'} declares a ${width}x${height} video frame; the software decoder accepts at most ${MAX_FRAME_SIDE}x${MAX_FRAME_SIDE}.`);
}

/**
 * libav.js's ff_init_demuxer_file in two steps, so the frame size declared in the container
 * headers is checked before avformat_find_stream_info runs a decoder (and allocates frames).
 * Returns [fmt, streams] in ff_init_demuxer_file's shape, or throws.
 */
async function openDemuxer(lib, deviceName, label) {
  const fmt = await lib.avformat_open_input_js(deviceName, null, null);
  if (!fmt) throw new Error('Could not open source file');
  try {
    const declared = async () => {
      const count = await lib.AVFormatContext_nb_streams(fmt);
      for (let i = 0; i < count; i += 1) {
        const par = await lib.AVStream_codecpar(await lib.AVFormatContext_streams_a(fmt, i));
        if ((await lib.AVCodecParameters_codec_type(par)) !== AVMEDIA_TYPE_VIDEO) continue;
        const width = await lib.AVCodecParameters_width(par);
        const height = await lib.AVCodecParameters_height(par);
        if (tooLarge(width, height)) throw frameTooLargeError(label, width, height);
      }
    };
    await declared();
    const ret = await lib.avformat_find_stream_info(fmt, 0);
    if (ret < 0) throw new Error(`avformat_find_stream_info failed (${ret})`);
    await declared();
    const count = await lib.AVFormatContext_nb_streams(fmt);
    const streams = [];
    for (let i = 0; i < count; i += 1) {
      const ptr = await lib.AVFormatContext_streams_a(fmt, i);
      const codecpar = await lib.AVStream_codecpar(ptr);
      const timeBaseNum = await lib.AVStream_time_base_num(ptr);
      const timeBaseDen = await lib.AVStream_time_base_den(ptr);
      const durationTb = (await lib.AVStream_duration(ptr)) + (await lib.AVStream_durationhi(ptr)) * 4294967296;
      streams.push({
        ptr, index: i, codecpar,
        codec_type: await lib.AVCodecParameters_codec_type(codecpar),
        codec_id: await lib.AVCodecParameters_codec_id(codecpar),
        time_base_num: timeBaseNum, time_base_den: timeBaseDen,
        duration: timeBaseDen ? (durationTb * timeBaseNum) / timeBaseDen : 0,
      });
    }
    return [fmt, streams];
  } catch (error) {
    try { await lib.avformat_close_input_js(fmt); } catch { /* gone */ }
    throw error;
  }
}

/* ---------------------------------------------------------------- helpers */

const i64 = (lo, hi) => {
  if (hi === NOPTS_HI && lo === 0) return null;
  return (hi ?? 0) * 4294967296 + (lo >>> 0);
};

function extensionOf(name) {
  const match = /\.([a-z0-9]{1,5})$/i.exec(name || '');
  return match ? match[1].toLowerCase() : 'bin';
}

function sampleFormatToFloat(samples, format) {
  // AV_SAMPLE_FMT_*: 0 U8, 1 S16, 2 S32, 3 FLT, 4 DBL; +5 for the planar forms.
  const base = format >= 5 ? format - 5 : format;
  if (base === 3) return samples instanceof Float32Array ? samples : Float32Array.from(samples);
  if (base === 4) return Float32Array.from(samples);
  const out = new Float32Array(samples.length);
  if (base === 0) for (let i = 0; i < samples.length; i += 1) out[i] = (samples[i] - 128) / 128;
  else if (base === 1) for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 32768;
  else if (base === 2) for (let i = 0; i < samples.length; i += 1) out[i] = samples[i] / 2147483648;
  else for (let i = 0; i < samples.length; i += 1) out[i] = samples[i];
  return out;
}

/** libav audio frame (default copyout) to one f32-planar buffer. */
function audioPlanes(frame) {
  const planar = frame.format >= 5;
  if (planar) {
    const planes = frame.data.map(plane => sampleFormatToFloat(plane, frame.format));
    return { planes, frames: planes[0]?.length ?? 0 };
  }
  const channels = frame.channels || 1;
  const interleaved = sampleFormatToFloat(frame.data, frame.format);
  const frames = Math.floor(interleaved.length / channels);
  const planes = Array.from({ length: channels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i += 1) {
    for (let c = 0; c < channels; c += 1) planes[c][i] = interleaved[i * channels + c];
  }
  return { planes, frames };
}

function colourSpaceFor(height) {
  return height > 576
    ? { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false }
    : { primaries: 'smpte170m', transfer: 'smpte170m', matrix: 'smpte170m', fullRange: false };
}

/** WebCodecs codec string for H.264, from avcC extradata or an Annex B SPS. */
function avcCodecString(extradata, firstPacket) {
  const tag = (profile, compat, level) =>
    `avc1.${[profile, compat, level].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  if (extradata && extradata.length > 4 && extradata[0] === 1) return tag(extradata[1], extradata[2], extradata[3]);
  const scan = data => {
    for (let i = 0; data && i + 4 < data.length; i += 1) {
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1 && (data[i + 3] & 0x1f) === 7 && i + 6 < data.length) {
        return tag(data[i + 4], data[i + 5], data[i + 6]);
      }
    }
    return null;
  };
  return scan(extradata) || scan(firstPacket);
}

/* ---------------------------------------------------------------- source */

/**
 * Open `file` through libav. Returns the source, or null when libav cannot demux it or finds
 * no track it can decode. Throws LibavRungError when the decoder itself cannot be loaded.
 *
 * Options beyond the contract: `deinterlace` (default false) runs yadif on frames flagged
 * interlaced; `source.setDeinterlace(on)` changes it for the next videoFrames() call.
 */
export async function openLibavSource(file, { requestDownload, log, deinterlace = false, callTimeoutMs = CALL_TIMEOUT_MS } = {}) {
  const read = readerFor(file);
  if (!read) return null;
  const say = message => { try { log?.(message); } catch { /* the host's logger failed; keep decoding */ } };
  const host = await instance(requestDownload, say); // counts this caller as a user
  try {
    const source = await openOn(host, file, read, say, deinterlace, callTimeoutMs);
    if (source) return source;
  } catch (error) {
    release(host);
    throw error;
  }
  release(host);
  return null;
}

/* One fewer source on this instance; the last one out stops the worker, so its wasm heap goes too. */
function release(host) {
  host.users = Math.max(0, host.users - 1);
  if (!host.users) retire(host, 'the last libav source closed');
}

async function openOn(host, file, read, say, deinterlace, callTimeoutMs) {
  const { lib } = host;
  const timeoutMs = Number.isFinite(callTimeoutMs) && callTimeoutMs > 0 ? callTimeoutMs : CALL_TIMEOUT_MS;
  const run = fn => host.run(fn, timeoutMs);
  const makeDevice = async name => {
    host.devices.set(name, { read, size: file.size, want: BLOCK_BYTES, ahead: null });
    await lib.mkblockreaderdev(name, file.size);
  };
  const extension = extensionOf(file?.name);
  const devices = new Set();
  const idle = new Map(); // stream index -> sessions ready for reuse
  let closed = false;

  const deviceName = () => {
    host.sequence += 1;
    const name = `reel-libav-${host.sequence}.${extension}`;
    devices.add(name);
    return name;
  };
  const dropDevice = async name => {
    devices.delete(name);
    host.devices.delete(name);
    try { await lib.unlink(name); } catch { /* already gone */ }
  };

  // Probe: open once, read stream information, close.
  let probe;
  const probeName = deviceName();
  try {
    probe = await run(async () => {
      await makeDevice(probeName);
      const [fmt, streams] = await openDemuxer(lib, probeName, file?.name);
      try {
        const startLo = await lib.AVFormatContext_start_time(fmt);
        const startHi = await lib.AVFormatContext_start_timehi(fmt);
        const durLo = await lib.AVFormatContext_duration(fmt);
        const durHi = await lib.AVFormatContext_durationhi(fmt);
        const tracks = [];
        for (const stream of streams) {
          const type = stream.codec_type === AVMEDIA_TYPE_VIDEO ? 'video'
            : stream.codec_type === AVMEDIA_TYPE_AUDIO ? 'audio' : null;
          if (!type) continue;
          if (!(await lib.avcodec_find_decoder(stream.codec_id))) continue;
          const par = stream.codecpar;
          const codec = await lib.avcodec_get_name(stream.codec_id);
          const track = {
            id: stream.index,
            type,
            codec,
            width: type === 'video' ? await lib.AVCodecParameters_width(par) : 0,
            height: type === 'video' ? await lib.AVCodecParameters_height(par) : 0,
            sampleRate: type === 'audio' ? await lib.AVCodecParameters_sample_rate(par) : 0,
            channels: type === 'audio' ? await lib.AVCodecParameters_ch_layout_nb_channels(par) : 0,
            durationS: stream.duration > 0 && Number.isFinite(stream.duration) ? stream.duration : 0,
          };
          if (type === 'video') {
            const num = await lib.AVCodecParameters_framerate_num(par);
            const den = await lib.AVCodecParameters_framerate_den(par);
            track.frameRate = num > 0 && den > 0 ? num / den : 0;
          }
          tracks.push(track);
        }
        return { tracks, startUs: i64(startLo, startHi), durationUs: i64(durLo, durHi) };
      } finally {
        await lib.avformat_close_input_js(fmt);
      }
    });
  } catch (error) {
    say(`libav could not open ${file?.name}: ${error?.message ?? error}`);
    // A refusal by name (frame too large, decoder timeout or abort) reaches the host; any other
    // failure means libav cannot demux the file.
    if (!host.dead) await run(() => dropDevice(probeName)).catch(() => {});
    if (error instanceof LibavRungError) throw error;
    return null;
  }
  await run(() => dropDevice(probeName));
  if (!probe.tracks.length) {
    say(`libav found no decodable track in ${file?.name}`);
    return null;
  }

  const startS = probe.startUs != null && probe.startUs > 0 ? probe.startUs / 1e6 : 0;
  const longestTrack = Math.max(0, ...probe.tracks.map(track => track.durationS - startS));
  const duration = probe.durationUs != null && probe.durationUs > 0 ? probe.durationUs / 1e6 : longestTrack;
  for (const track of probe.tracks) {
    if (track.durationS > startS) track.durationS -= startS;
    if (!track.durationS) track.durationS = duration;
  }
  const tracks = probe.tracks.map(track => Object.freeze({ ...track }));

  /* ---- sessions: one demuxer + decoder per running iterator, reused after it ends ---- */

  async function openSession(track) {
    const name = deviceName();
    await makeDevice(name);
    const [fmt, streams] = await openDemuxer(lib, name, file?.name);
    const stream = streams[track.id];
    for (const other of streams) {
      if (other.index !== track.id) await lib.AVStream_discard_s(other.ptr, AVDISCARD_ALL);
    }
    const readPacket = await lib.av_packet_alloc();
    const timeBase = [stream.time_base_num, stream.time_base_den];
    const session = { name, fmt, stream, track, readPacket, timeBase, decoder: null, graph: null, webcodecs: null, started: false };
    return session;
  }

  async function freeGraph(session) {
    if (session.graph) {
      try { await lib.avfilter_graph_free_js(session.graph.graph); } catch { /* already freed */ }
      try { await lib.av_frame_free_js(session.graph.frame); } catch { /* already freed */ }
      session.graph = null;
    }
  }

  async function freeSession(session) {
    await freeGraph(session);
    if (session.decoder) {
      try { await lib.ff_free_decoder(session.decoder.ctx, session.decoder.pkt, session.decoder.frame); } catch { /* gone */ }
      session.decoder = null;
    }
    try { await lib.av_packet_free_js(session.readPacket); } catch { /* gone */ }
    try { await lib.avformat_close_input_js(session.fmt); } catch { /* gone */ }
    await dropDevice(session.name);
  }

  async function takeSession(track) {
    const pool = idle.get(track.id);
    const session = pool?.pop();
    if (session) return session;
    return openSession(track);
  }

  /**
   * Take a session positioned at the key frame at or before `fromS`. When the demuxer cannot
   * seek (an AVI without an index, a damaged file), a fresh session reads from the start and
   * `dropBeforeUs` tells the iterator to discard what comes before the target.
   */
  async function positionedSession(track, fromS) {
    return run(async () => {
      let session = await takeSession(track);
      if (await seek(session, fromS)) return { session, dropBeforeUs: null };
      await freeSession(session);
      session = await openSession(track);
      return { session, dropBeforeUs: fromS > 0 ? Math.round(fromS * 1e6) : null };
    });
  }

  async function releaseSession(session) {
    if (session.webcodecs) {
      try { session.webcodecs.decoder.close(); } catch { /* already closed */ }
      session.webcodecs = null;
    }
    if (closed || host.dead) {
      if (!host.dead) await run(() => freeSession(session)).catch(() => {});
      return;
    }
    const pool = idle.get(session.track.id) ?? [];
    pool.push(session);
    idle.set(session.track.id, pool);
  }

  /** Seek the session's demuxer to the key frame at or before `fromS` and reset its decoder. */
  async function seek(session, fromS) {
    const [num, den] = session.timeBase;
    const target = Math.max(0, Math.floor(((fromS + startS) * den) / num));
    const lo = target % 4294967296;
    const hi = Math.floor(target / 4294967296);
    // av_seek_frame takes the 64-bit timestamp as two 32-bit halves (WASM_BIGINT is off).
    const ret = await lib.av_seek_frame(session.fmt, session.stream.index, lo | 0, hi, AVSEEK_FLAG_BACKWARD);
    if (session.decoder) await lib.avcodec_flush_buffers(session.decoder.ctx);
    await freeGraph(session);
    return ret >= 0;
  }

  async function ensureDecoder(session) {
    if (session.decoder) return;
    const [, ctx, pkt, frame] = await lib.ff_init_decoder(session.stream.codec_id, {
      codecpar: session.stream.codecpar,
      time_base: session.timeBase,
    });
    session.decoder = { ctx, pkt, frame };
  }

  async function readBatch(session, limit) {
    const [status, batch] = await lib.ff_read_frame_multi(session.fmt, session.readPacket, { limit });
    return { packets: batch[session.stream.index] ?? [], eof: status === AVERROR_EOF, error: status < 0 && status !== AVERROR_EOF && status !== -6 };
  }

  function packetTimeUs(packet, timeBase) {
    const ts = i64(packet.pts, packet.ptshi) ?? i64(packet.dts, packet.dtshi);
    if (ts == null) return null;
    const [num, den] = packet.time_base_num ? [packet.time_base_num, packet.time_base_den] : timeBase;
    return Math.round((ts * num * 1e6) / den - startS * 1e6);
  }

  function frameTimeUs(frame, timeBase) {
    const ts = i64(frame.best_effort_timestamp, frame.best_effort_timestamphi) ?? i64(frame.pts, frame.ptshi);
    if (ts == null) return null;
    const [num, den] = frame.time_base_num ? [frame.time_base_num, frame.time_base_den] : timeBase;
    return Math.round((ts * num * 1e6) / den - startS * 1e6);
  }

  /* ---- video ---- */

  async function buildGraph(session, ptr, interlace) {
    const width = await lib.AVFrame_width(ptr);
    const height = await lib.AVFrame_height(ptr);
    if (tooLarge(width, height)) throw frameTooLargeError(file?.name, width, height);
    const format = await lib.AVFrame_format(ptr);
    const sarNum = await lib.AVFrame_sample_aspect_ratio_num(ptr);
    const sarDen = await lib.AVFrame_sample_aspect_ratio_den(ptr);
    if (session.graph && session.graph.width === width && session.graph.height === height && session.graph.format === format) return;
    await freeGraph(session);
    // yadif only touches frames flagged interlaced; scale converts to I420 and evens odd sizes.
    const chain = `${interlace ? 'yadif=mode=send_frame:parity=auto:deint=interlaced,' : ''}scale=w=trunc(iw/2)*2:h=trunc(ih/2)*2`;
    const [graph, src, sink] = await lib.ff_init_filter_graph(chain,
      { type: AVMEDIA_TYPE_VIDEO, width, height, pix_fmt: format, time_base: session.timeBase },
      { type: AVMEDIA_TYPE_VIDEO, pix_fmt: AV_PIX_FMT_YUV420P });
    const frame = await lib.av_frame_alloc();
    session.graph = {
      graph, src, sink, frame, width, height, format,
      sar: sarNum > 0 && sarDen > 0 ? sarNum / sarDen : 1,
    };
  }

  /** Decode one demux batch in wasm; returns packed I420 frames (plain buffers, not VideoFrames yet). */
  async function decodeVideoBatch(session, packets, fin, interlace) {
    await ensureDecoder(session);
    const { ctx, pkt, frame } = session.decoder;
    const ptrs = await lib.ff_decode_multi(ctx, pkt, frame, packets, { fin, ignoreErrors: true, copyoutFrame: 'ptr' });
    if (!ptrs.length && !(fin && session.graph)) return [];
    if (ptrs.length) await buildGraph(session, ptrs[0], interlace);
    const g = session.graph;
    let out;
    try {
      out = await lib.ff_filter_multi(g.src, g.sink, g.frame, ptrs, { fin, copyoutFrame: 'video_packed' });
    } catch (error) {
      // A mid-batch size change: rebuild from the next batch and skip this one.
      say(`libav filter: ${error?.message ?? error}`);
      await freeGraph(session);
      return [];
    }
    return out.map(f => ({ ...f, sar: g.sar }));
  }

  function toVideoFrame(f, track, timeBase, fallbackUs, durationUs) {
    const timestamp = frameTimeUs(f, timeBase) ?? fallbackUs;
    const sar = f.sample_aspect_ratio?.[0] > 0 && f.sample_aspect_ratio?.[1] > 0
      ? f.sample_aspect_ratio[0] / f.sample_aspect_ratio[1] : f.sar;
    const init = {
      format: 'I420',
      codedWidth: f.width,
      codedHeight: f.height,
      timestamp,
      layout: f.layout ?? [
        { offset: 0, stride: f.width },
        { offset: f.width * f.height, stride: f.width / 2 },
        { offset: f.width * f.height * 1.25, stride: f.width / 2 },
      ],
      colorSpace: colourSpaceFor(f.height),
    };
    if (durationUs > 0) init.duration = durationUs;
    if (sar && Math.abs(sar - 1) > 0.001) {
      init.displayWidth = Math.max(1, Math.round(f.width * sar));
      init.displayHeight = f.height;
    }
    return { frame: new VideoFrame(f.data, init), timestamp };
  }

  async function* wasmVideo(session, fromS, interlace, dropBeforeUs) {
    const track = session.track;
    const frameUs = track.frameRate > 0 ? Math.round(1e6 / track.frameRate) : 40_000;
    const fromUs = Math.round(fromS * 1e6);
    let lastUs = fromUs - frameUs;
    let waitingForKey = fromS > 0 && dropBeforeUs == null;
    let dropped = 0;
    let backoff = 0;
    batches: for (;;) {
      if (closed) return;
      const decoded = await run(async () => {
        const { packets, eof, error } = await readBatch(session, VIDEO_READ_BYTES);
        const frames = await decodeVideoBatch(session, packets, eof || error, interlace);
        return { frames, done: eof || error };
      });
      for (const f of decoded.frames) {
        if (waitingForKey) {
          const key = (f.flags & AV_FRAME_FLAG_KEY) || f.key_frame || f.pict_type === AV_PICTURE_TYPE_I;
          if (!key && dropped < KEY_WAIT_FRAMES) { dropped += 1; continue; }
          const keyUs = frameTimeUs(f, session.timeBase);
          if (keyUs != null && keyUs > fromUs + frameUs / 2 && backoff < SEEK_BACKOFF_S.length) {
            // The seek landed past the target (index-less MPEG-PS/TS): seek again, earlier.
            await run(() => seek(session, Math.max(0, fromS - SEEK_BACKOFF_S[backoff])));
            backoff += 1;
            dropped = 0;
            continue batches;
          }
          waitingForKey = false;
        }
        const ts = frameTimeUs(f, session.timeBase);
        if (dropBeforeUs != null && ts != null && ts + frameUs <= dropBeforeUs) { lastUs = ts; continue; }
        const { frame, timestamp } = toVideoFrame(f, track, session.timeBase, lastUs + frameUs, frameUs);
        lastUs = timestamp;
        yield frame;
      }
      if (decoded.done) return;
    }
  }

  /** H.264 through WebCodecs, fed by libav's demuxer. Returns null when the browser refuses. */
  async function webcodecsVideo(session) {
    if (typeof globalThis.VideoDecoder !== 'function' || session.track.codec !== 'h264') return null;
    const extradata = await run(async () => {
      const par = session.stream.codecpar;
      const size = await lib.AVCodecParameters_extradata_size(par);
      const ptr = await lib.AVCodecParameters_extradata(par);
      return size > 0 && ptr ? await lib.copyout_u8(ptr, size) : null;
    });
    const avcc = extradata && extradata[0] === 1;
    return { extradata, avcc };
  }

  async function* webcodecsFrames(session, fromS, info) {
    const timeBase = session.timeBase;
    const queue = [];
    let failure = null;
    let wake = null;
    const notify = () => { const w = wake; wake = null; w?.(); };
    let configured = false;
    const decoder = new VideoDecoder({
      output: frame => { queue.push(frame); notify(); },
      error: error => { failure = error; notify(); },
    });
    session.webcodecs = { decoder };
    let waitingForKey = true;
    let eof = false;
    try {
      while (!eof || queue.length || (configured && decoder.decodeQueueSize > 0)) {
        if (closed) return;
        if (failure) throw failure;
        while (queue.length) {
          const frame = queue.shift();
          if (closed) { frame.close(); return; }
          yield frame;
        }
        if (eof) {
          if (configured) {
            await decoder.flush().catch(error => { failure ??= error; });
            configured = false;
          }
          if (!queue.length) break;
          continue;
        }
        if (decoder.decodeQueueSize >= WEBCODECS_QUEUE) {
          await new Promise(resolve => { wake = resolve; setTimeout(resolve, 20); });
          continue;
        }
        const batch = await run(() => readBatch(session, VIDEO_READ_BYTES));
        for (const packet of batch.packets) {
          const key = (packet.flags & 1) === 1;
          if (waitingForKey && !key) continue;
          if (!configured) {
            const codec = avcCodecString(info.extradata, packet.data);
            if (!codec) throw new Error('no H.264 parameter set found');
            const config = { codec, optimizeForLatency: false };
            if (info.avcc) config.description = info.extradata;
            const support = await VideoDecoder.isConfigSupported(config);
            if (!support.supported) throw new Error(`WebCodecs refuses ${codec}`);
            decoder.configure(config);
            configured = true;
          }
          waitingForKey = false;
          const timestamp = packetTimeUs(packet, timeBase) ?? 0;
          decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp, data: packet.data }));
        }
        if (batch.eof || batch.error) eof = true;
      }
      if (failure) throw failure;
    } finally {
      for (const frame of queue.splice(0)) frame.close();
    }
  }

  async function* videoFrames(fromS = 0, { trackId } = {}) {
    if (closed) return;
    const track = tracks.find(t => t.type === 'video' && (trackId == null || t.id === trackId));
    if (!track) return;
    const interlace = deinterlace;
    const start = Math.max(0, fromS);
    const { session, dropBeforeUs } = await positionedSession(track, start);
    try {
      const info = session.preferWasm || dropBeforeUs != null ? null : await webcodecsVideo(session);
      if (info) {
        let yielded = 0;
        try {
          for await (const frame of webcodecsFrames(session, fromS, info)) {
            yielded += 1;
            yield frame;
          }
          return;
        } catch (error) {
          if (yielded) throw error;
          // Refused before any frame: fall back to the wasm H.264 decoder from the same point.
          say(`libav: H.264 via WebCodecs unavailable (${error?.message ?? error}); decoding in wasm`);
          session.preferWasm = true;
          if (session.webcodecs) { try { session.webcodecs.decoder.close(); } catch { /* closed */ } session.webcodecs = null; }
          await run(() => seek(session, start));
        }
      }
      yield* wasmVideo(session, start, interlace, dropBeforeUs);
    } finally {
      await releaseSession(session);
    }
  }

  /* ---- audio ---- */

  async function* audioData(fromS = 0, { trackId } = {}) {
    if (closed) return;
    const track = tracks.find(t => t.type === 'audio' && (trackId == null || t.id === trackId));
    if (!track) return;
    const fromUs = Math.round(Math.max(0, fromS) * 1e6);
    const { session } = await positionedSession(track, Math.max(0, fromS));
    try {
      let nextUs = null;
      let firstAfterSeek = fromUs > 0;
      let backoff = 0;
      batches: for (;;) {
        if (closed) return;
        const decoded = await run(async () => {
          await ensureDecoder(session);
          const { packets, eof, error } = await readBatch(session, AUDIO_READ_BYTES);
          const { ctx, pkt, frame } = session.decoder;
          const frames = await lib.ff_decode_multi(ctx, pkt, frame, packets, { fin: eof || error, ignoreErrors: true });
          return { frames, done: eof || error };
        });
        for (const f of decoded.frames) {
          const { planes, frames } = audioPlanes(f);
          if (!frames || !planes.length) continue;
          const sampleRate = f.sample_rate || track.sampleRate;
          const timestamp = frameTimeUs(f, session.timeBase) ?? nextUs ?? fromUs;
          if (firstAfterSeek) {
            if (timestamp > fromUs + 50_000 && backoff < SEEK_BACKOFF_S.length) {
              await run(() => seek(session, Math.max(0, Math.max(0, fromS) - SEEK_BACKOFF_S[backoff])));
              backoff += 1;
              nextUs = null;
              continue batches;
            }
            firstAfterSeek = false;
          }
          const durationUs = Math.round((frames * 1e6) / sampleRate);
          nextUs = timestamp + durationUs;
          if (nextUs <= fromUs) continue; // wholly before the requested start
          const data = new Float32Array(frames * planes.length);
          planes.forEach((plane, c) => data.set(plane.subarray(0, frames), c * frames));
          yield audioBlock({
            format: 'f32-planar',
            sampleRate,
            numberOfFrames: frames,
            numberOfChannels: planes.length,
            timestamp,
            data,
          });
        }
        if (decoded.done) return;
      }
    } finally {
      await releaseSession(session);
    }
  }

  async function close() {
    if (closed) return;
    closed = true;
    const sessions = [...idle.values()].flat();
    idle.clear();
    try {
      if (!host.dead) {
        await run(async () => {
          for (const session of sessions) await freeSession(session);
          for (const name of [...devices]) await dropDevice(name);
        });
      }
    } catch { /* the instance is retired below or was already */ } finally {
      release(host);
    }
  }

  return {
    tracks,
    duration,
    startOffsetS: startS,
    decoderMode: host.mode,
    videoFrames,
    audioData,
    setDeinterlace(on) { deinterlace = !!on; },
    close,
  };
}

/** What this rung can open, for the engine's routing and the help sheet. */
export const LIBAV_RUNG = Object.freeze({
  pins: `vendor/libav/${PINS_FILE}`,
  licence: LICENCE,
  maxFrameSide: MAX_FRAME_SIDE,
  extensions: Object.freeze(['.avi', '.divx', '.xvid', '.flv', '.wmv', '.asf', '.mpg', '.mpeg', '.vob', '.ts', '.m2ts', '.mkv']),
});
