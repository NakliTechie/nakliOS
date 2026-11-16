// Reel speech worker (ported from Montella's src/workers/asr.js, same author): runs Whisper tiny through
// transformers.js on ONNX Runtime's WebAssembly backend. app/ai/speech.mjs hands it every file it needs,
// already checked against the pinned hashes; the runtime is imported from a blob URL, model files are
// served from memory through transformers.js's custom-cache hook, and env.fetch answers 404, so nothing
// here touches the network.
const MODEL_ID = 'reel/whisper-tiny';
let pipe = null;
let refused = [];

async function load(m) {
  const blob = (bytes, type) => URL.createObjectURL(new Blob([bytes], { type }));
  const T = await import(blob(m.runtime, 'text/javascript'));
  if (typeof T.pipeline !== 'function' || !T.env?.backends?.onnx?.wasm) throw new Error('the speech runtime lacks pipeline() or its ONNX settings');
  const { env } = T;
  const files = new Map(Object.entries(m.files));
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.useWasmCache = false;
  env.useCustomCache = true;
  env.customCache = {
    match: async (k) => {
      const s = String(k?.url ?? k), at = s.indexOf(`/${MODEL_ID}/`), b = at < 0 ? null : files.get(s.slice(at + MODEL_ID.length + 2));
      if (!b) { refused.push(s); return undefined; }
      return new Response(b);
    },
    put: async () => {},
  };
  env.fetch = async (u) => { refused.push(String(u?.url ?? u)); return new Response(null, { status: 404, statusText: 'Reel fetches nothing here' }); };
  const wasm = env.backends.onnx.wasm;
  wasm.wasmPaths = { mjs: blob(m.ortMjs, 'text/javascript'), wasm: blob(m.ortWasm, 'application/wasm') };
  wasm.wasmBinary = m.ortWasm;
  // One thread: the NakliOS iframe is not cross-origin isolated.
  wasm.numThreads = 1;
  wasm.proxy = false;
  pipe = await T.pipeline('automatic-speech-recognition', MODEL_ID, { dtype: 'q8', device: 'wasm' });
}

const reply = (msg) => { self.postMessage({ ...msg, refused }); refused = []; };
self.onmessage = async ({ data: m }) => {
  try {
    if (m.type === 'load') { await load(m); reply({ id: m.id, ok: true }); return; }
    if (m.type === 'run') {
      if (!pipe) throw new Error('the model is not loaded');
      const options = { task: 'transcribe', return_timestamps: true };
      if (m.language) options.language = m.language;
      // Temperature fallback (speech.mjs): sampling at the given temperature. transformers.js 4.3.2 reads
      // do_sample and temperature from the generation options; it has no compression-ratio, log-prob or
      // no-speech thresholds, so speech.mjs and logic.mjs apply those rules outside the model.
      if (m.temperature > 0) { options.do_sample = true; options.temperature = m.temperature; }
      const out = await pipe(m.audio, options);
      const chunks = (out?.chunks || []).map((c) => ({ start: c.timestamp?.[0] ?? 0, end: c.timestamp?.[1] ?? null, text: String(c.text || '').trim() }));
      reply({ id: m.id, ok: true, text: String(out?.text ?? '').trim(), chunks });
    }
  } catch (e) {
    reply({ id: m.id, ok: false, error: String(e?.message ?? e) });
  }
};
