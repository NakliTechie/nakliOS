// History — the run record (the log is the agent). An agent run is a fold over an
// append-only event chain; nothing about the run is stored that cannot be derived
// from it. This is the substrate under Anvil's task loop (and Forge's), and the
// first layer of plan/anvil-event-log-substrate.md.
//
// What today's scattered state becomes:
//   t.log     -> foldLog(events, resolve)         the UI rows are a projection
//   t.status  -> foldStatus(events, {gated})      "done" is derived, never set
//   t.convo   -> foldTranscript(events, resolve)  the carried transcript is a projection
//   replay    -> replayInfer / replayExecuteTool  the model is optional after the fact
//
// Two stores, one truth. The CHAIN (ledger.mjs) commits every event's input and
// output by HASH — tamper-evident, and it hoards nothing. The BLOBS map holds the
// payloads by that same hash, so a recorded model response or tool result can be
// served back on replay. `resolve(event)` joins them, exactly the seam ledger.mjs's
// replay() left open. Drop the blobs and the chain still verifies; drop the chain
// and the blobs are unattributed bytes.
//
// Fixed verbs, open nouns. RUN_EVENTS is frozen so tooling and tests key off it;
// tool names, args and payload shapes stay whatever the run produces.
//
// Recording is ORDER-PRESERVING and non-blocking to the loop: runAgentLoop calls
// onEvent synchronously, appendEvent hashes asynchronously, so appends ride one
// serial promise chain. Read the record only after `await settled()`.
//
// Pure over ledger.mjs. No storage, no DOM, no loop import — a caller records a
// run with any loop, and replays through any loop, by wrapping infer/executeTool.

import { appendEvent, contentHash, verifyChain, toNDJSON, fromNDJSON } from './ledger.mjs';
import { parseExpect, gradeExpect, stripExpect, EXPECT_MARKER } from '../ai/expect.mjs';

export const RUN_EVENTS = Object.freeze([
  'run.started',      // input: { messages, tools }            output: {}
  'turn.started',     // input: { step }                       output: {}
  'llm.requested',    // input: { request_hash, step }         output: {}
  'llm.responded',    // input: { request_hash, step }         output: { content, toolCalls, finishReason }
  'assistant.said',   // input: { step }                       output: { content }
  'tool.called',      // input: { id, name, args, step }       output: {}
  'tool.responded',   // input: { id, name, args_hash, step }  output: { result }
  'tool.failed',      // input: { id, name, step }             output: { error }
  'verify.passed',    // input: { step }                       output: { verdict }
  'verify.failed',    // input: { step, round, ran }           output: { verdict }
  'run.stopped',      // input: { steps }                      output: { stop, reason, verified, axis, error }
  'run.checkpoint',   // input: { step }                        output: { handoff }  (B4: a rollover landmark)
  'run.compacted',    // input: { method, from, to, step }      output: { replacement }  (F4: a logged surface replace)
]);

// The loop's onEvent types this recorder understands. 'done' and the pre-stop
// signals (budget, no-progress, max-steps, aborted, error) are NOT recorded from
// the event stream — run.stopped is recorded once, from the loop's RETURN value,
// which is the only complete statement of how a run ended. A run whose record
// has no run.stopped died mid-flight; foldStatus reports it as still running,
// and the last event says where it died (Tardigrade's "derive unfinished work").
const LOOP_TO_VERB = Object.freeze({
  'turn-start': 'turn.started',
  'assistant': 'assistant.said',
  'tool-call': 'tool.called',
  'tool-result': 'tool.responded',
  'tool-error': 'tool.failed',
  'verify-pass': 'verify.passed',
  'verify-fail': 'verify.failed',
});

export class ReplayMiss extends Error {
  constructor(what, detail) { super(`replay miss: ${what}`); this.code = 'EREPLAYMISS'; this.detail = detail; }
}

// What the model was actually asked. Everything that determines the response and
// is visible to this layer — the host picks the model id, so it is included only
// when the caller labels it. Tool DEFINITIONS are in the hash: a run with a
// different toolset is a different run.
export async function requestHash({ messages, tools, model = null }) {
  return contentHash({ messages, tools: tools || [], model });
}

export function createRunRecorder({ app = 'anvil', principal = 'local', grant_id = null, now = () => Date.now() } = {}) {
  const events = [];
  const blobs = new Map();      // hash -> payload (input or output)
  const argsHashes = new Map(); // tool-call id -> args_hash (so tool.responded can be keyed for replay)
  let head = null;
  let queue = Promise.resolve();

  let step = null;              // the current turn, as the loop reports it
  async function append(tool, input, output) {
    const { event, head: h } = await appendEvent(head, { ts: now(), principal, door: 'call', tool, app, input, output, grant_id });
    head = h;
    events.push(event);
    blobs.set(event.input_hash, input);
    blobs.set(event.output_hash, output);
    return event;
  }
  // Serialise every append so the chain order is the order things happened. The
  // payload is a THUNK evaluated at append time, so an event can read what earlier
  // appends produced (a tool's args_hash) rather than a snapshot taken at enqueue.
  function enqueue(tool, thunk) {
    const p = queue.then(async () => { const { input, output } = await thunk(); return append(tool, input, output); });
    queue = p.catch(() => {}); // a failed append must not wedge the queue
    return p;
  }

  return {
    // ---- recording ----
    start({ messages, tools }) { return enqueue('run.started', () => ({ input: { messages, tools: tools || [] }, output: {} })); },

    // Pass as runAgentLoop's onEvent. Synchronous by contract; the append is queued.
    onEvent(e) {
      const verb = LOOP_TO_VERB[e?.type];
      if (!verb) return; // done / budget / no-progress / max-steps / aborted / error → run.stopped covers them
      if (e.type === 'turn-start') step = e.step ?? null;
      const s = e.step ?? step;
      switch (verb) {
        case 'turn.started': enqueue(verb, () => ({ input: { step: s }, output: {} })); break;
        case 'assistant.said': enqueue(verb, () => ({ input: { step: s }, output: { content: String(e.content ?? '') } })); break;
        case 'tool.called': {
          const args = e.args ?? {};
          enqueue(verb, async () => { argsHashes.set(e.id, await contentHash(args)); return { input: { id: e.id, name: e.name, args, step: s }, output: {} }; });
          break;
        }
        case 'tool.responded':
          enqueue(verb, () => ({ input: { id: e.id, name: e.name, args_hash: argsHashes.get(e.id) ?? null, step: s }, output: { result: String(e.result ?? '') } }));
          break;
        case 'tool.failed': enqueue(verb, () => ({ input: { id: e.id, name: e.name, step: s }, output: { error: String(e.error ?? '') } })); break;
        case 'verify.passed': enqueue(verb, () => ({ input: { step: s }, output: { verdict: e.verdict ?? null } })); break;
        case 'verify.failed': enqueue(verb, () => ({ input: { step: s, round: e.round ?? null, ran: e.ran ?? null }, output: { verdict: e.verdict ?? null } })); break;
      }
    },

    // Wrap the loop's infer so every model exchange is recorded, content-addressed.
    // `onDivergence` receives { at, why } when the outgoing request cannot be reconstructed from
    // the chain (F1). It is called, never thrown — see reconstructionCheck.
    wrapInfer(infer, { model = null, onDivergence = null } = {}) {
      return async (args) => {
        const request_hash = await requestHash({ messages: args.messages, tools: args.tools, model });
        const s = step;
        if (typeof onDivergence === 'function') {
          try {
            await queue; // the chain must be settled before it can be compared against
            const chk = reconstructionCheck(args.messages, events, (e) => ({ input: blobs.get(e.input_hash), output: blobs.get(e.output_hash) }));
            if (!chk.ok) onDivergence(chk);
          } catch (_) { /* the check must never be what breaks a run */ }
        }
        await enqueue('llm.requested', () => ({ input: { request_hash, step: s }, output: {} }));
        const reply = await infer(args);
        const response = { content: reply?.content ?? '', toolCalls: reply?.toolCalls ?? [], finishReason: reply?.finishReason ?? 'stop' };
        await enqueue('llm.responded', () => ({ input: { request_hash, step: s }, output: response }));
        return reply;
      };
    },

    // Record how a loop ended, from its return value — the one complete statement.
    // Called once per loop; a task that re-runs the loop (Anvil's act-or-nudge)
    // records two run.stopped events, and foldStatus reads the LAST — honest, since
    // two loops ran.
    async finish(result) {
      await enqueue('run.stopped', () => ({ input: { steps: result?.steps ?? null }, output: {
        stop: result?.stop ?? 'unknown', reason: result?.reason ?? null,
        verified: result?.verified === true, axis: result?.budgetAxis ?? null,
        error: result?.error ?? null,
      } }));
    },

    // ---- the record ----
    // A checkpoint the agent asked for (B4): a capped handoff that becomes the next
    // projection's landmark. Recorded on the chain like any other event.
    // `step` is snapshotted at CALL time, like every other handler's `s = e.step ?? step`. The
    // thunk runs when the queue drains, and a turn.started arriving in between would otherwise
    // file the handoff under a later step than the one that asked for it (forward-pass L-6).
    // F4. Compaction used to REWRITE the carried transcript and store the result, so the record
    // and the live surface could disagree and nothing noticed — while run-record's own header
    // claimed the carried transcript was a projection. Recording the replacement makes that claim
    // true: `foldSurface` below reproduces the surface from the chain alone. The `summarize` path
    // calls a model and is not otherwise reproducible, which is precisely why the OUTPUT is logged
    // rather than the operation. Originals stay on the chain, shadowed rather than deleted.
    compacted({ method, from, to, replacement }) {
      const s = step;
      return enqueue('run.compacted', () => ({
        input: { method: String(method || 'shake'), from: Number(from) || 0, to: Number(to) || 0, step: s },
        output: { replacement: Array.isArray(replacement) ? replacement : [] },
      }));
    },
    checkpoint(handoff) { const s = step; return enqueue('run.checkpoint', () => ({ input: { step: s }, output: { handoff: String(handoff ?? '') } })); },
    async settled() { await queue; },
    events() { return events.slice(); },
    head() { return head; },
    blobs() { return new Map(blobs); },
    resolve(event) { return { input: blobs.get(event.input_hash), output: blobs.get(event.output_hash) }; },
    // Portable form: the chain as NDJSON, the payloads by hash. Drop `blobs` for a
    // hashes-only audit copy that still verifies.
    export() { return { events: toNDJSON(events), blobs: Object.fromEntries(blobs) }; },
  };
}

// Rehydrate an exported record into the same shape the recorder exposes for reading.
export function loadRecord({ events, blobs }) {
  const evs = typeof events === 'string' ? fromNDJSON(events) : events.slice();
  const map = blobs instanceof Map ? new Map(blobs) : new Map(Object.entries(blobs || {}));
  return {
    events: () => evs.slice(),
    blobs: () => new Map(map),
    resolve: (e) => ({ input: map.get(e.input_hash), output: map.get(e.output_hash) }),
    verify: () => verifyChain(evs),
  };
}

// ─────────────────────────────────────────────────────────────── folds ────

// Where the run stands. `gated` is whether a verify command was set — an UNGATED
// task_done returns verified:true from the loop (agent-loop.mjs:290-295), so
// "done" is derived from gate ∧ verified, never from verified alone. This is
// Anvil's 139c381 rule, now a pure function of the record.
export function foldStatus(events, resolve, { gated = false } = {}) {
  const stopEv = [...events].reverse().find((e) => e.tool === 'run.stopped');
  const steps = events.filter((e) => e.tool === 'turn.started').length;
  if (!stopEv) return { phase: 'running', status: 'running', stop: null, verified: false, steps };
  return { phase: 'stopped', steps, ...statusOf(resolve(stopEv)?.output || {}, gated) };
}
function statusOf(out, gated) {
  const stop = out.stop ?? 'unknown';
  const verified = out.verified === true;
  let status;
  if (stop === 'done') status = (gated && verified) ? 'done' : 'unclaimed';
  else if (stop === 'error' || stop === 'unverified') status = 'error';
  else status = 'idle';
  return { stop, verified, status, reason: out.reason ?? null, axis: out.axis ?? null, error: out.error ?? null };
}

// Join each chain event with its payloads. Folds below take the joined form.
export function joined(events, resolve) {
  return events.map((e) => { const r = resolve(e) || {}; return { ...e, input: r.input, output: r.output }; });
}

// Anvil's log pane rows, derived. Same shapes renderLog already draws.
export function foldLog(events, resolve) {
  const rows = [];
  const open = new Map(); // tool-call id -> row
  for (const e of joined(events, resolve)) {
    const inp = e.input || {}, out = e.output || {};
    switch (e.tool) {
      case 'run.started':
        for (const m of (inp.messages || [])) if (m.role === 'user') rows.push({ k: 'user', text: String(m.content ?? '') });
        break;
      case 'assistant.said': rows.push({ k: 'assistant', text: out.content ?? '' }); break;
      case 'tool.called': {
        const a = inp.args || {};
        const detail = a.command || a.path || a.file || a.old_string || (a.patch ? 'patch' : '') || '';
        const row = { k: 'tool', name: inp.name, detail: String(detail).split('\n')[0].slice(0, 120), result: null, error: null, args: a };
        open.set(inp.id, row); rows.push(row); break;
      }
      case 'tool.responded': {
        const row = open.get(inp.id);
        if (row) { row.result = String(out.result ?? '').slice(0, 8000); open.delete(inp.id); }
        else rows.push({ k: 'tool', name: inp.name || '(tool)', detail: '', result: String(out.result ?? '').slice(0, 8000), error: null });
        break;
      }
      case 'tool.failed': {
        const row = open.get(inp.id);
        if (row) { row.error = String(out.error ?? ''); open.delete(inp.id); }
        else rows.push({ k: 'tool', name: inp.name || '(tool)', detail: '(arguments rejected)', result: null, error: String(out.error ?? '') });
        break;
      }
      case 'verify.passed': rows.push({ k: 'system', text: '✓ gate passed — exit 0' }); break;
      case 'verify.failed': rows.push({ k: 'system', text: `✗ gate failed (round ${inp.round ?? 1}) — exit ${out.verdict?.exit ?? '?'}; agent retrying` }); break;
      case 'run.stopped': {
        const s = out.stop;
        const label = s === 'aborted' ? 'stopped' : s === 'budget' ? `hit budget (${out.axis || ''})` : s === 'unverified' ? 'gate never passed' : s === 'error' ? `error: ${out.error || ''}` : s;
        rows.push({ k: 'system', text: `agent ${label} · ${inp.steps ?? '?'} steps` });
        break;
      }
    }
  }
  return rows;
}

// The OpenAI-shaped transcript after the system prefix — what the next run is
// handed. Derived, so it can never drift from what happened: every tool reply is
// paired with the assistant turn that called it, by construction.
export function foldTranscript(events, resolve) {
  const out = [];
  let pendingCalls = null;
  const flushAssistant = () => {
    if (pendingCalls) { out.push({ role: 'assistant', content: null, tool_calls: pendingCalls }); pendingCalls = null; }
  };
  let started = 0;
  for (const e of joined(events, resolve)) {
    const inp = e.input || {}, o = e.output || {};
    switch (e.tool) {
      case 'run.started': {
        const msgs = (inp.messages || []).filter((m) => m.role !== 'system');
        if (started === 0) { for (const m of msgs) out.push(m); }
        else {
          // A re-entered loop (Anvil's act-or-nudge records a second run.started). Its messages
          // REPEAT everything the transcript already holds, then add the new turns (the nudge).
          // Emit only that new tail: skip the longest leading run of `msgs` that already sits as a
          // contiguous tail of `out` (compared by content), then push the remainder.
          const key = (m) => JSON.stringify([m.role, m.content ?? null, m.tool_call_id ?? null, (m.tool_calls || []).map((c) => c.id)]);
          // Largest k where out's last k messages equal msgs' first k — that overlap is the repeat;
          // msgs.slice(k) is the new tail (the nudge's assistant prose + user turn).
          let k = Math.min(out.length, msgs.length);
          for (; k > 0; k--) { let ok = true; for (let i = 0; i < k; i++) if (key(out[out.length - k + i]) !== key(msgs[i])) { ok = false; break; } if (ok) break; }
          for (const m of msgs.slice(k)) out.push(m);
        }
        started++;
        break;
      }
      case 'llm.responded': {
        flushAssistant();
        const calls = Array.isArray(o.toolCalls) ? o.toolCalls : [];
        if (calls.length) pendingCalls = calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } }));
        else if (o.content) out.push({ role: 'assistant', content: o.content });
        break;
      }
      case 'tool.responded': flushAssistant(); out.push({ role: 'tool', tool_call_id: inp.id, content: String(o.result ?? '') }); break;
      case 'tool.failed': flushAssistant(); out.push({ role: 'tool', tool_call_id: inp.id, content: `Error: ${o.error ?? ''}` }); break;
      // Coordination, not the owner: a carried gate verdict must never read as the owner's
      // instruction (B3). The tag survives into the next run's transcript.
      case 'verify.failed': out.push({ role: 'user', content: `[coordination] Gate failed (exit ${o.verdict?.exit ?? '?'}). Fix the problem and continue.` }); break;
    }
  }
  // An assistant turn whose tool replies never arrived is malformed as the next
  // request's tail — the run died there. Drop it; the record still shows it.
  return out;
}

// ─────────────────────────────────────────────────────────────── replay ───

// An infer that serves recorded responses by request hash — zero model calls.
// strict: a request the record never saw is a divergence (throw ReplayMiss).
// permissive: fall through to `live` and let the new response land as new history.
export function replayInfer(record, { strict = true, live = null, model = null } = {}) {
  const responses = new Map(); // request_hash -> [response, ...] in order
  for (const e of joined(record.events(), record.resolve)) {
    if (e.tool !== 'llm.responded') continue;
    const h = e.input?.request_hash; if (!h) continue;
    if (!responses.has(h)) responses.set(h, []);
    responses.get(h).push(e.output);
  }
  const cursor = new Map();
  return async (args) => {
    const h = await requestHash({ messages: args.messages, tools: args.tools, model });
    const list = responses.get(h) || [];
    const i = cursor.get(h) || 0;
    if (i < list.length) { cursor.set(h, i + 1); return { ...list[i] }; }
    if (strict || typeof live !== 'function') throw new ReplayMiss('model request not in record', { request_hash: h });
    return live(args);
  };
}

// An executeTool that serves recorded results by (name, args) — no side effects.
export function replayExecuteTool(record, { strict = true, live = null } = {}) {
  const results = new Map(); // `${name}:${args_hash}` -> [result...]
  for (const e of joined(record.events(), record.resolve)) {
    if (e.tool !== 'tool.responded' || !e.input?.args_hash) continue;
    const k = `${e.input.name}:${e.input.args_hash}`;
    if (!results.has(k)) results.set(k, []);
    results.get(k).push(e.output?.result ?? '');
  }
  const cursor = new Map();
  return async (name, args, call) => {
    const k = `${name}:${await contentHash(args ?? {})}`;
    const list = results.get(k) || [];
    const i = cursor.get(k) || 0;
    if (i < list.length) { cursor.set(k, i + 1); return list[i]; }
    if (strict || typeof live !== 'function') throw new ReplayMiss('tool call not in record', { name, args });
    return live(name, args, call);
  };
}

// Compare two records event by event — verb, input hash, output hash. Timestamps
// and chain links are deliberately excluded: they differ by construction. Returns
// the FIRST divergence, which is the whole point ("a green strict replay is a
// proof that the run is reproducible", and a red one names the event).
export function compareRuns(recorded, live) {
  const a = recorded.events(), b = live.events();
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i], y = b[i];
    if (x.tool !== y.tool) return { ok: false, at: i, why: `verb ${x.tool} ≠ ${y.tool}` };
    if (x.input_hash !== y.input_hash) return { ok: false, at: i, why: `input of ${x.tool} differs` };
    if (x.output_hash !== y.output_hash) return { ok: false, at: i, why: `output of ${x.tool} differs` };
  }
  if (a.length !== b.length) return { ok: false, at: n, why: `length ${a.length} ≠ ${b.length}` };
  return { ok: true, at: -1, why: '' };
}

// ─────────────────────────────────────────────────────────── outcome ──

// What a run says about itself and about the facts it used — derived, lazily, from
// the record alone (Caura's "six free signals", with our terminal signal being ground
// truth rather than a regex, and NOOA's rule that only DELIBERATE recalls count as
// use). Nothing here runs on the write path; nothing here calls a model.
//
// Polarity is asymmetric on purpose (Caura): strict on success, lenient on failure.
// A false-positive success would promote a bad fact; a false-negative failure only
// leaves a run unlabelled. So the `success` label is earned ONLY by a passed gate —
// never by score — and an ungated finish is `unknown` with a note saying why.
export const OUTCOME_SIGNALS = Object.freeze(['terminal', 'gate', 'repeat_recall', 'contradiction', 'reuse', 'expectation']);

export function foldOutcome(events, resolve) {
  const ev = joined(events, resolve);
  // The RECORD corroborates a pass — a verify.passed event — never a caller's flag. An
  // ungated loop returns verified:true (agent-loop.mjs, the gateGreen path), so the flag
  // alone could mint success evidence for facts; the event cannot be faked into a record.
  const passedInRecord = ev.some((e) => e.tool === 'verify.passed');
  const signals = []; const facts = {};
  const push = (kind, polarity, weight, detail, names = []) => {
    signals.push({ kind, polarity, weight, detail });
    for (const n of names) (facts[n] ||= []).push({ kind, polarity, weight });
  };
  let note = null;

  // 1. terminal — how the loop ended is the strongest signal we have, and we have it
  //    exactly (run.stopped is recorded from the loop's return value).
  const stopEv = [...ev].reverse().find((e) => e.tool === 'run.stopped');
  if (!stopEv) {
    note = 'no run.stopped — still running or died mid-flight; no outcome evidence';
  } else if (!stopEv.output) {
    note = 'run.stopped is in the chain but its payload is missing (hashes-only copy) — no outcome evidence';
    push('terminal', 'neutral', 0, 'stop payload unresolved');
  } else {
    const o = stopEv.output; const stop = o.stop;
    if (stop === 'done') {
      if (o.verified === true && passedInRecord) push('terminal', 'success', 1.0, 'gate passed and the loop finished');
      else { note = 'unclaimed: the loop finished but no gate corroborated it — no success evidence'; push('terminal', 'neutral', 0, 'finished without a gate'); }
    } else if (stop === 'unverified') push('terminal', 'failure', 1.0, 'gate never passed');
    else if (stop === 'error') push('terminal', 'failure', 1.0, `error: ${o.error || ''}`);
    else if (stop === 'budget' || stop === 'max-steps' || stop === 'no-progress') push('terminal', 'failure', 0.8, `did not finish: ${stop}${o.axis ? ` (${o.axis})` : ''}`);
    else if (stop === 'aborted') { note = 'aborted by the owner — no evidence either way'; push('terminal', 'neutral', 0, 'aborted'); }
    else push('terminal', 'neutral', 0, `unknown stop: ${stop}`);
  }

  // 2. gate rounds — every failed round is a small failure signal even on a run that
  //    eventually passed (the first answer did not land).
  const failedRounds = ev.filter((e) => e.tool === 'verify.failed').length;
  if (failedRounds) push('gate', 'failure', Math.min(0.5, 0.2 * failedRounds), `${failedRounds} failed gate round(s)`);

  // 2b. expectations (D3) — a shell call that carried an `expect` and MISSED it. A miss is a
  //     small failure signal; a hit is neutral; an UNGRADABLE prediction is neither.
  //
  //     The runner already grades every expectation live, with the true exit code in hand, and
  //     records its verdict as the `[expect] MET|MISS` line. That verdict is authoritative, so
  //     prefer it over re-deriving one from the text (forward-pass L-2): re-parsing cannot tell
  //     a runner-appended `[exit N]` from the same characters a command printed itself, and a
  //     command whose last line happens to read "[exit 0]" would otherwise mint a false grade.
  //     Re-parsing stays as the fallback for records written before the live grade existed.
  //     Responses are queued PER ID and consumed in order, so a repeated tool-call id pairs each
  //     call with its own result rather than grading every one against the last (forward-pass L-1).
  let expTotal = 0, expMissed = 0;
  const respsById = new Map();
  for (const e of ev) if (e.tool === 'tool.responded' && e.input?.id) {
    if (!respsById.has(e.input.id)) respsById.set(e.input.id, []);
    respsById.get(e.input.id).push(e);
  }
  const takenById = new Map();
  for (const e of ev) {
    if (e.tool !== 'tool.called') continue;
    const exp = parseExpect(e.input?.args?.expect); if (!exp) continue;
    const id = e.input.id;
    const nth = takenById.get(id) || 0;
    const resp = (respsById.get(id) || [])[nth]; if (!resp) continue; // no paired result — the run died there, not a miss
    takenById.set(id, nth + 1);
    const raw = String(resp?.output?.result ?? '');
    let missed = null;
    // lastIndexOf, not indexOf: the runner APPENDS its verdict, so the last marker is the one it
    // wrote. Reading the first would let a command forge a verdict by printing the marker itself,
    // which is the very substitution this fix exists to prevent. (Located, never regex-matched:
    // "[expect]" is a character class.)
    const at = raw.lastIndexOf(EXPECT_MARKER);
    if (at >= 0) {
      const verdict = raw.slice(at + EXPECT_MARKER.length).trimStart();
      if (verdict.startsWith('MISS')) missed = true;
      else if (verdict.startsWith('MET')) missed = false;
    }
    if (missed === null) {
      const result = stripExpect(raw);
      const m = /\[exit (-?\d+)\]\s*$/.exec(result); const exitCode = m ? Number(m[1]) : null;
      // An `exit` prediction against a result carrying NO exit code is UNGRADED, not missed
      // (forward-pass L-3): the runner appends the suffix only when it HAS a code, so its
      // absence means "unknown". Grading it as a miss minted failure signals out of silence.
      if (exp.kind !== 'exit' || exitCode != null) missed = !gradeExpect(exp, { exitCode, output: result }).ok;
    }
    if (missed == null) continue; // ungradable — it counts neither for nor against the run
    expTotal++;
    if (missed) { expMissed++; push('expectation', 'failure', 0.3, `predicted "${exp.kind} ${exp.value}" — missed`); }
  }

  // 3. + 4. per-fact evidence from deliberate tool calls: repeat recall, and a fact
  //    recalled then retracted in the same run.
  const recalls = new Map(); const recalled = []; const retracted = [];
  for (const e of ev) {
    if (e.tool !== 'tool.called') continue;
    const name = e.input?.name; const a = e.input?.args || {};
    if (name === 'recall' && a.name) { recalls.set(a.name, (recalls.get(a.name) || 0) + 1); if (!recalled.includes(a.name)) recalled.push(a.name); }
    if (name === 'revise' && a.status === 'retracted' && a.name && !retracted.includes(a.name)) retracted.push(a.name);
  }
  for (const [n, c] of recalls) if (c >= 2) push('repeat_recall', 'failure', 0.3, `"${n}" recalled ${c}× — the first answer did not land`, [n]);
  for (const n of retracted) if (recalls.has(n)) push('contradiction', 'failure', 0.5, `"${n}" was recalled, then retracted in the same run`, [n]);

  // A fact recalled in a run whose gate passed was load-bearing in a success — the
  // only success evidence a fact can earn here (strict: a passed gate, nothing less).
  const terminal = signals.find((s) => s.kind === 'terminal');
  if (terminal?.polarity === 'success') for (const n of recalled) if (!retracted.includes(n)) (facts[n] ||= []).push({ kind: 'terminal', polarity: 'success', weight: 0.5 });

  const score = Math.round(signals.reduce((t, s) => t + (s.polarity === 'success' ? s.weight : s.polarity === 'failure' ? -s.weight : 0), 0) * 100) / 100;
  const label = terminal?.polarity === 'success' ? 'success' : score < 0 ? 'failure' : 'unknown';
  return { label, score, signals, facts, recalled, retracted, note, expectations: { total: expTotal, missed: expMissed } };
}

// 5. reuse, across runs: a fact recalled in ≥ minRuns distinct runs is load-bearing
//    (polarity NEUTRAL — it says the fact is used, not that any run succeeded).
//    Deliberate `recall` calls only; injection into the index never counts (NOOA).
// Two distinct record OBJECTS for the same run — `loadRecord(x)` called twice, a recorder and
// its reload — are ONE run, and object identity cannot see that: `new Set(records)` counted it
// twice and inflated every cross-run number (forward-pass L-7). Identity comes from the chain
// instead: length + the first event's payload hash + the last event's prev_hash pin one chain
// without re-hashing anything. A record with no events keeps its position, never merging blindly.
// Null when the chain is too short to identify itself. `prev_hash` commits to events 0..N-2, so
// a chain needs at least two events before its key discriminates: a lone `run.started` from two
// different runs of the SAME prompt is byte-identical apart from a timestamp, and two runs
// started in one millisecond would merge. Over-counting a duplicate is a cosmetic error;
// merging two real runs silently destroys one, so the weak case declines to answer.
function runKey(r) {
  try {
    const evs = typeof r?.events === 'function' ? r.events() : [];
    if (evs.length < 2) return null;
    const first = evs[0], last = evs[evs.length - 1];
    // the last event needs its OWN contribution (output_hash) or two runs differing only in how
    // they ended — done vs budget — would share a key.
    return [evs.length, first.ts ?? '', first.input_hash ?? '', last.output_hash ?? '', last.prev_hash ?? ''].join(':');
  } catch { return null; }
}
// Object identity AND chain identity: the first catches the same record passed twice (including
// a one-event one), the second catches the same run arriving as two different objects.
function dedupeRecords(records) {
  const byChain = new Map(); const byObject = new Set(); const out = [];
  for (const r of (records || [])) {
    if (byObject.has(r)) continue;
    const k = runKey(r);
    if (k !== null && byChain.has(k)) continue;
    if (k !== null) byChain.set(k, r);
    byObject.add(r);
    out.push(r);
  }
  return out;
}

export function foldReuse(records, { minRuns = 3 } = {}) {
  const runsByFact = new Map();
  dedupeRecords(records).forEach((r, i) => { // the same run twice, by any object, is one run
    for (const n of foldOutcome(r.events(), r.resolve).recalled) {
      if (!runsByFact.has(n)) runsByFact.set(n, new Set());
      runsByFact.get(n).add(i);
    }
  });
  return [...runsByFact].filter(([, s]) => s.size >= minRuns)
    .map(([name, s]) => ({ name, runs: s.size, kind: 'reuse', polarity: 'neutral', weight: 0.3 }));
}

// ──────────────────────────────────────────────── stop reasons (D1) ──

// How runs end, across every record on disk — khiladi's Q3 ("instrument the
// stop-reason distribution first") as a read-only fold. `records` are anything
// with `events()` + `resolve()` (a recorder, a loadRecord, an index row's rec).
// Counts by stop (the loop's own word), by derived status (the 139c381 rule), and
// by budget axis; `unfinished` are records with no run.stopped at all. Nothing
// here writes; a caller renders the histogram wherever the index is rebuilt.
export function foldStopReasons(records, { gated = true } = {}) {
  const byStop = {}, byStatus = {}, byAxis = {};
  let runs = 0, unfinished = 0;
  const bump = (m, k) => { m[k] = (m[k] || 0) + 1; };
  for (const r of dedupeRecords(records)) {
    if (!r || typeof r.events !== 'function') continue;
    const ev = r.events(); runs++;
    const st = foldStatus(ev, r.resolve, { gated });
    if (st.phase !== 'stopped') { unfinished++; bump(byStatus, 'running'); continue; }
    bump(byStop, st.stop || 'unknown'); bump(byStatus, st.status);
    if (st.stop === 'budget') bump(byAxis, st.axis || 'unknown');
  }
  return { runs, unfinished, byStop, byStatus, byAxis };
}

// One line for a log pane: "12 runs · done 7 · unclaimed 2 · error 2 · idle 1 (budget: wall-clock 1)".
export function stopReasonsLine(h) {
  if (!h || !h.runs) return 'no runs recorded';
  const parts = Object.entries(h.byStatus).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`);
  const axes = Object.entries(h.byAxis).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${h.runs} run${h.runs === 1 ? '' : 's'} · ${parts.join(' · ')}${axes ? ` (budget: ${axes})` : ''}`;
}

// ────────────────────────────────────────────────── skill usage (C4) ──

// How often each skill was DELIBERATELY loaded — `skill` tool calls, per run — the
// telemetry the curator ages skills by. Injection into the index never counts
// (NOOA: spontaneous injection is logged but must never self-reinforce); only a call
// the model chose to make does. `records` are anything with events() + resolve().
// Returns Map name -> { views, runs, lastUsed (ms ts of the latest call), firstUsed }.
export function foldSkillUsage(records) {
  const out = new Map();
  dedupeRecords(records).forEach((r, i) => {
    if (!r || typeof r.events !== 'function') return;
    for (const e of joined(r.events(), r.resolve)) {
      if (e.tool !== 'tool.called' || e.input?.name !== 'skill') continue;
      const name = e.input?.args?.name; if (!name) continue;
      const u = out.get(name) || { views: 0, runs: new Set(), lastUsed: 0, firstUsed: Infinity };
      u.views++; u.runs.add(i); u.lastUsed = Math.max(u.lastUsed, e.ts || 0); u.firstUsed = Math.min(u.firstUsed, e.ts || Infinity);
      out.set(name, u);
    }
  });
  for (const [k, u] of out) out.set(k, { views: u.views, runs: u.runs.size, lastUsed: u.lastUsed, firstUsed: u.firstUsed === Infinity ? null : u.firstUsed });
  return out;
}

// ────────────────────────────────────────────── history / retrieval (B2) ──

// The retrieval half of the substrate (the "audit-state" thread): a fresh turn
// rehydrates by SEARCHING its own record, not by inheriting a lossy summary. Pure
// over the record — a grep across the joined events' payloads, sliced by role, plus
// a paged read of one event. `entries` are { runId, record } where record is a
// loadRecord-shaped object (events() + resolve). The id a hit carries — `runId#idx`
// — reads back through readEvent.
//
// Role slices: what each holon recovers (the thread's "different holons recover
// different slices"). reviewer → what the tools did/changed; supervisor → the
// trajectory (turns + stops); default → the transcript a next turn needs.
export const HISTORY_ROLES = Object.freeze({
  reviewer: new Set(['tool.called', 'tool.responded', 'tool.failed', 'verify.passed', 'verify.failed']),
  supervisor: new Set(['turn.started', 'run.stopped', 'verify.passed', 'verify.failed', 'run.checkpoint']),
  default: new Set(['run.started', 'assistant.said', 'llm.responded', 'tool.responded', 'tool.failed', 'verify.failed', 'run.checkpoint']),
});

// The searchable / readable text of one joined event — never raw base64 or a data:
// URI (a recorded image or binary result is summarised, never inlined).
// A payload too opaque to inline in a search hit. A data: URI is unambiguous. A bare blob is a
// guess, so it is made a NARROW one: hex is a subset of the base64 alphabet, so the old
// length+charset test swallowed long hex TEXT — a checksum table, a hexdump — and hid it from
// search (forward-pass L-4).
//
// Charset alone cannot settle it, because base64 of zero bytes is a run of "A"s, which is also
// valid hex. Symbol DIVERSITY separates them: a real hexdump draws on most of the 16 hex
// symbols, while a degenerate run of one or two characters carries no searchable content
// whatever it encodes. So: pure hex AND ≥8 distinct symbols reads as text; anything else that
// is a long unbroken blob is clipped, and `read` can still page it.
const DATA_URI_RE = /^data:[^;,]*;base64,/;
const B64_BLOB_RE = /^[A-Za-z0-9+/]{2000,}={0,2}$/;
const HEX_RE = /^[0-9a-f]+$/i;
function distinctEnough(s, min = 8) {
  const seen = new Set();
  for (const c of s) { seen.add(c); if (seen.size >= min) return true; }
  return false;
}
function looksHexText(s) { return HEX_RE.test(s) && distinctEnough(s); }
function looksBinary(s) { return DATA_URI_RE.test(s) || (B64_BLOB_RE.test(s) && !looksHexText(s)); }
function eventText(e) {
  const inp = e.input || {}, out = e.output || {};
  const clip = (v) => { const s = String(v ?? ''); return looksBinary(s.trim()) ? `[${s.length} bytes binary/base64 — not inlined; read the event to page it]` : s; };
  switch (e.tool) {
    case 'run.started': return (inp.messages || []).filter((m) => m.role === 'user').map((m) => `[user] ${String(m.content ?? '')}`).join('\n');
    case 'assistant.said': return `[assistant] ${out.content ?? ''}`;
    case 'llm.responded': return out.content ? `[assistant] ${out.content}` : '';
    case 'tool.called': return `[tool ${inp.name}] ${clip(inp.args && (inp.args.command || inp.args.path || inp.args.file || JSON.stringify(inp.args)))}`;
    case 'tool.responded': return `[result ${inp.name || ''}] ${clip(out.result)}`;
    case 'tool.failed': return `[error ${inp.name || ''}] ${clip(out.error)}`;
    case 'verify.passed': return '[gate] passed';
    case 'verify.failed': return `[gate] failed (round ${inp.round ?? 1}) exit ${out.verdict?.exit ?? '?'}`;
    case 'run.checkpoint': return `[checkpoint] ${clip(out.handoff)}`;
    case 'run.stopped': return `[stopped] ${out.stop}${out.reason ? ` (${out.reason})` : ''}${out.axis ? ` [${out.axis}]` : ''}`;
    case 'turn.started': return `[turn ${inp.step ?? '?'}]`;
    default: return '';
  }
}

function centredExcerpt(text, at, span = 120) {
  const start = Math.max(0, at - span), end = Math.min(text.length, at + span);
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

// Search across records, newest event first. Returns hits [{ id, runId, tool, ts, excerpt }].
export function searchRecords(entries, { query, role = 'default', limit = 20 } = {}) {
  const q = String(query ?? '').toLowerCase();
  if (!q) return [];
  const slice = HISTORY_ROLES[role] || HISTORY_ROLES.default;
  const hits = [];
  for (const { runId, record } of (entries || [])) {
    if (!record || typeof record.events !== 'function') continue;
    const evs = joined(record.events(), record.resolve);
    for (let i = 0; i < evs.length; i++) {
      const e = evs[i];
      if (!slice.has(e.tool)) continue;
      const text = eventText(e); if (!text) continue;
      const at = text.toLowerCase().indexOf(q); if (at === -1) continue;
      hits.push({ id: `${runId}#${i}`, runId, tool: e.tool, ts: e.ts ?? null, excerpt: centredExcerpt(text, at) });
    }
  }
  hits.sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0)); // newest first
  return hits.slice(0, limit);
}

// Read one event's full text by id (`runId#idx`), paged. Returns { id, tool, text,
// nextOffset } — nextOffset is null when the event is fully read. `limit` is the
// caller's budget (B4); binaries are summarised by eventText, so a read is bounded.
export function readEvent(entries, id, { offset = 0, limit = 4000 } = {}) {
  const hash = String(id ?? '').lastIndexOf('#');
  if (hash < 0) return { id, error: 'bad id — expected runId#index' };
  const runId = String(id).slice(0, hash), idx = Number(String(id).slice(hash + 1));
  const entry = (entries || []).find((x) => String(x.runId) === runId);
  if (!entry || !entry.record) return { id, error: `no record ${runId}` };
  const evs = joined(entry.record.events(), entry.record.resolve);
  const e = evs[idx];
  if (!e) return { id, error: `no event ${idx} in ${runId}` };
  const full = eventText(e);
  const start = Math.max(0, offset | 0);
  const end = Math.min(full.length, start + Math.max(1, limit | 0));
  return { id, tool: e.tool, ts: e.ts ?? null, text: full.slice(start, end), nextOffset: end < full.length ? end : null, total: full.length };
}

// The tool the agent calls to search and read its own run history.
export function historyTool() {
  return {
    type: 'function',
    function: {
      name: 'history',
      description: 'Search or read this project\'s run history — your own past runs, recorded event by event. ' +
        'op "search": find where something happened (query, optional scope run|task|project, optional role reviewer|supervisor); ' +
        'returns hits with an id, newest first. op "read": load one event\'s full text by id (paged with offset). ' +
        'Use this to recover what an earlier run did instead of guessing.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['search', 'read'] },
          query: { type: 'string', description: 'search: text to find (case-insensitive)' },
          scope: { type: 'string', enum: ['run', 'task', 'project'], description: 'search: how far back (default task)' },
          role: { type: 'string', enum: ['default', 'reviewer', 'supervisor'], description: 'search: which slice of events (default: the transcript)' },
          id: { type: 'string', description: 'read: the event id from a search hit (runId#index)' },
          offset: { type: 'integer', description: 'read: character offset to continue from (default 0)' },
        },
        required: ['op'],
      },
    },
  };
}

// ─────────────────────────────────────────── recovery record (B3) ──

// The stale-steer fix (the "audit-state" reply): a next turn must not re-apply an
// instruction it already satisfied, and must not read coordination (a gate verdict, a
// nudge) as the owner's words. This is a PURE fold over ONE run's record — deterministic,
// so the annotation is a function of the record, never of when it ran (the strict-replay
// guarantee). It ANNOTATES; it does not drop the transcript (Anvil still carries the paired
// transcript so a follow-up resumes — this rides alongside as guidance).
//
// Each owner input (a user message in the record's run.started) gets a resolution:
//   open              — the latest owner input, or one with no completion signal after it
//   likely-satisfied  — a verified gate pass (verify.passed) was recorded AFTER it; HEDGED,
//                       never a hard claim, because a task-level gate may not cover a specific
//                       steer — the next turn should verify, not silently redo (and never
//                       silently skip). Worst case is a cheap re-verify, never a dropped steer.
export function foldRecovery(events, resolve) {
  const ev = joined(events, resolve);
  // Collect owner (user) inputs across every run.started, deduped by text: a re-entered loop
  // (nudge) repeats the earlier prompts in its run.started, and a repeat is not a new input.
  const ownerInputs = []; const seenText = new Set();
  ev.forEach((e, i) => {
    if (e.tool !== 'run.started') return;
    for (const m of ((e.input && e.input.messages) || [])) {
      if (m.role !== 'user') continue;
      const text = String(m.content ?? ''); const norm = text.replace(/\s+/g, ' ').trim();
      if (/^\[coordination\]/.test(norm)) continue; // a tagged gate verdict / nudge is not an owner input
      if (seenText.has(norm)) continue; seenText.add(norm);
      ownerInputs.push({ text, atIndex: i, id: `#${i}` });
    }
  });
  // A gate pass anywhere in the record is a completion signal for inputs before it.
  const passIndex = ev.findIndex((e) => e.tool === 'verify.passed');
  const lastCheckpoint = [...ev].reverse().find((e) => e.tool === 'run.checkpoint');
  const coordinationCount = ev.filter((e) => e.tool === 'verify.failed').length;
  const annotated = ownerInputs.map((inp, k) => {
    const isLatest = k === ownerInputs.length - 1;
    const gatePassedAfter = passIndex !== -1 && passIndex > inp.atIndex;
    const resolution = isLatest ? 'open' : (gatePassedAfter ? 'likely-satisfied' : 'open');
    return { ...inp, resolution };
  });
  return {
    ownerInputs: annotated,
    coordinationCount,
    checkpoint: lastCheckpoint ? String(resolve(lastCheckpoint)?.output?.handoff ?? '') : null,
  };
}

// A compact, human/model-readable note from foldRecovery — prepended to a resumed run as
// guidance (a system line), so the model sees which prior asks are likely handled and that
// coordination lines are not the owner's.
export function recoveryNote(rec) {
  if (!rec || !rec.ownerInputs || !rec.ownerInputs.length) return '';
  const lines = rec.ownerInputs.map((inp) => {
    const tag = inp.resolution === 'likely-satisfied' ? ' — likely handled (a gate passed after it); verify before redoing' : ' — open';
    return `  • "${inp.text.replace(/\s+/g, ' ').slice(0, 100)}"${tag}`;
  });
  const foot = rec.coordinationCount ? `\n(${rec.coordinationCount} gate-feedback line(s) in the transcript are marked [coordination] — they are not the owner's instructions.)` : '';
  const cp = rec.checkpoint ? `\nLast checkpoint: ${rec.checkpoint.replace(/\s+/g, ' ').slice(0, 200)}` : '';
  return 'Recovery note (from the run record — prior owner requests and whether they look handled):\n' + lines.join('\n') + foot + cp;
}

// ──────────────────────────────────────── supervisor / stagnation (D2) ──

// A supervisor that REDIRECTS, as a pure fold over one run's record (AVO's stagnation
// detector; khiladi item 4). It fires only on UNAMBIGUOUS spinning, never on legitimate
// repetition (reading many different files is not a stall):
//   repeat      the SAME tool signature (name + exact args) run ≥ repeatN times
//   gate-stuck  ≥2 failed gate rounds with NO new file touched between the last two
//   no-tools    the latest loop segment produced turns but zero tool calls
// Returns { stalled, signal, detail } — the caller injects ONE capped nudge and re-loops.
// Key-order-stable JSON: the model may emit the same args with keys in a different order, and a
// stall is a stall regardless (D2 checker finding). Sort object keys recursively before compare.
// The arg keys that mean a call WROTE something (as opposed to merely naming a path, which a
// read does too). Used by the gate-stuck window to tell a fix attempt from a re-read. Covers
// every write tool in agent-tools.mjs: write{path,content}, edit{path,new_string},
// apply_patch{patch}, edit_lines{edit} — note the last two carry NO path, which is why the
// window keys on the payload rather than on a filename.
const WRITE_PAYLOAD = ['content', 'contents', 'text', 'patch', 'edit', 'data', 'body', 'new_string', 'replacement'];
function stableArgs(v) {
  if (Array.isArray(v)) return '[' + v.map(stableArgs).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stableArgs(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

export function foldStagnation(events, resolve, { repeatN = 3, noToolTurns = 1 } = {}) {
  const ev = joined(events, resolve);
  // 1. identical tool signatures (name + exact args), across the whole run.
  const sig = new Map();
  const touchedFile = (a) => a && (a.path || a.file) ? String(a.path || a.file) : null;
  for (const e of ev) {
    if (e.tool !== 'tool.called') continue;
    const k = `${e.input?.name}:${stableArgs(e.input?.args ?? {})}`;
    sig.set(k, (sig.get(k) || 0) + 1);
  }
  for (const [k, n] of sig) if (n >= repeatN) return { stalled: true, signal: 'repeat', detail: `the same call ran ${n}× (${k.slice(0, 80)}) — try a different approach` };

  // 2. gate stuck: between the last two failed rounds, NOTHING NEW was written. Keyed on the
  // whole call (path AND content), not the path alone: re-editing the same file with DIFFERENT
  // content across two failed rounds IS the normal fix loop, and calling that a stall nudged
  // healthy work. A repeat of a byte-identical edit is still a stall. (forward-pass M-2.)
  const failIdx = ev.map((e, i) => (e.tool === 'verify.failed' ? i : -1)).filter((i) => i >= 0);
  if (failIdx.length >= 2) {
    const [prev, last] = [failIdx[failIdx.length - 2], failIdx[failIdx.length - 1]];
    // Only a call carrying a write PAYLOAD counts as progress, and the payload — not a path —
    // is the test. Keying on any path-bearing call would let a read-only spin (one file re-read
    // at a new offset each round) read as "something new"; requiring a path as well would miss
    // apply_patch and edit_lines, which write without naming one.
    const writeSig = (e) => {
      if (e.tool !== 'tool.called') return null;
      const a = e.input?.args; if (!a || !WRITE_PAYLOAD.some((k) => a[k] !== undefined)) return null;
      return `${e.input?.name}:${stableArgs(a)}`;
    };
    const seenBefore = new Set();
    for (let i = 0; i < prev; i++) { const s = writeSig(ev[i]); if (s) seenBefore.add(s); }
    let progressed = false;
    for (let i = prev; i < last; i++) { const s = writeSig(ev[i]); if (s && !seenBefore.has(s)) { progressed = true; break; } }
    if (!progressed) return { stalled: true, signal: 'gate-stuck', detail: `${failIdx.length} gate rounds and nothing new written since the last failure — the fix is not landing` };
  }

  // 3. no tools in the latest loop segment (since the last run.started), but turns happened.
  let segStart = 0;
  for (let i = ev.length - 1; i >= 0; i--) if (ev[i].tool === 'run.started') { segStart = i; break; }
  const seg = ev.slice(segStart);
  const turns = seg.filter((e) => e.tool === 'turn.started').length;
  const toolCalls = seg.filter((e) => e.tool === 'tool.called').length;
  if (turns >= noToolTurns && toolCalls === 0) return { stalled: true, signal: 'no-tools', detail: 'the last run answered in prose with no tool calls — use the tools to make the change' };

  return { stalled: false, signal: null, detail: '' };
}

// The single redirect message a stalled run is nudged with (D2). Coordination, not the owner —
// tagged so it can never read as the owner's instruction (B3).
export function stagnationNudge(stag) {
  if (!stag || !stag.stalled) return '';
  return `[coordination] You appear to be stuck: ${stag.detail}. Step back and try a different approach — a different tool, a smaller step, or re-reading the goal — rather than repeating what has not worked.`;
}

// F1 — the invariant that makes this file's opening claim checkable.
//
// The header says the carried transcript IS a projection of the log. Until now nothing enforced
// it, and it was quietly FALSE: compaction rewrote the surface and stored the result outside the
// record. This compares what is about to be SENT against what the chain can reproduce, and names
// the first message that differs.
//
// It DETECTS; it does not throw. A divergence is diagnostic, not dangerous, and killing a live
// run over one would do more damage than the drift it found. The caller decides what to do.
// System messages are excluded because foldTranscript deliberately drops them.
export function reconstructionCheck(sent, events, resolve) {
  const want = foldSurface(events, resolve);
  const got = (Array.isArray(sent) ? sent : []).filter((m) => m && m.role !== 'system');
  const key = (m) => JSON.stringify([m?.role ?? null, m?.content ?? null, m?.tool_call_id ?? null,
                                     (m?.tool_calls || []).map((c) => c?.id ?? null)]);
  if (got.length !== want.length) {
    return { ok: false, at: Math.min(got.length, want.length),
             why: `length: sending ${got.length}, the record reconstructs ${want.length}` };
  }
  for (let i = 0; i < got.length; i++) {
    if (key(got[i]) !== key(want[i])) {
      return { ok: false, at: i, why: `message ${i} differs: sending ${key(got[i]).slice(0, 120)}, record has ${key(want[i]).slice(0, 120)}` };
    }
  }
  return { ok: true, at: -1, why: '' };
}

// The transcript as it was actually SENT: foldTranscript, then every recorded compaction applied
// in order. This is the function F1's invariant compares against — the claim at the top of this
// file ("the carried transcript is a projection") is only checkable because this exists.
//
// The shadowed span is a POSITION range, not a numeric interval: `from`/`to` index the surface as
// it stood when that compaction ran, so replacements must be applied in recorded order. An
// out-of-range span is ignored rather than throwing, because a fold must never be the thing that
// breaks a run.
export function foldSurface(events, resolve) {
  let surface = foldTranscript(events, resolve);
  for (const e of joined(events, resolve)) {
    if (e.tool !== 'run.compacted') continue;
    const { from = 0, to = 0 } = e.input || {};
    const replacement = (e.output && Array.isArray(e.output.replacement)) ? e.output.replacement : [];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < from || to > surface.length) continue;
    surface = [...surface.slice(0, from), ...replacement, ...surface.slice(to)];
  }
  return surface;
}

// Was a compaction started and never finished? A crash mid-compaction leaves the surface
// unresolvable; saying so is better than silently serving a half-applied transcript.
export function compactionOrphaned(events, resolve) {
  const ev = joined(events, resolve).filter((e) => e.tool === 'run.compacted');
  return ev.some((e) => !(e.output && Array.isArray(e.output.replacement)));
}

// ─────────────────────────────────── session context + decisions (C2) ──

// The inputs the post-run review fork reasons over (Agno's SessionContext + DecisionLog),
// derived from ONE run's record. Pure.

// {goal, lastCheckpoint, filesTouched, outcome} — what the run was for and how it went.
export function foldSessionContext(events, resolve) {
  const ev = joined(events, resolve);
  const started = ev.find((e) => e.tool === 'run.started');
  const goal = started ? String((((started.input && started.input.messages) || []).find((m) => m.role === 'user') || {}).content ?? '') : '';
  const lastCheckpoint = (() => { const c = [...ev].reverse().find((e) => e.tool === 'run.checkpoint'); return c ? String(c.output?.handoff ?? '') : null; })();
  const filesTouched = [...new Set(ev.filter((e) => e.tool === 'tool.called').map((e) => e.input?.args?.path || e.input?.args?.file).filter(Boolean).map(String))];
  const outcome = foldOutcome(events, resolve).label;
  return { goal, lastCheckpoint, filesTouched, outcome };
}

// A DecisionLog: each tool call paired with the gate verdict that followed it (the next
// verify.passed/verify.failed before the next tool call), so the review can see which moves led
// to a pass and which to a failure. Pure.
export function foldDecisions(events, resolve) {
  const ev = joined(events, resolve);
  const out = [];
  for (let i = 0; i < ev.length; i++) {
    const e = ev[i]; if (e.tool !== 'tool.called') continue;
    const sig = `${e.input?.name}:${stableArgs(e.input?.args ?? {})}`.slice(0, 200);
    let outcome = 'none';
    for (let j = i + 1; j < ev.length; j++) {
      if (ev[j].tool === 'tool.called') break;
      if (ev[j].tool === 'verify.passed') { outcome = 'passed'; break; }
      if (ev[j].tool === 'verify.failed') { outcome = 'failed'; break; }
    }
    out.push({ toolSignature: sig, name: e.input?.name, outcome });
  }
  return out;
}
