// Agent-tier inference protocol — the pure shaping core (headless, testable).
//
// The OS inference broker (index.html) is shaped for narrow chat: 1–32 messages,
// text-only roles, a 768-token output cap, no tool-calling. A coding agent needs
// the opposite — long tool-calling loops. This module is the additive core that
// makes that possible WITHOUT touching the narrow-chat path:
//
//   • raised caps for a trusted, permission-gated "agent" tier
//   • message normalisation that admits the `tool` role + assistant `tool_calls`
//   • an OpenAI-compatible request body that carries `tools`
//   • a streamed tool-call accumulator (delta chunks → complete tool calls)
//
// It is pure — no fetch, no DOM, no worker. The broker imports it and does the
// I/O; these functions decide shape and enforce limits. That split is what makes
// the agent tier verifiable headlessly, before any browser or endpoint is wired.
//
//   import { AGENT_LIMITS, normaliseAgentMessages, normaliseTools,
//            buildEndpointChatBody, createToolCallAccumulator } from './agent-protocol.mjs';

// ── Caps ──────────────────────────────────────────────────────────────
// The narrow-chat tier (index.html) stays at 32 messages / 24k chars / 768
// output tokens. The agent tier raises them for a permission-gated caller. Still
// bounded — an agent loop is long, not infinite; a runaway is a bug, not a use.
export const AGENT_LIMITS = Object.freeze({
  maxMessages: 512,        // a long tool-calling transcript, not unbounded
  maxInputChars: 512_000,  // repo context + tool results accumulate
  maxOutputTokens: 8192,   // a full patch / plan, not a chat reply
  maxTools: 64,            // the tool surface a coding agent exposes
  minOutputTokens: 16,
});

const CHAT_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

// One assistant tool-call entry: { id, type:'function', function:{ name, arguments } }.
// `arguments` is a JSON *string* on the wire (OpenAI contract), never a parsed object.
function normaliseToolCall(call, where) {
  if (!call || typeof call !== 'object') throw new Error(`${where}: tool_call must be an object`);
  const fn = call.function;
  if (!fn || typeof fn !== 'object') throw new Error(`${where}: tool_call.function required`);
  if (typeof fn.name !== 'string' || !fn.name) throw new Error(`${where}: tool_call.function.name required`);
  const args = fn.arguments;
  if (args != null && typeof args !== 'string') {
    throw new Error(`${where}: tool_call.function.arguments must be a JSON string`);
  }
  const out = {
    type: 'function',
    function: { name: fn.name, arguments: typeof args === 'string' ? args : '' },
  };
  if (typeof call.id === 'string' && call.id) out.id = call.id;
  return out;
}

// Validate + normalise an agent transcript. Admits the `tool` role and assistant
// `tool_calls` that narrow chat rejects; still caps count and total size. Returns
// a fresh array of clean messages (never mutates the input).
export function normaliseAgentMessages(messages, limits = AGENT_LIMITS) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('Agent inference requires at least 1 message');
  }
  if (messages.length > limits.maxMessages) {
    throw new Error(`Agent inference allows at most ${limits.maxMessages} messages`);
  }
  let total = 0;
  return messages.map((message, i) => {
    const where = `message[${i}]`;
    const role = CHAT_ROLES.has(message?.role) ? message.role : 'user';

    if (role === 'tool') {
      if (typeof message?.tool_call_id !== 'string' || !message.tool_call_id) {
        throw new Error(`${where}: tool message requires a tool_call_id`);
      }
      if (typeof message?.content !== 'string') {
        throw new Error(`${where}: tool message content must be text`);
      }
      total += message.content.length;
      if (total > limits.maxInputChars) throw new Error('Agent inference input is too large');
      return { role, tool_call_id: message.tool_call_id, content: message.content };
    }

    // assistant may carry tool_calls (then content may be null/empty).
    const hasToolCalls = role === 'assistant' && Array.isArray(message?.tool_calls) && message.tool_calls.length;
    if (!hasToolCalls && typeof message?.content !== 'string') {
      throw new Error(`${where}: ${role} message content must be text`);
    }
    const content = typeof message?.content === 'string' ? message.content : '';
    total += content.length;
    if (total > limits.maxInputChars) throw new Error('Agent inference input is too large');

    const out = { role, content };
    if (hasToolCalls) {
      out.tool_calls = message.tool_calls.map((c, j) => normaliseToolCall(c, `${where}.tool_calls[${j}]`));
      if (content === '') out.content = null; // OpenAI: assistant tool-call turns have null content
    }
    if (role === 'assistant' && typeof message?.name === 'string' && message.name) out.name = message.name;
    return out;
  });
}

// Validate the OpenAI `tools` array (type:'function' only in v0.1). Returns a
// clean array, or undefined when no tools were supplied (so the body omits it).
export function normaliseTools(tools, limits = AGENT_LIMITS) {
  if (tools == null) return undefined;
  if (!Array.isArray(tools)) throw new Error('tools must be an array');
  if (tools.length === 0) return undefined;
  if (tools.length > limits.maxTools) throw new Error(`At most ${limits.maxTools} tools`);
  const seen = new Set();
  return tools.map((tool, i) => {
    const where = `tools[${i}]`;
    if (!tool || typeof tool !== 'object') throw new Error(`${where}: tool must be an object`);
    if (tool.type != null && tool.type !== 'function') {
      throw new Error(`${where}: only type "function" is supported`);
    }
    const fn = tool.function;
    if (!fn || typeof fn !== 'object') throw new Error(`${where}: function definition required`);
    if (typeof fn.name !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(fn.name)) {
      throw new Error(`${where}: function.name must match [A-Za-z0-9_.-]{1,64}`);
    }
    if (seen.has(fn.name)) throw new Error(`${where}: duplicate tool name "${fn.name}"`);
    seen.add(fn.name);
    const out = { type: 'function', function: { name: fn.name } };
    if (typeof fn.description === 'string') out.function.description = fn.description;
    if (fn.parameters != null) {
      if (typeof fn.parameters !== 'object') throw new Error(`${where}: function.parameters must be a JSON schema object`);
      out.function.parameters = fn.parameters;
    }
    return out;
  });
}

// Validate tool_choice: 'auto' | 'none' | 'required' | { type:'function', function:{ name } }.
export function normaliseToolChoice(choice) {
  if (choice == null) return undefined;
  if (typeof choice === 'string') {
    if (!['auto', 'none', 'required'].includes(choice)) {
      throw new Error('tool_choice string must be auto, none, or required');
    }
    return choice;
  }
  if (typeof choice === 'object' && choice.type === 'function' && choice.function?.name) {
    return { type: 'function', function: { name: String(choice.function.name) } };
  }
  throw new Error('tool_choice must be auto/none/required or a {type:function} object');
}

// Clamp the requested output-token budget to the agent tier's bounds.
export function clampAgentMaxTokens(requested, limits = AGENT_LIMITS) {
  const n = Number(requested) || limits.maxOutputTokens;
  return Math.max(limits.minOutputTokens, Math.min(limits.maxOutputTokens, n));
}

// Build the OpenAI-compatible /chat/completions request body. `tools`,
// `tool_choice`, and `stream` are included only when meaningful — an endpoint
// that never sees a `tools` key behaves exactly as narrow chat did.
export function buildEndpointChatBody({ model, messages, maxTokens, tools, toolChoice, stream = true }) {
  const body = { model, messages, max_tokens: maxTokens, stream };
  if (tools && tools.length) {
    body.tools = tools;
    if (toolChoice !== undefined) body.tool_choice = toolChoice;
  }
  return body;
}

// Streamed tool calls arrive as partial deltas keyed by index: the first delta
// for an index carries id/name, later deltas append argument fragments. This
// accumulator reassembles them into complete tool calls, order preserved.
//
//   const acc = createToolCallAccumulator();
//   for (const chunk of sse) acc.absorbDelta(chunk.choices[0].delta);
//   const calls = acc.finalize();   // [{ id, type:'function', function:{ name, arguments } }]
export function createToolCallAccumulator() {
  const byIndex = new Map(); // index → { id, name, args }
  let order = 0;

  function slot(index) {
    const key = Number.isInteger(index) ? index : order;
    if (!byIndex.has(key)) { byIndex.set(key, { seq: order++, id: '', name: '', args: '' }); }
    return byIndex.get(key);
  }

  return {
    // Absorb one streamed delta object (choices[0].delta). No-op when it carries
    // no tool_calls, so it is safe to call on every chunk.
    absorbDelta(delta) {
      const calls = delta?.tool_calls;
      if (!Array.isArray(calls)) return;
      for (const call of calls) {
        const s = slot(call?.index);
        if (typeof call?.id === 'string' && call.id) s.id = call.id;
        const fn = call?.function;
        if (fn) {
          if (typeof fn.name === 'string' && fn.name) s.name = fn.name;
          if (typeof fn.arguments === 'string') s.args += fn.arguments;
        }
      }
    },
    // Absorb a non-streamed message.tool_calls array (whole calls at once).
    absorbMessage(message) {
      const calls = message?.tool_calls;
      if (!Array.isArray(calls)) return;
      calls.forEach((call, i) => {
        const s = slot(i);
        if (typeof call?.id === 'string' && call.id) s.id = call.id;
        const fn = call?.function;
        if (fn) {
          if (typeof fn.name === 'string') s.name = fn.name;
          if (typeof fn.arguments === 'string') s.args += fn.arguments;
        }
      });
    },
    get size() { return byIndex.size; },
    // Complete tool calls in arrival order. Entries with no name are dropped
    // (a malformed stream should not surface a nameless call).
    finalize() {
      return [...byIndex.values()]
        .sort((a, b) => a.seq - b.seq)
        .filter(s => s.name)
        .map(s => {
          const call = { type: 'function', function: { name: s.name, arguments: s.args } };
          if (s.id) call.id = s.id;
          return call;
        });
    },
  };
}

// Parse the argument JSON of a completed tool call, defensively. A model can
// emit invalid JSON; the caller decides what to do with { ok:false }.
export function parseToolArguments(call) {
  const raw = call?.function?.arguments ?? '';
  if (raw === '') return { ok: true, value: {} };
  try { return { ok: true, value: JSON.parse(raw) }; }
  catch (e) { return { ok: false, error: String(e?.message || e), raw }; }
}

// ── Ordered model fallback ────────────────────────────────────────────
// A free-tier endpoint can hand back a 500 for one model id while every other id
// on the same server answers fine (observed while probing five `:free` ids — one
// of them 500'd and the rest did not). Mid-run that kills the whole run, and an
// agent run is expensive to lose: the transcript, the tool results, and the work
// already done on disk all go with it.
//
// So the caller supplies an ORDER of model ids and this decides, per failure,
// whether to advance. Two rules make the difference between a useful ladder and
// one that silently corrupts a run:
//
//   1. Only TRANSPORT-class failures advance. A 5xx or a network throw says
//      "this id is not answering"; a 400/401/403/404 says "your request or your
//      credentials are wrong", and retrying that on four more ids just produces
//      four more identical refusals while looking like resilience. 429 is the
//      one rate-limit code worth stepping past — a different model is often a
//      different bucket — but it is NOT retried on the same id, which is what
//      the provider is asking for.
//   2. Nothing may have been EMITTED yet. Once tokens or a tool-call delta have
//      reached the caller, a second model's answer would be spliced onto the
//      first one's prefix and the transcript would describe a turn that no model
//      actually produced. After first emission the failure is terminal.
//
// Pure: it decides, it does not fetch. The broker does the I/O.

// Status codes worth trying a DIFFERENT model id for.
export function isRetryableEndpointStatus(status) {
  const n = Number(status);
  if (!Number.isFinite(n)) return false;
  return n === 429 || (n >= 500 && n <= 599);
}

// The ids to try, in order, deduped, primary first. Blank entries are dropped so
// a half-filled settings field cannot insert an empty model id into the ladder.
export function modelLadder(primary, fallbacks = []) {
  const seen = new Set(); const out = [];
  for (const raw of [primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]) {
    const id = typeof raw === 'string' ? raw.trim() : '';
    if (!id || seen.has(id)) continue;
    seen.add(id); out.push(id);
  }
  return out;
}

// Run `attempt(modelId)` down the ladder. `attempt` either resolves (success) or
// throws; a thrown error may carry `.status` (an HTTP response) or not (a network
// failure, which is transport-class by definition). `hasEmitted()` reports whether
// anything has already reached the caller for this request — once it has, the
// first failure is final.
//
// Resolves { value, model, attempts:[{ model, status, error }] } so the caller can
// record WHICH id actually answered: a run whose record names the configured model
// when a fallback answered is a record that lies about its own provenance.
export async function runModelLadder(ladder, attempt, { hasEmitted = () => false } = {}) {
  const ids = modelLadder(ladder[0], ladder.slice(1));
  if (!ids.length) throw new Error('runModelLadder: no model ids to try');
  const attempts = [];
  let last = null;
  for (let i = 0; i < ids.length; i++) {
    const model = ids[i];
    try {
      const value = await attempt(model);
      attempts.push({ model, status: null, error: null });
      return { value, model, attempts };
    } catch (error) {
      const status = error && error.status != null ? Number(error.status) : null;
      attempts.push({ model, status, error: String((error && error.message) || error) });
      last = error;
      if (hasEmitted()) break;                                  // rule 2
      if (status != null && !isRetryableEndpointStatus(status)) break; // rule 1
      if (i === ids.length - 1) break;
    }
  }
  // Every id failed. Surface the LAST error (the caller's existing message shape)
  // with the trail attached, so a report can say which ids were tried.
  if (last && typeof last === 'object') { try { last.attempts = attempts; } catch (_) {} }
  throw last || new Error('runModelLadder: every model id failed');
}
