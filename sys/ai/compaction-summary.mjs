// compaction-summary.mjs — the summariser Anvil's in-run compaction calls, and the experiment
// override that turns in-run compaction on.
//
// The checkpoint prompt is pi-durable's (`@earendil-works/pi-durable` 1.4.0,
// dist/harness/compaction.js, MIT, Earendil Works): a fixed structured summary (Goal, Constraints,
// Progress, Key Decisions, Next Steps, Critical Context) that folds an earlier summary forward.
// Why in-run compaction exists at all: Belcak et al., "You don't need long context"
// (arXiv:2611.05306) report that compacting at 16K–48K total context, or after every action, held
// agent accuracy for frontier models. NakliOS has not measured it for its own models; this module
// only makes the measurement possible. Nothing here imports a host.

export const CHECKPOINT_SYSTEM = `You are a context summarization assistant. Your task is to read a conversation between a user and an AI assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.`;

export const CHECKPOINT_PROMPT = `The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work. If the conversation starts with an earlier summary, preserve its information and fold the newer messages into it.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Constraints & Preferences
- [Any constraints, preferences, or requirements mentioned by user]
- [Or "(none)" if none were mentioned]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.`;

// Longest tool result a serialized summary source keeps (pi-durable uses the same cap).
export const TOOL_RESULT_MAX_CHARS = 2000;

function callText(c) {
  const name = c && (c.function ? c.function.name : c.name);
  let args = c && (c.function ? c.function.arguments : c.arguments);
  if (typeof args !== 'string') { try { args = JSON.stringify(args ?? {}); } catch (_) { args = '{}'; } }
  return `${name || 'tool'}(${args})`;
}

// The older region as one plain transcript, so the summariser reads it as text to summarise,
// never as a conversation to continue.
export function serializeForSummary(messages, { toolMax = TOOL_RESULT_MAX_CHARS } = {}) {
  const lines = [];
  for (const m of Array.isArray(messages) ? messages : []) {
    if (!m) continue;
    const text = typeof m.content === 'string' ? m.content : (m.content == null ? '' : JSON.stringify(m.content));
    if (m.role === 'tool') {
      const body = text.length > toolMax ? text.slice(0, toolMax) + `\n[… ${text.length - toolMax} more characters]` : text;
      lines.push(`[tool result]\n${body}`);
    } else if (m.role === 'assistant') {
      if (text) lines.push(`[assistant]\n${text}`);
      for (const c of m.tool_calls || []) lines.push(`[assistant tool call] ${callText(c)}`);
    } else {
      lines.push(`[${m.role || 'user'}]\n${text}`);
    }
  }
  return lines.join('\n\n');
}

// (olderMessages) => summary text, through the given infer ({ messages, tools, signal } => { content }).
// An empty reply throws, so compactConversation records "summary unavailable" instead of an empty summary.
export function makeSummarizer(infer, { signal = null } = {}) {
  return async (older) => {
    const reply = await infer({
      messages: [
        { role: 'system', content: CHECKPOINT_SYSTEM },
        { role: 'user', content: `<conversation>\n${serializeForSummary(older)}\n</conversation>\n\n${CHECKPOINT_PROMPT}` },
      ],
      tools: [],
      signal,
    });
    const text = typeof reply?.content === 'string' ? reply.content.trim() : '';
    if (!text) throw new Error('the model returned an empty summary');
    return text;
  };
}

// The experiment override, stored as JSON (Anvil keeps it in localStorage['anvil-compaction']):
//   { "mode": "threshold", "total": 24000, "threshold": 18000, "keep": 0 }
//     compact when the run's context passes `total` tokens, down to `threshold`, keeping `keep`
//     recent tokens verbatim (0 = only the latest turn, the paper's setting);
//   { "mode": "every-action", "keep": 0 }   compact before every request after the first;
//   { "mode": "off" } or nothing            today's behaviour: compact only between runs and after an overflow.
// `summarize` (default true) folds the older region into a checkpoint summary; false drops it.
// Returns null for "off", a missing value or anything malformed, so a bad value never changes a run.
export function parseCompactionOverride(raw) {
  let v = raw;
  if (typeof v === 'string') { if (!v.trim()) return null; try { v = JSON.parse(v); } catch (_) { return null; } }
  if (!v || typeof v !== 'object') return null;
  const n = (x) => (Number.isFinite(Number(x)) && Number(x) >= 0 ? Math.floor(Number(x)) : null);
  const keep = n(v.keep ?? 0);
  if (keep === null) return null;
  const summarize = v.summarize !== false;
  if (v.mode === 'every-action') return { mode: 'every-action', compactAbove: 0, threshold: 0, keepRecentTokens: keep, summarize };
  if (v.mode === 'threshold') {
    const total = n(v.total), threshold = n(v.threshold);
    if (!total || threshold === null || threshold > total) return null;
    return { mode: 'threshold', compactAbove: total, threshold, keepRecentTokens: Math.min(keep, threshold), summarize };
  }
  return null;
}
