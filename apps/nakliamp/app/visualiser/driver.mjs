// Visualiser driver.
//
// Owns the animation frame, the canvas sizing, and the analyser buffers. Modes
// stay pure; everything with a lifetime lives here, so switching modes or
// stopping cannot leak a frame callback or a stale canvas.

import { MODES, modeById, drawFrame } from './modes.mjs';

const PALETTE = Object.freeze({
  background: null,
  accent: '#e0a24a',
  warm: '#d98c5f',
  hot: '#f2d08a',
  good: '#8fbf7f',
  muted: '#9d9180',
  dim: 'rgba(157,145,128,0.18)',
  text: '#efe8da',
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

  function frame() {
    frameId = 0;
    frameKind = null;
    if (!running) return;
    try {
      const analyser = getAnalyser();
      if (analyser) {
        if (freq.length !== analyser.frequencyBinCount) {
          freq = new Uint8Array(analyser.frequencyBinCount);
          wave = new Uint8Array(analyser.fftSize);
        }
        analyser.getByteFrequencyData(freq);
        analyser.getByteTimeDomainData(wave);
        // A mode that draws two channels is given two channels. Where the rung
        // cannot be split, both are the summed spectrum — which is what the
        // file actually is when it is mono, and is at least not labelled as
        // something it is not when it is not.
        const channels = mode.stereo ? getChannelAnalysers() : null;
        if (channels?.length === 2) {
          if (freqLeft.length !== channels[0].frequencyBinCount) {
            freqLeft = new Uint8Array(channels[0].frequencyBinCount);
            freqRight = new Uint8Array(channels[1].frequencyBinCount);
          }
          channels[0].getByteFrequencyData(freqLeft);
          channels[1].getByteFrequencyData(freqRight);
        } else {
          freqLeft = freq;
          freqRight = freq;
        }
      } else if (freq.length) {
        // No analyser: decay to silence rather than freezing the last frame,
        // which reads as a hang.
        for (let index = 0; index < freq.length; index += 1) freq[index] = Math.max(0, freq[index] - 12);
        wave.fill(128);
      }
      resize();
      drawFrame(mode, {
        context, freq, wave, freqLeft, freqRight, palette, memory,
        width: canvas.width, height: canvas.height,
      });
    } catch (error) {
      // A failing mode must not take the player with it — and must not be left
      // installed. `stop()` alone kept the throwing mode as the current one, so
      // the caller's next `start()` ran it again: throw, report, stop, restart,
      // once per frame for the life of the tab. The driver owns mode lifetime,
      // so the driver is what falls back, before the caller is told.
      mode = modeById('none');
      memory = {};
      stop();
      onError(error);
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
    if (running || !mode.draw) return;
    running = true;
    schedule();
  }

  function stop() {
    running = false;
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
      mode = modeById(id);
      memory = {}; // a mode never inherits another mode's state
      context.clearRect(0, 0, canvas.width, canvas.height);
      if (mode.draw) start();
      else stop();
      return mode.id;
    },
    cycle(step = 1) {
      const index = MODES.findIndex(candidate => candidate.id === mode.id);
      return this.setMode(MODES[(index + step + MODES.length) % MODES.length].id);
    },
  };
}

export { PALETTE };
