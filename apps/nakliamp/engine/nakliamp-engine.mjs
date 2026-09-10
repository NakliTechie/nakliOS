import { createReelEngine } from './reel-engine.mjs';

export class NakliAmpError extends Error {
  constructor(name, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

const DEFAULT_CONFIG = Object.freeze({
  version: '0.2.0-m1',
  sync: { decodeAheadMs: 300, videoDropGraceMs: 20, audioRingSeconds: 1 },
  decode: {
    maxPacketsPerSample: 4096,
    videoLookaheadUs: 750_000,
    audioLookaheadUs: 250_000,
    queueFlushSize: 16,
  },
  demux: {
    probeTimeoutMs: 30_000,
    packetReadTimeoutMs: 30_000,
    subtitleScanTimeoutMs: 120_000,
    maxTrackCount: 256,
    ebmlWindowBytes: 4096,
    maxEbmlElements: 2_000_000,
    maxSubtitleCueBytes: 1024 * 1024,
    maxSubtitleCues: 100_000,
    maxSubtitleTextBytes: 64 * 1024 * 1024,
    maxCodecPrivateBytes: 256 * 1024,
  },
});

const MIME_BY_EXTENSION = Object.freeze({
  mp3: 'audio/mpeg',
  mp2: 'audio/mpeg',
  mpga: 'audio/mpeg',
  flac: 'audio/flac',
  m4a: 'audio/mp4',
  m4b: 'audio/mp4',
  m4r: 'audio/mp4',
  mp4: 'audio/mp4',
  aac: 'audio/aac',
  adts: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  spx: 'audio/ogg',
  wav: 'audio/wav',
  wave: 'audio/wav',
  aif: 'audio/aiff',
  aiff: 'audio/aiff',
  aifc: 'audio/aiff',
  caf: 'audio/x-caf',
  mka: 'audio/x-matroska',
  mkv: 'video/x-matroska',
  weba: 'audio/webm',
  webm: 'audio/webm',
  '3gp': 'audio/3gpp',
  amr: 'audio/amr',
});

/**
 * Errors that must not trigger the R1 to R2 fallback.
 * Two reasons: a superseded load is not a failure, and a named refusal is a
 * true statement about the file that a second attempt would only obscure.
 */
const FALLBACK_BLOCKED = Object.freeze(new Set([
  'ERR_NAKLIAMP_LOAD_SUPERSEDED',
  'ERR_ENGINE_LOAD_SUPERSEDED',
  'ERR_NAKLIAMP_NO_AUDIO',
]));

/**
 * Codecs the engine names and refuses, and no browser decodes either.
 *
 * Trying the native rung for these wastes a load and replaces a precise refusal
 * with a vague one. Trying the *software* rung is different: a build carrying a
 * decoder for them should use it, and one without it still ends at the original
 * named refusal.
 */
const SOFTWARE_ONLY_REFUSALS = Object.freeze(new Set([
  'ERR_DEMUX_WMA_REFUSED',
  'ERR_DEMUX_APE_REFUSED',
]));

function eventHub(externalEvents) {
  const listeners = new Map();
  const history = [];
  function emit(type, detail = {}) {
    const entry = { type, detail: structuredClone(detail), atMs: performance.now() };
    history.push(entry);
    if (history.length > 100) history.shift();
    for (const listener of listeners.get(type) || []) {
      try { listener(structuredClone(entry.detail)); } catch (_) {}
    }
    for (const listener of listeners.get('*') || []) {
      try { listener(structuredClone(entry)); } catch (_) {}
    }
    try { externalEvents?.emit?.(type, structuredClone(entry.detail)); } catch (_) {}
  }
  function on(type, listener) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(listener);
    return () => listeners.get(type)?.delete(listener);
  }
  return Object.freeze({ emit, on, history: () => structuredClone(history) });
}

async function fingerprint(file) {
  const head = new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer());
  const digest = await crypto.subtle.digest('SHA-256', head);
  const hex = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  return `${file.size}-${hex.slice(0, 24)}`;
}

async function localFile(value) {
  if (value instanceof Blob) return value;
  if (value && typeof value.getFile === 'function') return value.getFile();
  throw new NakliAmpError(
    'InvalidMediaInputError',
    'ERR_NAKLIAMP_LOCAL_INPUT',
    'NakliAmp accepts a local File, Blob, or file handle.',
  );
}

function extensionOf(name = '') {
  return String(name).toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || '';
}

function nativeMime(file) {
  return file.type || MIME_BY_EXTENSION[extensionOf(file.name)] || '';
}

function defaultNativeAudioFactory({ url }) {
  const audio = new Audio();
  audio.preload = 'metadata';
  audio.src = url;
  return audio;
}

/**
 * Whether the browser claims it can play a MIME type, asked without building
 * any playback object. Injected factories are exempt: a test double decides for
 * itself, and its own `canPlayType` is still consulted below.
 */
function canPlayNatively(mime) {
  // `new Audio()` with no source starts no load, so this is a pure question.
  if (typeof Audio !== 'function') return true;
  try {
    return Boolean(new Audio().canPlayType(mime));
  } catch (_) {
    return true;
  }
}

function waitForNativeMetadata(audio, timeoutMs) {
  if (audio.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      audio.removeEventListener('loadedmetadata', onReady);
      audio.removeEventListener('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new NakliAmpError(
        'NativePlaybackError',
        'ERR_NAKLIAMP_NATIVE_LOAD',
        'The browser native audio path could not read this file.',
      ));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new NakliAmpError(
        'NativePlaybackTimeoutError',
        'ERR_NAKLIAMP_NATIVE_TIMEOUT',
        `The browser native audio path exceeded ${timeoutMs} ms.`,
      ));
    }, timeoutMs);
    audio.addEventListener('loadedmetadata', onReady, { once: true });
    audio.addEventListener('error', onError, { once: true });
    audio.load();
  });
}

/**
 * Pick the audio track to play.
 * Only a file with no audio at all is refused. A file that also carries video
 * is played for its audio: people throw music videos and rips at a music
 * player, and refusing them serves nobody.
 */
function selectAudioTrack(metadata) {
  const audioTrack = metadata.tracks.find(track => track.type === 'audio');
  if (!audioTrack) {
    throw new NakliAmpError(
      'AudioTrackUnavailableError',
      'ERR_NAKLIAMP_NO_AUDIO',
      'NakliAmp could not find an audio track in this file.',
    );
  }
  return audioTrack;
}

function hasVideoTrack(metadata) {
  return metadata.tracks.some(track => track.type === 'video');
}

/**
 * Minimal metadata for a file the engine could not probe.
 * The browser is then the only judge of whether it plays, which is the point:
 * an unrecognised container is not the same thing as an unplayable one.
 */
function unprobedMetadata(file) {
  const extension = extensionOf(file.name);
  return {
    name: file.name || 'Untitled track',
    size: file.size,
    duration: null,
    container: extension || null,
    mimeType: file.type || MIME_BY_EXTENSION[extension] || null,
    tracks: [{ type: 'audio', codec: null, sampleRate: null, channels: null }],
  };
}

/**
 * Software decoders for the R3 rung.
 *
 * Injected rather than imported, so the engine never depends on which decoders
 * a build ships. The lean build passes the in-house PCM tier; the full build
 * adds the wasm tier. Each decoder is:
 *
 *   { name, sniff(Uint8Array) -> string|null, decode(Uint8Array) -> Decoded }
 *
 * where Decoded is `{ sampleRate, channels: Float32Array[], frames }`. Both
 * methods may return a promise, so a decoder that must instantiate a wasm
 * module before it can answer is supported without the engine changing.
 */
export function createNakliAmpEngine({
  version = DEFAULT_CONFIG.version,
  forcePath = 'auto',
  nativeAudioFactory = defaultNativeAudioFactory,
  softwareDecoders = [],
  audioContextFactory = () => new AudioContext(),
  events: externalEvents = null,
} = {}) {
  if (!['auto', 'r1', 'r2'].includes(forcePath)) {
    throw new TypeError(`Unknown NakliAmp playback path: ${forcePath}`);
  }

  const events = eventHub(externalEvents);
  const store = {
    media: { handle: null, name: null, fingerprint: null, duration: null },
    tracks: { audio: [], video: [], subtitle: [], selected: { video: 0, audio: 0, subtitle: -1 } },
    clock: { positionS: 0, playing: false, rate: 1, volume: 1, muted: false },
    ui: { screen: 'empty', devAgentFace: false },
  };
  const reel = createReelEngine({
    config: { ...DEFAULT_CONFIG, version },
    store,
    storage: { fingerprint },
    metadataSync: { state: () => ({ mode: 'local', lastError: null }) },
    events,
  });

  let mode = null;
  let status = 'idle';
  let nativeAudio = null;
  let nativeUrl = null;
  let nativeMetadata = null;
  let nativeGraph = null;
  let nativeFingerprint = null;
  let lastError = null;
  let latestLoadId = 0;
  let fellBackFrom = null;
  let software = null;
  let analyser = null;
  let analyserOwner = null;
  let splitter = null;
  let channelAnalysers = null;

  function preferredMode() {
    if (forcePath === 'r1') return 'r1';
    if (forcePath === 'r2') return 'r2';
    return reel.caps().audioDecoder ? 'r1' : 'r2';
  }

  /**
   * A spectrum tap on whichever rung is playing.
   *
   * One analyser for all three rungs, because a visualiser that works on some
   * files and not others is worse than none. R1 uses the seam Reel exposes,
   * R2 routes the native element through Web Audio, R3 already owns its graph.
   *
   * Returns null when nothing is playing or the rung cannot be tapped, and the
   * caller is expected to show no visualiser rather than a fake one.
   */
  function audioAnalyser() {
    if (!mode) return null;
    try {
      const graph = rungGraph();
      if (!graph) return null;
      // Keyed on the output node itself, not on the rung. The engine builds a
      // fresh gain node for each track, so a tap cached per rung stays bolted
      // to a node that has been replaced and reports silence for every track
      // after the first.
      if (analyser && analyserOwner === graph.output) return analyser;
      disposeAnalyser();
      const next = graph.context.createAnalyser();
      next.fftSize = 2048;
      next.smoothingTimeConstant = 0.72;
      // Inserted in parallel, never in series: the tap must not sit between the
      // output and the destination, where a mistake would silence playback.
      graph.output.connect(next);
      analyser = next;
      analyserOwner = graph.output;
      return analyser;
    } catch (_) {
      return null;
    }
  }

  /**
   * A tap per channel, for a visualiser that claims to show left and right.
   *
   * `audioAnalyser` is a single node on the summed output, so anything drawn
   * from it has no channel information in it at all — a mode that split those
   * bins in half and labelled the halves "left" and "right" was stating
   * something the data could not support. A ChannelSplitterNode gives the two
   * genuinely, on whichever rung is playing.
   *
   * A mono source up-mixes, so both taps report the same thing — which for a
   * mono file is the truth rather than a stand-in for it.
   *
   * Returns null when the rung cannot be tapped; the caller then has one
   * spectrum and should say so, not invent a second.
   */
  function audioChannelAnalysers() {
    if (!mode) return null;
    try {
      const graph = rungGraph();
      if (!graph) return null;
      // Shares `analyserOwner` with the summed tap: both hang off the same
      // output node and both go when that node is replaced.
      if (channelAnalysers && analyserOwner === graph.output) return channelAnalysers;
      // Building the summed tap first is what establishes the owner.
      if (!audioAnalyser()) return null;
      const split = graph.context.createChannelSplitter(2);
      // In parallel, like the summed tap: never between output and destination.
      graph.output.connect(split);
      const taps = [0, 1].map(channel => {
        const node = graph.context.createAnalyser();
        node.fftSize = 2048;
        node.smoothingTimeConstant = 0.72;
        split.connect(node, channel);
        return node;
      });
      splitter = split;
      channelAnalysers = taps;
      return taps;
    } catch (_) {
      return null;
    }
  }

  function rungGraph() {
    if (mode === 'r3' && software) return { context: software.context, output: software.gain };
    if (mode === 'r1') return reel.audioGraph?.() ?? null;
    if (mode === 'r2' && nativeAudio) {
      if (!nativeGraph) {
        // createMediaElementSource reroutes the element through Web Audio, so
        // the destination has to be reconnected or playback goes silent.
        const AudioContextClass = globalThis.AudioContext || globalThis.webkitAudioContext;
        if (!AudioContextClass || typeof nativeAudio.play !== 'function') return null;
        const context = new AudioContextClass();
        // Hazard worth naming: createMediaElementSource permanently reroutes
        // the element through Web Audio and cannot be undone. If the context
        // is suspended by autoplay policy, that means silence. So the graph is
        // only built once the context is actually running, and until then the
        // caller gets null and shows no visualiser rather than risking audio.
        if (context.state === 'suspended') {
          context.resume().catch(() => {});
          try { context.close(); } catch (_) {}
          return null;
        }
        const source = context.createMediaElementSource(nativeAudio);
        const output = context.createGain();
        source.connect(output);
        output.connect(context.destination);
        nativeGraph = { context, output };
      }
      return nativeGraph;
    }
    return null;
  }

  function disposeAnalyser() {
    try { analyser?.disconnect(); } catch (_) {}
    try { splitter?.disconnect(); } catch (_) {}
    for (const node of channelAnalysers ?? []) { try { node.disconnect(); } catch (_) {} }
    analyser = null;
    splitter = null;
    channelAnalysers = null;
    analyserOwner = null;
  }

  /**
   * Stop the current BufferSource, keeping the graph.
   * A BufferSource is single-use, so play, pause and seek all end one and
   * build another against the same context, buffer and gain.
   */
  function stopSoftwareSource() {
    try { software?.source?.stop(); } catch (_) {}
    try { software?.source?.disconnect(); } catch (_) {}
    if (software) software.source = null;
  }

  /**
   * Give the whole R3 graph back.
   *
   * An AudioContext holds a live audio thread and, through the buffer, the
   * entire decoded track: a five-minute 44.1 kHz stereo AIFF is about 105 MB
   * of Float32. Only the source used to be stopped, so every R3 load left the
   * previous context open with its buffer still reachable, and twelve loads
   * meant twelve live contexts. Browsers also cap how many a page may hold, so
   * this eventually stops playback outright rather than merely wasting memory.
   */
  function releaseSoftware() {
    stopSoftwareSource();
    try { software?.gain?.disconnect(); } catch (_) {}
    // `close()` is async and nothing waits for it: this is teardown, and a
    // context that refuses to close is not a reason to fail the next load.
    try { software?.context?.close?.()?.catch?.(() => {}); } catch (_) {}
    software = null;
  }

  /**
   * Play a decoded buffer through Web Audio.
   * A BufferSource is single-use, so every play builds a new one and the clock
   * is kept as an offset plus the context's own time rather than read from the
   * node, which reports nothing after it stops.
   */
  function softwarePlayback(decoded, name, size, container) {
    const context = audioContextFactory();
    const buffer = context.createBuffer(decoded.channels.length, decoded.frames, decoded.sampleRate);
    for (const [index, channel] of decoded.channels.entries()) {
      buffer.copyToChannel(channel.subarray(0, decoded.frames), index);
    }
    const gain = context.createGain();
    gain.connect(context.destination);
    return {
      context, buffer, gain,
      source: null,
      name, size, container,
      decoderName: decoded.decoderName,
      offsetS: 0,
      startedAt: 0,
      playing: false,
      volume: 1,
      muted: false,
      durationS: decoded.frames / decoded.sampleRate,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels.length,
    };
  }

  function softwarePosition() {
    if (!software) return 0;
    const elapsed = software.playing ? software.context.currentTime - software.startedAt : 0;
    return Math.min(software.durationS, software.offsetS + elapsed);
  }

  function disposeNative() {
    try { nativeAudio?.pause(); } catch (_) {}
    try { nativeAudio?.removeAttribute?.('src'); } catch (_) {}
    try { nativeAudio?.load(); } catch (_) {}
    if (nativeUrl) URL.revokeObjectURL(nativeUrl);
    try { nativeGraph?.output?.disconnect(); } catch (_) {}
    try { nativeGraph?.context?.close?.(); } catch (_) {}
    nativeGraph = null;
    nativeAudio = null;
    nativeUrl = null;
  }

  function disposeNativeCandidate(audio, url) {
    try { audio?.pause?.(); } catch (_) {}
    URL.revokeObjectURL(url);
  }

  function recordError(error) {
    lastError = {
      name: error?.name || 'Error',
      code: error?.code || 'ERR_NAKLIAMP_UNKNOWN',
      message: error?.message || String(error),
    };
    status = 'refused';
    events.emit('playback:refused', lastError);
  }

  async function loadR1(input, loadId) {
    const metadata = await reel.load(input);
    if (loadId !== latestLoadId) {
      throw new NakliAmpError(
        'SupersededLoadError',
        'ERR_NAKLIAMP_LOAD_SUPERSEDED',
        'A newer track selection replaced this request.',
      );
    }
    const track = selectAudioTrack(metadata);
    releaseSoftware();
    if (hasVideoTrack(metadata)) {
      throw new NakliAmpError(
        'VideoMediaDeferredError',
        'ERR_NAKLIAMP_VIDEO_MEDIA',
        'This file carries video; NakliAmp plays its audio on the native path.',
      );
    }
    disposeNative();
    mode = 'r1';
    status = 'ready';
    nativeMetadata = null;
    nativeFingerprint = null;
    lastError = null;
    events.emit('track:loaded', {
      name: metadata.name,
      container: metadata.container,
      codec: track.codec,
      path: mode,
    });
    return structuredClone({ ...metadata, audioTrack: track, path: mode });
  }

  async function loadR2(input, loadId) {
    const file = await localFile(input);
    // The native path must not depend on the engine understanding the file.
    // If it did, any container the engine has never heard of would be a dead
    // end even when the browser can play it perfectly well.
    let metadata;
    let probeFailure = null;
    try {
      metadata = await reel.probe(file);
    } catch (error) {
      if (FALLBACK_BLOCKED.has(error?.code)) throw error;
      probeFailure = error;
      metadata = unprobedMetadata(file);
    }
    const track = selectAudioTrack(metadata);
    const videoIgnored = hasVideoTrack(metadata);
    const mime = nativeMime(file);

    // Ask whether the browser can play this before handing it anything. Building
    // the element first starts a load that is already known to fail, which costs
    // a wasted fetch and leaves a media error in the console for a file the
    // ladder goes on to play perfectly well on the next rung.
    // Only when the real element is in play. An injected factory is the
    // authority on what it can accept, and its own `canPlayType` is consulted
    // below; probing the browser instead would overrule the injection.
    if (mime && nativeAudioFactory === defaultNativeAudioFactory && !canPlayNatively(mime)) {
      throw new NakliAmpError(
        'NativeCodecUnsupportedError',
        'ERR_NAKLIAMP_NATIVE_UNSUPPORTED',
        `The browser native audio path does not support ${track.codec || extensionOf(file.name) || 'this codec'}.`,
      );
    }

    const candidateUrl = URL.createObjectURL(file);
    let candidateAudio;
    let adopted = false;
    try {
      candidateAudio = nativeAudioFactory({ url: candidateUrl, file, metadata });
      if (!candidateAudio || typeof candidateAudio.play !== 'function') {
        throw new TypeError('nativeAudioFactory must return an audio-like playback object.');
      }
      if (mime && typeof candidateAudio.canPlayType === 'function' && !candidateAudio.canPlayType(mime)) {
        throw new NakliAmpError(
          'NativeCodecUnsupportedError',
          'ERR_NAKLIAMP_NATIVE_UNSUPPORTED',
          `The browser native audio path does not support ${track.codec || extensionOf(file.name) || 'this codec'}.`,
        );
      }
      await waitForNativeMetadata(candidateAudio, DEFAULT_CONFIG.demux.probeTimeoutMs);
      const nextFingerprint = await fingerprint(file);
      if (loadId !== latestLoadId) {
        throw new NakliAmpError(
          'SupersededLoadError',
          'ERR_NAKLIAMP_LOAD_SUPERSEDED',
          'A newer track selection replaced this request.',
        );
      }
      reel.pause();
      disposeNative();
      disposeAnalyser();
      releaseSoftware();
      nativeAudio = candidateAudio;
      nativeUrl = candidateUrl;
      nativeMetadata = {
        ...metadata,
        videoIgnored,
        name: file.name || metadata.name,
        duration: Number.isFinite(candidateAudio.duration) ? candidateAudio.duration : metadata.duration,
        unprobed: Boolean(probeFailure),
      };
      nativeFingerprint = nextFingerprint;
      mode = 'r2';
      status = 'ready';
      lastError = null;
      adopted = true;
      events.emit('track:loaded', {
        name: nativeMetadata.name,
        container: metadata.container,
        codec: track.codec,
        path: mode,
      });
      return structuredClone({ ...nativeMetadata, audioTrack: track, path: mode });
    } catch (error) {
      if (!adopted) disposeNativeCandidate(candidateAudio, candidateUrl);
      throw error;
    }
  }

  /**
   * R3: decode in software.
   * Reached only when the engine could not demux the file and the browser could
   * not play it either, which is exactly the case a software decoder exists for.
   */
  async function loadR3(input, loadId) {
    if (!softwareDecoders.length) {
      throw new NakliAmpError(
        'SoftwareDecodeUnavailableError',
        'ERR_NAKLIAMP_NO_SOFTWARE_DECODER',
        'This build has no software decoder for this file.',
      );
    }
    const file = await localFile(input);
    const bytes = new Uint8Array(await file.arrayBuffer());

    let decoded = null;
    let lastFailure = null;
    for (const decoder of softwareDecoders) {
      let container = null;
      try {
        container = await decoder.sniff(bytes);
      } catch (_) {
        container = null;
      }
      if (!container) continue;
      try {
        // Awaited, so a decoder may be asynchronous. A wasm decoder has to
        // instantiate its module before it can decode anything, and the
        // in-house tier is unaffected: awaiting a plain value is a no-op.
        decoded = { ...(await decoder.decode(bytes)), decoderName: decoder.name, container };
        break;
      } catch (error) {
        // A decoder that recognised the file and then failed has the most
        // specific thing to say about it, so its reason is the one kept.
        lastFailure = error;
      }
    }
    if (!decoded) {
      throw lastFailure ?? new NakliAmpError(
        'SoftwareDecodeUnsupportedError',
        'ERR_NAKLIAMP_SOFTWARE_UNSUPPORTED',
        'No software decoder in this build recognises this file.',
      );
    }
    if (loadId !== latestLoadId) {
      throw new NakliAmpError(
        'SupersededLoadError',
        'ERR_NAKLIAMP_LOAD_SUPERSEDED',
        'A newer track selection replaced this request.',
      );
    }

    reel.pause();
    disposeNative();
    disposeAnalyser();
    releaseSoftware();
    software = softwarePlayback(decoded, file.name, file.size, decoded.container);
    mode = 'r3';
    status = 'ready';
    lastError = null;
    events.emit('track:loaded', {
      name: file.name,
      container: decoded.container,
      codec: 'pcm',
      path: mode,
    });
    return structuredClone({
      name: file.name,
      size: file.size,
      duration: software.durationS,
      container: decoded.container,
      tracks: [{ type: 'audio', codec: 'pcm', sampleRate: decoded.sampleRate, channels: decoded.channels.length }],
      path: mode,
    });
  }

  async function load(input) {
    const loadId = ++latestLoadId;
    status = 'loading';
    fellBackFrom = null;
    const nextMode = preferredMode();
    try {
      return nextMode === 'r1' ? await loadR1(input, loadId) : await loadR2(input, loadId);
    } catch (error) {
      // R1 to R2 fallback. Without it, anything the engine cannot demux is a
      // dead end even when the browser itself could play the file — the single
      // largest gap between "an engine proof" and "throw anything at it".
      // A named codec refusal skips the native rung and goes straight to
      // software, which is the only rung that could ever play it.
      if (nextMode === 'r1'
        && forcePath === 'auto'
        && loadId === latestLoadId
        && softwareDecoders.length
        && SOFTWARE_ONLY_REFUSALS.has(error?.code)) {
        try {
          const loaded = await loadR3(input, loadId);
          fellBackFrom = error.code;
          events.emit('playback:fallback', { from: 'r1', to: 'r3', code: error.code });
          return { ...loaded, fellBackFrom };
        } catch (softwareError) {
          if (loadId !== latestLoadId) throw softwareError;
          // No decoder in this build claimed it, so the original named refusal
          // is still the truest thing we can say.
          recordError(error);
          throw error;
        }
      }

      if (nextMode === 'r1'
        && forcePath === 'auto'
        && loadId === latestLoadId
        && !FALLBACK_BLOCKED.has(error?.code)
        && !SOFTWARE_ONLY_REFUSALS.has(error?.code)) {
        try {
          const loaded = await loadR2(input, loadId);
          fellBackFrom = error?.code ?? 'ERR_NAKLIAMP_R1_FAILED';
          events.emit('playback:fallback', { from: 'r1', to: 'r2', code: fellBackFrom });
          return { ...loaded, fellBackFrom };
        } catch (fallbackError) {
          if (loadId !== latestLoadId) throw fallbackError;
          // R3: the browser refused too, so try decoding it ourselves.
          if (softwareDecoders.length && !FALLBACK_BLOCKED.has(fallbackError?.code)) {
            try {
              const loaded = await loadR3(input, loadId);
              fellBackFrom = error?.code ?? 'ERR_NAKLIAMP_R1_FAILED';
              events.emit('playback:fallback', { from: 'r2', to: 'r3', code: fallbackError?.code });
              return { ...loaded, fellBackFrom };
            } catch (softwareError) {
              if (loadId !== latestLoadId) throw softwareError;
              // Report the native refusal, not the software one: the browser's
              // reason is the more useful of the two for a file it knows.
              if (softwareError?.code === 'ERR_NAKLIAMP_SOFTWARE_UNSUPPORTED') {
                recordError(fallbackError);
                throw fallbackError;
              }
              recordError(softwareError);
              throw softwareError;
            }
          }
          recordError(fallbackError);
          throw fallbackError;
        }
      }
      // R2 to R3, when the browser was the *first* rung rather than the
      // second. Both blocks above are gated on having started at R1, so on a
      // browser without WebCodecs `AudioDecoder` the software rung was
      // unreachable and AIFF, CAF and AU were refused outright — on exactly
      // the browsers most likely to need it. "Tries every rung before it gives
      // up" has to mean every rung it actually has.
      if (nextMode === 'r2'
        && forcePath === 'auto'
        && loadId === latestLoadId
        && softwareDecoders.length
        && !FALLBACK_BLOCKED.has(error?.code)) {
        try {
          const loaded = await loadR3(input, loadId);
          fellBackFrom = error?.code ?? 'ERR_NAKLIAMP_R2_FAILED';
          events.emit('playback:fallback', { from: 'r2', to: 'r3', code: error?.code });
          return { ...loaded, fellBackFrom };
        } catch (softwareError) {
          if (loadId !== latestLoadId) throw softwareError;
          // The browser's reason for refusing a file it recognises is more
          // useful than "no decoder claimed it".
          if (softwareError?.code === 'ERR_NAKLIAMP_SOFTWARE_UNSUPPORTED') {
            recordError(error);
            throw error;
          }
          recordError(softwareError);
          throw softwareError;
        }
      }

      if (loadId !== latestLoadId) {
        throw new NakliAmpError(
          'SupersededLoadError',
          'ERR_NAKLIAMP_LOAD_SUPERSEDED',
          'A newer track selection replaced this request.',
          error,
        );
      }
      if (error?.code !== 'ERR_NAKLIAMP_LOAD_SUPERSEDED' && error?.code !== 'ERR_ENGINE_LOAD_SUPERSEDED') recordError(error);
      throw error;
    }
  }

  async function play() {
    if (mode === 'r3' && software) {
      if (software.context.state === 'suspended') await software.context.resume();
      stopSoftwareSource();
      const source = software.context.createBufferSource();
      source.buffer = software.buffer;
      source.connect(software.gain);
      source.onended = () => { if (software?.playing) software.playing = false; };
      source.start(0, Math.min(software.offsetS, software.durationS));
      software.source = source;
      software.startedAt = software.context.currentTime;
      software.playing = true;
    } else if (mode === 'r1') await reel.play();
    else if (mode === 'r2' && nativeAudio) await nativeAudio.play();
    else throw new NakliAmpError('NoTrackError', 'ERR_NAKLIAMP_NO_TRACK', 'Open an audio file before playing.');
    status = 'playing';
    events.emit('transport:play', { positionS: state().clock.positionS, path: mode });
  }

  function pause() {
    if (mode === 'r3' && software) {
      software.offsetS = softwarePosition();
      software.playing = false;
      stopSoftwareSource();
    }
    if (mode === 'r1') reel.pause();
    if (mode === 'r2') nativeAudio?.pause();
    if (mode) status = 'paused';
    events.emit('transport:pause', { positionS: state().clock.positionS, path: mode });
  }

  async function seek(positionS) {
    const duration = state().media.duration;
    const next = Math.max(0, Math.min(Number.isFinite(duration) ? duration : Infinity, Number(positionS) || 0));
    if (mode === 'r3' && software) {
      const wasPlaying = software.playing;
      stopSoftwareSource();
      software.offsetS = next;
      software.playing = false;
      if (wasPlaying) await play();
    } else if (mode === 'r1') await reel.seek(next);
    else if (mode === 'r2' && nativeAudio) nativeAudio.currentTime = next;
    else throw new NakliAmpError('NoTrackError', 'ERR_NAKLIAMP_NO_TRACK', 'Open an audio file before seeking.');
    events.emit('transport:seek', { positionS: next, path: mode });
  }

  function applySoftwareGain() {
    if (software?.gain) software.gain.gain.value = software.muted ? 0 : software.volume;
  }

  function setVolume(value) {
    const next = Math.max(0, Math.min(1, Number(value) || 0));
    if (mode === 'r1') reel.setVolume(next);
    if (nativeAudio) nativeAudio.volume = next;
    if (software) { software.volume = next; applySoftwareGain(); }
  }

  function setMuted(value) {
    const next = !!value;
    if (mode === 'r1') reel.setMuted(next);
    if (nativeAudio) nativeAudio.muted = next;
    if (software) { software.muted = next; applySoftwareGain(); }
  }

  function state() {
    if (mode === 'r1') {
      const upstream = reel.state();
      const track = upstream.tracks.audio[upstream.tracks.selected.audio] || null;
      return structuredClone({
        version,
        status,
        path: mode,
        media: upstream.media,
        track,
        clock: upstream.clock,
        honesty: {
          container: upstream.media.container,
          codec: track?.codec || null,
          decode: 'AudioDecoder',
          output: 'AudioWorklet · Web Audio',
          gapless: null,
          localOnly: true,
          fellBackFrom: null,
          videoIgnored: false,
        },
        diagnostics: {
          consumedFrames: upstream.playback.audio.consumedFrames,
          droppedFrames: upstream.playback.audio.droppedFrames,
          lastError: upstream.playback.lastError,
        },
        error: lastError,
      });
    }
    if (mode === 'r3' && software) {
      return structuredClone({
        version,
        status: software.playing ? 'playing' : status === 'ready' ? 'ready' : 'paused',
        path: mode,
        media: {
          name: software.name,
          fingerprint: null,
          duration: software.durationS,
          size: software.size,
          container: software.container,
          mimeType: null,
        },
        track: { type: 'audio', codec: 'pcm', sampleRate: software.sampleRate, channels: software.channels },
        clock: {
          positionS: softwarePosition(),
          playing: software.playing,
          rate: 1,
          volume: software.volume,
          muted: software.muted,
        },
        honesty: {
          container: software.container,
          codec: 'pcm',
          decode: `software decode (${software.decoderName})`,
          output: 'Web Audio',
          gapless: false,
          localOnly: true,
          fellBackFrom,
          videoIgnored: false,
        },
        diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
        error: lastError,
      });
    }
    if (mode === 'r2' && nativeAudio && nativeMetadata) {
      const track = nativeMetadata.tracks.find(candidate => candidate.type === 'audio') || null;
      return structuredClone({
        version,
        status: nativeAudio.paused ? (status === 'ready' ? 'ready' : 'paused') : 'playing',
        path: mode,
        media: {
          name: nativeMetadata.name,
          fingerprint: nativeFingerprint,
          duration: nativeMetadata.duration,
          size: nativeMetadata.size,
          container: nativeMetadata.container,
          mimeType: nativeMetadata.mimeType,
        },
        track,
        clock: {
          positionS: Number(nativeAudio.currentTime) || 0,
          playing: !nativeAudio.paused,
          rate: Number(nativeAudio.playbackRate) || 1,
          volume: Number(nativeAudio.volume) || 0,
          muted: !!nativeAudio.muted,
        },
        honesty: {
          container: nativeMetadata.container,
          codec: track?.codec || null,
          decode: nativeMetadata.unprobed ? 'browser native audio (container unrecognised)' : 'browser native audio',
          output: 'native audio element',
          gapless: false,
          localOnly: true,
          // Both facts the strip must state rather than hide: why this file is
          // not on the engine path, and that a video track went unplayed.
          fellBackFrom,
          videoIgnored: Boolean(nativeMetadata.videoIgnored),
        },
        diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
        error: lastError,
      });
    }
    return structuredClone({
      version,
      status,
      path: mode,
      media: { name: null, fingerprint: null, duration: null, size: null, container: null, mimeType: null },
      track: null,
      clock: { positionS: 0, playing: false, rate: 1, volume: 1, muted: false },
      honesty: null,
      diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
      error: lastError,
    });
  }

  /**
   * Give everything back.
   *
   * The app never calls this — a player's teardown is the tab closing — but
   * the engine is a separable module with its own consumers, and the gates
   * lean on it to prove a load leaves nothing behind. It stays because
   * "nothing in this page happens to call it" is not the same as unused.
   */
  function destroy() {
    latestLoadId += 1;
    reel.pause();
    disposeNative();
    // The R3 graph and the spectrum tap outlive the element otherwise: a
    // destroyed engine left a live audio thread and a decoded track behind.
    disposeAnalyser();
    releaseSoftware();
    mode = null;
    status = 'idle';
  }

  return Object.freeze({
    version,
    caps: () => ({ ...reel.caps(), nativeAudio: typeof Audio === 'function', preferredPath: preferredMode() }),
    load,
    play,
    pause,
    seek,
    setVolume,
    setMuted,
    state,
    analyser: audioAnalyser,
    analysers: audioChannelAnalysers,
    on: events.on,
    eventHistory: events.history,
    destroy,
  });
}
