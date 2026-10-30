// audio.mjs — microphone capture at 16 kHz mono, a simple voice-activity detector for end of turn,
// and streaming playback of 24 kHz chunks that stops at once when the person talks over it.
// createVad and concatFloat32 are pure (node tests); the mic and the player need a browser.
import { INPUT_SAMPLE_RATE, OUTPUT_SAMPLE_RATE, MAX_TURN_SECONDS } from './adapter.mjs';

export function concatFloat32(chunks) {
  const out = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

export function rms(frame) {
  let s = 0;
  for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
  return frame.length ? Math.sqrt(s / frame.length) : 0;
}

// Energy detector with an adaptive noise floor. Speech starts after minSpeechMs above the threshold;
// the turn ends after endSilenceMs below it. push(frame) returns 'start', 'end' or null.
export function createVad({ sampleRate = INPUT_SAMPLE_RATE, threshold = 0.015, ratio = 3, minSpeechMs = 120, endSilenceMs = 800 } = {}) {
  let floor = 0.003, speaking = false, above = 0, below = 0;
  return {
    get speaking() { return speaking; },
    push(frame) {
      const level = rms(frame);
      const ms = (frame.length / sampleRate) * 1000;
      const loud = level > Math.max(threshold, floor * ratio);
      if (!speaking && !loud) floor = floor * 0.95 + level * 0.05;
      if (loud) { above += ms; below = 0; } else { below += ms; above = 0; }
      if (!speaking && above >= minSpeechMs) { speaking = true; return 'start'; }
      if (speaking && below >= endSilenceMs) { speaking = false; return 'end'; }
      return null;
    },
    reset() { speaking = false; above = 0; below = 0; },
  };
}

const WORKLET = `registerProcessor('nakli-voice-tap', class extends AudioWorkletProcessor {
  process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice(0)); return true; }
});`;

// Mic → 16 kHz Float32 frames. The AudioContext runs at 16 kHz, so the browser resamples the mic.
// onFrame gets about 8 ms frames; onLevel gets their RMS for the orb.
export async function openMic({ onFrame, onLevel = () => {} }) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
  try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, 'nakli-voice-tap');
  tap.port.onmessage = (e) => { onLevel(rms(e.data)); onFrame(e.data); };
  source.connect(tap);
  return {
    sampleRate: ctx.sampleRate,
    async close() {
      tap.port.onmessage = null;
      source.disconnect();
      stream.getTracks().forEach((t) => t.stop());
      await ctx.close();
    },
  };
}

// Collects one turn of speech and stops at the cap.
export function createTurnRecorder({ sampleRate = INPUT_SAMPLE_RATE, maxSeconds = MAX_TURN_SECONDS } = {}) {
  let chunks = [], length = 0;
  return {
    push(frame) { if (length < maxSeconds * sampleRate) { chunks.push(frame); length += frame.length; } return length >= maxSeconds * sampleRate; },
    get seconds() { return length / sampleRate; },
    take() { const out = concatFloat32(chunks); chunks = []; length = 0; return out; },
  };
}

// Plays 24 kHz chunks back to back. stop() silences everything queued; drained() resolves when idle.
export function createPlayer({ sampleRate = OUTPUT_SAMPLE_RATE, onLevel = () => {} } = {}) {
  let ctx = null, at = 0, sources = new Set(), waiters = [];
  const settle = () => { if (!sources.size) { waiters.splice(0).forEach((r) => r()); onLevel(0); } };
  return {
    // Call from a user gesture first, so the context is allowed to start.
    unlock() { ctx ||= new AudioContext({ sampleRate }); return ctx.resume(); },
    get playing() { return sources.size > 0; },
    enqueue(chunk) {
      ctx ||= new AudioContext({ sampleRate });
      const buf = ctx.createBuffer(1, chunk.length, sampleRate);
      buf.copyToChannel(chunk, 0);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(ctx.destination);
      at = Math.max(at, ctx.currentTime + 0.02);
      src.start(at);
      at += buf.duration;
      sources.add(src);
      onLevel(Math.min(1, rms(chunk) * 6));
      src.onended = () => { sources.delete(src); settle(); };
    },
    stop() {
      for (const s of sources) { s.onended = null; try { s.stop(); } catch {} }
      sources.clear(); at = 0; settle();
    },
    drained() { return sources.size ? new Promise((r) => waiters.push(r)) : Promise.resolve(); },
  };
}
