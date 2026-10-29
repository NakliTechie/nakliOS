// Anthropic Messages API shaping for the broker — the pure core (headless, testable).
//
// Apps speak one agent protocol to the host: OpenAI-shaped messages, `tools`,
// and `tool_calls` (see agent-protocol.mjs). An Anthropic-compatible endpoint
// (Claude, or any server that implements POST /v1/messages) needs a different
// shape, so the broker converts at the edge and apps never notice:
//
//   • toAnthropicRequest — system text, user/assistant turns with `tool_use`
//     blocks, `tool` messages folded into `tool_result` blocks, tools as
//     { name, description, input_schema }.
//   • fromAnthropicMessage — the final message back into text, OpenAI tool
//     calls, a finish reason and an OpenAI-style usage object.
//
// Thinking blocks. Current Claude models think on every turn, and the API
// expects their thinking blocks back unchanged; removing one from the middle of
// a history invalidates the blocks after it. The app transcript has no place
// for them, so the broker keeps each reply's raw content blocks under a replay
// key (its text plus its tool calls) and puts them back when that turn returns.
// When a turn has no saved blocks (a reload, another model answered), every
// thinking block BEFORE it is dropped too: removing a leading run is allowed,
// a gap in the middle is not.
//
// Pure: no fetch, no SDK, no DOM. The broker owns the client and the I/O.

const THINKING_TYPES = new Set(['thinking', 'redacted_thinking']);

function parseArgs(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try { const v = JSON.parse(raw); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch (_) { return {}; }
}

// The key a reply is saved and found under: its text and its tool calls.
export function replayKey({ content, toolCalls }) {
  const calls = (Array.isArray(toolCalls) ? toolCalls : [])
    .map((c) => [c?.id || '', c?.function?.name || '', JSON.stringify(parseArgs(c?.function?.arguments))]);
  return JSON.stringify([String(content ?? '').trim(), calls]);
}

function assistantBlocks(message) {
  const blocks = [];
  const text = typeof message.content === 'string' ? message.content : '';
  if (text.trim()) blocks.push({ type: 'text', text });
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
    blocks.push({ type: 'tool_use', id: call.id, name: call.function?.name, input: parseArgs(call.function?.arguments) });
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}

function pushUser(out, blocks) {
  const last = out[out.length - 1];
  if (last && last.role === 'user') {
    if (typeof last.content === 'string') last.content = [{ type: 'text', text: last.content }];
    last.content.push(...blocks);
  } else {
    out.push({ role: 'user', content: blocks });
  }
}

// Build the Messages API fields (everything except `model`). `replay` is a Map
// from replayKey to the raw content blocks of a reply this host received.
export function toAnthropicRequest({ messages, maxTokens, tools, toolChoice, replay = new Map() }) {
  const system = [];
  const turns = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m.role === 'system' || m.role === 'developer') {
      if (typeof m.content === 'string' && m.content.trim()) system.push(m.content);
    } else if (m.role === 'tool') {
      pushUser(turns, [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: String(m.content ?? '') }]);
    } else if (m.role === 'assistant') {
      const saved = replay.get(replayKey({ content: m.content, toolCalls: m.tool_calls }));
      turns.push({ role: 'assistant', content: saved ? structuredClone(saved) : assistantBlocks(m), saved: !!saved });
    } else {
      pushUser(turns, [{ type: 'text', text: String(m.content ?? '') }]);
    }
  }
  // Keep thinking blocks only after the last assistant turn that has none saved.
  let lastMiss = -1;
  turns.forEach((t, i) => { if (t.role === 'assistant' && !t.saved) lastMiss = i; });
  const out = turns.map((t, i) => {
    if (t.role !== 'assistant') return t;
    const content = i < lastMiss ? t.content.filter((b) => !THINKING_TYPES.has(b?.type)) : t.content;
    return { role: 'assistant', content: content.length ? content : [{ type: 'text', text: '' }] };
  });

  const body = { max_tokens: maxTokens, messages: out, cache_control: { type: 'ephemeral' } };
  if (system.length) body.system = system.join('\n\n');
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools.map((t) => {
      const fn = t.function || t;
      const tool = { name: fn.name, input_schema: fn.parameters || { type: 'object', properties: {} } };
      if (fn.description) tool.description = fn.description;
      return tool;
    });
    // Current models refuse forced tool choice (`any` / a named tool), so the
    // OpenAI 'required' and named choices run as 'auto'.
    body.tool_choice = toolChoice === 'none' ? { type: 'none' } : { type: 'auto' };
  }
  return body;
}

const FINISH = {
  end_turn: 'stop', stop_sequence: 'stop', pause_turn: 'stop',
  tool_use: 'tool_calls', max_tokens: 'length', model_context_window_exceeded: 'length', refusal: 'refusal',
};

// Read a final Messages API message. `usage` keeps the OpenAI names the app's
// budget reads, with the cache counts alongside. `prompt_tokens_details.cached_tokens`
// is where OpenAI-shaped clients read cache hits: without it Dish showed "Cache hit 0%"
// while Anthropic served 12,522 of 12,673 prompt tokens from cache (live 2026-10-29).
// It is a subset of prompt_tokens, as in OpenAI's shape, so no reader double-counts it.
export function fromAnthropicMessage(message) {
  const blocks = Array.isArray(message?.content) ? message.content : [];
  const text = blocks.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
  const toolCalls = blocks.filter((b) => b?.type === 'tool_use').map((b) => ({
    id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
  }));
  const u = message?.usage || {};
  const prompt = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
  const usage = message?.usage ? {
    prompt_tokens: prompt,
    completion_tokens: u.output_tokens || 0,
    total_tokens: prompt + (u.output_tokens || 0),
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens || 0 },
    cache_read_input_tokens: u.cache_read_input_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0,
  } : null;
  return {
    text,
    toolCalls,
    finishReason: FINISH[message?.stop_reason] || 'stop',
    refusal: message?.stop_reason === 'refusal' ? (message.stop_details?.category || 'unspecified') : null,
    usage,
  };
}
