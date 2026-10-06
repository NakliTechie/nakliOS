#!/usr/bin/env node
// Layer 1 of the autoharness optimizer: is every task in the battery a real task? No live model.
//   node scripts/test-autoharness-battery.mjs
//
// A criterion nobody has seen fail is decoration (plan/bench-playbook.md §2). For each task:
//   1. its scripted reference solution, run through the app's assembly (driveRun, the real tools,
//      the in-memory workspace), PASSES the gate;
//   2. a run that does nothing on the untouched seed FAILS it — the seed is not already an answer;
//   3. a run that does nothing in an EMPTY workspace FAILS it.
// Plus the battery's shape: ≥ 60 tasks, unique ids, a fixed split per task, every family in every split.
//
// A `pythonRef` task's reference runs `python -c`. In a bed with python (AUTOHARNESS_PYODIDE=<dir>,
// scripts/autoharness/python.mjs) it must pass like any other; in the bed without it (CI's) it must
// FAIL, which shows the reference really goes through python.
import assert from 'node:assert/strict';
import { TASKS, SPLITS } from './autoharness/battery.mjs';
import { runTask, scriptedInfer } from './autoharness/bed.mjs';
import { PYODIDE_DIR } from './autoharness/python.mjs';

let failed = 0;
const check = (name, cond, detail = '') => { if (!cond) { failed++; console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); } };

// ── shape ──
assert.ok(TASKS.length >= 60, `the battery has ${TASKS.length} tasks; it needs at least 60`);
assert.equal(new Set(TASKS.map((t) => t.id)).size, TASKS.length, 'task ids are unique');
for (const t of TASKS) {
  for (const k of ['id', 'split', 'family', 'prompt']) assert.equal(typeof t[k], 'string', `${t.id}: ${k} is a string`);
  assert.ok(SPLITS.includes(t.split), `${t.id}: split "${t.split}" is one of ${SPLITS.join('/')}`);
  assert.equal(typeof t.seed, 'object', `${t.id}: seed is an object`);
  assert.equal(typeof t.gate, 'function', `${t.id}: gate is a function`);
  assert.ok(Array.isArray(t.solve) && t.solve.length, `${t.id}: has a scripted solution`);
  if (t.pythonRef) assert.ok(t.solve.some((s) => /^python3? -c /.test(s.args?.command || '')), `${t.id}: a pythonRef reference runs python -c`);
}
const families = [...new Set(TASKS.map((t) => t.family))];
for (const f of families) for (const s of SPLITS) {
  assert.ok(TASKS.some((t) => t.family === f && t.split === s), `family ${f} has a task in ${s}`);
}

// ── every gate: green on the reference, red on the untouched seed, red on an empty workspace ──
const t0 = Date.now();
for (const t of TASKS) {
  const good = await runTask(t, { infer: scriptedInfer(t.solve) });
  if (t.pythonRef && !PYODIDE_DIR) check(`${t.id}: without python, its python reference fails`, !good.pass && !good.crash, `pass ${good.pass} | crash: ${good.crash} | changed ${good.changed.join(',')}`);
  else check(`${t.id}: the reference solution passes`, good.pass && !good.crash, `why: ${good.why} | crash: ${good.crash} | stop ${good.stop} | changed ${good.changed.join(',')} | answer ${JSON.stringify(good.answer.slice(0, 80))}`);
  const idle = await runTask(t, { infer: scriptedInfer([]) });
  check(`${t.id}: doing nothing on the seed fails`, !idle.pass && !idle.crash, `crash: ${idle.crash}`);
  const empty = await runTask({ ...t, seed: {} }, { infer: scriptedInfer([]) });
  check(`${t.id}: doing nothing in an empty workspace fails`, !empty.pass && !empty.crash, `crash: ${empty.crash}`);
}

const counts = Object.fromEntries(SPLITS.map((s) => [s, TASKS.filter((t) => t.split === s).length]));
const pyRefs = TASKS.filter((t) => t.pythonRef).length;
console.log(`autoharness battery: ${TASKS.length} tasks (${SPLITS.map((s) => `${s} ${counts[s]}`).join(', ')}), ${families.length} families, ${TASKS.length * 3} scripted runs in ${Math.round((Date.now() - t0) / 1000)}s, bed ${PYODIDE_DIR ? 'with python' : 'without python'}`);
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
console.log(PYODIDE_DIR
  ? 'ok — every gate passes its reference (python ones included) and fails on the seed and on an empty workspace'
  : `ok — every gate passes its reference and fails on the seed and on an empty workspace; ${pyRefs} python reference(s) fail without python as they must (AUTOHARNESS_PYODIDE=<dir> checks that they pass)`);
