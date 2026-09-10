// The provider's token count must survive the whole path: endpoint → host → SDK → app.
//   node scripts/test-host-usage.mjs
//
// The live check on 2026-09-07 measured Anvil's own chars/4 estimate at 1,319 tokens for a
// request Ollama counted at 3,903 — against a 4,096 window. The run was at 95.3% of its
// context believing it was a third full. F6 was built to fix exactly that and could not
// engage, because the number never reached the app: the host streamed without asking for
// usage, and its done-event did not forward it.
//
// Four seams, all of which have to hold at once. Each is checked here, and the SHAPES the
// providers actually send are exercised against the real accounting function.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { usageInputTokens, usageOutputTokens } from '../sys/ai/agent-loop.mjs';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// ── seam 1: the host ASKS for it ──
// A streamed OpenAI-compatible response carries no usage unless stream_options requests it.
assert.match(host, /if \(wantsUsage\) body\.stream_options = \{ include_usage:true \};/,
  'the host asks the provider to report usage on a streamed request');
assert.match(host, /const wantsUsage = body\.stream === true;/,
  'and only when it is actually streaming — a non-streamed reply already carries usage');
// A provider that rejects the unknown field must not become a broken endpoint.
// Matched on SHAPE, not on the variable that happens to hold the response: these two
// anchors both broke when the request body gained a model-fallback ladder around it, and
// reported the retry missing when it was still there.
assert.match(host, /\w+\.status === 400 \|\| \w+\.status === 422/,
  'a rejected stream_options is retried without it');
assert.match(host, /const \{ stream_options, \.\.\.withoutUsage \} = \w+;/,
  'the retry drops exactly that field and keeps the rest of the body');

// ── seam 2: the host READS it, in both response shapes ──
assert.match(host, /if \(data\?\.usage\) request\.usage = data\.usage;\n    return data\?\.choices\?\.\[0\]\?\.finish_reason/,
  'the non-streamed branch keeps the usage');
assert.match(host, /if \(choice\?\.finish_reason\) finishReason = choice\.finish_reason;\s*\n\s*\/\/[^\n]*\n\s*if \(data\?\.usage\) request\.usage = data\.usage;/,
  'the streamed branch reads usage off the FRAME — the usage chunk carries no choice at all');

// ── seam 3: the host FORWARDS it ──
assert.match(host, /\.\.\.\(request\.usage \? \{ usage:request\.usage \} : \{\}\)/,
  'the done event carries the usage when there is one');

// ── seam 4: the SDK and the app pass it through ──
assert.match(sdk, /usage: msg\.usage \|\| null,/, 'the SDK puts usage on the done chunk');
assert.match(sdk, /if \(chunk\.usage\) usage = chunk\.usage;/, 'and collects it while assembling a completion');
assert.match(sdk, /\/\/ top level, as the OpenAI completion shape has it[\s\S]{0,80}usage: usage,/,
  'the assembled completion carries it at the top level, where the OpenAI shape puts it');
assert.match(anvil, /usage: \(r&&r\.usage\)\|\|null \}/, 'inferViaHost returns it on the reply the loop reads');

// ── the accounting itself, on the shapes the providers really send ──
// Ollama / OpenAI: prompt_tokens ALREADY includes the cached part.
assert.equal(usageInputTokens({ prompt_tokens: 3903, completion_tokens: 1, total_tokens: 3904 }), 3903,
  'the exact shape Ollama returned in the 2026-09-07 live check');
assert.equal(usageInputTokens({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } }), 1000,
  'a cached subset is never added on top');
// Anthropic: input_tokens EXCLUDES the cache, which is reported beside it.
assert.equal(usageInputTokens({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }), 1050,
  'the anthropic shape sums');
assert.equal(usageOutputTokens({ completion_tokens: 1 }), 1, 'output, openai');
assert.equal(usageOutputTokens({ output_tokens: 1 }), 1, 'output, anthropic');
// Absent → null, so the loop falls back to the estimate rather than anchoring on zero.
assert.equal(usageInputTokens(null), null, 'no usage → no anchor');
assert.equal(usageInputTokens({}), null, 'an empty usage object is not a zero-token request');

// ── the gap this closes, stated as a number ──
// chars/4 over the messages cannot see the tool schemas: 19 tools, ~12.8 KB of JSON.
const MESSAGES_CHARS = 5276, TOOL_SCHEMA_CHARS = 12777;   // measured live, same request
const estimate = Math.ceil(MESSAGES_CHARS / 4);
assert.equal(estimate, 1319, 'the estimate the live check saw');
assert.ok(estimate < 3903 * 0.4, `the estimate was under 40% of the truth (${estimate} vs 3903)`);
assert.ok(TOOL_SCHEMA_CHARS > MESSAGES_CHARS * 2, 'the tool schemas the estimator cannot see are the bulk of the prompt');

console.log('host-usage: the provider token count survives endpoint → host → SDK → app, and both provider shapes account correctly');
