// usage.mjs — what a provider says a request cost, in one shape.
//
// Two readers share this: the loop's usage-anchored budget (agent-loop.mjs, F6) and the run record's
// llm.responded output (run-record.mjs, LX-3). One owner, or the Anthropic cache rule below drifts.
//
// The two provider shapes, and why they are NOT added together:
//   Anthropic: input_tokens EXCLUDES cache reads/writes, which are reported separately —
//              so the real input is the sum of the three.
//   OpenAI:    prompt_tokens INCLUDES the cached part, and prompt_tokens_details.cached_tokens
//              is a SUBSET of it — adding it would double-count the cache on every turn.
// Returns null when the object carries no usable input count, so the caller falls back to
// the estimate rather than silently anchoring on zero.

const num = (v) => (Number.isFinite(v) && v >= 0 ? v : null);

export function usageInputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const stored = num(usage.prompt); // the record's own shape — served back on replay (see usageOf)
  if (stored !== null) return stored;
  const anthropic = num(usage.input_tokens);
  if (anthropic !== null) {
    return anthropic + (num(usage.cache_read_input_tokens) || 0) + (num(usage.cache_creation_input_tokens) || 0);
  }
  const openai = num(usage.prompt_tokens);
  if (openai !== null) return openai; // cached_tokens is already inside this
  return null;
}

// What the provider says the reply itself cost, or null.
export function usageOutputTokens(usage) {
  if (!usage || typeof usage !== 'object') return null;
  return num(usage.completion) ?? num(usage.output_tokens) ?? num(usage.completion_tokens);
}

// The count as the record stores it: { prompt, completion, total } — or null when the reply carries
// no usable count at all (an empty usage object is not a zero-token request). A side the provider did
// not report is stored as null, never 0: the loop anchors its budget on `prompt`, and a stored 0 would
// be an anchor the live run never had (the re-check's finding) — null reads back as "unknown" on both
// sides, so the replayed loop falls to the estimate exactly where the live one did. `total` is the sum
// of the known sides; a provider's own total_tokens is not read, so two providers' totals mean the same.
// IDEMPOTENT on its own output, and READ BACK by the two readers above: a replay serves the recorded
// llm.responded output back as the reply, so the re-recorded output hashes the same AND the loop's
// usage-anchored budget trips where the live run's did.
export function usageOf(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const prompt = usageInputTokens(usage), completion = usageOutputTokens(usage);
  if (prompt === null && completion === null) return null;
  return { prompt, completion, total: (prompt ?? 0) + (completion ?? 0) };
}
