#!/usr/bin/env node
// record-corpus.mjs — capture REAL agent runs into the replay corpus (F2's record mode).
//
//   node scripts/record-corpus.mjs                       # all scenarios, needs a live endpoint
//   node scripts/record-corpus.mjs --only write-a-file
//   OLLAMA=http://127.0.0.1:11434/v1 MODEL=qwen3:8b node scripts/record-corpus.mjs
//
// This is the ONLY thing that needs a model. The gate replays what it writes, keyless — so
// this runs when a scenario is added or deliberately re-captured, never in CI.
//
// What makes a recording replayable: the record keeps the exact messages and tools the run was
// handed, so `replayEntry` re-runs it against its own opening rather than today's app prompt.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRecorder } from '../sys/history/run-record.mjs';
import { runAgentLoop, shellTool, makeShellExecutor, taskDoneTool } from '../sys/ai/agent-loop.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { buildEndpointChatBody, createToolCallAccumulator } from '../sys/ai/agent-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, '..', 'sys', 'history', 'corpus');
const BASE = process.env.OLLAMA || 'http://127.0.0.1:11434/v1';
const MODEL = process.env.MODEL || 'qwen3:8b';

// A real endpoint call, non-streamed: the corpus wants whole responses, and `usage` comes back
// on a non-streamed body without needing stream_options.
async function inferLive({ messages, tools }) {
  const body = buildEndpointChatBody({ model: MODEL, messages, tools, toolChoice: 'auto', stream: false });
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`endpoint ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const data = await r.json();
  const msg = data?.choices?.[0]?.message || {};
  const acc = createToolCallAccumulator();
  acc.absorbMessage(msg);
  return {
    content: typeof msg.content === 'string' ? msg.content : '',
    toolCalls: acc.finalize(),
    finishReason: data?.choices?.[0]?.finish_reason || 'stop',
    usage: data?.usage || null,
  };
}

function freshShell(seed = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return { shell: createShell({ registry, face }), fs, seed };
}

const SYSTEM =
  'You are a coding agent working over the user\'s files. You have one tool: shell. ' +
  'Run one command per call. Work in small, verifiable steps; end with a one-line summary.';

// Scenarios. Each is a real task with a real answer — deliberately small, because the corpus is
// about the LOOP's behaviour, not the model's cleverness.
//
// The last three are Chunk 0's 2b gate conditions (S1). They were closed on 2026-09-04/06 by
// driving Anvil by hand and reading the result, which means re-proving them meant another live
// run. Recorded here they replay keyless, forever, as part of the gate.
//
// `budget` uses the TURNS axis on purpose. Turns and tokens are functions of the transcript, so
// they trip at the same point under replay; wall-clock is not — a replay is instant and would
// never reach it. That axis stays a live-only check, and the corpus does not pretend otherwise.
const SCENARIOS = [
  { name: 'write-a-file',
    prompt: 'Use the shell tool to run exactly: echo hello > greeting.txt   Then say DONE and stop.',
    seed: {} },
  { name: 'read-then-answer',
    prompt: 'Use the shell tool to run exactly: cat fact.txt   Then reply with the single word it contains and stop.',
    seed: { 'fact.txt': 'kiwi\n' } },
  { name: 'refused-command',
    prompt: 'Use the shell tool to run exactly: sort -Z fact.txt   Report the exit code you saw, then stop.',
    seed: { 'fact.txt': 'b\na\n' } },

  // 0.0 — a gate that never passes. The loop feeds the failing verdict back, retries up to
  // maxVerifyRounds, then stops 'unverified'. The model does not get to declare done.
  { name: 'failing-gate',
    // Call task_done FIRST and immediately: the point is what the loop does with a verdict that
    // never passes, so the run must reach the gate rather than wander the workspace.
    prompt: 'Call the task_done tool right now, with no other tool calls and no preamble. The work is already finished.',
    seed: { 'build.log': 'FAIL: 1 test failed\n' },
    gate: { rounds: 2, verdict: { ok: false, exit: 1, stdout: 'FAIL: 1 test failed at spec/build.test.js:12', stderr: '' } },
    expect: 'unverified' },

  // 0.0b — the OTHER way a run reaches the gate: the model stops calling tools and answers in
  // prose. The loop runs the gate on that turn and pushes the verdict back as a USER message —
  // a different branch from the task_done interception above, and one a mutation proved the
  // corpus did not cover.
  { name: 'gate-on-prose',
    prompt: 'Answer in one short sentence and use no tools at all: what does the shell tool do?',
    seed: {},
    gate: { rounds: 2, verdict: { ok: false, exit: 1, stdout: 'FAIL: 1 test failed at spec/build.test.js:12', stderr: '' } },
    noTaskDone: true,
    expect: 'unverified' },

  // 0.2 — the budget ends the run, not the model. Turns, so it replays.
  { name: 'budget-stop',
    prompt: 'Explore this workspace with the shell tool, one command per call. Keep going until told to stop.',
    seed: { 'a.txt': 'one\n', 'b.txt': 'two\n' },
    budget: { turns: 2 },
    expect: 'budget' },

  // 0.3 — act-or-nudge: a code-mode run that answers in PROSE with no tool calls gets one firm
  // nudge and the loop is re-entered. Two run.started and two run.stopped in ONE record; the
  // replay derives the two loops from the record itself.
  { name: 'act-or-nudge',
    prompt: 'Describe, in one sentence and without using any tool, what the shell tool is for.',
    seed: {},
    nudge: '[coordination] You described the work but did not do it. Use the shell tool to actually run a command now, then give a one-line summary. Do not only explain.',
    expect: 'done' },
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
mkdirSync(CORPUS, { recursive: true });

for (const sc of SCENARIOS) {
  if (only && sc.name !== only) continue;
  const { shell, fs } = freshShell();
  for (const [p, c] of Object.entries(sc.seed)) await fs.write(p, c);

  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: sc.prompt }];
  const tools = (sc.gate && !sc.noTaskDone) ? [shellTool(), taskDoneTool()] : [shellTool()];
  const rec = createRunRecorder({ app: 'anvil', principal: 'corpus' });
  // A scripted gate: the point of 0.0 is what the LOOP does with a verdict that never passes,
  // so the verdict is fixed and the run is real around it.
  const verify = sc.gate ? async () => sc.gate.verdict : null;
  const loop = (msgs) => runAgentLoop({
    messages: msgs, tools,
    infer: rec.wrapInfer(inferLive, { model: null }),
    executeTool: makeShellExecutor(shell),
    onEvent: rec.onEvent, maxSteps: 6,
    ...(verify ? { verify, maxVerifyRounds: sc.gate.rounds } : {}),
    ...(sc.budget ? { budget: sc.budget } : {}),
  });

  await rec.start({ messages, tools });
  let result = await loop(messages);
  await rec.finish(result);

  // 0.3 — the app's act-or-nudge, reproduced exactly as runTask does it: a code-mode run that
  // used NO tools gets the prose back plus one firm nudge, and the loop is re-entered on the
  // same recorder. That is what puts two run.started on one chain.
  if (sc.nudge) {
    const usedTools = rec.events().some((e) => e.tool === 'tool.called');
    if (usedTools) { console.log(`SKIPPED ${sc.name}: the model used a tool, so act-or-nudge never fires — re-run`); continue; }
    const convo = [...messages];
    if (result.text) convo.push({ role: 'assistant', content: result.text });
    convo.push({ role: 'user', content: sc.nudge });
    await rec.start({ messages: convo, tools });
    result = await loop(convo);
    await rec.finish(result);
  }
  await rec.settled();

  if (sc.expect && result.stop !== sc.expect) {
    console.log(`SKIPPED ${sc.name}: stopped '${result.stop}', the scenario needs '${sc.expect}' — not written`);
    continue;
  }

  const dump = rec.export();
  writeFileSync(join(CORPUS, `${sc.name}.json`), JSON.stringify(dump, null, 0) + '\n');
  // What a record cannot hold: the budget the run was given. Written beside it, from the same
  // capture, so the replay reproduces the stop rather than running past it.
  if (sc.budget || sc.gate) {
    writeFileSync(join(CORPUS, `${sc.name}.opts.json`),
      JSON.stringify({ ...(sc.budget ? { budget: sc.budget } : {}), ...(sc.gate ? { maxVerifyRounds: sc.gate.rounds } : {}), expect: sc.expect }, null, 2) + '\n');
  }
  const starts = rec.events().filter((e) => e.tool === 'run.started').length;
  console.log(`recorded ${sc.name}: stop=${result.stop} steps=${result.steps} events=${rec.events().length} loops=${starts}`);
}
