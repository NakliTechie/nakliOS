// compaction — keeping a long agent transcript under a token budget without
// losing the recent working context (pi's algorithm + omp's `shake`).
//
// Two moves, cheapest first:
//   1. shake (LLM-free): swap the bodies of OLD, bulky tool results for a
//      reference. Costs nothing but a Map insert — in a browser, where an extra
//      model call is expensive, this is the first line of defence. What the ref
//      TELLS the model depends on `retrievable`: with a run record behind it, the
//      exact `history` calls plus a verbatim phrase to search by; without one, that
//      the content is gone. It never names a retrieval the caller cannot serve.
//   2. summarize (LLM, optional): only if shaking did not get under budget, fold
//      the older region into one summary system message via an injected async
//      summarize(olderMessages) -> string. No summarizer wired ⇒ the older region
//      is dropped (with a marker) rather than blocking.
//
// Hard rules (omp): never cut inside a turn — the kept region always begins at a
// user/assistant boundary, so an assistant tool-call turn is never separated from
// its tool results. Leading system messages are always preserved.
//
// Pure and headless: the token estimator is injected (defaults to the loop's
// ~4-chars/token proxy), so this is fully unit-testable with a scripted estimator.

import { estimateTokens } from './agent-loop.mjs';

// How many leading messages are the pinned system preamble (never compacted).
function systemPrefixLen(messages) {
  let n = 0;
  while (n < messages.length && messages[n]?.role === 'system') n++;
  return n;
}

// The cut index: walk back from the end accumulating tokens until we have kept
// ~keepRecentTokens, then snap earlier to a turn boundary (a user/assistant
// message, never a tool result) so no turn is split. Never crosses into the
// system prefix.
function findCut(messages, keepRecentTokens, estimate, sysEnd) {
  let acc = 0;
  let cut = messages.length;
  for (let i = messages.length - 1; i >= sysEnd; i--) {
    const t = estimate([messages[i]]);
    // Don't pull a message into the recent window if it would blow the budget —
    // a single huge old tool result belongs in the older (shakeable) region, not
    // protected as "recent". The acc>0 guard keeps the kept window non-empty.
    if (acc > 0 && acc + t > keepRecentTokens) break;
    acc += t;
    cut = i;
  }
  // Snap to a boundary: kept must start at a user/assistant message, not a tool
  // result (which would orphan it from its assistant tool-call turn).
  while (cut > sysEnd && messages[cut]?.role === 'tool') cut--;
  return cut;
}

// A search handle for an elided body: a contiguous, verbatim slice of the content that a
// `history` search can actually match. Substring-only transforms (picking a line, trimming,
// slicing) — anything else would produce a query that does not occur in the record.
// Returns '' when nothing usable is there, which is how the caller knows not to promise a
// retrieval.
function searchHandle(content, max = 48) {
  const head = content.slice(0, 400);
  let best = '';
  for (const line of head.split('\n')) {
    const t = line.trim();
    if (t.length > best.length) best = t;
  }
  best = best.slice(0, max).trim();
  return best.length >= 8 ? best : '';
}

// LLM-free reduction: replace the bodies of bulky tool results in `region` with a reference
// the model can act on. Returns { messages, artifacts, saved } where artifacts maps ref id ->
// original content. `protect` keeps the newest N tokens of the region untouched.
//
// `retrievable` is the whole honesty question. The ref text used to say "read it with the read
// tool" against an `artifact://` id — but `read` reads workspace files, cannot resolve that id,
// and no caller keeps the artifacts map, so the content was simply gone and the model was
// instructed to perform an impossible retrieval (forward-pass R1a). Pointing at the `history`
// tool instead is only true when the caller is writing a run record AND the model is given
// something to search FOR: the body it would query by is the very thing that was elided.
// So the ref carries a verbatim handle, and a caller that keeps no record gets the plain
// statement that the content is gone.
export function shake(region, { estimate = estimateTokens, minChars = 200, artifactPrefix = 'artifact://tool-', retrievable = false } = {}) {
  const artifacts = new Map();
  let saved = 0;
  let counter = 0;
  // tool_call_id -> the tool's name, so the ref can say WHICH tool produced the body.
  const names = new Map();
  for (const m of region) {
    if (!Array.isArray(m?.tool_calls)) continue;
    for (const c of m.tool_calls) if (c?.id) names.set(c.id, c.function?.name || '');
  }
  const out = region.map((m) => {
    if (m?.role === 'tool' && typeof m.content === 'string' && m.content.length >= minChars) {
      const id = `${artifactPrefix}${++counter}`;
      artifacts.set(id, m.content);
      saved += estimate([m]);
      const name = m.name || names.get(m.tool_call_id) || '';
      const from = name ? ` from \`${name}\`` : '';
      const handle = retrievable ? searchHandle(m.content) : '';
      const ref = handle
        // The record keeps every tool result and `history` searches it, so name the exact two
        // calls and hand over a phrase that occurs in the stored text. The last clause is not a
        // hedge: the carry happens before the record is written, so a failed save is a real
        // outcome the model must be able to recognise rather than retry forever.
        ? `[tool output elided — ${m.content.length} chars${from}. The full result is in this task's run history: `
          + `history {"op":"search","query":${JSON.stringify(handle)}} then history {"op":"read","id":"<the hit's id>"}. `
          + `If that search returns no hits, the record was not saved and this content is gone.]`
        // Nothing retains it. Say so, and say what to do instead — an agent told only that
        // output is "elided" will burn turns hunting for it.
        : `[tool output elided — ${m.content.length} chars${from}. This content is GONE: it was not preserved anywhere you can read. `
          + `Do not try to retrieve it. Work from what remains, or make the tool call again if you need the output.]`;
      saved -= estimate([{ role: 'tool', content: ref }]);
      return { ...m, content: ref, _artifact: id };
    }
    return m;
  });
  return { messages: out, artifacts, saved };
}

// The top-level pass. Returns:
//   { messages, compacted, method, artifacts, droppedTokens }
// method ∈ 'none' | 'shake' | 'summarize' | 'drop'.
export async function compactConversation(messages, {
  threshold = 20_000,        // stay at/under this many estimated tokens
  keepRecentTokens = 8_000,  // protect at least this much recent context
  estimate = estimateTokens,
  summarize = null,          // optional async (olderMessages) => string
  shakeMinChars = 200,
  // True only when the caller persists a run record of THIS transcript — that record is what
  // an elided body is recoverable from. Default false: promise nothing by default.
  retrievable = false,
} = {}) {
  const before = estimate(messages);
  if (before <= threshold) return { messages, compacted: false, method: 'none', artifacts: new Map(), droppedTokens: 0 };

  const sysEnd = systemPrefixLen(messages);
  const cut = findCut(messages, keepRecentTokens, estimate, sysEnd);
  const system = messages.slice(0, sysEnd);
  const older = messages.slice(sysEnd, cut);
  const kept = messages.slice(cut);
  if (!older.length) {
    // Everything recent is already within one turn / the budget can't shrink.
    return { messages, compacted: false, method: 'none', artifacts: new Map(), droppedTokens: 0 };
  }

  // 1. shake the older region.
  const shaken = shake(older, { estimate, minChars: shakeMinChars, retrievable });
  let next = [...system, ...shaken.messages, ...kept];
  if (estimate(next) <= threshold) {
    return { messages: next, compacted: true, method: 'shake', artifacts: shaken.artifacts, droppedTokens: shaken.saved };
  }

  // 2. still over → summarize (or drop) the older region.
  const olderTokens = estimate(shaken.messages);
  if (typeof summarize === 'function') {
    let summary;
    try { summary = await summarize(older); }
    catch (e) { summary = `[compaction summary unavailable: ${String(e?.message || e)}]`; }
    const summaryMsg = { role: 'system', content: `Earlier context (compacted):\n${summary}` };
    next = [...system, summaryMsg, ...kept];
    return { messages: next, compacted: true, method: 'summarize', artifacts: shaken.artifacts, droppedTokens: olderTokens };
  }

  const marker = { role: 'system', content: `[${older.length} earlier messages (~${olderTokens} tokens) were dropped to stay under the context budget.]` };
  next = [...system, marker, ...kept];
  return { messages: next, compacted: true, method: 'drop', artifacts: shaken.artifacts, droppedTokens: olderTokens };
}
