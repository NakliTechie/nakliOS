/* Reel ai module: the removable local speech model (Q1), ported from Montella's src/speech.js
 * (same author; Montella ported it from Sonella).
 *
 * Reel keeps no model files. Inside NakliOS it fetches Sonella's files from the same site
 * (../sonella/ai/...), checks each file's pinned SHA-256, and keeps them in Cache Storage under
 * Sonella's cache name and key prefix, so one download serves Sonella, Montella and Reel.
 * Transcription runs Whisper tiny (multilingual, q8) through transformers.js in a worker on
 * WebAssembly, never WebGPU (q8 Whisper decoders give gibberish on WebGPU, transformers.js issue 1317).
 * Removing the model leaves every other feature as it was.
 * No DOM or location access at module top level: build-commands.mjs imports this in Node. */

const fail = (code, message) => Object.assign(new Error(message), { code });
const SONELLA_BASE = () => new URL('../sonella/', location.href).href;
const MODEL_DIR = 'ai/whisper-tiny-ff41770/';

// Identical to Montella's SPEECH manifest (and Sonella's): versions @huggingface/transformers 4.3.2,
// onnxruntime-web 1.31.0-dev.20260914-8d85527a0 (plain SIMD build), onnx-community/whisper-tiny at
// revision ff4177021cc41f7db950912b73ea4fdf7d01d8e7 (OpenAI Whisper tiny, MIT; the q8 files).
export const SPEECH = {
  name: 'Whisper tiny (multilingual, q8) on ONNX Runtime Web',
  cache: 'sonella-speech-v1',
  runtime: { path: 'ai/transformers-4.3.2.min.js', bytes: 587917, sha256: '8b5a3171f8876bab2b1820a7d65eb87628e3d30bb5ea85b9dd398e76eb34decb' },
  ortMjs: { path: 'ai/ort-wasm-simd-threaded-1.31.0-dev.20260914.mjs', bytes: 24381, sha256: 'c57ca56328877353a575e51bbca6f18450027d6c9bf2307a2cb2c41363b4de9f' },
  ortWasm: { path: 'ai/ort-wasm-simd-threaded-1.31.0-dev.20260914.wasm', bytes: 14264838, sha256: '06ba057753da3847e4c24f02d91ab133455b0817c69a44993a9a53a2146df9e3' },
  model: [
    { name: 'config.json', bytes: 2243, sha256: '46aeea0a406afbeb563fc8e59ca10609203df4299af6a83f73752fef369efd2d' },
    { name: 'generation_config.json', bytes: 3772, sha256: 'f5c67e5a4f7102f8cb4d058bc95da276bbc19eeec997267c3bb0f25ef68facd1' },
    { name: 'preprocessor_config.json', bytes: 339, sha256: 'a6a76d28c93edb273669eb9e0b0636a2bddbb1272c3261e47b7ca6dfdbac1b8d' },
    { name: 'tokenizer.json', bytes: 2480466, sha256: '27fc476bfe7f17299480be2273fc0608e4d5a99aba2ab5dec5374b4482d1a566' },
    { name: 'tokenizer_config.json', bytes: 282683, sha256: '2a4c4281cf9f51ac6ccc406fdc711a087afe6530f671fa7b80953edc498275ce' },
    { name: 'onnx/encoder_model_quantized.onnx', file: 'encoder_model_quantized.onnx', bytes: 10124990, sha256: '2af4a414ca47aa30f61246017e5fe82b0a8d229281d1255ba666a2a7f6b84d19' },
    { name: 'onnx/decoder_model_merged_quantized.onnx', file: 'decoder_model_merged_quantized.onnx', parts: 2, bytes: 30719241, sha256: '25e807a962b6349356d0ea5d0dfe530b7e5bf0e2a484aeca0359d03143faddd3' },
  ],
};

export const speechFiles = () => [SPEECH.runtime, SPEECH.ortMjs, SPEECH.ortWasm, ...SPEECH.model.map(f => ({ ...f, path: MODEL_DIR + (f.file ?? f.name) }))]
  .map(f => ({ ...f, urls: f.parts ? Array.from({ length: f.parts }, (_, i) => `${f.path}.part${i}`) : [f.path] }));
export const SPEECH_BYTES = speechFiles().reduce((s, f) => s + f.bytes, 0);
export const speechMB = () => (SPEECH_BYTES / 1048576).toFixed(0);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const open = () => caches.open(SPEECH.cache);
// Cache keys live under one made-up origin-absolute path shared with Sonella and Montella.
const key = path => new URL(`/__sonella-speech/${path}`, location.href).href;
async function cachedSet() {
  try {
    const c = await open();
    return new Set((await c.keys()).map(r => new URL(r.url).pathname.split('/__sonella-speech/')[1]));
  } catch { return new Set(); }
}

let worker = null, ready = null, loaded = false, loading = false, downloading = false, seq = 0, gen = 0;
let refused = [];
const pending = new Map();

export async function speechStatus() {
  const available = typeof caches !== 'undefined' && location.protocol !== 'file:';
  const have = available ? await cachedSet() : new Set();
  const downloaded = speechFiles().every(f => have.has(f.path));
  const state = loaded ? 'loaded' : (loading || downloading) ? 'loading' : downloaded ? 'cached' : 'absent';
  return { model: SPEECH.name, state, downloaded, bytes: SPEECH_BYTES, cache: SPEECH.cache, refusedRequests: refused.length, available };
}

/* Fetch every file not yet kept, check it, keep it. An interrupted download resumes. */
export async function downloadSpeech({ signal, onProgress } = {}) {
  if (typeof caches === 'undefined') throw fail('REFUSED', 'This browser has no Cache Storage here, so the speech model cannot be kept');
  downloading = true;
  try {
    const have = await cachedSet();
    let done = 0, kept = 0;
    const cancelled = () => fail('CANCELLED', 'The download was cancelled; the files already checked are kept, and the next download resumes');
    for (const f of speechFiles()) {
      if (have.has(f.path)) { done += f.bytes; continue; }
      const chunks = [];
      for (const u of f.urls) {
        if (signal?.aborted) throw cancelled();
        const res = await fetch(new URL(u, SONELLA_BASE()).href, { cache: 'no-store', signal }).catch(() => null);
        if (signal?.aborted) throw cancelled();
        if (!res?.ok) throw fail('REFUSED', `The speech model file ${u} could not be fetched from ${SONELLA_BASE()} (Reel uses Sonella's copy, which exists inside NakliOS)`);
        const body = await res.arrayBuffer().catch(() => null);
        if (!body) throw signal?.aborted ? cancelled() : fail('REFUSED', `The speech model file ${u} stopped part way; download again to resume`);
        chunks.push(new Uint8Array(body));
        done += body.byteLength;
        onProgress?.(Math.min(1, done / SPEECH_BYTES));
      }
      const buf = new Uint8Array(chunks.reduce((s, x) => s + x.length, 0));
      chunks.reduce((o, x) => (buf.set(x, o), o + x.length), 0);
      const got = hex(await crypto.subtle.digest('SHA-256', buf));
      if (got !== f.sha256 || buf.length !== f.bytes) throw fail('REFUSED', `The speech model file ${f.path} did not match its pinned checksum (got ${got.slice(0, 12)}…); it was not kept`);
      await (await open()).put(key(f.path), new Response(buf));
      kept += buf.length;
    }
    return { kept, bytes: SPEECH_BYTES };
  } finally {
    downloading = false;
  }
}

/* Stops the worker (a cancel mid-window, or a removal). The kept files stay. */
export function stopSpeech(err = fail('CANCELLED', 'Transcription was cancelled')) {
  gen++;
  worker?.terminate();
  worker = null; ready = null; loaded = false; loading = false; refused = [];
  for (const { reject } of pending.values()) reject(err);
  pending.clear();
}

function ask(msg, transfer = []) {
  if (!worker) return Promise.reject(fail('REFUSED', 'The speech model stopped; nothing more was transcribed'));
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); worker.postMessage({ ...msg, id }, transfer); });
}

function load() {
  if (ready) return ready;
  const my = ++gen;
  loading = true;
  const p = (async () => {
    const c = await open().catch(() => null);
    const bytes = {};
    for (const f of speechFiles()) {
      const r = await c?.match(key(f.path));
      if (!r) throw fail('REFUSED', `The speech model is not downloaded (about ${speechMB()} MB); the person must choose Generate subtitles and agree to the download.`);
      bytes[f.path] = await r.arrayBuffer();
    }
    if (my !== gen) throw fail('CANCELLED', 'The speech model was stopped while it was loading');
    const w = new Worker(new URL('./asr-worker.js', import.meta.url));
    worker = w;
    w.addEventListener('message', ({ data: m }) => {
      if (m.refused?.length && worker === w) refused.push(...m.refused);
      const q = pending.get(m.id);
      if (!q) return;
      pending.delete(m.id);
      if (m.ok) q.resolve(m); else q.reject(fail('REFUSED', `The local speech model failed: ${m.error}`));
    });
    w.addEventListener('error', e => { if (worker === w) stopSpeech(fail('REFUSED', `The local speech model failed to start: ${e.message ?? 'worker error'}`)); });
    const files = Object.fromEntries(SPEECH.model.map(f => [f.name, bytes[MODEL_DIR + (f.file ?? f.name)]]));
    await ask({ type: 'load', runtime: bytes[SPEECH.runtime.path], ortMjs: bytes[SPEECH.ortMjs.path], ortWasm: bytes[SPEECH.ortWasm.path], files }, Object.values(bytes));
    if (my === gen) { loaded = true; loading = false; }
  })();
  ready = p;
  p.catch(err => { if (my === gen) stopSpeech(err); });
  return p;
}

/* 16 kHz mono, at most 30 s, in; text and segment chunks (seconds from the window start) out. */
export async function transcribeLocal(audio, { language } = {}) {
  await load();
  const r = await ask({ type: 'run', audio, language: language || null });
  return { text: r.text, chunks: r.chunks || [] };
}
