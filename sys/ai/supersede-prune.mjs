// supersede-prune.mjs — before each model request, shrink tool results the model no longer needs (omp's
// pruning pass, packages/agent/src/compaction/pruning.ts, MIT; plan/research/2026-11-02-omp-shortlist.md §1).
//
//   superseded  an older read of a file, once a newer COMPLETE read of the same file exists
//               → "[Superseded by a newer read of this file]"
//   uneventful  a result that found nothing ("No matches found", "(no output)" with grep's exit 1)
//               → "[Uneventful result elided]"
//
// The pass works on a copy: the durable transcript keeps every result, and the same history always prunes the
// same way, so a request prefix changes only when a new prune lands. It is all-or-nothing per request — it acts
// only when the saving reaches `minSavingsTokens`, so small sessions (and provider prompt caches) are left alone.
// The newest `protectTokens` of tool results are never superseded, and the last `keepLast` results are never
// touched at all: the model must see what its latest call returned.
//
// One core over a neutral list, and one adapter per message format: OpenAI chat (Anvil, the host broker) and
// pi-ai (Pi's pi-durable `beforeRequest` hook).

export const SUPERSEDED = '[Superseded by a newer read of this file]';
export const UNEVENTFUL = '[Uneventful result elided]';
export const PRUNE_DEFAULTS = Object.freeze({ protectTokens: 2000, minSavingsTokens: 400, keepLast: 2 });

const estimate = (text) => Math.ceil(String(text || '').length / 4);
const READ_TOOLS = new Set(['read', 'read_file']);
const PARTIAL = /\(Showing lines \d+[–-]\d+ of \d+|… \(truncated\)|\(line truncated\)|\[truncated/;
const NOTHING = /^(?:no matches(?: found)?\.?|0 matches\.?|no files found\.?|\(no output\)(?:\s*\[exit 1\])?)$/i;

// The file a read shows, plus its line window when it asked for one: reads of different windows never supersede.
export function readKey(tool, args) {
  if (!READ_TOOLS.has(tool) || !args || typeof args.path !== 'string' || !args.path) return null;
  const windowed = args.offset != null || args.limit != null;
  return windowed ? `${args.path}#${args.offset ?? 1}+${args.limit ?? ''}` : args.path;
}
// A read supersedes older ones only when it shows the whole file (omp read-supersede.ts).
export function isCompleteRead(tool, args, text) {
  return readKey(tool, args) === args.path && !PARTIAL.test(String(text || ''));
}
export function isUneventful(text) { return NOTHING.test(String(text || '').trim()); }

/**
 * @param {Array<{ tool: string, args: object, text: string }>} items tool results in conversation order
 * @returns {Map<number, string>} item index → replacement text (empty when the pass does not pay)
 */
export function planPrune(items, { protectTokens = PRUNE_DEFAULTS.protectTokens, minSavingsTokens = PRUNE_DEFAULTS.minSavingsTokens,
  keepLast = PRUNE_DEFAULTS.keepLast } = {}) {
  const out = new Map();
  const n = items.length;
  const protectedFrom = (() => { // first index inside the newest protectTokens
    let sum = 0;
    for (let i = n - 1; i >= 0; i--) { sum += estimate(items[i].text); if (sum > protectTokens) return i + 1; }
    return 0;
  })();
  const newestComplete = new Map(); // read key → index of its newest complete read
  items.forEach((item, i) => { if (isCompleteRead(item.tool, item.args, item.text)) newestComplete.set(item.args.path, i); });
  for (let i = 0; i < n - keepLast; i++) {
    const item = items[i];
    if (item.text === SUPERSEDED || item.text === UNEVENTFUL) continue;
    if (isUneventful(item.text)) { out.set(i, UNEVENTFUL); continue; }
    const key = readKey(item.tool, item.args);
    if (key && i < protectedFrom) {
      const newest = newestComplete.get(item.args.path);
      if (newest !== undefined && newest > i) out.set(i, SUPERSEDED);
    }
  }
  let saved = 0;
  for (const [i, text] of out) saved += estimate(items[i].text) - estimate(text);
  return saved >= minSavingsTokens ? out : new Map();
}

const parseArgs = (raw) => {
  if (raw && typeof raw === 'object') return raw;
  try { const v = JSON.parse(String(raw || '{}')); return v && typeof v === 'object' ? v : {}; } catch { return {}; }
};

/** OpenAI chat messages (assistant `tool_calls`, `role: 'tool'` results). Returns `{ messages, pruned, saved }`. */
export function pruneOpenAIMessages(messages, options) {
  const calls = new Map();
  for (const m of messages) for (const c of (m && m.role === 'assistant' && m.tool_calls) || []) {
    calls.set(c.id, { tool: c.function?.name || c.name, args: parseArgs(c.function?.arguments ?? c.arguments) });
  }
  const slots = [];
  messages.forEach((m, at) => {
    if (m && m.role === 'tool' && typeof m.content === 'string') {
      const call = calls.get(m.tool_call_id) || { tool: m.name || '', args: {} };
      slots.push({ at, tool: call.tool, args: call.args, text: m.content });
    }
  });
  const plan = planPrune(slots, options);
  if (!plan.size) return { messages, pruned: 0, saved: 0 };
  const next = messages.slice();
  let saved = 0;
  for (const [i, text] of plan) { const s = slots[i]; saved += estimate(s.text) - estimate(text); next[s.at] = { ...messages[s.at], content: text }; }
  return { messages: next, pruned: plan.size, saved };
}

/** pi-ai messages (assistant `toolCall` parts, `role: 'toolResult'` with text parts). Image results are left alone. */
export function prunePiMessages(messages, options) {
  const calls = new Map();
  for (const m of messages) for (const part of (m && m.role === 'assistant' && Array.isArray(m.content) && m.content) || []) {
    if (part && part.type === 'toolCall') calls.set(part.id, { tool: part.name, args: part.arguments || {} });
  }
  const slots = [];
  messages.forEach((m, at) => {
    if (!m || m.role !== 'toolResult' || !Array.isArray(m.content) || !m.content.every((p) => p && p.type === 'text')) return;
    const call = calls.get(m.toolCallId) || { tool: m.toolName, args: {} };
    slots.push({ at, tool: call.tool || m.toolName, args: call.args, text: m.content.map((p) => p.text).join('\n') });
  });
  const plan = planPrune(slots, options);
  if (!plan.size) return { messages, pruned: 0, saved: 0 };
  const next = messages.slice();
  let saved = 0;
  for (const [i, text] of plan) { const s = slots[i]; saved += estimate(s.text) - estimate(text); next[s.at] = { ...messages[s.at], content: [{ type: 'text', text }] }; }
  return { messages: next, pruned: plan.size, saved };
}
