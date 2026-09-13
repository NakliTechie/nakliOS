#!/usr/bin/env node
// Teeth for scripts/probe-index-usage.mjs (PG-A2): the context-message parser, the fired/never-fired
// count per record, the per-class summary, and the honest NO ANSWER over records with no index.
import assert from 'node:assert/strict';
import { indexInContext, probeRecord, summarize, parseContext } from './probe-index-usage.mjs';
import { createRunRecorder, loadRecord } from '../sys/history/run-record.mjs';
import { contextMessage } from '../sys/ai/run-assembly.mjs';
import { buildMemoryIndex } from '../sys/ai/memory-store.mjs';
import { buildSkillsIndex } from '../sys/ai/skills.mjs';

let teeth = 0; const ok = (c, m) => { assert.ok(c, m); teeth++; };

// the parser reads what the app actually renders — not a hand-typed lookalike
const facts = [{ name: 'build-is-node-build', type: 'project', description: 'The build is node build.mjs', status: 'verified' }, { name: 'tests-live-in-sys-test', type: 'project', description: 'Tests live under sys/test', status: 'hypothesis' }];
const skills = [{ name: 'working-in-anvil', description: 'How to work here', status: 'active' }, { name: 'release-notes', description: 'Write the notes', status: 'active' }];
const ctx = contextMessage('# Project notes\n\nsome notes' + buildMemoryIndex(facts) + buildSkillsIndex(skills));
const parsed = indexInContext([{ role: 'system', content: 'sys' }, ctx]);
ok(parsed && parsed.facts.join(',') === 'build-is-node-build,tests-live-in-sys-test', `facts parsed from the rendered index: ${parsed && parsed.facts}`);
ok(parsed.skills.join(',') === 'working-in-anvil,release-notes', `skills parsed from the rendered index: ${parsed.skills}`);
ok(indexInContext([{ role: 'user', content: 'go' }]) === null, 'a run with no working-context message has no index');

// a record: the index in context, one fact recalled, one skill loaded → two fired, two never
async function record(calls, { tools = ['shell', 'recall', 'skill', 'task_done'] } = {}) {
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  await rec.start({ messages: [{ role: 'system', content: 'sys' }, ctx, { role: 'user', content: 'go' }], tools: tools.map((n) => ({ type: 'function', function: { name: n } })) });
  let step = 0;
  for (const [name, args] of calls) { rec.onEvent({ type: 'tool-call', id: 'c' + step, name, args, step }); rec.onEvent({ type: 'tool-result', id: 'c' + step, name, result: 'ok', step }); step++; }
  await rec.finish({ stop: 'done', steps: step, verified: false });
  await rec.settled();
  return loadRecord(rec.export());
}
const r1 = probeRecord(await record([['recall', { name: 'build-is-node-build' }], ['skill', { name: 'release-notes' }], ['shell', { command: 'ls' }]]));
ok(r1.indexed && r1.inContext === 4 && r1.fired === 2, `two of four in-context items fired: ${JSON.stringify(r1)}`);
ok(r1.neverFired.join(',') === 'tests-live-in-sys-test,working-in-anvil', `the never-fired are named: ${r1.neverFired}`);
ok(r1.cls === 'gated', 'task_done in the toolset → gated');
const r2 = probeRecord(await record([['shell', { command: 'ls' }]], { tools: ['shell'] }));
ok(r2.cls === 'ungated' && r2.fired === 0 && r2.neverFired.length === 4, 'nothing fired → every item never fired; no task_done → ungated');

// the summary groups by class and outcome, and names the never-fired most
const s = summarize([r1, r2, { ...r2, cls: 'ungated' }]);
ok(s.by.gated.runs === 1 && s.by.ungated.runs === 2, 'grouped by class');
ok(s.by.gated.byOutcome[r1.outcome].neverFired === 2 && s.by.ungated.byOutcome[r2.outcome].neverFired === 8, 'never-fired summed per class and outcome');
ok(s.neverFiredMost[0][0] === 'tests-live-in-sys-test' && s.neverFiredMost[0][1] === 3, `the most-never-fired item is counted across records: ${JSON.stringify(s.neverFiredMost[0])}`);

// the parser reads the memory LIST and the rules HEADINGS, never a lookalike in the project notes
const rules = buildMemoryIndex([{ name: 'always-run-tests', type: 'rule', description: 'Run the tests', status: 'verified' }, ...facts]);
const p2 = parseContext('# Project notes\n- **lookalike** (x): not a fact\n' + rules + buildSkillsIndex(skills));
ok(p2.facts.includes('always-run-tests') && !p2.facts.includes('lookalike') && p2.facts.length === 3, `rules counted, notes lookalike not: ${p2.facts}`);
// two loops: the second context carries a fact the first lacked → the union counts it; a skill
// call never fires a fact of the same name
{
  const rec = createRunRecorder({ app: 'anvil', principal: 'test' });
  await rec.start({ messages: [ctx], tools: [{ type: 'function', function: { name: 'recall' } }] });
  rec.onEvent({ type: 'tool-call', id: 'c0', name: 'skill', args: { name: 'build-is-node-build' }, step: 0 }); rec.onEvent({ type: 'tool-result', id: 'c0', name: 'skill', result: 'x', step: 0 });
  await rec.finish({ stop: 'max-steps', steps: 1 });
  const ctx2 = contextMessage(buildMemoryIndex([...facts, { name: 'late-fact', type: 'project', description: 'remembered mid-run', status: 'hypothesis' }]) + buildSkillsIndex(skills));
  await rec.start({ messages: [ctx2, { role: 'user', content: '[coordination] redirect' }], tools: [{ type: 'function', function: { name: 'recall' } }] });
  rec.onEvent({ type: 'tool-call', id: 'c1', name: 'recall', args: { name: 'late-fact' }, step: 0 }); rec.onEvent({ type: 'tool-result', id: 'c1', name: 'recall', result: 'Fact', step: 0 });
  await rec.finish({ stop: 'done', steps: 1 }); await rec.settled();
  const r = probeRecord(loadRecord(rec.export()));
  ok(r.inContext === 5, `the union across both loops holds five items: ${r.inContext}`);
  ok(r.fired === 1 && !r.neverFired.includes('late-fact'), `the late fact, recalled in loop 2, fired: ${r.neverFired}`);
  ok(r.neverFired.includes('build-is-node-build'), 'a skill call does not fire a fact of the same name');
}

// a record with no run.started is skipped, not crashed
ok(probeRecord(loadRecord({ events: [], blobs: {} })) === null, 'an empty record probes to null');
console.log(`probe-index-usage: ${teeth} teeth green — the parser reads the rendered index, fired vs never-fired counts per record, the summary groups per class`);
