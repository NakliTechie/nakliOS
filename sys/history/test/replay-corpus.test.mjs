// Conformance — the replay lane (F2). Real recorded runs, replayed with ZERO model calls.
//   node sys/history/test/replay-corpus.test.mjs
//
// Every other test in this repo drives a scripted model. The records here were captured by
// `node scripts/record-corpus.mjs` — seven from a live Ollama qwen3:8b on 2026-09-07, five from
// DeepSeek on 2026-09-12 — real responses, real tool calls, real shell results. Nothing here
// touches a network.
//
// This is what Chunk 0's "2b gated on live failure-path runs" was waiting for: the failure
// paths a settled transcript cannot express arrive through a manifest's override instead.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { replayEntry, openingOf, applyOverride } from '../replay-corpus.mjs';
import { loadRecord, replayInfer, replayExecuteTool, assertConsumed, joined, foldTranscript, foldStagnation, ReplayMiss } from '../run-record.mjs';
import { runAgentLoop, shellTool } from '../../ai/agent-loop.mjs';
import { createRunRecorder, isCorpusRecord } from '../run-record.mjs';
import { classifyToolResult } from '../../ai/tool-result-kind.mjs';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const entries = existsSync(CORPUS) ? readdirSync(CORPUS).filter(isCorpusRecord) : [];
const load = (f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf8'));
// The generic lane tests below need a plain single-loop entry with no budget and no gate —
// naming it beats `entries[0]`, which silently became the two-loop act-or-nudge when the S1
// scenarios were added and made three tests assert the wrong thing.
const SIMPLE = 'write-a-file.json';
// The cell's manifest names the stop it ends in; what the LOOP needs to reproduce that stop and a
// record cannot hold — a budget, a rounds cap, a step cap — sits in `.opts.json`, written at capture.
const manifestOf = (cell) => { const p = join(CORPUS, cell + '.manifest.json'); return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null; };
const expectOf = (f) => manifestOf(f.replace(/\.json$/, ''))?.expect;
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
    // a clarify cell pauses the loop on its FIRST response by design; every other cell needs two
    const expectsPause = (manifestOf(f.replace(/\.json$/, '')) || {}).expect === 'clarify';
    assert(responses.length >= (expectsPause ? 1 : 2), `${f}: a one-turn record cannot exercise the loop`);
    // a real model wrote these, and the LOOP did something with the answer: it either ran a
    // tool or ran the gate. `gate-on-prose` is deliberately the second kind — a run with no
    // tool call at all is exactly the branch it exists to cover.
    // … or intercepted a clarify (the loop's own tool: no executeTool, a paused run)
    assert(ev.some((e) => e.tool === 'tool.called' || e.tool === 'verify.failed' || e.tool === 'verify.passed') || expectsPause,
      `${f}: the loop neither called a tool nor ran the gate — nothing is being exercised`);
    assert(ev.some((e) => e.tool === 'run.stopped'), `${f}: the run never finished`);
  }
});

// ── B2 (2026-09-12): the corpus is a MATRIX of named cells, not a list of runs ──
// Every cell the loop can end in has a manifest (`<cell>.manifest.json`): what it pins, when and on
// what it was recorded, the stop it ends in. A recorded cell has its record; an override cell
// declares a failure path a settled transcript cannot express over a base record. A required cell
// with no manifest is red — the matrix names its gaps rather than forgetting them.
const REQUIRED_CELLS = [
  'write-a-file', 'read-then-answer', 'refused-command', 'failing-gate', 'gate-on-prose', 'budget-stop', 'act-or-nudge',
  'clarify', 'failed-command', 'stale-edit', 'parallel-reads', 'supervisor', 'tool-error', 'auth-failure', 'aborted',
];
await test('every required cell has a manifest, and every manifest names a record that exists', () => {
  for (const cell of REQUIRED_CELLS) {
    const m = manifestOf(cell);
    assert(m, `${cell}: no manifest — the matrix has a hole`);
    eq(m.cell, cell, `${cell}: manifest names itself`);
    assert(['recorded', 'override'].includes(m.kind), `${cell}: kind`);
    assert(typeof m.expect === 'string' && m.expect, `${cell}: names the stop it ends in`);
    assert(typeof m.description === 'string' && m.description.length > 20, `${cell}: says what it pins (description)`);
    assert(Number.isInteger(m.events) && m.events > 0, `${cell}: names its event count`);
    assert(typeof m.recordedAt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(m.recordedAt), `${cell}: recordedAt`);
    if (m.kind === 'recorded') {
      assert(existsSync(join(CORPUS, cell + '.json')), `${cell}: a recorded cell with no record`);
      const rec = loadRecord(load(cell + '.json'));
      const ev = joined(rec.events(), rec.resolve);
      eq(ev.filter((e) => e.tool === 'run.started').length, m.loops, `${cell}: the manifest's loop count is the record's`);
      eq(ev.length, m.events, `${cell}: the manifest's event count is the record's`);
      const last = [...ev].reverse().find((e) => e.tool === 'run.stopped');
      eq(last.output.stop, m.expect, `${cell}: the manifest's stop is the record's last run.stopped`);
    } else {
      assert(m.record && existsSync(join(CORPUS, m.record)), `${cell}: an override cell over a record that does not exist (${m.record})`);
      assert(m.override && typeof m.override === 'object', `${cell}: declares its override`);
    }
  }
  // every manifest on disk is a required cell — a cell nobody listed is a cell nobody will miss —
  // and every RECORD on disk is a required cell: a stray record rides no lane unnamed
  for (const f of readdirSync(CORPUS).filter((f) => f.endsWith('.manifest.json'))) assert(REQUIRED_CELLS.includes(f.replace('.manifest.json', '')), `${f}: not in REQUIRED_CELLS`);
  for (const f of entries) assert(REQUIRED_CELLS.includes(f.replace(/\.json$/, '')), `${f}: a record with no cell`);
});

// ── the override cells — failure paths a record cannot hold, replayed over a base record ──
// What every one must show: the stop its manifest names, and a chain that DIVERGED from the base
// (an override that changes nothing is a recorded cell wearing the wrong kind). Then each cell
// pins the one thing it exists for — explicitly, so a new override cell with no test is red.
// `left` is what the override cut off — the cell names how many recorded responses it must leave
// unserved, so a cell that quietly serves the whole record (or none of it) is red.
async function replayOverrideCell(cell, left) {
  const m = manifestOf(cell);
  const r = await replayEntry(load(m.record), { override: m.override, expectConsumed: false, opts: optsOf(m.record) });
  assert(r.ok, `${cell}: ${r.why}`);
  eq(r.stop, m.expect, `${cell}: the replayed run ended ${r.stop}`);
  eq(r.events.length, m.events, `${cell}: the manifest's event count is the replayed chain's`);
  const base = loadRecord(load(m.record));
  const baseChain = joined(base.events(), base.resolve).map((e) => e.tool).join(' ');
  const chain = r.events.map((e) => e.tool);
  assert(chain.join(' ') !== baseChain, `${cell}: the override replayed the base record unchanged — it declares no failure`);
  eq(JSON.stringify(r.left), JSON.stringify(left), `${cell}: what the override left unserved`);
  return { m, r, chain };
}
const OVERRIDE_CELLS = {
  'auth-failure': async () => {
    const { r } = await replayOverrideCell('auth-failure', { model: 2, tools: 1 });
    assert(/401/.test(String(r.error || '')), `the loop recorded the endpoint's error: ${r.error}`);
  },
  aborted: async () => {
    // Stop pressed while a call is in flight: the call is CANCELLED, not completed — the last
    // request has no response, and the loop stops at that boundary
    const { chain } = await replayOverrideCell('aborted', { model: 1, tools: 1 });
    eq(chain.slice(-2).join(' '), 'llm.requested run.stopped', `the run ends on an unanswered request: … ${chain.slice(-3).join(' ')}`);
    eq(chain.lastIndexOf('llm.responded') < chain.lastIndexOf('llm.requested'), true, 'the in-flight call was cancelled, not answered');
  },
  'tool-error': async () => {
    // the executor throws: the loop records tool.failed, hands the model the error as the
    // result, and the run reaches its stop — the model's answer to a request the record never
    // saw is the override's `reply`
    const { m, r, chain } = await replayOverrideCell('tool-error', { model: 1, tools: 1 });
    const failed = r.events.find((e) => e.tool === 'tool.failed');
    assert(failed, `a thrown tool is recorded as tool.failed: ${chain.join(' ')}`);
    eq(failed.output.error, m.override.throwOnTool.message, 'with the executor\'s error');
    // what the model was shown is the error as a result — and its kind is execution_error, the
    // closed set's "the tool broke", not not_found (which is what the BASE record's command was)
    const shown = r.events.find((e) => e.tool === 'tool.responded');
    eq(shown?.output?.result, `Error: ${m.override.throwOnTool.message}`, 'the model sees the error as the tool result');
    eq(classifyToolResult('shell', shown.output.result), 'execution_error', 'classified as the executor breaking');
    assert(chain.indexOf('llm.responded', chain.indexOf('tool.failed')) > 0, 'the loop went on to ask the model again');
    eq(r.stop, 'done', 'and the run ended on the model\'s reply, not on the failure');
  },
};
for (const cell of REQUIRED_CELLS.filter((c) => manifestOf(c)?.kind === 'override')) {
  await test(`cell ${cell} (override over ${manifestOf(cell).record}) ends ${manifestOf(cell).expect}`, async () => {
    assert(OVERRIDE_CELLS[cell], `${cell}: an override cell with no test pins nothing`);
    await OVERRIDE_CELLS[cell]();
  });
}
for (const cell of Object.keys(OVERRIDE_CELLS)) assert(manifestOf(cell)?.kind === 'override', `${cell}: tested as an override cell but its manifest says otherwise`);

// parallel-reads: three reads asked for in ONE turn ran through the F9 pool, and the record's shape
// is the serial one — tool.called then tool.responded, per call, in request order
await test('cell parallel-reads: the record pairs each read with its result, in request order', () => {
  const rec = loadRecord(load('parallel-reads.json'));
  const ev = joined(rec.events(), rec.resolve);
  const seq = ev.filter((e) => e.tool === 'tool.called' || e.tool === 'tool.responded');
  eq(seq.length, 6, 'three calls, three results');
  for (let i = 0; i < 6; i += 2) { eq(seq[i].tool, 'tool.called', `pair ${i / 2}`); eq(seq[i + 1].tool, 'tool.responded'); eq(seq[i + 1].input.id, seq[i].input.id, 'paired by id'); }
  const paths = seq.filter((e) => e.tool === 'tool.called').map((e) => e.input.args.path);
  eq(paths.join(' '), 'a.txt b.txt c.txt', 'request order');
  const turns = ev.filter((e) => e.tool === 'turn.started').length;
  eq(turns, 2, 'one turn asked for all three (the second is the answer)');
});

// stale-edit: F8's refusal happened in a REAL run, and the model recovered by re-reading
await test('cell stale-edit: the edit after a shell rewrite was refused as stale, then applied after a re-read', () => {
  const rec = loadRecord(load('stale-edit.json'));
  const ev = joined(rec.events(), rec.resolve);
  const results = ev.filter((e) => e.tool === 'tool.responded').map((e) => String(e.output.result));
  const stale = results.findIndex((r) => /^Refused: cfg\.txt is stale/.test(r));
  assert(stale >= 0, 'the stale refusal is in the record');
  assert(results.slice(stale + 1).some((r) => /^Edited cfg\.txt/.test(r)), 'and a later edit applied');
});

// ── the lane itself ──
for (const f of entries) {
  await test(`replay ${f} — same answers, same shape, nothing left over`, async () => {
    const opts = optsOf(f);
    const r = await replayEntry(load(f), { opts });
    assert(r.ok, `${f}: ${r.why}`);
    eq(r.consumed, true, `${f}: recorded responses went unserved`);
    eq(r.stop, expectOf(f) || 'done', `${f}: the replayed run ended ${r.stop}`);
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

// ── the failure modes a settled transcript cannot express, one mechanism at a time ──
await test('override: an endpoint that fails BEFORE the first chunk (no response to record)', async () => {
  const r = await replayEntry(load(SIMPLE), {
    override: { throwBeforeFirstChunk: true, atCall: 0, message: 'connection reset' },
    expectConsumed: false,
  });
  // The loop does NOT propagate a failed inference — it records run.stopped{stop:'error'} and
  // returns. That IS the failure path, and pinning it is the whole reason this lane exists.
  eq(r.stop, 'error', `a pre-first-chunk failure must end the run as an error, not a throw: ${r.stop}`);
  assert(/connection reset/.test(String(r.error)), `the error is the one the sidecar declared: ${r.error}`);
  const chain = r.events.map((e) => e.tool);
  assert(chain.includes('run.stopped'), `and it is ON the chain: ${JSON.stringify(chain)}`);
  assert(!chain.includes('llm.responded'), 'nothing was ever responded — there was no first chunk');
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

await test('cell supervisor — a spinning run is redirected ONCE by the D2 supervisor and the loop re-entered, on ONE chain', async () => {
  if (!entries.includes('supervisor.json')) throw new Error('supervisor.json is not in the corpus — record it');
  const dump = load('supervisor.json');
  const rec = loadRecord(dump);
  const raw = rec.events();
  const ev = joined(raw, rec.resolve);
  const starts = ev.filter((e) => e.tool === 'run.started');
  const stops = ev.filter((e) => e.tool === 'run.stopped');
  eq(starts.length, 2, `two loops on one chain: ${starts.length}`);
  eq(stops.length, 2, `and two stops: ${stops.length}`);
  // the first loop SPUN — that is the condition the supervisor fires on, folded from its own record
  const firstStopAt = ev.findIndex((e) => e.tool === 'run.stopped');
  const stag = foldStagnation(raw.slice(0, firstStopAt + 1), rec.resolve);
  assert(stag.stalled && stag.signal !== 'no-tools', `the first loop's record shows stagnation: ${JSON.stringify(stag)}`);
  eq(stops[0].output.stop, 'max-steps', 'the first loop ran into its step cap');
  // the redirect is in the SECOND loop's opening, tagged as coordination — exactly one
  const redirects = (starts[1].input.messages || []).filter((m) => m.role === 'user' && /^\[coordination\]/.test(String(m.content || '')));
  eq(redirects.length, 1, `the second loop opens with one tagged redirect: ${redirects.length}`);
  assert(ev.slice(firstStopAt).some((e) => e.tool === 'tool.called'), 'the redirected loop ran');
  // and the two-loop shape replays under the step cap the run was given
  const r = await replayEntry(dump, { opts: optsOf('supervisor.json') });
  assert(r.ok, `the two-loop replay failed: ${r.why}`);
  eq(r.consumed, true, 'both loops served every recorded response');
});

if (failures.length) {
  console.error(`replay-corpus: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`replay-corpus conformance: ${passed}/${passed} passed (${entries.length} real runs replayed, 0 model calls)`);
