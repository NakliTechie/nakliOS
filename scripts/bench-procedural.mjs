#!/usr/bin/env node
// AC-3's payoff: what is each procedural edge WORTH?
//   node scripts/bench-procedural.mjs [--base URL] [--model ID] [--tasks a,b] [--record DIR] [--replay DIR]
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
import { shellTool, makeShellExecutor } from '../sys/ai/agent-loop.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { DEFAULT_GRAPH, renderProcedural, proceduralEdges } from '../sys/ai/procedural.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const BASE = opt('--base', 'http://127.0.0.1:11434/v1');
const MODEL = opt('--model', 'qwen3-32k:8b');
const KEY = opt('--key', 'local');
const ONLY = (opt('--tasks') || '').split(',').filter(Boolean);
const recordDir = opt('--record'), replayDir = opt('--replay');
const MAX_STEPS = Number(opt('--max-steps', '10'));

const EDGES = proceduralEdges();
const HEAD = 'You are a coding agent working over the user\'s files. Tools: shell (a CURATED bash-like shell: ls cat grep rg sed awk find head tail wc sort uniq cut tr test git python, with pipes, && || ; > >> < and globs. Each builtin implements a documented subset and REFUSES an unsupported flag rather than ignoring it). ';
const TAIL = ' Work in small, verifiable steps; end with a one-line summary.';

// The system prompt for one arm: every edge except the ones this arm turns off.
function systemFor(caps) {
  const disable = EDGES.filter((e) => !caps[e]);
  const prior = renderProcedural(DEFAULT_GRAPH, { disable });
  return HEAD + prior + TAIL;
}

function freshShell(seed = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return { shell: createShell({ registry, face }), fs, seed };
}

// One live OpenAI-compatible call. No streaming, no retry ladder — a benchmark that silently
// retries is a benchmark measuring the retry.
function liveInfer() {
  return async ({ messages, tools }) => {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', stream: false, temperature: 0 }),
    });
    const json = await res.json().catch(() => null);
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
      return { passed: ok, verdict: ok ? 'config.txt updated, other lines intact' : `wrong: ${JSON.stringify(t).slice(0, 120)}` };
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
      return { passed: ok, verdict: ok ? 'answer.txt says 2' : `answer.txt says ${JSON.stringify(t)}, expected "2"` };
    },
  },
  // The control: no edge in the graph speaks to creating one new file.
  'control-new-file': {
    seed: {},
    prompt: 'Create a file called hello.txt containing exactly the word hello.',
    gate: async (ctx) => {
      const r = await ctx.fs.read('hello.txt', { encoding: 'utf-8' });
      const ok = ((r && r.ok && r.data) || '').trim() === 'hello';
      return { passed: ok, verdict: ok ? 'hello.txt is correct' : 'hello.txt missing or wrong' };
    },
  },
};

function buildTask(id, spec) {
  return {
    id,
    messages: (caps) => [{ role: 'system', content: systemFor(caps) }, { role: 'user', content: spec.prompt }],
    tools: () => [shellTool()],
    model: () => liveInfer(),
    executeTool: (_caps, ctx) => {
      const s = freshShell();
      ctx.fs = s.fs; ctx.shell = s.shell;
      // Seed the workspace before the agent sees it.
      ctx.ready = (async () => { for (const [p, c] of Object.entries(spec.seed)) await s.fs.write(p, c); })();
      const exec = makeShellExecutor(s.shell);
      return async (...a) => { await ctx.ready; return exec(...a); };
    },
    gate: (_caps, ctx) => async () => { await ctx.ready; return spec.gate(ctx); },
    loopOptions: () => ({ maxSteps: MAX_STEPS }),
  };
}

const chosen = Object.entries(TASKS).filter(([id]) => !ONLY.length || ONLY.includes(id));
if (!chosen.length) { console.error(`no such task. known: ${Object.keys(TASKS).join(', ')}`); process.exit(2); }

let records = null;
if (replayDir) records = JSON.parse(await readFile(join(replayDir, 'procedural.json'), 'utf8'));

console.error(`bench-procedural: ${chosen.length} task(s) x ${EDGES.length + 1} arms = ${chosen.length * (EDGES.length + 1)} runs`);
console.error(`  model ${MODEL} @ ${BASE}${replayDir ? '  (REPLAY)' : ''}`);
const t0 = Date.now();
const result = await runAblation({
  tasks: chosen.map(([id, spec]) => buildTask(id, spec)),
  capabilities: EDGES,
  records,
  principal: 'bench-procedural',
});
console.error(`  ${Math.round((Date.now() - t0) / 1000)}s, ${result.liveCalls} live model call(s)\n`);
console.log(renderTable(result));

if (recordDir) {
  await mkdir(recordDir, { recursive: true });
  await writeFile(join(recordDir, 'procedural.json'), JSON.stringify(result.records));
  console.log(`\nrecorded → ${join(recordDir, 'procedural.json')} (replay with --replay ${recordDir})`);
}
if (replayDir && result.liveCalls !== 0) { console.error(`replay made ${result.liveCalls} live call(s) — the records do not cover this matrix`); process.exit(1); }
