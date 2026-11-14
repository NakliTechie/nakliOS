// Conformance — the repeat guard (sys/ai/repeat-guard.mjs) and the agent loop's answer to a
// reply it stopped (finishReason 'repetition').
//   node sys/ai/test/repeat-guard.test.mjs
import { findRepeatedTail, createRepeatGuard, REPETITION } from '../repeat-guard.mjs';
import { runAgentLoop, REPETITION_NUDGE, REPETITION_RETRIES } from '../agent-loop.mjs';
import { foldQuota } from '../../history/run-record.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const stream = (guard, text, size = 7) => { for (let i = 0; i < text.length; i += size) { if (guard.push(text.slice(i, i + size))) return i + size; } return null; };

await test('a sentence repeated back to back trips the guard and keeps one copy', async () => {
  const lead = 'Let me think about the review. ';
  const block = 'Wait, I should check the proposal format again. ';
  const text = lead + block.repeat(30);
  const g = createRepeatGuard();
  const at = stream(g, text);
  assert(g.tripped, 'tripped');
  assert(at < text.length * 0.6, `stopped early (at ${at} of ${text.length})`);
  const kept = text.slice(0, g.keepChars);
  assert(kept.startsWith(lead), 'the lead-in is kept');
  assert(kept.length <= lead.length + block.length * 2, `about one copy kept (${kept.length} chars)`);
});

await test('lines that differ only by a number are real output, not a loop', async () => {
  let text = '';
  for (let i = 10; i < 60; i++) text += `Step ${i}: re-read the file and try again. `;
  const g = createRepeatGuard();
  stream(g, text);
  assert(!g.tripped, 'a numbered list does not trip (exact match only)');
});

await test('ordinary prose, code and a markdown table do not trip it', async () => {
  const prose = Array.from({ length: 40 }, (_, i) => `Sentence ${i} talks about topic ${i * 7 % 13} with its own words ${'abcdefghij'[i % 10]}.`).join(' ');
  const code = Array.from({ length: 60 }, (_, i) => `  const v${i} = compute(${i}, '${'xyz'[i % 3]}');`).join('\n');
  const table = '| a | b |\n|---|---|\n' + Array.from({ length: 40 }, (_, i) => `| row ${i} | ${['red', 'green', 'blue', 'amber'][i % 4]} item |`).join('\n');
  const rule = '-'.repeat(2000) + ' ' + ' '.repeat(2000);
  for (const [name, text] of [['prose', prose], ['code', code], ['rule', rule]]) {
    const g = createRepeatGuard(); stream(g, text); assert(!g.tripped, `${name} tripped`);
  }
  // A table whose rows differ only by a number and a rotating word is a borderline case; record it.
  const t = createRepeatGuard(); stream(t, table);
  assert(!t.tripped, 'a table with varied cells does not trip');
});

await test('findRepeatedTail names the period and needs both length and copies', async () => {
  const hit = findRepeatedTail('intro ' + 'abcdefghijklmnop'.repeat(40));
  assert(hit && hit.period === 16, `period 16 (got ${hit && hit.period})`);
  eq(findRepeatedTail('abcdefghijklmnop'.repeat(3)), null, 'three short copies are not enough');
});

await test('the loop nudges after a stopped reply, then accepts the short answer', async () => {
  const replies = [
    { content: 'loop loop loop', toolCalls: [], finishReason: REPETITION },
    { content: 'The answer is 42.', toolCalls: [], finishReason: 'stop' },
  ];
  const seen = []; const events = [];
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'What is the answer?' }], tools: [], maxSteps: 6,
    infer: async ({ messages }) => { seen.push(messages.map((m) => m.content)); return replies.shift(); },
    executeTool: async () => 'n/a', onEvent: (e) => events.push(e),
  });
  eq(res.stop, 'done', 'the run ends done on the short answer');
  eq(res.text, 'The answer is 42.', 'with that answer');
  assert(seen[1].includes(REPETITION_NUDGE), 'the second request carries the nudge');
  const nudge = events.find((e) => e.type === 'repeat-nudge');
  assert(nudge && nudge.times === null && nudge.content === REPETITION_NUDGE, 'the nudge rides a repeat-nudge event with its exact words');
});

await test('the loop stops with its own reason after the retries run out', async () => {
  let calls = 0;
  const res = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [], maxSteps: 10,
    infer: async () => { calls++; return { content: 'again again', toolCalls: [], finishReason: REPETITION }; },
    executeTool: async () => 'n/a',
  });
  eq(res.stop, 'repetition', 'stop names the cause');
  eq(calls, REPETITION_RETRIES + 1, 'one call plus the retries');
});

await test('foldQuota counts stopped replies per answering model', async () => {
  const ev = [
    { tool: 'llm.responded', output: { finishReason: 'repetition', model: 'lfm25' } },
    { tool: 'llm.responded', output: { finishReason: 'stop', model: 'lfm25' } },
    { tool: 'llm.responded', output: { finishReason: 'repetition', model: 'lfm25' } },
    { tool: 'llm.responded', output: { finishReason: 'repetition' } },
  ];
  const q = foldQuota(ev, (e) => ({ input: {}, output: e.output }));
  eq(q.repeats.lfm25, 2, 'two for lfm25'); eq(q.repeats.unknown, 1, 'an unnamed model counts as unknown');
  eq(q.calls, 4, 'calls unchanged');
});

if (failures.length) {
  console.error(`repeat-guard: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`repeat-guard: ${passed} passed — loops trip and keep one copy, prose/code/tables do not, the loop nudges then stops, quota counts per model.`);
