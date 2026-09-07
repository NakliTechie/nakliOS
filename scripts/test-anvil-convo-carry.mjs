// Guards what the NEXT run of an Anvil task gets to see.
//
// t.convo used to accumulate only user prompts and the final assistant text —
// never a tool call, a tool result, or the gate output. So a follow-up send
// restarted blind, and after a few sends the model was handed a transcript of
// consecutive user turns (observed 2026-09-03 driving Anvil against a local
// model: [user, user, user, assistant, user, user]), after which it answered in
// prose instead of using tools. The gate feedback an agent needs in order to fix
// its own work survived only inside a single run.
//
// This extracts the real carryForward from apps/anvil/index.html and runs it
// against the real compaction module — behaviour, not a grep.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { compactConversation } from '../sys/ai/compaction.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// The CALL SITE, first. A correct helper the app never calls is exactly the
// defect that made belief revision dead code — the pure module passed its own
// tests while the app dropped the field. Pin the wiring, not just the function.
// shape, not signature: carryForward now also takes the recorder, so the lossy carry is LOGGED
assert.match(anvil, /t\.convo = await carryForward\(foldTranscript\(recEvents, rec\.resolve\)/,
  'runTask carries the CANONICAL transcript (the fold) forward into t.convo — paired by construction');
// F4: and the carry records its own replacement, so foldSurface can reproduce what was sent.
// BOTH halves are needed: the recording lives inside carryForward, so asserting only that it
// exists left `carryForward(fold)` — the recorder argument dropped at the CALL — passing
// (mutation-tested by a cross-family review).
assert.match(anvil, /rec\.compacted\(\{ method:'carry-forward'/,
  'a lossy carry is put ON THE CHAIN, not just stored — otherwise the record and the surface drift');
assert.match(anvil, /await carryForward\(foldTranscript\(recEvents, rec\.resolve\), rec\)/,
  'and the CALL SITE actually hands carryForward the recorder — without it the recording is dead code');
{
  const sig = anvil.match(/async function carryForward\(([^)]*)\)/);
  assert.ok(sig, 'carryForward is declared');
  assert.match(sig[1], /,\s*rec\b/, `carryForward takes the recorder: (${sig[1]})`);
}
assert.ok(!/if\(finalAssistant\) convo\.push\(\{role:'assistant', content:finalAssistant\.text\}\);\n      \/\/ #5/.test(anvil),
  'the prose-only convo append is no longer the primary path');

const start = anvil.indexOf('const CONVO_MAX_CHARS');
const end = anvil.indexOf('async function inferViaHost');
assert.ok(start > 0 && end > start, 'carryForward found in apps/anvil/index.html');
const carryForward = new Function('compactConversation', `${anvil.slice(start, end)}; return carryForward;`)(compactConversation);

const sys = { role: 'system', content: 'you are a coding agent' };
const turn = (i) => ([
  { role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'shell', arguments: '{"command":"echo ' + i + '"}' } }] },
  { role: 'tool', tool_call_id: 'c' + i, content: 'output ' + i },
]);

// 1. THE HEADLINE: tool calls and their results survive into the next run.
{
  const out = await carryForward([sys, { role: 'user', content: 'do it' }, ...turn(0), { role: 'assistant', content: 'done' }]);
  assert.ok(out.some(m => m.role === 'tool'), 'a tool RESULT is carried forward');
  assert.ok(out.some(m => Array.isArray(m.tool_calls) && m.tool_calls.length), 'a tool CALL is carried forward');
  assert.ok(out.some(m => m.role === 'user'), 'the user prompt is kept');
}

// 2. The incoming system prefix is dropped — sysMsg() is rebuilt every run, so
//    carrying it forward would duplicate it.
{
  const out = await carryForward([sys, { role: 'user', content: 'hi' }, { role: 'assistant', content: 'ok' }]);
  assert.equal(out[0].role, 'user', 'the carried transcript starts after the system prefix');
  assert.ok(!out.some(m => m.content === sys.content), 'the old system message is gone');
}

// 3. Gate feedback reaches the next run. This is the whole point: the agent must
//    be able to see that its own work was refused.
{
  const gate = { role: 'user', content: 'Gate `python test_attest.py` failed with exit 1.\nFix the problem and continue.' };
  const out = await carryForward([sys, { role: 'user', content: 'build it' }, ...turn(0), gate]);
  assert.ok(out.some(m => /exit 1/.test(String(m.content || ''))), 'the gate verdict survives into the next run');
}

// 4. A trailing assistant turn whose tool replies never arrived (an aborted run)
//    is dropped — it is malformed as the start of the next request.
{
  const dangling = { role: 'assistant', content: null, tool_calls: [{ id: 'zz', type: 'function', function: { name: 'shell', arguments: '{}' } }] };
  const out = await carryForward([sys, { role: 'user', content: 'go' }, dangling]);
  const last = out[out.length - 1];
  assert.ok(!last || !(Array.isArray(last.tool_calls) && last.tool_calls.length),
    'no unanswered assistant tool-call turn is left at the end');
}

// 5. Over the cap it trims WHOLE TURNS and never begins on an orphan tool reply —
//    a leading role:'tool' with no preceding call is rejected by the endpoint.
{
  const big = [sys, { role: 'user', content: 'start' }];
  for (let i = 0; i < 400; i++) {
    big.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'shell', arguments: '{}' } }] });
    big.push({ role: 'tool', tool_call_id: 'c' + i, content: 'x'.repeat(800) });
  }
  const out = await carryForward(big);
  const bytes = JSON.stringify(out).length;
  assert.ok(bytes <= 120000, `carried convo stays inside the localStorage budget (${bytes} bytes)`);
  assert.ok(out.length, 'something is carried forward');
  assert.notEqual(out[0].role, 'tool', 'never starts on an orphan tool reply');
}

// 6. Every carried tool reply is still paired with the call that produced it.
{
  const msgs = [sys, { role: 'user', content: 'go' }];
  for (let i = 0; i < 40; i++) msgs.push(...turn(i));
  msgs.push({ role: 'assistant', content: 'finished' });
  const out = await carryForward(msgs);
  const offered = new Set();
  for (const m of out) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) offered.add(c.id);
    if (m.role === 'tool') {
      assert.ok(offered.has(m.tool_call_id),
        `tool reply ${m.tool_call_id} has no preceding call — an OpenAI-compatible endpoint rejects this transcript`);
    }
  }
}

// 7. R1a — an elided tool body never promises a retrieval the caller cannot serve.
//    carryForward is the ONLY caller of compaction, and it keeps only r.messages: the artifacts
//    map dies here, and `artifact://tool-N` was never a path the `read` tool could resolve. So
//    what the ref TELLS the model must depend on whether a run record is being written, since
//    the record is the only thing that still holds the body.
{
  const bulky = () => ([
    sys, { role: 'user', content: 'run the gate' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'b1', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'b1', content: 'grant scope check failed on revoke\n' + 'x'.repeat(120000) },
    { role: 'user', content: 'now fix it' },
    { role: 'assistant', content: 'ok' },
  ]);

  // No recorder ⇒ nothing retains the body ⇒ say so, plainly.
  const bare = await carryForward(bulky());
  const bareRef = bare.map(m => String(m.content || '')).find(c => /elided/.test(c));
  assert.ok(bareRef, 'the bulky tool body was elided');
  assert.ok(!/artifact:\/\//.test(bareRef), 'no artifact:// id reaches the model — nothing can resolve it');
  assert.ok(!/read tool/.test(bareRef), 'the `read` tool cannot serve an elided body; it must not be named');
  assert.ok(!/history/.test(bareRef), 'with no record being written, `history` must not be promised either');
  assert.match(bareRef, /GONE/, 'it states plainly that the content is gone');

  // With a recorder ⇒ the body is on the chain and `history` searches it ⇒ name the exact calls.
  const calls = [];
  const rec = { compacted: async (e) => { calls.push(e); } };
  const kept = await carryForward(bulky(), rec);
  const keptRef = kept.map(m => String(m.content || '')).find(c => /elided/.test(c));
  assert.ok(keptRef, 'the bulky tool body was elided');
  assert.match(keptRef, /history \{"op":"search"/, 'the ref names the tool that CAN retrieve it, and the op');
  assert.ok(!/artifact:\/\//.test(keptRef), 'still no unresolvable id');
  // The query must be text that occurs in the recorded result — a handle the model cannot match
  // is the same defect wearing a different tool name.
  const q = JSON.parse(keptRef.match(/"query":("(?:[^"\\]|\\.)*")/)[1]);
  assert.ok(bulky()[3].content.includes(q), `the handed query is a verbatim substring of the elided body: ${JSON.stringify(q)}`);
  assert.ok(calls.length, 'and the lossy carry is still recorded on the chain');
}

// 8. The call site actually passes the condition — a correct default the app overrides blindly
//    would put the promise back.
assert.match(anvil, /compactConversation\(out, \{[^}]*retrievable: !!\(rec && rec\.compacted\)/,
  'carryForward gates the retrieval promise on a recorder actually being present');

console.log('anvil-convo-carry: the next run sees tool calls, tool results, the gate verdict, and no impossible retrieval');
