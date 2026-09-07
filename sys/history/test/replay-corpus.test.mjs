// Conformance — the replay lane (F2). Real recorded runs, replayed with ZERO model calls.
//   node sys/history/test/replay-corpus.test.mjs
//
// Every other test in this repo drives a scripted model. These three entries were recorded
// from a live Ollama qwen3:8b on 2026-09-07 by `node scripts/record-corpus.mjs` — real
// responses, real tool calls, real shell results. Nothing here touches a network.
//
// This is what Chunk 0's "2b gated on live failure-path runs" was waiting for: the failure
// paths a settled transcript cannot express arrive through the override sidecar instead.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayEntry, openingOf, applyOverride } from '../replay-corpus.mjs';
import { loadRecord, replayInfer, replayExecuteTool, assertConsumed, joined, foldTranscript, ReplayMiss } from '../run-record.mjs';
import { runAgentLoop, shellTool } from '../../ai/agent-loop.mjs';
import { createRunRecorder } from '../run-record.mjs';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const entries = existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => f.endsWith('.json') && !f.endsWith('.override.json') && !f.endsWith('.opts.json')) : [];
const load = (f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf8'));
// The generic lane tests below need a plain single-loop entry with no budget and no gate —
// naming it beats `entries[0]`, which silently became the two-loop act-or-nudge when the S1
// scenarios were added and made three tests assert the wrong thing.
const SIMPLE = 'write-a-file.json';
// What a record cannot hold — the budget the run was given — sits beside it, written at capture.
const optsOf = (f) => {
  const p = join(CORPUS, f.replace(/\.json$/, '.opts.json'));
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : {};
};

await test('the corpus exists and holds real runs — an empty lane proves nothing', () => {
  assert(entries.length >= 3, `the corpus is thin or missing: ${entries.length} entries in ${CORPUS}`);
  for (const f of entries) {
    const rec = loadRecord(load(f));
    const ev = joined(rec.events(), rec.resolve);
    assert(ev.length >= 6, `${f}: ${ev.length} events is not a run`);
    const responses = ev.filter((e) => e.tool === 'llm.responded');
    assert(responses.length >= 2, `${f}: a one-turn record cannot exercise the loop`);
    // a real model wrote these, and the LOOP did something with the answer: it either ran a
    // tool or ran the gate. `gate-on-prose` is deliberately the second kind — a run with no
    // tool call at all is exactly the branch it exists to cover.
    assert(ev.some((e) => e.tool === 'tool.called' || e.tool === 'verify.failed' || e.tool === 'verify.passed'),
      `${f}: the loop neither called a tool nor ran the gate — nothing is being exercised`);
    assert(ev.some((e) => e.tool === 'run.stopped'), `${f}: the run never finished`);
  }
});

// ── the lane itself ──
for (const f of entries) {
  await test(`replay ${f} — same answers, same shape, nothing left over`, async () => {
    const opts = optsOf(f);
    const r = await replayEntry(load(f), { opts });
    assert(r.ok, `${f}: ${r.why}`);
    eq(r.consumed, true, `${f}: recorded responses went unserved`);
    eq(r.stop, opts.expect || 'done', `${f}: the replayed run ended ${r.stop}`);
  });
}

// ── the property a strict replay cannot see on its own ──
await test('a scenario that drives FEWER calls than the run did FAILS (assertConsumed)', async () => {
  const dump = load(SIMPLE);
  const recorded = loadRecord(dump);
  const { messages, tools } = openingOf(recorded);
  const infer = replayInfer(recorded, { strict: true });
  const exec = replayExecuteTool(recorded, { strict: true });
  // maxSteps 1 stops after the first turn — every assertion about what DID run still passes
  const live = createRunRecorder({ app: 'anvil', principal: 'short' });
  await live.start({ messages, tools });
  const result = await runAgentLoop({ messages, tools, infer: live.wrapInfer(infer), executeTool: exec, onEvent: live.onEvent, maxSteps: 1 });
  await live.finish(result); await live.settled();
  assert(result.stop === 'max-steps', `the short run ended ${result.stop}`);

  const left = infer.remaining();
  assert(left.length > 0, 'the short run left recorded responses unserved, and remaining() must say so');
  let threw = null;
  try { infer.assertConsumed(); } catch (e) { threw = e; }
  assert(threw instanceof ReplayMiss, `assertConsumed must throw a ReplayMiss, got ${threw}`);
  assert(/FEWER calls/.test(threw.message), `and say what happened: ${threw && threw.message}`);

  // and the same thing through the lane's own entry point
  const viaLane = await replayEntry(dump, { maxSteps: 1 });
  eq(viaLane.ok, false, 'the lane fails a short replay');
  eq(viaLane.consumed, false, 'and names it as unconsumed rather than a shape difference');
});

await test('a full replay consumes everything on BOTH sides — infer and executeTool', async () => {
  const recorded = loadRecord(load(SIMPLE));
  const { messages, tools } = openingOf(recorded);
  const infer = replayInfer(recorded, { strict: true });
  const exec = replayExecuteTool(recorded, { strict: true });
  const live = createRunRecorder({ app: 'anvil', principal: 'full' });
  await live.start({ messages, tools });
  const result = await runAgentLoop({ messages, tools, infer: live.wrapInfer(infer), executeTool: exec, onEvent: live.onEvent, maxSteps: 24 });
  await live.finish(result); await live.settled();
  eq(infer.remaining().length, 0, `model responses left over: ${JSON.stringify(infer.remaining())}`);
  eq(exec.remaining().length, 0, `tool results left over: ${JSON.stringify(exec.remaining())}`);
  eq(assertConsumed(infer, 'model requests'), true, 'assertConsumed returns true when it is satisfied');
});

// ── the two failure modes a settled transcript cannot express ──
await test('override: an endpoint that fails BEFORE the first chunk (no response to record)', async () => {
  const r = await replayEntry(load(SIMPLE), {
    override: { throwBeforeFirstChunk: true, atCall: 0, message: 'connection reset' },
    expectConsumed: false,
  });
  // The loop does NOT propagate a failed inference — it records run.stopped{stop:'error'} and
  // returns. That IS the failure path, and pinning it is the whole reason this lane exists.
  eq(r.stop, 'error', `a pre-first-chunk failure must end the run as an error, not a throw: ${r.stop}`);
  assert(/connection reset/.test(String(r.error)), `the error is the one the sidecar declared: ${r.error}`);
  assert(r.recorded.includes('run.stopped'), `and it is ON the chain: ${JSON.stringify(r.recorded)}`);
  assert(!r.recorded.includes('llm.responded'), 'nothing was ever responded — there was no first chunk');
  // the point: a record alone can only show the run that DID happen
  const rec = loadRecord(load(SIMPLE));
  assert(!joined(rec.events(), rec.resolve).some((e) => e.tool === 'run.stopped' && e.output?.stop === 'error'),
    'the recorded run finished cleanly — this path exists only because the sidecar declares it');
});

await test('override: a call that HANGS is released by the harness, not by a real clock', async () => {
  let released = false;
  const recorded = loadRecord(load(SIMPLE));
  const infer = replayInfer(recorded, { strict: true });
  const wrapped = applyOverride(infer, { hangUntil: true, atCall: 0, released: () => released });
  const started = Date.now();
  const call = wrapped({ messages: openingOf(recorded).messages, tools: openingOf(recorded).tools });
  let settledEarly = false;
  await Promise.race([call.then(() => { settledEarly = true; }), new Promise((r) => setTimeout(r, 60))]);
  eq(settledEarly, false, 'the call hangs until it is released — that is the scenario');
  released = true;
  const reply = await call;
  assert(reply && (reply.content !== undefined || reply.toolCalls), 'once released it serves the recorded response');
  assert(Date.now() - started >= 50, 'and the hang really happened');
});

await test('a corpus entry replays against ITS OWN opening, so a reworded prompt does not stale it', () => {
  // The normalization that matters: replay uses the messages/tools out of the record, never
  // today's app prompt. Rewording SYSTEM in apps/anvil cannot break the lane.
  const rec = loadRecord(load(SIMPLE));
  const { messages, tools } = openingOf(rec);
  assert(messages.length >= 2 && messages[0].role === 'system', 'the opening is carried in the record');
  assert(tools.length >= 1, 'and so are the tool schemas the hashes were taken over');
});

// ── S1: Chunk 0's three 2b gate conditions, replayed instead of re-driven by hand ──
//
// These were closed on 2026-09-04/06 by driving Anvil live and reading the result, which meant
// re-proving them cost another live run. Each entry below pins the LOOP behaviour the condition
// was about, from a real recorded run.

await test('0.0 failing gate — the model does not get to declare done; the verifier does', async () => {
  if (!entries.includes('failing-gate.json')) throw new Error('failing-gate.json is not in the corpus — record it');
  const opts = optsOf('failing-gate.json');
  const r = await replayEntry(load('failing-gate.json'), { opts });
  assert(r.ok, `replay failed: ${r.why}`);
  eq(r.stop, 'unverified', `a gate that never passes must end the run unverified, not done: ${r.stop}`);

  const rec = loadRecord(load('failing-gate.json'));
  const ev = joined(rec.events(), rec.resolve);
  const fails = ev.filter((e) => e.tool === 'verify.failed');
  assert(fails.length >= 2, `the failing verdict was fed back and retried: ${fails.length} round(s)`);
  assert(!ev.some((e) => e.tool === 'verify.passed'), 'nothing passed');
  const stop = ev.find((e) => e.tool === 'run.stopped');
  eq(stop.output.verified, false, 'and the run says so: verified=false');
  // HOW the model asked to be done, in this recording: it called `task_done`. The loop
  // intercepts that before executeTool — which is why there is no `tool.called` for it — runs
  // the gate itself, and refuses. Asserting the mechanism, not a guess about it.
  const turns = ev.filter((e) => e.tool === 'turn.started').length;
  assert(turns >= 3, `the run really looped: ${turns} turns`);
  const asked = ev.find((e) => e.tool === 'llm.responded' && (e.output?.toolCalls || []).some((c) => c.function?.name === 'task_done'));
  assert(asked, 'the model asked to be done via task_done');
  assert(!ev.some((e) => e.tool === 'tool.called' && e.input?.name === 'task_done'),
    'and it never reached executeTool — the loop owns completion');
  const firstFailAt = ev.findIndex((e) => e.tool === 'verify.failed');
  assert(firstFailAt > 0, 'the gate ran and refused');
  // the failing verdict was fed back: the run continued AFTER the first refusal
  assert(ev.slice(firstFailAt).some((e) => e.tool === 'tool.called'),
    'the model kept working after the gate refused it, which is the point of feeding the verdict back');
});

await test('0.0b the OTHER route to the gate — the model answers in prose and the verdict comes back as a user turn', async () => {
  if (!entries.includes('gate-on-prose.json')) throw new Error('gate-on-prose.json is not in the corpus — record it');
  // A mutation proved this branch uncovered: deleting `convo.push(fb)` — the loop feeding a
  // failing verdict back on a no-tool-call turn — survived the whole suite, because
  // failing-gate reaches the gate through the task_done interception, which uses a TOOL
  // message instead. Two routes, two entries.
  const r = await replayEntry(load('gate-on-prose.json'), { opts: optsOf('gate-on-prose.json') });
  assert(r.ok, `replay failed: ${r.why}`);
  eq(r.stop, 'unverified', `a gate that never passes ends the run unverified: ${r.stop}`);

  const rec = loadRecord(load('gate-on-prose.json'));
  const ev = joined(rec.events(), rec.resolve);
  const first = ev.find((e) => e.tool === 'llm.responded');
  eq((first.output?.toolCalls || []).length, 0, 'the first turn used NO tools — that is what makes this the other branch');
  assert(!ev.some((e) => e.tool === 'tool.called'), 'no tool was ever called in this run');
  assert(ev.filter((e) => e.tool === 'verify.failed').length >= 2, 'the gate ran and refused more than once');

  // and the verdict really was fed back as a USER turn — the fold reproduces it
  const folded = foldTranscript(ev.length ? rec.events() : [], rec.resolve);
  const coord = folded.filter((m) => m.role === 'user' && /^\[coordination\] Gate failed/.test(String(m.content || '')));
  assert(coord.length >= 1, `the failing verdict is carried as a coordination turn: ${JSON.stringify(folded.map((m) => m.role))}`);
});

await test('0.2 budget stop — the budget ends the run, and it replays because the axis is turns', async () => {
  if (!entries.includes('budget-stop.json')) throw new Error('budget-stop.json is not in the corpus — record it');
  const opts = optsOf('budget-stop.json');
  assert(opts.budget && Number.isFinite(opts.budget.turns),
    `the budget must be on a replayable axis — wall-clock never trips in an instant replay: ${JSON.stringify(opts.budget)}`);
  const r = await replayEntry(load('budget-stop.json'), { opts });
  assert(r.ok, `replay failed: ${r.why}`);
  eq(r.stop, 'budget', `the run must stop on the budget: ${r.stop}`);

  const stop = joined(loadRecord(load('budget-stop.json')).events(), loadRecord(load('budget-stop.json')).resolve)
    .find((e) => e.tool === 'run.stopped');
  eq(stop.output.stop, 'budget', 'the record says budget');
  eq(stop.output.axis, 'turns', `and names the axis: ${stop.output.axis}`);

  // the CONTROL: without the budget the replay does not stop there — it runs past the recording
  // and comes up short, which is exactly what the opts sidecar exists to prevent
  const without = await replayEntry(load('budget-stop.json'), {});
  assert(without.stop !== 'budget' || !without.ok,
    `without the recorded budget the run must NOT reproduce the stop: ${JSON.stringify({ ok: without.ok, stop: without.stop })}`);
});

await test('0.3 act-or-nudge — a prose-only run is nudged and the loop re-entered, on ONE chain', async () => {
  if (!entries.includes('act-or-nudge.json')) throw new Error('act-or-nudge.json is not in the corpus — record it');
  const dump = load('act-or-nudge.json');
  const rec = loadRecord(dump);
  const ev = joined(rec.events(), rec.resolve);
  const starts = ev.filter((e) => e.tool === 'run.started');
  const stops = ev.filter((e) => e.tool === 'run.stopped');
  eq(starts.length, 2, `two loops on one chain: ${starts.length}`);
  eq(stops.length, 2, `and two stops: ${stops.length}`);

  // the first loop used NO tools — that is the condition that triggers the nudge
  const firstStopAt = ev.findIndex((e) => e.tool === 'run.stopped');
  assert(!ev.slice(0, firstStopAt).some((e) => e.tool === 'tool.called'),
    'the first loop answered in prose with no tool call — otherwise the nudge would never fire');
  // the nudge is in the SECOND loop's opening, tagged as coordination, not as the owner
  const nudge = (starts[1].input.messages || []).filter((m) => m.role === 'user' && /^\[coordination\]/.test(String(m.content || '')));
  eq(nudge.length, 1, `the second loop opens with one tagged nudge: ${nudge.length}`);
  // and the re-entered run did what the first would not
  assert(ev.slice(firstStopAt).some((e) => e.tool === 'tool.called'), 'the nudged loop actually used a tool');

  // and the whole two-loop shape replays — derived from the record, no sidecar needed
  const r = await replayEntry(dump, { opts: optsOf('act-or-nudge.json') });
  assert(r.ok, `the two-loop replay failed: ${r.why}`);
  eq(r.consumed, true, 'both loops served every recorded response');
});

if (failures.length) {
  console.error(`replay-corpus: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`replay-corpus conformance: ${passed}/${passed} passed (${entries.length} real runs replayed, 0 model calls)`);
