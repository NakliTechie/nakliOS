// Conformance — transcript compaction (shake + boundary-safe cut + summarize).
//
//   node sys/ai/test/compaction.test.mjs
//
// Pure/headless: a scripted token estimator drives the thresholds, so the cut
// boundaries and the shake/summarize/drop ladder are verified deterministically.

import { shake, compactConversation } from '../compaction.mjs';
import { estimateTokens } from '../agent-loop.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

const big = (n) => 'x'.repeat(n);

// ── shake: bulky old tool results become artifact refs ──────────────────
await test('shake elides large tool results and preserves them in artifacts', () => {
  const region = [
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: big(4000) },
    { role: 'tool', tool_call_id: 't2', content: 'short' },
  ];
  const r = shake(region, { minChars: 200 });
  assert(/elided/.test(r.messages[1].content), 'big tool result elided');
  eq(r.messages[2].content, 'short', 'short tool result untouched');
  eq(r.artifacts.size, 1, 'one artifact captured');
  assert(r.artifacts.get(r.messages[1]._artifact).length === 4000, 'full content recoverable');
  assert(r.saved > 0, 'reported a token saving');
});

// ── compaction is a no-op under budget ──────────────────────────────────
await test('compactConversation leaves an under-budget transcript untouched', async () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ];
  const r = await compactConversation(msgs, { threshold: 10_000 });
  eq(r.compacted, false, 'not compacted');
  eq(r.method, 'none', 'method none');
  eq(r.messages, msgs, 'same array returned');
});

// ── shake path gets it back under budget ────────────────────────────────
await test('compaction shakes bulky old tool output to get under budget', async () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do a big search' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 't1', content: big(60_000) }, // ~15k tokens, old + bulky
    { role: 'user', content: 'now do a small thing' },
    { role: 'assistant', content: 'ok done' },
  ];
  const r = await compactConversation(msgs, { threshold: 5_000, keepRecentTokens: 500 });
  eq(r.compacted, true, 'compacted');
  eq(r.method, 'shake', 'via shake (no LLM)');
  assert(estimateTokens(r.messages) <= 5_000, 'now under budget');
  // The recent turn survives verbatim.
  assert(r.messages.some((m) => m.content === 'now do a small thing'), 'recent user turn kept');
  assert(r.messages[0].role === 'system' && r.messages[0].content === 'sys', 'system preamble kept');
});

// ── never split a turn: kept region starts at a boundary, not a tool msg ─
await test('the kept region never begins with an orphaned tool result', async () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'old' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: big(30_000) },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b', content: big(30_000) },
    { role: 'assistant', content: 'final' },
  ];
  const r = await compactConversation(msgs, { threshold: 4_000, keepRecentTokens: 200 });
  // Find the first non-system message in the output; it must be user/assistant.
  const firstNonSys = r.messages.find((m) => m.role !== 'system');
  assert(firstNonSys.role === 'user' || firstNonSys.role === 'assistant', `boundary respected, got ${firstNonSys.role}`);
});

// ── summarize path when shake is not enough ─────────────────────────────
await test('compaction summarizes when shaking cannot get under budget', async () => {
  // Bulk lives in ASSISTANT/USER text (shake only elides tool results), so shake
  // alone can't help — the summarizer must run.
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: big(40_000) },
    { role: 'assistant', content: big(40_000) },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'ok' },
  ];
  let summarizedInput = null;
  const r = await compactConversation(msgs, {
    threshold: 5_000,
    keepRecentTokens: 200,
    summarize: async (older) => { summarizedInput = older; return 'the user asked for two big things'; },
  });
  eq(r.compacted, true, 'compacted');
  eq(r.method, 'summarize', 'used the summarizer');
  assert(summarizedInput && summarizedInput.length >= 1, 'older region handed to the summarizer');
  assert(r.messages.some((m) => /two big things/.test(m.content || '')), 'summary injected');
  assert(r.messages.some((m) => m.content === 'recent'), 'recent turn kept');
});

// ── drop path when no summarizer is wired ───────────────────────────────
await test('compaction drops the older region (with a marker) when no summarizer is wired', async () => {
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: big(40_000) },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'recent' },
    { role: 'assistant', content: 'ok' },
  ];
  const r = await compactConversation(msgs, { threshold: 5_000, keepRecentTokens: 200 });
  eq(r.method, 'drop', 'dropped');
  assert(r.messages.some((m) => /were dropped/.test(m.content || '')), 'a drop marker was left');
  assert(r.droppedTokens > 0, 'reported dropped tokens');
});

await test('R1a: with no record behind it, the elision says the content is GONE', () => {
  // It used to say "read it with the read tool" against an `artifact://` id — `read` reads
  // workspace files, cannot resolve that id, and no caller keeps the artifacts map. Default is
  // now the honest statement, not a softer impossible pointer.
  const region = [{ role: 'tool', content: 'x'.repeat(4000) }];
  const r = shake(region);
  const ref = r.messages[0].content;
  assert(!/read tool/.test(ref), `must not point at a tool that cannot resolve it: ${ref}`);
  assert(!/artifact:\/\//.test(ref), 'no unresolvable id is shown to the model');
  assert(!/history/.test(ref), 'no record is being kept, so history must not be promised either');
  assert(/GONE/.test(ref), `it states plainly that the content is gone: ${ref}`);
  assert(r.artifacts.size === 1, 'the map is still returned for a caller that wants to resolve ids');
});

await test('retrievable: the ref names the tool, the exact calls, and a query that is a real substring', () => {
  const body = ['npm test -- grant.spec.js', '17 passing', '1 failing: scope leak on revoke'].join('\n') + '\n' + 'x'.repeat(4000);
  const region = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: body },
  ];
  const ref = shake(region, { retrievable: true }).messages[1].content;
  assert(/history/.test(ref), `names the tool that can retrieve it: ${ref}`);
  assert(/"op":"search"/.test(ref) && /"op":"read"/.test(ref), `names both ops: ${ref}`);
  assert(/`shell`/.test(ref), `names the tool that produced the body: ${ref}`);
  assert(!/artifact:\/\//.test(ref), 'still no unresolvable id');
  // The load-bearing property: the query is text that OCCURS in the stored result. A handle the
  // model cannot match would be the same defect wearing a different tool name.
  const q = JSON.parse(ref.match(/"query":("(?:[^"\\]|\\.)*")/)[1]);
  assert(q.length >= 8, `handle is substantial: ${JSON.stringify(q)}`);
  assert(body.includes(q), `the handed query is a verbatim substring of the elided body: ${JSON.stringify(q)}`);
});

await test('retrievable: a body with no usable handle falls back to the GONE wording', () => {
  // Nothing to search by ⇒ nothing to promise, even with a record behind it.
  const r = shake([{ role: 'tool', content: 'ab\n'.repeat(1000) }], { retrievable: true });
  assert(/GONE/.test(r.messages[0].content), `no handle ⇒ no promise: ${r.messages[0].content}`);
});

await test('compactConversation threads retrievable through to the shaken refs', async () => {
  const msgs = () => ([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do a big search' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'grant scope check failed\n' + big(60_000) },
    { role: 'user', content: 'now do a small thing' },
    { role: 'assistant', content: 'ok done' },
  ]);
  const off = await compactConversation(msgs(), { threshold: 5_000, keepRecentTokens: 500 });
  assert(off.messages.some((m) => /GONE/.test(m.content || '')), 'default promises nothing');
  const on = await compactConversation(msgs(), { threshold: 5_000, keepRecentTokens: 500, retrievable: true });
  assert(on.messages.some((m) => /"op":"search"/.test(m.content || '')), 'retrievable reaches the ref text');
});

// ── end to end: the query the ref hands the model actually retrieves the body ──
await test('the ref\'s query retrieves the full body from a real run record', async () => {
  const { createRunRecorder, searchRecords, readEvent, loadRecord } = await import('../../history/run-record.mjs');
  const body = 'grant scope check failed on revoke\n' + 'y'.repeat(6000);

  // A real record of the run whose transcript is about to be compacted.
  const rec = createRunRecorder({ app: 'anvil', principal: 'anvil:test' });
  await rec.start({ messages: [{ role: 'user', content: 'run the gate' }] });
  rec.onEvent({ type: 'tool-call', id: 'c1', name: 'shell', args: { command: 'npm test' }, step: 1 });
  rec.onEvent({ type: 'tool-result', id: 'c1', name: 'shell', result: body, step: 1 });
  await rec.settled();
  const entries = [{ runId: 'run-1', taskId: 't1', record: loadRecord(rec.export()) }];

  // Now compact that same transcript, with the record behind it.
  const r = shake([
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: body },
  ], { retrievable: true });
  const ref = r.messages[1].content;

  // Follow the ref exactly as the model would: search by the handed query, then read the hit.
  const query = JSON.parse(ref.match(/"query":("(?:[^"\\]|\\.)*")/)[1]);
  const hits = searchRecords(entries, { query, scope: 'task', taskId: 't1' });
  assert(hits.length >= 1, `the handed query finds the event: ${JSON.stringify(query)}`);
  const read = readEvent(entries, hits[0].id, { limit: 100_000 });
  assert(!read.error, `read resolves the hit id: ${read.error}`);
  assert(read.text.includes(body), 'the FULL elided body comes back out of the record');
});

if (failures.length) {
  console.error(`compaction: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/compaction conformance: ${passed}/${passed} passed`);
