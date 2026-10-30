// lfm3-omni.mjs — LFM3-Omni-2B behind the voice assistant's generate() contract (adapter.mjs).
//
// anyformer loads the model (diskformer's ONNX engine on onnxruntime-web WebGPU; files cached in Cache Storage
// 'diskformer-models' after the first 2.7 GB download). Its session streams the reply as cumulative text and leaves
// tool calls as raw Qwen3-Coder XML, so this adapter holds back everything from the first call marker, parses the
// calls with the broker's parser (sys/ai/local-tool-calls.mjs) and speaks nothing of them.
// Speech out (speech: true, the default): the model writes 6 text tokens, then 12 speech frames, in turn, so a call
// marker shows in the text before its sound; audio stops at the marker and the reply is cut once the call closes.
// With speech: false the panel speaks the text with an on-device system voice instead.
import { parseLocalToolCalls } from '../ai/local-tool-calls.mjs';

// anyformer 0.4.14 (speech out), the published npm version.
export const ANYFORMER_URL = 'https://cdn.jsdelivr.net/npm/anyformer@0.4.14/index.js';
export const DOWNLOAD_BYTES = 2.14e9;
export const SPEECH_BYTES = 0.515e9;
// The engine adds this system turn only when the messages have none, and the assistant always sends its own.
export const SPEECH_SYSTEM_PROMPT = 'Respond with interleaved text and audio.';

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

// Whether the model's files are already in the engine's cache, from Hugging Face: the decoder (the largest file) and,
// for speech, the depth decoder, so a cached text model never starts the 515 MB speech download unasked.
export async function isCached({ cacheStorage = globalThis.caches, speech = true } = {}) {
  try {
    if (!cacheStorage) return false;
    if (!(await cacheStorage.keys()).includes('diskformer-models')) return false;
    const urls = (await (await cacheStorage.open('diskformer-models')).keys()).map((r) => r.url).filter((u) => /LFM3-Omni-2B/i.test(u));
    const has = (re) => urls.some((u) => re.test(u));
    return has(/decoder_q4f16\.onnx_data$/) && (!speech || has(/depth_decoder\.onnx(_data)?$/));
  } catch { return false; }
}

// maxNewTokens counts text tokens and 80 ms speech frames together, so a spoken reply needs far more than a text one.
export function createLfm3OmniModel({ url = ANYFORMER_URL, importer = (u) => import(u), speech = true, maxNewTokens = speech ? 2048 : 384 } = {}) {
  let session = null, loading = null;
  const model = {
    id: 'lfm3-omni-2b',
    label: 'LFM3-Omni 2B',
    ready: false,
    audioOut: speech,
    downloadLabel: `${((DOWNLOAD_BYTES + (speech ? SPEECH_BYTES : 0)) / 1e9).toFixed(1)} GB`,
    // Also says how much is left to fetch, so a browser that has the text model hears "0.5 GB", not "2.7 GB".
    async isCached(opts) {
      if (await isCached({ ...opts, speech })) return true;
      if (speech && await isCached({ ...opts, speech: false })) model.downloadLabel = `${(SPEECH_BYTES / 1e9).toFixed(1)} GB of speech files`;
      return false;
    },
    load({ onProgress, signal } = {}) {
      loading ||= (async () => {
        const af = await importer(url);
        session = await af.load(af.MODELS.chat.LFM3_OMNI_2B, { onProgress, signal, ...(speech && { speech: true }) });
        model.ready = true;
      })().catch((e) => { loading = null; throw e; });
      return loading;
    },
    async generate({ messages, tools = [], onText, onAudio, signal, speech: speak = speech } = {}) {
      if (!session) await model.load({ signal });
      let msgs = toTemplateMessages(messages);
      if (speak) msgs = msgs.map((m) => (m.role === 'system' ? { ...m, content: `${m.content}\n${SPEECH_SYSTEM_PROMPT}` } : m));
      // Our own stop: a closed tool call ends the reply, so no time goes to voicing its markup.
      const inner = new AbortController();
      const onAbort = () => inner.abort();
      signal?.addEventListener('abort', onAbort, { once: true });
      let full = '', shown = 0, tokens = 0, marked = false;
      try {
        for await (const chunk of session.generate(msgs, {
          signal: inner.signal, maxNewTokens, thinking: false, ...(tools.length ? { tools } : {}), ...(speak && { speech: true }),
        })) {
          full = chunk.text ?? full; tokens = chunk.tokens || tokens;
          const end = visibleEnd(full);
          if (end > shown) { onText?.(full.slice(shown, end)); shown = end; }
          marked ||= end < full.length && MARKERS.some((m) => full.includes(m));
          // A copy, because the chunk can be a view of the engine's own buffer.
          if (chunk.audio?.length && !marked && !signal?.aborted) onAudio?.(Float32Array.from(chunk.audio));
          if (marked && /<\/tool_call>|<\/function>/.test(full)) { inner.abort(); break; }
        }
      } finally { signal?.removeEventListener('abort', onAbort); }
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
