#!/usr/bin/env node
// record-corpus.mjs — capture REAL agent runs into the replay corpus (F2's record mode).
//
//   node scripts/record-corpus.mjs                       # all scenarios, needs a live endpoint
//   node scripts/record-corpus.mjs --only write-a-file
//   BASE=https://api.deepseek.com/v1 MODEL=deepseek-flash KEY=… node scripts/record-corpus.mjs --only <cell>
//   (2026-09-12: DeepSeek as configured is the bed's fuel; never a local Ollama model — too slow, and
//   the records it made were the ones the live sessions kept disagreeing with)
//
// This is the ONLY thing that needs a model. The gate replays what it writes, keyless — so
// this runs when a scenario is added or deliberately re-captured, never in CI.
//
// What makes a recording replayable: the record keeps the exact messages and tools the run was
// handed, so `replayEntry` re-runs it against its own opening rather than today's app prompt.
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRunRecorder } from '../sys/history/run-record.mjs';
import { runAgentLoop, shellTool, makeShellExecutor, taskDoneTool, clarifyTool } from '../sys/ai/agent-loop.mjs';
import { readTool, editTool, makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { foldStagnation, stagnationNudge } from '../sys/history/run-record.mjs';
import { needsSupervisor } from '../sys/ai/run-assembly.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { buildEndpointChatBody, createToolCallAccumulator } from '../sys/ai/agent-protocol.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
// OUT= writes somewhere else — a dry run against a stub endpoint must never land in the real corpus
const CORPUS = process.env.OUT || join(HERE, '..', 'sys', 'history', 'corpus');
const BASE = process.env.BASE || 'http://127.0.0.1:8645/v1';
const MODEL = process.env.MODEL || 'deepseek-flash';
const KEY = process.env.KEY || 'local';
const RECORDED_AT = new Date().toISOString().slice(0, 10);

// A real endpoint call, non-streamed: the corpus wants whole responses, and `usage` comes back
// on a non-streamed body without needing stream_options.
async function inferLive({ messages, tools }) {
  const body = buildEndpointChatBody({ model: MODEL, messages, tools, toolChoice: 'auto', stream: false });
  const r = await fetch(`${BASE}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', authorization: `Bearer ${KEY}` }, body: JSON.stringify(body),
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
  return { shell: createShell({ registry, face }), fs, face, seed };
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
  { name: 'write-a-file', description: "A one-command task: echo into a file, then DONE.",
    prompt: 'Use the shell tool to run exactly: echo hello > greeting.txt   Then say DONE and stop.',
    seed: {} },
  { name: 'read-then-answer', description: "Read a file through the shell and answer with its one word.",
    prompt: 'Use the shell tool to run exactly: cat fact.txt   Then reply with the single word it contains and stop.',
    seed: { 'fact.txt': 'kiwi\n' } },
  { name: 'refused-command', description: "An unsupported flag is refused by the curated shell; the model reports the exit code.",
    prompt: 'Use the shell tool to run exactly: sort -Z fact.txt   Report the exit code you saw, then stop.',
    seed: { 'fact.txt': 'b\na\n' } },

  // 0.0 — a gate that never passes. The loop feeds the failing verdict back, retries up to
  // maxVerifyRounds, then stops 'unverified'. The model does not get to declare done.
  { name: 'failing-gate', description: "0.0 — task_done with a gate that never passes: the loop feeds the verdict back, retries to the rounds cap, stops unverified.",
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
  { name: 'gate-on-prose', description: "0.0b — the OTHER route to the gate: no tool calls, the verdict comes back as a [coordination] user turn.",
    prompt: 'Answer in one short sentence and use no tools at all: what does the shell tool do?',
    seed: {},
    gate: { rounds: 2, verdict: { ok: false, exit: 1, stdout: 'FAIL: 1 test failed at spec/build.test.js:12', stderr: '' } },
    noTaskDone: true,
    expect: 'unverified' },

  // 0.2 — the budget ends the run, not the model. Turns, so it replays.
  { name: 'budget-stop', description: "0.2 — the budget ends the run on the turns axis.",
    prompt: 'Explore this workspace with the shell tool, one command per call. Keep going until told to stop.',
    seed: { 'a.txt': 'one\n', 'b.txt': 'two\n' },
    budget: { turns: 2 },
    expect: 'budget' },

  // 0.3 — act-or-nudge: a code-mode run that answers in PROSE with no tool calls gets one firm
  // nudge and the loop is re-entered. Two run.started and two run.stopped in ONE record; the
  // replay derives the two loops from the record itself.
  { name: 'act-or-nudge', description: "0.3 — a prose-only code-mode run is nudged once and the loop is re-entered: two loops on one chain.",
    prompt: 'Describe, in one sentence and without using any tool, what the shell tool is for.',
    seed: {},
    nudge: '[coordination] You described the work but did not do it. Use the shell tool to actually run a command now, then give a one-line summary. Do not only explain.',
    expect: 'done' },

  // ── B2 (2026-09-12): the cells a run can end in that the seven above did not name ──
  // clarify — the loop pauses on the model's one question; the owner's next message is the answer.
  { name: 'clarify', description: "The loop pauses on the model's one clarify question — stop:\"clarify\" on the first response; the owner's next message is the answer.",
    prompt: 'Before doing anything, use the clarify tool to ask me ONE question: which file name I want. Make no other tool call.',
    seed: {}, tools: 'shell+clarify',
    expect: 'clarify' },
  // failed-command — a command that fails with a non-zero exit (not_found), fed back with its exit
  // code; the run continues. (The executor THROWING is the tool-error cell: an override, because
  // the standard executors never throw and so no live run can record that path.)
  { name: 'failed-command', description: 'A command that exits non-zero: its error text is fed back as the tool result (not_found), and the run continues to a one-line report.',
    prompt: 'Use the shell tool to run exactly: cat missing.txt   Then report the exit code you saw in one line and stop.',
    seed: { 'present.txt': 'x\n' },
    expect: 'done' },
  // stale-edit — F8: read, the shell rewrites the file behind the tools, edit → refused as stale;
  // the model must re-read and edit again. Needs the real tool executor (read/edit over a face).
  { name: 'stale-edit', description: "F8 in a real run: read → a shell rewrite behind the tools → edit refused as stale (rejected) → re-read → the edit applies.",
    prompt: 'Do exactly these steps, one tool call each: (1) read cfg.txt with the read tool; (2) run with the shell tool exactly: echo one=2 > cfg.txt ; (3) use the edit tool on cfg.txt to replace "one=1" with "one=3"; (4) if the edit was refused, read cfg.txt again and use the edit tool to replace "one=2" with "one=3". Then say DONE and stop.',
    seed: { 'cfg.txt': 'one=1\n' }, tools: 'files',
    expect: 'done' },
  // parallel-reads — three reads asked for in ONE turn go through the F9 pool; the record's shape
  // must be the serial one (call, responded, call, responded …, in request order).
  { name: 'parallel-reads', description: "Three reads asked for in ONE turn run through the F9 pool; the record's shape is the serial one — call, responded, per read, in request order.",
    prompt: 'In a SINGLE response, call the read tool three times — on a.txt, b.txt and c.txt — as three parallel tool calls. Then reply with the three words you read, in order, and stop.',
    seed: { 'a.txt': 'apple\n', 'b.txt': 'banana\n', 'c.txt': 'cherry\n' }, tools: 'files',
    expect: 'done' },
  // supervisor — a run that spins (the same call, non-consecutively) to max-steps; the D2
  // supervisor folds the record, injects ONE redirect, and re-enters the loop: two run.started on
  // one chain, like act-or-nudge, derived from the record by the replay.
  { name: 'supervisor', description: "A run that spins (the same call, non-consecutively) to max-steps; the D2 supervisor folds the record, injects ONE redirect, and re-enters the loop — two loops on one chain. The model kept alternating, so the second loop ends max-steps too.",
    prompt: 'Alternate forever between exactly two shell commands, one per tool call: first "cat a.txt", then "ls", then "cat a.txt", then "ls", and so on. Never stop and never summarise; keep alternating until you are told otherwise.',
    seed: { 'a.txt': 'one\n' }, maxSteps: 6, supervise: true,
    // the LOOP is what this pins — two loops on one chain with the redirect between them; whether
    // the model then stops or keeps alternating is its choice, so the stop it ended in is recorded
    // into the manifest rather than demanded
    expect: null },
];

function kitOf(sc, { shell, face }) {
  if (sc.tools === 'files') return {
    system: 'You are a coding agent working over the user\'s files. Tools: read (line-numbered), edit (surgical old_string→new_string), shell. Follow the steps exactly; end with a one-line summary.',
    tools: [readTool(), editTool(), shellTool()], executeTool: makeToolExecutor({ shell, face, mode: 'code' }) };
  if (sc.tools === 'shell+clarify') return {
    system: 'You are a coding agent working over the user\'s files. Tools: shell, clarify. Work in small, verifiable steps; end with a one-line summary.',
    tools: [shellTool(), clarifyTool()], executeTool: makeShellExecutor(shell) };
  return { system: SYSTEM, tools: (sc.gate && !sc.noTaskDone) ? [shellTool(), taskDoneTool()] : [shellTool()], executeTool: makeShellExecutor(shell) };
}

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
mkdirSync(CORPUS, { recursive: true });

const overwrite = process.argv.includes('--overwrite');
for (const sc of SCENARIOS) {
  if (only && sc.name !== only) continue;
  if (!sc.description) throw new Error(`${sc.name}: a scenario says what it pins — add a description`);
  // a recorded cell is never re-captured to make a lane green (2026-09-07 rule); overwriting is a
  // decision, said out loud
  if (existsSync(join(CORPUS, `${sc.name}.json`)) && !overwrite) { console.log(`SKIPPED ${sc.name}: already recorded — pass --overwrite to re-capture (and say why in the manifest)`); continue; }
  const { shell, fs, face } = freshShell();
  for (const [p, c] of Object.entries(sc.seed)) await fs.write(p, c);

  // A scenario names its kit once: the system prompt, the tool list and the executor go together.
  // The file kit needs the real tool executor (read-before-edit, F8's version ledger) over the same
  // face the shell was built over, so a `read` and a shell rewrite see one store; the rest use the
  // plain shell executor the corpus always did.
  const { system, tools, executeTool } = kitOf(sc, { shell, face });
  const messages = [{ role: 'system', content: system }, { role: 'user', content: sc.prompt }];
  const rec = createRunRecorder({ app: 'anvil', principal: 'corpus' });
  // A scripted gate: the point of 0.0 is what the LOOP does with a verdict that never passes,
  // so the verdict is fixed and the run is real around it.
  const verify = sc.gate ? async () => sc.gate.verdict : null;
  const loop = (msgs) => runAgentLoop({
    messages: msgs, tools,
    infer: rec.wrapInfer(inferLive, { model: null }),
    executeTool,
    onEvent: rec.onEvent, maxSteps: sc.maxSteps || 6,
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
  // B2 — the D2 supervisor, as run-assembly's driveRun does it: a non-done run whose record shows
  // spinning gets ONE redirect and the loop is re-entered on the same recorder.
  if (sc.supervise) {
    await rec.settled();
    const stag = foldStagnation(rec.events(), rec.resolve);
    if (!needsSupervisor({ mode: 'code', stop: result.stop, stag })) { console.log(`SKIPPED ${sc.name}: the app's supervisor would not fire (stop=${result.stop}, ${JSON.stringify(stag)}) — re-run`); continue; }
    const convo = [...messages, { role: 'user', content: stagnationNudge(stag) }];
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
  // (the stop it ends in is the manifest's to say, not the opts')
  if (sc.budget || sc.gate || sc.maxSteps) {
    writeFileSync(join(CORPUS, `${sc.name}.opts.json`),
      JSON.stringify({ ...(sc.budget ? { budget: sc.budget } : {}), ...(sc.gate ? { maxVerifyRounds: sc.gate.rounds } : {}), ...(sc.maxSteps ? { maxSteps: sc.maxSteps } : {}) }, null, 2) + '\n');
  }
  const starts = rec.events().filter((e) => e.tool === 'run.started').length;
  // B2: a manifest per cell — what it is, when and on what it was recorded, and the stop it ends in.
  writeFileSync(join(CORPUS, `${sc.name}.manifest.json`), JSON.stringify({
    cell: sc.name, kind: 'recorded', description: sc.description, recordedAt: RECORDED_AT, model: MODEL,
    expect: sc.expect || result.stop, loops: starts, events: rec.events().length, tools: tools.map((t) => t.function.name),
  }, null, 2) + '\n');
  console.log(`recorded ${sc.name}: stop=${result.stop} steps=${result.steps} events=${rec.events().length} loops=${starts}`);
}
