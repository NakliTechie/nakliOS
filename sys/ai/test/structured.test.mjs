// Conformance — structured output from a reluctant model (CRIB-B B4): the balanced scanner finds JSON
// inside prose; the repair turn carries the validation errors; the ladder records every attempt.
//   node sys/ai/test/structured.test.mjs
import { extractJson, repairPrompt, inferStructured, attemptsLine } from '../structured.mjs';

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e && e.message || String(e) }); } }
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} — ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const J = (v) => JSON.stringify(v);

await test('extractJson: JSON wrapped in prose, in a code fence, with braces and escaped quotes inside strings', () => {
  eq(J(extractJson('Sure! Here it is: {"proposals": []} — hope that helps.').value), '{"proposals":[]}');
  eq(J(extractJson('```json\n{"a": {"b": [1, 2, {"c": "}"}]}}\n```').value), '{"a":{"b":[1,2,{"c":"}"}]}}', 'a brace inside a string does not close the object');
  eq(J(extractJson('x {"s": "say \\"hi\\" {not json"} y').value), '{"s":"say \\"hi\\" {not json"}', 'escaped quotes stay inside the string');
  eq(J(extractJson('[1, [2, 3], {"k": "v"}] trailing').value), '[1,[2,3],{"k":"v"}]', 'an array is a value too');
  const r = extractJson('prefix {"n": 1} suffix'); eq(r.start, 7); eq(r.end, 14, 'the span is reported');
  eq(J(extractJson('{"s": "a \\" b { c"}').value), '{"s":"a \\" b { c"}', 'a lone escaped quote does not end the string (an unescaped reading would run to the end)');
});

await test('extractJson: the first candidate that parses AND satisfies want; none → null', () => {
  const text = 'first {"kind": "note"} then {"proposals": [{"kind": "fact", "name": "x"}]} end';
  eq(J(extractJson(text).value), '{"kind":"note"}', 'the first balanced value by default');
  eq(J(extractJson(text, { want: (v) => Array.isArray(v?.proposals) }).value), '{"proposals":[{"kind":"fact","name":"x"}]}', 'want skips to the one that fits');
  eq(extractJson('no json here { unbalanced'), null);
  eq(extractJson('{"broken": }'), null, 'a balanced but invalid candidate is skipped');
  eq(extractJson(''), null); eq(extractJson(null), null);
  eq(J(extractJson('{"a": 1} {"b": 2}', { want: (v) => 'b' in v }).value), '{"b":2}');
  eq(extractJson('{]'), null, 'mismatched nesting is not a value');
  const big = 'x'.repeat(200000) + '{"ok": true}'; eq(extractJson(big).value.ok, true, 'a long prefix is fine');
});

await test('repairPrompt carries the errors as a list, then the ask', () => {
  const p = repairPrompt(['"proposals" must be an array', 'item 2 has no "name"']);
  eq(p, 'Your reply was not the JSON that was asked for:\n- "proposals" must be an array\n- item 2 has no "name"\nReply again with ONLY the JSON — no prose, no code fence, no commentary.');
  eq(repairPrompt([]), 'Your reply was not the JSON that was asked for.\nReply again with ONLY the JSON — no prose, no code fence, no commentary.');
  eq(repairPrompt('one', { ask: 'Again.' }), 'Your reply was not the JSON that was asked for:\n- one\nAgain.');
});

const scripted = (name, replies) => { let i = 0; const calls = []; return { name, calls, infer: async ({ messages }) => { calls.push(messages.slice()); const r = replies[Math.min(i++, replies.length - 1)]; if (r instanceof Error) throw r; return { content: r, toolCalls: [] }; } }; };
const validate = (v) => { const e = []; if (!Array.isArray(v?.proposals)) e.push('"proposals" must be an array'); else v.proposals.forEach((p, i) => { if (!p?.name) e.push(`item ${i + 1} has no "name"`); }); return e; };
const msgs = [{ role: 'user', content: 'Reply with JSON.' }];

await test('inferStructured: a valid first reply answers with an empty trail', async () => {
  const a = scripted('a', ['{"proposals": [{"name": "x"}]}']);
  const r = await inferStructured({ ladder: [a], messages: msgs, validate });
  eq(r.ok, true); eq(r.rung, 'a'); eq(r.attempts.length, 0); eq(J(r.value), '{"proposals":[{"name":"x"}]}');
  eq(attemptsLine(r), 'answered by a first try');
});

await test('inferStructured: prose → one repair turn carrying the errors → valid; the trail says so', async () => {
  const a = scripted('a', ['Here you go: {"proposals": [{"kind": "fact"}]}', '{"proposals": [{"name": "y"}]}']);
  const r = await inferStructured({ ladder: [a], messages: msgs, validate });
  eq(r.ok, true); eq(r.attempts.length, 1); eq(r.attempts[0].error, 'item 1 has no "name"');
  eq(a.calls.length, 2, 'two model calls');
  const second = a.calls[1];
  eq(second.length, 3, 'the repair turn: the original, the model\'s reply, the repair prompt');
  eq(second[1].role, 'assistant'); eq(second[2].role, 'user');
  assert(/^Your reply was not the JSON that was asked for:\n- item 1 has no "name"\n/.test(second[2].content), second[2].content);
  eq(attemptsLine(r), 'answered by a after 1 failed attempt: a#1 — item 1 has no "name"');
});

await test('inferStructured: a rung that fails twice hands over to the next rung, whose own convo starts clean', async () => {
  const a = scripted('local', ['nothing useful', 'still nothing']);
  const b = scripted('byok', ['{"proposals": []}']);
  const r = await inferStructured({ ladder: [a, b], messages: msgs, validate });
  eq(r.ok, true); eq(r.rung, 'byok'); eq(r.attempts.length, 2);
  eq(r.attempts.map((x) => `${x.rung}#${x.try}`).join(','), 'local#1,local#2');
  eq(r.attempts[0].error, 'no JSON value could be found in the reply');
  eq(b.calls[0].length, 1, 'the second rung is not shown the first rung\'s failed exchange');
});

await test('inferStructured: every rung fails → ok:false with the whole trail; a throwing rung is an attempt, not a crash; retries: 0 means one try per rung', async () => {
  const a = scripted('a', [new Error('ECONNREFUSED')]);
  const b = scripted('b', ['', 'prose']);
  const r = await inferStructured({ ladder: [a, b], messages: msgs, validate });
  eq(r.ok, false); eq(r.value, null); eq(r.rung, null);
  eq(r.attempts.map((x) => `${x.rung}#${x.try}`).join(','), 'a#1,b#1,b#2');
  eq(r.attempts[0].error, 'model call failed: ECONNREFUSED');
  eq(r.attempts[1].error, 'no JSON value could be found in the reply (the reply was empty)');
  assert(/^no rung answered after 3 attempts: a#1 — model call failed: ECONNREFUSED; b#1/.test(attemptsLine(r)), attemptsLine(r));
  const c = scripted('c', ['prose', '{"proposals": []}']);
  const r0 = await inferStructured({ ladder: [c], messages: msgs, validate, retries: 0 });
  eq(r0.ok, false); eq(c.calls.length, 1, 'no repair turn when retries is 0');
  let threw = false; try { await inferStructured({ ladder: [], messages: msgs }); } catch (_) { threw = true; } assert(threw, 'an empty ladder is a caller error');
});

await test('inferStructured: the default extract prefers the candidate the validator accepts; a failed run hands back what parsed last as partial', async () => {
  const a = scripted('a', ['{"note": 1} and then {"proposals": [{"name": "z"}]}']);
  const r = await inferStructured({ ladder: [a], messages: msgs, validate });
  eq(r.ok, true); eq(r.value.proposals[0].name, 'z', 'the note object did not shadow the valid one'); eq(r.partial, null);
  const b = scripted('b', ['{"proposals": [{"name": "good"}, {"kind": "note"}]}', '{"proposals": [{"name": "good"}, {"kind": "note"}]}']);
  const f = await inferStructured({ ladder: [b], messages: msgs, validate });
  eq(f.ok, false); eq(f.partial.proposals.length, 2, 'the last parsed-but-invalid value is handed back'); eq(f.partialRung, 'b', 'and whose reply it was'); eq(f.attempts.length, 2);
  const c = scripted('c', ['no json at all']);
  eq((await inferStructured({ ladder: [c], messages: msgs, validate, retries: 0 })).partial, null, 'nothing parsed → nothing partial');
});

await test('inferStructured: a custom extract (want) picks the right value out of several', async () => {
  const a = scripted('a', ['{"note": 1} and then {"proposals": [{"name": "z"}]}']);
  const r = await inferStructured({ ladder: [a], messages: msgs, validate, extract: (t) => extractJson(t, { want: (v) => Array.isArray(v?.proposals) }) });
  eq(r.ok, true); eq(r.value.proposals[0].name, 'z');
});

if (failures.length) {
  console.error(`structured: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`structured: ${passed}/${passed} passed — JSON out of prose, a repair turn that names the errors, a ladder with its trail`);
