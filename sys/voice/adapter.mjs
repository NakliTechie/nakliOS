// adapter.mjs — the seam between the voice assistant and a speech model.
//
// Contract (agreed with the LocalMind/diskformer engine, 2026-10-30):
//   model.load({ onProgress({ loaded, total, file }) }) → Promise; model.ready is true afterwards.
//   model.generate({ messages, tools, onText(delta), onAudio(Float32Array), signal })
//     → Promise<{ text, toolCalls: [{ name, arguments }], stopReason }>
// messages: { role: 'system'|'user'|'assistant'|'tool', content }. User and assistant content is a
// list of parts: { type:'text', text } · { type:'audio', audio: Float32Array 16 kHz mono } ·
// { type:'image', image: Blob|ImageBitmap }. A tool message is { role:'tool', name, content: JSON string }.
// onAudio receives 24 kHz mono Float32 chunks. Tool-call markup never reaches onText or onAudio.
// An abort through `signal` resolves with stopReason 'aborted'.
//
// The stub below runs the whole loop with no GPU and no model: it routes a few phrases to tools,
// echoes everything else, and speaks a soft tone per word.

export const INPUT_SAMPLE_RATE = 16000;
export const OUTPUT_SAMPLE_RATE = 24000;
export const MAX_TURN_SECONDS = 30;

const sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});

// One short sine burst with a fade in and out, so chunks join without clicks.
export function tone({ seconds = 0.12, hz = 523.25, gain = 0.12, sampleRate = OUTPUT_SAMPLE_RATE } = {}) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float32Array(n);
  const fade = Math.min(n >> 2, Math.round(0.01 * sampleRate));
  for (let i = 0; i < n; i++) {
    const env = Math.min(1, i / fade, (n - 1 - i) / fade);
    out[i] = Math.sin(2 * Math.PI * hz * i / sampleRate) * gain * env;
  }
  return out;
}

export function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: String(m.content ?? '') }];
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join(' ').trim();
    const audio = parts.filter((p) => p.type === 'audio').reduce((s, p) => s + p.audio.length, 0);
    return { text, audioSeconds: audio / INPUT_SAMPLE_RATE };
  }
  return { text: '', audioSeconds: 0 };
}

// Phrase → tool call, only for tools the caller offered.
function routeToTool(text, offered) {
  const t = text.toLowerCase();
  const has = (name) => offered.has(name);
  let m;
  if (has('set_timer') && (m = t.match(/timer[^0-9]*(\d+)\s*(second|sec|minute|min)/) || t.match(/(\d+)\s*(second|sec|minute|min)\w*\s+timer/))) {
    const n = Number(m[1]);
    return { name: 'set_timer', arguments: { seconds: /min/.test(m[2]) ? n * 60 : n } };
  }
  if (has('get_battery') && /battery/.test(t)) return { name: 'get_battery', arguments: {} };
  if (has('get_network_status') && /\b(online|offline|network|connect(ed|ion)?|internet)\b/.test(t)) return { name: 'get_network_status', arguments: {} };
  if (has('open_app') && (m = t.match(/\b(?:open|launch|start)\s+(?:the\s+)?([a-z][\w-]*)/))) return { name: 'open_app', arguments: { name: m[1] } };
  if (has('get_time') && /\b(time|date|day is it)\b/.test(t)) return { name: 'get_time', arguments: {} };
  return null;
}

function describeResult(name, result) {
  if (!result || result.ok === false) return `The ${name.replace(/_/g, ' ')} tool failed: ${result?.error || 'no result'}.`;
  const r = result.result ?? result;
  switch (name) {
    case 'set_timer': return `Timer set for ${r.seconds} seconds.`;
    case 'get_battery': return r.available === false ? 'This browser does not report the battery.' : `Battery is at ${Math.round(r.level * 100)} percent${r.charging ? ' and charging' : ''}.`;
    case 'get_network_status': return r.online ? 'You are online.' : 'You are offline.';
    case 'open_app': return `Opened ${r.name}.`;
    case 'get_time': return `It is ${r.local}.`;
    default: return `${name} returned ${JSON.stringify(r)}.`;
  }
}

export function createStubModel({ wordMs = 60 } = {}) {
  return {
    id: 'stub',
    label: 'Test stub (no model)',
    ready: true,
    async load({ onProgress } = {}) { onProgress?.({ loaded: 1, total: 1, file: 'stub' }); },
    async generate({ messages, tools = [], onText, onAudio, signal } = {}) {
      const last = messages[messages.length - 1];
      let reply;
      if (last?.role === 'tool') {
        const results = [];
        for (let i = messages.length - 1; i >= 0 && messages[i].role === 'tool'; i--) results.unshift(messages[i]);
        reply = results.map((m) => describeResult(m.name, JSON.parse(m.content))).join(' ');
      } else {
        const { text, audioSeconds } = lastUserText(messages);
        const call = text && routeToTool(text, new Set(tools.map((t) => t.name)));
        if (call) return { text: '', toolCalls: [call], stopReason: 'tool_calls' };
        reply = text ? `You said: ${text}` : `I heard ${audioSeconds.toFixed(1)} seconds of audio. The real model will understand it.`;
      }
      let said = '';
      for (const word of reply.split(/(\s+)/)) {
        if (signal?.aborted) return { text: said, toolCalls: [], stopReason: 'aborted' };
        said += word;
        onText?.(word);
        if (word.trim()) onAudio?.(tone());
        await sleep(wordMs, signal);
      }
      return { text: said, toolCalls: [], stopReason: signal?.aborted ? 'aborted' : 'stop' };
    },
  };
}

// The models the assistant can run. The LFM3-Omni entry joins when the engine passes its browser check.
export const VOICE_MODELS = Object.freeze({ stub: createStubModel });
