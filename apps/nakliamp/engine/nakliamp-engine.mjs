import { createReelEngine } from './reel-engine.mjs';
import { createChain, resolveTrackGain } from '../app/audio/chain.mjs';
import { createGaplessLane, laneItem, laneJoin, wantsLane, LANE_MAX_S } from '../app/audio/gapless.mjs';
import { parseTrim, reconcileTrim } from '../app/audio/trim.mjs';
import { createMonoStage } from '../app/audio/volume.mjs';

export class NakliAmpError extends Error {
  constructor(name, code, message, cause = null) {
    super(message, cause ? { cause } : undefined);
    this.name = name;
    this.code = code;
  }
}

// Streamed R3 playback (long DSD and large software-decoded files).
const STREAM_HEAD_BYTES = 64 * 1024; // bytes read to sniff before choosing whole or streamed decode
const STREAM_AHEAD_S = 3; // seconds of PCM kept scheduled ahead of the clock
const STREAM_LEAD_S = 0.05; // first chunk starts this far ahead of the context clock
const STREAM_TICK_MS = 200; // pump interval, beside each chunk's own ended event

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
      try { listener(structuredClone(entry.detail)); } catch {}
    }
    for (const listener of listeners.get('*') || []) {
      try { listener(structuredClone(entry)); } catch {}
    }
    try { externalEvents?.emit?.(type, structuredClone(entry.detail)); } catch {}
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
  } catch {
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

/** The browser's AudioContext constructor, or undefined where there is none. */
function audioContextClass() {
  return globalThis.AudioContext || globalThis.webkitAudioContext;
}

/** A lane track's container: the probe's, then the trim parser's format, then the extension. */
function laneContainer(file, probe, decoded) {
  return probe?.container ?? decoded.trimInfo.format ?? (extensionOf(file.name) || null);
}

/** A lane track's codec: the probe's audio track codec, then the trim parser's format. */
function laneCodec(probe, decoded) {
  const audioTrack = probe?.tracks?.find?.(track => track.type === 'audio') ?? null;
  return audioTrack?.codec ?? decoded.trimInfo.format ?? null;
}

/** A preload entry waiting for its decode. */
function pendingEntry(input, meta, token) {
  return { input, meta: meta ? { ...meta } : null, token, item: null, join: null, state: 'pending' };
}

/** Refuse a track the probe says is too long for the lane. */
function refuseLongProbe(probe) {
  if (Number.isFinite(probe?.duration) && probe.duration >= LANE_MAX_S) {
    throw new NakliAmpError('LaneTooLongError', 'ERR_NAKLIAMP_LANE_TOO_LONG', 'Tracks of 20 minutes or more play on the normal route.');
  }
}

/** Merge a setDsp patch into the DSP settings; the chain goes on unless `chain: false` is given. */
function mergeDspPatch(dsp, patch) {
  if (patch.eq && typeof patch.eq === 'object') dsp.eq = { ...dsp.eq, ...patch.eq };
  if (patch.replayGain && typeof patch.replayGain === 'object') dsp.replayGain = { ...dsp.replayGain, ...patch.replayGain };
  if (patch.crossfadeS !== undefined) dsp.crossfadeS = Math.max(0, Math.min(12, Number(patch.crossfadeS) || 0));
  if (patch.gapless !== undefined && ['off', 'albums', 'always'].includes(patch.gapless)) dsp.gapless = patch.gapless;
  if (patch.mono !== undefined) dsp.mono = Boolean(patch.mono);
  dsp.chain = patch.chain === undefined ? true : Boolean(patch.chain);
}

/** A playback rate in 0.5..2 (P9); junk is 1. */
function clampRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate <= 0) return 1;
  return Math.max(0.5, Math.min(2, rate));
}

/** The refusal for a codec the browser's native audio path cannot play. */
function nativeUnsupportedError(track, file) {
  return new NakliAmpError(
    'NativeCodecUnsupportedError',
    'ERR_NAKLIAMP_NATIVE_UNSUPPORTED',
    `The browser native audio path does not support ${track.codec || extensionOf(file.name) || 'this codec'}.`,
  );
}

/** Refuse a factory result that is not audio-like, or that says it cannot play this MIME type. */
function checkNativeCandidate(candidateAudio, mime, track, file) {
  if (!candidateAudio || typeof candidateAudio.play !== 'function') {
    throw new TypeError('nativeAudioFactory must return an audio-like playback object.');
  }
  if (mime && typeof candidateAudio.canPlayType === 'function' && !candidateAudio.canPlayType(mime)) {
    throw nativeUnsupportedError(track, file);
  }
}

/** When no software decoder claimed the file, the native refusal says more than the software one. */
function preferNativeRefusal(softwareError, nativeError) {
  return softwareError?.code === 'ERR_NAKLIAMP_SOFTWARE_UNSUPPORTED' ? nativeError : softwareError;
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
 *
 * A decoder may also stream: `streams(container, size) -> boolean` and
 * `stream(Blob, { container, outputRate }) -> Stream`, where Stream is
 * `{ sampleRate, channelCount, durationS, read(), seek(s), close() }` and
 * `read()` yields `{ channels, frames, startS }` chunks or null at the end.
 * The engine sniffs only the file's head, and a file the first matching
 * decoder streams is never read whole.
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
  // The analysers read the level before the volume stage, as cliamp does: on
  // every route the tap sits after the node that applies the volume (Reel's
  // gain, the R3 gain, the lane's volume, then the chain), so a gain of
  // 1 / volume between the tap point and the analysers undoes it. The picture
  // is then the same at every volume, and "link to volume" in the shell scales
  // it exactly once. At volume 0 there is nothing left to undo, so it is silent.
  let tapCompensator = null;

  // DSP state. The chain stays off until the app calls setDsp, so a caller
  // that never asks for EQ, ReplayGain or gapless (the browser harnesses)
  // gets the routing it always had.
  const dsp = {
    chain: false,
    eq: { enabled: false, preset: 'flat', custom: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
    replayGain: { mode: 'off', preampDb: 0, preventClipping: true },
    crossfadeS: 0,
    gapless: 'off',
    mono: false,
  };
  // Speed (P9) and output device (S6) hold across tracks and routes.
  let speed = 1;
  let sinkId = '';
  let sinkError = null;
  const chains = new Map(); // AudioContext -> chain
  let r1Spliced = null; // the Reel gain node currently routed into the chain
  let currentMeta = null; // { albumKey, trackNo, discNo, replayGain, loudness } of the loaded track
  let previousMeta = null;
  let trackValues = { replayGain: null, loudness: null, albumContext: null };
  let trackGain = { gainDb: 0, source: 'off', peak: null, clipLimited: false };
  let lane = null; // { context, volume, lane, chainOn }
  let laneMedia = null;
  let laneSkipped = null; // why the last load did not use the lane, for the strip
  let pendingNext = null; // { input, meta, token, item, join, state }
  let preloadToken = 0;
  let laneVolumeValue = 1;
  let laneMutedFlag = false;

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
      const compensator = graph.context.createGain();
      graph.output.connect(compensator);
      compensator.connect(next);
      tapCompensator = compensator;
      analyser = next;
      analyserOwner = graph.output;
      applyTapCompensation();
      return analyser;
    } catch {
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
      // Through the same compensator, so both taps read before the volume stage.
      (tapCompensator ?? graph.output).connect(split);
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
    } catch {
      return null;
    }
  }

  /**
   * Where the analysers tap. With the DSP chain on, that is the chain's output
   * (after EQ and gain, so the picture matches what is heard); without it, the
   * rung's own output as before.
   */
  function rungGraph() {
    const graph = rawRungGraph();
    if (!graph) return null;
    const chain = routeChained() ? chains.get(graph.context) : null;
    return chain ? { context: graph.context, output: chainTap(chain) } : graph;
  }

  function rawRungGraph() {
    if (mode === 'lane' && lane) return { context: lane.context, output: lane.volume };
    if (mode === 'r3' && software) return { context: software.context, output: software.gain };
    if (mode === 'r1') {
      spliceR1();
      return reel.audioGraph?.() ?? null;
    }
    if (mode === 'r2' && nativeAudio) return nativeGraph ?? tapNativeOnRunningContext();
    return null;
  }

  /**
   * Build the R2 graph for a tap, only on a context that is already running.
   *
   * Hazard worth naming: createMediaElementSource permanently reroutes the
   * element through Web Audio and cannot be undone. If the context is
   * suspended by autoplay policy, that means silence. So the graph is only
   * built once the context is actually running, and until then the caller
   * gets null and shows no visualiser rather than risking audio.
   */
  function tapNativeOnRunningContext() {
    const AudioContextClass = audioContextClass();
    if (!AudioContextClass || typeof nativeAudio.play !== 'function') return null;
    const context = new AudioContextClass();
    if (context.state === 'suspended') {
      context.resume().catch(() => {});
      try { context.close(); } catch {}
      return null;
    }
    return buildNativeGraph(context);
  }

  /**
   * Route the native element through Web Audio on a running context.
   * createMediaElementSource reroutes the element, so the output has to be
   * connected onward (to the chain or the destination) or playback goes silent.
   */
  function buildNativeGraph(context) {
    const source = context.createMediaElementSource(nativeAudio);
    const output = context.createGain();
    source.connect(output);
    const chained = connectOutput(context, output);
    nativeGraph = { context, output, chained };
    applyTrackGain();
    return nativeGraph;
  }

  /**
   * With the chain on, R2 must play through Web Audio, so the graph is built
   * when playback starts (normally inside the click that started it). The
   * suspended-context safety stays: if the context will not run, the element
   * plays directly and the strip reports the chain as off for this track.
   */
  async function ensureNativeChain() {
    if (!dsp.chain || nativeGraph || !nativeAudio) return;
    const AudioContextClass = audioContextClass();
    if (!AudioContextClass) return;
    let context;
    try {
      context = new AudioContextClass();
      await buildNativeGraphWhenRunning(context);
    } catch {
      try { context?.close?.(); } catch {}
    }
  }

  /** Build the R2 graph once the context runs; close the context when it will not. */
  async function buildNativeGraphWhenRunning(context) {
    if (context.state === 'suspended') {
      // resume() can stay pending until a user gesture; do not wait for it forever.
      await Promise.race([context.resume().catch(() => {}), new Promise(resolve => setTimeout(resolve, 300))]);
    }
    if (context.state !== 'running') {
      try { context.close(); } catch {}
      return;
    }
    buildNativeGraph(context);
  }

  // ---- DSP chain plumbing ----------------------------------------------

  function chainFor(context) {
    let chain = chains.get(context);
    if (!chain) {
      chain = createChain(context);
      chain.setEq(dsp.eq);
      chain.setGainDb(lane && context === lane.context ? 0 : trackGain.gainDb);
      attachMono(context, chain);
      chains.set(context, chain);
      applySink(context);
    }
    return chain;
  }

  /**
   * The mono stage (P11) sits after the chain: chain.output -> stage -> destination.
   * A context that cannot build it (no channel merger) keeps the plain route,
   * and the state reports mono as unavailable rather than pretending.
   */
  function attachMono(context, chain) {
    let stage;
    try {
      stage = createMonoStage(context, { mono: dsp.mono });
    } catch {
      return;
    }
    try {
      chain.output.disconnect(context.destination);
      chain.output.connect(stage.input);
      stage.output.connect(context.destination);
      chain.post = stage;
    } catch {
      try { chain.output.connect(context.destination); } catch {}
    }
  }

  /** The node the analysers tap on a chained route: after the mono stage, so the picture matches what plays. */
  const chainTap = chain => chain.post?.output ?? chain.output;

  function dropChain(context) {
    const chain = context ? chains.get(context) : null;
    if (!chain) return;
    if (analyserOwner === chainTap(chain)) disposeAnalyser();
    if (chain.post) {
      for (const node of [chain.post.input, chain.post.output, ...Object.values(chain.post.nodes ?? {})]) { try { node.disconnect(); } catch {} }
    }
    chain.dispose();
    chains.delete(context);
  }

  /** Connect a route's output to the chain when it is on, else the destination. Returns whether it is chained. */
  function connectOutput(context, node) {
    if (dsp.chain) {
      try {
        node.connect(chainFor(context).input);
        return true;
      } catch {}
    }
    node.connect(context.destination);
    return false;
  }

  /** Reel builds a fresh gain node for every track and seek, so it is re-spliced each time. */
  function spliceR1() {
    if (!dsp.chain || mode !== 'r1') return;
    const graph = reel.audioGraph?.();
    if (!graph || graph.output === r1Spliced) return;
    try {
      graph.output.disconnect(graph.context.destination);
    } catch {
      try { graph.output.disconnect(); } catch {}
    }
    try {
      graph.output.connect(chainFor(graph.context).input);
      r1Spliced = graph.output;
    } catch {
      try { graph.output.connect(graph.context.destination); } catch {}
      r1Spliced = null;
    }
    applyTrackGain();
  }

  function routeChained() {
    if (mode === 'r1') return Boolean(r1Spliced) && r1Spliced === reel.audioGraph?.()?.output;
    if (mode === 'r2') return Boolean(nativeGraph?.chained);
    if (mode === 'r3') return Boolean(software?.chained);
    if (mode === 'lane') return Boolean(lane?.chained);
    return false;
  }

  /** The live route's holder for the current rung: anything with a `context`, or null. */
  function currentRoute() {
    if (mode === 'r1') return reel.audioGraph?.() ?? null;
    if (mode === 'r2') return nativeGraph;
    if (mode === 'r3') return software;
    if (mode === 'lane') return lane;
    return null;
  }

  function currentContext() {
    return currentRoute()?.context ?? null;
  }

  /** Re-connect the live route after the chain was switched on or off. */
  function reroute() {
    disposeAnalyser();
    if (mode === 'r1') {
      if (dsp.chain) spliceR1();
      else unspliceR1();
    }
    if (software?.gain) reconnectRoute(software, software.gain);
    if (nativeGraph) reconnectRoute(nativeGraph, nativeGraph.output);
    if (lane) reconnectRoute(lane, lane.volume);
  }

  /** Take Reel's output off the chain and back onto the destination. */
  function unspliceR1() {
    if (!r1Spliced) return;
    const graph = reel.audioGraph?.();
    try { r1Spliced.disconnect(); } catch {}
    if (graph?.output === r1Spliced) { try { r1Spliced.connect(graph.context.destination); } catch {} }
    r1Spliced = null;
  }

  /** Disconnect a route's output node and connect it again to the chain or the destination. */
  function reconnectRoute(route, node) {
    try { node.disconnect(); } catch {}
    route.chained = connectOutput(route.context, node);
  }

  /** Whether a queue neighbour (previous or next) shares the current track's album. */
  function albumNeighbour() {
    const key = currentMeta?.albumKey;
    if (!key) return false;
    return previousMeta?.albumKey === key || pendingNext?.meta?.albumKey === key;
  }

  /** Recompute the current track's gain and apply it to its route. */
  function applyTrackGain() {
    const albumContext = trackValues.albumContext ?? albumNeighbour();
    trackGain = resolveTrackGain(dsp.replayGain, trackValues, { albumContext });
    if (mode === 'lane' && lane) {
      lane.lane.setCurrentGainDb(trackGain.gainDb);
      return;
    }
    const context = currentContext();
    const chain = context ? chains.get(context) : null;
    chain?.setGainDb(trackGain.gainDb);
  }

  function adoptMeta(meta) {
    previousMeta = currentMeta;
    currentMeta = meta && typeof meta === 'object' ? { ...meta } : null;
    trackValues = {
      replayGain: currentMeta?.replayGain ?? null,
      loudness: currentMeta?.loudness ?? null,
      albumContext: null,
    };
  }

  // ---- Gapless lane ------------------------------------------------------

  function ensureLane() {
    if (lane) return lane;
    const context = openLaneContext();
    const volume = context.createGain();
    volume.gain.value = laneMutedFlag ? 0 : laneVolumeValue;
    const instance = createGaplessLane({ context, destination: volume, onAdvance: laneAdvanced });
    instance.setRate?.(speed);
    lane = { context, volume, lane: instance, chained: false };
    lane.chained = connectOutput(context, volume);
    if (lane.chained) chains.get(context)?.setGainDb(0);
    return lane;
  }

  /** A context that can decode whole files and play buffers, or a LaneUnavailableError. */
  function openLaneContext() {
    const context = audioContextFactory();
    if (typeof context?.decodeAudioData !== 'function' || typeof context.createBufferSource !== 'function') {
      try { context?.close?.()?.catch?.(() => {}); } catch {}
      throw new NakliAmpError('LaneUnavailableError', 'ERR_NAKLIAMP_LANE_UNAVAILABLE', 'This browser cannot decode audio in full for the gapless lane.');
    }
    return context;
  }

  function stopLane() {
    if (!lane) return;
    lane.lane.dispose();
    laneMedia = null;
    // An idle running context still costs an audio thread; play() resumes it.
    try { lane.context.suspend?.()?.catch?.(() => {}); } catch {}
  }

  function releaseLane() {
    if (!lane) return;
    lane.lane.dispose();
    try { lane.volume.disconnect(); } catch {}
    dropChain(lane.context);
    try { lane.context.close?.()?.catch?.(() => {}); } catch {}
    lane = null;
    laneMedia = null;
  }

  async function probeDuration(file) {
    try {
      return await reel.probe(file);
    } catch {
      return null;
    }
  }

  /** Decode a whole file for the lane: browser first, NakliAmp's own decoders second. */
  async function laneDecode(file, context) {
    // A file the software rung streams is one the lane would have to hold
    // whole, which is what streaming exists to avoid.
    if (await streamingDecoder(file)) {
      throw new NakliAmpError('LaneStreamedError', 'ERR_NAKLIAMP_LANE_STREAMED', 'This file plays streamed on the software route.');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    let buffer = null;
    let decoderName = null;
    try {
      // decodeAudioData detaches what it is given, so it gets a copy.
      buffer = await context.decodeAudioData(bytes.slice().buffer);
      decoderName = 'browser';
    } catch {
      buffer = null;
    }
    if (!buffer) {
      for (const decoder of softwareDecoders) {
        let container = null;
        try { container = await decoder.sniff(bytes); } catch { container = null; }
        if (!container) continue;
        try {
          const decoded = await decoder.decode(bytes);
          const made = context.createBuffer(decoded.channels.length, decoded.frames, decoded.sampleRate);
          for (const [index, channel] of decoded.channels.entries()) made.copyToChannel(channel.subarray(0, decoded.frames), index);
          buffer = made;
          decoderName = decoder.name;
          break;
        } catch {}
      }
    }
    if (!buffer) {
      throw new NakliAmpError('LaneDecodeError', 'ERR_NAKLIAMP_LANE_DECODE', 'Neither the browser nor a NakliAmp decoder could decode this file in full.');
    }
    if (buffer.duration > LANE_MAX_S) {
      throw new NakliAmpError('LaneTooLongError', 'ERR_NAKLIAMP_LANE_TOO_LONG', 'Tracks of 20 minutes or more play on the normal route.');
    }
    const trimInfo = parseTrim(bytes);
    const trim = reconcileTrim(trimInfo, buffer.length, buffer.sampleRate);
    return { buffer, decoderName, trim, trimInfo };
  }

  function laneMediaFor(file, probe, decoded, item) {
    return {
      name: file.name || probe?.name || 'Untitled track',
      size: file.size,
      container: laneContainer(file, probe, decoded),
      mimeType: probe?.mimeType ?? (file.type || null),
      codec: laneCodec(probe, decoded),
      duration: item.lengthS,
      decoderName: decoded.decoderName,
      sampleRate: decoded.buffer.sampleRate,
      channels: decoded.buffer.numberOfChannels,
      trim: decoded.trim,
    };
  }

  async function loadLane(input, meta, loadId) {
    const file = await localFile(input);
    const probe = await probeDuration(file);
    refuseLongProbe(probe);
    const laneState = ensureLane();
    const decoded = await laneDecode(file, laneState.context);
    if (loadId !== latestLoadId) {
      throw new NakliAmpError('SupersededLoadError', 'ERR_NAKLIAMP_LOAD_SUPERSEDED', 'A newer track selection replaced this request.');
    }
    reel.pause();
    disposeNative();
    releaseSoftware();
    pendingNext = null;
    adoptMeta(meta);
    const gainInfo = resolveTrackGain(dsp.replayGain, trackValues, { albumContext: albumNeighbour() });
    const item = laneItem(decoded.buffer, decoded.trim, { gainDb: gainInfo.gainDb, meta: currentMeta });
    item.media = laneMediaFor(file, probe, decoded, item);
    laneState.lane.load(item);
    laneMedia = item.media;
    trackGain = gainInfo;
    mode = 'lane';
    status = 'ready';
    lastError = null;
    fellBackFrom = null;
    laneSkipped = null;
    events.emit('track:loaded', { name: laneMedia.name, container: laneMedia.container, codec: laneMedia.codec, path: mode });
    return structuredClone({
      name: laneMedia.name,
      size: laneMedia.size,
      duration: laneMedia.duration,
      container: laneMedia.container,
      tracks: [{ type: 'audio', codec: laneMedia.codec, sampleRate: laneMedia.sampleRate, channels: laneMedia.channels }],
      path: mode,
      trim: laneMedia.trim.reason,
    });
  }

  function laneAdvanced(item, { mode: join }) {
    previousMeta = currentMeta;
    currentMeta = item.meta ? { ...item.meta } : null;
    trackValues = { replayGain: currentMeta?.replayGain ?? null, loudness: currentMeta?.loudness ?? null, albumContext: null };
    trackGain = item.gainInfo ?? trackGain;
    laneMedia = item.media;
    pendingNext = null;
    events.emit('track-advanced', { name: laneMedia?.name ?? null, path: 'lane', join, duration: laneMedia?.duration ?? null });
  }

  /**
   * Hand the engine the next queue item. When the settings join the two
   * tracks and the current one is on the lane, the next is decoded now and
   * scheduled to start on the frame the current one ends (or crossfaded).
   * Otherwise nothing is scheduled and the app advances as before.
   * Returns { joined, mode?, reason? }. `preload(null)` clears it.
   */
  async function preload(nextInput, nextMeta = null) {
    const token = ++preloadToken;
    if (lane) lane.lane.clearNext();
    pendingNext = nextInput ? pendingEntry(nextInput, nextMeta, token) : null;
    applyTrackGain();
    if (!pendingNext) return { joined: false, reason: 'no next track' };
    const refusal = joinRefusal(pendingNext.meta);
    if (refusal) {
      pendingNext.state = 'not-joined';
      return { joined: false, reason: refusal };
    }
    const entry = pendingNext;
    try {
      return await prepareNext(entry, token);
    } catch (error) {
      if (pendingNext === entry) entry.state = 'failed';
      return { joined: false, reason: error?.message || String(error) };
    }
  }

  /** Why the next track cannot join the current one on the lane, or null when it can. */
  function joinRefusal(nextMeta) {
    if (!laneJoin(dsp, currentMeta, nextMeta)) return 'the settings do not join these two tracks';
    if (mode !== 'lane' || !lane) return 'the current track is not on the gapless lane';
    return null;
  }

  /** Decode the next track for the lane and schedule it, unless a newer track or preload took over meanwhile. */
  async function prepareNext(entry, token) {
    const forTrack = laneMedia;
    const file = await localFile(entry.input);
    const probe = await probeDuration(file);
    refuseLongProbe(probe);
    const decoded = await laneDecode(file, lane.context);
    if (token !== preloadToken || mode !== 'lane' || laneMedia !== forTrack || !lane) {
      return { joined: false, reason: 'superseded by a newer track or preload' };
    }
    const albumContext = Boolean(currentMeta?.albumKey) && currentMeta.albumKey === entry.meta?.albumKey;
    const gainInfo = resolveTrackGain(dsp.replayGain, entry.meta ?? {}, { albumContext });
    const item = laneItem(decoded.buffer, decoded.trim, { gainDb: gainInfo.gainDb, gainInfo, meta: entry.meta });
    item.media = laneMediaFor(file, probe, decoded, item);
    entry.item = item;
    return queuePending(entry);
  }

  /** (Re)schedule a decoded next item under the current settings. */
  function queuePending(entry) {
    if (!lane || mode !== 'lane' || !entry?.item || pendingNext !== entry) return { joined: false, reason: 'nothing to schedule' };
    const join = laneJoin(dsp, currentMeta, entry.meta);
    entry.join = join;
    if (!join) {
      lane.lane.clearNext();
      entry.state = 'not-joined';
      return { joined: false, reason: 'the settings do not join these two tracks' };
    }
    lane.lane.queue(entry.item, { mode: join, fadeS: Number(dsp.crossfadeS) || 0 });
    entry.state = 'queued';
    return { joined: true, mode: join };
  }

  /**
   * Apply DSP settings live. Any subset of { eq, replayGain, crossfadeS,
   * gapless, chain } may be passed; calling it at all switches the chain on
   * unless `chain: false` is given.
   */
  function setDsp(patch = {}) {
    const wasChained = dsp.chain;
    mergeDspPatch(dsp, patch);
    if (wasChained !== dsp.chain) reroute();
    for (const chain of chains.values()) { chain.setEq(dsp.eq); chain.post?.setMono(dsp.mono); }
    applyTrackGain();
    refreshPending();
    return dspState();
  }

  // ---- Speed (P9) and output device (S6) -----------------------------------

  /** Apply the current speed to whichever route is live. */
  function applyRate() {
    if (mode === 'r1') { try { reel.setRate?.(speed); } catch {} }
    if (nativeAudio) applyNativeRate();
    if (software) applySoftwareRate();
    lane?.lane.setRate?.(speed);
  }

  function applyNativeRate() {
    try { nativeAudio.preservesPitch = true; } catch {}
    try { nativeAudio.playbackRate = speed; } catch {}
  }

  /** Keep the R3 clock continuous: fold the elapsed time in at the old rate first. */
  function applySoftwareRate() {
    if (software.streamed) {
      // Chunks already scheduled carry the old rate, so playback restarts at
      // the current position with every chunk at the new one.
      const track = software;
      track.offsetS = streamedPosition(track);
      track.rate = speed;
      if (track.playing) startStreamed(track).catch(recordError);
      return;
    }
    if (software.playing) {
      software.offsetS = softwarePosition();
      software.startedAt = software.context.currentTime;
    }
    software.rate = speed;
    if (software.source?.playbackRate) software.source.playbackRate.value = speed;
  }

  /**
   * Set the playback rate, 0.5..2, on every route. The element keeps pitch
   * (preservesPitch); the buffer routes (R1, R3, the lane) change pitch with
   * speed, and the state says which.
   */
  function setRate(value) {
    speed = clampRate(value);
    applyRate();
    return { rate: speed, preservesPitch: mode === 'r2' };
  }

  /** Route one context to the chosen output device, where the browser can. */
  function applySink(context) {
    if (!context || typeof context.setSinkId !== 'function') return Promise.resolve(false);
    if ((context.sinkId ?? '') === sinkId) return Promise.resolve(true);
    return Promise.resolve()
      .then(() => context.setSinkId(sinkId))
      .then(() => { sinkError = null; return true; })
      .catch(error => { sinkError = { name: error?.name || 'Error', message: error?.message || String(error) }; return false; });
  }

  /**
   * Play through another output device (`''` is the system default). Every live
   * context and the native element move; contexts built later pick it up in
   * chainFor. Resolves `{ applied, supported, error }`.
   */
  async function setSinkId(id) {
    sinkId = typeof id === 'string' ? id : '';
    sinkError = null;
    const contexts = [...new Set([...chains.keys(), currentContext()].filter(Boolean))]
      .filter(context => typeof context.setSinkId === 'function');
    const results = await Promise.all(contexts.map(applySink));
    const element = await applyElementSink();
    const supported = contexts.length > 0 || element !== null;
    const applied = results.every(Boolean) && element !== false;
    return { applied: applied && !sinkError, supported, error: sinkError };
  }

  /** The unchained native element plays straight to an output: true, false, or null when not in use. */
  async function applyElementSink() {
    if (!nativeAudio || nativeGraph || typeof nativeAudio.setSinkId !== 'function') return null;
    try {
      await nativeAudio.setSinkId(sinkId);
      return true;
    } catch (error) {
      sinkError = { name: error?.name || 'Error', message: error?.message || String(error) };
      return false;
    }
  }

  /** Reschedule a decoded next item, or retry a preload the old settings would not join. */
  function refreshPending() {
    if (pendingNext?.item) queuePending(pendingNext);
    else if (pendingNext && pendingNext.state === 'not-joined' && mode === 'lane') {
      preload(pendingNext.input, pendingNext.meta).catch(() => {});
    }
  }

  /** Gain values for the loaded track; the engine picks track or album per mode. */
  function setTrackGain({ replayGain = null, loudness = null, albumContext = null } = {}) {
    trackValues = { replayGain, loudness, albumContext: typeof albumContext === 'boolean' ? albumContext : null };
    applyTrackGain();
    return { ...trackGain };
  }

  /** The lane's part of the DSP state; all off when the current track is not on the lane. */
  function laneDspState() {
    if (mode !== 'lane') return { scheduled: null, lane: 'normal', gapless: false, crossfading: false, trim: null };
    const scheduled = lane?.lane.nextScheduled();
    return {
      scheduled,
      lane: 'gapless',
      gapless: scheduled?.mode === 'gapless',
      crossfading: Boolean(lane?.lane.crossfading()),
      trim: laneMedia?.trim?.reason ?? null,
    };
  }

  /** 'on', 'off', or 'unavailable' when the live chain has no mono stage. */
  function monoState() {
    const context = currentContext();
    const chain = context ? chains.get(context) : null;
    if (!dsp.mono) return 'off';
    return chain?.post ? 'on' : 'unavailable';
  }

  function dspState() {
    const { scheduled, ...laneState } = laneDspState();
    return {
      chain: routeChained() ? 'on' : 'off',
      lane: laneState.lane,
      gapless: laneState.gapless,
      crossfading: laneState.crossfading,
      gainDb: trackGain.gainDb,
      gainSource: trackGain.source,
      clipLimited: trackGain.clipLimited,
      eq: { enabled: Boolean(dsp.eq.enabled), preset: dsp.eq.preset },
      mono: monoState(),
      rate: speed,
      sinkId,
      sinkError,
      next: scheduled ? scheduled.mode : (pendingNext?.state ?? 'none'),
      trim: laneState.trim,
      laneSkipped,
      // Where analyser() reads: always before the volume stage (see tapCompensator).
      analyserTap: 'pre-volume',
      settings: { gapless: dsp.gapless, crossfadeS: dsp.crossfadeS, replayGain: { ...dsp.replayGain } },
    };
  }

  /** True when the volume is applied before the tap on the current route (see tapCompensator). */
  function volumeBeforeTap() {
    // R2 sets the element's volume; Chrome applies it before a
    // MediaElementAudioSourceNode, so the R2 graph is post-volume too.
    return mode === 'r1' || mode === 'r2' || mode === 'r3' || mode === 'lane';
  }

  /** Set the compensator to 1 / volume, so the analysers read the pre-volume level. */
  function applyTapCompensation() {
    if (!tapCompensator) return;
    const volume = laneMutedFlag ? 0 : laneVolumeValue;
    // Below -80 dB the picture is noise either way; at 0 nothing is left to undo.
    const value = volumeBeforeTap() && volume > 1e-4 ? 1 / volume : 1;
    const param = tapCompensator.gain;
    try { param.setTargetAtTime(value, tapCompensator.context.currentTime, 0.01); } catch { param.value = value; }
  }

  function disposeAnalyser() {
    try { tapCompensator?.disconnect(); } catch {}
    tapCompensator = null;
    try { analyser?.disconnect(); } catch {}
    try { splitter?.disconnect(); } catch {}
    for (const node of channelAnalysers ?? []) { try { node.disconnect(); } catch {} }
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
    try { software?.source?.stop(); } catch {}
    try { software?.source?.disconnect(); } catch {}
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
    if (!software) return;
    if (software.streamed) releaseStream(software);
    stopSoftwareSource();
    try { software.gain?.disconnect(); } catch {}
    if (software.context) dropChain(software.context);
    // `close()` is async and nothing waits for it: this is teardown, and a
    // context that refuses to close is not a reason to fail the next load.
    try { software.context?.close?.()?.catch?.(() => {}); } catch {}
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
    const chained = connectOutput(context, gain);
    return {
      context, buffer, gain, chained,
      source: null,
      name, size, container,
      decoderName: decoded.decoderName,
      offsetS: 0,
      startedAt: 0,
      rate: speed,
      playing: false,
      volume: 1,
      muted: false,
      durationS: decoded.frames / decoded.sampleRate,
      sampleRate: decoded.sampleRate,
      channels: decoded.channels.length,
    };
  }

  /**
   * The R3 graph for a streamed track: the same context and gain as a decoded
   * buffer, fed by AudioBufferSourceNodes scheduled back to back.
   *
   * Memory held, by construction: at most STREAM_AHEAD_S seconds of scheduled
   * PCM plus the one chunk being decoded (about half a second), at the
   * context's rate. At 48 kHz stereo that is under 1.5 MB of Float32, against
   * about 850 MB for a whole five-minute DSD64 track at 352.8 kHz.
   */
  function streamedPlayback(context, stream, name, size, container, decoderName) {
    const gain = context.createGain();
    const chained = connectOutput(context, gain);
    return {
      context, gain, chained,
      buffer: null,
      source: null,
      streamed: true,
      stream,
      sources: new Set(),
      generation: 0,
      timer: null,
      pumping: null,
      anchor: null, // { mediaS, ctxT }: media time mediaS plays at context time ctxT
      scheduledEndS: 0,
      nextTime: 0,
      streamEnded: false,
      name, size, container,
      decoderName,
      offsetS: 0,
      startedAt: 0,
      rate: speed,
      playing: false,
      volume: 1,
      muted: false,
      durationS: stream.durationS,
      sampleRate: stream.sampleRate,
      channels: stream.channelCount,
    };
  }

  /**
   * Stop a streamed track and close its decode stream, which frees the
   * demuxer, decoder, resampler and reader device. The close queues behind any
   * read in flight, so nothing waits for it here.
   */
  function releaseStream(track) {
    haltStreamed(track);
    track.stream.close().catch(() => {});
  }

  /** Stop every scheduled source and cancel the pump; the stream stays open. */
  function haltStreamed(track) {
    track.generation += 1;
    if (track.timer) { clearInterval(track.timer); track.timer = null; }
    for (const source of track.sources) {
      source.onended = null;
      try { source.stop(); } catch {}
      try { source.disconnect(); } catch {}
    }
    track.sources.clear();
    track.pumping = null;
  }

  /** Schedule one decoded chunk right after the previous one. */
  function scheduleChunk(track, chunk) {
    const { context } = track;
    const rate = track.rate || 1;
    const now = context.currentTime;
    if (!track.anchor || track.nextTime < now + 0.01) {
      // First chunk, or decode fell behind the clock: start again a little
      // ahead, at this chunk's own position, so the clock stays truthful.
      track.nextTime = now + STREAM_LEAD_S;
      track.anchor = { mediaS: chunk.startS, ctxT: track.nextTime };
    }
    const buffer = context.createBuffer(chunk.channels.length, chunk.frames, track.sampleRate);
    for (const [index, channel] of chunk.channels.entries()) buffer.copyToChannel(channel, index);
    const source = context.createBufferSource();
    source.buffer = buffer;
    if (source.playbackRate) source.playbackRate.value = rate;
    source.connect(track.gain);
    const generation = track.generation;
    source.onended = () => {
      track.sources.delete(source);
      if (generation !== track.generation) return;
      if (track.streamEnded && !track.sources.size) {
        track.offsetS = track.durationS;
        track.playing = false;
        haltStreamed(track);
        return;
      }
      pumpStreamed(track);
    };
    source.start(track.nextTime);
    track.sources.add(source);
    track.nextTime += chunk.frames / track.sampleRate / rate;
    track.scheduledEndS = chunk.startS + chunk.frames / track.sampleRate;
  }

  /** Keep STREAM_AHEAD_S seconds scheduled. One pump at a time per track. */
  function pumpStreamed(track, { limit = Infinity } = {}) {
    if (track.pumping) return track.pumping;
    const generation = track.generation;
    const run = (async () => {
      let added = 0;
      while (generation === track.generation && track.playing && !track.streamEnded && added < limit
        && (!track.anchor || track.nextTime - track.context.currentTime < STREAM_AHEAD_S)) {
        const chunk = await track.stream.read();
        if (generation !== track.generation) return;
        if (!chunk) {
          track.streamEnded = true;
          if (!track.sources.size) { track.offsetS = track.durationS; track.playing = false; haltStreamed(track); }
          return;
        }
        scheduleChunk(track, chunk);
        added += 1;
      }
    })().catch(error => {
      if (generation === track.generation) {
        track.offsetS = streamedPosition(track);
        track.playing = false;
        haltStreamed(track);
        recordError(error);
      }
    }).finally(() => {
      if (track.pumping === run) track.pumping = null;
    });
    track.pumping = run;
    return run;
  }

  /** Start (or restart) a streamed track at its offset: seek the decoder, fill one chunk, then keep pumping. */
  async function startStreamed(track) {
    haltStreamed(track);
    const generation = track.generation;
    track.anchor = null;
    track.streamEnded = false;
    track.scheduledEndS = track.offsetS;
    track.playing = true;
    await track.stream.seek(track.offsetS);
    if (generation !== track.generation) return;
    await pumpStreamed(track, { limit: 1 });
    if (generation !== track.generation || !track.playing) return;
    track.timer = setInterval(() => pumpStreamed(track), STREAM_TICK_MS);
    pumpStreamed(track);
  }

  function streamedPosition(track) {
    if (!track.playing || !track.anchor) return Math.min(track.durationS, track.offsetS);
    const elapsed = Math.max(0, track.context.currentTime - track.anchor.ctxT) * (track.rate || 1);
    return Math.min(track.durationS, track.scheduledEndS, track.anchor.mediaS + elapsed);
  }

  function softwarePosition() {
    if (!software) return 0;
    if (software.streamed) return streamedPosition(software);
    const elapsed = software.playing ? (software.context.currentTime - software.startedAt) * (software.rate || 1) : 0;
    return Math.min(software.durationS, software.offsetS + elapsed);
  }

  function disposeNative() {
    stopNativeElement();
    if (nativeUrl) URL.revokeObjectURL(nativeUrl);
    releaseNativeGraph();
    nativeGraph = null;
    nativeAudio = null;
    nativeUrl = null;
  }

  /** Stop the native element and detach its source. */
  function stopNativeElement() {
    try { nativeAudio?.pause(); } catch {}
    try { nativeAudio?.removeAttribute?.('src'); } catch {}
    try { nativeAudio?.load(); } catch {}
  }

  /** Disconnect the R2 graph, drop its chain and close its context. */
  function releaseNativeGraph() {
    try { nativeGraph?.output?.disconnect(); } catch {}
    if (nativeGraph?.context) dropChain(nativeGraph.context);
    try { nativeGraph?.context?.close?.(); } catch {}
  }

  function disposeNativeCandidate(audio, url) {
    try { audio?.pause?.(); } catch {}
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
    // The demuxer can describe a codec WebCodecs has no configuration for
    // (ALAC in MP4 is the case that found this). Loading on R1 anyway left a
    // track that failed only at play. Refusing here lets the ladder move on to
    // the native and software rungs while the person is still on this track.
    const config = track.decoderConfig;
    let configUsable = Boolean(config && typeof config.codec === 'string');
    if (configUsable && typeof globalThis.AudioDecoder?.isConfigSupported === 'function') {
      try { configUsable = Boolean((await globalThis.AudioDecoder.isConfigSupported(config))?.supported); } catch { configUsable = false; }
    }
    if (!configUsable) {
      throw new NakliAmpError(
        'MissingDecoderConfigError',
        'ERR_NAKLIAMP_R1_NO_DECODER',
        `The engine cannot decode ${track.codec || 'this codec'} with WebCodecs here.`,
      );
    }
    releaseSoftware();
    if (hasVideoTrack(metadata)) {
      throw new NakliAmpError(
        'VideoMediaDeferredError',
        'ERR_NAKLIAMP_VIDEO_MEDIA',
        'This file carries video; NakliAmp plays its audio on the native path.',
      );
    }
    disposeNative();
    stopLane();
    r1Spliced = null;
    mode = 'r1';
    applyRate();
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
    const { metadata, probeFailure } = await probeForNative(file);
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
      throw nativeUnsupportedError(track, file);
    }

    const candidateUrl = URL.createObjectURL(file);
    let candidateAudio;
    let adopted = false;
    try {
      candidateAudio = nativeAudioFactory({ url: candidateUrl, file, metadata });
      checkNativeCandidate(candidateAudio, mime, track, file);
      await waitForNativeMetadata(candidateAudio, DEFAULT_CONFIG.demux.probeTimeoutMs);
      const nextFingerprint = await fingerprint(file);
      if (loadId !== latestLoadId) {
        throw new NakliAmpError(
          'SupersededLoadError',
          'ERR_NAKLIAMP_LOAD_SUPERSEDED',
          'A newer track selection replaced this request.',
        );
      }
      adoptNative({ candidateAudio, candidateUrl, file, metadata, probeFailure, videoIgnored, nextFingerprint });
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
   * Probe a file for the native rung.
   * The native path must not depend on the engine understanding the file.
   * If it did, any container the engine has never heard of would be a dead
   * end even when the browser can play it perfectly well.
   */
  async function probeForNative(file) {
    try {
      return { metadata: await reel.probe(file), probeFailure: null };
    } catch (error) {
      if (FALLBACK_BLOCKED.has(error?.code)) throw error;
      return { metadata: unprobedMetadata(file), probeFailure: error };
    }
  }

  /** Stop every other rung and make the candidate element the playing R2 track. */
  function adoptNative({ candidateAudio, candidateUrl, file, metadata, probeFailure, videoIgnored, nextFingerprint }) {
    reel.pause();
    disposeNative();
    disposeAnalyser();
    releaseSoftware();
    stopLane();
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
    applyRate();
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
    const streamer = await streamingDecoder(file);
    if (streamer) return loadR3Streamed(file, streamer, loadId);
    const bytes = new Uint8Array(await file.arrayBuffer());

    let decoded = null;
    let lastFailure = null;
    for (const decoder of softwareDecoders) {
      let container = null;
      try {
        container = await decoder.sniff(bytes);
      } catch {
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
    stopLane();
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

  /**
   * The software decoder that will stream `file`, or null when it decodes whole.
   *
   * Only the head of the file is read. The first decoder that recognises the
   * head decides: when it streams this container at this size, the file is
   * never read whole; otherwise the whole-file ladder runs exactly as before.
   */
  async function streamingDecoder(file) {
    const head = new Uint8Array(await file.slice(0, STREAM_HEAD_BYTES).arrayBuffer());
    for (const decoder of softwareDecoders) {
      let container = null;
      try { container = await decoder.sniff(head); } catch { container = null; }
      if (!container) continue;
      const streams = typeof decoder.stream === 'function' && Boolean(decoder.streams?.(container, file.size));
      return streams ? { decoder, container } : null;
    }
    return null;
  }

  /**
   * R3, streamed: decode a slice at a time, a few seconds ahead of the clock.
   * The context is made first because the decoder resamples to its rate.
   */
  async function loadR3Streamed(file, { decoder, container }, loadId) {
    const context = audioContextFactory();
    let stream = null;
    try {
      stream = await decoder.stream(file, { container, outputRate: context.sampleRate });
    } catch (error) {
      try { context.close?.()?.catch?.(() => {}); } catch {}
      throw error;
    }
    if (loadId !== latestLoadId) {
      stream.close().catch(() => {});
      try { context.close?.()?.catch?.(() => {}); } catch {}
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
    stopLane();
    software = streamedPlayback(context, stream, file.name, file.size, container, decoder.name);
    mode = 'r3';
    status = 'ready';
    lastError = null;
    events.emit('track:loaded', { name: file.name, container, codec: 'pcm', path: mode });
    return structuredClone({
      name: file.name,
      size: file.size,
      duration: software.durationS,
      container,
      tracks: [{ type: 'audio', codec: 'pcm', sampleRate: stream.sampleRate, channels: stream.channelCount }],
      path: mode,
    });
  }

  /**
   * Load a track. `meta` is optional (`{ albumKey, trackNo, discNo,
   * replayGain, loudness }`): with it, the engine can apply the track's gain
   * and put the track on the gapless lane when the settings may join it to
   * the next one. Without it, loading behaves exactly as before.
   */
  async function load(input, meta = null) {
    const loadId = ++latestLoadId;
    status = 'loading';
    fellBackFrom = null;
    laneSkipped = null;
    if (forcePath === 'auto' && wantsLane(dsp, meta)) {
      try {
        return await loadLane(input, meta, loadId);
      } catch (error) {
        if (loadId !== latestLoadId) throw error;
        // Not an error for the person: the normal ladder plays the file.
        laneSkipped = error?.code ?? 'ERR_NAKLIAMP_LANE_FAILED';
        status = 'loading';
      }
    }
    const loaded = await loadNormal(input, loadId);
    pendingNext = null;
    adoptMeta(meta);
    applyTrackGain();
    return loaded;
  }

  async function loadNormal(input, loadId) {
    const nextMode = preferredMode();
    try {
      return nextMode === 'r1' ? await loadR1(input, loadId) : await loadR2(input, loadId);
    } catch (error) {
      return fallBack(nextMode, error, input, loadId);
    }
  }

  /**
   * Which fallback a failed first rung takes: 'r1-r3', 'r1-r2', 'r2-r3' or null.
   *
   * R1 to R2: without it, anything the engine cannot demux is a dead end even
   * when the browser itself could play the file — the single largest gap
   * between "an engine proof" and "throw anything at it". A named codec
   * refusal skips the native rung and goes straight to software, which is the
   * only rung that could ever play it.
   *
   * R2 to R3, when the browser was the *first* rung rather than the second.
   * The R1 routes are gated on having started at R1, so on a browser without
   * WebCodecs `AudioDecoder` the software rung was unreachable and AIFF, CAF
   * and AU were refused outright — on exactly the browsers most likely to
   * need it. "Tries every rung before it gives up" has to mean every rung it
   * actually has.
   */
  function fallbackRoute(nextMode, code, loadId) {
    if (forcePath !== 'auto' || loadId !== latestLoadId) return null;
    const hasSoftware = softwareDecoders.length > 0;
    if (nextMode === 'r1' && hasSoftware && SOFTWARE_ONLY_REFUSALS.has(code)) return 'r1-r3';
    if (nextMode === 'r1' && !FALLBACK_BLOCKED.has(code) && !SOFTWARE_ONLY_REFUSALS.has(code)) return 'r1-r2';
    if (nextMode === 'r2' && hasSoftware && !FALLBACK_BLOCKED.has(code)) return 'r2-r3';
    return null;
  }

  /** Try the next rung after the first one failed, or record and rethrow the refusal. */
  async function fallBack(nextMode, error, input, loadId) {
    const route = fallbackRoute(nextMode, error?.code, loadId);
    if (route === 'r1-r3') {
      // When no decoder in this build claims it, the original named refusal
      // is still the truest thing we can say.
      return fallToR3(input, loadId, { from: 'r1', fellBack: error.code, code: error.code, refusal: () => error });
    }
    if (route === 'r1-r2') return fallToR2(error, input, loadId);
    if (route === 'r2-r3') {
      // The browser's reason for refusing a file it recognises is more
      // useful than "no decoder claimed it".
      return fallToR3(input, loadId, {
        from: 'r2',
        fellBack: error?.code ?? 'ERR_NAKLIAMP_R2_FAILED',
        code: error?.code,
        refusal: softwareError => preferNativeRefusal(softwareError, error),
      });
    }
    return refuseLoad(error, loadId);
  }

  /** R1 failed: try the browser, and when it refuses too, try decoding it ourselves. */
  async function fallToR2(error, input, loadId) {
    const fellBack = error?.code ?? 'ERR_NAKLIAMP_R1_FAILED';
    try {
      const loaded = await loadR2(input, loadId);
      fellBackFrom = fellBack;
      events.emit('playback:fallback', { from: 'r1', to: 'r2', code: fellBackFrom });
      return { ...loaded, fellBackFrom };
    } catch (fallbackError) {
      if (loadId !== latestLoadId) throw fallbackError;
      if (softwareDecoders.length && !FALLBACK_BLOCKED.has(fallbackError?.code)) {
        // Report the native refusal, not the software one: the browser's
        // reason is the more useful of the two for a file it knows.
        return fallToR3(input, loadId, {
          from: 'r2',
          fellBack,
          code: fallbackError?.code,
          refusal: softwareError => preferNativeRefusal(softwareError, fallbackError),
        });
      }
      recordError(fallbackError);
      throw fallbackError;
    }
  }

  /** Try the software rung; on failure, record and throw the error `refusal` picks. */
  async function fallToR3(input, loadId, { from, fellBack, code, refusal }) {
    try {
      const loaded = await loadR3(input, loadId);
      fellBackFrom = fellBack;
      events.emit('playback:fallback', { from, to: 'r3', code });
      return { ...loaded, fellBackFrom };
    } catch (softwareError) {
      if (loadId !== latestLoadId) throw softwareError;
      const reported = refusal(softwareError);
      recordError(reported);
      throw reported;
    }
  }

  /** No fallback applies: report a superseded load as such, record anything else, and throw. */
  function refuseLoad(error, loadId) {
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


  /** Play on R3: a decoded buffer from its offset, or a stream restarted at it. */
  async function playSoftware() {
    if (software.context.state === 'suspended') await software.context.resume();
    if (software.streamed) {
      if (software.offsetS >= software.durationS) software.offsetS = 0;
      await startStreamed(software);
      return;
    }
    stopSoftwareSource();
    const source = software.context.createBufferSource();
    source.buffer = software.buffer;
    if (source.playbackRate) source.playbackRate.value = software.rate || 1;
    source.connect(software.gain);
    source.onended = () => { if (software?.playing) software.playing = false; };
    source.start(0, Math.min(software.offsetS, software.durationS));
    software.source = source;
    software.startedAt = software.context.currentTime;
    software.playing = true;
  }

  async function play() {
    if (mode === 'r3' && software) {
      await playSoftware();
    } else if (mode === 'lane' && lane) {
      if (lane.context.state === 'suspended') await lane.context.resume();
      lane.lane.play();
    } else if (mode === 'r1') {
      await reel.play();
      spliceR1();
    } else if (mode === 'r2' && nativeAudio) {
      await ensureNativeChain();
      await nativeAudio.play();
    } else throw new NakliAmpError('NoTrackError', 'ERR_NAKLIAMP_NO_TRACK', 'Open an audio file before playing.');
    status = 'playing';
    events.emit('transport:play', { positionS: state().clock.positionS, path: mode });
  }

  function pause() {
    if (mode === 'r3' && software?.streamed) {
      software.offsetS = softwarePosition();
      software.playing = false;
      haltStreamed(software);
    } else if (mode === 'r3' && software) {
      software.offsetS = softwarePosition();
      software.playing = false;
      stopSoftwareSource();
    }
    if (mode === 'lane') lane?.lane.pause();
    if (mode === 'r1') reel.pause();
    if (mode === 'r2') nativeAudio?.pause();
    if (mode) status = 'paused';
    events.emit('transport:pause', { positionS: state().clock.positionS, path: mode });
  }

  /** Seek on R3. A streamed track restarts its stream there; a buffer replays from there. */
  async function seekSoftware(next) {
    const wasPlaying = software.playing;
    if (software.streamed) haltStreamed(software);
    else stopSoftwareSource();
    software.offsetS = next;
    software.playing = false;
    if (!wasPlaying) return;
    if (software.streamed) await startStreamed(software);
    else await play();
  }

  async function seek(positionS) {
    const duration = state().media.duration;
    const next = Math.max(0, Math.min(Number.isFinite(duration) ? duration : Infinity, Number(positionS) || 0));
    if (mode === 'r3' && software) await seekSoftware(next);
    else if (mode === 'lane' && lane) lane.lane.seek(next);
    else if (mode === 'r1') {
      await reel.seek(next);
      spliceR1();
    } else if (mode === 'r2' && nativeAudio) nativeAudio.currentTime = next;
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
    laneVolumeValue = next;
    applyLaneVolume();
    applyTapCompensation();
  }

  function applyLaneVolume() {
    if (!lane) return;
    const value = laneMutedFlag ? 0 : laneVolumeValue;
    try { lane.volume.gain.setTargetAtTime(value, lane.context.currentTime, 0.01); } catch { lane.volume.gain.value = value; }
  }

  function setMuted(value) {
    const next = !!value;
    if (mode === 'r1') reel.setMuted(next);
    if (nativeAudio) nativeAudio.muted = next;
    if (software) { software.muted = next; applySoftwareGain(); }
    laneMutedFlag = next;
    applyLaneVolume();
    applyTapCompensation();
  }

  function state() {
    if (mode === 'lane' && lane) {
      const onLane = laneState();
      if (onLane) return onLane;
    }
    if (mode === 'r1') return r1State();
    if (mode === 'r3' && software) return r3State();
    if (mode === 'r2' && nativeAudio && nativeMetadata) return r2State();
    return idleState();
  }

  /** State on the gapless lane, or null when the lane holds no track. */
  function laneState() {
    // position() first: it is where the lane notices it has moved on, which
    // replaces laneMedia with the next track's.
    const positionS = lane.lane.position();
    const media = laneMedia;
    if (!media) return null;
    const decode = media.decoderName === 'browser'
      ? 'gapless lane: decoded in full by the browser'
      : `gapless lane: decoded in full by ${media.decoderName}`;
    return structuredClone({
      version,
      status,
      path: mode,
      media: {
        name: media.name,
        fingerprint: null,
        duration: media.duration,
        size: media.size,
        container: media.container,
        mimeType: media.mimeType,
      },
      track: { type: 'audio', codec: media.codec, sampleRate: media.sampleRate, channels: media.channels },
      clock: {
        positionS,
        playing: lane.lane.playing(),
        rate: speed,
        volume: laneVolumeValue,
        muted: laneMutedFlag,
      },
      honesty: {
        container: media.container,
        codec: media.codec,
        decode,
        output: 'Web Audio',
        gapless: true,
        trim: media.trim?.reason ?? null,
        localOnly: true,
        fellBackFrom: null,
        videoIgnored: false,
      },
      diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
      error: lastError,
      dsp: dspState(),
    });
  }

  /** State on R1, read through Reel. */
  function r1State() {
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
      dsp: dspState(),
    });
  }

  /** State on R3, the software rung. */
  function r3State() {
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
        rate: software.rate || 1,
        volume: software.volume,
        muted: software.muted,
      },
      honesty: {
        container: software.container,
        codec: 'pcm',
        decode: software.streamed
          ? `software decode, streamed (${software.decoderName})`
          : `software decode (${software.decoderName})`,
        output: 'Web Audio',
        gapless: false,
        localOnly: true,
        fellBackFrom,
        videoIgnored: false,
      },
      diagnostics: { consumedFrames: null, droppedFrames: null, lastError: null },
      error: lastError,
      dsp: dspState(),
    });
  }

  /** State on R2, the native element. */
  function r2State() {
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
      dsp: dspState(),
    });
  }

  /** State with no track loaded. */
  function idleState() {
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
      dsp: dspState(),
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
    releaseLane();
    for (const context of chains.keys()) dropChain(context);
    pendingNext = null;
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
    setDsp,
    setTrackGain,
    setRate,
    setSinkId,
    preload,
    on: events.on,
    eventHistory: events.history,
    destroy,
  });
}
