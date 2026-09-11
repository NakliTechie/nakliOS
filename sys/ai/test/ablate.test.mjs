// Conformance — the ablation harness: same agent ± one capability, recorded, replayable.
//   node sys/ai/test/ablate.test.mjs
import { runAblation, armsFor, renderTable, deltaOf } from '../ablate.mjs';
import { fixtureTasks, CAPABILITIES } from './ablate-fixtures.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const row = (res, task, cap) => res.rows.find((r) => r.task === task && r.capability === cap);

let first;
await test('the matrix runs headlessly: 3 tasks × 4 arms, every arm recorded, every arm a full record', async () => {
  first = await runAblation({ tasks: fixtureTasks(), capabilities: CAPABILITIES, now: () => 1_000 });
  eq(first.arms.join(','), 'full,-gate,-memory,-retry', 'arms: full + one-off per capability');
  eq(first.rows.length, 9, '3 tasks × 3 capabilities');
  for (const t of Object.keys(first.records)) for (const a of first.arms) {
    const dump = first.records[t][a];
    assert(typeof dump.events === 'string' && dump.events.includes('run.stopped'), `${t}/${a} recorded to a stop`);
    assert(dump.events.includes('run.started'), `${t}/${a} recorded from a start (the default driver starts the record before its loop)`);
  }
  assert(first.liveCalls > 0, 'the first pass hit the scripted model');
});

await test('deltas are real and attributable: gate makes attest-lint a success; memory saves steps; retry rescues flaky-fix', () => {
  const g = row(first, 'attest-lint', 'gate');
  eq(g.full.label, 'success', 'with everything on, attest-lint passes its gate');
  eq(g.without.label, 'unknown', 'without a gate the wrong file stands — unclaimed, not failure');
  eq(g.delta.label, 1, 'Δlabel +1: the gate turned unclaimed into success');
  const m = row(first, 'memory-shortcut', 'memory');
  assert(m.delta.steps < 0, `memory saves steps: full ${m.full.steps} vs without ${m.without.steps}`);
  eq(m.full.label, 'success', 'and still passes');
  const r = row(first, 'flaky-fix', 'retry');
  eq(r.full.label, 'success', 'three rounds rescue it'); eq(r.without.label, 'failure', 'one round → unverified → failure');
  eq(r.delta.label, 2, 'Δlabel +2: failure → success');
  assert(r.delta.failedRounds > 0, 'the rescue cost failed rounds — the table shows the price');
  const noop = row(first, 'flaky-fix', 'memory');
  eq(noop.delta.label, 0, 'a capability the task does not use shows zero delta — honest, not padded');
  eq(noop.delta.steps, 0, 'no step delta either');
});

await test('factory order: executeTool sets up the arm, then gate, then loopOptions read it', async () => {
  const order = [];
  const task = {
    id: 'order', messages: () => [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], tools: () => [],
    model: () => async () => ({ content: 'done', toolCalls: [] }),
    executeTool: (_c, ctx) => { order.push('executeTool'); ctx.ws = 'ready'; return async () => ''; },
    gate: (_c, ctx) => { order.push('gate:' + ctx.ws); return null; },
    loopOptions: (_c, ctx) => { order.push('loopOptions:' + ctx.ws); return { maxSteps: 2 }; },
  };
  await runAblation({ tasks: [task], capabilities: [], now: () => 1_000 });
  eq(order.join(' '), 'executeTool gate:ready loopOptions:ready', 'loopOptions and the gate see the workspace executeTool made');
});

await test('REPLAY: the same matrix from the records makes ZERO live model calls and reproduces every metric', async () => {
  const again = await runAblation({ tasks: fixtureTasks(), capabilities: CAPABILITIES, records: first.records, now: () => 1_000 });
  eq(again.liveCalls, 0, 'reproduced from the record alone');
  for (const t of Object.keys(first.byArm)) for (const a of first.arms) {
    const x = first.byArm[t][a], y = again.byArm[t][a];
    for (const k of ['label', 'score', 'steps', 'toolCalls', 'failedRounds', 'events']) eq(y[k], x[k], `${t}/${a}.${k} reproduced`);
  }
  eq(JSON.stringify(again.rows.map((r) => r.delta)), JSON.stringify(first.rows.map((r) => r.delta)), 'identical deltas');
});

await test('the table renders every row and says when the run was reproduced', () => {
  const t = renderTable(first);
  assert(/^task\s+capability\s+full\s+-cap/.test(t), 'header');
  eq(t.split('\n').length, 2 + 9 + 1, 'header + rule + 9 rows + footer');
  assert(/attest-lint\s+gate\s+success \d+s\s+unknown \d+s\s+\+1/.test(t), t.split('\n')[2]);
  assert(/live model calls: \d+$/.test(t), 'footer counts live calls');
  eq(armsFor(['x']).length, 2, 'one capability → two arms');
  eq(deltaOf({ label: 'success', score: 1, steps: 2, toolCalls: 1, failedRounds: 0 }, { label: 'failure', score: -1, steps: 5, toolCalls: 4, failedRounds: 2 }).label, 2, 'label delta spans −1..+1 → 2');
});

if (failures.length) { console.error(`ablate: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`ablate conformance: ${passed}/${passed} passed — 3 tasks × 4 arms recorded, deltas attributable, replayed with zero model calls`);
