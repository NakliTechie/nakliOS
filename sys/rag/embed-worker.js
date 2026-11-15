/*!
 * embed-worker.js — NakliOS semantic-index embedding worker.
 *
 * Loads all-MiniLM-L6-v2 (384-dim) through Transformers.js and mean-pools
 * normalized sentence embeddings, mirroring the VaultMind indexer that proved
 * the pipeline. One request at a time; the host serializes calls.
 *
 * With `ane: true` it first tries the Apple Neural Engine through WebNN
 * (sdk/ane-embed.js: fp16, a load check against an fp32 reference vector).
 * When WebNN is missing or the check fails, the WebGPU/WASM pipeline below runs
 * as before, and `note` in the ready message says why.
 *
 * Protocol (structured clone):
 *   → { type:'load', device:'webgpu'|'wasm', ane?:boolean }
 *   ← { type:'progress', data:{ status, progress?, file? } }
 *   ← { type:'ready', backend:'webnn-npu'|'webgpu'|'wasm', note } | { type:'error', message }
 *   ← { type:'backend', backend, note }   (a Neural Engine run failed; the CPU path takes over)
 *   → { type:'embed', id, texts:[string] }
 *   ← { type:'embeddings', id, vectors:[Float32Array(384)] } | { type:'error', id?, message }
 */
// 4.3.2: the first version whose WebNN path works (sdk/ane-embed.js MIN_TRANSFORMERS_VERSION).
import * as transformers from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/+esm';

const { pipeline, env } = transformers;
const MODEL = 'Xenova/all-MiniLM-L6-v2';
const ANE_URL = new URL('../../sdk/ane-embed.js', import.meta.url).href;

env.allowLocalModels = false;

let embedder = null;
let cpuDevice = 'wasm';

const progress = p => {
  self.postMessage({
    type:'progress',
    data:{ status:p.status, progress:p.progress, file:p.file },
  });
};

// The pre-WebNN path, unchanged: one batched pipeline call per request.
async function loadCpu(){
  const extractor = await pipeline('feature-extraction', MODEL, {
    device: cpuDevice,
    dtype: cpuDevice === 'webgpu' ? 'fp16' : 'q8',
    progress_callback: progress,
  });
  return async texts => {
    const out = await extractor(texts, { pooling:'mean', normalize:true });
    const dims = out.dims || [texts.length, 384];
    const dim = dims[dims.length - 1] || 384;
    const vectors = [];
    for (let i = 0; i < texts.length; i++) vectors.push(out.data.slice(i * dim, (i + 1) * dim));
    return vectors;
  };
}

self.addEventListener('message', async event => {
  const msg = event.data || {};
  if (msg.type === 'load'){
    if (embedder){ self.postMessage({ type:'ready', backend:embedder.backend, note:embedder.note }); return; }
    cpuDevice = msg.device === 'webgpu' ? 'webgpu' : 'wasm';
    try {
      let createEmbedder = null, note = '';
      if (msg.ane){
        try { ({ createEmbedder } = await import(ANE_URL)); }
        catch (err){ note = 'the Neural Engine module did not load: ' + String(err?.message || err).slice(0, 160) + '.'; }
      }
      if (createEmbedder){
        embedder = await createEmbedder(transformers, MODEL, {
          loadCpu,
          progress,
          onBackend: (backend, why) => { if (embedder) self.postMessage({ type:'backend', backend: backend === 'cpu' ? cpuDevice : backend, note: why }); },
        });
      } else {
        const cpu = await loadCpu();
        embedder = { backend:'cpu', note, embed: cpu };
      }
      const backend = embedder.backend === 'cpu' ? cpuDevice : embedder.backend;
      self.postMessage({ type:'ready', backend, note:embedder.note });
    } catch (err){
      embedder = null;
      self.postMessage({ type:'error', message:String(err?.message || err) });
    }
    return;
  }
  if (msg.type === 'embed'){
    if (!embedder){
      self.postMessage({ type:'error', id:msg.id, message:'Embedding model is not loaded' });
      return;
    }
    try {
      const texts = Array.isArray(msg.texts) ? msg.texts.map(String) : [];
      if (!texts.length){
        self.postMessage({ type:'embeddings', id:msg.id, vectors:[] });
        return;
      }
      const vectors = await embedder.embed(texts);
      self.postMessage({ type:'embeddings', id:msg.id, vectors });
    } catch (err){
      self.postMessage({ type:'error', id:msg.id, message:String(err?.message || err) });
    }
  }
});
