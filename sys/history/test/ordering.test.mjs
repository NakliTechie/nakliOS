// AC-1 — ordering metrics: how many tool calls happened before the run's first real action.
//   node sys/history/test/ordering.test.mjs
//
// The metric exists because CALL VOLUME does not track a harness improvement and ordering does
// (arXiv:2609.09153: guidance cut one model 18.94 → 12.53 calls per month while raising its
// score, and raised another 0.89 → 3.18 with survival improving). We saw the same shape here on
// 2026-09-07 — a run that answered in ONE `rg -n "def solve" --type py` against one that made 7
// searches by step 8 and died at max-steps — and nothing folded it, so it stayed an anecdote.
//
// What this file mostly guards is the HONESTY of the numbers, not their arithmetic:
//   · an unanchored run reports null, never 0 (0 would read as "instant");
//   · a heuristic anchor is labelled so it cannot be silently compared to a gate-anchored one;
//   · `2>&1` is not a redirect;
//   · deltaOf refuses to subtract across unlike anchors.
// Each of those is a way the metric could quietly lie, which is worse than not having it.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createRunRecorder, loadRecord, foldOrdering, groupOrdering } from '../run-record.mjs';
import { deltaOf, metricsOf } from '../../ai/ablate.mjs';

// ── a recorder driven by hand, so each shape is exactly the one being asserted ──
async function record(steps) {
  const rec = createRunRecorder({ app: 'test', principal: 'ordering' });
  await rec.start({ messages: [{ role: 'user', content: 'go' }], tools: [] });
  let n = 0;
  for (const s of steps) {
    if (s.call) {
      const id = `c${n++}`;
      rec.onEvent({ type: 'tool-call', id, name: s.call, args: s.args, step: n });
      if (s.fail) rec.onEvent({ type: 'tool-error', id, name: s.call, step: n, error: 'boom' });
      else rec.onEvent({ type: 'tool-result', id, name: s.call, args: s.args, step: n, result: s.result ?? '(no output)' });
    }
    if (s.verify === 'pass') rec.onEvent({ type: 'verify-pass', step: n, verdict: 'ok' });
    if (s.verify === 'fail') rec.onEvent({ type: 'verify-fail', step: n, round: 1, ran: 'x', verdict: 'no' });
  }
  await rec.finish({ stop: 'done', steps: n, verified: steps.some((s) => s.verify === 'pass') });
  await rec.settled();
  return rec;
}
const foldOf = async (steps) => { const r = await record(steps); return foldOrdering(r.events(), r.resolve); };

// ── 1. the anchor ladder, in precedence order ──────────────────────────────
{
  const gate = await foldOf([
    { call: 'shell', args: { command: 'ls' } },
    { call: 'write', args: { path: 'a.txt', content: 'x' } },
    { verify: 'pass' },
  ]);
  assert.equal(gate.anchor, 'gate', 'a passed gate outranks a write');
  assert.equal(gate.toFirstAction, 2, 'two calls happened before the gate passed');
  assert.equal(gate.note, '', 'a gate-anchored number needs no caveat');
}
{
  const w = await foldOf([
    { call: 'shell', args: { command: 'ls' } },
    { call: 'shell', args: { command: 'cat a' } },
    { call: 'edit', args: { path: 'a.txt', new_string: 'x' } },
  ]);
  assert.equal(w.anchor, 'write', 'a write payload anchors when no gate passed');
  assert.equal(w.toFirstAction, 2);
  assert.match(w.note, /not a correctness claim/, 'a write anchor says what it is not');
}
{
  const sw = await foldOf([
    { call: 'shell', args: { command: 'rg -n "def solve"' } },
    { call: 'shell', args: { command: 'echo hi > out.txt' } },
  ]);
  assert.equal(sw.anchor, 'shell-write', 'a shell redirect anchors when nothing stronger did');
  assert.equal(sw.toFirstAction, 1);
  assert.match(sw.note, /HEURISTIC/, 'the heuristic anchor is labelled as one');
}

// ── 2. null, never zero — the misreading that would make this worse than nothing ──
{
  const none = await foldOf([{ call: 'shell', args: { command: 'ls' } }, { call: 'shell', args: { command: 'cat a' } }]);
  assert.equal(none.anchor, 'none');
  assert.equal(none.toFirstAction, null, 'a run that never acted reports null, not 0');
  assert.equal(none.redundantBefore, null);
  assert.equal(none.failedBefore, null);
  assert.equal(none.toolCalls, 2, 'the raw call count is still reported — it is not anchor-dependent');
  assert.match(none.note, /never mutated/);
}
{
  const failedGate = await foldOf([{ call: 'shell', args: { command: 'ls' } }, { verify: 'fail' }]);
  assert.equal(failedGate.anchor, 'none', 'a FAILED gate is not an anchor — only verify.passed is');
}

// ── 3. `2>&1` is not a redirect ────────────────────────────────────────────
{
  const stderr = await foldOf([{ call: 'shell', args: { command: 'make test 2>&1 | tail -5' } }]);
  assert.equal(stderr.anchor, 'none', '2>&1 is stderr redirection, not a write — the commonest false positive');
}
{
  const real = await foldOf([{ call: 'shell', args: { command: 'make test > log.txt 2>&1' } }]);
  assert.equal(real.anchor, 'shell-write', 'a genuine redirect in the same command still counts');
}

// ── 4. the 2026-09-07 shape: same work, different ordering ─────────────────
// The number that motivated AC-1. Both runs write the same file; one searched once, one flailed.
const straight = await foldOf([
  { call: 'shell', args: { command: 'rg -n "def solve" --type py' } },
  { call: 'write', args: { path: 'solver.py', content: 'x' } },
]);
const flailing = await foldOf([
  { call: 'shell', args: { command: 'rg -n "solve"' } },
  { call: 'shell', args: { command: 'rg -n "solve"' } },          // exact repeat
  { call: 'shell', args: { command: 'rg -n "def"' } },
  { call: 'shell', args: { command: 'rg -n "solve"' } },          // exact repeat again
  { call: 'shell', args: { command: 'find . -name "*.py"', }, fail: true },
  { call: 'write', args: { path: 'solver.py', content: 'x' } },
]);
assert.equal(straight.toFirstAction, 1, 'one search, then the write');
assert.equal(flailing.toFirstAction, 5, 'five calls before the same write');
assert.equal(straight.redundantBefore, 0, 'nothing repeated');
assert.equal(flailing.redundantBefore, 2, 'two of the five were byte-identical repeats');
assert.equal(flailing.failedBefore, 1, 'and one errored');
assert.equal(straight.toolCalls, 2);
assert.equal(flailing.perTool.shell.beforeAnchor, 5, 'the flail is attributed to the tool that flailed');
// The point of the metric, stated as the assertion: volume alone would have said 2 vs 6 — a 3x.
// Ordering says 1 vs 5, and names 2 of those as pure waste. Both runs "succeeded".
assert.ok(flailing.toFirstAction > straight.toFirstAction);

// ── 5. deltaOf refuses to subtract across unlike anchors ───────────────────
{
  const a = { label: 'success', score: 1, steps: 1, toolCalls: 2, failedRounds: 0, events: 9, toFirstAction: 1, redundantBefore: 0, anchor: 'gate' };
  const b = { label: 'success', score: 1, steps: 1, toolCalls: 6, failedRounds: 0, events: 9, toFirstAction: 5, redundantBefore: 2, anchor: 'gate' };
  assert.equal(deltaOf(a, b).toFirstAction, -4, 'same anchor: a real delta');
  assert.equal(deltaOf(a, b).anchor, 'gate');

  const mixed = deltaOf(a, { ...b, anchor: 'shell-write' });
  assert.equal(mixed.toFirstAction, null, 'gate vs shell-write is not a comparison — null, not a number');
  assert.equal(mixed.redundantBefore, null);
  assert.equal(mixed.anchor, 'shell-write→gate', 'and the table says which way it moved');

  const unanchored = deltaOf({ ...a, anchor: 'none', toFirstAction: null }, { ...b, anchor: 'none', toFirstAction: null });
  assert.equal(unanchored.toFirstAction, null, 'two unanchored arms compare to null, never 0');
}

// ── 6. metricsOf carries it, so every ablation arm reports it for free ─────
{
  const rec = await record([{ call: 'shell', args: { command: 'ls' } }, { call: 'write', args: { path: 'a', content: 'b' } }]);
  const m = metricsOf(rec);
  assert.equal(m.anchor, 'write');
  assert.equal(m.toFirstAction, 1);
  assert.equal(m.redundantBefore, 0);
  assert.ok('label' in m && 'score' in m && 'toolCalls' in m, 'the existing metrics still ride along');
}

// ── 7. over the real corpus, keyless ───────────────────────────────────────
// Every entry is a REAL recorded run. This is the [test] leg AC-1 was written with: the fold
// runs over records captured from a live endpoint, with zero model calls.
{
  const dir = new URL('../corpus/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.json') && !f.endsWith('.opts.json'));
  assert.ok(files.length >= 7, `the corpus still has entries (found ${files.length})`);
  const recs = [];
  for (const f of files) recs.push(loadRecord(JSON.parse(await readFile(new URL(f, dir), 'utf8'))));
  for (const rec of recs) {
    const o = foldOrdering(rec.events(), rec.resolve);
    assert.ok(['gate', 'write', 'shell-write', 'none'].includes(o.anchor), 'every record folds to a known anchor');
    if (o.anchor === 'none') assert.equal(o.toFirstAction, null);
    else assert.ok(Number.isInteger(o.toFirstAction) && o.toFirstAction >= 0);
  }
  // write-a-file.json is the one corpus entry that mutates, and it does so through a shell
  // redirect — which is why the payload-key test alone found no action in 7 of 7 records.
  const wf = recs.find((r) => JSON.stringify(r.events()).length && foldOrdering(r.events(), r.resolve).anchor === 'shell-write');
  assert.ok(wf, 'the corpus contains at least one shell-mutating run');
  assert.equal(foldOrdering(wf.events(), wf.resolve).toFirstAction, 0, 'it went straight to the write');

  const groups = groupOrdering(recs);
  assert.ok(groups.length >= 1);
  for (const g of groups) {
    assert.equal(g.runs, g.anchored + g.unanchored, 'every run is counted exactly once');
    assert.equal(Object.values(g.byAnchor).reduce((a, b) => a + b, 0), g.runs, 'byAnchor sums to the run count');
    for (const v of Object.values(g.byAnchor)) assert.ok(Number.isInteger(v), 'no NaN leaks into the histogram');
    if (g.anchored === 0) assert.equal(g.toFirstAction, null, 'a class with nothing anchored reports null, not a mean over nothing');
    else assert.equal(g.toFirstAction.n, g.anchored, 'the mean is taken over the anchored runs only');
  }
}

// ── 8. unanchored runs never enter the mean ────────────────────────────────
// The failure mode this guards: a capability that makes runs DIE EARLIER would improve the
// average time-to-first-action if the dead runs were dropped silently instead of counted.
{
  const acted = await record([{ call: 'shell', args: { command: 'echo x > a' } }]);
  const died = await record([{ call: 'shell', args: { command: 'ls' } }]);
  const [g] = groupOrdering([acted, died, died, died], { classify: () => 'one-class' });
  assert.equal(g.runs, 4);
  assert.equal(g.anchored, 1);
  assert.equal(g.unanchored, 3, 'three runs never acted, and the group says so out loud');
  assert.equal(g.toFirstAction.n, 1, 'the mean is over 1 run, not 4');
}

console.log('ordering: anchor ladder, null-not-zero, 2>&1, the 2026-09-07 rg shape, delta refusal, 7 corpus records');
