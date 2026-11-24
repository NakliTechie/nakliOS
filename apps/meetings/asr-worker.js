/*!
 * asr-worker.js — Meetings' speech recogniser: Whisper base through Transformers.js, on WebGPU when the browser has
 * an adapter, else on WebAssembly. The model downloads from Hugging Face once and stays in the browser's cache; the
 * audio never leaves this worker.
 *
 *   → { type:'load' }                       ← { type:'progress', data } … { type:'ready', backend, note }
 *   → { type:'run', id, audio, language }   ← { type:'text', id, text } | { type:'error', id, message }
 */
import * as transformers from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';

const { pipeline, env } = transformers;
export const MODEL = 'onnx-community/whisper-base';
env.allowLocalModels = false;

let asr = null, backend = null, note = '', loading = null;
const progress = p => self.postMessage({ type: 'progress', data: { status: p.status, progress: p.progress, file: p.file, loaded: p.loaded, total: p.total } });

async function hasGpu() {
  try { return !!(self.navigator?.gpu && await self.navigator.gpu.requestAdapter()); } catch { return false; }
}
function load() {
  return loading ||= (async () => {
    if (await hasGpu()) {
      try {
        asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: progress });
        backend = 'webgpu';
        return;
      } catch (e) { note = `WebGPU failed (${e?.message || e}), so it runs on the processor`; }
    } else note = 'No WebGPU adapter, so it runs on the processor';
    asr = await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: 'q8', progress_callback: progress });
    backend = 'wasm';
  })().catch(e => { loading = null; throw e; });
}

self.addEventListener('message', async ({ data: m }) => {
  try {
    if (m.type === 'load') { await load(); self.postMessage({ type: 'ready', backend, note, model: MODEL }); return; }
    if (m.type === 'run') {
      await load();
      const opts = { task: 'transcribe' };
      if (m.language) opts.language = m.language;
      const out = await asr(m.audio, opts);
      self.postMessage({ type: 'text', id: m.id, text: String(out?.text ?? '') });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id: m?.id, message: String(e?.message || e) });
  }
});
