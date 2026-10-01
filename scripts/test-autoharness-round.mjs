#!/usr/bin/env node
// Layer 3 of the autoharness optimizer: does one round do what it claims? No live model, no Codex.
//   node scripts/test-autoharness-round.mjs
//
// A copy of this repo (sys/, scripts/, verify/, apps/anvil/, the workflow) becomes a scratch git repo
// on a branch. The train evidence is one scripted failed run. A stub stands in for the optimizer:
// it edits the STAGED harness, and also tries to change the repo behind the round's back. Four rounds:
//   1. a SYSTEM_TAIL sentence  → committed: only the harness file and its pin; the repo edits restored;
//      the copied test-run-assembly passes on the new bytes
//   2. a tool description      → committed with the inventory rebaselined (tool:read)
//   3. a pinned seam           → ci-red: nothing committed, the working tree restored
//   4. no edit                 → no-edit
//   5. a bed fact              → bed-leak (screened before pins, gate or dev runs)
//   6. python named, no bed    → committed (the screen is not a python ban)
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS } from './autoharness/battery.mjs';
import { runTask, scriptedInfer } from './autoharness/bed.mjs';
import { scratchRepo } from './autoharness/scratch.mjs';

const { TMP, REPO, git } = scratchRepo('ah-round-');
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)}`); if (!cond) failed++; };

// ── one scripted failed train run, in run-split's layout ──
const task = TASKS.find((t) => t.id === 'battery-write-fresh');
const r = await runTask(task, { infer: scriptedInfer([{ tool: 'write', args: { path: 'hi.txt', content: 'hello' } }, { say: 'Wrote hi.txt.' }]) });
if (r.pass || r.void) throw new Error('the fixture run must be a scored failure');
const TRAIN = join(TMP, 'train');
mkdirSync(join(TRAIN, 'runs', task.id), { recursive: true });
writeFileSync(join(TRAIN, 'runs', task.id, '0.json'), JSON.stringify({ ...r, rep: 0, split: task.split, family: task.family, prompt: task.prompt }));

// ── the stub optimizer: one literal replacement in a staged file, plus mischief in the repo ──
const STUB = join(TMP, 'stub.mjs');
writeFileSync(STUB, `import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [file, from, to] = JSON.parse(process.env.STUB_EDIT || 'null') || [];
const stage = process.env.AUTOHARNESS_STAGE;
if (!readFileSync(join(stage, 'evidence/failures/battery-write-fresh.md'), 'utf8').includes('write hi.txt containing hi')) throw new Error('the evidence is not staged');
if (file) { const p = join(stage, 'harness', file); const t = readFileSync(p, 'utf8'); if (!t.includes(from)) throw new Error('stub: no ' + from); writeFileSync(p, t.replace(from, to)); }
writeFileSync(join(process.env.REPO_UNDER_TEST, 'stray.txt'), 'stray');
writeFileSync(join(process.env.REPO_UNDER_TEST, 'scripts/autoharness/battery.mjs'), '// clobbered');
writeFileSync(process.env.AUTOHARNESS_REPLY, 'Looked at 1 failure.\\nRATIONALE: stub edit for the round test.\\n');
`);
const GATE = 'scripts/test-run-assembly.mjs,scripts/test-anvil-procedural.mjs,scripts/verify-inventory.mjs';
function round(n, edit) {
  const p = spawnSync(process.execPath, ['scripts/autoharness/round.mjs', '--round', String(n), '--train-dir', TRAIN, '--optimizer-cmd', `node ${STUB}`, '--gate', GATE],
    { cwd: REPO, encoding: 'utf8', env: { ...process.env, STUB_EDIT: JSON.stringify(edit), REPO_UNDER_TEST: REPO } });
  const f = join(REPO, '.autoharness', `round-${n}`, 'round.json');
  return { code: p.status, stderr: p.stderr, rec: existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null };
}
const batteryBefore = readFileSync(join(REPO, 'scripts/autoharness/battery.mjs'), 'utf8');
console.log('autoharness round (stub optimizer, scratch repo):');

// 1. a tail sentence
const head0 = git('rev-parse', 'HEAD');
const r1 = round(1, ['sys/ai/run-assembly.mjs', 'End with a one-line summary.', 'End with a one-line summary. Remove any scratch file you created before you finish.']);
check('round 1 exits 0 and commits the candidate', r1.code === 0 && r1.rec?.outcome === 'committed', r1.stderr.slice(-800));
const files1 = git('diff', '--name-only', head0, 'HEAD').split('\n').sort();
check('the commit holds the harness file and its pin, nothing else', JSON.stringify(files1) === JSON.stringify(['sys/ai/run-assembly.mjs', 'sys/ai/test/prompt-pins.json']), files1.join(', '));
check('the repo changes made during the call are restored', !existsSync(join(REPO, 'stray.txt')) && readFileSync(join(REPO, 'scripts/autoharness/battery.mjs'), 'utf8') === batteryBefore && (r1.rec?.reverted || []).length === 2, JSON.stringify(r1.rec?.reverted));
const pins = JSON.parse(readFileSync(join(REPO, 'sys/ai/test/prompt-pins.json'), 'utf8')).pins;
check('a literal pin records the new span', pins.some((p) => p.id.startsWith('R1-') && p.after.includes('Remove any scratch file')), JSON.stringify(pins.at(-1)).slice(0, 300));
const rt = spawnSync(process.execPath, ['scripts/test-run-assembly.mjs'], { cwd: REPO, encoding: 'utf8' });
check('the pinned test passes on the new bytes', rt.status === 0, rt.stderr.slice(-400));
check('the commit message carries the rationale', /autoharness R1: stub edit for the round test/.test(git('log', '-1', '--format=%B')));
check('the failure evidence was written as markdown', existsSync(join(REPO, '.autoharness/round-1/failures/battery-write-fresh.md')));

// 2. a tool description → the inventory is rebaselined
const head1 = git('rev-parse', 'HEAD');
const r2 = round(2, ['sys/ai/agent-tools.mjs', "description: 'Read a text file from the workspace, returned with line numbers.", "description: 'Read a text file from the workspace, returned with line numbers (a final newline adds no line)."]);
const files2 = git('diff', '--name-only', head1, 'HEAD').split('\n').sort();
check('round 2 commits a tool-description edit with the inventory rebaselined', r2.rec?.outcome === 'committed' && files2.includes('verify/anvil/inventory.json') && (r2.rec?.pins?.inventory || []).some((d) => d.includes('tool:read')), `${r2.rec?.outcome} ${files2.join(', ')} ${JSON.stringify(r2.rec?.pins)} ${JSON.stringify(r2.rec?.gate?.newRedTails)}`);

// 3. a pinned seam → ci-red, nothing committed, the tree restored
const head2 = git('rev-parse', 'HEAD');
const r3 = round(3, ['sys/ai/run-assembly.mjs', ' Work in small, verifiable steps,', ' Work in tiny steps,']);
check('round 3 is rejected by the gate (ci-red)', r3.rec?.outcome === 'ci-red' && r3.rec.gate.newRed.some((c) => c.includes('test-run-assembly')), `${r3.rec?.outcome} ${JSON.stringify(r3.rec?.gate?.newRed)}`);
check('and leaves no commit and a clean harness', git('rev-parse', 'HEAD') === head2 && git('status', '--porcelain', '--', 'sys/ai', 'verify/anvil') === '', git('status', '--porcelain'));

// 4. no edit
const r4 = round(4, null);
check('round 4 with no edit reports no-edit', r4.rec?.outcome === 'no-edit' && git('rev-parse', 'HEAD') === head2, r4.rec?.outcome);

// 5. a bed fact → bed-leak, rejected before pins, gate or dev runs
const r5 = round(5, ['sys/ai/run-assembly.mjs', 'End with a one-line summary.', 'End with a one-line summary. This Node bed does not provide Python; use node for scripting.']);
check('round 5 (a fact about the bed, not the app) is screened out as bed-leak', r5.rec?.outcome === 'bed-leak' && (r5.rec.leaks || []).length > 0 && !r5.rec.gate, JSON.stringify({ o: r5.rec?.outcome, l: r5.rec?.leaks }));
check('and leaves no commit and a clean harness', git('rev-parse', 'HEAD') === head2 && git('status', '--porcelain', '--', 'sys/ai', 'verify/anvil') === '', git('status', '--porcelain'));
// a harness sentence that merely mentions python stays allowed
const r6 = round(6, ['sys/ai/run-assembly.mjs', 'End with a one-line summary.', 'End with a one-line summary. Prefer python for multi-step data work.']);
check('round 6 (python named, nothing about the bed) is not screened out', r6.rec?.outcome === 'committed', JSON.stringify({ o: r6.rec?.outcome, l: r6.rec?.leaks }));

// the round refuses main
git('checkout', '-q', 'main');
const rm = spawnSync(process.execPath, ['scripts/autoharness/round.mjs', '--round', '7', '--train-dir', TRAIN, '--optimizer-cmd', 'true'], { cwd: REPO, encoding: 'utf8' });
check('a round on main is refused', rm.status === 2 && /refusing to run on main/.test(rm.stderr), rm.stderr);

if (failed) { console.log(`${failed} check(s) failed — scratch repo kept at ${REPO}`); process.exit(1); }
