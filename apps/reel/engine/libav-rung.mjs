// libav rung: software demux and decode for the formats Mediabunny and WebCodecs refuse.
//
// Containers: AVI, FLV, ASF/WMV, MPEG program stream (.mpg/.vob), MPEG-TS, Matroska.
// Video: MPEG-1/2, MPEG-4 Part 2 (Xvid, DivX), MS-MPEG-4 v1/v2/v3, WMV 7/8/9, VC-1,
// H.263, Sorenson Spark (FLV1) and H.264. Audio: MP1/2/3, AC-3, E-AC-3, AAC, WMA v1/v2,
// Nellymoser, ADPCM (MS, IMA, SWF) and PCM.
//
// The decoder is a custom libav.js 6.10.9.0 build (variant "reel", FFmpeg 9.0, LGPL-2.1,
// no --enable-gpl); see VENDOR.md, section "libav.js". It is loaded lazily, once, after a
// SHA-256 check of every file, and runs in its own Web Worker without threads, so it needs
// no COOP/COEP inside the NakliOS iframe. H.264 goes to WebCodecs when the browser accepts
// the configuration, because hardware decode is far faster than wasm; wasm is the fallback.
//
// Reading: the File is never read whole. Each demuxer opens a libav.js "readahead file"
// (mkreadaheadfile), a block device whose reads become File.slice(pos, pos + len) calls,
// with one block of read-ahead. A multi-GB file costs only the blocks in flight.
//
// Contract (docs/build/reel-v1-contract.md, "libav rung interface"):
//   openLibavSource(file, { requestDownload, log }) -> source, or null when libav cannot
//   open the file or finds no decodable track. Loading failures throw a LibavRungError
//   with a code (ERR_LIBAV_DECLINED, ERR_LIBAV_UNAVAILABLE, ERR_LIBAV_INTEGRITY).
//   source.tracks, source.duration, source.videoFrames(fromS), source.audioData(fromS),
//   source.close().
//
// Self-contained ES module: relative imports only, no DOM, no UI.

const VERSION = '6.10.9.0';
const VARIANT = 'reel';
const VENDOR_DIR = '../vendor/libav/';
const FILES = Object.freeze([
  { key: 'loader', name: `libav-${VERSION}-${VARIANT}.mjs`, bytes: 28408, type: 'text/javascript',
    sha256: '3b3de436145b875715c394d47946d62f38b7c90cea167bb016ee513ff37808ec' },
  { key: 'factory', name: `libav-${VERSION}-${VARIANT}.wasm.mjs`, bytes: 251298, type: 'text/javascript',
    sha256: '75eadd3ab9614c3b99099c33cca2fe6c43db59f7f5643adb58c1a245c9d11d55' },
  { key: 'wasm', name: `libav-${VERSION}-${VARIANT}.wasm.wasm`, bytes: 3516872, type: 'application/wasm',
    sha256: '505bbd5a65fa85990a6539f22b735b770d7807ad86c07e3cb080e6e25ed79304' },
]);
const TOTAL_BYTES = FILES.reduce((sum, file) => sum + file.bytes, 0);
const ASK_OVER_BYTES = 5 * 1024 * 1024;
const DOWNLOAD = Object.freeze({
  name: 'libav.js video decoder (Reel variant)',
  bytes: TOTAL_BYTES,
  licence: 'LGPL-2.1',
});

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

let instancePromise = null;

function hex(buffer) {
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function fetchVerified(file) {
  const url = new URL(VENDOR_DIR + file.name, import.meta.url).href;
  const response = await fetch(url);
  if (!response.ok) throw new LibavRungError('ERR_LIBAV_UNAVAILABLE', `${file.name} did not load (HTTP ${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (digest !== file.sha256) {
    throw new LibavRungError('ERR_LIBAV_INTEGRITY', `${file.name} failed its SHA-256 check (got ${digest.slice(0, 12)}).`);
  }
  return { url, blob: URL.createObjectURL(new Blob([bytes], { type: file.type })) };
}

const WORKER_START_MS = 20_000;

/** libav.js leaves its promise pending when the worker fails to load, so bound the wait. */
function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/** Serialise every call into one libav instance: libav.js uses Asyncify, which is not re-entrant. */
function serialiser() {
  let tail = Promise.resolve();
  return fn => {
    const run = tail.then(fn);
    tail = run.catch(() => {});
    return run;
  };
}

async function createInstance(requestDownload, log) {
  if (typeof WebAssembly !== 'object' || !globalThis.crypto?.subtle || typeof fetch !== 'function') {
    throw new LibavRungError('ERR_LIBAV_UNAVAILABLE', 'The software video decoder needs WebAssembly, Web Crypto and fetch.');
  }
  if (TOTAL_BYTES > ASK_OVER_BYTES) {
    const yes = typeof requestDownload === 'function' && (await requestDownload({ ...DOWNLOAD })) === true;
    if (!yes) throw new LibavRungError('ERR_LIBAV_DECLINED', `The ${DOWNLOAD.name} download was declined.`);
  }
  const urls = {};
  for (const file of FILES) urls[file.key] = await fetchVerified(file);
  const module = await import(urls.loader.blob);
  const LibAV = module.default ?? module;
  let lib;
  let mode = 'worker';
  try {
    if (typeof Worker !== 'function') throw new Error('no Worker');
    // The worker starts from the vendored URL, not a blob: in Chrome 2026-11 a blob-URL glue
    // worker given a blob-URL wasm failed to load, while either half alone loaded. The glue's
    // bytes were hash-checked above from the same URL; the wasm itself runs from the checked blob.
    lib = await withTimeout(
      LibAV.LibAV({ variant: VARIANT, toImport: urls.factory.url, wasmurl: urls.wasm.blob, nothreads: true }),
      WORKER_START_MS, 'the libav worker did not start');
  } catch (error) {
    // A page without module workers, or a worker that failed to start, decodes on this thread.
    log?.(`libav worker unavailable (${error?.message ?? error}); decoding on the page thread`);
    const factory = (await import(urls.factory.blob)).default;
    lib = await LibAV.LibAV({ variant: VARIANT, factory, wasmurl: urls.wasm.blob, noworker: true, nothreads: true });
    mode = 'direct';
  }
  await lib.av_log_set_level(AV_LOG_QUIET);
  return { lib, mode, run: serialiser(), sequence: 0 };
}

async function instance(requestDownload, log) {
  instancePromise ??= createInstance(requestDownload, log).catch(error => {
    instancePromise = null; // a decline or a network failure may be retried later
    throw error;
  });
  return instancePromise;
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
export async function openLibavSource(file, { requestDownload, log, deinterlace = false } = {}) {
  const say = message => { try { log?.(message); } catch { /* the host's logger failed; keep decoding */ } };
  const host = await instance(requestDownload, say);
  const { lib, run } = host;
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
    try { await lib.unlinkreadaheadfile(name); } catch { /* already gone */ }
  };

  // Probe: open once, read stream information, close.
  let probe;
  const probeName = deviceName();
  try {
    probe = await run(async () => {
      await lib.mkreadaheadfile(probeName, file);
      const [fmt, streams] = await lib.ff_init_demuxer_file(probeName);
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
    await run(() => dropDevice(probeName));
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
    await lib.mkreadaheadfile(name, file);
    const [fmt, streams] = await lib.ff_init_demuxer_file(name);
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
    if (closed) {
      await run(() => freeSession(session));
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
          yield new AudioData({
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
    await run(async () => {
      for (const session of sessions) await freeSession(session);
      for (const name of [...devices]) await dropDevice(name);
    });
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
  version: VERSION,
  variant: VARIANT,
  download: DOWNLOAD,
  extensions: Object.freeze(['.avi', '.divx', '.xvid', '.flv', '.wmv', '.asf', '.mpg', '.mpeg', '.vob', '.ts', '.m2ts', '.mkv']),
});
