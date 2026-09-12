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
// prompt that was sent. What a record cannot express is a failure path that never produces a
// settled transcript; those are declared in a cell's manifest as an override (below).

import { loadRecord, createRunRecorder, replayInfer, replayExecuteTool, replayVerify, compareRuns, joined, ReplayMiss } from './run-record.mjs';
import { runAgentLoop } from '../ai/agent-loop.mjs';

// A record's own opening request — what the run was actually handed.
export function openingOf(record) {
  return openingsOf(record)[0];
}

// EVERY opening in the record, in order. A record with two `run.started` events is a run whose
// loop was re-entered — Anvil's act-or-nudge and its D2 supervisor both do this, and it is one
// of the three conditions Chunk 0 could previously only close with a live run. The shape is
// derivable from the record itself: one loop per run.started, each replayed against its own
// recorded messages. No sidecar needed to express it.
export function openingsOf(record) {
  const starts = joined(record.events(), record.resolve).filter((e) => e.tool === 'run.started');
  if (!starts.length) throw new Error('corpus entry has no run.started — not a replayable run');
  return starts.map((e) => ({ messages: e.input?.messages || [], tools: e.input?.tools || [] }));
}

// The failure modes a settled transcript cannot express, declared per cell in its manifest
// (`<cell>.manifest.json`, field `override`) over a base record rather than faked inside one:
//
//   throwBeforeFirstChunk — the endpoint fails before it emits anything. There is no response
//     to record, so a record alone can only ever show the run that DIDN'T happen.
//   hangUntil — the call never returns. `released()` is the harness's hand on the hang, so a
//     test can assert the loop's own abort rather than waiting on a real clock. With
//     `abortOnHang`, the hang's first poll presses Stop itself: the in-flight call is cancelled,
//     never answered, and the loop stops at that boundary — the aborted cell, with no clock at all.
//   throwOnTool — the executor itself throws (not a failing command: a broken executor). The
//     standard executors never throw, so no live run can record the loop's tool-error path.
//   reply — the model's answer to a request the record never saw (the turn after a thrown
//     tool): served fixed, so the run reaches a real stop instead of a ReplayMiss.
//
// `atCall` is 0-based and counts model calls (tool calls, for throwOnTool).
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
    if (override.reply && n === override.reply.atCall) return { content: String(override.reply.content || ''), toolCalls: [], finishReason: 'stop' };
    return infer(args);
  };
  wrapped.remaining = () => infer.remaining();
  wrapped.assertConsumed = () => infer.assertConsumed();
  return wrapped;
}

function applyToolOverride(exec, override) {
  if (!override?.throwOnTool) return exec;
  let n = -1;
  const wrapped = (name, args, call) => {
    n++;
    if (n === (override.throwOnTool.atCall ?? 0)) throw new Error(override.throwOnTool.message || 'executor threw');
    return exec(name, args, call);
  };
  wrapped.remaining = () => exec.remaining();
  wrapped.assertConsumed = () => exec.assertConsumed();
  return wrapped;
}

// Replay one corpus entry. Returns { ok, why, steps, stop, consumed } — plus `events` (the live
// chain, joined) for an override cell, whose divergence from its base is the thing to assert on.
// `expectConsumed:false` is for an entry whose override deliberately cuts the run short.
export async function replayEntry(dump, { override = null, expectConsumed = true, maxSteps = 24, opts = {} } = {}) {
  const recorded = loadRecord(dump);
  const openings = openingsOf(recorded);
  let signal = null;
  if (override?.abortOnHang) {
    const ac = new AbortController();
    signal = ac.signal;
    override = { ...override, released: () => { ac.abort(); return false; } };
  }

  const live = createRunRecorder({ app: 'anvil', principal: 'replay' });
  const baseInfer = replayInfer(recorded, { strict: true });
  const infer = applyOverride(baseInfer, override);
  const exec = applyToolOverride(replayExecuteTool(recorded, { strict: true }), override);
  // A gate verdict is served from the chain — no command is ever run. A budget cannot be, so it
  // comes from the entry's own capture-time options; only the WALL-CLOCK axis is unreplayable
  // (a replay is instant), which is why the corpus uses turns.
  const gate = replayVerify(recorded);
  const verify = gate.count() ? gate : null;

  let result, threw = null;
  try {
    for (const { messages, tools } of openings) {
      await live.start({ messages, tools });
      result = await runAgentLoop({
        messages, tools, infer: live.wrapInfer(infer), executeTool: exec, onEvent: live.onEvent,
        // a step cap is not in the record either (the supervisor cell spins to it); it rides in opts
        maxSteps: opts.maxSteps ?? maxSteps, verify, signal, ...(opts.budget ? { budget: opts.budget } : {}),
        ...(opts.maxVerifyRounds ? { maxVerifyRounds: opts.maxVerifyRounds } : {}),
      });
      await live.finish(result);
    }
  } catch (e) { threw = e; }
  await live.settled();

  if (threw && !override) return { ok: false, why: `replay threw: ${threw.message}`, threw };
  if (threw) return { ok: true, why: '', threw, stop: null, steps: 0, consumed: false };

  // An override makes the run DIVERGE on purpose, so shape and consumption are not the
  // question — what happened is. The loop does not propagate a failed inference: it records
  // `run.stopped {stop:'error'}` and returns, which is the failure path this lane exists to
  // pin. Report it, and let the caller assert the stop it declared.
  // What it did NOT serve is part of what happened: an override cuts the run short by a knowable
  // amount, and the cell says how much.
  if (override) {
    const stopped = joined(live.events(), live.resolve).find((e) => e.tool === 'run.stopped');
    const count = (r) => r.remaining().reduce((n, x) => n + (x.recorded - x.served), 0);
    return { ok: true, why: '', stop: result.stop, steps: result.steps, consumed: false,
             error: result.error || stopped?.output?.error || null,
             events: joined(live.events(), live.resolve), left: { model: count(baseInfer), tools: count(exec) } };
  }

  // 3 — nothing recorded went unused
  let consumed = true, consumeWhy = '';
  try { baseInfer.assertConsumed(); exec.assertConsumed(); gate.assertConsumed(); }
  catch (e) { consumed = false; consumeWhy = e.message; }
  if (expectConsumed && !consumed) return { ok: false, why: consumeWhy, stop: result.stop, steps: result.steps, consumed };

  // 2 — the same shape, event by event
  const cmp = compareRuns(recorded, live);
  if (!cmp.ok) return { ok: false, why: `event ${cmp.at}: ${cmp.why}`, stop: result.stop, steps: result.steps, consumed };

  return { ok: true, why: '', stop: result.stop, steps: result.steps, consumed };
}

export { ReplayMiss };
