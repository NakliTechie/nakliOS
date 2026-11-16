// R3 software decode, streamed: long files decoded a slice at a time.
//
// The whole-file decode in libav.mjs holds the file, a copy of it inside the
// wasm filesystem and the decoded Float32 output all at once. For DSD that is
// ruinous: a five-minute DSD64 stereo track is about 210 MB in and, at the
// decoder's native 352.8 kHz, about 850 MB of Float32 out. This module keeps
// memory bounded instead:
//
// - The file is never read whole. libav's demuxer reads it through a block
//   reader device (`mkreadaheadfile`), which asks the Blob for one slice at a
//   time.
// - Decoded audio is resampled inside libav (its `aresample` filter) to the
//   caller's output rate, so DSD leaves the wasm heap at 44.1 or 48 kHz rather
//   than at 352.8 kHz.
// - `read()` returns about half a second of PCM per call. The caller decides
//   how far ahead to read; the engine keeps a few seconds.
// - Seek opens a fresh demuxer. On one open demuxer a second seek failed for
//   every container this build carries (observed 2026-11-17 in Node), so each
//   seek starts over. For DSF the start point is arithmetic: blocks have a
//   fixed size, so the demuxer is opened on a header rewritten for the tail of
//   the file plus a slice of the file starting at the block boundary. Other
//   containers reopen and use libav's timestamp seek once, then trim.
//
// Every libav handle (demuxer, decoder, packet, frame, filter graph, reader
// device) is freed on seek and on close. All stream operations run one at a
// time across every stream, because libav's reader devices suspend inside
// wasm and two suspended calls must not interleave.

/** Files above this size stream on the software rung even when they are not DSD. */
export const STREAM_MIN_BYTES = 64 * 1024 * 1024;

/** Seconds of PCM one `read()` aims to return. */
export const CHUNK_S = 0.5;

/** Bytes of the file's head read for sniffing and for the DSF header. */
export const HEAD_BYTES = 64 * 1024;

/** How far before a timestamp seek target a non-DSF reopen lands, so a coarse seek does not overshoot. */
const SEEK_MARGIN_S = 3;

/** True when a file of this container and size plays streamed rather than decoded whole. */
export function shouldStream(container, size) {
  return container === 'dsd' || Number(size) > STREAM_MIN_BYTES;
}

const fourcc = (data, at) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
const le32 = (data, at) => (data[at] | (data[at + 1] << 8) | (data[at + 2] << 16) | (data[at + 3] << 24)) >>> 0;
const le64 = (data, at) => le32(data, at) + le32(data, at + 4) * 2 ** 32;

function put64(data, at, value) {
  const low = value % 2 ** 32;
  const high = Math.floor(value / 2 ** 32);
  for (let index = 0; index < 4; index += 1) {
    data[at + index] = (low >>> (8 * index)) & 0xff;
    data[at + 4 + index] = (high >>> (8 * index)) & 0xff;
  }
}

/**
 * Read a DSF header: the 'DSD ' chunk, the 'fmt ' chunk and the 'data' chunk header.
 *
 * Returns null when the bytes are not a DSF file this module can seek in.
 * `headerBytes` is where the first audio byte sits. Audio is stored as groups
 * of one `blockSize`-byte block per channel; each byte holds 8 one-bit
 * samples, so one group lasts `blockSize * 8 / dsdRate` seconds.
 */
export function parseDsf(head) {
  if (!head || head.length < 92 || fourcc(head, 0) !== 'DSD ') return null;
  const fmtAt = le64(head, 4);
  if (fmtAt + 52 > head.length || fourcc(head, fmtAt) !== 'fmt ') return null;
  const fmtSize = le64(head, fmtAt + 4);
  const channels = le32(head, fmtAt + 24);
  const dsdRate = le32(head, fmtAt + 28);
  const sampleCount = le64(head, fmtAt + 36);
  const blockSize = le32(head, fmtAt + 44);
  const dataAt = fmtAt + fmtSize;
  if (dataAt + 12 > head.length || fourcc(head, dataAt) !== 'data') return null;
  const dataBytes = le64(head, dataAt + 4) - 12;
  return dsfUsable({ channels, dsdRate, blockSize, dataBytes }) ? {
    channels,
    dsdRate,
    pcmRate: dsdRate / 8,
    sampleCount,
    blockSize,
    fmtAt,
    dataAt,
    headerBytes: dataAt + 12,
    dataBytes,
    durationS: sampleCount / dsdRate,
  } : null;
}

/** Field values a DSF this module can seek in must have. */
function dsfUsable({ channels, dsdRate, blockSize, dataBytes }) {
  return channels >= 1 && channels <= 8 && dsdRate > 0 && blockSize > 0 && dataBytes > 0;
}

/**
 * Where a seek to `seconds` restarts a DSF file: the block group at or before it.
 *
 * `seconds` is the exact start time of that group, `byteOffset` the file
 * offset of its first byte. The caller trims the gap up to the target, at most
 * one group (11.6 ms with the usual 4096-byte blocks at DSD64).
 */
export function dsfSeekPoint(info, seconds) {
  const groupBytes = info.blockSize * info.channels;
  const groups = Math.ceil(info.dataBytes / groupBytes);
  const samplesPerGroup = info.blockSize * 8;
  const wanted = Math.floor((Math.max(0, Number(seconds) || 0) * info.dsdRate) / samplesPerGroup);
  const index = Math.max(0, Math.min(groups - 1, wanted));
  return {
    index,
    seconds: (index * samplesPerGroup) / info.dsdRate,
    byteOffset: info.headerBytes + index * groupBytes,
  };
}

/** A DSF header describing only the audio from `point` to the end, sizes rewritten. */
export function dsfTailHeader(head, info, point) {
  const header = head.slice(0, info.headerBytes);
  const remainingBytes = info.dataBytes - point.index * info.blockSize * info.channels;
  const remainingSamples = Math.max(0, info.sampleCount - point.index * info.blockSize * 8);
  put64(header, 12, info.headerBytes + remainingBytes); // total file size
  put64(header, 20, 0); // no metadata chunk in the tail
  put64(header, info.fmtAt + 36, remainingSamples);
  put64(header, info.dataAt + 4, remainingBytes + 12);
  return header;
}

/** A plain channel layout mask for a count, as libav.js derives one. */
function layoutFor(channels) {
  return channels === 1 ? 4 : (2 ** channels) - 1;
}

// One libav operation at a time across every stream; see the module comment.
let chain = Promise.resolve();
function serial(task) {
  const result = chain.then(task);
  chain = result.catch(() => {});
  return result;
}

let sequence = 0;
const live = new Set();
let closedWaiters = [];

function settleClosed() {
  if (live.size) return;
  const waiters = closedWaiters;
  closedWaiters = [];
  for (const resolve of waiters) resolve();
}

/** Streams open now. Exported for the gates. */
export function openStreamCount() {
  return live.size;
}

/** Resolves once every stream has closed and freed its handles. Exported for the gates. */
export function whenStreamsClosed() {
  if (!live.size) return Promise.resolve();
  return new Promise(resolve => closedWaiters.push(resolve));
}

/**
 * Build the stream opener around a libav instance getter and an error maker.
 *
 * Injected rather than imported so this module and libav.mjs do not import
 * each other: libav.mjs owns the instance and builds the opener from here.
 */
export function createStreamOpener({ instance, error }) {
  /**
   * Open `blob` for streamed decode at `outputRate`.
   *
   * Returns `{ sampleRate, channelCount, durationS, container, read(), seek(s), close() }`.
   * `read()` resolves to `{ channels: Float32Array[], frames, startS }` or null
   * at the end; `startS` is the chunk's position in the track.
   */
  return async function openLibavStream(blob, { container, outputRate }) {
    const libav = await instance();
    const head = new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer());
    const dsf = container === 'dsd' ? parseDsf(head) : null;
    if (container === 'dsd' && !dsf) {
      throw error('ERR_NAKLIAMP_LIBAV_FAILED', 'This DSD file has a header the streamed decoder cannot read.');
    }
    const rate = Math.round(Number(outputRate) || 48000);
    const handles = { name: null, format: null, context: null, packet: null, frame: null, graph: null, source: null, sink: null };
    const at = { index: -1, channels: 0, baseS: 0, skipUntilS: 0, nextS: 0, ended: false, readLimit: 64 * 1024, timeBase: [1, rate] };
    const info = { channelCount: 0, durationS: 0 };
    let closed = false;
    const id = ++sequence;
    live.add(id);

    async function freeHandles() {
      const { graph, context, packet, frame, format, name } = handles;
      if (graph) { try { await libav.avfilter_graph_free_js(graph); } catch { /* already gone */ } }
      if (context) { try { await libav.ff_free_decoder(context, packet, frame); } catch { /* already gone */ } }
      if (format) { try { await libav.avformat_close_input_js(format); } catch { /* already gone */ } }
      if (name) { try { await libav.unlinkreadaheadfile(name); } catch { /* never made */ } }
      for (const key of Object.keys(handles)) handles[key] = null;
    }

    /**
     * What the demuxer reads for a start at `seconds`: the file itself, or for
     * DSF a rewritten header plus the file from the block group at or before it.
     */
    function sourceAt(seconds) {
      at.baseS = 0;
      if (!dsf || seconds <= 0) return blob;
      const point = dsfSeekPoint(dsf, seconds);
      at.baseS = point.seconds;
      return new Blob([dsfTailHeader(head, dsf, point), blob.slice(point.byteOffset, dsf.headerBytes + dsf.dataBytes)]);
    }

    /** Open demuxer, decoder and resampler positioned at `seconds`. */
    async function openAt(seconds) {
      await freeHandles();
      const source = sourceAt(seconds);
      handles.name = `stream-${id}-${++sequence}.${container}`;
      await libav.mkreadaheadfile(handles.name, source);
      let streams;
      [handles.format, streams] = await libav.ff_init_demuxer_file(handles.name);
      const audio = streams.find(stream => stream.codec_type === libav.AVMEDIA_TYPE_AUDIO);
      if (!audio) throw error('ERR_NAKLIAMP_LIBAV_NO_AUDIO', 'This file has no audio stream.');
      at.index = audio.index;
      [, handles.context, handles.packet, handles.frame] = await libav.ff_init_decoder(audio.codec_id, audio.codecpar);
      await openResampler();
      if (!info.channelCount) learnShape(audio);
      at.timeBase = [audio.time_base_num || 1, audio.time_base_den || rate];
      if (!dsf && seconds > 0) await timestampSeek(seconds);
      at.skipUntilS = seconds;
      at.nextS = at.baseS;
      at.ended = false;
    }

    /** The resampler: decoder output in, FLTP at the output rate out. */
    async function openResampler() {
      const inRate = await libav.AVCodecContext_sample_rate(handles.context);
      const sampleFormat = await libav.AVCodecContext_sample_fmt(handles.context);
      const channels = await libav.AVCodecContext_ch_layout_nb_channels(handles.context);
      const layout = (await libav.AVCodecContext_channel_layoutmask(handles.context)) || layoutFor(channels);
      [handles.graph, handles.source, handles.sink] = await libav.ff_init_filter_graph(
        `aresample=${rate}`,
        { sample_rate: inRate, sample_fmt: sampleFormat, channel_layout: layout },
        { sample_rate: rate, sample_fmt: libav.AV_SAMPLE_FMT_FLTP, channel_layout: layout },
      );
      at.channels = channels;
    }

    /** Channel count, duration and the per-read byte budget, from the first open. */
    function learnShape(audio) {
      info.channelCount = at.channels;
      const reported = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0;
      info.durationS = dsf ? dsf.durationS : reported;
      const bytesPerSecond = info.durationS ? blob.size / info.durationS : 1024 * 1024;
      at.readLimit = Math.max(16 * 1024, Math.round(bytesPerSecond * CHUNK_S));
    }

    /**
     * libav's own seek, once, on a freshly opened demuxer, landing a margin
     * early. A refused seek leaves the demuxer at the start; the trim in
     * read() then discards everything before the target, slower but exact.
     */
    async function timestampSeek(seconds) {
      const landing = Math.max(0, seconds - SEEK_MARGIN_S);
      const timestamp = Math.round((landing * at.timeBase[1]) / at.timeBase[0]);
      try { await libav.av_seek_frame(handles.format, at.index, timestamp, 0); } catch { /* read from the start */ }
    }

    /** Join one batch of filtered frames into a chunk; null when it holds no samples. */
    function toChunk(frames) {
      if (!frames.length) return null;
      let total = 0;
      for (const frame of frames) total += frame.data[0].length;
      if (!total) return null;
      const channels = Array.from({ length: info.channelCount }, () => new Float32Array(total));
      let offset = 0;
      for (const frame of frames) {
        for (let channel = 0; channel < channels.length; channel += 1) {
          channels[channel].set(frame.data[channel] ?? frame.data[0], offset);
        }
        offset += frame.data[0].length;
      }
      const first = frames[0];
      const stamped = Number.isFinite(first.pts) && first.time_base_den
        ? at.baseS + (first.pts * first.time_base_num) / first.time_base_den
        : at.nextS;
      return { channels, frames: total, startS: stamped };
    }

    /** Drop the samples before the seek target; null when the whole chunk lies before it. */
    function trim(chunk) {
      if (!(at.skipUntilS > chunk.startS)) {
        at.skipUntilS = 0;
        return chunk;
      }
      const drop = Math.round((at.skipUntilS - chunk.startS) * rate);
      if (drop >= chunk.frames) return null;
      const startS = at.skipUntilS;
      at.skipUntilS = 0;
      return { channels: chunk.channels.map(channel => channel.subarray(drop)), frames: chunk.frames - drop, startS };
    }

    async function readChunk() {
      let emptyBatches = 0;
      for (let guard = 0; guard < 10_000 && !at.ended && !closed; guard += 1) {
        const [status, batch] = await libav.ff_read_frame_multi(handles.format, handles.packet, { limit: at.readLimit });
        const packets = batch[at.index] ?? [];
        const done = status === libav.AVERROR_EOF;
        if (done) at.ended = true;
        const frames = packets.length || done
          ? await libav.ff_decode_filter_multi(handles.context, handles.source, handles.sink, handles.packet, handles.frame, packets, { fin: done })
          : [];
        const whole = toChunk(frames);
        if (whole) {
          at.nextS = whole.startS + whole.frames / rate;
          const chunk = trim(whole);
          if (chunk) return chunk;
        }
        // The same rule as the whole-file read: a batch of other streams'
        // packets is ordinary, a demuxer that yields nothing at all has stopped.
        if (Object.values(batch).some(list => list.length)) emptyBatches = 0;
        else if ((emptyBatches += 1) >= 3) at.ended = true;
      }
      return null;
    }

    async function close() {
      if (closed) return;
      closed = true;
      try {
        await freeHandles();
      } finally {
        live.delete(id);
        settleClosed();
      }
    }

    try {
      await serial(() => openAt(0));
    } catch (cause) {
      await serial(close);
      if (cause?.code?.startsWith?.('ERR_NAKLIAMP_')) throw cause;
      throw error('ERR_NAKLIAMP_LIBAV_FAILED', `The software decoder could not read this file: ${cause?.message ?? cause}`, cause);
    }

    return Object.freeze({
      container,
      sampleRate: rate,
      channelCount: info.channelCount,
      durationS: info.durationS,
      streamed: true,
      read: () => serial(() => (closed ? null : readChunk())),
      seek: seconds => serial(() => (closed ? null : openAt(Math.max(0, Number(seconds) || 0)))),
      close: () => serial(close),
      /** Bytes of the input libav reads per batch: the compressed side of the memory bound. */
      readLimit: () => at.readLimit,
    });
  };
}
