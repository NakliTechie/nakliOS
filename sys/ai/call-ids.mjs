// Tool-call ids for a transcript — one owner, shared by the loop (sys/ai/agent-loop.mjs) and the
// record's transcript fold (sys/history/run-record.mjs), so the two cannot disagree about an id.
//
// H3 (iii #35, 2026-09-24): ids are assigned ONCE, before the assistant turn is stored, so the turn
// and its tool results agree (an id-less call used to be stored without an id while its result
// named `call_<step>_<i>` — a pair a strict endpoint refuses). A synthesised id is unique against
// every id already in the transcript: a DC2 re-entered loop restarts `step` at 0 over a carried
// transcript that may already hold `call_0_0`. Deterministic, so a replay rebuilds the same bytes.
export function transcriptCallIds(messages) {
  const ids = new Set();
  for (const m of messages || []) {
    if (m && Array.isArray(m.tool_calls)) for (const c of m.tool_calls) if (c && c.id) ids.add(String(c.id));
    if (m && m.role === 'tool' && m.tool_call_id) ids.add(String(m.tool_call_id));
  }
  return ids;
}
export function withCallIds(toolCalls, step, used) {
  return toolCalls.map((c, i) => {
    if (c && c.id) { used.add(String(c.id)); return c; }
    const base = `call_${step}_${i}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}_${n}`;
    used.add(id);
    return { ...c, id };
  });
}
