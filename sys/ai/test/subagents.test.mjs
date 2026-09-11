// Conformance — supervisor / parallel-subagent pure helpers.
//   node sys/ai/test/subagents.test.mjs
import {
  dispatchTool, reviewTool, normalizeTasks, detectConflicts, mergeDecision,
  planMerge, formatDispatchDigest, DISPATCH_MAX,
  subagentFeedRow, subagentFeedLine, clampSubagentBudget, SUBAGENT_MAX_STEPS, SUBAGENT_WALL_CLOCK_S,
} from '../subagents.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

await test('tool schemas expose dispatch + review', () => {
  eq(dispatchTool().function.name, 'dispatch', 'dispatch name');
  eq(reviewTool().function.name, 'review', 'review name');
  assert(dispatchTool().function.parameters.required.includes('tasks'), 'dispatch requires tasks');
  assert(reviewTool().function.parameters.required.includes('prompt'), 'review requires prompt');
});

await test('normalizeTasks: labels default, empties dropped, non-array rejected', () => {
  const bad = normalizeTasks('nope');
  assert(!bad.ok, 'non-array rejected');
  const r = normalizeTasks([{ prompt: 'do a thing please now' }, { prompt: '' }, { description: 'lbl', prompt: 'x' }]);
  assert(r.ok, 'ok with valid tasks');
  eq(r.tasks.length, 2, 'empty dropped');
  eq(r.dropped, 1, 'one dropped counted');
  eq(r.tasks[1].label, 'lbl', 'explicit label kept');
  assert(r.tasks[0].label.startsWith('do a thing'), 'label defaults from prompt');
});

await test('normalizeTasks: caps at DISPATCH_MAX and reports overflow', () => {
  const many = Array.from({ length: DISPATCH_MAX + 3 }, (_, i) => ({ prompt: 'task ' + i }));
  const r = normalizeTasks(many);
  eq(r.tasks.length, DISPATCH_MAX, 'capped');
  eq(r.overflow, 3, 'overflow reported');
  eq(r.dropped, 3, 'dropped counts overflow');
});

await test('normalizeTasks: all-empty → not ok', () => {
  const r = normalizeTasks([{ prompt: '  ' }, { prompt: '' }]);
  assert(!r.ok, 'no usable tasks');
  eq(r.dropped, 2, 'both counted dropped');
});

await test('detectConflicts: same path by two agents flagged; disjoint clean', () => {
  const disjoint = detectConflicts([{ written: ['a.js'] }, { written: ['b.js'], deleted: ['c.js'] }]);
  eq(disjoint.length, 0, 'no conflict when disjoint');
  const clash = detectConflicts([{ written: ['shared.js'] }, { written: ['shared.js'] }]);
  eq(clash.length, 1, 'one conflict');
  eq(clash[0].path, 'shared.js', 'path named');
  eq(JSON.stringify(clash[0].agents), JSON.stringify([0, 1]), 'both agents named');
});

await test('detectConflicts: write vs delete of same path is a conflict', () => {
  const c = detectConflicts([{ written: ['x'] }, { deleted: ['x'] }]);
  eq(c.length, 1, 'write/delete conflict');
});

await test('mergeDecision: applies all when disjoint, none when conflicting', () => {
  const clean = mergeDecision([{ written: ['a'] }, { written: ['b'] }, { written: [], deleted: [] }]);
  eq(JSON.stringify(clean.apply), JSON.stringify([0, 1]), 'apply the two that changed, skip the no-op');
  eq(clean.conflicts.length, 0, 'no conflicts');
  const dirty = mergeDecision([{ written: ['a'] }, { written: ['a'] }]);
  eq(dirty.apply.length, 0, 'apply nothing on conflict');
  eq(dirty.conflicts.length, 1, 'conflict surfaced');
});

await test('planMerge: clean disjoint runs both merge', () => {
  const runs = [
    { ok: true, changes: { written: ['a.js'], deleted: [] } },
    { ok: true, changes: { written: ['b.js'], deleted: [] } },
  ];
  const plan = planMerge(runs);
  eq(JSON.stringify(plan.apply), JSON.stringify([0, 1]), 'both applied');
  eq(plan.status[0], 'merge', 'run0 merge');
  eq(plan.conflicts.length, 0, 'no conflicts');
});

await test('planMerge: a non-clean run is HELD and never merged (F1)', () => {
  const runs = [
    { ok: false, stop: 'max-steps', changes: { written: ['half.js'], deleted: [] } }, // partial
    { ok: true, changes: { written: ['done.js'], deleted: [] } },
  ];
  const plan = planMerge(runs);
  eq(plan.status[0], 'incomplete', 'partial run held');
  assert(!plan.apply.includes(0), 'partial NOT applied');
  eq(plan.status[1], 'merge', 'clean sibling merges');
  assert(plan.apply.includes(1), 'clean sibling applied');
});

await test("planMerge: a held run's path does not block a disjoint clean sibling", () => {
  // even if the incomplete run touched the SAME path, it is excluded (not clean),
  // so it must not create a phantom conflict against the clean run.
  const runs = [
    { ok: false, stop: 'error', changes: { written: ['x.js'], deleted: [] } },
    { ok: true, changes: { written: ['x.js'], deleted: [] } },
  ];
  const plan = planMerge(runs);
  eq(plan.conflicts.length, 0, 'incomplete run is not counted as an owner');
  eq(plan.status[1], 'merge', 'clean run merges');
});

await test('planMerge: per-subagent conflict isolation — clash holds only the clashers', () => {
  const runs = [
    { ok: true, changes: { written: ['shared.js'], deleted: [] } }, // clashes with [1]
    { ok: true, changes: { written: ['shared.js'], deleted: [] } }, // clashes with [0]
    { ok: true, changes: { written: ['solo.js'], deleted: [] } },   // disjoint
  ];
  const plan = planMerge(runs);
  eq(plan.status[0], 'conflict', 'clasher held');
  eq(plan.status[1], 'conflict', 'clasher held');
  eq(plan.status[2], 'merge', 'disjoint sibling still merges');
  eq(JSON.stringify(plan.apply), JSON.stringify([2]), 'only the disjoint one applies');
  eq(plan.conflicts.length, 1, 'one conflicting path');
});

await test('formatDispatchDigest: honest labels — merged / held / conflict, and dropped note', () => {
  const results = [
    { label: 'edit A', ok: true, text: 'changed A', changes: { written: ['a.js'], deleted: [] } },
    { label: 'edit B', ok: true, text: 'changed B', changes: { written: ['a.js'], deleted: [] } },
    { label: 'stuck C', ok: false, stop: 'max-steps', text: 'partial', changes: { written: ['c.js'], deleted: [] } },
  ];
  const plan = planMerge(results);
  const digest = formatDispatchDigest({ results, status: plan.status, conflicts: plan.conflicts, dropped: 2 });
  assert(digest.includes('[1] edit A'), 'labels numbered');
  assert(digest.includes('path conflict'), 'conflict wording shown');
  assert(digest.includes('a.js'), 'conflicting path shown');
  assert(/did not finish cleanly \(max-steps\)/.test(digest), 'incomplete run flagged, not "merged"');
  assert(/NOT applied/.test(digest), 'held changes marked not applied');
  assert(/2 sub-tasks dropped/.test(digest), 'dropped reported, not silent');
});

await test('formatDispatchDigest: a clean applied run reads "merged"', () => {
  const results = [{ label: 'x', ok: true, text: 'done', changes: { written: ['q.js'], deleted: [] } }];
  const plan = planMerge(results);
  const digest = formatDispatchDigest({ results, status: plan.status, conflicts: plan.conflicts, dropped: 0 });
  assert(/— merged/.test(digest), 'merged tag');
  assert(/applied: wrote q.js/.test(digest), 'applied changes listed');
});

// ESS-2: the live feed row is a pure fold over a child's loop events.
await test('subagentFeedRow: a fresh row, steps from turn-start, tool calls with their detail, aborted', () => {
  let r = subagentFeedRow(null, {});
  eq(r.k, 'subagent'); eq(r.status, 'running'); eq(r.steps, 0); eq(r.tools, 0);
  r = subagentFeedRow(r, { type: 'turn-start', step: 0 }); eq(r.steps, 1, 'step is 1-based');
  r = subagentFeedRow(r, { type: 'tool-call', name: 'shell', args: { command: 'ls -la' } });
  eq(r.tools, 1); eq(r.lastTool, 'shell'); eq(r.lastDetail, 'ls -la');
  r = subagentFeedRow(r, { type: 'tool-call', name: 'write', args: { path: 'a.py', content: 'x' } });
  eq(r.tools, 2); eq(r.lastTool, 'write'); eq(r.lastDetail, 'a.py', 'a path shows as the detail, never the content');
  r = subagentFeedRow(r, { type: 'turn-start', step: 3 }); eq(r.steps, 4, 'steps only grow');
  r = subagentFeedRow(r, { type: 'turn-start', step: 1 }); eq(r.steps, 4, 'never backwards');
  r = subagentFeedRow(r, { type: 'tool-error', error: 'boom' }); eq(r.lastError, 'boom');
  const before = { ...r }; r = subagentFeedRow(r, { type: 'assistant', content: 'hi' }); eq(JSON.stringify(r), JSON.stringify(before), 'an unrelated event changes nothing');
  r = subagentFeedRow(r, { type: 'aborted' }); eq(r.status, 'aborted');
  assert(subagentFeedRow(before, {}) !== before, 'pure — returns a new object');
});
await test('subagentFeedLine: running says where it is; a finished row says how it ended', () => {
  const running = { kind: 'dispatch', label: 'split lexer', status: 'running', steps: 3, tools: 2, lastTool: 'read', lastDetail: 'lexer.py' };
  const line = subagentFeedLine(running);
  assert(/dispatch · split lexer — running · step 3 · 2 tool calls · last: read\(lexer\.py\)/.test(line), line);
  const done = subagentFeedLine({ ...running, status: 'done', tools: 1 });
  assert(/split lexer — done \(3 steps, 1 tool call\)/.test(done), done);
});

// ESS-3: a launch budget decided per call — clamped to the ceilings, never above them, stated.
await test('clampSubagentBudget: defaults, explicit values, ceilings, floors, junk', () => {
  const d = clampSubagentBudget({});
  eq(d.maxSteps, SUBAGENT_MAX_STEPS); eq(d.wallClockMs, SUBAGENT_WALL_CLOCK_S * 1000); eq(d.explicit.steps, false); eq(d.explicit.secs, false);
  const e = clampSubagentBudget({ max_steps: 3, wall_clock_s: 30 });
  eq(e.maxSteps, 3); eq(e.wallClockMs, 30000); eq(e.explicit.steps, true); eq(e.explicit.secs, true);
  assert(/3 steps, 30 s/.test(e.line), e.line);
  const c = clampSubagentBudget({ max_steps: 999, wall_clock_s: 99999 });
  eq(c.maxSteps, SUBAGENT_MAX_STEPS, 'never above the step ceiling'); eq(c.wallClockMs, SUBAGENT_WALL_CLOCK_S * 1000, 'never above the wall-clock ceiling');
  eq(clampSubagentBudget({ wall_clock_s: 1 }).wallClockMs, 5000, 'a wall clock has a floor');
  const j = clampSubagentBudget({ max_steps: 'lots', wall_clock_s: -4 });
  eq(j.maxSteps, SUBAGENT_MAX_STEPS); eq(j.explicit.steps, false); eq(j.explicit.secs, false, 'junk is not explicit');
  eq(clampSubagentBudget({ max_steps: 2.9 }).maxSteps, 2, 'floors a fraction');
});

if (failures.length){
  console.error(`subagents: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`subagents conformance: ${passed}/${passed} passed`);
