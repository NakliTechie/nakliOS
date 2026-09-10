// Conformance — the agent-tier inference protocol core.
//
//   node sys/ai/test/agent-protocol.test.mjs
//
// Pure-function tests: message/tool normalisation limits, endpoint body shaping,
// and streamed tool-call accumulation against fixtures that mirror the OpenAI /
// Ollama /chat/completions wire format. No fetch, no browser.

import {
  AGENT_LIMITS,
  normaliseAgentMessages,
  normaliseTools,
  normaliseToolChoice,
  clampAgentMaxTokens,
  buildEndpointChatBody,
  createToolCallAccumulator,
  parseToolArguments,
  isRetryableEndpointStatus,
  modelLadder,
  runModelLadder,
} from '../agent-protocol.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function deep(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg || 'deep not equal'}:\n  got ${JSON.stringify(a)}\n  exp ${JSON.stringify(b)}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function throws(fn, re, msg) {
  try { fn(); } catch (e) { if (re && !re.test(e.message)) throw new Error(`${msg}: wrong error ${e.message}`); return; }
  throw new Error(`${msg || 'should throw'}: did not throw`);
}

// ── message normalisation ──────────────────────────────────────────────
await test('narrow chat messages pass through with roles coerced', () => {
  const out = normaliseAgentMessages([
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'weird', content: 'x' },   // unknown role → user
  ]);
  deep(out, [
    { role: 'system', content: 'be terse' },
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'x' },
  ], 'roles');
});

await test('admits the tool role with a tool_call_id', () => {
  const out = normaliseAgentMessages([
    { role: 'user', content: 'list files' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ls', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' },
  ]);
  eq(out[1].content, null, 'assistant tool-call turn has null content');
  deep(out[1].tool_calls[0], { type: 'function', function: { name: 'ls', arguments: '{}' }, id: 'c1' }, 'tool_call preserved');
  deep(out[2], { role: 'tool', tool_call_id: 'c1', content: 'a.txt\nb.txt' }, 'tool result');
});

await test('tool message without tool_call_id is rejected', () => {
  throws(() => normaliseAgentMessages([{ role: 'tool', content: 'x' }]), /tool_call_id/, 'missing id');
});

await test('assistant tool_call missing function.name is rejected', () => {
  throws(() => normaliseAgentMessages([
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { arguments: '{}' } }] },
  ]), /name required/, 'no name');
});

await test('message count and input size caps enforced', () => {
  const many = Array.from({ length: AGENT_LIMITS.maxMessages + 1 }, () => ({ role: 'user', content: 'x' }));
  throws(() => normaliseAgentMessages(many), /at most/, 'count cap');
  const big = [{ role: 'user', content: 'x'.repeat(AGENT_LIMITS.maxInputChars + 1) }];
  throws(() => normaliseAgentMessages(big), /too large/, 'size cap');
});

await test('agent caps are strictly larger than narrow chat (32/24k/768)', () => {
  assert(AGENT_LIMITS.maxMessages > 32, 'messages');
  assert(AGENT_LIMITS.maxInputChars > 24000, 'chars');
  assert(AGENT_LIMITS.maxOutputTokens > 768, 'tokens');
});

// ── tools + tool_choice ────────────────────────────────────────────────
await test('normaliseTools validates and strips to the function shape', () => {
  const out = normaliseTools([
    { type: 'function', function: { name: 'read_file', description: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  ]);
  eq(out.length, 1, 'one tool');
  eq(out[0].function.name, 'read_file', 'name');
  deep(out[0].function.parameters, { type: 'object', properties: { path: { type: 'string' } } }, 'params');
});

await test('normaliseTools: empty/absent → undefined; dupes + bad names rejected', () => {
  eq(normaliseTools(undefined), undefined, 'absent');
  eq(normaliseTools([]), undefined, 'empty');
  throws(() => normaliseTools([{ function: { name: 'a b' } }]), /name must match/, 'bad name');
  throws(() => normaliseTools([
    { function: { name: 'x' } }, { function: { name: 'x' } },
  ]), /duplicate/, 'dupe');
});

await test('tool_choice normalisation', () => {
  eq(normaliseToolChoice('auto'), 'auto', 'auto');
  eq(normaliseToolChoice(undefined), undefined, 'absent');
  deep(normaliseToolChoice({ type: 'function', function: { name: 'ls' } }), { type: 'function', function: { name: 'ls' } }, 'named');
  throws(() => normaliseToolChoice('sometimes'), /auto, none/, 'bad string');
});

await test('clampAgentMaxTokens bounds the request', () => {
  eq(clampAgentMaxTokens(999999), AGENT_LIMITS.maxOutputTokens, 'upper');
  eq(clampAgentMaxTokens(1), AGENT_LIMITS.minOutputTokens, 'lower');
  eq(clampAgentMaxTokens(2048), 2048, 'passthrough');
});

// ── endpoint body ──────────────────────────────────────────────────────
await test('buildEndpointChatBody omits tools when none supplied (narrow-chat identical)', () => {
  const body = buildEndpointChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 });
  deep(body, { model: 'm', messages: [{ role: 'user', content: 'hi' }], max_tokens: 100, stream: true }, 'no tools key');
  assert(!('tools' in body), 'tools absent');
});

await test('buildEndpointChatBody includes tools + tool_choice when present', () => {
  const tools = normaliseTools([{ function: { name: 'ls' } }]);
  const body = buildEndpointChatBody({ model: 'm', messages: [], maxTokens: 50, tools, toolChoice: 'auto', stream: false });
  eq(body.stream, false, 'stream flag threaded');
  eq(body.tools.length, 1, 'tools present');
  eq(body.tool_choice, 'auto', 'choice present');
});

// ── streamed tool-call accumulation ────────────────────────────────────
// Fixture: OpenAI-style SSE deltas — id/name in the first, arguments in fragments.
await test('accumulator reassembles a streamed tool call from deltas', () => {
  const acc = createToolCallAccumulator();
  const deltas = [
    { content: null, tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt",' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '"data":"hi"}' } }] },
  ];
  for (const d of deltas) acc.absorbDelta(d);
  const calls = acc.finalize();
  eq(calls.length, 1, 'one call');
  deep(calls[0], { type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","data":"hi"}' }, id: 'call_1' }, 'reassembled');
  deep(parseToolArguments(calls[0]).value, { path: 'a.txt', data: 'hi' }, 'args parse');
});

await test('accumulator handles two parallel tool calls by index', () => {
  const acc = createToolCallAccumulator();
  acc.absorbDelta({ tool_calls: [
    { index: 0, id: 'a', function: { name: 'ls', arguments: '{}' } },
    { index: 1, id: 'b', function: { name: 'cat', arguments: '' } },
  ] });
  acc.absorbDelta({ tool_calls: [{ index: 1, function: { arguments: '{"f":"x"}' } }] });
  const calls = acc.finalize();
  eq(calls.length, 2, 'two calls');
  eq(calls[0].function.name, 'ls', 'order 0');
  eq(calls[1].function.arguments, '{"f":"x"}', 'order 1 args');
});

await test('accumulator absorbs a non-streamed message.tool_calls', () => {
  const acc = createToolCallAccumulator();
  acc.absorbMessage({ tool_calls: [{ id: 'z', type: 'function', function: { name: 'grep', arguments: '{"q":"e"}' } }] });
  const calls = acc.finalize();
  deep(calls[0], { type: 'function', function: { name: 'grep', arguments: '{"q":"e"}' }, id: 'z' }, 'whole call');
});

await test('absorbDelta is a no-op on plain content chunks; nameless calls dropped', () => {
  const acc = createToolCallAccumulator();
  acc.absorbDelta({ content: 'hello' });     // no tool_calls
  acc.absorbDelta({ tool_calls: [{ index: 0, function: { arguments: '{}' } }] }); // never got a name
  eq(acc.finalize().length, 0, 'no spurious calls');
});

await test('parseToolArguments reports invalid JSON without throwing', () => {
  const r = parseToolArguments({ function: { name: 'x', arguments: '{bad' } });
  eq(r.ok, false, 'not ok');
  assert(typeof r.error === 'string', 'error string');
  deep(parseToolArguments({ function: { name: 'x', arguments: '' } }), { ok: true, value: {} }, 'empty → {}');
});


// ── Ordered model fallback ────────────────────────────────────────────
await test('the ladder is ordered, deduped, and drops blanks', () => {
  eq(modelLadder('a', ['b', 'a', '  ', null, 'c']).join(','), 'a,b,c');
  eq(modelLadder('  ', ['', 'b']).join(','), 'b');
  eq(modelLadder('', []).length, 0);
});

await test('only transport-class failures are worth a different model id', () => {
  for (const s of [500, 502, 503, 529, 429]) assert(isRetryableEndpointStatus(s), `${s} should advance`);
  for (const s of [200, 400, 401, 403, 404, 422]) assert(!isRetryableEndpointStatus(s), `${s} must not advance`);
  assert(!isRetryableEndpointStatus(undefined), 'a missing status is not a status');
});

await test('a 500 on one id falls through to the next and reports who answered', async () => {
  const seen = [];
  const err = (status) => Object.assign(new Error('boom ' + status), { status });
  const r = await runModelLadder(['x:free', 'y:free', 'z:free'], async (m) => {
    seen.push(m);
    if (m !== 'z:free') throw err(500);
    return 'answer';
  });
  eq(r.value, 'answer');
  eq(r.model, 'z:free', 'the ladder names the id that actually answered, not the configured one');
  eq(seen.join(','), 'x:free,y:free,z:free');
  eq(r.attempts.length, 3);
  eq(r.attempts[0].status, 500);
});

await test('a network throw with no status still advances', async () => {
  const r = await runModelLadder(['a', 'b'], async (m) => {
    if (m === 'a') throw new TypeError('Failed to fetch');
    return 'ok';
  });
  eq(r.model, 'b');
});

await test('a 401 stops the ladder instead of repeating itself down every id', async () => {
  const seen = [];
  let thrown = null;
  try {
    await runModelLadder(['a', 'b', 'c'], async (m) => {
      seen.push(m); throw Object.assign(new Error('bad key'), { status: 401 });
    });
  } catch (e) { thrown = e; }
  assert(thrown, 'a non-retryable failure still throws');
  eq(seen.join(','), 'a', 'a credential error must not be retried on four more ids');
});

await test('once anything has been emitted the failure is terminal', async () => {
  const seen = [];
  let emitted = false;
  let thrown = null;
  try {
    await runModelLadder(['a', 'b'], async (m) => {
      seen.push(m); emitted = true;            // tokens reached the caller
      throw Object.assign(new Error('died mid-stream'), { status: 500 });
    }, { hasEmitted: () => emitted });
  } catch (e) { thrown = e; }
  assert(thrown, 'a mid-stream death is not swallowed');
  eq(seen.join(','), 'a', 'switching after emission would splice two models into one turn');
});

await test('when every id fails the error carries the trail that was tried', async () => {
  let thrown = null;
  try {
    await runModelLadder(['a', 'b'], async () => { throw Object.assign(new Error('down'), { status: 503 }); });
  } catch (e) { thrown = e; }
  assert(thrown, 'it throws');
  eq(thrown.attempts.length, 2);
  eq(thrown.attempts.map((a) => a.model).join(','), 'a,b');
});


if (failures.length) {
  console.error(`agent-protocol: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/agent-protocol conformance: ${passed}/${passed} passed`);
