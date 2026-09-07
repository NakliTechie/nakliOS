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
import { runAgentLoop, shellTool, makeShellExecutor } from '../sys/ai/agent-loop.mjs';
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
];

const only = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
mkdirSync(CORPUS, { recursive: true });

for (const sc of SCENARIOS) {
  if (only && sc.name !== only) continue;
  const { shell, fs } = freshShell();
  for (const [p, c] of Object.entries(sc.seed)) await fs.write(p, c);

  const messages = [{ role: 'system', content: SYSTEM }, { role: 'user', content: sc.prompt }];
  const tools = [shellTool()];
  const rec = createRunRecorder({ app: 'anvil', principal: 'corpus' });
  await rec.start({ messages, tools });
  const result = await runAgentLoop({
    messages, tools,
    infer: rec.wrapInfer(inferLive, { model: null }),
    executeTool: makeShellExecutor(shell),
    onEvent: rec.onEvent, maxSteps: 6,
  });
  await rec.finish(result);
  await rec.settled();

  const dump = rec.export();
  writeFileSync(join(CORPUS, `${sc.name}.json`), JSON.stringify(dump, null, 0) + '\n');
  console.log(`recorded ${sc.name}: stop=${result.stop} steps=${result.steps} events=${rec.events().length}`);
}
