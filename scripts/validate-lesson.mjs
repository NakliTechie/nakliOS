#!/usr/bin/env node
// AC-9 live half: put a candidate lesson through the gate.
//   node scripts/validate-lesson.mjs --lesson true-build --n 6 [--base URL] [--model ID] [--key K]
//
// sys/ai/lesson-gate.mjs decides; this runs the arms that feed it. Two arms over the same tasks:
// the candidate lesson present in the memory index, and absent. Everything else identical.
//
// THE POINT OF THE `false-build` CANDIDATE. A gate that admits a good lesson proves nothing — a
// gate that admits everything does that too. The only evidence that this gate WORKS is that it
// rejects a lesson deliberately written to be wrong. So the default run does both, and the result
// worth reporting is the pair, not either verdict alone.
import { runAgentLoop } from '../sys/ai/agent-loop.mjs';
import { createRunRecorder } from '../sys/history/run-record.mjs';
import { buildSkillsIndex, skillTool } from '../sys/ai/skills.mjs';
import { buildMemoryIndex, recallTool } from '../sys/ai/memory-store.mjs';
import { codingToolset, makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { judgeLesson, MIN_REPS_PER_ARM } from '../sys/ai/lesson-gate.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const BASE = opt('--base', 'http://127.0.0.1:8645/v1');
const MODEL = opt('--model', 'inclusionai/ling-3.0-flash-sante:free');
const KEY = opt('--key', 'local');
const REPS = Number(opt('--n', '6'));
const TIMEOUT = Number(opt('--timeout', '120')) * 1000;
const ONLY = opt('--lesson', null);

// The base project. Same shape as capture-context-corpus, minus the facts a candidate supplies.
const SKILLS = [{ name: 'run-the-gate', status: 'active', body: 'Run `node gate.mjs`. It prints PASS or FAIL.', description: 'How to run this project\'s test gate' }];
const BASE_FACTS = [{ name: 'entry-point', type: 'project', status: 'verified', description: 'The app entry point is src/main.js.', body: 'src/main.js is the entry point; index.js is a legacy shim.' }];

// Candidates. One true, one false, both about the SAME thing so the only difference is correctness.
const CANDIDATES = {
  'true-build': { name: 'build-command', type: 'project', status: 'verified',
    description: 'The build is `node build.mjs`, not npm run build.',
    body: 'The build is `node build.mjs`. There is no npm script for it.' },
  'false-build': { name: 'build-command', type: 'project', status: 'verified',
    description: 'The build is `npm run build`.',
    body: 'The build is `npm run build`. Do not call node directly; the npm script sets up the environment.' },
};

const TASKS = [
  { id: 'build-it', seed: { 'build.mjs': 'console.log("built")\n', 'package.json': '{"name":"p"}\n' },
    prompt: 'Build this project and report what command you used.' },
  { id: 'run-the-gate', seed: { 'gate.mjs': 'console.log("PASS")\n' },
    prompt: 'Run this project\'s test gate and tell me whether it passes.' },
];

function freshWorkspace(seed) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  return { fs, face, shell: createShell({ registry, face }),
    ready: (async () => { for (const [p, c] of Object.entries(seed)) await fs.write(p, c); })() };
}

let calls = 0; const t0 = Date.now();
const log = (m) => process.stderr.write(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}\n`);
function infer(label) {
  return async ({ messages, tools }) => {
    const n = ++calls; const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await fetch(`${BASE}/chat/completions`, { method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', stream: false, temperature: 0 }) });
      if (res.status === 429) throw new Error('RATE_LIMIT');
      const json = await res.json().catch(() => null);
      if (!res.ok) throw new Error(`http ${res.status}`);
      const m = json?.choices?.[0]?.message || {};
      const tc = (m.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } }));
      log(`${label} call ${n}: ${json?.usage?.prompt_tokens ?? '?'}+${json?.usage?.completion_tokens ?? '?'} tok${tc.length ? ' → ' + tc.map((x) => x.function.name).join(',') : ''}`);
      return { content: m.content || '', toolCalls: tc, finishReason: json?.choices?.[0]?.finish_reason };
    } finally { clearTimeout(timer); }
  };
}

async function runArm(candidate, present, rep) {
  const facts = present ? [...BASE_FACTS, candidate] : BASE_FACTS;
  const system = 'You are a coding agent working over the user\'s files. Tools: read, write, edit, shell. '
    + 'When a listed skill or fact covers what you are doing, load it with the `skill` or `recall` tool BEFORE acting. '
    + 'Work in small, verifiable steps; end with a one-line summary.'
    + buildSkillsIndex(SKILLS) + buildMemoryIndex(facts);
  let done = 0, voided = 0;
  for (const task of TASKS) {
    const ws = freshWorkspace(task.seed); await ws.ready;
    const base = makeToolExecutor({ shell: ws.shell, face: ws.face, mode: 'code' });
    const executeTool = async (nm, ar, call) => {
      if (nm === 'skill') { const s = SKILLS.find((x) => x.name === ar?.name); return s ? s.body : `No skill named "${ar?.name}".`; }
      if (nm === 'recall') { const f = facts.find((x) => x.name === ar?.name); return f ? `- **${f.name}** (${f.type}): ${f.body}` : `No fact named "${ar?.name}".`; }
      return base(nm, ar, call);
    };
    const messages = [{ role: 'system', content: system }, { role: 'user', content: task.prompt }];
    const tools = [...codingToolset('code'), skillTool(), recallTool()];
    const rec = createRunRecorder({ app: 'anvil', principal: 'lesson-gate' });
    await rec.start({ messages, tools });
    const label = `${present ? 'with' : 'without'}/${task.id}#${rep}`;
    const result = await runAgentLoop({ messages, tools, infer: rec.wrapInfer(infer(label)), executeTool, onEvent: rec.onEvent, maxSteps: 8 });
    await rec.finish(result); await rec.settled();
    if (result.stop === 'error' && /RATE_LIMIT/.test(String(result.error || ''))) { voided++; log(`${label} VOID`); continue; }
    if (result.stop === 'done') done++;
    log(`${label} → ${result.stop}`);
  }
  return { done, voided };
}

const names = ONLY ? [ONLY] : Object.keys(CANDIDATES);
if (REPS < MIN_REPS_PER_ARM) {
  console.error(`--n ${REPS} is below the gate's floor of ${MIN_REPS_PER_ARM}; the verdict would be 'unpowered' by construction.`);
}
console.error(`validate-lesson: ${names.length} candidate(s) x 2 arms x ${REPS} rep(s) x ${TASKS.length} task(s)`);
console.error(`  ${MODEL} @ ${BASE}\n`);

const verdicts = {};
for (const nm of names) {
  const cand = CANDIDATES[nm];
  if (!cand) { console.error(`unknown candidate "${nm}" — have: ${Object.keys(CANDIDATES).join(', ')}`); process.exit(2); }
  console.error(`── candidate: ${nm} — "${cand.description}"`);
  let withDone = 0, withN = 0, withoutDone = 0, withoutN = 0, voids = 0;
  for (let rep = 1; rep <= REPS; rep++) {
    const a = await runArm(cand, true, rep); withDone += a.done; withN += TASKS.length - a.voided; voids += a.voided;
    const b = await runArm(cand, false, rep); withoutDone += b.done; withoutN += TASKS.length - b.voided; voids += b.voided;
  }
  const v = judgeLesson({ withDone, withN, withoutDone, withoutN });
  verdicts[nm] = { v, withDone, withN, withoutDone, withoutN, voids };
  console.error(`\n  with-lesson    ${withDone}/${withN}`);
  console.error(`  without-lesson ${withoutDone}/${withoutN}`);
  if (voids) console.error(`  VOID (rate limited, excluded): ${voids}`);
  console.error(`  → ${v.verdict.toUpperCase()} (admit=${v.admit}) — ${v.reason}\n`);
}

console.error('─'.repeat(72));
for (const [nm, r] of Object.entries(verdicts)) {
  console.error(`${nm.padEnd(14)} with ${String(r.withDone + '/' + r.withN).padEnd(7)} without ${String(r.withoutDone + '/' + r.withoutN).padEnd(7)} → ${r.v.verdict}`);
}
if (verdicts['true-build'] && verdicts['false-build']) {
  const ok = verdicts['false-build'].v.verdict === 'harmed' && verdicts['true-build'].v.admit;
  console.error(`\nDoes the gate DISCRIMINATE? ${ok ? 'yes — it rejected the wrong lesson and kept the right one' : 'NO'}`);
  if (!ok) console.error('A gate that cannot reject a deliberately wrong lesson is not a gate. Report this as such.');
}
console.error(`\n${calls} live model call(s)`);
