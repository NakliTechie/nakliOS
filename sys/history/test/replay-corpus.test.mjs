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
import { loadRecord, replayInfer, replayExecuteTool, assertConsumed, joined, ReplayMiss } from '../run-record.mjs';
import { runAgentLoop, shellTool } from '../../ai/agent-loop.mjs';
import { createRunRecorder } from '../run-record.mjs';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const entries = existsSync(CORPUS) ? readdirSync(CORPUS).filter((f) => f.endsWith('.json') && !f.endsWith('.override.json')) : [];
const load = (f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf8'));

await test('the corpus exists and holds real runs — an empty lane proves nothing', () => {
  assert(entries.length >= 3, `the corpus is thin or missing: ${entries.length} entries in ${CORPUS}`);
  for (const f of entries) {
    const rec = loadRecord(load(f));
    const ev = joined(rec.events(), rec.resolve);
    assert(ev.length >= 6, `${f}: ${ev.length} events is not a run`);
    const responses = ev.filter((e) => e.tool === 'llm.responded');
    assert(responses.length >= 2, `${f}: a one-turn record cannot exercise the loop`);
    // a real model wrote these: at least one turn asked for a tool
    assert(ev.some((e) => e.tool === 'tool.called'), `${f}: no tool was ever called`);
    assert(ev.some((e) => e.tool === 'run.stopped'), `${f}: the run never finished`);
  }
});

// ── the lane itself ──
for (const f of entries) {
  await test(`replay ${f} — same answers, same shape, nothing left over`, async () => {
    const r = await replayEntry(load(f));
    assert(r.ok, `${f}: ${r.why}`);
    eq(r.consumed, true, `${f}: recorded responses went unserved`);
    eq(r.stop, 'done', `${f}: the replayed run ended ${r.stop}`);
  });
}

// ── the property a strict replay cannot see on its own ──
await test('a scenario that drives FEWER calls than the run did FAILS (assertConsumed)', async () => {
  const dump = load(entries[0]);
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
  const recorded = loadRecord(load(entries[0]));
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
  const r = await replayEntry(load(entries[0]), {
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
  const rec = loadRecord(load(entries[0]));
  assert(!joined(rec.events(), rec.resolve).some((e) => e.tool === 'run.stopped' && e.output?.stop === 'error'),
    'the recorded run finished cleanly — this path exists only because the sidecar declares it');
});

await test('override: a call that HANGS is released by the harness, not by a real clock', async () => {
  let released = false;
  const recorded = loadRecord(load(entries[0]));
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
  const rec = loadRecord(load(entries[0]));
  const { messages, tools } = openingOf(rec);
  assert(messages.length >= 2 && messages[0].role === 'system', 'the opening is carried in the record');
  assert(tools.length >= 1, 'and so are the tool schemas the hashes were taken over');
});

if (failures.length) {
  console.error(`replay-corpus: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`replay-corpus conformance: ${passed}/${passed} passed (${entries.length} real runs replayed, 0 model calls)`);
