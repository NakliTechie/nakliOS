// Guards the history tool's wiring in Anvil (B2): the agent can search and read its own
// run records, in every mode, over the persisted records — the retrieval half of the
// substrate. Grep-based; pins the seam, the pure core is unit-tested in run-record.test.mjs.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchRecords, scopeEntries, readEvent, historyTool } from '../sys/history/run-record.mjs';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

assert.match(anvil, /import \{[^}]*\bsearchRecords\b[^}]*\bhistoryTool\b[^}]*\} from '\.\.\/\.\.\/sys\/history\/run-record\.mjs'/, 'Anvil imports the history core');
assert.match(anvil, /async function loadTaskRecords\(scope/, 'a helper loads the task\'s records by scope');
// forward-pass NAF-02/NAF-07: every scope stays inside the active project, and the CALLER names
// its task rather than inheriting whatever the UI has selected.
assert.match(anvil, /if\(p!==proj\) continue;/, 'project scope no longer reads every project');
assert.match(anvil, /const callerTask = runCtx && runCtx\.t && runCtx\.t\.id;/, 'the ASKING task is named once, not inherited from the UI selection');
// the DEFAULT scope is 'task': defaulting to 'run' would silently hide every earlier run of
// the caller's own task, and every other anchor here would still match (mutation-tested).
assert.match(anvil, /\['run','task','project'\]\.includes\(ar&&ar\.scope\)\?ar\.scope:'task'/, "an omitted scope means the whole TASK, not just the latest run");
assert.match(anvil, /loadTaskRecords\(scope, callerTask\)/, 'history asks for the calling task\'s records');
assert.match(anvil, /getDirectoryHandle\('anvil'\)\)\.getDirectoryHandle\('runs'\)/, 'it reads the persisted OPFS records');
assert.match(anvil, /if\(nm==='history'\)\{/, 'a history handler exists');
assert.match(anvil, /searchRecords\(entries,\{ query:/, 'search is served by the pure core');
// S-1: the tool advertises scope run|task|project, so the SEARCH must apply it — the loader's
// narrowing is a cost optimisation, not the guarantee. Both the scope and the asking task reach
// the core, and a read is served from the scoped set so it cannot cross what the search could not.
assert.match(anvil, /searchRecords\(entries,\{[^}]*\bscope\b[^}]*taskId:callerTask/, 'the scope and the asking task reach searchRecords');
assert.match(anvil, /const scoped=scopeEntries\(entries, scope, callerTask\)/, 'the entries are scoped in the module, not only by the loader');
assert.match(anvil, /readEvent\(scoped,String\(\(ar&&ar\.id\)\|\|''\)/, 'read is served from the SCOPED set (a read must not reach what a search could not)');
assert.match(anvil, /entries\.push\(\{ runId:rid, taskId:tk,/, 'the loader tags each entry with its task, or scoping has nothing to match on');
assert.match(anvil, /tools\.push\(historyTool\(\)\);/, 'the history tool is offered');
// history is NOT gated to code mode (read-only): it must not be in the mode!=='code' refusal list
assert.ok(!/nm==='history'[^)]*\)\)\{\s*\n\s*return 'Error: the "'\+nm/.test(anvil), 'history is available in every mode');

// The contract the app depends on, in the pure core.
assert.equal(historyTool().function.name, 'history', 'tool name');
assert.equal(searchRecords([], { query: 'x' }).length, 0, 'no records → no hits, no throw');
assert.ok(readEvent([], 'nope', {}).error, 'a bad id is an error, not a throw');
// scope is real in the core, not a parameter the app passes into a no-op
{
  const e = [{ runId: 'a', taskId: 't1', record: null }, { runId: 'b', taskId: 't2', record: null }];
  assert.equal(scopeEntries(e, 'task', 't1').length, 1, 'task scope drops the sibling task');
  assert.equal(scopeEntries(e, 'project', 't1').length, 2, 'project scope keeps both');
}

console.log('anvil-history: the agent can search and read its own run records in every mode');
