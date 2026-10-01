#!/usr/bin/env node
// Layer 4 of the autoharness optimizer: does the loop keep a real gain, reject noise, and stop? No
// live model, no Codex.
//   node scripts/test-autoharness-loop.mjs
//
// A scratch repo, a stub model server and a stub optimizer. The server answers "what is 17 times
// 23?" with 391 only when the system prompt carries the sentence MARKER, else 390. The optimizer
// adds MARKER to SYSTEM_TAIL in round 1, a sentence that changes nothing in round 2, and nothing in
// round 3. Dev is the two "answer" battery cases × 3 reps, scored for incumbent and candidate in
// the same batch. Expected: round 1 kept (+6 paired, margin 3), round 2 rejected and git-reverted
// (net 0), round 3 no candidate → two dry rounds → patience 2 stops the loop.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TASKS } from './autoharness/battery.mjs';
import { runTask, scriptedInfer } from './autoharness/bed.mjs';
import { scratchRepo } from './autoharness/scratch.mjs';
import { compare } from './autoharness/score.mjs';

const MARKER = 'Answer arithmetic exactly.';
const { TMP, REPO, git } = scratchRepo('ah-loop-');
let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n        ' + String(detail).slice(0, 700)}`); if (!cond) failed++; };

const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const ok = String(body.messages?.[0]?.content || '').includes(MARKER);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ok ? '391' : '390' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 }, model: 'stub' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));

// train evidence: one scored failure
const task = TASKS.find((t) => t.id === 'battery-write-fresh');
const r = await runTask(task, { infer: scriptedInfer([{ tool: 'write', args: { path: 'hi.txt', content: 'hello' } }, { say: 'Wrote hi.txt.' }]) });
const TRAIN = join(TMP, 'train');
mkdirSync(join(TRAIN, 'runs', task.id), { recursive: true });
writeFileSync(join(TRAIN, 'runs', task.id, '0.json'), JSON.stringify({ ...r, rep: 0, split: task.split, family: task.family, prompt: task.prompt }));

// the stub optimizer: the n-th call makes the n-th edit
const STUB = join(TMP, 'stub.mjs'), COUNT = join(TMP, 'count');
writeFileSync(STUB, `import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const n = (existsSync(${JSON.stringify(COUNT)}) ? Number(readFileSync(${JSON.stringify(COUNT)}, 'utf8')) : 0) + 1;
writeFileSync(${JSON.stringify(COUNT)}, String(n));
const p = join(process.env.AUTOHARNESS_STAGE, 'harness/sys/ai/run-assembly.mjs');
const add = { 1: ${JSON.stringify(' ' + MARKER)}, 2: ' Keep summaries short.' }[n];
if (add) writeFileSync(p, readFileSync(p, 'utf8').replace('End with a one-line summary.', 'End with a one-line summary.' + add));
writeFileSync(process.env.AUTOHARNESS_REPLY, 'RATIONALE: stub edit ' + n + '.\\n');
`);

// Async, never spawnSync: the stub server lives in THIS process, and a blocked event loop answers no
// one — every scoring call then times out as void (the first version of this lane did exactly that).
const p = await new Promise((resolve) => {
  const c = spawn(process.execPath, ['scripts/autoharness/loop.mjs', '--margin', '3', '--rounds', '5', '--patience', '2', '--reps', '3',
    '--dev-tasks', 'battery-answer-fresh,battery-answer-finished', '--train-dir', TRAIN, '--optimizer-cmd', `node ${STUB}`, '--gate', 'scripts/test-run-assembly.mjs',
    '--base', `http://127.0.0.1:${srv.address().port}/v1`, '--model', 'stub', '--key', 'x', '--concurrency', '3', '--timeout', '30'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  c.stderr.on('data', (d) => { stderr += d; }); c.stdout.on('data', () => {});
  c.on('close', (status) => resolve({ status, stderr }));
});
srv.close();

console.log('autoharness loop (stub model, stub optimizer, scratch repo):');
check('the loop exits 0', p.status === 0, p.stderr.slice(-1200));
const ledgerPath = join(REPO, '.autoharness/ledger.jsonl');
const rows = existsSync(ledgerPath) ? readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
check('three rounds ran, then patience 2 stopped the loop', rows.length === 3 && /patience 2 reached/.test(p.stderr), `${rows.length} rows; ${p.stderr.slice(-300)}`);
const [k, rj, nc] = rows;
check('round 1 (the marker) is kept: +6 paired, 0 lost, z 2.45', k?.verdict === 'kept' && k.dS.up === 6 && k.dS.down === 0 && k.dS.z === 2.45 && k.beacon?.fired === true, JSON.stringify(k?.dS));
check('round 2 (no effect) is rejected below the margin and reverted', rj?.verdict === 'rejected' && rj.dS.delta === 0 && /below the margin 3/.test(rj.reason) && !!rj.revert, JSON.stringify({ v: rj?.verdict, r: rj?.reason }));
check('round 3 (no edit) leaves no candidate', nc?.verdict === 'no-candidate' && nc.reason === 'no-edit', JSON.stringify(nc));
const tail = readFileSync(join(REPO, 'sys/ai/run-assembly.mjs'), 'utf8');
check('the branch holds the kept edit and not the rejected one', tail.includes(MARKER) && !tail.includes('Keep summaries short.'));
check('the rejected candidate stays in history as a commit and its revert', /autoharness R2/.test(git('log', '--format=%s')) && /Revert "autoharness R2/.test(git('log', '--format=%s')));
const hist = readFileSync(join(REPO, '.autoharness/history.md'), 'utf8');
check('the optimizer history names each verdict', /Round 1: KEPT/.test(hist) && /Round 2: REJECTED/.test(hist) && /Round 3: NO-CANDIDATE/.test(hist), hist.slice(0, 400));
check('each ledger row carries hypothesis, ΔS, ΔC and the margin (RRSI shape)', !!(k?.hypothesis && k.dS && k.dC && k.margin === 3 && k.diff));
check('the scoring worktrees were removed', !/score/.test(git('worktree', 'list')), git('worktree', 'list'));
// a summary with python and one without are two beds: never paired (a summary without the field had none)
const arm = (python) => ({ summary: { ...(python === undefined ? {} : { python: { present: python } }), meanInputTokensPerRun: 1 }, runs: new Map() });
let mixed = null;
try { compare(arm(true), arm(false)); } catch (e) { mixed = e.message; }
check('arms from a bed with python and one without are refused, never paired', /different beds/.test(mixed || '') && compare(arm(undefined), arm(false)).pairs === 0, mixed);
if (failed) { console.log(`${failed} check(s) failed — scratch repo kept at ${REPO}`); process.exit(1); }
