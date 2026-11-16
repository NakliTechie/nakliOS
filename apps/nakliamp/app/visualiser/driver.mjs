// Visualiser driver.
//
// Owns the animation frame, the canvas sizing, and the analyser buffers. Modes
// stay pure; everything with a lifetime lives here, so switching modes or
// stopping cannot leak a frame callback or a stale canvas.

import { MODES, modeById, drawFrame, isAnimated } from './modes.mjs';
import { createMilkdrop, checkSupport } from './milkdrop.mjs';

const PALETTE = Object.freeze({
  background: null,
  accent: '#e0a24a',
  warm: '#d98c5f',
  hot: '#f2d08a',
  good: '#8fbf7f',
  muted: '#9d9180',
  dim: 'rgba(157,145,128,0.18)',
  text: '#efe8da',
  petal: '#e9a6b4',
});

/**
 * Drive a canvas from an analyser.
 *
 * `getAnalyser` is called each frame rather than captured once, because the
 * analyser changes when playback moves between rungs and a captured one would
 * quietly go flat.
 */
export function createVisualiser({
  canvas,
  getAnalyser,
  // Only read for modes that declare `stereo`, so a build with no per-channel
  // tap costs nothing and every other mode is unaffected.
  getChannelAnalysers = () => null,
  palette = PALETTE,
  reducedMotion = () => false,
  onError = () => {},
  // Milkdrop seams, injectable so tests never touch WebGL or the GPU.
  milkdropFactory = createMilkdrop,
  milkdropSupport = checkSupport,
  now = () => performance.now(),
  // Seeds the modes' random streams; modes never call Math.random, so a fixed
  // seed and the same audio give the same pictures.
  seed = 0x5eed1e55,
  // 0..1, read each frame: "link to volume" passes the volume gain here so a
  // quiet player draws a quiet picture. 1 leaves the analyser data untouched.
  inputScale = () => 1,
}) {
  const context = canvas.getContext('2d');
  let mode = MODES[0];
  let frameId = 0;
  // Which pool `frameId` belongs to. Animation frames and timeouts number
  // independently, so cancelling one id in both pools can cancel an unrelated
  // callback — including the page's own clock frame, which nothing reschedules.
  let frameKind = null;
  let running = false;
  let memory = {};
  let freq = new Uint8Array(0);
  let wave = new Uint8Array(0);
  let freqLeft = new Uint8Array(0);
  let freqRight = new Uint8Array(0);
  // Milkdrop keeps one instance for the life of the driver (WebGL setup is
  // expensive), created on first use and paused while another mode runs.
  let milkdrop = null;
  let milkdropSupported = null; // probed once: the probe makes a WebGL context
  let lastFrameAt = 0;

  function resize() {
    // Match the backing store to the display size, capped so a full-window
    // visualiser on a retina display does not paint four times the pixels it
    // needs and drop frames doing it.
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.floor(canvas.clientWidth * ratio));
    const height = Math.max(1, Math.floor(canvas.clientHeight * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  function fail(error) {
    // A failing mode must not take the player with it, and must not stay
    // installed (see the catch in `frame`).
    mode = modeById('none');
    memory = {};
    stop();
    onError(error);
  }

  function dropMilkdrop() {
    milkdrop?.destroy();
    milkdrop = null;
  }

  function milkdropFrame() {
    const analyser = getAnalyser();
    resize();
    if (!analyser) {
      // Nothing is playing through a graph yet; show nothing rather than a
      // frozen picture.
      milkdrop?.pause();
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }
    if (milkdrop && milkdrop.audioContext !== analyser.context) dropMilkdrop();
    if (!milkdrop) {
      const instance = milkdropFactory({
        canvas, audioContext: analyser.context, sourceNode: analyser, reducedMotion,
        // setMode already probed; do not make a second WebGL context to ask again.
        support: () => (milkdropSupported ??= milkdropSupport()),
      });
      milkdrop = instance;
      instance.ready.catch(error => {
        if (milkdrop === instance) dropMilkdrop();
        if (mode.external === 'milkdrop') fail(error);
      });
    }
    milkdrop.setSource(analyser);
    const at = now();
    // Reduced motion: frames come every 500 ms and each advances the
    // animation by 1/30 s, so the picture moves at about a fifteenth of its
    // speed. Slower, not stopped, as with the 2D modes.
    const elapsedS = reducedMotion()
      ? 1 / 30
      : Math.min(0.25, lastFrameAt ? (at - lastFrameAt) / 1000 : 1 / 60);
    lastFrameAt = at;
    milkdrop.render({ width: canvas.width, height: canvas.height, elapsedS });
  }

  /** Fill the spectrum and wave buffers from the analysers for this frame. */
  function sampleAnalysers() {
    const analyser = getAnalyser();
    if (!analyser) {
      if (freq.length) {
        // No analyser: decay to silence rather than freezing the last frame,
        // which reads as a hang.
        for (let index = 0; index < freq.length; index += 1) freq[index] = Math.max(0, freq[index] - 12);
        wave.fill(128);
      }
      return;
    }
    if (freq.length !== analyser.frequencyBinCount) {
      freq = new Uint8Array(analyser.frequencyBinCount);
      wave = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);
    sampleChannels();
    const scale = inputScale();
    scaleInput(freq, wave, scale);
    if (freqLeft !== freq) { scaleInput(freqLeft, null, scale); scaleInput(freqRight, null, scale); }
  }

  /**
   * A mode that draws two channels is given two channels. Where the rung
   * cannot be split, both are the summed spectrum, which is what the file
   * actually is when it is mono, and is at least not labelled as something it
   * is not when it is not.
   */
  function sampleChannels() {
    const channels = mode.stereo ? getChannelAnalysers() : null;
    if (channels?.length !== 2) {
      freqLeft = freq;
      freqRight = freq;
      return;
    }
    if (freqLeft.length !== channels[0].frequencyBinCount) {
      freqLeft = new Uint8Array(channels[0].frequencyBinCount);
      freqRight = new Uint8Array(channels[1].frequencyBinCount);
    }
    channels[0].getByteFrequencyData(freqLeft);
    channels[1].getByteFrequencyData(freqRight);
  }

  function frame() {
    frameId = 0;
    frameKind = null;
    if (!running) return;
    try {
      if (mode.external === 'milkdrop') {
        milkdropFrame();
        schedule();
        return;
      }
      sampleAnalysers();
      resize();
      drawFrame(mode, {
        context, freq, wave, freqLeft, freqRight, palette, memory, seed,
        reduced: reducedMotion(),
        width: canvas.width, height: canvas.height,
      });
    } catch (error) {
      // A failing mode must not take the player with it — and must not be left
      // installed. `stop()` alone kept the throwing mode as the current one, so
      // the caller's next `start()` ran it again: throw, report, stop, restart,
      // once per frame for the life of the tab. The driver owns mode lifetime,
      // so the driver is what falls back, before the caller is told.
      if (mode.external === 'milkdrop') dropMilkdrop();
      fail(error);
      return;
    }
    schedule();
  }

  function schedule() {
    if (!running || frameId) return;
    // Reduced motion still shows the spectrum, just refreshed slowly enough not
    // to animate. Stopping entirely would remove information, not just motion.
    if (reducedMotion()) {
      frameKind = 'timeout';
      frameId = setTimeout(frame, 500);
    } else {
      frameKind = 'frame';
      frameId = requestAnimationFrame(frame);
    }
  }

  function start() {
    if (running || !isAnimated(mode)) return;
    running = true;
    schedule();
  }

  function stop() {
    running = false;
    lastFrameAt = 0;
    milkdrop?.pause();
    if (frameId) {
      if (frameKind === 'timeout') clearTimeout(frameId);
      else cancelAnimationFrame(frameId);
      frameId = 0;
      frameKind = null;
    }
    context.clearRect(0, 0, canvas.width, canvas.height);
  }

  return {
    start,
    stop,
    get running() { return running; },
    mode: () => mode.id,
    modes: () => MODES.map(({ id, label }) => ({ id, label })),
    setMode(id) {
      const next = modeById(id);
      if (next.external === 'milkdrop') {
        milkdropSupported ??= milkdropSupport();
        if (!milkdropSupported.ok) {
          // Refuse by name, and land on None so the caller persists a mode
          // that can run.
          fail(new Error(milkdropSupported.reason));
          return mode.id;
        }
      } else {
        milkdrop?.pause();
      }
      mode = next;
      memory = {}; // a mode never inherits another mode's state
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (isAnimated(mode)) start();
      else stop();
      return mode.id;
    },
    /**
     * Milkdrop controls for the shell: null until Milkdrop has run once.
     * `next(step)` changes preset; `loadPresetJson(text, name)` loads one from
     * disk and rejects with a reason when the file is not a preset.
     */
    milkdrop() {
      if (!milkdrop) return null;
      const instance = milkdrop;
      return {
        presetName: () => instance.presetName(),
        presetNames: () => instance.presetNames(),
        next: (step = 1) => instance.nextPreset(step),
        loadPresetJson: (text, name) => instance.loadPresetJson(text, name),
      };
    },
    cycle(step = 1) {
      const index = MODES.findIndex(candidate => candidate.id === mode.id);
      return this.setMode(MODES[(index + step + MODES.length) % MODES.length].id);
    },
  };
}

export { PALETTE };

/**
 * Scale analyser data in place by `scale` (0..1): spectrum bytes toward 0, waveform
 * bytes toward the 128 centre line. A scale of 1, or anything not a number, is a no-op.
 */
export function scaleInput(freq, wave, scale) {
  if (!(typeof scale === 'number' && Number.isFinite(scale)) || scale >= 1) return;
  const k = Math.max(0, scale);
  if (freq) for (let index = 0; index < freq.length; index += 1) freq[index] = Math.round(freq[index] * k);
  if (wave) for (let index = 0; index < wave.length; index += 1) wave[index] = Math.round(128 + (wave[index] - 128) * k);
}

// ------------------------------------------------------------ picker tiles ----
//
// The picker shows every mode drawing live in a small tile, from the same
// analyser as the main canvas. Tiles run at a few frames per second, never on
// the animation frame, and only while the picker is open. When drawing every
// tile costs more than the frame budget, each tick draws the next slice of
// tiles and the others keep their last picture.

export const PREVIEW_FPS = 6;
export const PREVIEW_REDUCED_DELAY_MS = 1000;
export const PREVIEW_BUDGET_MS = 6;

/** Milliseconds between preview ticks: `fps` frames a second, one a second under reduced motion. */
export function previewDelayMs({ fps = PREVIEW_FPS, reduced = false } = {}) {
  if (reduced) return PREVIEW_REDUCED_DELAY_MS;
  const rate = Math.min(30, Math.max(1, Number(fps) || PREVIEW_FPS));
  return Math.round(1000 / rate);
}

/**
 * Which tiles to draw this tick. `perTileMs` is the measured cost of one tile (0 before
 * the first measurement). Returns `{ indices, cursor }`: every tile while they fit the
 * budget, else `floor(budgetMs / perTileMs)` tiles (at least one) from `cursor` on,
 * wrapping, with the cursor for the next tick.
 */
export function planPreviewTick({ count, cursor = 0, perTileMs = 0, budgetMs = PREVIEW_BUDGET_MS }) {
  if (!Number.isInteger(count) || count <= 0) return { indices: [], cursor: 0 };
  const start = ((cursor % count) + count) % count;
  const fits = perTileMs > 0 ? Math.floor(budgetMs / perTileMs) : count;
  const take = Math.max(1, Math.min(count, fits));
  const indices = Array.from({ length: take }, (_, i) => (start + i) % count);
  return { indices, cursor: (start + take) % count };
}

/**
 * Drive the picker tiles. `tiles` is `[{ canvas, modeId }]`; a tile whose mode does not
 * draw in 2D (Milkdrop, None) is left to the caller's label. `start()` and `stop()` are
 * the picker's open and close; `drawn()` counts tile frames, for the gate.
 */
export function createPreviewGrid({
  tiles,
  getAnalyser,
  palette = PALETTE,
  reducedMotion = () => false,
  inputScale = () => 1,
  fps = PREVIEW_FPS,
  budgetMs = PREVIEW_BUDGET_MS,
  now = () => performance.now(),
  hidden = () => globalThis.document?.hidden === true,
  timers = globalThis,
  seed = 0x5eed1e55,
}) {
  const live = tiles
    .map(tile => ({ ...tile, mode: modeById(tile.modeId), memory: {}, context: tile.canvas.getContext('2d') }))
    .filter(tile => tile.mode.id === tile.modeId && typeof tile.mode.draw === 'function' && tile.context);
  let freq = new Uint8Array(0);
  let wave = new Uint8Array(0);
  let timer = null;
  let running = false;
  let cursor = 0;
  let perTileMs = 0;
  let drawn = 0;

  function sample() {
    const analyser = getAnalyser();
    if (!analyser) {
      for (let index = 0; index < freq.length; index += 1) freq[index] = Math.max(0, freq[index] - 24);
      wave.fill(128);
      return;
    }
    if (freq.length !== analyser.frequencyBinCount) {
      freq = new Uint8Array(analyser.frequencyBinCount);
      wave = new Uint8Array(analyser.fftSize);
    }
    analyser.getByteFrequencyData(freq);
    analyser.getByteTimeDomainData(wave);
    scaleInput(freq, wave, inputScale());
  }

  function tick() {
    timer = null;
    if (!running) return;
    if (!hidden() && live.length) {
      sample();
      const plan = planPreviewTick({ count: live.length, cursor, perTileMs, budgetMs });
      cursor = plan.cursor;
      const reduced = reducedMotion();
      const began = now();
      for (const index of plan.indices) {
        const tile = live[index];
        try {
          drawFrame(tile.mode, {
            context: tile.context, freq, wave, freqLeft: freq, freqRight: freq, palette, memory: tile.memory, seed,
            reduced, width: tile.canvas.width, height: tile.canvas.height,
          });
          drawn += 1;
        } catch {
          tile.mode = modeById('none'); // a failing tile goes blank; the picker stays open
        }
      }
      const cost = (now() - began) / Math.max(1, plan.indices.length);
      perTileMs = perTileMs ? perTileMs * 0.7 + cost * 0.3 : cost;
    }
    timer = timers.setTimeout(tick, previewDelayMs({ fps, reduced: reducedMotion() }));
  }

  return {
    start() {
      if (running) return;
      running = true;
      tick();
    },
    stop() {
      running = false;
      if (timer !== null) timers.clearTimeout(timer);
      timer = null;
    },
    get running() { return running; },
    drawn: () => drawn,
    tiles: () => live.map(tile => tile.modeId),
  };
}
