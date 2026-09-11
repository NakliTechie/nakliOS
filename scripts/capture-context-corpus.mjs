#!/usr/bin/env node
// Capture run records that CARRY a skills/memory index, so AC-2 has something to measure.
//   node scripts/capture-context-corpus.mjs --out /tmp/ctx-corpus [--base URL] [--model ID] [--n 2]
//     [--ablate]  index vs no-index arms          [--carry]  reps reuse the previous workspace (AC-8)
//
// AC-2 asks whether the always-on index costs QUALITY, not just tokens. Its probe
// (scripts/probe-context-payload.mjs) answers "no DATA": not one record in the repo carried an
// index, because the corpus was captured from a bare 167-character harness prompt and Anvil's real
// runs persist to OPFS in the browser. This produces the missing records.
//
// WHAT THESE RECORDS ARE, AND ARE NOT. The system prompt is built by the REAL buildSkillsIndex and
// buildMemoryIndex, so the thing under test is the thing that ships. The tools are the real
// skillTool and recallTool, so "did it fire?" is a real decision by a real model. But the task set
// and the workspace are this script's, not a user's project — so these support a claim about
// whether carried-but-unfired context correlates with worse outcomes IN THIS SHAPE OF WORK, and
// not a claim about Anvil in general. Said plainly because the temptation with a small corpus is
// to quote it as if it were one.
//
// The project deliberately carries MORE than any one task needs: three skills and four facts, of
// which each task should want one or two. That spread is the whole point — a corpus where
// everything fires cannot show a cost, and neither can one where nothing does.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runAgentLoop } from '../sys/ai/agent-loop.mjs';
import { createRunRecorder } from '../sys/history/run-record.mjs';
import { metricsOf } from '../sys/ai/ablate.mjs';
import { buildSkillsIndex, skillTool } from '../sys/ai/skills.mjs';
import { buildMemoryIndex, recallTool } from '../sys/ai/memory-store.mjs';
import { codingToolset, makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { SECURITY_ROWS, judgeSecurityRow } from '../sys/ai/bench-security.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const OUT = opt('--out', '/tmp/ctx-corpus');
const BASE = opt('--base', 'http://127.0.0.1:8645/v1');
const MODEL = opt('--model', 'inclusionai/ling-3.0-flash-sante:free');
const KEY = opt('--key', 'local');
const REPS = Number(opt('--n', '2'));
const TIMEOUT = Number(opt('--timeout', '90')) * 1000;
// --ablate runs each task TWICE: once with the index in context, once without.
//
// This is the arm AC-2 actually needs. The probe alone measures how much carried context never
// fires, which is an observation, not an answer: with a FIXED index the dead-weight share is
// nearly constant by construction, so correlating it against outcome is undefined. The paper's
// design is the one that answers the question — same task, same model, index vs no index — and
// comparing the two arms is the only way "the index costs quality" can be true or false rather
// than merely stated.
const ABLATE = args.includes('--ablate');
// Pace between calls. The first ablation run was INVALID and this is why: 8 of 18 runs died on
// HTTP 429, and the rate limit is CONFOUNDED WITH THE VARIABLE UNDER TEST. The with-index arm
// sends a bigger prompt (measured: 1,926 mean prompt tokens against 1,620) and therefore burns
// the per-minute allowance faster, so it was throttled more — and "with-index did worse" was
// fully explained by being throttled, not by the index costing quality. A confound that runs the
// same direction as the hypothesis is the most dangerous kind: it produces a confident wrong
// answer. Pacing keeps both arms under the limit so the arms differ only in what is under test.
const PACE = Number(opt('--pace', '2500'));
// --carry makes reps 2..n reuse the PREVIOUS rep's workspace for the same (arm, task) instead of a
// fresh one. Without it every rep calls freshWorkspace() and the reps are i.i.d. BY CONSTRUCTION —
// which is fine for the AC-2 ablation (each rep is an independent draw) and useless for AC-8.
//
// AC-8 asks "after N failures on this task, is the next attempt worth starting?". Under i.i.d. that
// question is already answered — no, a streak carries no information, provably, because nothing
// connects one rep to the next. Measuring it on the i.i.d. bed produced a curve that LOOKED like a
// clean N=2 (P(next finishes) 0.55 -> 0.20 after one failure) and was entirely Simpson's paradox:
// within every task the after-failure rate equalled the base rate, and the pooled drop was task mix,
// because the easy task rarely enters a streak and the hard one supplies most of them. Full
// analysis: plan/bench-quota-2026-09-10.md.
//
// A real retry inherits the workspace and whatever partial progress is in it. That is the channel a
// genuine "stuck" signal would travel down, and --carry is the only thing here that opens it.
// It deliberately does NOT carry the transcript: a fresh Send starts a new conversation over the
// same files, so workspace-only is the shape Anvil actually retries in, and carrying both would
// move two variables at once.
const CARRY = args.includes('--carry');
// --security: B5. Two deterministic rows judged from the store and the fence, never from what the
// model said — an escape or a criterion edit is a failure even when the answer sounds right.
// They run on a ROOTED workspace (ws/p1 inside a larger store) so "outside the root" is observable.
const SECURITY = args.includes('--security');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

// ── the project's context: more than any one task needs ────────────────────
const SKILLS = [
  { name: 'run-the-gate', status: 'active', body: 'Run `node gate.mjs`. It prints PASS or FAIL.',
    description: 'How to run this project\'s test gate' },
  { name: 'release-checklist', status: 'active', body: 'Bump VERSION, tag, push.',
    description: 'The steps for cutting a release' },
  { name: 'db-migrations', status: 'active', body: 'Migrations live in db/. Never edit an applied one.',
    description: 'How database migrations work here' },
];
const FACTS = [
  { name: 'build-command', type: 'project', status: 'verified', description: 'The build is `node build.mjs`, not npm run build.',
    body: 'The build is `node build.mjs`. There is no npm script for it.' },
  { name: 'entry-point', type: 'project', status: 'verified', description: 'The app entry point is src/main.js.',
    body: 'src/main.js is the entry point; index.js is a legacy shim.' },
  { name: 'deploy-target', type: 'project', status: 'verified', description: 'Deploys go to Cloudflare Workers.',
    body: 'Deploys go to Cloudflare Workers via wrangler.' },
  { name: 'legacy-shim', type: 'project', status: 'hypothesis', description: 'index.js may be removable.',
    body: 'index.js appears unused; removing it is untested.' },
];

const SYSTEM_HEAD = 'You are a coding agent working over the user\'s files. Tools: read, write, edit, shell. '
  + 'When a listed skill or fact covers what you are doing, load it with the `skill` or `recall` tool BEFORE acting. '
  + 'Work in small, verifiable steps; end with a one-line summary.';

const TASKS = [
  { id: 'run-the-gate', seed: { 'gate.mjs': 'console.log("PASS")\n' },
    prompt: 'Run this project\'s test gate and tell me whether it passes.' },
  { id: 'find-entry', seed: { 'src/main.js': 'export const main = () => 1\n', 'index.js': '// legacy\n' },
    prompt: 'Which file is the application entry point? Write its path into answer.txt.' },
  { id: 'build-it', seed: { 'build.mjs': 'console.log("built")\n' },
    prompt: 'Build this project and report what command you used.' },
];

function freshWorkspace(seed, { root = '' } = {}) {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, root });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  const ready = (async () => { for (const [p, c] of Object.entries(seed)) await fs.write(p, c); })();
  return { fs, shell, face, ready, backend, root };
}

let calls = 0;
const t0 = Date.now();
const log = (m) => process.stderr.write(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}\n`);

function infer(label) {
  return async ({ messages, tools }) => {
    const since = Date.now() - lastCallAt;
    if (PACE > 0 && since < PACE) await sleep(PACE - since);
    lastCallAt = Date.now();
    const n = ++calls;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT);
    try {
      const res = await fetch(`${BASE}/chat/completions`, {
        method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
        body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', stream: false, temperature: 0 }),
      });
      const json = await res.json().catch(() => null);
      if (res.status === 429) throw new Error('RATE_LIMIT');
      if (!res.ok) throw new Error(`http ${res.status}`);
      const m = json?.choices?.[0]?.message || {};
      const tc = (m.tool_calls || []).map((c) => ({ id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments } }));
      log(`${label} call ${n}: ${(json?.usage?.prompt_tokens ?? '?')}+${(json?.usage?.completion_tokens ?? '?')} tok, ${tc.length} tool call(s)${tc.length ? ' → ' + tc.map((x) => x.function.name).join(',') : ''}`);
      return { content: m.content || '', toolCalls: tc, finishReason: json?.choices?.[0]?.finish_reason, model: json?.model || MODEL };
    } finally { clearTimeout(timer); }
  };
}

await mkdir(OUT, { recursive: true });
const system = SYSTEM_HEAD + buildSkillsIndex(SKILLS) + buildMemoryIndex(FACTS);
console.error(`capture: ${TASKS.length} task(s) x ${REPS} rep(s) = ${TASKS.length * REPS} records`);
console.error(`  ${MODEL} @ ${BASE}`);
console.error(`  system prompt: ${system.length} chars, ${SKILLS.length} skills + ${FACTS.length} facts in context`);
console.error(`  reps: ${CARRY ? 'CARRY-FORWARD (rep k reuses rep k-1\'s workspace — a retry)' : 'i.i.d. (fresh workspace each rep — independent draws)'}\n`);

let saved = 0, failed = 0;
const carried = new Map(); // (arm/task) -> workspace, only populated under --carry
const arms = ABLATE ? ['with-index', 'no-index'] : ['with-index'];
const outcomes = {}, voids = {};
for (let rep = 1; rep <= (SECURITY && REPS === 0 ? 0 : REPS); rep++) {
  for (const arm of arms) {
  for (const task of TASKS) {
    // Under --carry the workspace persists across reps of the same (arm, task), so rep k sees
    // whatever rep k-1 left behind. Rep 1 is always fresh.
    const key = `${arm}/${task.id}`;
    const ws = (CARRY && carried.has(key)) ? carried.get(key) : freshWorkspace(task.seed);
    if (CARRY) carried.set(key, ws);
    await ws.ready;
    // The real skill/recall handlers: return the body for a listed name, refuse otherwise.
    const base = makeToolExecutor({ shell: ws.shell, face: ws.face, mode: 'code' });
    const executeTool = async (nm, ar, call) => {
      if (nm === 'skill') {
        const s = SKILLS.find((x) => x.name === ar?.name);
        return s ? s.body : `No skill named "${ar?.name}". Available: ${SKILLS.map((x) => x.name).join(', ')}.`;
      }
      if (nm === 'recall') {
        const f = FACTS.find((x) => x.name === ar?.name);
        return f ? `- **${f.name}** (${f.type}): ${f.body}` : `No fact named "${ar?.name}".`;
      }
      return base(nm, ar, call);
    };
    const withIndex = arm === 'with-index';
    const messages = [{ role: 'system', content: withIndex ? system : SYSTEM_HEAD }, { role: 'user', content: task.prompt }];
    // The no-index arm keeps the skill/recall TOOLS — removing them would change two things at
    // once and make the comparison meaningless. It only stops listing what there is to load,
    // which is exactly the variable under test.
    const tools = [...codingToolset('code'), skillTool(), recallTool()];
    const rec = createRunRecorder({ app: 'anvil', principal: 'capture' });
    await rec.start({ messages, tools });
    try {
      const result = await runAgentLoop({ messages, tools, infer: rec.wrapInfer(infer(`${arm}/${task.id}#${rep}`)), executeTool, onEvent: rec.onEvent, maxSteps: 8 });
      await rec.finish(result); await rec.settled();
      // The loop CATCHES an infer throw and returns stop:'error' — it does not propagate — so a
      // rate-limited run reaches here looking like a task failure. Caught in the catch block
      // below, seven of them were still counted into the arithmetic on the second run. The check
      // has to be on the RESULT, not on an exception that never arrives.
      if (result.stop === 'error' && /RATE_LIMIT/.test(String(result.error || ''))) {
        (voids[arm] ||= []).push(`${task.id}#${rep}`);
        log(`${arm}/${task.id}#${rep} VOID — rate limited`);
        continue;
      }
      const dir = ABLATE ? join(OUT, arm) : OUT;
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${task.id}-${rep}.json`), JSON.stringify(rec.export()));
      saved++;
      const m = metricsOf(rec);
      (outcomes[arm] ||= []).push({ task: task.id, rep, stop: result.stop, label: m.label, steps: m.steps, toolCalls: m.toolCalls, toFirstAction: m.toFirstAction, anchor: m.anchor });
      log(`${arm}/${task.id}#${rep} → ${result.stop} (${m.toolCalls} tool calls)`);
    } catch (e) {
      failed++;
      const why = String(e.message || e);
      // A throttled run tells us nothing about the index. Counted apart, never averaged in.
      if (/RATE_LIMIT/.test(why)) { (voids[arm] ||= []).push(`${task.id}#${rep}`); log(`${arm}/${task.id}#${rep} VOID — rate limited`); }
      else log(`${arm}/${task.id}#${rep} FAILED: ${why.slice(0, 80)}`);
    }
  }
  }
}
if (SECURITY) {
  console.error('\nsecurity rows (deterministic — judged from the store and the fence, not the prose):');
  const secOut = [];
  for (const row of SECURITY_ROWS) {
    const ROOT = 'ws/p1';
    const ws = freshWorkspace(row.seed || {}, { root: ROOT }); await ws.ready;
    const readOnlyGrant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'], readOnlyPrefixes: ['.anvil/gate'] });
    const registry = buildRigRegistry({ fs: ws.fs });
    const face = createAgentFace({ registry, grant: readOnlyGrant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
    const shell = createShell({ registry, face });
    const results = [];
    const base = makeToolExecutor({ shell, face, mode: 'code' });
    const executeTool = async (nm, ar, call) => { const r = await base(nm, ar, call); results.push(String(r ?? '')); return r; };
    const messages = [{ role: 'system', content: SYSTEM_HEAD }, { role: 'user', content: row.prompt }];
    const tools = [...codingToolset('code', { completion: true })];
    const rec = createRunRecorder({ app: 'anvil', principal: 'capture' });
    await rec.start({ messages, tools });
    const result = await runAgentLoop({ messages, tools, infer: rec.wrapInfer(infer(`security/${row.id}`)), executeTool, onEvent: rec.onEvent, maxSteps: 8, verify: async () => ({ ok: true, exit: 0, stdout: '', stderr: '' }) });
    await rec.finish(result); await rec.settled();
    // the whole store, and what lies outside the root
    const all = createFileops({ backend: ws.backend });
    const listing = await all.list('.', { recursive: true });
    const outside = [];
    for (const e of (listing.entries || [])) {
      if (e.type !== 'file' || e.path.startsWith(ROOT + '/')) continue;
      const r = await all.read(e.path, { encoding: 'utf-8' }); outside.push({ path: e.path, content: r && r.ok ? r.data : null });
    }
    const files = {};
    for (const p of Object.keys(row.mustEqual || {})) { const r = await ws.fs.read(p, { encoding: 'utf-8' }); files[p] = r && r.ok ? r.data : null; }
    const verdict = judgeSecurityRow(row, { outside, files, results });
    secOut.push({ id: row.id, pass: verdict.pass, why: verdict.why, stop: result.stop });
    log(`security/${row.id} → ${verdict.pass ? 'PASS' : 'FAIL'} (agent stop: ${result.stop})${verdict.why.length ? ' — ' + verdict.why.join('; ') : ''}`);
  }
  console.error('\nrow                       verdict  agent stop');
  for (const r of secOut) console.error(`${r.id.padEnd(26)}${(r.pass ? 'PASS' : 'FAIL').padEnd(9)}${r.stop}`);
  console.error('A FAIL here is a fence defect regardless of the completion table above.');
}
console.error(`\n${saved} record(s) → ${OUT}${failed ? `, ${failed} failed` : ''}`);
if (ABLATE) {
  const sum = (a) => ({
    n: a.length,
    done: a.filter((x) => x.stop === 'done').length,
    maxSteps: a.filter((x) => x.stop === 'max-steps').length,
    toolCalls: Math.round((a.reduce((s, x) => s + x.toolCalls, 0) / a.length) * 10) / 10,
    steps: Math.round((a.reduce((s, x) => s + x.steps, 0) / a.length) * 10) / 10,
  });
  console.error('\narm         n  done  max-steps  mean tool calls  mean steps');
  for (const arm of arms) {
    const s = sum(outcomes[arm] || []);
    console.error(`${arm.padEnd(12)}${String(s.n).padEnd(3)}${String(s.done).padEnd(6)}${String(s.maxSteps).padEnd(11)}${String(s.toolCalls).padEnd(17)}${s.steps}`);
  }
  console.error('\nPer task (stop reason, with-index vs no-index):');
  for (const t of TASKS) {
    const w = (outcomes['with-index'] || []).filter((x) => x.task === t.id).map((x) => x.stop);
    const n = (outcomes['no-index'] || []).filter((x) => x.task === t.id).map((x) => x.stop);
    console.error(`  ${t.id.padEnd(14)} with: ${w.join(',').padEnd(24)} without: ${n.join(',')}`);
  }
  const vAll = arms.flatMap((a) => (voids[a] || []).map((x) => `${a}/${x}`));
  if (vAll.length) {
    console.error(`\nVOID (rate limited — NOT a task failure, and excluded above): ${vAll.length}`);
    console.error(`  ${vAll.join(', ')}`);
    console.error('  A 429 tells you nothing about the index. Worse: the bigger arm hits the limit');
    console.error('  sooner, so throttling runs the SAME direction as the hypothesis. If either arm');
    console.error('  shows voids, raise --pace and re-run before reading a single row above.');
  }
  console.error('\nn is small. Read only what repeats across every rep — a single flip is noise.');

}
if (!CARRY) {
  // Applies to every run, not just an --ablate one: the caveat is about the BED, not the arms.
  console.error('\nReps here are i.i.d. (fresh workspace each time). The per-task sequences');
  console.error('CANNOT answer AC-8\'s "after N failures, stop offering to start" — a streak carries');
  console.error('no information when nothing connects one rep to the next. Re-run with --carry for');
  console.error('that question, and stratify by task: pooled, composition alone fakes a clean N.');
}
console.error(`\nNow: node scripts/probe-context-payload.mjs ${ABLATE ? join(OUT, 'with-index') : OUT}`);
