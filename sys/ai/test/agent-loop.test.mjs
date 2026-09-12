// Conformance — the agent loop over a real Rig shell.
//
//   node sys/ai/test/agent-loop.test.mjs
//
// The model is mocked (a scripted `infer`), but the tool side is the real Forge
// shell over an in-memory Rig backend — so this exercises the true tool-calling
// path (send → tool_calls → shell.feed → tool result → repeat) end-to-end,
// headlessly. The live endpoint is the only piece a browser/Ollama session adds.

import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGitCore } from '../../rig/git/git-core.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { runAgentLoop, shellTool, makeShellExecutor, taskDoneTool, DEFAULT_TOOL_CONCURRENCY,
  estimateTokens, boundedText, interceptBashCommand,
  REPEAT_NUDGE_AT, repeatNudge, stepSignature,
  usageInputTokens, usageOutputTokens,
  spillToolOutput, placeholderSummary, clarifyTool } from '../agent-loop.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function deepEq(a, b, msg) {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }

function freshShell() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({
    prefixes: [''],
    scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'],
  });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent' });
  return createShell({ registry, face });
}

// A scripted model: each entry is what infer() returns for that step. Later
// steps can inspect the transcript to react to tool results.
function scriptedInfer(script) {
  let i = 0;
  return async ({ messages }) => {
    const step = script[Math.min(i, script.length - 1)];
    i++;
    return typeof step === 'function' ? step(messages) : step;
  };
}
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// ── the headline: a multi-step tool-calling loop drives the real shell ──
await test('a scripted 3-tool-call loop creates and reads a file, then finishes', async () => {
  const shell = freshShell();
  const events = [];
  const result = await runAgentLoop({
    messages: [
      { role: 'system', content: 'You are a coding agent with a shell.' },
      { role: 'user', content: 'Create src/a.txt containing hi and show it.' },
    ],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'mkdir -p src' }, 'c0')] },
      { content: '', toolCalls: [call('shell', { command: 'echo hi > src/a.txt' }, 'c1')] },
      { content: '', toolCalls: [call('shell', { command: 'cat src/a.txt' }, 'c2')] },
      { content: 'Done — src/a.txt contains "hi".', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
    onEvent: e => events.push(e),
  });
  eq(result.stop, 'done', 'loop ended cleanly');
  eq(result.steps, 4, 'four model turns');
  assert(/hi/.test(result.text), `final text mentions the content: ${result.text}`);
  // The transcript carries the real tool result from `cat`.
  const toolMsgs = result.messages.filter(m => m.role === 'tool');
  eq(toolMsgs.length, 3, 'three tool results appended');
  eq(toolMsgs[2].content, 'hi', 'cat returned the file content through the real shell');
  // Prove the write actually landed in the workspace.
  eq((await shell.feed('cat src/a.txt')).output, 'hi', 'file persisted in the backend');
  // Events fired for each tool call and result.
  eq(events.filter(e => e.type === 'tool-call').length, 3, 'three tool-call events');
  eq(events.filter(e => e.type === 'tool-result').length, 3, 'three tool-result events');
  assert(events.some(e => e.type === 'done'), 'a done event fired');
});

// ── a turn must be observable and cancellable while it is in flight ──────
await test('every turn announces itself before blocking on the model', async () => {
  const shell = freshShell();
  const events = [];
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'echo a' }, 'c0')] },
      { content: 'finished.', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
    onEvent: e => events.push(e),
  });
  // Without this the UI has nothing to draw while a slow model thinks, so a
  // working run and a wedged one look identical.
  eq(events.filter(e => e.type === 'turn-start').length, 2, 'one turn-start per model turn');
  const first = events.findIndex(e => e.type === 'turn-start');
  const firstCall = events.findIndex(e => e.type === 'tool-call');
  assert(first >= 0 && first < firstCall, 'turn-start precedes the turn it announces');
  eq(events.filter(e => e.type === 'turn-start')[0].step, 0, 'turn-start carries its step');
});

await test('the abort signal reaches infer, so an in-flight call can be cancelled', async () => {
  const shell = freshShell();
  const seen = [];
  const controller = new AbortController();
  // A hung endpoint: infer never resolves on its own — only the signal ends it.
  const hangingInfer = ({ signal }) => new Promise((resolve, reject) => {
    seen.push(signal || null);
    if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  setTimeout(() => controller.abort(), 20);
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: hangingInfer,
    executeTool: makeShellExecutor(shell),
    signal: controller.signal,
  });
  assert(seen[0], 'infer received a signal');
  eq(seen[0].aborted, true, 'and it is the run\'s own signal');
  // Stop must end the run. Before this, abort was only checked BETWEEN turns, so
  // a hung inference ignored both Stop and the wall-clock budget.
  // A cancelled in-flight inference is the Stop button working — it must read as
  // 'aborted', never 'error' (Anvil showed 'agent error: aborted' until this was pinned).
  eq(result.stop, 'aborted', `run ended as an abort, not an error (got ${result.stop})`);
  assert(!result.error, 'no error field on a user stop');
});

await test('assistant tool-call turns carry null content + tool_calls, paired by id', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'list root' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'pwd' }, 'x1')] },
      { content: 'root is /', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
  });
  const assistantToolTurn = result.messages.find(m => m.role === 'assistant' && m.tool_calls);
  eq(assistantToolTurn.content, null, 'tool-call turn has null content');
  eq(assistantToolTurn.tool_calls[0].id, 'x1', 'tool_call id preserved');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  eq(toolMsg.tool_call_id, 'x1', 'tool result references the call id');
});

await test('a repeating model is NUDGED, escalating, and the run is never killed for it (F7)', async () => {
  const shell = freshShell();
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'r')] }]), // same forever
    executeTool: makeShellExecutor(shell),
    onEvent: (e) => events.push(e),
    maxSteps: 10,
  });
  // the old behaviour — killing the run at the second identical call — is gone
  assert(result.stop !== 'no-progress', `the run was killed for repeating: ${result.stop}`);
  eq(result.stop, 'max-steps', 'the run ran to its own bound instead');
  eq(result.steps, 10, 'every step was used — the nudge never stops the loop');

  const nudges = events.filter((e) => e.type === 'repeat-nudge');
  deepEq(nudges.map((n) => n.times), REPEAT_NUDGE_AT.slice(), `nudged at ${REPEAT_NUDGE_AT.join('/')}, once each: ${JSON.stringify(nudges.map(n => n.times))}`);
  assert(!events.some((e) => e.type === 'no-progress'), 'the no-progress event is gone with the stop');

  const notes = result.messages.filter((m) => m.role === 'user' && /^\[coordination\]/.test(m.content));
  eq(notes.length, 3, `three nudges reached the transcript: ${notes.length}`);
  for (const n of notes) assert(/pwd/.test(n.content), `the nudge names the repeated call: ${n.content}`);
  // escalation is real: the last one asks for a stop, the first only asks to step back
  assert(/Step back/.test(notes[0].content), `first nudge is gentle: ${notes[0].content}`);
  assert(/Stop repeating it/.test(notes[2].content), `last nudge is blunt: ${notes[2].content}`);
  assert(notes[0].content !== notes[1].content && notes[1].content !== notes[2].content, 'the three nudges differ — escalation, not repetition');
  // every assistant tool-call turn is still immediately followed by its tool result
  for (let i = 0; i < result.messages.length; i++) {
    const m = result.messages[i];
    if (m.role === 'assistant' && m.tool_calls?.length) {
      eq(result.messages[i + 1]?.role, 'tool', `a nudge was inserted between a tool call and its result at ${i}`);
    }
  }
});

await test('a nudge lands after EVERY tool result of a multi-call turn, not between them (F7)', async () => {
  // With one call per turn, flushing the nudge inside the tool loop is indistinguishable from
  // flushing it after — a checker moved the flush and the suite stayed green. Three calls in
  // one turn tell the two apart: a user turn between a tool_call and any of its replies is
  // malformed on a strict endpoint, and the provider rejects the NEXT request.
  const three = [
    call('shell', { command: 'a' }, 'c1'),
    call('shell', { command: 'b' }, 'c2'),
    call('shell', { command: 'c' }, 'c3'),
  ];
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: three }),
    executeTool: async () => 'ok',
    maxSteps: 4,
  });
  const notes = r.messages.filter((m) => m.role === 'user' && /^\[coordination\]/.test(m.content));
  assert(notes.length >= 1, 'the run did nudge, so the ordering below is actually exercised');
  for (let i = 0; i < r.messages.length; i++) {
    if (r.messages[i].role !== 'assistant' || !r.messages[i].tool_calls?.length) continue;
    const ids = r.messages[i].tool_calls.map((c) => c.id);
    // the next `ids.length` messages must be exactly this turn's tool replies, in order
    const replies = r.messages.slice(i + 1, i + 1 + ids.length);
    deepEq(replies.map((m) => m.role), ids.map(() => 'tool'),
      `a non-tool message interrupts a 3-call turn's replies at ${i}: ${JSON.stringify(r.messages.slice(i, i + 5).map((m) => m.role))}`);
    deepEq(replies.map((m) => m.tool_call_id), ids, 'every call is answered, in the order it was made');
  }
});

await test('the repeat chain keys on the CANONICAL call, and a denied call is nudged in stronger terms (F7)', async () => {
  // same call, keys emitted in a different order each turn — a raw-string compare calls this progress
  const flip = [
    { content: '', toolCalls: [{ id: 'a', function: { name: 'shell', arguments: '{"command":"pwd","cwd":"/"}' } }] },
    { content: '', toolCalls: [{ id: 'a', function: { name: 'shell', arguments: '{"cwd":"/","command":"pwd"}' } }] },
  ];
  let i = 0;
  const events = [];
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => flip[i++ % 2],
    executeTool: async () => 'Refused: the skills directory is managed by skill_manage.',
    onEvent: (e) => events.push(e),
    maxSteps: 4,
  });
  const n = events.find((e) => e.type === 'repeat-nudge');
  assert(n, 'reordered arguments are recognised as the same call');
  eq(n.times, 3, 'the chain counted through the reordering');
  assert(n.denied === true, 'a turn whose every result was a refusal is marked denied');
  const note = repeatNudge(3, flip[0].toolCalls, { denied: true });
  assert(/refused/i.test(note), `the denied nudge says so: ${note}`);
  assert(!/refused/i.test(repeatNudge(3, flip[0].toolCalls, { denied: false })), 'an undenied nudge does not claim a refusal');
});

await test('a user interjection resets the repeat chain, and a nudge never counts as one (F7)', async () => {
  const events = [];
  let step = 0;
  await runAgentLoop({
    // the caller appends an owner turn after two identical calls; the count restarts from it
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async ({ messages }) => {
      step++;
      // after the 3rd identical call the OWNER speaks — simulated by appending to the array
      // the loop is building, which is exactly what a host interjection would do. Without it
      // the 4 steps below would reach an unbroken run of 3 and nudge (the control proves it).
      if (step === 3) messages.push({ role: 'user', content: 'actually, do it the other way' });
      return { content: '', toolCalls: [call('shell', { command: 'pwd' }, 'r')] };
    },
    executeTool: async () => 'ok',
    onEvent: (e) => events.push(e),
    maxSteps: 4,
  });
  const nudges = events.filter((e) => e.type === 'repeat-nudge');
  eq(nudges.length, 0, `the interjection reset the chain, so 4 identical calls did not reach 3 unbroken: ${JSON.stringify(nudges)}`);
  // and the control: the SAME run with no interjection does nudge
  const ctlEvents = [];
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'r')] }),
    executeTool: async () => 'ok',
    onEvent: (e) => ctlEvents.push(e),
    maxSteps: 4,
  });
  eq(ctlEvents.filter((e) => e.type === 'repeat-nudge').length, 1, 'control: without the interjection the chain reaches 3 and nudges');
});

await test('the nudge preview is bounded, but detection is not (F7)', () => {
  const long = 'x'.repeat(5000);
  const c = [{ function: { name: 'write', arguments: JSON.stringify({ path: 'a', text: long }) } }];
  const note = repeatNudge(3, c);
  assert(note.length < 700, `the model-visible preview is capped: ${note.length} chars`);
  assert(/\+\d+ chars/.test(note), `the elision is honest about how much it dropped: ${note}`);
  // two calls that differ only PAST the cap are still different calls to the detector
  const d = [{ function: { name: 'write', arguments: JSON.stringify({ path: 'a', text: long + 'DIFFERENT' }) } }];
  assert(stepSignature(c) !== stepSignature(d), 'detection keys on the full string, not the preview');
});

await test('max-steps bounds a model that keeps calling distinct tools', async () => {
  const shell = freshShell();
  let n = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: `echo ${n++}` }, `c${n}`)] }),
    executeTool: makeShellExecutor(shell),
    maxSteps: 5,
  });
  eq(result.stop, 'max-steps', 'bounded');
  eq(result.steps, 5, 'stopped at the cap');
});

await test('at the step cap a gated run asks the verifier once: green is done (atCap), red stays max-steps with the verdict', async () => {
  // a model that keeps probing and never calls task_done — the 2026-09-12 mdlite shape
  const probing = () => { let n = 0; return async () => ({ content: '', toolCalls: [call('shell', { command: `echo ${n++}` }, `c${n}`)] }); };
  const events = [];
  const green = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [shellTool()], infer: probing(),
    executeTool: makeShellExecutor(freshShell()), maxSteps: 3, verify: async () => ({ ok: true, exit: 0 }),
    onEvent: (e) => events.push(e.type),
  });
  eq(green.stop, 'done', 'the gate passed, so the run is done');
  eq(green.verified, true, 'on the verifier\'s word');
  eq(green.atCap, true, 'and the record says the model never called task_done');
  eq(green.steps, 3, 'it did run out of steps');
  eq(events.slice(-3).join(' '), 'max-steps verify-pass done', 'the cap, then the verdict, then done');
  let asked = 0;
  const red = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [shellTool()], infer: probing(),
    executeTool: makeShellExecutor(freshShell()), maxSteps: 3, verify: async () => { asked++; return { ok: false, exit: 1, stderr: 'FAILED (failures=1)' }; },
  });
  eq(red.stop, 'max-steps', 'a red gate leaves the stop as it was');
  eq(red.verified, false, 'and says so');
  assert(red.verdict && /FAILED/.test(red.verdict.stderr), 'with the verdict the owner would want to see');
  eq(asked, 1, 'the verifier is asked exactly once at the cap');
  const ungated = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [shellTool()], infer: probing(),
    executeTool: makeShellExecutor(freshShell()), maxSteps: 3,
  });
  eq(ungated.stop, 'max-steps', 'no gate → nothing to ask; the cap is the cap');
  eq(ungated.verified, undefined, 'and no claim is made');
});

await test('a tool call with invalid JSON args yields an error result, loop continues', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [{ id: 'b', type: 'function', function: { name: 'shell', arguments: '{bad json' } }] },
      { content: 'ok, recovered', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell),
  });
  eq(result.stop, 'done', 'recovered and finished');
  const toolMsg = result.messages.find(m => m.role === 'tool');
  assert(/could not parse/i.test(toolMsg.content), `error surfaced to the model: ${toolMsg.content}`);
});

await test('makeShellExecutor rejects unknown tools and empty commands', async () => {
  const exec = makeShellExecutor(freshShell());
  assert(/unknown tool/.test(await exec('frobnicate', {})), 'unknown tool');
  // The refusal must name where the command goes, not just that one is missing: a model
  // that put it under the wrong key learns nothing from "requires a non-empty command".
  const blank = await exec('shell', { command: '  ' });
  assert(/"command"/.test(blank), `names the parameter: ${blank}`);
  const wrongKey = await exec('shell', { cmd: 'echo hi' });
  assert(/"command"/.test(wrongKey), `names the parameter: ${wrongKey}`);
  assert(/"cmd"/.test(wrongKey), `names the key that was sent: ${wrongKey}`);
  eq(await exec('shell', { command: 'echo hi' }), 'hi', 'real output');
});

await test('shellTool schema is a valid OpenAI function tool', () => {
  const t = shellTool();
  eq(t.type, 'function', 'type');
  eq(t.function.name, 'shell', 'name');
  eq(t.function.parameters.required[0], 'command', 'required command');
});

await test('infer errors surface as stop:error, not a throw', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => { throw new Error('endpoint down'); },
    executeTool: makeShellExecutor(freshShell()),
  });
  eq(result.stop, 'error', 'error captured');
  assert(/endpoint down/.test(result.error), 'error text preserved');
});

await test('verifier gate: a failing verdict is fed back; only a passing one completes', async () => {
  const shell = freshShell();
  const verify = async () => {
    const out = (await shell.feed('cat status.txt')).output;
    const ok = /PASS/.test(out);
    return { ok, exit: ok ? 0 : 1, stdout: out };
  };
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'echo FAIL > status.txt' }, 'c0')] },
      { content: 'done (prematurely)', toolCalls: [] },              // claims done → verify FAILS
      { content: '', toolCalls: [call('shell', { command: 'echo PASS > status.txt' }, 'c1')] }, // fix
      { content: 'now really done', toolCalls: [] },                 // claims done → verify PASSES
    ]),
    executeTool: makeShellExecutor(shell),
    verify,
    onEvent: (e) => events.push(e),
  });
  eq(result.stop, 'done', 'completed'); eq(result.verified, true, 'verified true');
  assert(events.some((e) => e.type === 'verify-fail'), 'a verify-fail was surfaced');
  assert(events.some((e) => e.type === 'verify-pass'), 'a verify-pass ended it');
});

await test('verifier gate: stop:unverified when the model never satisfies the verifier', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do the task' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'I think it is done', toolCalls: [] }), // always claims done, never acts
    executeTool: makeShellExecutor(shell),
    verify: async () => ({ ok: false, exit: 1, stderr: 'still failing' }),
    maxVerifyRounds: 2,
  });
  eq(result.stop, 'unverified', 'never verified'); eq(result.verified, false, 'verified false');
  eq(result.steps, 2, 'stopped after maxVerifyRounds');
});

await test('no verifier → the model still completes on its own (back-compat)', async () => {
  const shell = freshShell();
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: 'all set', toolCalls: [] }]),
    executeTool: makeShellExecutor(shell),
  });
  eq(result.stop, 'done', 'done without a verifier');
  assert(result.verified === undefined, 'no verified flag when no verifier');
});

// ── Batch 7: gate memoization by workspace hash ─────────────────────────
await test('gate memoization: an unchanged workspace hash replays the cached failure — no rerun', async () => {
  let verifyCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'I claim it is done', toolCalls: [] }), // never acts
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => { verifyCalls++; return { ok: false, exit: 1, stderr: 'still red' }; },
    workspaceHash: async () => 'STABLE', // workspace never changes
    maxVerifyRounds: 3,
  });
  eq(result.stop, 'unverified', 'stopped unverified');
  eq(verifyCalls, 1, 'gate ran once; the 2 later identical-hash rounds replayed the memo');
});

await test('gate memoization: a changed workspace hash reruns the gate', async () => {
  let verifyCalls = 0;
  let hashN = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'done?', toolCalls: [] }),
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => { verifyCalls++; return { ok: false, exit: 1, stderr: 'red' }; },
    workspaceHash: async () => `H${hashN++}`, // different every check
    maxVerifyRounds: 3,
  });
  eq(result.stop, 'unverified', 'unverified');
  eq(verifyCalls, 3, 'gate reran each round because the hash changed');
});

// ── Batch 7: bounded gate output as the repair prompt ───────────────────
await test('bounded gate output is fed back as the repair prompt', async () => {
  const bigStdout = Array.from({ length: 500 }, (_, i) => `error line ${i}`).join('\n');
  let sawFeedback = null;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: 'done (early)', toolCalls: [] }, // fails → feedback injected
      (messages) => { sawFeedback = messages[messages.length - 1]; return { content: '', toolCalls: [] }; },
    ]),
    executeTool: makeShellExecutor(freshShell()),
    verify: async () => ({ ok: false, exit: 2, stdout: bigStdout }),
    gateOutputCap: { maxLines: 50, maxBytes: 5000 },
    maxVerifyRounds: 3,
  });
  assert(sawFeedback && sawFeedback.role === 'user', 'a user repair message was injected');
  assert(/exit 2/.test(sawFeedback.content), 'the exit code is in the repair prompt');
  assert(/output truncated/.test(sawFeedback.content), 'the gate output was bounded');
  assert(sawFeedback.content.split('\n').length < 100, 'feedback is capped, not the full 500 lines');
});

// ── Batch 7: explicit completion (task_done) + gate veto ────────────────
await test('task_done: a red gate rejects completion; a later green gate accepts it', async () => {
  const shell = freshShell();
  const verify = async () => {
    const out = (await shell.feed('cat status.txt')).output;
    const ok = /PASS/.test(out);
    return { ok, exit: ok ? 0 : 1, stdout: out };
  };
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'do it' }],
    tools: [shellTool(), taskDoneTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'echo FAIL > status.txt' }, 's0')] },
      { content: '', toolCalls: [call('task_done', { summary: 'think done' }, 'd0')] }, // gate RED → rejected
      { content: '', toolCalls: [call('shell', { command: 'echo PASS > status.txt' }, 's1')] },
      { content: '', toolCalls: [call('task_done', { summary: 'really done' }, 'd1')] }, // gate GREEN → accepted
    ]),
    executeTool: makeShellExecutor(shell),
    verify,
    onEvent: (e) => events.push(e),
  });
  eq(result.stop, 'done', 'completed via task_done');
  eq(result.verified, true, 'verified true');
  // The rejected task_done left a tool message with the gate failure.
  const rejected = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'd0');
  assert(/NOT complete/.test(rejected.content), 'red task_done fed back the failure');
  const accepted = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'd1');
  assert(/complete/i.test(accepted.content), 'green task_done accepted');
});

await test('task_done with no gate wired is accepted as the explicit done signal', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool(), taskDoneTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('task_done', { summary: 'Wrote the file and ran it; output matched.' }, 'd')] }]),
    executeTool: makeShellExecutor(freshShell()),
  });
  eq(result.stop, 'done', 'done'); eq(result.verified, true, 'accepted');
});

// ── B2 (2026-09-11): a placeholder summary is bounced, never accepted, never gated ──
await test('task_done: an empty or placeholder summary is refused and the gate does not run', async () => {
  let gateRuns = 0;
  const verify = async () => { gateRuns++; return { ok: true, exit: 0, stdout: 'PASS', stderr: '' }; };
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool(), taskDoneTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('task_done', {}, 'd1')] },
      { content: '', toolCalls: [call('task_done', { summary: 'done' }, 'd2')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Task complete!' }, 'd3')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Fixed parse_amount to return Decimal; the gate passes.' }, 'd4')] },
    ]),
    executeTool: makeShellExecutor(freshShell()), verify,
  });
  eq(result.stop, 'done', 'the real summary was accepted');
  eq(gateRuns, 1, 'the gate ran ONCE — never for a placeholder');
  const bounced = result.messages.filter((m) => m.role === 'tool' && /invalid_args/.test(m.content));
  eq(bounced.length, 3, 'three placeholders, three bounces');
  assert(/what you did and how you verified it/.test(bounced[0].content), `the bounce says what a summary is: ${bounced[0].content}`);
});
await test('placeholderSummary: the closed list, blanks, and length', () => {
  for (const bad of ['', '  ', 'done', 'Done.', 'ok', 'finished', 'Task complete', 'task is done!', 'success']) assert(placeholderSummary(bad), `refused: ${JSON.stringify(bad)}`);
  for (const good of ['Wrote inv/store.py and ran the gate; it passed.', 'Renamed the flag; tests green.', 'tests green', 'think done']) eq(placeholderSummary(good), null, `accepted (no length rule): ${good}`);
});

// ── B3: clarify pauses the run with the question; an empty question is bounced ──
await test('clarify: the run pauses with stop:clarify, the question rides the result, and the loop emits it', async () => {
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'migrate the db' }],
    tools: [shellTool(), clarifyTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('clarify', { question: 'Drop the legacy table, or keep it read-only?' }, 'q1')] }]),
    executeTool: makeShellExecutor(freshShell()), onEvent: (e) => events.push(e),
  });
  eq(result.stop, 'clarify'); eq(result.question, 'Drop the legacy table, or keep it read-only?');
  eq(result.steps, 1, 'it stopped on the step that asked');
  assert(events.some((e) => e.type === 'clarify' && /legacy table/.test(e.question)), 'the clarify event carries the question');
  const toolMsg = result.messages.find((m) => m.role === 'tool' && m.tool_call_id === 'q1');
  assert(/pauses here/.test(toolMsg.content), 'the model was told the run pauses');
});
await test('clarify: an empty question is refused as invalid_args and the run continues', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool(), clarifyTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('clarify', { question: '   ' }, 'q0')] }, { content: 'fine, proceeding', toolCalls: [] }]),
    executeTool: makeShellExecutor(freshShell()),
  });
  eq(result.stop, 'done', 'the run went on');
  assert(result.messages.some((m) => m.role === 'tool' && /invalid_args.*clarify needs the question/.test(m.content)), 'bounced with a reason');
});

// ── B1: every failing tool result carries a typed kind on its event; successes carry none ──
await test('tool results carry a failure kind the loop can route on', async () => {
  const events = [];
  const shell = freshShell();
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([
      { content: '', toolCalls: [call('shell', { command: 'cat nope.txt' }, 'c1')] },
      { content: '', toolCalls: [call('shell', { command: 'echo hi' }, 'c2')] },
      { content: '', toolCalls: [{ id: 'c3', type: 'function', function: { name: 'shell', arguments: '{"command": "unterminated' } }] },
      { content: '', toolCalls: [call('nosuchtool', { x: 1 }, 'c4')] },
      { content: 'done', toolCalls: [] },
    ]),
    executeTool: makeShellExecutor(shell), onEvent: (e) => events.push(e),
  });
  const kinds = Object.fromEntries(events.filter((e) => e.type === 'tool-result').map((e) => [e.id, e.kind || null]));
  eq(kinds.c1, 'not_found', 'ENOENT is not_found'); eq(kinds.c2, null, 'a success has no kind');
  eq(kinds.c3, 'invalid_args', 'unparseable arguments'); eq(kinds.c4, 'unavailable', 'an unknown tool');
});


// ── Batch 7: the budget ladder (turns / tokens / wall-clock) ────────────
await test('budget ladder: the turns axis trips its stop reason', async () => {
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: `echo ${Math.random()}` }, `c${Math.random()}`)] }),
    executeTool: makeShellExecutor(freshShell()),
    budget: { turns: 3 },
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'turns', 'the turns axis');
  eq(result.steps, 3, 'stopped at the turn budget');
});

await test('budget ladder: the tokens axis trips its stop reason', async () => {
  const huge = 'x'.repeat(40_000); // ~10k tokens, dwarfs the budget
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: huge }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'echo hi' }, 'c')] }),
    executeTool: makeShellExecutor(freshShell()),
    budget: { tokens: 100 },
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'tokens', 'the tokens axis');
});

await test('budget ladder: the wall-clock axis trips its stop reason', async () => {
  let t = 1000;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => { t += 5000; return { content: '', toolCalls: [call('shell', { command: 'echo hi' }, `c${t}`)] }; },
    executeTool: makeShellExecutor(freshShell()),
    budget: { wallClockMs: 10_000 },
    now: () => t, // injected clock advances 5s per turn
    maxSteps: 50,
  });
  eq(result.stop, 'budget', 'stopped on budget');
  eq(result.budgetAxis, 'wall-clock', 'the wall-clock axis');
});

// ── Batch 3 rest: bash interceptor hints ────────────────────────────────
await test('interceptBashCommand redirects sed -i / grep -r / cat > to structured tools', () => {
  assert(/edit/.test(interceptBashCommand('sed -i s/a/b/ f.txt') || ''), 'sed -i → edit');
  assert(/edit/.test(interceptBashCommand('perl -i -pe s/a/b/ f') || ''), 'perl -i → edit');
  assert(/rg|ripgrep/.test(interceptBashCommand('grep -r foo src/') || ''), 'grep -r → rg');
  assert(/rg|ripgrep/.test(interceptBashCommand('grep -R foo .') || ''), 'grep -R → rg');
  assert(/write/.test(interceptBashCommand('cat > out.txt') || ''), 'cat > → write');
  assert(/write/.test(interceptBashCommand('cat <<EOF') || ''), 'cat heredoc → write');
  eq(interceptBashCommand('cat f.txt'), null, 'plain cat read is not intercepted');
  eq(interceptBashCommand('grep foo f.txt'), null, 'non-recursive grep is not intercepted');
  eq(interceptBashCommand('echo hi > f.txt'), null, 'echo redirect (supported) is not intercepted');
  eq(interceptBashCommand('ls -la'), null, 'ls is not intercepted');
});

await test('the shell executor returns the interceptor hint instead of running the command', async () => {
  const exec = makeShellExecutor(freshShell());
  const out = await exec('shell', { command: 'sed -i s/a/b/ f.txt' });
  assert(/edit/.test(out), `hint returned: ${out}`);
});

// ── token estimator + boundedText (compaction/budget primitives) ────────
await test('estimateTokens and boundedText behave as monotonic, capping primitives', () => {
  assert(estimateTokens('a'.repeat(400)) === 100, '~4 chars/token');
  assert(estimateTokens([{ role: 'user', content: 'a'.repeat(40) }]) === 10, 'over a transcript');
  const capped = boundedText(Array.from({ length: 300 }, (_, i) => `L${i}`).join('\n'), { maxLines: 10, maxBytes: 9999 });
  assert(/truncated/.test(capped), 'marks truncation');
  assert(capped.split('\n').length <= 12, 'capped to ~10 lines');
  eq(boundedText('short'), 'short', 'short text passes through unchanged');
  // R1b: boundedText feeds GATE FEEDBACK, and a test runner prints its verdict LAST. Head-only
  // truncation dropped exactly the diagnosis the agent needed.
  const fail = Array.from({ length: 500 }, (_, i) => `line ${i}`);
  fail[499] = 'AssertionError: expected 3 to equal 4';
  const both = boundedText(fail.join('\n'));
  assert(/AssertionError: expected 3 to equal 4/.test(both), 'the TAIL survives — the diagnosis is the last line');
  assert(/line 0/.test(both), 'the head survives too');
  assert(/elided/.test(both), 'the pruned middle is marked');
  // the marker names BOTH dimensions removed, so the model knows the output is not contiguous
  assert(/… \(\d+ lines \/ \d+ chars elided\) …/.test(both), `marker names lines and chars: ${both.slice(0, 400)}`);
  assert(/line 300/.test(both) === false, 'the middle is actually gone, not just annotated');
  // a single over-long line has no newlines at all: only the byte cap can fire, and the END
  // of that line — where a traceback's last frame lives — must still arrive
  const oneLine = 'START' + 'x'.repeat(9000) + 'ASSERT-FAILED-HERE';
  const capped1 = boundedText(oneLine, { maxLines: 200, maxBytes: 400 });
  assert(/^START/.test(capped1), 'the head of the single line survives');
  assert(/ASSERT-FAILED-HERE/.test(capped1), 'the tail of the single line survives');
  assert(/chars elided/.test(capped1), 'the character-path marker names what it removed');
  // the counts must be TRUE, not decorative: what the marker claims to have removed is what is
  // actually missing. "bytes" would be a lie here — s.length is UTF-16 units and the path below
  // counts code points, so 3,000 emoji are 3,000 of these and 12,000 real UTF-8 bytes.
  {
    const src = Array.from({ length: 600 }, (_, i) => `line ${i} ${'y'.repeat(20)}`).join('\n');
    const capped = boundedText(src, { maxLines: 200, maxBytes: 999999 });
    const m = capped.match(/… \((\d+) lines \/ (\d+) chars elided\) …/);
    assert(m, `the marker is there: ${capped.slice(0, 200)}`);
    const keptLines = capped.split('\n').filter((l) => /^line \d+ /.test(l)).length;
    eq(Number(m[1]), 600 - keptLines, 'the line count is the number of lines really removed');
    const trueChars = src.length - capped.split('\n').filter((l) => /^line \d+ /.test(l)).join('\n').length - 1;
    assert(Math.abs(Number(m[2]) - trueChars) <= 2, `the char count matches what is missing: said ${m[2]}, really ${trueChars}`);
    assert(!/bytes elided/.test(capped), 'and it does not call code units bytes');
  }
  // sliced by code point, so a surrogate pair is never split
  const wide = boundedText('\u{1F600}'.repeat(3000), { maxLines: 10, maxBytes: 100 });
  // isWellFormed is the real check: a lone surrogate is not U+FFFD, so the old assertion
  // passed on malformed output (checker mutation).
  assert(wide.isWellFormed(), 'no lone surrogate — the slice respects code points');
  for (const n of [1, 2, 5, 37, 120]) {
    assert(boundedText('\u{1F600}'.repeat(500), { maxLines: 4, maxBytes: n }).isWellFormed(), `well-formed at maxBytes ${n}`);
  }
  // the byte tail must also be clamped — removing that clamp survived before
  const tinyBytes = boundedText('x'.repeat(5000), { maxLines: 9999, maxBytes: 20 });
  assert([...tinyBytes].length <= 20 + 80, `a small byte cap stays small: ${[...tinyBytes].length}`);
  // and the tail can never outgrow the cap it enforces
  const tiny = boundedText(Array.from({ length: 300 }, (_, i) => `L${i}`).join('\n'), { maxLines: 6, maxBytes: 9999 });
  assert(tiny.split('\n').length <= 8, `a small cap stays small: ${tiny.split('\n').length} lines`);
});

// ── abort: a Stop signal ends the loop cooperatively ──
await test('an already-aborted signal stops before the first inference', async () => {
  const ac = new AbortController();
  ac.abort();
  let inferCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [], infer: async () => { inferCalls++; return { content: 'hi', toolCalls: [] }; },
    executeTool: async () => 'ok', signal: ac.signal,
  });
  eq(result.stop, 'aborted', 'stop reason is aborted');
  eq(inferCalls, 0, 'never called infer once already aborted');
});
await test('aborting mid-run stops at the next turn boundary', async () => {
  const ac = new AbortController();
  let inferCalls = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [{ type: 'function', function: { name: 'noop', parameters: {} } }],
    infer: async () => { inferCalls++; if (inferCalls === 1) return { content: 'working', toolCalls: [call('noop', {}, 't1')] }; return { content: 'more', toolCalls: [call('noop', {}, 't2')] }; },
    executeTool: async () => { ac.abort(); return 'did work'; }, // abort during the first tool
    signal: ac.signal, maxSteps: 10,
  });
  eq(result.stop, 'aborted', 'stopped after the aborting turn');
  assert(inferCalls <= 2, 'did not keep looping after abort');
});

// ─────────────────────────── usage-anchored token accounting (F6) ──

await test('usageInputTokens reads both provider shapes, and never double-counts the cache (F6)', () => {
  // Anthropic: input_tokens EXCLUDES the cache, so the three add up
  eq(usageInputTokens({ input_tokens: 100, cache_read_input_tokens: 900, cache_creation_input_tokens: 50 }), 1050, 'anthropic sums');
  eq(usageInputTokens({ input_tokens: 100 }), 100, 'anthropic without cache fields');
  // OpenAI: prompt_tokens INCLUDES the cached part — adding cached_tokens would double it
  eq(usageInputTokens({ prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 } }), 1000, 'openai does not add its cached subset');
  eq(usageOutputTokens({ output_tokens: 12 }), 12, 'anthropic output');
  eq(usageOutputTokens({ completion_tokens: 12 }), 12, 'openai output');
  // absent / malformed → null, so the caller falls back to the estimate instead of anchoring on 0
  for (const bad of [null, undefined, {}, { input_tokens: -1 }, { prompt_tokens: 'lots' }, 'usage']) {
    eq(usageInputTokens(bad), null, `no usable count: ${JSON.stringify(bad)}`);
  }
  eq(usageOutputTokens({}), null, 'no output count');
});

await test('the token budget trips on the PROVIDER count, not chars/4 (F6)', async () => {
  // A short transcript the estimator scores at ~10 tokens, which the provider says cost 5000
  // (a big system prompt and tool schemas the estimator never sees). Anchored, the budget trips.
  const events = [];
  const withUsage = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'thinking', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { input_tokens: 5000, output_tokens: 10 } }),
    executeTool: async () => 'ok',
    onEvent: (e) => events.push(e),
    budget: { tokens: 1000 },
    maxSteps: 6,
  });
  eq(withUsage.stop, 'budget', 'the run stopped on the budget');
  eq(withUsage.budgetAxis, 'tokens', 'on the tokens axis');
  assert(withUsage.steps <= 2, `it stopped as soon as the provider count was known: ${withUsage.steps} steps`);
  const u = events.find((e) => e.type === 'usage');
  assert(u && u.input === 5000, `the anchor is surfaced: ${JSON.stringify(u)}`);

  // the CONTROL: the identical run with no usage reported never trips — proving the stop
  // came from the provider's number and not from the transcript's size
  const noUsage = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'thinking', toolCalls: [call('shell', { command: 'pwd' }, 'u')] }),
    executeTool: async () => 'ok',
    budget: { tokens: 1000 },
    maxSteps: 6,
  });
  assert(noUsage.stop !== 'budget', `without usage the same run does not trip: ${noUsage.stop}`);
});

await test('the anchor counts only the delta since the reported request (F6)', async () => {
  // provider says 400; the loop then appends a large tool result. The count must be
  // 400 + (the tail), not 400 alone and not the whole transcript re-estimated.
  const big = 'y'.repeat(4000); // ~1000 estimated tokens
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { prompt_tokens: 400 } }),
    executeTool: async () => big,
    budget: { tokens: 1200 },   // 400 anchor + ~1000 tail trips; 400 alone would not
    maxSteps: 6,
  });
  eq(r.stop, 'budget', `the tail is counted on top of the anchor: ${r.stop}`);
  eq(r.budgetAxis, 'tokens', 'tokens axis');
  // and the anchor does not double the prefix: a generous budget survives its steps
  const survives = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { prompt_tokens: 400 } }),
    executeTool: async () => big,
    budget: { tokens: 100000 },
    maxSteps: 3,
  });
  eq(survives.stop, 'max-steps', `a generous budget is not tripped by re-counting the prefix: ${survives.stop}`);
});

// ─────────────────────────────── spill at produce-time (F5) ──

await test('spillToolOutput caps at produce time, reserving the notice inside the cap (F5)', () => {
  const body = 'HEADMARK' + 'z'.repeat(50000) + 'TAILMARK';
  const r = spillToolOutput(body, { name: 'shell', cap: 2000 });
  assert(r.spilled, 'an oversized result is spilled');
  eq(r.chars, body.length, 'it reports the original size');
  assert(r.sent.length <= 2000, `the replacement fits INSIDE the cap it enforces: ${r.sent.length} > 2000`);
  assert(r.sent.startsWith('HEADMARK'), 'the head survives');
  assert(r.sent.endsWith('TAILMARK'), 'the tail survives');
  assert(/history/.test(r.sent), `the locator names a tool that can actually retrieve it: ${r.sent.slice(0, 300)}`);
  assert(/shell/.test(r.sent), 'and names the call it came from');
  assert(/\d+ chars elided/.test(r.sent), 'it is honest about how much it dropped');
  // under the cap nothing happens at all — byte-identical, not merely similar
  const small = 'x'.repeat(100);
  const u = spillToolOutput(small, { cap: 2000 });
  eq(u.sent, small, 'a small result passes through unchanged');
  eq(u.spilled, false, 'and is not marked spilled');
  eq(spillToolOutput('x'.repeat(2000), { cap: 2000 }).spilled, false, 'exactly at the cap is not spilled');
  eq(spillToolOutput('x'.repeat(2001), { cap: 2000 }).spilled, true, 'one over is');
  // a cap of 0 / nonsense disables it rather than eliding everything
  eq(spillToolOutput(body, { cap: 0 }).spilled, false, 'cap 0 disables the spill');
  eq(spillToolOutput(null, { cap: 10 }).sent, '', 'a null result is a string, not a crash');
});

await test('an oversized result never enters the transcript, and the record keeps the whole thing (F5)', async () => {
  const huge = 'START' + 'q'.repeat(30000) + 'END';
  const events = [];
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('shell', { command: 'cat big' }, 'b')] }, { content: 'done', toolCalls: [] }]),
    executeTool: async () => huge,
    onEvent: (e) => events.push(e),
    toolOutputCap: 1000,
    maxSteps: 3,
  });
  const toolMsg = r.messages.find((m) => m.role === 'tool');
  assert(toolMsg.content.length <= 1000, `the surface carried ${toolMsg.content.length} chars past a 1000 cap`);
  assert(!toolMsg.content.includes('q'.repeat(2000)), 'the bulk never reached the transcript');
  // the FULL text is still reported to the recorder, so history can serve it
  const full = events.find((e) => e.type === 'tool-result');
  eq(full.result, huge, 'the recorder was given the complete result');
  const spill = events.find((e) => e.type === 'tool-spilled');
  assert(spill && spill.chars === huge.length, `the spill is announced with its true size: ${JSON.stringify(spill && spill.chars)}`);
});

await test('a recorder that REFUSES the spill leaves the original inline — a success is not turned into a loss (F5)', async () => {
  const huge = 'START' + 'q'.repeat(30000) + 'END';
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('shell', { command: 'cat big' }, 'b')] }, { content: 'done', toolCalls: [] }]),
    executeTool: async () => huge,
    // the storage seam fails exactly for the spill, and only for it
    onEvent: (e) => { if (e.type === 'tool-spilled') throw new Error('record unavailable'); },
    toolOutputCap: 1000,
    maxSteps: 3,
  });
  const toolMsg = r.messages.find((m) => m.role === 'tool');
  eq(toolMsg.content, huge, 'the whole result stayed inline because the elision had nowhere to point');
  eq(r.stop, 'done', 'and the run finished normally rather than erroring');
});

// ── the survivors of a cross-family mutation pass (F6/F7/F5) ──

await test('the repeat chain nudges again after an owner interjection resets it (F7)', async () => {
  const events = [];
  let n = 0;
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async ({ messages }) => {
      n++;
      // the owner speaks once, after the chain has already nudged at 3
      if (n === 4) messages.push({ role: 'user', content: 'try it another way' });
      return { content: '', toolCalls: [call('shell', { command: 'pwd' }, 'r')] };
    },
    executeTool: async () => 'ok',
    onEvent: (e) => events.push(e),
    maxSteps: 8,
  });
  const times = events.filter((e) => e.type === 'repeat-nudge').map((e) => e.times);
  // 3 before the interjection; the chain restarts and reaches 3 again by step 7
  deepEq(times, [3, 3, 5], `the nudge is silenced after a reset: ${JSON.stringify(times)}`);
  eq(times.filter((t) => t === 3).length, 2, 'the count 3 is reached twice — once per chain — and nudged both times');
});

await test('the canonical signature is DEEP — a nested key reorder is still the same call (F7)', () => {
  const a = [{ function: { name: 'write', arguments: JSON.stringify({ opts: { b: 2, a: 1 }, path: 'p' }) } }];
  const b = [{ function: { name: 'write', arguments: JSON.stringify({ path: 'p', opts: { a: 1, b: 2 } }) } }];
  eq(stepSignature(a), stepSignature(b), 'a reorder nested inside an object is not progress');
  // and a genuinely different nested VALUE is still a different call
  const c = [{ function: { name: 'write', arguments: JSON.stringify({ path: 'p', opts: { a: 9, b: 2 } }) } }];
  assert(stepSignature(a) !== stepSignature(c), 'a changed nested value is a different call');
  // arrays keep their order — [1,2] is not [2,1]
  const d = [{ function: { name: 'write', arguments: JSON.stringify({ xs: [1, 2] }) } }];
  const e = [{ function: { name: 'write', arguments: JSON.stringify({ xs: [2, 1] }) } }];
  assert(stepSignature(d) !== stepSignature(e), 'array order is meaningful and is preserved');
});

await test('the anchor REPLACES the prefix estimate, it does not add to it (F6)', async () => {
  // A large opening message the estimator scores high and the provider scores low. Counting
  // `anchor.input + estimate(whole convo)` re-counts that prefix on top of the provider's own
  // number. The budget below sits BETWEEN the two readings, so only the wrong one trips.
  const bigOpen = 'w '.repeat(20000);
  const opening = [{ role: 'user', content: bigOpen }];
  const est = estimateTokens(opening);
  assert(est > 5000, `the opening is estimator-heavy on purpose: ${est}`);
  const budget = { tokens: est + 200 };   // above the pre-anchor estimate, below est + 400
  const r = await runAgentLoop({
    messages: opening,
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { prompt_tokens: 400 } }),
    executeTool: async () => 'ok',
    budget,
    maxSteps: 3,
  });
  eq(r.stop, 'max-steps',
    `once anchored the count is 400 + the tail, not ${est} + 400: stopped ${r.stop}/${r.budgetAxis} after ${r.steps}`);
  // and the budget still trips when the PROVIDER's number is genuinely over it
  const over = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { prompt_tokens: 5000 } }),
    executeTool: async () => 'ok',
    budget: { tokens: 1000 },
    maxSteps: 3,
  });
  eq(over.stop, 'budget', 'a budget under the provider count still trips');
});

await test('the anchor MOVES to the latest reported request (F6)', async () => {
  // Anchoring only once leaves every later turn measured as a delta from the first request —
  // the count drifts further from the truth with every turn, silently.
  const events = [];
  let turn = 0;
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: '', toolCalls: [call('shell', { command: 'pwd' }, 'u')], usage: { prompt_tokens: 100 * (++turn) } }),
    executeTool: async () => 'ok',
    onEvent: (e) => events.push(e),
    maxSteps: 3,
  });
  const anchors = events.filter((e) => e.type === 'usage');
  eq(anchors.length, 3, `every reported request re-anchors: ${anchors.length}`);
  deepEq(anchors.map((a) => a.input), [100, 200, 300], 'the anchor follows the latest count');
  const ats = anchors.map((a) => a.at);
  assert(ats[1] > ats[0] && ats[2] > ats[1], `the anchor position moves forward: ${JSON.stringify(ats)}`);
  deepEq(anchors.map((a) => a.output), [null, null, null], 'no output count was reported, and none is invented');
});

await test('the usage event carries the OUTPUT count when the provider gives one (F6)', async () => {
  const events = [];
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }],
    tools: [shellTool()],
    infer: async () => ({ content: 'done', toolCalls: [], usage: { input_tokens: 50, output_tokens: 17 } }),
    executeTool: async () => 'ok',
    onEvent: (e) => events.push(e),
    maxSteps: 2,
  });
  const u = events.find((e) => e.type === 'usage');
  eq(u.input, 50, 'input');
  eq(u.output, 17, 'the completion count is reported, not dropped');
});

await test('the spill notice states the TRUE elided count (F5)', () => {
  const body = 'x'.repeat(9000);
  const r = spillToolOutput(body, { name: 'shell', cap: 1200 });
  const m = r.sent.match(/\((\d+) chars elided/);
  assert(m, `the notice names a count: ${r.sent.slice(0, 200)}`);
  const elided = Number(m[1]);
  const kept = r.sent.length - (r.sent.length - r.sent.indexOf('…')); // not exact; check by reconstruction
  eq(elided, body.length - (r.sent.split('\n… (')[0].length + r.sent.split(') …\n')[1].length),
    `the count must be head+tail subtracted from the original, not a placeholder: said ${elided}`);
  assert(elided > 0, 'and it is not zero for a result that really was elided');
});

// ── F9 (N4): parallel dispatch within a step ───────────────────────────────
// A timed executor: every call records when it started and finished; reads take a set time,
// writes too. Concurrency is visible in the overlap, order in the events and the transcript.
function timedExecutor({ readMs = 40, writeMs = 40, log }) {
  return async (name, args) => {
    const t0 = Date.now();
    log.push({ name, path: args.path, start: t0 });
    await new Promise((r) => setTimeout(r, name === 'read' ? readMs : writeMs));
    const row = log.find((x) => x.name === name && x.path === args.path && x.end == null);
    row.end = Date.now();
    return `${name} ${args.path} ok`;
  };
}
const parallelDefault = (n) => DEFAULT_TOOL_CONCURRENCY[n] === 'parallel';
const READ_TOOLS = [{ type: 'function', function: { name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } } },
  { type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' } } } } }];

await test('F9: four reads in one step run concurrently — all four are running before any has finished', async () => {
  // deterministic: each read is held open until the test releases it, so "all four started while
  // none finished" is a fact, not a wall-clock race
  const holds = new Map(); const startedPaths = [];
  const exec = (n, a) => new Promise((res) => { startedPaths.push(a.path); holds.set(a.path, () => res('read ' + a.path)); });
  const run = runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: ['a', 'b', 'c', 'd'].map((p, i) => call('read', { path: p }, 'c' + i)) }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, maxSteps: 3,
  });
  await new Promise((res) => setTimeout(res, 0));
  eq(startedPaths.join(' '), 'a b c d', 'all four started before any finished — a serial loop would have started only a');
  for (const p of ['d', 'c', 'b', 'a']) holds.get(p)();
  const r = await run;
  eq(r.stop, 'done');
  eq(r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id).join(' '), 'c0 c1 c2 c3', 'released in reverse, recorded in request order');
});

await test('F9: the recorded order is the request order, deterministic, whatever order the reads finish in', async () => {
  const ev = [];
  const log = [];
  // the SECOND read (a member started ahead, not the inline first one) is the slowest: a
  // completion-ordered emitter, or an ahead slot paired with whichever settles first, would
  // put its result after the third's (a checker's mutant did exactly that when index 0 was slow)
  const exec = async (name, args) => { const ms = args.path === 'slow' ? 80 : 5; log.push(args.path); await new Promise((r) => setTimeout(r, ms)); return 'read ' + args.path; };
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'first' }, 'c0'), call('read', { path: 'slow' }, 'c1'), call('read', { path: 'fast' }, 'c2')] }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, onEvent: (e) => ev.push(e), maxSteps: 3,
  });
  const seq = ev.filter((e) => e.type === 'tool-call' || e.type === 'tool-result').map((e) => e.type[5] + ':' + e.id);
  eq(seq.join(' '), 'c:c0 r:c0 c:c1 r:c1 c:c2 r:c2', 'tool-call then tool-result, per call, in request order — the serial shape');
  const tools = r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id + '=' + m.content);
  eq(tools.join(' '), 'c0=read first c1=read slow c2=read fast', 'the transcript pairs each result with its call, in request order — the slow ahead member is not swapped with the fast one');
  eq(log.join(' '), 'first slow fast', 'and they were all started, in request order');
});

await test('F9: a write in the same step waits for the reads before it; reads after it wait for the write', async () => {
  const log = [];
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0'), call('read', { path: 'b' }, 'c1'), call('write', { path: 'c' }, 'c2'), call('read', { path: 'd' }, 'c3'), call('read', { path: 'e' }, 'c4')] }, { content: 'done', toolCalls: [] }]),
    executeTool: timedExecutor({ readMs: 30, writeMs: 30, log }), maxSteps: 3,
  });
  eq(r.stop, 'done');
  const by = Object.fromEntries(log.map((x) => [x.path, x]));
  assert(by.b.start < by.a.end, 'a and b overlapped (a batch)');
  assert(by.c.start >= Math.max(by.a.end, by.b.end), `the write started at ${by.c.start} — after both reads ended (${by.a.end}, ${by.b.end})`);
  assert(by.d.start >= by.c.end && by.e.start >= by.c.end, 'the reads after the write waited for it');
  assert(by.e.start < by.d.end, 'and those two reads overlapped with each other');
  const tools = r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
  eq(tools.join(' '), 'c0 c1 c2 c3 c4', 'transcript order is request order');
});

await test('F9: the declaration is per tool and overridable; unknown names are exclusive; a batch member that throws fails alone', async () => {
  const log = [];
  // an unknown name (not in the map) is exclusive even between parallel reads
  const r0 = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0'), call('mystery', { path: 'm' }, 'c1'), call('read', { path: 'b' }, 'c2')] }, { content: 'done', toolCalls: [] }]),
    executeTool: timedExecutor({ readMs: 30, writeMs: 30, log }), maxSteps: 3,
  });
  eq(r0.stop, 'done');
  const by0 = Object.fromEntries(log.map((x) => [x.path, x]));
  assert(by0.m.start >= by0.a.end && by0.b.start >= by0.m.end, 'an unknown tool ran alone, between the reads');
  assert(!Object.hasOwn(DEFAULT_TOOL_CONCURRENCY, 'mystery') && !parallelDefault('write') && !parallelDefault('shell') && !parallelDefault('read_lines') && !parallelDefault('skill') && !parallelDefault('context_remaining') && !parallelDefault('recall'), 'the default set is read + history only — the rest touch state');
  log.length = 0;
  // default: read is parallel, write exclusive. Override: make write parallel too and read exclusive.
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('write', { path: 'x' }, 'c0'), call('write', { path: 'y' }, 'c1'), call('read', { path: 'z' }, 'c2'), call('read', { path: 'w' }, 'c3')] }, { content: 'done', toolCalls: [] }]),
    executeTool: timedExecutor({ readMs: 30, writeMs: 30, log }), maxSteps: 3,
    concurrency: { write: 'parallel', read: 'exclusive' },
  });
  eq(r.stop, 'done');
  const by = Object.fromEntries(log.map((x) => [x.path, x]));
  assert(by.y.start < by.x.end, 'with the override the two writes overlapped');
  // an INHERITED 'parallel' does not count: only the map's own entries declare
  log.length = 0;
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('write', { path: 'x2' }, 'c0'), call('write', { path: 'y2' }, 'c1')] }, { content: 'done', toolCalls: [] }]),
    executeTool: timedExecutor({ readMs: 30, writeMs: 30, log }), maxSteps: 3,
    concurrency: Object.create({ write: 'parallel' }),
  });
  const byI = Object.fromEntries(log.map((x) => [x.path, x]));
  assert(byI.y2.start >= byI.x2.end, 'an inherited declaration is ignored — the writes ran in series');
  assert(by.w.start >= by.z.end, 'and the two reads ran one after another');
  // a throwing batch member: its own result is the error, its neighbours are untouched
  const ev = [];
  const r2 = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'ok1' }, 'c0'), call('read', { path: 'boom' }, 'c1'), call('read', { path: 'ok2' }, 'c2')] }, { content: 'done', toolCalls: [] }]),
    executeTool: async (n, a) => { await new Promise((r) => setTimeout(r, 5)); if (a.path === 'boom') throw new Error('disk on fire'); return 'read ' + a.path; },
    onEvent: (e) => ev.push(e), maxSteps: 3,
  });
  const tools = r2.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id + '=' + m.content);
  eq(tools.join(' | '), 'c0=read ok1 | c1=Error: disk on fire | c2=read ok2', 'the throw is that call\'s result; the others completed');
  const errs = ev.filter((e) => e.type === 'tool-error');
  eq(errs.length, 1); eq(errs[0].id, 'c1'); eq(errs[0].kind, 'execution_error');
  const seq = ev.filter((e) => /^tool-(call|result|error)$/.test(e.type)).map((e) => e.type.slice(5, 6) + ':' + e.id).join(' ');
  eq(seq, 'c:c0 r:c0 c:c1 e:c1 r:c1 c:c2 r:c2', 'the error sits between its own call and result, in request order');
});

await test('F9: clarify and task_done are never batched with reads', async () => {
  const log = [];
  // clarify pauses the run: the read after it must not have been started
  const r0 = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [...READ_TOOLS, clarifyTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0'), call('clarify', { question: 'which one?' }, 'c1'), call('read', { path: 'b' }, 'c2')] }]),
    executeTool: timedExecutor({ readMs: 20, log }), maxSteps: 3,
  });
  eq(r0.stop, 'clarify');
  eq(log.map((x) => x.path).join(' '), 'a', 'the read after clarify never started');
  log.length = 0;
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [...READ_TOOLS, taskDoneTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0'), call('task_done', { summary: 'wrote the thing carefully' }, 'c1'), call('read', { path: 'b' }, 'c2')] }]),
    executeTool: timedExecutor({ readMs: 20, log }), maxSteps: 3,
  });
  eq(r.stop, 'done', 'task_done without a gate accepts');
  eq(log.map((x) => x.path).join(' '), 'a b', 'both reads ran, task_done handled by the loop between them');
  assert(log[1].start >= log[0].end, 'the read after task_done was not started with the read before it');
});

await test('F9: the pool is rolling — at most maxParallel running, started in request order, refilled when a member SETTLES', async () => {
  // deterministic: every member is held until the test releases it; no wall clock
  const holds = new Map(); const startedPaths = [];
  const exec = (n, a) => new Promise((res) => { startedPaths.push(a.path); holds.set(a.path, () => res('read ' + a.path)); });
  let done = null;
  const run = runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: Array.from({ length: 6 }, (_, i) => call('read', { path: 'p' + i }, 'c' + i)) }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, maxSteps: 3, maxParallel: 3,
  }).then((r) => { done = r; return r; });
  const tick = () => new Promise((res) => setTimeout(res, 0));
  await tick();
  eq(startedPaths.join(' '), 'p0 p1 p2', 'three started, in request order, and no more (the cap)');
  holds.get('p1')(); await tick(); await tick();
  eq(startedPaths.join(' '), 'p0 p1 p2 p3', 'p1 settled → p3 started, although p0 (the front) is still running — refill is on settlement, not consumption');
  holds.get('p2')(); await tick(); await tick();
  eq(startedPaths.join(' '), 'p0 p1 p2 p3 p4', 'p2 settled → p4 started');
  holds.get('p0')(); await tick(); await tick();
  eq(startedPaths.join(' '), 'p0 p1 p2 p3 p4 p5', 'p0 settled → p5 started; never more than three running');
  holds.get('p3')(); holds.get('p4')(); holds.get('p5')();
  const r = await run;
  eq(r.stop, 'done');
  eq(r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id + '=' + m.content).join(' '), 'c0=read p0 c1=read p1 c2=read p2 c3=read p3 c4=read p4 c5=read p5', 'transcript order is request order whatever the settlement order');
  assert(done !== null);
});

await test('F9: a stop raised inside the first executor starts nothing else', async () => {
  const ac = new AbortController();
  const ev = [];
  const log = [];
  const exec = async (n, a) => { log.push('start:' + a.path); if (a.path === 'a') ac.abort(); await new Promise((r) => setTimeout(r, 20)); return 'read ' + a.path; };
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS, signal: ac.signal,
    infer: scriptedInfer([{ content: '', toolCalls: Array.from({ length: 6 }, (_, i) => call('read', { path: String.fromCharCode(97 + i) }, 'c' + i)) }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, onEvent: (e) => ev.push(e), maxSteps: 3, maxParallel: 3,
  });
  eq(r.stop, 'aborted');
  eq(log.join(' '), 'start:a', 'the signal is checked before each launch — b was never started');
  eq(ev.filter((e) => e.type === 'tool-result').map((e) => e.id).join(' '), 'c0', 'a ran (its tool-call was out) and is recorded');
});

await test('F9: a stop while three members are running drains them — recorded, not force-killed — and starts nothing new', async () => {
  const ac = new AbortController();
  const ev = [];
  const log = [];
  let entered = 0; let release; const gate = new Promise((res) => { release = res; });
  const exec = async (n, a) => { log.push('start:' + a.path); if (++entered === 3) { ac.abort(); release(); } await gate; await new Promise((r) => setTimeout(r, 5)); log.push('end:' + a.path); return 'read ' + a.path; };
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS, signal: ac.signal,
    infer: scriptedInfer([{ content: '', toolCalls: Array.from({ length: 6 }, (_, i) => call('read', { path: String.fromCharCode(97 + i) }, 'c' + i)) }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, onEvent: (e) => ev.push(e), maxSteps: 3, maxParallel: 3,
  });
  eq(r.stop, 'aborted');
  eq(ev.filter((e) => e.type === 'tool-result').map((e) => e.id).join(' '), 'c0 c1 c2', 'the three members running at the stop were drained and recorded');
  assert(!log.includes('start:d'), 'nothing after the stop was started');
  eq(r.messages.filter((m) => m.role === 'tool').length, 3, 'their results are in the transcript');
  const n = ev.length;
  await new Promise((res) => setTimeout(res, 40));
  eq(ev.length, n, 'no event arrives after the loop returned');
});

await test('F9: an exclusive call\'s synchronous throw is reported in the same tick, as before', async () => {
  const order = [];
  const exec = (n) => { queueMicrotask(() => order.push('microtask')); throw new Error('sync boom'); };
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('write', { path: 'x' }, 'c0')] }, { content: 'done', toolCalls: [] }]),
    executeTool: exec, onEvent: (e) => { if (e.type === 'tool-error' || e.type === 'tool-result') order.push(e.type); }, maxSteps: 3,
  });
  eq(r.stop, 'done');
  eq(order.join(' '), 'tool-error tool-result microtask', 'error and result are emitted before a microtask scheduled by the throw runs');
});

await test('F9: a synchronous executor returning null records null, as the serial loop did', async () => {
  const ev = [];
  await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0')] }, { content: 'done', toolCalls: [] }]),
    executeTool: () => null, onEvent: (e) => ev.push(e), maxSteps: 3,
  });
  const res = ev.find((e) => e.type === 'tool-result');
  assert(res && res.result === null, `result is null, not undefined: ${JSON.stringify(res)}`);
});

await test('F9: a single parallel-class call keeps the serial shape — tool-call before the executor runs', async () => {
  const order = [];
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: READ_TOOLS,
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0')] }, { content: 'done', toolCalls: [] }]),
    executeTool: async () => { order.push('execute'); return 'x'; }, onEvent: (e) => { if (/^tool-/.test(e.type)) order.push(e.type); }, maxSteps: 3,
  });
  eq(r.stop, 'done');
  eq(order.join(' '), 'tool-call execute tool-result');
});

await test('F9: a call whose arguments do not parse is never started, and a loop-owned call is never batched even if declared parallel', async () => {
  const seen = [];
  const bad = { id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path": "b"' } }; // cut off mid-JSON
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'go' }], tools: [...READ_TOOLS, taskDoneTool()],
    infer: scriptedInfer([{ content: '', toolCalls: [call('read', { path: 'a' }, 'c0'), bad, call('read', { path: 'c' }, 'c2'), call('task_done', { summary: 'wrote the thing carefully' }, 'c3'), call('read', { path: 'd' }, 'c4')] }]),
    executeTool: async (n, a) => { seen.push(n + ':' + (a && a.path)); return 'ok'; }, maxSteps: 3,
    concurrency: { read: 'parallel', task_done: 'parallel' }, // a caller cannot make the loop's own call executable
  });
  eq(r.stop, 'done');
  eq(seen.join(' '), 'read:a read:c read:d', 'the unparseable call and task_done never reached the executor');
  const tools = r.messages.filter((m) => m.role === 'tool').map((m) => m.tool_call_id + '=' + m.content.slice(0, 24));
  eq(tools.join(' | '), 'c0=ok | c1=Error: could not parse a | c2=ok | c3=Task accepted (no verifi | c4=ok', 'every call answered, in request order');
});

if (failures.length) {
  console.error(`agent-loop: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/agent-loop conformance: ${passed}/${passed} passed`);
