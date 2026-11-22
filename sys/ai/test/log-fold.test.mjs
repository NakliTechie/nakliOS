// Folded actions — a finished turn's tool calls fold into one summary line under the answer.
//   node sys/ai/test/log-fold.test.mjs
//
// The fold is display only, so most of this file guards what it must NOT do: fold a turn that is
// still running, hide a failed call or a failed child, or change a single byte of the transcript.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { planFolds, foldSummary, foldKeys, isEndOfRun } from '../log-fold.mjs';
import { rowKeys, planLogUpdate } from '../log-render-plan.mjs';

const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');

const ok = (name, detail) => ({ k: 'tool', name, detail, result: 'ok', error: null });
const user = (text) => ({ k: 'user', text });
const said = (text) => ({ k: 'assistant', text });
const end = (steps) => ({ k: 'system', text: `agent done · ${steps} steps` });

// ── a finished turn folds its successful actions, and keeps the change chip and the answer ──
{
  // The bench's README turn: read, edit, (chip), read, answer, end of run.
  const log = [user('add a line'), ok('read', 'README.md'), ok('edit', 'README.md'),
    { k: 'change', verb: 'edited', file: 'README.md' }, ok('read', 'README.md'), said('Done'), end(4)];
  const before = JSON.stringify(log);
  const p = planFolds(log);
  assert.deepEqual([...p.hidden].sort(), [1, 2, 4], 'the three tool rows fold');
  assert.ok(!p.hidden.has(3), 'the changed-file chip stays visible');
  assert.ok(!p.hidden.has(5), 'the answer stays visible');
  assert.deepEqual([...p.folds.keys()], [6], 'the fold is drawn at the end-of-run row, under the answer');
  assert.equal(foldSummary(p.folds.get(6)), '3 actions · edited README.md');
  assert.equal(JSON.stringify(log), before, 'planning a fold never writes a row');
}

// ── a running turn never folds ──
{
  const log = [user('go'), ok('read', 'a'), { k: 'tool', name: 'shell', detail: 'ls', result: null, error: null }];
  const p = planFolds(log);
  assert.equal(p.hidden.size, 0, 'no end-of-run row yet, so nothing folds');
}

// ── failures stay in place, and the summary says so ──
{
  const log = [user('go'), ok('read', 'a'),
    { k: 'tool', name: 'edit', detail: 'a', result: null, error: 'old_string not found' },
    { k: 'tool', name: 'read', detail: 'b', result: 'no such file', error: null, kind: 'not_found' },
    { k: 'subagent', label: 'one', status: 'done' },
    { k: 'subagent', label: 'two', status: 'error' },
    { k: 'subagent', label: 'three', status: 'running' },
    said('Done'), end(5)];
  const p = planFolds(log);
  assert.deepEqual([...p.hidden].sort(), [1, 4], 'only the clean tool call and the finished child fold');
  for (const i of [2, 3, 5, 6]) assert.ok(!p.hidden.has(i), `row ${i} (failed or running) stays visible`);
  assert.equal(foldSummary(p.folds.get(8)), '1 action · 1 subagent · 3 failed (shown above)');
}

// ── each turn folds on its own; an interrupted turn's rows never join the next turn ──
{
  const log = [user('one'), ok('read', 'a'), said('A'), end(1),
    user('two'), ok('read', 'b'),                 // this run died before its end-of-run row
    user('three'), ok('read', 'c'), ok('write', 'c'), said('C'), end(2)];
  const p = planFolds(log);
  assert.deepEqual([...p.folds.keys()], [3, 10]);
  assert.deepEqual(p.folds.get(10).members, [7, 8]);
  assert.ok(!p.hidden.has(5), 'the interrupted turn keeps its rows on screen');
}

// ── a turn with no successful action draws no fold ──
{
  const p = planFolds([user('hi'), said('hello'), end(1)]);
  assert.equal(p.folds.size, 0);
  assert.ok(isEndOfRun({ k: 'system', text: 'agent gate never passed · 24 steps' }));
  assert.ok(!isEndOfRun({ k: 'system', text: 'Reverted README.md.' }));
}

// ── display keys: opening a fold, or a member changing, repaints the host and only the host ──
{
  const log = [user('go'), ok('read', 'a'), ok('edit', 'a'), said('Done'), end(2)];
  const p = planFolds(log);
  const closed = foldKeys(rowKeys(log), p, () => false);
  const opened = foldKeys(rowKeys(log), p, () => true);
  assert.deepEqual(planLogUpdate(closed, opened).patched, [4], 'opening a fold patches its host row');
  log[1] = { ...log[1], open: true };
  const memberOpened = foldKeys(rowKeys(log), planFolds(log), () => true);
  assert.deepEqual(planLogUpdate(opened, memberOpened).patched, [1, 4], 'a member row changing repaints its host');
}

// ── the app draws it: names, not exact text ──
assert.match(anvil, /from '\.\.\/\.\.\/sys\/ai\/log-fold\.mjs'/, 'Anvil imports the fold module');
assert.match(anvil, /function buildFoldRow\(/, 'Anvil has a fold row builder');
assert.match(anvil, /function buildFoldRow\([\s\S]{0,3000}?aria-expanded/, 'the fold is a button with aria-expanded');
assert.match(anvil, /function buildFoldRow\([\s\S]{0,3000}?aria-controls/, 'the button names the region it opens');
assert.match(anvil, /function renderLog\(\)\{[\s\S]{0,2500}?displayKeys\(t\)/, 'renderLog plans with the fold-aware keys');

console.log('log-fold: all assertions passed');
