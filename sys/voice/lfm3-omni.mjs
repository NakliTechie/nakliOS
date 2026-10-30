// lfm3-omni.mjs — LFM3-Omni-2B behind the voice assistant's generate() contract (adapter.mjs).
//
// anyformer loads the model (diskformer's ONNX engine on onnxruntime-web WebGPU; files cached in Cache Storage
// 'diskformer-models' after the first 2.1 GB download). Its session streams the reply as cumulative text and leaves
// tool calls as raw Qwen3-Coder XML, so this adapter holds back everything from the first call marker, parses the
// calls with the broker's parser (sys/ai/local-tool-calls.mjs) and speaks nothing of them.
// Text out only for now (audioOut: false): the panel speaks the text with an on-device system voice.
import { parseLocalToolCalls } from '../ai/local-tool-calls.mjs';

// anyformer 0.4.13 (tag v0.4.13), pinned by commit until the npm package is published.
export const ANYFORMER_URL = 'https://cdn.jsdelivr.net/gh/NakliTechie/anyformer.js@8f10d7cb0fa2d055903a16a11acc9214ccd353ac/index.js';
export const DOWNLOAD_BYTES = 2.14e9;

const MARKERS = ['<tool_call>', '<function='];

// Index where visible text must stop: the first call marker, or a trailing partial marker that may grow into one.
export function visibleEnd(text) {
  let end = text.length;
  for (const m of MARKERS) { const i = text.indexOf(m); if (i >= 0) end = Math.min(end, i); }
  if (end < text.length) return end;
  for (const m of MARKERS) {
    for (let k = Math.min(m.length - 1, text.length); k > 0; k--) {
      if (text.endsWith(m.slice(0, k))) { end = Math.min(end, text.length - k); break; }
    }
  }
  return end;
}

// The assistant's history (adapter.mjs shapes) into the chat template's messages.
export function toTemplateMessages(messages) {
  return messages.map((m) => {
    if (m.role === 'system') return { role: 'system', content: String(m.content) };
    if (m.role === 'tool') return { role: 'tool', content: String(m.content) };
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    if (m.role === 'assistant') {
      const out = { role: 'assistant', content: parts.filter((p) => p.type === 'text').map((p) => p.text).join('') };
      if (m.toolCalls?.length) out.tool_calls = m.toolCalls.map((c) => ({ type: 'function', function: { name: c.name, arguments: c.arguments || {} } }));
      return out;
    }
    return { role: m.role, content: parts };
  });
}

// Whether the decoder (the largest file) is already in the engine's cache, from any source URL.
export async function isCached({ cacheStorage = globalThis.caches } = {}) {
  try {
    if (!cacheStorage) return false;
    if (!(await cacheStorage.keys()).includes('diskformer-models')) return false;
    const keys = await (await cacheStorage.open('diskformer-models')).keys();
    return keys.some((r) => /LFM3-Omni-2B|omni-2b/i.test(r.url) && r.url.endsWith('decoder_q4f16.onnx_data'));
  } catch { return false; }
}

export function createLfm3OmniModel({ url = ANYFORMER_URL, importer = (u) => import(u), maxNewTokens = 384 } = {}) {
  let session = null, loading = null;
  const model = {
    id: 'lfm3-omni-2b',
    label: 'LFM3-Omni 2B',
    ready: false,
    audioOut: false,
    downloadLabel: `${(DOWNLOAD_BYTES / 1e9).toFixed(1)} GB`,
    isCached,
    load({ onProgress, signal } = {}) {
      loading ||= (async () => {
        const af = await importer(url);
        session = await af.load(af.MODELS.chat.LFM3_OMNI_2B, { onProgress, signal });
        model.ready = true;
      })().catch((e) => { loading = null; throw e; });
      return loading;
    },
    async generate({ messages, tools = [], onText, signal } = {}) {
      if (!session) await model.load({ signal });
      let full = '', shown = 0, tokens = 0;
      for await (const chunk of session.generate(toTemplateMessages(messages), { signal, maxNewTokens, thinking: false, ...(tools.length ? { tools } : {}) })) {
        full = chunk.text; tokens = chunk.tokens || 0;
        const end = visibleEnd(full);
        if (end > shown) { onText?.(full.slice(shown, end)); shown = end; }
      }
      if (signal?.aborted) return { text: full.slice(0, shown), toolCalls: [], stopReason: 'aborted' };
      const { content, toolCalls } = parseLocalToolCalls(full, tools, { idPrefix: 'voice' });
      // A held partial marker that never became a call is ordinary text.
      if (!toolCalls.length && full.length > shown) { onText?.(full.slice(shown)); shown = full.length; }
      return {
        text: toolCalls.length ? content : full,
        toolCalls: toolCalls.map((c) => ({ name: c.function.name, arguments: JSON.parse(c.function.arguments) })),
        stopReason: toolCalls.length ? 'tool_calls' : tokens >= maxNewTokens ? 'length' : 'stop',
      };
    },
    dispose() { session?.dispose?.(); session = null; loading = null; model.ready = false; },
  };
  return model;
}
