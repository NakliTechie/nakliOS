// CRIB-E E3 (ZR-A2) — turn-scoped change review, driven through Anvil's REAL handlers.
//   node scripts/test-anvil-turn-review.mjs
//
// A change chip reviews one write. A run is now reviewed as a unit: when it ends it leaves one
// "This run changed N files" row, which opens every file's before-the-run → now diff, with a
// Revert that restores only files the run's result still stands in. The gate the research item
// named: reload, missing pre-image, storage failure, concurrent edit, safe revert. The pure half
// is in sys/ai/test/change-preimages.test.mjs; this file runs the app's own functions.
import assert from 'node:assert/strict';
import { inlineModule, extractFunction, extractRegion, instantiate, evaluate, memFs, failingFs } from './anvil-harness.mjs';
import { buildChangeRow, planRevert, prunePreimages, turnChanges, planTurnRevert } from '../sys/ai/change-preimages.mjs';

const src = await inlineModule();
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
const lineDiff = instantiate(extractFunction(src, 'lineDiff'), 'lineDiff', {});

// A task whose run 2 edited a.py twice and b.py once; run 1 touched old.txt.
function task() {
  const row = (run, file, pre, post) => ({ ...buildChangeRow({ file, verb: 'edited', pre, post }), run });
  return { id: 't', runSeq: 2, log: [
    row(1, 'old.txt', 'o0', 'o1'),
    row(2, 'a.py', 'A0', 'A1'), row(2, 'b.py', 'B0', 'B1'), row(2, 'a.py', 'A1', 'A2'),
  ] };
}
function bed(t, fs) {
  const calls = { system: [], renders: 0 };
  const ctx = { turnChanges, planTurnRevert, lineDiff, fs, state: {}, globalPreview: null,
    activeTask: () => t, pushSystem: (x) => calls.system.push(x), save() {}, renderAll() { calls.renders++; }, renderPreview() {} };
  const openTurn = instantiate(extractFunction(src, 'openTurn'), 'openTurn', ctx);
  ctx.openTurn = openTurn;
  const revertTurn = instantiate(extractFunction(src, 'revertTurn'), 'revertTurn', ctx);
  return { openTurn, revertTurn, calls };
}

await test('the review shows each file from BEFORE the run to now — one entry per file, only this run', async () => {
  const t = task(); const fs = memFs({ 'a.py': 'A2', 'b.py': 'B1', 'old.txt': 'o1' });
  await bed(t, fs).openTurn(t, 2);
  assert.equal(t.preview.turn, 2); assert.equal(t.preview.type, 'diff');
  assert.match(t.preview.file, /Run 2 — 2 files/);
  assert.match(t.preview.content, /=== a\.py \(2 edits\) ===/, 'a.py once, with its edit count');
  assert.match(t.preview.content, /-A0/); assert.match(t.preview.content, /\+A2/);
  assert.ok(!/old\.txt/.test(t.preview.content), 'run 1\'s change is not this run\'s');
  assert.equal(t.preview.note, '');
});

await test('safe revert: files the run\'s result still stands in are restored to their pre-run text', async () => {
  const t = task(); const fs = memFs({ 'a.py': 'A2', 'b.py': 'B1' });
  const b = bed(t, fs); await b.revertTurn(2);
  assert.equal(fs.store['a.py'], 'A0', 'two edits undone as one: back to before the run');
  assert.equal(fs.store['b.py'], 'B0');
  assert.match(b.calls.system[0], /Reverted run 2: a\.py, b\.py/);
});

await test('concurrent edit: a file touched since the run is skipped and named, never overwritten', async () => {
  const t = task(); const fs = memFs({ 'a.py': 'A2', 'b.py': 'B1 + the owner\'s edit' });
  const b = bed(t, fs); await b.revertTurn(2);
  assert.equal(fs.store['a.py'], 'A0', 'the untouched file is restored');
  assert.equal(fs.store['b.py'], 'B1 + the owner\'s edit', 'the touched one is left alone');
  assert.ok(b.calls.system.some((l) => /Not reverted — b\.py has changed since the agent wrote it/.test(l)), b.calls.system.join(' | '));
});

await test('missing pre-image: the review says which file has no diff, and revert skips it with the reason', async () => {
  const t = task();
  t.log = prunePreimages(t.log, { budget: 3 }).log; // retention dropped the older pre-images
  const fs = memFs({ 'a.py': 'A2', 'b.py': 'B1' });
  const b = bed(t, fs); await b.openTurn(t, 2);
  assert.match(t.preview.note, /No before\/after diff for: .*a\.py/, t.preview.note);
  await b.revertTurn(2);
  assert.equal(fs.store['a.py'], 'A2', 'no pre-image, no write');
  assert.ok(b.calls.system.some((l) => /No previous version was kept for a\.py/.test(l)));
});

await test('storage failure: a write that fails is reported as not reverted, never as reverted', async () => {
  const t = task(); const fs = { ...failingFs('disk full'), read: memFs({ 'a.py': 'A2', 'b.py': 'B1' }).read };
  const b = bed(t, fs); await b.revertTurn(2);
  assert.ok(!b.calls.system.some((l) => /Reverted run/.test(l)), 'nothing claims success: ' + b.calls.system.join(' | '));
  assert.ok(b.calls.system.filter((l) => /Not reverted — .* — disk full/.test(l)).length === 2, b.calls.system.join(' | '));
});

await test('reload: the turn row, its run tag and the pre-images are plain task state — a JSON round-trip reviews the same', async () => {
  const t = JSON.parse(JSON.stringify(task())); // what localStorage / state.json hand back
  const fs = memFs({ 'a.py': 'A2', 'b.py': 'B1' });
  await bed(t, fs).openTurn(t, 2);
  assert.match(t.preview.content, /=== a\.py \(2 edits\) ===/);
});

// The app tags every change with its run, leaves one turn row when a run changed files, and wires
// the preview's Revert to the run when the preview is a turn.
await test('wiring: run tag, turn row at run end, and the preview button', async () => {
  assert.match(src, /t\.runSeq=\(t\.runSeq\|\|0\)\+1;/, 'each run takes a sequence number');
  assert.match(src, /if\(t\.runSeq\) row\.run = t\.runSeq;/, 'each change row carries it');
  const endRegion = extractRegion(src, "try{ const tc=turnChanges(t.log, t.runSeq);", 'running=false;');
  const t = task(); t.log = t.log.slice(); evaluate(endRegion, { t, turnChanges });
  // (the row is built inside the vm realm, so compare by value, not by prototype)
  assert.equal(JSON.stringify(t.log.at(-1)), JSON.stringify({ k: 'turn', run: 2, files: 2, state: 'complete' }), 'a run that changed files leaves one turn row');
  const quiet = { id: 'q', runSeq: 3, log: task().log }; evaluate(endRegion, { t: quiet, turnChanges });
  assert.notEqual(quiet.log.at(-1).k, 'turn', 'a run that changed nothing leaves no row');
  assert.match(src, /if\(pv\.turn!=null\)\{ rev\.hidden=false; rev\.textContent='↶ Revert this run';[^\n]*rev\.onclick=\(\)=>revertTurn\(pv\.turn\); \}/, 'the preview button reverts the run');
});

if (failures.length) {
  console.error(`anvil-turn-review: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`anvil-turn-review: ${passed}/${passed} passed — review and revert a run: safe restore, concurrent edit, missing pre-image, storage failure, reload`);
