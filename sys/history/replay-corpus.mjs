// replay-corpus — a lane that re-runs REAL recorded runs with zero model calls (F2).
//
// The gate could prove a fold was correct and a module parsed. It could not prove that a whole
// AGENT RUN still does what it did — the loop, the recorder, the tools and the transcript
// together. That needs a real run to compare against, and this is where they live: a corpus of
// records captured from a live endpoint once, replayed keyless forever after.
//
// Three properties make a replay meaningful, and only the first is free:
//
//   1. Same answers. `replayInfer` serves the recorded response for a request hash. If the loop
//      builds a different request, the hash misses and the replay throws — that is the check.
//   2. Same SHAPE. `compareRuns` walks both records event by event, verb and input and output
//      hash. A replay that reaches the same end by a different route is a regression.
//   3. Nothing left over. A scenario that drives FEWER calls than the run did passes 1 and 2 by
//      simply stopping early. `assertConsumed()` at teardown is what catches it.
//
// Records are replayed as they were RECORDED: the messages and tools come out of the corpus
// entry's own `run.started`, never rebuilt from today's app. That is the normalization — a
// corpus does not go stale when the system prompt is reworded, because the corpus IS the
// prompt that was sent. What a record cannot express is the two failure modes that never
// produce a settled transcript, and those come from the sidecar below.

import { loadRecord, createRunRecorder, replayInfer, replayExecuteTool, compareRuns, joined, ReplayMiss } from './run-record.mjs';
import { runAgentLoop } from '../ai/agent-loop.mjs';

// A record's own opening request — what the run was actually handed.
export function openingOf(record) {
  const started = joined(record.events(), record.resolve).find((e) => e.tool === 'run.started');
  if (!started) throw new Error('corpus entry has no run.started — not a replayable run');
  return { messages: started.input?.messages || [], tools: started.input?.tools || [] };
}

// The two failure modes a settled transcript cannot express, declared per entry in a sidecar
// (`<name>.override.json`) rather than faked inside the record:
//
//   throwBeforeFirstChunk — the endpoint fails before it emits anything. There is no response
//     to record, so a record alone can only ever show the run that DIDN'T happen.
//   hangUntil — the call never returns. `readyFile` names a path the harness creates when it
//     wants the hang released, so a test can assert the loop's own deadline/abort rather than
//     waiting on a real clock.
//
// An override applies to the request at `atCall` (0-based, counting model calls).
export function applyOverride(infer, override) {
  if (!override) return infer;
  let n = -1;
  const wrapped = async (args) => {
    n++;
    if (override.throwBeforeFirstChunk && n === (override.atCall ?? 0)) {
      const e = new Error(override.message || 'endpoint failed before the first chunk');
      e.beforeFirstChunk = true;
      throw e;
    }
    if (override.hangUntil && n === (override.atCall ?? 0)) {
      await new Promise((resolve, reject) => {
        const timer = setInterval(() => { if (override.released && override.released()) { clearInterval(timer); resolve(); } }, 5);
        if (args?.signal) args.signal.addEventListener('abort', () => { clearInterval(timer); reject(new Error('aborted')); });
      });
    }
    return infer(args);
  };
  wrapped.remaining = () => infer.remaining();
  wrapped.assertConsumed = () => infer.assertConsumed();
  return wrapped;
}

// Replay one corpus entry. Returns { ok, why, steps, stop, consumed }.
// `expectConsumed:false` is for an entry whose override deliberately cuts the run short.
export async function replayEntry(dump, { override = null, expectConsumed = true, maxSteps = 24 } = {}) {
  const recorded = loadRecord(dump);
  const { messages, tools } = openingOf(recorded);

  const live = createRunRecorder({ app: 'anvil', principal: 'replay' });
  const baseInfer = replayInfer(recorded, { strict: true });
  const infer = applyOverride(baseInfer, override);
  const exec = replayExecuteTool(recorded, { strict: true });

  await live.start({ messages, tools });
  let result, threw = null;
  try {
    result = await runAgentLoop({ messages, tools, infer: live.wrapInfer(infer), executeTool: exec, onEvent: live.onEvent, maxSteps });
  } catch (e) { threw = e; }
  if (result) await live.finish(result);
  await live.settled();

  if (threw && !override) return { ok: false, why: `replay threw: ${threw.message}`, threw };
  if (threw) return { ok: true, why: '', threw, stop: null, steps: 0, consumed: false };

  // An override makes the run DIVERGE on purpose, so shape and consumption are not the
  // question — what happened is. The loop does not propagate a failed inference: it records
  // `run.stopped {stop:'error'}` and returns, which is the failure path this lane exists to
  // pin. Report it, and let the caller assert the stop it declared.
  if (override) {
    const stopped = joined(live.events(), live.resolve).find((e) => e.tool === 'run.stopped');
    return { ok: true, why: '', stop: result.stop, steps: result.steps, consumed: false,
             error: result.error || stopped?.output?.error || null,
             recorded: joined(live.events(), live.resolve).map((e) => e.tool) };
  }

  // 3 — nothing recorded went unused
  let consumed = true, consumeWhy = '';
  try { baseInfer.assertConsumed(); exec.assertConsumed(); }
  catch (e) { consumed = false; consumeWhy = e.message; }
  if (expectConsumed && !consumed) return { ok: false, why: consumeWhy, stop: result.stop, steps: result.steps, consumed };

  // 2 — the same shape, event by event
  const cmp = compareRuns(recorded, live);
  if (!cmp.ok) return { ok: false, why: `event ${cmp.at}: ${cmp.why}`, stop: result.stop, steps: result.steps, consumed };

  return { ok: true, why: '', stop: result.stop, steps: result.steps, consumed };
}

export { ReplayMiss };
