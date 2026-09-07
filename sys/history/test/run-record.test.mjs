// Conformance — the run record: the log is the agent.
//   node sys/history/test/run-record.test.mjs
//
// A real runAgentLoop over a real Rig shell is RECORDED; then everything Anvil
// keeps about a run is derived from the record, and the run is REPLAYED with
// zero model calls. Strict replay must name the first divergent event.
import { runAgentLoop, shellTool, makeShellExecutor } from '../../ai/agent-loop.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';
import { verifyChain } from '../ledger.mjs';
import { RUN_EVENTS, createRunRecorder, loadRecord, foldStatus, foldLog, foldTranscript,
         replayInfer, replayExecuteTool, compareRuns, requestHash, ReplayMiss,
         OUTCOME_SIGNALS, foldOutcome, foldReuse, foldStopReasons, stopReasonsLine,
         searchRecords, scopeEntries, readEvent, historyTool, HISTORY_ROLES, foldRecovery, recoveryNote,
         foldStagnation, stagnationNudge, foldSessionContext, foldDecisions,
         foldSurface, compactionOrphaned, reconstructionCheck } from '../run-record.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function deepEq(a, b, m) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

function freshShell() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return createShell({ registry, face });
}
const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const scripted = (turns) => { let i = 0; return async () => turns[i++] || { content: 'done', toolCalls: [] }; };
const SCRIPT = () => [
  { content: '', toolCalls: [call('shell', { command: 'mkdir -p src' }, 'c0')] },
  { content: '', toolCalls: [call('shell', { command: 'echo hi > src/a.txt' }, 'c1')] },
  { content: '', toolCalls: [call('shell', { command: 'cat src/a.txt' }, 'c2')] },
  { content: 'Done — src/a.txt contains "hi".', toolCalls: [] },
];
const MESSAGES = [{ role: 'system', content: 'You are a coding agent with a shell.' }, { role: 'user', content: 'Create src/a.txt containing hi and show it.' }];

// Record one real run. Returns { rec, result, shell }.
async function recordRun({ verify = null, infer = scripted(SCRIPT()), now } = {}) {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test', now });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec.wrapInfer(infer), executeTool: makeShellExecutor(shell),
    onEvent: rec.onEvent, verify,
  });
  await rec.finish(result);
  await rec.settled();
  return { rec, result, shell };
}

await test('a real run is recorded as a verifiable chain using only the fixed verbs', async () => {
  const { rec, result } = await recordRun();
  eq(result.stop, 'done', 'the loop finished');
  const ev = rec.events();
  const v = await verifyChain(ev);
  eq(v.ok, true, `chain verifies (broke at ${v.brokenAt})`);
  for (const e of ev) assert(RUN_EVENTS.includes(e.tool), `unknown verb in record: ${e.tool}`);
  eq(ev[0].tool, 'run.started', 'opens with run.started');
  eq(ev[ev.length - 1].tool, 'run.stopped', 'closes with run.stopped');
  eq(ev.filter((e) => e.tool === 'llm.responded').length, 4, 'four model exchanges');
  eq(ev.filter((e) => e.tool === 'tool.called').length, 3, 'three tool calls');
  eq(ev.filter((e) => e.tool === 'tool.responded').length, 3, 'three tool results');
  // Every payload is reachable through the resolver — the chain holds hashes only.
  for (const e of ev) { const r = rec.resolve(e); assert(r.input !== undefined && r.output !== undefined, `payloads resolve for ${e.tool}`); }
  assert(!JSON.stringify(ev).includes('mkdir -p src'), 'the CHAIN carries no payload text, only hashes');
});

await test('status is a fold: an ungated done is unclaimed; a gated verified done is done', async () => {
  const ungated = await recordRun();
  const s1 = foldStatus(ungated.rec.events(), ungated.rec.resolve, { gated: false });
  eq(s1.phase, 'stopped', 'stopped'); eq(s1.stop, 'done', 'stop'); eq(s1.status, 'unclaimed', 'no gate → the agent\'s own claim');
  eq(s1.steps, 4, 'steps derived from turn.started');

  const gated = await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  eq(gated.result.verified, true, 'the gate passed');
  const s2 = foldStatus(gated.rec.events(), gated.rec.resolve, { gated: true });
  eq(s2.status, 'done', 'gate ∧ verified → done');
  assert(gated.rec.events().some((e) => e.tool === 'verify.passed'), 'the pass is in the record');
});

await test('the log pane is a fold: same rows renderLog draws, tool calls paired with results', async () => {
  const { rec } = await recordRun();
  const rows = foldLog(rec.events(), rec.resolve);
  eq(rows[0].k, 'user', 'opens with the prompt');
  const tools = rows.filter((r) => r.k === 'tool');
  eq(tools.length, 3, 'three tool rows');
  eq(tools[2].detail, 'cat src/a.txt', 'detail is the command');
  eq(tools[2].result, 'hi', 'the real shell output rode the record');
  assert(rows.some((r) => r.k === 'assistant' && /contains "hi"/.test(r.text)), 'assistant prose present');
  eq(rows[rows.length - 1].text, 'agent done · 4 steps', 'closing system row from run.stopped');
});

await test('the transcript is a fold: no system prefix, every tool reply paired with its call', async () => {
  const { rec } = await recordRun();
  const t = foldTranscript(rec.events(), rec.resolve);
  eq(t[0].role, 'user', 'starts after the system prefix');
  assert(!t.some((m) => m.role === 'system'), 'no system message carried');
  const offered = new Set();
  for (const m of t) {
    if (Array.isArray(m.tool_calls)) for (const c of m.tool_calls) offered.add(c.id);
    if (m.role === 'tool') assert(offered.has(m.tool_call_id), `orphan tool reply ${m.tool_call_id}`);
  }
  eq(t.filter((m) => m.role === 'tool').length, 3, 'three tool replies');
  eq(t[t.length - 1].role, 'assistant', 'ends on the final prose');
});

await test('REPLAY: the run re-executes with ZERO model calls and reproduces the record exactly', async () => {
  const { rec } = await recordRun();
  let liveCalls = 0;
  const shell = freshShell();
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec2.wrapInfer(replayInfer(rec, { strict: true, live: async () => { liveCalls++; return { content: 'x', toolCalls: [] }; } })),
    executeTool: makeShellExecutor(shell), // tools run LIVE against a fresh workspace
    onEvent: rec2.onEvent,
  });
  await rec2.finish(result); await rec2.settled();
  eq(liveCalls, 0, 'no live model call was made');
  eq(result.stop, 'done', 'replayed run finished');
  const cmp = compareRuns(rec, rec2);
  eq(cmp.ok, true, `strict replay is green (diverged at ${cmp.at}: ${cmp.why})`);
  eq((await shell.feed('cat src/a.txt')).output, 'hi', 'and the replayed run rebuilt the workspace for real');
});

await test('REPLAY with recorded tools too: no side effects, still green', async () => {
  const { rec } = await recordRun();
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({
    messages: MESSAGES, tools: [shellTool()],
    infer: rec2.wrapInfer(replayInfer(rec)), executeTool: replayExecuteTool(rec),
    onEvent: rec2.onEvent,
  });
  await rec2.finish(result); await rec2.settled();
  eq(compareRuns(rec, rec2).ok, true, 'fully recorded replay is green');
});

await test('STRICT replay names the FIRST divergent event when the world changed', async () => {
  const { rec } = await recordRun();
  // A live tool that answers differently to the third call — the world moved.
  const shell = freshShell();
  const liveExec = makeShellExecutor(shell);
  const exec = async (name, args, c) => (args?.command === 'cat src/a.txt' ? 'DIFFERENT' : liveExec(name, args, c));
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  let miss = null;
  try {
    const result = await runAgentLoop({
      messages: MESSAGES, tools: [shellTool()],
      infer: rec2.wrapInfer(replayInfer(rec, { strict: true })), executeTool: exec, onEvent: rec2.onEvent,
    });
    await rec2.finish(result);
  } catch (e) { miss = e; }
  await rec2.settled();
  // The divergence surfaces two ways, both correct: the changed tool output is a
  // different event, and the NEXT model request (which embeds that output) is a
  // request the record never saw.
  const cmp = compareRuns(rec, rec2);
  eq(cmp.ok, false, 'red');
  const divergedVerb = rec.events()[cmp.at].tool;
  eq(divergedVerb, 'tool.responded', `first divergence is the changed tool result, not something later (got ${divergedVerb} at ${cmp.at})`);
  assert(/output of tool\.responded differs/.test(cmp.why), cmp.why);
  // And the loop itself was stopped by a ReplayMiss on the unseen request.
  const stopped = rec2.events().find((e) => e.tool === 'run.stopped');
  const stopOut = stopped ? rec2.resolve(stopped).output : null;
  assert((miss instanceof ReplayMiss) || (stopOut && stopOut.stop === 'error' && /replay miss/.test(stopOut.error || '')),
    'the unseen request was refused in strict mode');
});

await test('content addressing: same request → same hash; a different toolset is a different run', async () => {
  const a = await requestHash({ messages: MESSAGES, tools: [shellTool()] });
  const b = await requestHash({ messages: MESSAGES, tools: [shellTool()] });
  const c = await requestHash({ messages: MESSAGES, tools: [] });
  const d = await requestHash({ messages: MESSAGES, tools: [shellTool()], model: 'qwen3:8b' });
  eq(a, b, 'deterministic'); assert(a !== c, 'tool definitions are in the hash'); assert(a !== d, 'model label is in the hash');
});

await test('export/load round-trips; a hashes-only copy (no blobs) still verifies', async () => {
  const { rec } = await recordRun();
  const dump = rec.export();
  assert(typeof dump.events === 'string' && dump.events.includes('run.started'), 'NDJSON chain');
  const back = loadRecord(dump);
  eq((await back.verify()).ok, true, 'reloaded chain verifies');
  eq(back.events().length, rec.events().length, 'same length');
  eq(foldStatus(back.events(), back.resolve).status, foldStatus(rec.events(), rec.resolve).status, 'same fold');
  const audit = loadRecord({ events: dump.events }); // blobs dropped
  eq((await audit.verify()).ok, true, 'a payload-free audit copy still verifies');
  eq(audit.resolve(audit.events()[0]).input, undefined, 'but cannot resolve payloads — by design');
});

await test('a run that died mid-flight reads as running, and the record says where', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  // The tab "closes" during the second model call: infer never returns and no finish() is recorded.
  let n = 0;
  const infer = rec.wrapInfer(async () => { n++; if (n === 2) throw new Error('tab closed'); return SCRIPT()[0]; });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer, executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  // (no rec.finish — the process is gone)
  await rec.settled();
  const s = foldStatus(rec.events(), rec.resolve);
  eq(s.phase, 'running', 'no run.stopped → still running, not silently idle');
  const last = rec.events()[rec.events().length - 1];
  eq(last.tool, 'llm.requested', 'the last event is the request that never answered — the work owed');
  eq(result.stop, 'error', 'sanity: the loop did surface the throw');
});

// ─────────────────────────────────────────── history / retrieval (B2) ──
// Build three recorded runs; each writes a distinct file so a later run can find an
// earlier one's tool output — the "audit-state" rehydration the thread describes.
async function recordFinding(marker) {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: `investigate ${marker}` }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  const script = [{ content: '', toolCalls: [call('shell', { command: `echo ${marker}` }, 'c0')] }, { content: `found ${marker}`, toolCalls: [] }];
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()], infer: rec.wrapInfer(scripted(script)), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  return rec;
}

await test('HISTORY scope: run / task / project return DIFFERENT sets — the advertised parameter is implemented (S-1)', async () => {
  // three records: two belong to the asking task, one to a sibling task in the same project
  const entries = [
    { runId: 'mine-1',    taskId: 'task-A', record: await recordFinding('SCOPE-OLD') },
    { runId: 'other-1',   taskId: 'task-B', record: await recordFinding('SCOPE-SIBLING') },
    { runId: 'mine-2',    taskId: 'task-A', record: await recordFinding('SCOPE-NEW') },
  ];
  const ids = (scope) => searchRecords(entries, { query: 'scope-', scope, taskId: 'task-A', limit: 20 })
    .map((h) => h.runId).filter((v, i, a) => a.indexOf(v) === i).sort();

  deepEq(ids('project'), ['mine-1', 'mine-2', 'other-1'], 'project sees every entry');
  deepEq(ids('task'), ['mine-1', 'mine-2'], 'task excludes the sibling task');
  deepEq(ids('run'), ['mine-2'], 'run is the newest entry of the asking task alone');
  assert(ids('project').length !== ids('task').length, 'project and task are DIFFERENT sets, not the same call twice');
  assert(!ids('task').includes('other-1'), "the sibling task's record is not reachable at task scope");

  // an unknown scope is not a silent narrowing — it behaves as project
  deepEq(scopeEntries(entries, 'nonsense', 'task-A').map((e) => e.runId), ['mine-1', 'other-1', 'mine-2'], 'an unrecognised scope does not filter');
  // entries the loader did not tag keep working: an untagged entry is never dropped
  const untagged = [{ runId: 'legacy', record: entries[0].record }];
  eq(scopeEntries(untagged, 'task', 'task-A').length, 1, 'an untagged entry survives a task-scoped search');
  // and with no taskId the filter cannot narrow, so it does not pretend to
  eq(scopeEntries(entries, 'task', null).length, 3, 'no asking task → nothing to match against, nothing filtered');
});

await test('HISTORY search: from "run 3" a query finds a tool result recorded in run 1, newest first, with a readable id', async () => {
  const entries = [
    { runId: 'run1', record: await recordFinding('WIDGET-ALPHA') },
    { runId: 'run2', record: await recordFinding('WIDGET-BETA') },
    { runId: 'run3', record: await recordFinding('WIDGET-GAMMA') },
  ];
  const hits = searchRecords(entries, { query: 'widget-alpha' });
  assert(hits.length >= 1, 'the run-1 finding is searchable from run 3');
  assert(hits.some((h) => h.runId === 'run1' && /WIDGET-ALPHA/.test(h.excerpt)), 'hit names its run and centres the excerpt on the match');
  assert(/^run1#\d+$/.test(hits.find((h) => h.runId === 'run1').id), 'the id is runId#index');
  const all = searchRecords(entries, { query: 'widget', limit: 20 });
  const ts = all.map((h) => h.ts); assert(ts.every((t, i) => i === 0 || ts[i - 1] >= t), 'newest first');
  eq(searchRecords(entries, { query: '' }).length, 0, 'an empty query finds nothing');
  eq(searchRecords(entries, { query: 'widget', limit: 2 }).length, 2, 'limit caps the hits');
});

await test('HISTORY role slices: reviewer sees tool events, supervisor sees the trajectory, neither leaks the other', async () => {
  const entries = [{ runId: 'r', record: await recordFinding('SLICE-X') }];
  const rev = searchRecords(entries, { query: 'slice-x', role: 'reviewer' });
  assert(rev.length >= 1 && rev.every((h) => HISTORY_ROLES.reviewer.has(h.tool)), 'reviewer hits are tool/verify events');
  const sup = searchRecords(entries, { query: 'slice-x', role: 'supervisor' });
  assert(sup.every((h) => HISTORY_ROLES.supervisor.has(h.tool)), 'supervisor hits are turns/stops/verify only');
  assert(!sup.some((h) => h.tool === 'tool.responded'), 'the supervisor slice does not carry tool results');
});

await test('HISTORY read: an event pages by offset and preserves the tail; a bad id is reported, not thrown', async () => {
  const entries = [{ runId: 'run1', record: await recordFinding('PAGEME') }];
  const hit = searchRecords(entries, { query: 'pageme', role: 'reviewer' }).find((h) => h.tool === 'tool.responded');
  assert(hit, 'the tool result is a hit');
  const p1 = readEvent(entries, hit.id, { offset: 0, limit: 4 });
  eq(p1.text.length, 4, 'first page is limit-sized'); eq(p1.nextOffset, 4, 'nextOffset points past it');
  const p2 = readEvent(entries, hit.id, { offset: p1.nextOffset, limit: 4000 });
  assert(p2.text.length > 0 && p2.nextOffset === null, 'the tail reads to the end');
  const whole = readEvent(entries, hit.id, { offset: 0, limit: 100000 });
  eq(p1.text + readEvent(entries, hit.id, { offset: 4, limit: 100000 }).text, whole.text, 'the pages reassemble the whole event');
  assert(readEvent(entries, 'nope', {}).error, 'a bad id is an error field'); assert(readEvent(entries, 'run1#999', {}).error, 'a missing event is an error');
});

await test('HISTORY never inlines base64/data-URI payloads; the tool advertises search + read', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'grab the image' }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  const bigB64 = 'A'.repeat(5000);
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'cat img' }, 'c0')] }, { content: 'ok', toolCalls: [] }])),
    executeTool: async () => bigB64, onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  const entries = [{ runId: 'img', record: rec }];
  const read = readEvent(entries, 'img#' + rec.events().findIndex((e) => e.tool === 'tool.responded'), { limit: 100000 });
  assert(/binary\/base64 — not inlined/.test(read.text) && !read.text.includes(bigB64), 'a base64 blob is summarised, never inlined');
  const t = historyTool(); eq(t.function.name, 'history', 'named history');
  assert(t.function.parameters.properties.op.enum.join(',') === 'search,read', 'search + read');
});

// ─────────────────────────────────────────── recovery record (B3) ──
// A run that RESUMES after a gate pass, with two owner inputs (the original ask and a steer).
async function recordSteered({ gatePass }) {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  // First run.started carries the original ask; a nudge-style second run.started adds the steer.
  await rec.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'build the parser' }], tools: [shellTool()] });
  const verify = gatePass ? async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) : null;
  const r1 = await runAgentLoop({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'build the parser' }], tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'echo built' }, 'c0')] }, { content: 'built it', toolCalls: [] }])),
    executeTool: makeShellExecutor(shell), onEvent: rec.onEvent, verify });
  await rec.finish(r1);
  // the steer, as a second recorded run.started
  await rec.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'build the parser' }, { role: 'assistant', content: 'built it' }, { role: 'user', content: 'also handle comments' }], tools: [shellTool()] });
  const r2 = await runAgentLoop({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'also handle comments' }], tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: 'ok', toolCalls: [] }])), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  await rec.finish(r2); await rec.settled();
  return rec;
}

await test('RECOVERY is a pure fold: the SAME record yields an identical recovery record (strict-replay)', async () => {
  const rec = await recordSteered({ gatePass: true });
  const a = foldRecovery(rec.events(), rec.resolve), b = foldRecovery(rec.events(), rec.resolve);
  eq(JSON.stringify(a), JSON.stringify(b), 'deterministic — the annotation is a function of the record, not of when it ran');
  // and stable across an export/reload round-trip (the record is the whole input)
  const back = loadRecord(rec.export());
  eq(JSON.stringify(foldRecovery(back.events(), back.resolve)), JSON.stringify(a), 'same after export/load');
});

await test('RECOVERY resolution: a gate pass marks an EARLIER owner input likely-satisfied; the latest stays open; ungated stays open', async () => {
  const passed = foldRecovery((await recordSteered({ gatePass: true })).events(), (await recordSteered({ gatePass: true })).resolve);
  // rebuild cleanly (resolve must match the same record)
  const rp = await recordSteered({ gatePass: true }); const p = foldRecovery(rp.events(), rp.resolve);
  eq(p.ownerInputs.length, 2, 'two owner inputs: the ask and the steer');
  eq(p.ownerInputs[0].resolution, 'likely-satisfied', 'the original ask, with a gate pass after it, is likely handled');
  eq(p.ownerInputs[p.ownerInputs.length - 1].resolution, 'open', 'the LATEST owner input is always open — never marked satisfied');
  const ru = await recordSteered({ gatePass: false }); const u = foldRecovery(ru.events(), ru.resolve);
  assert(u.ownerInputs.every((x) => x.resolution === 'open'), 'no gate pass → everything stays open (never a false satisfied — the BLOCKS failure)');
  assert(/likely handled.*verify before redoing/.test(recoveryNote(p)), 'the note HEDGES: verify, do not blindly redo'); void passed;
});

await test('RECOVERY: coordination (a carried gate verdict) is tagged and never reads as an owner turn', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix the build' }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  let n = 0;
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'false' }, 'c0')] }, { content: '', toolCalls: [call('shell', { command: 'true' }, 'c1')] }, { content: 'fixed', toolCalls: [] }])),
    executeTool: makeShellExecutor(shell), onEvent: rec.onEvent, verify: async () => (++n >= 2 ? { ok: true, exit: 0 } : { ok: false, exit: 1 }), maxVerifyRounds: 3 });
  await rec.finish(r); await rec.settled();
  const t = foldTranscript(rec.events(), rec.resolve);
  const gate = t.find((m) => m.role === 'user' && /Gate failed/.test(m.content || ''));
  assert(gate && /^\[coordination\]/.test(gate.content), 'a carried gate verdict is tagged [coordination]');
  const ownerAt = t.findIndex((m) => m.role === 'user' && /fix the build/.test(m.content || ''));
  const coordAt = t.findIndex((m) => /^\[coordination\]/.test(m.content || ''));
  assert(ownerAt >= 0 && (coordAt === -1 || coordAt > ownerAt), 'coordination never precedes the owner intent');
  // a [coordination]-tagged user turn (a nudge or gate verdict) is NOT an owner input in the recovery record
  const nudged = createRunRecorder({ app: 'anvil', principal: 'p' });
  await nudged.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'real ask' }] });
  await nudged.finish({ stop: 'done', steps: 0 });
  await nudged.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'real ask' }, { role: 'user', content: '[coordination] You described the work but did not do it.' }] });
  await nudged.finish({ stop: 'done', steps: 0 }); await nudged.settled();
  const rec2 = foldRecovery(nudged.events(), nudged.resolve);
  eq(rec2.ownerInputs.length, 1, 'the nudge is not counted as an owner request'); eq(rec2.ownerInputs[0].text, 'real ask', 'only the real ask');
});

await test('a checkpoint is recorded on the chain and reads back through the history tool (B4)', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'long task' }], tools: [] });
  rec.onEvent({ type: 'turn-start', step: 0 });
  await rec.checkpoint('goal: ship X. progress: wrote the module. next: the test.');
  await rec.finish({ stop: 'done', steps: 1, verified: false }); await rec.settled();
  const ev = rec.events();
  const cp = ev.find((e) => e.tool === 'run.checkpoint'); assert(cp, 'the checkpoint is on the chain');
  eq((await verifyChain(ev)).ok, true, 'the chain still verifies with the new verb');
  eq(rec.resolve(cp).output.handoff, 'goal: ship X. progress: wrote the module. next: the test.', 'the handoff is the payload');
  const hits = searchRecords([{ runId: 'r', record: rec }], { query: 'ship X', role: 'supervisor' });
  assert(hits.some((h) => h.tool === 'run.checkpoint'), 'a checkpoint is in the supervisor slice');
});

await test('STAGNATION (D2): the same call repeated ≥3× is a stall; many DIFFERENT calls are not', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  // NON-consecutive repetition: the loop's own guard stops on 2 CONSECUTIVE identical steps, so
  // it misses A,B,A,B,A — which is exactly the spinning the supervisor is for. 'npm test' 3×.
  const spin = [
    { content: '', toolCalls: [call('shell', { command: 'npm test' }, 'c0')] },
    { content: '', toolCalls: [call('shell', { command: 'ls' }, 'c1')] },
    { content: '', toolCalls: [call('shell', { command: 'npm test' }, 'c2')] },
    { content: '', toolCalls: [call('shell', { command: 'ls' }, 'c3')] },
    { content: '', toolCalls: [call('shell', { command: 'npm test' }, 'c4')] },
    { content: 'x', toolCalls: [] }];
  const r = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rec.wrapInfer(scripted(spin)), executeTool: async () => 'still failing', onEvent: rec.onEvent, maxSteps: 8 });
  await rec.finish(r); await rec.settled();
  const st = foldStagnation(rec.events(), rec.resolve);
  assert(st.stalled && st.signal === 'repeat', `repeated identical call → stall: ${JSON.stringify(st)}`);
  assert(/\[coordination\]/.test(stagnationNudge(st)) && /different approach/.test(stagnationNudge(st)), 'the nudge is tagged coordination and redirects');
  // many DIFFERENT reads are legitimate, not a stall
  const shell2 = freshShell(); const rec2 = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec2.start({ messages: MESSAGES, tools: [shellTool()] });
  const reads = [0,1,2,3,4].map((i) => ({ content: '', toolCalls: [call('shell', { command: 'cat file'+i }, 'r'+i)] }));
  const r2 = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rec2.wrapInfer(scripted([...reads, { content: 'done', toolCalls: [] }])), executeTool: async () => 'contents', onEvent: rec2.onEvent, maxSteps: 8 });
  await rec2.finish(r2); await rec2.settled();
  assert(!foldStagnation(rec2.events(), rec2.resolve).stalled, 'five different reads is progress, not a stall');
  eq(stagnationNudge({ stalled: false }), '', 'no nudge when not stalled');
  // key order must not hide a stall: the same call with reordered arg keys still counts as one signature
  const rk = createRunRecorder({ app: 'anvil', principal: 'p' }); await rk.start({ messages: MESSAGES, tools: [shellTool()] });
  const mk = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rk.wrapInfer(scripted([
    { content: '', toolCalls: [call('shell', { command: 'x', dir: '/a' }, 'k0')] },
    { content: '', toolCalls: [call('shell', { command: 'y' }, 'k1')] },
    { content: '', toolCalls: [call('shell', { dir: '/a', command: 'x' }, 'k2')] },
    { content: '', toolCalls: [call('shell', { command: 'y' }, 'k3')] },
    { content: '', toolCalls: [call('shell', { command: 'x', dir: '/a' }, 'k4')] },
    { content: 'z', toolCalls: [] }])), executeTool: async () => 'o', onEvent: rk.onEvent, maxSteps: 8 });
  await rk.finish(mk); await rk.settled();
  eq(foldStagnation(rk.events(), rk.resolve).signal, 'repeat', 'reordered arg keys still detected as the same repeated call');
});

await test('STAGNATION: gate-stuck needs an unchanged EDIT, not just an unchanged filename (forward-pass M-2)', async () => {
  // Was: this test wrote a.js twice with DIFFERENT content and asserted "stalled" — it encoded
  // the false positive. Re-editing one file across two failed gate rounds IS the normal fix
  // loop; only a byte-identical re-edit is a stall.
  // Each write is followed by a prose turn, so the gate runs between the two edits — otherwise
  // both writes land before the FIRST failure and nothing is written between the rounds at all.
  const stagnationOf = async (contents) => {
    const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
    await rec.start({ messages: MESSAGES, tools: [shellTool()] });
    const turns = contents.flatMap((c, i) => ([
      { content: '', toolCalls: [call('write', { path: 'a.js', content: c }, 'w' + i)] },
      { content: 'done', toolCalls: [] }]));
    const r = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
      infer: rec.wrapInfer(scripted(turns)),
      executeTool: async (nm, a) => (nm === 'write' ? 'wrote ' + a.path : 'out'), onEvent: rec.onEvent, verify: async () => ({ ok: false, exit: 1 }), maxVerifyRounds: 2 });
    await rec.finish(r); await rec.settled();
    return foldStagnation(rec.events(), rec.resolve);
  };
  const progressing = await stagnationOf(['v1', 'v2']);
  assert(!progressing.stalled, `same file + NEW content across gate rounds is progress: ${JSON.stringify(progressing)}`);
  const stuck = await stagnationOf(['v1', 'v1']);
  assert(stuck.stalled && stuck.signal === 'gate-stuck', `byte-identical re-edit → gate-stuck: ${JSON.stringify(stuck)}`);
  // a READ-only spin is still a stall: re-reading one file at a new offset each round writes
  // nothing, so it must not read as progress just because an arg changed.
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const rr = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([
      { content: '', toolCalls: [call('read', { path: 'a.js', offset: 1 }, 'r0')] },
      { content: 'done', toolCalls: [] },
      { content: '', toolCalls: [call('read', { path: 'a.js', offset: 2 }, 'r1')] },
      { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'contents', onEvent: rec.onEvent, verify: async () => ({ ok: false, exit: 1 }), maxVerifyRounds: 2 });
  await rec.finish(rr); await rec.settled();
  const readSpin = foldStagnation(rec.events(), rec.resolve);
  assert(readSpin.stalled && readSpin.signal === 'gate-stuck', `a read-only spin is still gate-stuck: ${JSON.stringify(readSpin)}`);
  // apply_patch and edit_lines write WITHOUT naming a path, so the window keys on the payload,
  // not on a filename — two different patches across two failed rounds is progress.
  const pr = createRunRecorder({ app: 'anvil', principal: 'p' });
  await pr.start({ messages: MESSAGES, tools: [shellTool()] });
  const pp = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: pr.wrapInfer(scripted([
      { content: '', toolCalls: [call('apply_patch', { patch: '*** Begin Patch\n+v1\n*** End Patch' }, 'p0')] },
      { content: 'done', toolCalls: [] },
      { content: '', toolCalls: [call('apply_patch', { patch: '*** Begin Patch\n+v2\n*** End Patch' }, 'p1')] },
      { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'applied', onEvent: pr.onEvent, verify: async () => ({ ok: false, exit: 1 }), maxVerifyRounds: 2 });
  await pr.finish(pp); await pr.settled();
  const patched = foldStagnation(pr.events(), pr.resolve);
  assert(!patched.stalled, `two different patches is progress, even with no path arg: ${JSON.stringify(patched)}`);
});

await test('STAGNATION: a run that answered with no tool calls is no-tools; a normal run is not stalled', async () => {
  const shell = freshShell(); const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const r = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rec.wrapInfer(scripted([{ content: 'I would run the tests.', toolCalls: [] }])), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  eq(foldStagnation(rec.events(), rec.resolve).signal, 'no-tools', 'prose-only run → no-tools');
  eq(foldStagnation((await recordRun()).rec.events(), (await recordRun()).rec.resolve).stalled, false, 'a normal 3-tool run is not stalled');
});

await test('SESSION CONTEXT + DECISIONS folds (C2): goal, files, outcome; tool→gate pairing', async () => {
  const gated = await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  const ctx = foldSessionContext(gated.rec.events(), gated.rec.resolve);
  assert(/Create src\/a\.txt/.test(ctx.goal), 'goal is the first owner input'); eq(ctx.outcome, 'success', 'gated pass → success');
  assert(ctx.filesTouched.length === 0 || Array.isArray(ctx.filesTouched), 'filesTouched is a list (shell commands carry no path arg here)');
  const dec = foldDecisions(gated.rec.events(), gated.rec.resolve);
  assert(dec.length === 3 && dec.every((d) => typeof d.toolSignature === 'string'), 'one decision per tool call, each with a signature');
  assert(dec.some((d) => d.outcome === 'passed'), 'a decision is paired with the gate pass');
  const ungated = await recordRun();
  eq(foldSessionContext(ungated.rec.events(), ungated.rec.resolve).outcome, 'unknown', 'ungated → unknown outcome');
});

await test('the fixed vocabulary is frozen and complete for the loop', () => {
  assert(Object.isFrozen(RUN_EVENTS), 'frozen');
  for (const v of ['run.started', 'turn.started', 'llm.requested', 'llm.responded', 'tool.called', 'tool.responded', 'tool.failed', 'verify.passed', 'verify.failed', 'run.stopped', 'run.checkpoint'])
    assert(RUN_EVENTS.includes(v), `missing verb ${v}`);
});

// ─────────────────────────────────────────────── outcome (A4) ──
// Three recorded fixtures — pass / failing gate / budget — plus an ungated finish and
// a memory-using run. Every label is derived from the record; strict on success.

await test('OUTCOME pass: a gated, verified finish is the ONLY way to earn the success label', async () => {
  const { rec } = await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'success', 'label'); eq(o.note, null, 'no caveat');
  const t = o.signals.find((s) => s.kind === 'terminal');
  eq(t.polarity, 'success', 'terminal polarity'); eq(t.weight, 1.0, 'terminal weight is ground truth (1.0), not a regex guess');
  assert(o.score > 0, 'positive score');
  for (const s of o.signals) assert(OUTCOME_SIGNALS.includes(s.kind), `known signal kind ${s.kind}`);
});

await test('OUTCOME failing gate: unverified stop → failure, and every failed round is counted', async () => {
  const { rec, result } = await recordRun({ verify: async () => ({ ok: false, exit: 1, stdout: '', stderr: 'nope' }) });
  eq(result.stop, 'unverified', 'sanity: the loop gave up after maxVerifyRounds');
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'failure', 'label');
  eq(o.signals.find((s) => s.kind === 'terminal').weight, 1.0, 'gate never passed is a full-weight failure');
  const g = o.signals.find((s) => s.kind === 'gate');
  assert(g && g.polarity === 'failure' && /3 failed gate round/.test(g.detail), `failed rounds counted: ${g && g.detail}`);
  assert(o.score < 0, 'negative score');
});

await test('OUTCOME budget: a budget stop is a failure to finish (0.8), never a success', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [shellTool()] });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: rec.wrapInfer(scripted(SCRIPT())), executeTool: makeShellExecutor(shell), onEvent: rec.onEvent, budget: { turns: 2 } });
  await rec.finish(result); await rec.settled();
  eq(result.stop, 'budget', 'sanity: budget tripped');
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'failure', 'label');
  const t = o.signals.find((s) => s.kind === 'terminal');
  eq(t.weight, 0.8, 'did-not-finish weight'); assert(/budget \(turns\)/.test(t.detail), `names the axis: ${t.detail}`);
});

await test('OUTCOME unclaimed: an ungated finish yields NO success evidence, and says so', async () => {
  const { rec } = await recordRun();
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'unknown', 'not success, not failure');
  assert(/unclaimed/.test(o.note || ''), `the note explains: ${o.note}`);
  eq(o.signals.find((s) => s.kind === 'terminal').polarity, 'neutral', 'terminal is neutral');
  eq(o.score, 0, 'no score either way');
  // the RECORD must corroborate: a stop claiming verified:true with no verify.passed event
  // in the chain (an ungated loop says exactly that) earns nothing — a flag cannot mint success.
  const forged = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await forged.start({ messages: MESSAGES, tools: [] });
  await forged.finish({ stop: 'done', verified: true, steps: 1 }); await forged.settled();
  const f = foldOutcome(forged.events(), forged.resolve);
  eq(f.label, 'unknown', 'verified:true without a verify.passed event is not success'); assert(/unclaimed/.test(f.note), f.note);
  // a hashes-only audit copy (blobs dropped) says why it has no evidence
  const audit = loadRecord({ events: rec.export().events });
  const a = foldOutcome(audit.events(), audit.resolve);
  eq(a.label, 'unknown', 'no payload → unknown'); assert(/payload is missing/.test(a.note), a.note);
  // a run that died mid-flight: no run.stopped → no evidence, with a note
  const dead = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await dead.start({ messages: MESSAGES, tools: [shellTool()] }); await dead.settled();
  const d = foldOutcome(dead.events(), dead.resolve);
  eq(d.label, 'unknown', 'dead run is unknown'); assert(/no run\.stopped/.test(d.note), d.note);
});

// A memory-using run: recall x twice, then retract it — both per-fact failure signals fire.
const MEM_SCRIPT = () => [
  { content: '', toolCalls: [call('recall', { name: 'cache-guess' }, 'r1')] },
  { content: '', toolCalls: [call('recall', { name: 'cache-guess' }, 'r2')] },
  { content: '', toolCalls: [call('recall', { name: 'db-fact' }, 'r3')] },
  { content: '', toolCalls: [call('revise', { name: 'cache-guess', status: 'retracted', cause: 'correction' }, 'v1')] },
  { content: 'done', toolCalls: [] },
];
async function recordMemRun({ verify = null } = {}) {
  const rec = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await rec.start({ messages: MESSAGES, tools: [] });
  const result = await runAgentLoop({ messages: MESSAGES, tools: [], infer: rec.wrapInfer(scripted(MEM_SCRIPT())), executeTool: async (name, args) => `${name}:${args.name}`, onEvent: rec.onEvent, verify });
  await rec.finish(result); await rec.settled();
  return rec;
}

await test('OUTCOME expectation (D3): a shell call that missed its predicted exit is failure evidence; a hit is neutral', async () => {
  const shell = freshShell();
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 's' }, { role: 'user', content: 'run it' }];
  await rec.start({ messages: msgs, tools: [shellTool()] });
  // The model predicts exit 0 but the command fails; the recorded result carries [exit 1].
  const r = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'false', expect: 'exit 0' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'command failed\n[exit 1]', onEvent: rec.onEvent });
  await rec.finish(r); await rec.settled();
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.expectations.total, 1, 'one prediction'); eq(o.expectations.missed, 1, 'it missed');
  const sig = o.signals.find((x) => x.kind === 'expectation'); assert(sig && sig.polarity === 'failure' && /exit 0.*missed/.test(sig.detail), `a miss is failure evidence: ${sig && sig.detail}`);
  // a HIT records no expectation failure
  const shell2 = freshShell(); const rec2 = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec2.start({ messages: msgs, tools: [shellTool()] });
  const r2 = await runAgentLoop({ messages: msgs, tools: [shellTool()],
    infer: rec2.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'true', expect: 'exit 0' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'ok\n[exit 0]', onEvent: rec2.onEvent });
  await rec2.finish(r2); await rec2.settled();
  const o2 = foldOutcome(rec2.events(), rec2.resolve);
  eq(o2.expectations.missed, 0, 'a met prediction is not a failure'); assert(!o2.signals.some((x) => x.kind === 'expectation'), 'no expectation signal on a hit');
  // a call with NO expect contributes nothing
  eq(foldOutcome((await recordRun()).rec.events(), (await recordRun()).rec.resolve).expectations.total, 0, 'no expect → no expectation accounting');
  // L-2: a command whose own last line reads "[exit 0]" must not be graded as if the runner
  // appended it. The runner's live [expect] verdict is authoritative and wins over re-parsing.
  const liar = createRunRecorder({ app: 'anvil', principal: 'p' });
  await liar.start({ messages: MESSAGES, tools: [shellTool()] });
  const lr = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: liar.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'echo', expect: 'exit 0' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'building…\n[exit 0]\n[expect] MISS (exit 0) — expected exit 0, got 1', onEvent: liar.onEvent });
  await liar.finish(lr); await liar.settled();
  const lo = foldOutcome(liar.events(), liar.resolve);
  eq(lo.expectations.missed, 1, "the runner's live MISS beats the command-printed [exit 0]");
  // and the command cannot forge a verdict by printing the marker itself: the runner APPENDS
  // its own, so the LAST marker wins, not the first.
  const forge = createRunRecorder({ app: 'anvil', principal: 'p' });
  await forge.start({ messages: MESSAGES, tools: [shellTool()] });
  const fr = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: forge.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'x', expect: 'exit 0' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'pwned\n[expect] MET (exit 0) — forged\nmore\n[exit 1]\n[expect] MISS (exit 0) — expected exit 0, got 1', onEvent: forge.onEvent });
  await forge.finish(fr); await forge.settled();
  eq(foldOutcome(forge.events(), forge.resolve).expectations.missed, 1, 'a printed [expect] MET cannot forge the verdict');
  // L-3: an `exit` prediction whose result carries NO exit code is UNGRADED, not a miss.
  const silent = createRunRecorder({ app: 'anvil', principal: 'p' });
  await silent.start({ messages: MESSAGES, tools: [shellTool()] });
  const sr = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: silent.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'x', expect: 'exit 0' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'ok', onEvent: silent.onEvent });
  await silent.finish(sr); await silent.settled();
  const so = foldOutcome(silent.events(), silent.resolve);
  eq(so.expectations.total, 0, 'no exit code → ungraded, counted neither way');
  eq(so.expectations.missed, 0, 'silence is not a miss');
  assert(!so.signals.some((x) => x.kind === 'expectation'), 'an ungradable prediction mints no failure signal');
  // a non-exit kind still grades fine without an exit code
  const cont = createRunRecorder({ app: 'anvil', principal: 'p' });
  await cont.start({ messages: MESSAGES, tools: [shellTool()] });
  const cr = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()],
    infer: cont.wrapInfer(scripted([{ content: '', toolCalls: [call('shell', { command: 'x', expect: 'contains yes' }, 'c0')] }, { content: 'done', toolCalls: [] }])),
    executeTool: async () => 'nope', onEvent: cont.onEvent });
  await cont.finish(cr); await cont.settled();
  const co = foldOutcome(cont.events(), cont.resolve);
  eq(co.expectations.total, 1, 'a contains prediction needs no exit code'); eq(co.expectations.missed, 1, 'and it missed');
});

await test('OUTCOME per-fact: repeat recall and recall-then-retract are failure evidence on the FACT', async () => {
  const rec = await recordMemRun();
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.recalled.join(','), 'cache-guess,db-fact', 'deliberate recalls, in order, deduped');
  eq(o.retracted.join(','), 'cache-guess', 'retractions seen');
  const rr = o.signals.find((s) => s.kind === 'repeat_recall'); assert(rr && /2×/.test(rr.detail), `repeat recall fires: ${rr && rr.detail}`);
  const c = o.signals.find((s) => s.kind === 'contradiction'); assert(c && /retracted in the same run/.test(c.detail), 'contradiction fires');
  const ev = o.facts['cache-guess'] || [];
  assert(ev.some((x) => x.kind === 'repeat_recall') && ev.some((x) => x.kind === 'contradiction'), 'both land on the fact');
  assert(!o.facts['db-fact'], 'a fact recalled once in an unclaimed run earns nothing');
  eq(o.label, 'failure', 'the run itself reads as failure (score < 0) even though it "finished"');
});

await test('OUTCOME strict on success: a fact recalled in a PASSED run earns success evidence; a retracted one never does', async () => {
  const rec = await recordMemRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
  const o = foldOutcome(rec.events(), rec.resolve);
  eq(o.label, 'success', 'gate passed');
  assert((o.facts['db-fact'] || []).some((x) => x.kind === 'terminal' && x.polarity === 'success' && x.weight === 0.5), 'db-fact was load-bearing in a success');
  assert(!(o.facts['cache-guess'] || []).some((x) => x.polarity === 'success'), 'the retracted fact earns no success');
});

await test('OUTCOME reuse across runs: ≥3 distinct runs recalling a fact → load-bearing (neutral); injection never counts', async () => {
  const runs = [await recordMemRun(), await recordMemRun(), await recordMemRun()];
  const reuse = foldReuse(runs, { minRuns: 3 });
  const names = reuse.map((r) => r.name).sort().join(',');
  eq(names, 'cache-guess,db-fact', 'both facts recalled in 3 runs');
  eq(reuse[0].polarity, 'neutral', 'reuse is neutral — used, not proven');
  eq(foldReuse(runs.slice(0, 2), { minRuns: 3 }).length, 0, 'two runs are not enough');
  // a run with NO recall tool calls contributes nothing, however many facts its index injected
  const { rec: plain } = await recordRun();
  eq(foldReuse([plain, plain, plain]).length, 0, 'injection is not use');
  const one = await recordMemRun();
  eq(foldReuse([one, one, one]).length, 0, 'the same record passed thrice is one run, not three');
});

await test('FOLD IDENTITY (L-7): the same run as two distinct objects is one run, not two', async () => {
  const one = await recordMemRun();
  // object identity cannot see this: a reload is a different object, the same chain
  const copy = loadRecord(one.export());
  const copy2 = loadRecord(one.export());
  eq(foldReuse([one, copy, copy2], { minRuns: 2 }).length, 0, 'one run reloaded twice is still one run');
  eq(foldReuse([one, copy, copy2], { minRuns: 1 }).length, 2, 'and it counts exactly once');
  const h = foldStopReasons([one, copy, copy2]);
  eq(h.runs, 1, 'the stop-reason histogram counts the chain, not the objects');
  // two genuinely different runs are still two
  const other = await recordMemRun();
  eq(foldStopReasons([one, loadRecord(one.export()), other]).runs, 2, 'distinct chains stay distinct');
  // the key must cover the LAST event too: two runs identical until they ended are two runs
  const mk = async (stop) => { const r = createRunRecorder({ app: 'anvil', principal: 'p', now: () => 1000 });
    await r.start({ messages: MESSAGES, tools: [] }); await r.finish({ stop, steps: 1 }); await r.settled(); return r; };
  eq(foldStopReasons([await mk('done'), await mk('budget')]).runs, 2, 'runs differing only in how they stopped are distinct');
  // and a single-event record carries no prev_hash — two of them must not collapse into one
  const solo = async () => { const r = createRunRecorder({ app: 'anvil', principal: 'p' });
    await r.start({ messages: MESSAGES, tools: [] }); await r.settled(); return r; };
  eq(foldStopReasons([await solo(), await solo()]).runs, 2, 'two single-event runs are two runs');
});

await test('CHECKPOINT step (L-6): the handoff is filed under the step that ASKED, not the step at drain', async () => {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: MESSAGES, tools: [] });
  rec.onEvent({ type: 'turn-start', step: 3 });
  const pending = rec.checkpoint('handing off at step 3');   // NOT awaited — still queued
  rec.onEvent({ type: 'turn-start', step: 4 });               // a later turn lands first
  await pending; await rec.settled();
  const cp = rec.events().find((e) => e.tool === 'run.checkpoint');
  assert(cp, 'the checkpoint is on the chain');
  eq(rec.resolve(cp).input.step, 3, 'the step is snapshotted at call time');
});

await test('EVENT TEXT (L-4): a long hex dump is text and stays searchable; real base64 is still clipped', async () => {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: MESSAGES, tools: [] });
  const hex = 'deadbeef0123456789abcdef'.repeat(140);       // 3360 chars, all 16 hex symbols — a hexdump, not binary
  const b64 = 'QUJDRGVmZ2hpSktMbW5vUFFSU3R1Vld4eVowMTIzNDU2Nzg5Kw'.repeat(50); // 2450 chars, mixed alphabet
  rec.onEvent({ type: 'tool-call', id: 'h', name: 'shell', args: { command: 'sha256sum *' }, step: 1 });
  rec.onEvent({ type: 'tool-result', id: 'h', name: 'shell', result: hex, step: 1 });
  rec.onEvent({ type: 'tool-call', id: 'b', name: 'shell', args: { command: 'cat img' }, step: 1 });
  rec.onEvent({ type: 'tool-result', id: 'b', name: 'shell', result: b64, step: 1 });
  await rec.settled();
  const entries = [{ runId: 'r', record: rec }];
  assert(searchRecords(entries, { query: 'deadbeef' }).length > 0, 'the hex dump is searchable, not hidden as "binary"');
  const clipped = searchRecords(entries, { query: 'QUJDRGVmZ2hp' });
  eq(clipped.length, 0, 'a real base64 blob is still clipped out of the inlined text');
  // and a degenerate run of one character stays clipped whatever alphabet it belongs to
  // (base64 of zero bytes is "AAAA…", which is also valid hex — diversity, not charset, decides)
  const zeros = createRunRecorder({ app: 'anvil', principal: 'p' });
  await zeros.start({ messages: MESSAGES, tools: [] });
  zeros.onEvent({ type: 'tool-call', id: 'z', name: 'shell', args: { command: 'cat zeros' }, step: 1 });
  zeros.onEvent({ type: 'tool-result', id: 'z', name: 'shell', result: 'A'.repeat(3000), step: 1 });
  await zeros.settled();
  eq(searchRecords([{ runId: 'z', record: zeros }], { query: 'AAAAAAAAAA' }).length, 0, 'a one-symbol blob is not searchable text');
});

await test('TRANSCRIPT overlap (L-5): identical adjacent messages do not drop a genuine new turn', async () => {
  // The re-entered loop carries the WHOLE prior transcript, so the greedy scan's FIRST
  // candidate (k = out.length) is the correct anchor; identical repeats must not shift it.
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec.start({ messages: [{ role: 'user', content: 'go' }, { role: 'user', content: 'go' }] });
  await rec.settled();
  const first = foldTranscript(rec.events(), rec.resolve);
  eq(first.length, 2, 'both identical opening messages are kept');
  // a second run.started repeating both, plus a new turn
  rec.onEvent({ type: 'turn-start', step: 1 });
  await rec.start({ messages: [{ role: 'user', content: 'go' }, { role: 'user', content: 'go' }, { role: 'user', content: '[coordination] nudge' }] });
  await rec.settled();
  const after = foldTranscript(rec.events(), rec.resolve);
  eq(after.length, 3, 'the repeat is deduped exactly once and the new turn survives');
  eq(after[2].content, '[coordination] nudge', 'the new turn is the nudge');
  eq(after.filter((m) => m.content === 'go').length, 2, 'neither identical message is duplicated or dropped');
});

// ──────────────────────────────────────────── stop reasons (D1) ──
await test('STOP REASONS: a histogram over records — by stop, by derived status, by budget axis; unfinished counted', async () => {
  const pass = (await recordRun({ verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) })).rec;
  const fail = (await recordRun({ verify: async () => ({ ok: false, exit: 1, stdout: '', stderr: '' }) })).rec;
  const plain = (await recordRun()).rec; // ungated done → unclaimed under gated:true (the index's reading)
  const shell = freshShell();
  const bud = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await bud.start({ messages: MESSAGES, tools: [shellTool()] });
  const r = await runAgentLoop({ messages: MESSAGES, tools: [shellTool()], infer: bud.wrapInfer(scripted(SCRIPT())), executeTool: makeShellExecutor(shell), onEvent: bud.onEvent, budget: { turns: 1 } });
  await bud.finish(r); await bud.settled();
  const dead = createRunRecorder({ app: 'anvil', principal: 'prin_test' });
  await dead.start({ messages: MESSAGES, tools: [] }); await dead.settled();
  const h = foldStopReasons([pass, fail, plain, bud, dead, pass /* dup */]);
  eq(h.runs, 5, 'five distinct records (a duplicate object counts once)');
  eq(h.unfinished, 1, 'the dead run is unfinished');
  eq(h.byStop.done, 2, 'two done stops (one gated, one not)');
  eq(h.byStop.unverified, 1, 'one unverified'); eq(h.byStop.budget, 1, 'one budget');
  eq(h.byStatus.done, 1, 'only the gated pass is done'); eq(h.byStatus.unclaimed, 1, 'the ungated finish is unclaimed');
  eq(h.byStatus.error, 1, 'unverified reads as error'); eq(h.byStatus.idle, 1, 'budget reads as idle'); eq(h.byStatus.running, 1, 'dead reads as running');
  eq(h.byAxis.turns, 1, 'the budget axis is counted');
  const line = stopReasonsLine(h);
  assert(/^5 runs · /.test(line) && /budget: turns 1/.test(line), line);
  eq(stopReasonsLine(foldStopReasons([])), 'no runs recorded', 'empty');
  eq(JSON.stringify(pass.events()), JSON.stringify(pass.events()), 'read-only: events untouched');
});

await test('F1: the request-reconstruction invariant detects drift, and never throws', async () => {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  await rec.start({ messages: msgs });
  await rec.settled();
  // the honest case: what we would send IS what the record reconstructs
  const ok = reconstructionCheck(msgs, rec.events(), rec.resolve);
  eq(ok.ok, true, `a faithful request reconstructs: ${ok.why}`);
  // drift: a message the record has never seen
  const drifted = reconstructionCheck([...msgs, { role: 'user', content: 'smuggled' }], rec.events(), rec.resolve);
  eq(drifted.ok, false, 'an extra message is caught');
  assert(/length/.test(drifted.why), `and named: ${drifted.why}`);
  // drift: same length, different content — the subtler case
  const swapped = reconstructionCheck([{ role: 'system', content: 'sys' }, { role: 'user', content: 'CHANGED' }], rec.events(), rec.resolve);
  eq(swapped.ok, false, 'a mutated message is caught');
  eq(swapped.at, 0, 'and located');
  // it must see through a recorded compaction, because that is the case it exists for
  await rec.compacted({ method: 'summarize', from: 0, to: 1, replacement: [{ role: 'user', content: 'summary' }] });
  await rec.settled();
  eq(reconstructionCheck([{ role: 'system', content: 'sys' }, { role: 'user', content: 'summary' }], rec.events(), rec.resolve).ok,
     true, 'after a logged compaction, the COMPACTED surface is what reconstructs');
  eq(reconstructionCheck(msgs, rec.events(), rec.resolve).ok, false, 'and the pre-compaction transcript no longer does');

  // the hook fires on a real request, and does NOT throw
  const seen = [];
  const rec2 = createRunRecorder({ app: 'anvil', principal: 'p' });
  await rec2.start({ messages: [{ role: 'user', content: 'a' }] });
  const infer = rec2.wrapInfer(async () => ({ content: 'ok', toolCalls: [] }), { onDivergence: (d) => seen.push(d) });
  const reply = await infer({ messages: [{ role: 'user', content: 'a' }], tools: [] });
  eq(seen.length, 0, 'a faithful request raises nothing');
  eq(reply.content, 'ok', 'and the reply passes through');
  const reply2 = await infer({ messages: [{ role: 'user', content: 'TAMPERED' }], tools: [] });
  eq(seen.length, 1, 'a drifted request is reported');
  eq(reply2.content, 'ok', 'and the run CONTINUES — detection must not kill it');
});

await test('F7 x F1: a NUDGED run still reconstructs from its chain — the loop\'s own user turn is recorded', async () => {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'go' }];
  await rec.start({ messages: msgs });
  const seen = [];
  let sent = null;
  const infer = rec.wrapInfer(async ({ messages }) => { sent = messages; return { content: '', toolCalls: [{ id: 'c', function: { name: 'shell', arguments: '{"command":"pwd"}' } }] }; },
    { onDivergence: (d) => seen.push(d) });
  const r = await runAgentLoop({
    messages: msgs, tools: [shellTool()], infer,
    executeTool: async () => 'Refused: nope',
    onEvent: rec.onEvent, maxSteps: 4,
  });
  await rec.finish(r); await rec.settled();

  // the nudge really happened, and it is ON THE CHAIN
  const nudges = rec.events().filter((e) => e.tool === 'run.nudged');
  eq(nudges.length, 1, 'the repeat nudge was recorded as an event, not only pushed into the array');
  const folded = foldTranscript(rec.events(), rec.resolve);
  const note = folded.filter((m) => m.role === 'user' && /^\[coordination\] You have issued/.test(m.content));
  eq(note.length, 1, `the fold reproduces the nudge: ${JSON.stringify(folded.map(m => m.role))}`);
  assert(/refused/i.test(note[0].content), 'a run whose every result was a refusal is nudged in the denied wording');

  // and the invariant F1 exists to protect holds across it
  eq(seen.length, 0, `no divergence was raised on a nudged run: ${JSON.stringify(seen)}`);
  const chk = reconstructionCheck(sent, rec.events(), rec.resolve);
  eq(chk.ok, true, `the LAST request sent still equals the fold: ${chk.why} at ${chk.at}`);
  // the control: drop the nudge event and the same request no longer reconstructs
  const without = rec.events().filter((e) => e.tool !== 'run.nudged');
  eq(reconstructionCheck(sent, without, rec.resolve).ok, false, 'without the recorded nudge the request does NOT reconstruct — which is why it must be recorded');
});

await test('F4: compaction is a LOGGED surface replace — the sent transcript is derivable', async () => {
  const rec = createRunRecorder({ app: 'anvil', principal: 'p' });
  // the system message is stripped by foldTranscript; three user turns survive
  await rec.start({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'one' },
                               { role: 'user', content: 'two' }, { role: 'user', content: 'three' }] });
  await rec.settled();
  const before = foldSurface(rec.events(), rec.resolve);
  eq(before.length, 3, 'three carried turns');
  // compact the two assistant turns into one summary — the model-written part, hence logged
  await rec.compacted({ method: 'summarize', from: 1, to: 3, replacement: [{ role: 'user', content: '[summary of 2 turns]' }] });
  await rec.settled();
  const after = foldSurface(rec.events(), rec.resolve);
  eq(after.length, 2, 'the span collapsed to the replacement');
  eq(after[1].content, '[summary of 2 turns]', 'the recorded replacement is what the surface carries');
  eq(after[0].content, 'one', 'the head of the surface is untouched');
  // the ORIGINALS are shadowed, not deleted — still on the chain and still foldable
  eq(foldTranscript(rec.events(), rec.resolve).length, 3, 'the raw transcript still holds both turns');
  assert(rec.events().some((e) => e.tool === 'run.compacted'), 'the compaction is on the chain');
  eq((await verifyChain(rec.events())).ok, true, 'and the chain still verifies');
  // a replay from the exported record reproduces the same surface
  const reloaded = loadRecord(rec.export());
  eq(JSON.stringify(foldSurface(reloaded.events(), reloaded.resolve)), JSON.stringify(after), 'reproducible from the export alone');
  // an out-of-range span is ignored, never thrown — a fold must not break a run
  const bad = createRunRecorder({ app: 'anvil', principal: 'p' });
  await bad.start({ messages: [{ role: 'user', content: 'x' }] });
  await bad.compacted({ method: 'shake', from: 5, to: 99, replacement: [{ role: 'user', content: 'nope' }] });
  await bad.settled();
  eq(foldSurface(bad.events(), bad.resolve).length, 1, 'an impossible span leaves the surface alone');
  eq(compactionOrphaned(bad.events(), bad.resolve), false, 'a completed compaction is not an orphan');
});

if (failures.length) { console.error(`history/run-record: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`history/run-record conformance: ${passed}/${passed} passed`);
