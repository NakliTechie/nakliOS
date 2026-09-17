// Conformance — supervisor / parallel-subagent pure helpers.
//   node sys/ai/test/subagents.test.mjs
import { normalizeOwnership, ownershipOverlaps, ownershipsOverlap, outsideOwnership, renderTaskSpec, awaitCohort, formatCompletionSteer, DISPATCH_SETTLE_MS, subagentLiveness, SUBAGENT_STALE_MS,
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

await test('normalizeTasks: duplicate labels under one dispatch are suffixed, in order (B1: the label is the child\'s identity)', () => {
  const r = normalizeTasks([{ description: 'same', prompt: 'a' }, { description: 'same', prompt: 'b' }, { prompt: 'x y z' }, { description: 'same', prompt: 'c' }]);
  eq(r.tasks.map((t) => t.label).join('|'), 'same|same (2)|x y z|same (3)');
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
  const { lastSeen: _s0, ...before } = r; const { lastSeen: _s1, ...after } = subagentFeedRow(r, { type: 'assistant', content: 'hi' }); eq(JSON.stringify(after), JSON.stringify(before), 'an unrelated event changes nothing but the last-seen clock');
  r = subagentFeedRow(r, { type: 'assistant', content: 'hi' });
  r = subagentFeedRow(r, { type: 'aborted' }); eq(r.status, 'aborted');
  assert(subagentFeedRow(before, {}) !== before, 'pure — returns a new object');
});
await test('subagentFeedLine: running says where it is; a finished row says how it ended', () => {
  const running = { kind: 'dispatch', label: 'split lexer', status: 'running', steps: 3, tools: 2, lastTool: 'read', lastDetail: 'lexer.py' };
  const line = subagentFeedLine(running);
  assert(/dispatch · split lexer — unverifiable \(no event seen from it yet\) · step 3 · 2 tool calls · last: read\(lexer\.py\)/.test(line), `a running row with no last-seen cannot prove liveness: ${line}`);
  const seen = subagentFeedLine({ ...running, lastSeen: 1000 }, { now: 5000 });
  assert(/split lexer — live \(last event 4s ago\) · step 3/.test(seen), seen);
  const done = subagentFeedLine({ ...running, status: 'done', tools: 1 });
  assert(/split lexer — done \(3 steps, 1 tool call\)/.test(done), done);
});

// CRIB-B B3: ownership declared at dispatch — normalised, overlap predicted, the invariant checked
await test('B3: normalizeOwnership — workspace-relative, a trailing / is a prefix, empties and duplicates dropped, a string splits', () => {
  eq(normalizeOwnership(['./src/api/', '/README.md', ' ', 'src/api/', '.', 'lib']).join('|'), 'src/api/|README.md|lib');
  eq(normalizeOwnership('a.py, b/\nc').join('|'), 'a.py|b/|c');
  eq(normalizeOwnership(null).length, 0); eq(normalizeOwnership(42).length, 0);
  eq(normalizeOwnership(['src//api/', 'src/./api/', '../x', 'a/b/../c', '..', 'd/e/../../f/']).join('|'), 'src/api/|x|a/c|f/', 'the write face\'s segment walk: //, . and .. collapse; the trailing / stays');
});
await test('B3: ownershipOverlaps — equal, prefix either way, disjoint, undeclared', () => {
  const T = (ownership) => ({ ownership });
  eq(ownershipOverlaps([T(['src/api/']), T(['src/api/routes.py'])]).map((o) => `${o.a}-${o.b}:${o.path}`).join(','), '0-1:src/api/', 'a prefix owns the file under it');
  eq(ownershipOverlaps([T(['a.py']), T(['a.py'])])[0].path, 'a.py', 'equal paths');
  eq(ownershipOverlaps([T(['src/api/']), T(['src/apix/'])]).length, 0, 'src/api/ does not cover src/apix/');
  eq(ownershipOverlaps([T(['src/api']), T(['src/api/x.py'])]).length, 1, 'a bare directory name owns its subtree too');
  eq(ownershipOverlaps([T(['src/api']), T(['src/api/'])]).length, 1, 'with or without the slash, the same claim');
  eq(ownershipOverlaps([T(['README.md']), T(['README.md.bak'])]).length, 0, 'a file does not own a longer name');
  eq(ownershipOverlaps([T(['src/']), T(['docs/']), T(['src/x.py'])]).map((o) => `${o.a}-${o.b}`).join(','), '0-2', 'only the overlapping pair');
  eq(ownershipOverlaps([T([]), T(['src/'])]).length, 0, 'undeclared overlaps nothing');
  eq(ownershipsOverlap(['a/'], ['a/b.py', 'c']), 'a/'); eq(ownershipsOverlap(['a/'], ['b/']), null);
});
await test('B3: outsideOwnership — the paths a child touched beyond its declaration; nothing when undeclared', () => {
  eq(outsideOwnership(['src/api/', 'README.md'], { written: ['src/api/a.py', 'README.md', 'src/core/b.py'], deleted: ['tests/t.py'] }).join(','), 'src/core/b.py,tests/t.py');
  eq(outsideOwnership([], { written: ['anything'] }).length, 0, 'undeclared → today\'s rules');
  eq(outsideOwnership(['src/api'], { written: ['src/api/x.py', 'src/apix/y.py'], deleted: [] }).join(','), 'src/apix/y.py', 'a bare name owns its subtree, not a sibling with the same prefix');
  eq(outsideOwnership(['src/'], null).length, 0);
});
await test('B3: normalizeTasks keeps the five fields; renderTaskSpec briefs the child with the boundary, then the prompt', () => {
  const r = normalizeTasks([{ description: 'api', prompt: 'Add the route.', target: 'src/api', change: 'add GET /x', constraints: 'no new deps', ownership: ['src/api/'], acceptance: 'python -m pytest tests/api' }, { prompt: 'plain' }]);
  eq(r.tasks[0].ownership.join(), 'src/api/'); eq(r.tasks[0].acceptance, 'python -m pytest tests/api'); eq('ownership' in r.tasks[1], false, 'absent fields stay absent');
  const spec = renderTaskSpec(r.tasks[0]);
  assert(/^Target: src\/api\nChange: add GET \/x\nConstraints: no new deps\nOwnership: you may write only under src\/api\/ — anything written elsewhere is held and never merged\.\nObservable acceptance: python -m pytest tests\/api\n\nAdd the route\.$/.test(spec), spec);
  eq(renderTaskSpec(r.tasks[1]), 'plain', 'no spec → the prompt alone, byte for byte');
  const d = formatDispatchDigest({ results: [{ label: 'api', ok: true, stop: 'done', text: 'r', changes: { written: ['src/core/b.py'], deleted: [] }, outside: ['src/core/b.py'] }], status: ['outside'], conflicts: [], dropped: 0, budget: null });
  assert(/### \[1\] api — held — wrote outside its declared ownership \(src\/core\/b\.py\)/.test(d) && /attempted \(NOT applied\)/.test(d), d);
  const s = formatCompletionSteer({ index: 0, label: 'api', run: { ok: true, text: 'r', changes: { written: ['src/core/b.py'], deleted: [] }, outside: ['src/core/b.py'] }, status: 'outside' });
  assert(/finished — held — wrote outside its declared ownership \(src\/core\/b\.py\)\./.test(s), s);
});

// CRIB-B B2: the cohort wait, the completion steer, the digest's in-flight tail
await test('B2: awaitCohort — all at once, the settle window, Infinity, empty', async () => {
  const later = (ms, v) => new Promise((r) => setTimeout(() => r(v), ms));
  let c = await awaitCohort([later(5, 'a'), later(8, 'b')]);
  eq(c.done.map((d) => d.value).join(','), 'a,b', 'Infinity waits for all'); eq(c.inFlight.length, 0);
  c = await awaitCohort([later(5, 'a'), later(120, 'b'), later(8, 'c')], { settleMs: 40 });
  eq(c.done.map((d) => d.index + ':' + d.value).join(','), '0:a,2:c', 'the first completion plus what settles inside the window, in cohort order');
  eq(c.inFlight.map((x) => x.index).join(','), '1', 'the slow one is still in flight, with its promise');
  eq(await c.inFlight[0].promise, 'b');
  c = await awaitCohort([later(5, 'a'), later(30, 'b')], { settleMs: 0 });
  eq(c.done.length, 1, 'a zero window returns after the first completion');
  c = await awaitCohort([]); eq(c.done.length + c.inFlight.length, 0, 'empty cohort');
  c = await awaitCohort([Promise.reject(new Error('x')).catch((e) => { throw e; }), later(3, 'ok')]);
  eq(c.done[0].ok, false); eq(c.done[1].value, 'ok', 'a rejection is a done entry, not a throw');
  eq(DISPATCH_SETTLE_MS, 250);
});
await test('B2: formatCompletionSteer and the digest tail speak the same vocabulary, numbered by the cohort index', () => {
  const run = { label: 'slow', ok: true, stop: 'done', text: 'wrote the thing', changes: { written: ['s.txt'], deleted: [] } };
  const merged = formatCompletionSteer({ index: 1, label: 'slow', run, status: 'merge' });
  assert(/^\[coordination\] subagent \[2\] "slow" finished — merged\. changes applied: wrote s\.txt\. wrote the thing$/.test(merged), merged);
  const held = formatCompletionSteer({ index: 2, label: 'late', run, status: 'conflict', conflictWith: ['s.txt'] });
  assert(/held — conflicts with an earlier sibling that already merged \(s\.txt\); un-merging is not possible\. changes attempted \(NOT applied\)/.test(held), held);
  const inc = formatCompletionSteer({ index: 0, label: 'x', run: { ...run, ok: false, stop: 'budget' }, status: 'incomplete' });
  assert(/held — subagent did not finish cleanly \(budget\)/.test(inc), inc);
  const d = formatDispatchDigest({ results: [run], status: ['merge'], conflicts: [], dropped: 0, budget: null, inFlight: ['late'], indices: [2] });
  assert(/### \[3\] slow — merged/.test(d), 'numbered by the cohort index: ' + d);
  assert(/^Dispatched 2 subagents in parallel\. 1 settled, 1 still in flight\./.test(d), 'LV1: the head counts the cohort, not the settled slice: ' + d.split('\n')[0]);
  assert(/### still in flight: "late" — its completion will arrive as a \[coordination\] message/.test(d) && /do not re-dispatch it/.test(d), d);
  const plain = formatDispatchDigest({ results: [run], status: ['merge'], conflicts: [], dropped: 0, budget: null });
  assert(!/still in flight/.test(plain) && /### \[1\] slow/.test(plain), 'no tail and identity numbering when nothing is in flight');
  assert(/^Dispatched 1 subagent in parallel\.\n/.test(plain), 'LV1: no settled/in-flight clause when nothing is in flight: ' + plain.split('\n')[0]);
});

// CRIB-B B1: the typed in-flight state — live by a recent event, unverifiable by silence, exited by a stop
await test('B1: subagentLiveness — live within the window, unverifiable past it (authorizes nothing), exited by a stop', () => {
  const now = 5_000_000;
  let r = subagentFeedRow(null, {}, { now });
  eq(r.lastSeen, now, 'a fresh row was seen now');
  r = subagentFeedRow(r, { type: 'assistant', content: 'hi' }, { now: now + 30_000 });
  eq(r.lastSeen, now + 30_000, 'any event is a sign of life');
  eq(subagentLiveness(r, { now: now + 31_000 }).state, 'live');
  eq(subagentLiveness(r, { now: now + 30_000 + SUBAGENT_STALE_MS - 1 }).state, 'live', 'one ms inside the window');
  const stale = subagentLiveness(r, { now: now + 30_000 + SUBAGENT_STALE_MS });
  eq(stale.state, 'unverifiable', 'at the window'); assert(/no event for 90s/.test(stale.why) && /authorizes nothing: not killed, not re-dispatched/.test(stale.why), stale.why);
  eq(subagentLiveness({ ...r, status: 'done' }, { now: now + 999_999 }).state, 'exited', 'a stop is a stop, however old');
  eq(subagentLiveness({ ...r, status: 'aborted' }).why, 'aborted');
  eq(subagentLiveness({ status: 'running' }).state, 'unverifiable', 'no last-seen → nothing can be proven');
  const line = subagentFeedLine({ kind: 'dispatch', label: 'x', status: 'running', steps: 1, tools: 0, lastSeen: now }, { now: now + 200_000 });
  assert(/x — unverifiable \(no event for 200s — a stalled endpoint looks like a slow one; this authorizes nothing: not killed, not re-dispatched\) · step 1 · 0 tool calls$/.test(line), line);
  eq(SUBAGENT_STALE_MS, 90_000, 'the window is a named constant');
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
