#!/usr/bin/env node
// AC-3's payoff: what is each procedural edge WORTH?
//   node scripts/bench-procedural.mjs [--base URL] [--model ID] [--key KEY] [--tasks a,b] [--record DIR] [--replay DIR] [--full-only]
//
// N1 (2026-09-12): the bed runs what the app runs — prompt, toolset, budgets (24 steps / 900 s,
// then the re-loops), hooks, act-or-nudge and supervisor all come from sys/ai/run-assembly.mjs.
// There is no --max-steps: a bed that caps the app's budget measures a different product.
//
// Six transitions have been in Anvil's system prompt since it was written. None was ever measured.
// The procedural-graph work (arXiv:2609.09153) reports that a hand-crafted prior can be WORSE THAN
// NONE, so "it is only a sentence" is not a reason to assume it is free.
//
// Arms: `full` (every edge) and `-<edge>` (every edge but that one), per task. Metrics come from
// the record — foldOutcome's label plus AC-1's ordering, so a change in WHEN the agent acted shows
// up even when the outcome is identical. That is the metric this benchmark exists to read.
//
// A LIVE model is the point. The scripted fixtures in ablate-fixtures.mjs cannot answer this: the
// question is whether removing a sentence changes what a real model does, and a scripted model
// does what the script says. Runs against the test bed (hermes proxy or Ollama); pre-flight first.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAblation, renderTable } from '../sys/ai/ablate.mjs';
import { makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { DEFAULT_GRAPH, renderProcedural, proceduralEdges } from '../sys/ai/procedural.mjs';
import { systemMessage, gateNote, runToolset, driveRun, withHooks, withBedStubs, loadHooks, EMPTY_HOOKS } from '../sys/ai/run-assembly.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const BASE = opt('--base', 'http://127.0.0.1:11434/v1');
const MODEL = opt('--model', 'qwen3-32k:8b');
const KEY = opt('--key', 'local');
const ONLY = (opt('--tasks') || '').split(',').filter(Boolean);
const recordDir = opt('--record'), replayDir = opt('--replay');
// --full-only: the `full` arm alone (one run per task) — a smoke or a paid proof, not an ablation.
const FULL_ONLY = args.includes('--full-only');
const CALL_TIMEOUT = Number(opt('--timeout', '180')) * 1000;
// Who answers, stamped on every loop's run.started as the app stamps its configured endpoint.
const MODEL_STAMP = () => ({ id: MODEL, provider: (() => { try { return new URL(BASE).host; } catch (_) { return null; } })(), label: MODEL });

// Progress goes to stderr as it happens. The first version of this script had neither a timeout
// nor progress, and a blocked fetch was indistinguishable from a slow model for several minutes —
// the same silent-refusal shape as the stale-`running` bug. A benchmark that can hang forever with
// nothing on screen is not a benchmark.
let calls = 0;
const since = Date.now();
const log = (m) => process.stderr.write(`  [${String(Math.round((Date.now() - since) / 1000)).padStart(4)}s] ${m}\n`);

const EDGES = proceduralEdges();
// N1 (2026-09-12): the prompt, the toolset, the budgets and the re-loops are the APP's — imported
// from sys/ai/run-assembly.mjs, not transcribed here. The first version of this bench hand-wrote a
// shorter prompt and a shell-only toolset, and the prior it was meant to ablate said "prefer
// edit/apply_patch" about tools that did not exist in that arm: a prior CONTRADICTED, not ablated,
// and a table of zeroes. The prior itself is still the variable: every edge except this arm's.
function priorFor(caps) {
  const disable = EDGES.filter((e) => caps[e] === false); // absent = on (--full-only names no edge)
  return renderProcedural(DEFAULT_GRAPH, { disable });
}

function freshShell(seed = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return { shell: createShell({ registry, face }), face, fs, seed };
}

// One live OpenAI-compatible call. No streaming, no retry ladder — a benchmark that silently
// retries is a benchmark measuring the retry.
function liveInfer(label) {
  return async ({ messages, tools }) => {
    const n = ++calls;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), CALL_TIMEOUT);
    const t0 = Date.now();
    let res;
    try {
      res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', stream: false, temperature: 0 }),
        signal: ac.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      // A timeout is DATA, not a crash: it ends this arm, and the arm is reported as it ended.
      // Swallowing it would silently turn a stalled arm into a short one.
      log(`${label} call ${n} FAILED after ${Math.round((Date.now() - t0) / 1000)}s: ${err.name === 'AbortError' ? `timeout >${CALL_TIMEOUT / 1000}s` : err.message}`);
      throw err;
    }
    clearTimeout(timer);
    const json = await res.json().catch(() => null);
    log(`${label} call ${n}: ${Math.round((Date.now() - t0) / 1000)}s, ${json?.usage?.prompt_tokens ?? '?'}+${json?.usage?.completion_tokens ?? '?'} tok, ${(json?.choices?.[0]?.message?.tool_calls || []).length} tool call(s)`);
    if (!res.ok) throw new Error(`http ${res.status}: ${String(json?.error?.message || '').slice(0, 120)}`);
    const m = json?.choices?.[0]?.message || {};
    return {
      content: m.content || '',
      toolCalls: (m.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } })),
      finishReason: json?.choices?.[0]?.finish_reason,
      model: json?.model || MODEL,
    };
  };
}

// ── the tasks ─────────────────────────────────────────────────────────────
// Each is chosen because a SPECIFIC edge is meant to matter to it, and each has a machine gate.
// A task no edge should affect is worth as much as one that should: it is the control.

const TASKS = {
  // read-before-edit / prefer-surgical: the file already exists and must keep its other lines.
  'edit-in-place': {
    seed: { 'config.txt': 'name = anvil\nport = 8080\ndebug = false\nowner = chirag\n' },
    prompt: 'The file config.txt exists. Change the port to 9090. Every other line must be left exactly as it is.',
    gate: async (ctx) => {
      const r = await ctx.fs.read('config.txt', { encoding: 'utf-8' });
      const t = (r && r.ok && r.data) || '';
      const ok = t.includes('port = 9090') && t.includes('name = anvil') && t.includes('debug = false') && t.includes('owner = chirag');
      return { ok, exit: ok ? 0 : 1, stdout: t, stderr: ok ? '' : `config.txt is ${JSON.stringify(t).slice(0, 120)}` };
    },
  },
  // shell-to-verify: the answer is only obtainable by running something, not by assuming.
  'count-matches': {
    seed: { 'a.py': 'def solve():\n    pass\n', 'b.py': 'x = 1\n', 'c.py': 'def solve(n):\n    return n\n' },
    prompt: 'How many .py files in this directory contain the text "def solve"? Write just that number into answer.txt and nothing else.',
    gate: async (ctx) => {
      const r = await ctx.fs.read('answer.txt', { encoding: 'utf-8' });
      const t = ((r && r.ok && r.data) || '').trim();
      const ok = t === '2';
      return { ok, exit: ok ? 0 : 1, stdout: t, stderr: ok ? '' : `answer.txt says ${JSON.stringify(t)}, expected "2"` };
    },
  },
  // The control: no edge in the graph speaks to creating one new file.
  'control-new-file': {
    seed: {},
    prompt: 'Create a file called hello.txt containing exactly the word hello.',
    gate: async (ctx) => {
      const r = await ctx.fs.read('hello.txt', { encoding: 'utf-8' });
      const t = ((r && r.ok && r.data) || '').trim();
      const ok = t === 'hello';
      return { ok, exit: ok ? 0 : 1, stdout: t, stderr: ok ? '' : 'hello.txt missing or not exactly "hello"' };
    },
  },
};

function buildTask(id, spec) {
  // The gate is a function over the workspace, not a shell command; the note names the bench.
  const gate = gateNote('bench gate: ' + id);
  return {
    id,
    // With a driver, `messages` is the CARRIED conversation — the driver builds the prefix itself.
    messages: () => [{ role: 'user', content: spec.prompt }],
    tools: () => runToolset('code', { verify: true }),
    // The arm's model is also what a `task` subagent runs on (unrecorded in this layer, as in the app).
    model: (caps, ctx) => (ctx.infer = liveInfer(`${id}/${EDGES.filter((e) => caps[e] === false).map((e) => '-' + e).join(',') || 'full'}`)),
    executeTool: (caps, ctx) => {
      const s = freshShell();
      ctx.fs = s.fs; ctx.shell = s.shell; ctx.hooks = EMPTY_HOOKS;
      // Seed the workspace before the agent sees it; a seeded .anvil/hooks.json is honoured.
      ctx.ready = (async () => { for (const [p, c] of Object.entries(spec.seed)) await s.fs.write(p, c); ctx.hooks = await loadHooks(s.fs); })();
      // The app's executor layers the bed can have: hooks around the base executor (with `task`
      // subagents on the same model); the store-backed tools answer with an honest bed stub.
      const exec = withHooks(withBedStubs(makeToolExecutor({ shell: s.shell, face: s.face, mode: 'code', infer: ctx.infer })), { hooks: () => ctx.hooks, shellFor: () => s.shell });
      return async (...a) => { await ctx.ready; return exec(...a); };
    },
    gate: (_caps, ctx) => async () => { await ctx.ready; return spec.gate(ctx); },
    // The app's driver: first loop on RUN_BUDGET, then act-or-nudge and the supervisor, every loop
    // recorded on this arm's chain.
    driver: (caps) => ({ messages, tools, infer, executeTool, verify, rec, onEvent }) => driveRun({
      mode: 'code', convo: messages, sysMsg: (extra) => systemMessage({ mode: 'code', proceduralPrior: priorFor(caps), extra }),
      tools, infer, executeTool, rec, verify, onEvent, gateNote: gate, model: MODEL_STAMP,
    }),
  };
}

const chosen = Object.entries(TASKS).filter(([id]) => !ONLY.length || ONLY.includes(id));
if (!chosen.length) { console.error(`no such task. known: ${Object.keys(TASKS).join(', ')}`); process.exit(2); }

let records = null;
if (replayDir) records = JSON.parse(await readFile(join(replayDir, 'procedural.json'), 'utf8'));

const ARMS = FULL_ONLY ? [] : EDGES;
console.error(`bench-procedural: ${chosen.length} task(s) x ${ARMS.length + 1} arms = ${chosen.length * (ARMS.length + 1)} runs${FULL_ONLY ? ' (--full-only)' : ''}`);
console.error(`  model ${MODEL} @ ${BASE}${replayDir ? '  (REPLAY)' : ''}`);
const t0 = Date.now();
const result = await runAblation({
  tasks: chosen.map(([id, spec]) => buildTask(id, spec)),
  capabilities: ARMS,
  records,
  principal: 'bench-procedural',
});
console.error(`  ${Math.round((Date.now() - t0) / 1000)}s, ${result.liveCalls} live model call(s)\n`);

// A VOID arm is one the provider never really answered: zero tool calls and no assistant text.
// Observed in bursts on the free tier — whole tasks came back `failure 1s / anchor none` in
// repeats 1 and 3 while repeat 2 was clean. foldOutcome correctly calls that a failure (the run
// did not finish), but scoring it as a TASK failure would attribute a provider hiccup to whichever
// edge that arm happened to be ablating. Same discipline as AC-1's null-never-zero: "we could not
// measure this" and "this did worse" are different findings.
const isVoid = (m) => m.toolCalls === 0 && m.steps <= 1 && m.label !== 'success';
const voids = [];
for (const r of result.rows) {
  if (isVoid(r.full)) voids.push(`${r.task}/full`);
  if (isVoid(r.without)) voids.push(`${r.task}/-${r.capability}`);
}
const uniqueVoids = [...new Set(voids)];
// --full-only has no deltas to tabulate; say how the one arm ended, from the record.
if (FULL_ONLY) for (const [task, arms] of Object.entries(result.byArm)) { const m = arms.full; console.log(`${task}/full: ${m.label} (score ${m.score}) — ${m.steps} step(s), ${m.toolCalls} tool call(s), ${m.failedRounds} failed gate round(s), ${m.liveCalls} live call(s)`); }
else console.log(renderTable(result));
if (uniqueVoids.length) {
  console.log(`\nVOID (provider returned nothing — not a task failure, and no delta involving one is real): ${uniqueVoids.length} arm(s)`);
  console.log(`  ${uniqueVoids.join(', ')}`);
  console.log('  Re-run before reading any row above that names one of these.');
}

if (recordDir) {
  await mkdir(recordDir, { recursive: true });
  await writeFile(join(recordDir, 'procedural.json'), JSON.stringify(result.records));
  console.log(`\nrecorded → ${join(recordDir, 'procedural.json')} (replay with --replay ${recordDir})`);
}
if (replayDir && result.liveCalls !== 0) { console.error(`replay made ${result.liveCalls} live call(s) — the records do not cover this matrix`); process.exit(1); }
