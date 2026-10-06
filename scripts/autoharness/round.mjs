#!/usr/bin/env node
// Layer 3 of the autoharness optimizer: ONE round. Run the incumbent harness on a sample of train
// tasks, write each failure as markdown, let an optimizer model make one focused edit to the three
// harness files, record the pins the edit changes, run the repo's CI gate, and commit the candidate.
// Scoring the candidate on dev — keep or revert — is layer 4 (loop.mjs).
//
//   node scripts/autoharness/round.mjs --round 1 [--n 20] [--seed 1] [--train-dir DIR]
//     [--endpoint openrouter-bunny | --base URL --model ID --key-from SOURCE]   (the solver, for the train runs)
//     [--optimizer-model gpt-5.6-luna | --optimizer-cmd "<shell command>"]
//     [--history FILE] [--gate full | lane,lane] [--min-failures 3] [--no-commit]
//
// The repo is the one this script lives in; run it on a branch or worktree, never on main.
// Modelled on huyxdang/AutoHarness optimizer/round.py, with three differences:
//   - the optimizer is Codex (`codex exec`, default model gpt-5.6-luna; Chirag 2026-10-01) and works in
//     a STAGING directory holding only the three harness files, read-only context and the train
//     evidence. The battery's dev and test definitions live in this repo, so the repo is not its
//     workspace. Any repo file that changes during the call is still restored (AutoHarness's guard).
//   - the CI pins of the harness text are updated as recorded literals (pins.mjs), and the whole CI
//     gate runs; a lane the edit turns red rejects the candidate.
//   - the round's record is .autoharness/round-<N>/round.json, beside the evidence it saw.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, copyFileSync, rmSync, unlinkSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { tasksIn } from './battery.mjs';
import { readRuns, failureMarkdown } from './failures.mjs';
import { snapshot, writePins, PIN_FILES } from './pins.mjs';
import { runGate, gateCommands, treeOf } from './gate.mjs';
import { ENDPOINTS, DEFAULT_ENDPOINT } from './endpoints.mjs';
import { freshWorkspace } from './bed.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ROUND = Number(opt('--round'));
if (!Number.isInteger(ROUND) || ROUND < 1) { console.error('--round N (a positive integer) is required'); process.exit(2); }
const N = Number(opt('--n', '20'));
// Below this many scored train failures the optimizer is not called: rounds 1 and 4 of the first live
// run each generalised one slip into a harness edit (2026-10-01). More train tasks are drawn first.
const MIN_FAILURES = Number(opt('--min-failures', '3'));
const SEED = Number(opt('--seed', String(ROUND)));
const OPT_MODEL = opt('--optimizer-model', 'gpt-5.6-luna');
const OPT_CMD = opt('--optimizer-cmd');
const GATE = opt('--gate', 'full');
const NO_COMMIT = args.includes('--no-commit');
const HARNESS = Object.freeze(['sys/ai/run-assembly.mjs', 'sys/ai/procedural.mjs', 'sys/ai/agent-tools.mjs']);
const CONTEXT = ['sys/ai/agent-loop.mjs'];
const WS = join(REPO, '.autoharness', `round-${ROUND}`);
const t0 = Date.now();
const log = (m) => process.stderr.write(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(4)}s] ${m}\n`);
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const ist = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';

const record = { round: ROUND, started: ist(t0), optimizer: OPT_CMD ? { cmd: OPT_CMD } : { tool: 'codex exec', model: OPT_MODEL } };
function finish(outcome, extra = {}) {
  Object.assign(record, { outcome, ...extra, ended: ist(Date.now()), seconds: Math.round((Date.now() - t0) / 1000) });
  mkdirSync(WS, { recursive: true });
  writeFileSync(join(WS, 'round.json'), JSON.stringify(record, null, 2));
  log(`round ${ROUND}: ${outcome}${record.rationale ? ' — ' + record.rationale : ''}`);
  console.log(join(WS, 'round.json'));
  process.exit(0);
}

// Every non-ignored file in the repo, path → bytes, except the round's own workspace.
function repoFiles() {
  const listed = git('ls-files', '--cached', '--others', '--exclude-standard').split('\n').filter((p) => p && !p.startsWith('.autoharness/'));
  const out = new Map();
  for (const p of listed) { const f = join(REPO, p); if (existsSync(f)) out.set(p, readFileSync(f)); }
  return out;
}
function restore(before, paths) {
  for (const p of paths) {
    const f = join(REPO, p);
    if (before.has(p)) { mkdirSync(dirname(f), { recursive: true }); writeFileSync(f, before.get(p)); }
    else if (existsSync(f)) unlinkSync(f);
  }
}
// Ignored paths (collapsed to directories): this repo ignores everything not on its allow-list, so a
// file the optimizer drops at the root is invisible to `ls-files --others --exclude-standard`.
const ignoredPaths = () => new Set(git('ls-files', '--others', '--ignored', '--exclude-standard', '--directory').split('\n').filter((p) => p && !p.startsWith('.autoharness/')));
const changedBetween = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((p) => !(a.has(p) && b.has(p) && a.get(p).equals(b.get(p))));

// ── 0. guards ──────────────────────────────────────────────────────────────────────────────────
const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (['main', 'master', 'HEAD'].includes(branch)) { console.error(`refusing to run on ${branch}: use a branch or a worktree`); process.exit(2); }
const dirty = git('status', '--porcelain', '--', ...HARNESS, ...PIN_FILES);
if (dirty) { console.error(`the harness or its pins have uncommitted changes:\n${dirty}`); process.exit(2); }
const BASE = git('rev-parse', 'HEAD');
Object.assign(record, { branch, base: BASE });
rmSync(WS, { recursive: true, force: true });
mkdirSync(join(WS, 'failures'), { recursive: true });

// ── 1. the incumbent on a sample of train tasks ───────────────────────────────────────────────
function sample(ids, n, seed) {
  let s = (seed * 2654435761) >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const a = [...ids];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}
// Draw train tasks N at a time, in a seeded order, until MIN_FAILURES scored failures or the split
// runs out. A given --train-dir is used as it is.
const GIVEN = opt('--train-dir');
const trainDirs = GIVEN ? [GIVEN] : [];
const scoredFailures = () => trainDirs.reduce((n, d) => n + [...readRuns(d).values()].filter((reps) => reps.some((r) => !r.pass && !r.void)).length, 0);
if (!GIVEN) {
  const all = tasksIn('train').map((t) => t.id);
  const order = sample(all, all.length, SEED);
  const pass = ['--endpoint', '--base', '--model', '--key-from', '--key', '--concurrency', '--timeout'].flatMap((f) => (opt(f) !== null ? [f, opt(f)] : []));
  for (let k = 0; k * N < order.length; k++) {
    const ids = order.slice(k * N, (k + 1) * N);
    const dir = join(WS, 'train', `c${k + 1}`);
    log(`train: ${ids.length} task(s), seed ${SEED}, draw ${k + 1}`);
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, [join(REPO, 'scripts/autoharness/run-split.mjs'), '--tasks', ids.join(','), '--reps', '1', '--out', dir, ...pass], { cwd: REPO, stdio: ['ignore', 'ignore', 'inherit'] });
      p.on('close', (c) => (c === 0 ? res() : rej(new Error(`run-split exited ${c}`))));
    });
    trainDirs.push(dir);
    if (scoredFailures() >= MIN_FAILURES) break;
  }
}

// ── 2. the evidence: failures as markdown ──────────────────────────────────────────────────────
const runs = new Map(trainDirs.flatMap((d) => [...readRuns(d)]));
let nRuns = 0, nVoid = 0;
const failed = [];
for (const [id, reps] of runs) {
  nRuns += reps.length; nVoid += reps.filter((r) => r.void).length;
  const bad = reps.filter((r) => !r.pass && !r.void);
  if (!bad.length) continue;
  failed.push(id);
  writeFileSync(join(WS, 'failures', `${id}.md`), failureMarkdown(bad[0], { reps: reps.filter((r) => !r.void).length, failed: bad.length }));
}
const summaries = trainDirs.map((d) => join(d, 'summary.json')).filter(existsSync).map((f) => JSON.parse(readFileSync(f, 'utf8')));
// The bed the evidence came from: each draw's summary says whether the agent had python (python.mjs).
// A summary without the field predates it, and that bed had none.
const BED_PYTHON = summaries.length > 0 && summaries.every((x) => x.python?.present === true);
if (summaries.length) writeFileSync(join(WS, 'summary.json'), JSON.stringify({ model: summaries[0].model, endpoint: summaries[0].endpoint, python: BED_PYTHON ? summaries[0].python : { present: false }, perTask: summaries.flatMap((x) => x.perTask) }, null, 2));
record.train = { dirs: trainDirs, tasks: runs.size, runs: nRuns, voids: nVoid, failed, python: BED_PYTHON };
log(`train: ${failed.length} of ${runs.size} task(s) failed (${nVoid} void)`);
if (!failed.length) finish('no-failures');
if (!GIVEN && failed.length < MIN_FAILURES) finish('thin-evidence', { note: `${failed.length} scored failure(s) across the whole train split; the optimizer needs ${MIN_FAILURES}` });

// ── 3. the base gate (cached by tree) ─────────────────────────────────────────────────────────
const gateList = GATE === 'full' ? gateCommands(REPO) : GATE.split(',').map((l) => (l.startsWith('node ') ? l : `node ${l}`));
const cacheDir = join(REPO, '.autoharness', 'gate-cache');
const baseGate = await runGate(REPO, { commands: gateList, cacheDir: GATE === 'full' ? cacheDir : null, cacheKey: treeOf(REPO), log });
log(`base gate: ${baseGate.lanes - baseGate.red.length}/${baseGate.lanes} green${baseGate.cached ? ' (cached)' : ''}`);

// ── 4. the optimizer, in a staging directory ──────────────────────────────────────────────────
const STAGE = mkdtempSync(join(tmpdir(), 'autoharness-stage-'));
for (const p of HARNESS) { mkdirSync(dirname(join(STAGE, 'harness', p)), { recursive: true }); copyFileSync(join(REPO, p), join(STAGE, 'harness', p)); }
for (const p of CONTEXT) { mkdirSync(dirname(join(STAGE, 'context', p)), { recursive: true }); copyFileSync(join(REPO, p), join(STAGE, 'context', p)); }
// The shell's own `help` — the ground truth for any claim about quoting, flags or commands. Round 4 of
// the first live run wrote "single quotes are literal rather than shell-quoting" into the shell tool's
// description; they quote as in any shell, and the edit cost 4 net dev runs.
{ const ws = freshWorkspace({}); await ws.ready; writeFileSync(join(STAGE, 'context', 'shell-help.txt'), String((await ws.shell.feed('help')).output || '')); }
mkdirSync(join(STAGE, 'evidence', 'failures'), { recursive: true });
for (const id of failed) copyFileSync(join(WS, 'failures', `${id}.md`), join(STAGE, 'evidence', 'failures', `${id}.md`));
if (existsSync(join(WS, 'summary.json'))) copyFileSync(join(WS, 'summary.json'), join(STAGE, 'evidence', 'summary.json'));
const HISTORY = opt('--history');
if (HISTORY && existsSync(HISTORY)) copyFileSync(HISTORY, join(STAGE, 'evidence', 'history.md'));
const SOLVER = opt('--model') || ENDPOINTS[opt('--endpoint') || DEFAULT_ENDPOINT]?.model || 'an unnamed model';
const BED = BED_PYTHON
  ? { runs: 'This benchmark runs it in a bed that has both, with the python runtime the app uses.', never: 'that the environment is a bed or a benchmark' }
  : { runs: 'This benchmark runs it in a bed that has node but NOT python, so a failure caused by a python call is a gap in the bed, not in the harness.', never: 'that python is unavailable, that the environment is a bed or a benchmark' };
const PROMPT = `You are optimizing the harness of Anvil, a coding agent whose model is ${SOLVER}. The agent works over a user's files with tools (read, write, edit, apply_patch, shell, task_done and others) and a curated bash-like shell. In the app the agent has python (a Pyodide kernel) and node. ${BED.runs} Never write facts about this bed or benchmark into the harness — ${BED.never}, task names, file names or answers. An edit that does is rejected before it is scored.

Harness files you may edit (and ONLY these), under harness/:
- harness/sys/ai/run-assembly.mjs — the system prompt (SYSTEM_HEAD, SYSTEM_TAIL, MODE_NOTE, LESSON_NOTE), the act-or-nudge text (ACT_NUDGE), the gate note, the toolset assembly and the run driver (driveRun).
- harness/sys/ai/procedural.mjs — the procedural prior: DEFAULT_GRAPH's edges, rendered between SYSTEM_HEAD and SYSTEM_TAIL.
- harness/sys/ai/agent-tools.mjs — every tool's schema and description (what the model reads about each tool) and the tool executors.
context/ holds read-only files that explain them: the agent loop, and shell-help.txt (the shell's own \`help\` output). Use only the files in this directory.

Evidence for round ${ROUND}, in evidence/:
- summary.json — pass/fail, tokens and steps per train task
- failures/<task_id>.md — for each FAILED train task: the instruction, the agent's trajectory and the grader's report
- history.md — earlier edits in this optimization run and whether held-out validation KEPT or REJECTED them (absent on the first round). Do not repeat a rejected idea; build on kept ones.

Constraints:
- The system prompt is a cache prefix shared by every run and project: no per-task, per-run or time-varying text in SYSTEM_HEAD, SYSTEM_TAIL or the procedural graph.
- RUN_BUDGET and RELOOP_BUDGET are fixed by the owner; do not change them.
- The repo's CI pins the prompt's seams (the head ends "Use python for scripting). ", the prior starts "Read a file before editing it, unless" and ends "one solver.", the tail starts " Work in small, verifiable steps") and several procedural sentences. An edit that breaks a CI lane is rejected. Safest: add or reword sentences inside SYSTEM_TAIL, ACT_NUDGE, an edge's text or a tool's description; keep edge ids, exported names and function signatures.
- Every statement you add about how a tool or the shell behaves must be true: check it against harness/sys/ai/agent-tools.mjs or context/shell-help.txt first. A false description is worse than none.
- Do not run the agent or any benchmark.

Do this:
1. Read the failures. Identify the 1-2 most common, harness-fixable failure patterns. Ignore one-off reasoning mistakes.
2. Make ONE focused change to the harness that addresses the top pattern. Keep it general: never hardcode task-specific answers, task ids, file names or data from the tasks.
3. Finish with a final message containing exactly one line starting with \`RATIONALE:\` that states the failure pattern (with how many failed tasks showed it) and the change you made, in one sentence.
`;
writeFileSync(join(WS, 'optimizer_prompt.md'), PROMPT);
const oldSnap = snapshot(REPO);
const before = repoFiles();
const ignoredBefore = ignoredPaths();
const replyFile = join(WS, 'optimizer_reply.md');
const optT0 = Date.now();
const optLog = join(WS, 'optimizer.log');
const optCode = await new Promise((res) => {
  const argv = OPT_CMD ? ['/bin/bash', ['-c', OPT_CMD]]
    : ['codex', ['exec', '-m', OPT_MODEL, '-s', 'workspace-write', '-C', STAGE, '--skip-git-repo-check', '--ephemeral', '-o', replyFile, PROMPT]];
  const p = spawn(argv[0], argv[1], { cwd: STAGE, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, AUTOHARNESS_STAGE: STAGE, AUTOHARNESS_REPLY: replyFile } });
  let out = '';
  p.stdout.on('data', (c) => { out += c; }); p.stderr.on('data', (c) => { out += c; });
  p.on('close', (c) => { writeFileSync(optLog, out); res(c); });
});
const optLogText = readFileSync(optLog, 'utf8');
const tok = /tokens used\s*\n?\s*([\d,]+)/i.exec(optLogText);
Object.assign(record.optimizer, { exit: optCode, seconds: Math.round((Date.now() - optT0) / 1000), tokens: tok ? Number(tok[1].replace(/,/g, '')) : null });
const reply = existsSync(replyFile) ? readFileSync(replyFile, 'utf8') : '';
record.rationale = (reply.split('\n').find((l) => l.includes('RATIONALE:')) || '').split('RATIONALE:')[1]?.trim() || 'no rationale given';
log(`optimizer exit ${optCode} in ${record.optimizer.seconds}s`);

// ── 5. the guard: the repo did not move, and nothing in it changed during the call ───────────
if (git('rev-parse', 'HEAD') !== BASE || git('rev-parse', '--abbrev-ref', 'HEAD') !== branch) finish('repo-moved', { error: 'HEAD or the branch changed during the optimizer call; left for a person' });
const strayed = changedBetween(before, repoFiles());
if (strayed.length) { log(`restoring ${strayed.length} repo file(s) changed during the call: ${strayed.join(', ')}`); restore(before, strayed); }
const newIgnored = [...ignoredPaths()].filter((p) => !ignoredBefore.has(p));
for (const p of newIgnored) rmSync(join(REPO, p), { recursive: true, force: true });
if (newIgnored.length) log(`removed ${newIgnored.length} ignored path(s) created during the call: ${newIgnored.join(', ')}`);
record.reverted = [...strayed, ...newIgnored];

// ── 6. bring back the harness edit ─────────────────────────────────────────────────────────────
const edited = HARNESS.filter((p) => !readFileSync(join(STAGE, 'harness', p)).equals(before.get(p)));
for (const p of edited) copyFileSync(join(STAGE, 'harness', p), join(REPO, p));
record.edited = edited;
rmSync(STAGE, { recursive: true, force: true });
if (!edited.length) finish('no-edit');
record.diffStat = git('diff', '--stat', '--', ...edited);

// ── 6b. the leakage screen (RRSI's critic, for this bed's one known confound) ──────────────────
// The words the edit ADDED, from a word diff, checked for facts about the bench rather than about the
// app. Round 2 of the first live loop (2026-10-01) added "This Node bed does not provide Python; use
// node for scripting" — true in the bed, false in Anvil, where python is the scripting language.
const added = git('diff', '-U0', '--word-diff=porcelain', '--word-diff-regex=[^[:space:]]+', '--', ...edited)
  .split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1)).join(' ');
const BED_FACTS = [/\bbed\b/i, /\bbench(mark)?s?\b/i, /\bautoharness\b/i, /\bbattery\b/i,
  /\bpython\b[^.;]{0,48}\b(not|unavailable|absent|missing|lacks?|no longer)\b/i, /\b(no|not|without|lacks?|unavailable)\b[^.;]{0,48}\bpython\b/i];
const leaks = BED_FACTS.map((re) => re.exec(added)?.[0]).filter(Boolean);
if (leaks.length) { restore(before, [...HARNESS, ...PIN_FILES]); finish('bed-leak', { leaks, addedText: added.slice(0, 600) }); }
writeFileSync(join(WS, 'candidate.diff'), git('diff', '--', ...edited) + '\n');

// ── 7. pins ────────────────────────────────────────────────────────────────────────────────────
const undo = () => restore(before, [...HARNESS, ...PIN_FILES]);
let newSnap;
try { newSnap = snapshot(REPO); } catch (e) { undo(); finish('broken-module', { error: String(e.message).slice(0, 400) }); }
const pinOut = writePins(REPO, oldSnap, newSnap, { id: `R${ROUND}`, why: record.rationale });
record.pins = { added: pinOut.pins.map((p) => p.id), procedural: pinOut.procedural, inventory: pinOut.inventory, inventoryProblems: pinOut.inventoryProblems };

// ── 8. the gate ────────────────────────────────────────────────────────────────────────────────
const candGate = await runGate(REPO, { commands: gateList, log });
const newRed = candGate.red.filter((c) => !baseGate.red.includes(c));
record.gate = { lanes: candGate.lanes, baseRed: baseGate.red, red: candGate.red, newRed, seconds: candGate.seconds,
  newRedTails: candGate.results.filter((r) => newRed.includes(r.command)).map((r) => ({ command: r.command, tail: r.tail.slice(-600) })) };
log(`candidate gate: ${candGate.lanes - candGate.red.length}/${candGate.lanes} green, ${newRed.length} newly red`);
if (newRed.length) { undo(); finish('ci-red'); }

// ── 9. commit the candidate ────────────────────────────────────────────────────────────────────
if (NO_COMMIT) finish('candidate', { note: '--no-commit: the edit and its pins are in the working tree' });
const pinPaths = PIN_FILES.filter((p) => git('status', '--porcelain', '--', p));
git('add', '--', ...edited, ...pinPaths);
const msg = [
  `autoharness R${ROUND}: ${record.rationale.slice(0, 200)}`, '',
  `Files: ${edited.join(', ')}`,
  `Pins: ${record.pins.added.join(', ') || 'none'}${pinOut.procedural ? '; procedural golden updated' : ''}`,
  `Inventory: ${pinOut.inventory.length ? pinOut.inventory.join('; ') : 'no change'}`,
  `Train: ${failed.length} of ${runs.size} task(s) failed, seed ${SEED}`,
  `Optimizer: ${OPT_CMD ? 'command' : 'codex ' + OPT_MODEL} (${record.optimizer.seconds}s)`,
  `Gate: ${candGate.lanes} lanes, ${baseGate.red.length} red at base, 0 newly red`, '',
  'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>',
].join('\n');
execFileSync('git', ['commit', '-q', '-F', '-'], { cwd: REPO, input: msg });
finish('committed', { commit: git('rev-parse', 'HEAD') });
