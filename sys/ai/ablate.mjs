// Ablation harness (D4): the same agent ± one capability over a fixed task set,
// every arm recorded, every arm replayable with zero model calls. NOOA reports
// per-capability deltas and NVIDIA refuses to call an uncontrolled gap an ablation;
// this is how the supervisor, the review fork and the seeding experiment get a
// number instead of a claim.
//
// Shape: a TASK is { id, messages, tools, model(caps, ctx) → infer, executeTool(caps, ctx),
// gate(caps, ctx) → verify|null, loopOptions(caps, ctx), driver(caps, ctx) }; `ctx` is a fresh object per arm
// that the factories share (a workspace made in executeTool is what the gate reads). A CAPABILITY is a name the task's
// factories read from `caps`. `driver` is optional: a task that must run what the APP runs (the
// shared assembly's driveRun — re-loops, the app's budgets) hands back a function that owns the
// record from rec.start to rec.finish, and then `messages` is the CARRIED conversation (the driver
// builds the system prefix); without one, the arm is a single loop on `loopOptions` and
// `messages` is the whole request, system message first. Arms: `full` (every capability on) and `-<cap>` (all
// on but that one). Metrics come from the record: foldOutcome's label + score, steps,
// tool calls, failed gate rounds. delta = full − (−cap), per task per capability.
//
// Replay: pass `records` (a prior run's `records`) and each arm's infer becomes
// replayInfer over its recorded arm with the live model as fallback; `liveCalls`
// says how many times the fallback fired — zero means the ablation reproduced from
// the record alone. Pure over the run record; nothing here touches disk or a host.

import { runAgentLoop } from './agent-loop.mjs';
import { createRunRecorder, loadRecord, foldOutcome, foldOrdering, replayInfer } from '../history/run-record.mjs';

export function armsFor(capabilities) {
  const all = Object.fromEntries(capabilities.map((c) => [c, true]));
  return [{ name: 'full', caps: all }, ...capabilities.map((c) => ({ name: `-${c}`, caps: { ...all, [c]: false } }))];
}

export function metricsOf(rec) {
  const ev = rec.events();
  const o = foldOutcome(ev, rec.resolve);
  // AC-1: ordering, not just volume. `toFirstAction` is null on a run that never acted —
  // deltaOf skips nulls rather than reading them as zero, because a capability that makes
  // runs die earlier must not be able to show up here as an improvement.
  const ord = foldOrdering(ev, rec.resolve);
  return {
    label: o.label, score: o.score,
    steps: ev.filter((e) => e.tool === 'turn.started').length,
    toolCalls: ev.filter((e) => e.tool === 'tool.called').length,
    failedRounds: ev.filter((e) => e.tool === 'verify.failed').length,
    events: ev.length,
    toFirstAction: ord.toFirstAction,
    redundantBefore: ord.redundantBefore,
    anchor: ord.anchor,
  };
}

// The default driver: one recorded loop. A task's own driver replaces the whole of this.
function singleLoop(loopOptions) {
  return async ({ messages, tools, infer, executeTool, onEvent, verify, rec }) => {
    await rec.start({ messages, tools });
    const result = await runAgentLoop({ messages, tools, infer, executeTool, onEvent, verify, ...loopOptions });
    await rec.finish(result);
    return result;
  };
}

async function runArm(task, arm, { prior, principal, now }) {
  const rec = createRunRecorder({ app: 'ablate', principal, now });
  // One context per ARM, handed to every factory: whatever a task's executeTool sets up
  // (a workspace, a shell) is what its gate reads — no shared map to cross-wire.
  const ctx = { task: task.id, arm: arm.name };
  const messages = task.messages(arm.caps, ctx);
  const tools = task.tools ? task.tools(arm.caps, ctx) : [];
  let liveCalls = 0;
  const live = task.model(arm.caps, ctx);
  const counted = async (args) => { liveCalls++; return live(args); };
  const infer = prior ? replayInfer(prior, { strict: false, live: counted }) : counted;
  // Factory order is part of the contract: executeTool sets up the workspace the gate reads and
  // loopOptions may read, so executeTool → gate → loopOptions/driver, as the single call was.
  const executeTool = task.executeTool(arm.caps, ctx);
  const verify = task.gate ? task.gate(arm.caps, ctx) : null;
  const drive = task.driver ? task.driver(arm.caps, ctx) : singleLoop(task.loopOptions ? task.loopOptions(arm.caps, ctx) : {});
  const result = await drive({ messages, tools, infer: rec.wrapInfer(infer), executeTool, onEvent: rec.onEvent, verify, rec });
  await rec.settled();
  return { rec, liveCalls, metrics: metricsOf(rec) };
}

// Run the whole matrix. Returns { arms, rows, records, liveCalls } where rows is
// [{ task, capability, full, without, delta }] and records[task][arm] is the export.
export async function runAblation({ tasks, capabilities, records = null, principal = 'ablate', now = () => Date.now() }) {
  const arms = armsFor(capabilities);
  const out = { arms: arms.map((a) => a.name), rows: [], records: {}, liveCalls: 0, byArm: {} };
  for (const task of tasks) {
    out.records[task.id] = {}; out.byArm[task.id] = {};
    for (const arm of arms) {
      const priorDump = records?.[task.id]?.[arm.name];
      const prior = priorDump ? loadRecord(priorDump) : null;
      const r = await runArm(task, arm, { prior, principal, now });
      out.liveCalls += r.liveCalls;
      out.records[task.id][arm.name] = r.rec.export();
      out.byArm[task.id][arm.name] = { ...r.metrics, liveCalls: r.liveCalls };
    }
    const full = out.byArm[task.id].full;
    for (const c of capabilities) {
      const without = out.byArm[task.id][`-${c}`];
      out.rows.push({ task: task.id, capability: c, full, without, delta: deltaOf(full, without) });
    }
  }
  return out;
}

const LABEL_SCORE = { success: 1, unknown: 0, failure: -1 };
export function deltaOf(full, without) {
  return {
    label: (LABEL_SCORE[full.label] ?? 0) - (LABEL_SCORE[without.label] ?? 0), // success 1 / unknown 0 / failure −1: +2 = failure→success, +1 = one rung up, 0 = no change
    score: Math.round((full.score - without.score) * 100) / 100,
    steps: full.steps - without.steps,
    toolCalls: full.toolCalls - without.toolCalls,
    failedRounds: full.failedRounds - without.failedRounds,
    // Ordering deltas are null unless BOTH arms actually acted, and unless they measured to
    // the SAME anchor. A gate-anchored 4 and a write-anchored 4 are not the same quantity, and
    // subtracting them would manufacture a number out of a category error.
    toFirstAction: comparable(full, without) ? full.toFirstAction - without.toFirstAction : null,
    redundantBefore: comparable(full, without) ? full.redundantBefore - without.redundantBefore : null,
    anchor: full.anchor === without.anchor ? full.anchor : `${without.anchor}→${full.anchor}`,
  };
}

// Both arms anchored, and anchored the same way. Anything else is not a comparison.
function comparable(a, b) {
  return a.anchor === b.anchor && a.toFirstAction !== null && b.toFirstAction !== null;
}

// A plain-text table for a terminal or a log pane.
export function renderTable(result) {
  const head = ['task', 'capability', 'full', '-cap', 'Δlabel', 'Δscore', 'Δsteps', 'Δtools', 'Δrounds', 'Δ1st', 'Δredun', 'anchor'];
  // An incomparable ordering delta prints '·', never a number and never 0 — the whole point of
  // AC-1 is that "we could not measure this" and "no change" are different findings.
  const ord = (v) => (v === null || v === undefined ? '·' : sign(v));
  const rows = result.rows.map((r) => [r.task, r.capability, `${r.full.label} ${r.full.steps}s`, `${r.without.label} ${r.without.steps}s`,
    sign(r.delta.label), sign(r.delta.score), sign(r.delta.steps), sign(r.delta.toolCalls), sign(r.delta.failedRounds),
    ord(r.delta.toFirstAction), ord(r.delta.redundantBefore), r.delta.anchor]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => r.map((c, i) => String(c).padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line),
    `live model calls: ${result.liveCalls}${result.liveCalls === 0 ? ' (reproduced from the record alone)' : ''}`].join('\n');
}
function sign(n) { return n > 0 ? `+${n}` : String(n); }
