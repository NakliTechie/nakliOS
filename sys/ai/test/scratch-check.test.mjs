// Conformance — the finish check for scratch files (sys/ai/scratch-check.mjs) and the agent loop's
// once-per-run `finishCheck` (sys/ai/agent-loop.mjs), recorded and replayed (sys/history).
//   node sys/ai/test/scratch-check.test.mjs
import { askNames, unaskedNewFiles, scratchNote, makeFinishCheck, SCRATCH_LIST_LIMIT } from '../scratch-check.mjs';
import { runAgentLoop } from '../agent-loop.mjs';
import { createWorkspaceCapture } from '../workspace-capture.mjs';
import { createRunRecorder, foldTranscript, foldLog, joined } from '../../history/run-record.mjs';
import { replayEntry } from '../../history/replay-corpus.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const call = (name, args, id) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
function scriptedInfer(script) { let i = 0; return async () => script[Math.min(i++, script.length - 1)]; }
// A workspace as a Set of paths; `write` adds one, `rm` removes one. Enough to drive the check.
function fakeWorkspace(seed = []) {
  const files = new Set(seed); const start = new Set(seed);
  const executeTool = async (name, args) => {
    if (name === 'write') { files.add(args.path); return 'wrote ' + args.path; }
    if (name === 'rm') { files.delete(args.path); return 'removed ' + args.path; }
    return 'ok';
  };
  return { files, executeTool, created: () => [...files].filter((p) => !start.has(p)) };
}
const tools = ['write', 'rm'].map((name) => ({ type: 'function', function: { name, parameters: { type: 'object' } } }));
const ASK = 'Implement evaluate in expr.mjs exactly as the comment at the top of the file specifies.';

// ── the pure helpers ──
await test('the ask names a path by itself, by its file name, or by one of its folders', async () => {
  assert(askNames(ASK, 'expr.mjs'), 'expr.mjs is named');
  assert(!askNames(ASK, 'tmp/t.mjs'), 'tmp/t.mjs is not');
  const build = 'Build mdlite.mjs: an ES module that exports render(markdown). You may put tests under test/.';
  assert(askNames(build, 'test/mdlite.test.mjs'), 'a file under a named folder is named');
  assert(askNames('Fix the ledger package (ledger/money.mjs).', 'ledger/money.mjs'), 'a full path');
  assert(!askNames('Update mdlite.mjs.', 'old-mdlite.mjs'), 'a file name inside a longer name is not a match');
  assert(!askNames('', 'a.mjs'), 'an empty ask names nothing');
});

await test('unaskedNewFiles drops named files and Anvil\'s own state, and sorts', async () => {
  const got = unaskedNewFiles(['tmp/t.mjs', 'expr.mjs', '.anvil/runs/x.json', '.git/index', 'check.mjs', 'tmp/t.mjs'], ASK);
  eq(JSON.stringify(got), JSON.stringify(['check.mjs', 'tmp/t.mjs']), 'only the unnamed scratch files');
});

await test('the note names every file up to the limit and counts the rest', async () => {
  eq(scratchNote(['tmp/t.mjs']).includes('created 1 file the request did not name: `tmp/t.mjs`'), true, 'singular, quoted path');
  const many = Array.from({ length: SCRATCH_LIST_LIMIT + 3 }, (_, i) => `tmp/f${String(i).padStart(2, '0')}.mjs`);
  const note = scratchNote(many);
  assert(note.includes(`created ${many.length} files`), 'the full count');
  assert(note.includes('and 3 more'), 'the overflow count');
  assert(!note.includes('`tmp/f' + (SCRATCH_LIST_LIMIT + 1) + '.mjs`'), 'past the limit is not listed');
});

await test('makeFinishCheck answers once with a note, null with nothing new, null on a failing listing', async () => {
  const check = makeFinishCheck({ created: () => ['tmp/t.mjs'], ask: ASK });
  assert(typeof (await check()) === 'string', 'first ask: a note');
  eq(await check(), null, 'second ask: nothing, it fires once');
  eq(await makeFinishCheck({ created: () => ['expr.mjs'], ask: ASK })(), null, 'only named files: no note');
  eq(await makeFinishCheck({ created: () => { throw new Error('listing failed'); }, ask: ASK })(), null, 'a throw never blocks the finish');
});

// ── the loop ──
await test('a run that leaves a scratch file is asked once, deletes it, and finishes done', async () => {
  const ws = fakeWorkspace(['expr.mjs']);
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: ASK }], tools, executeTool: ws.executeTool, onEvent: (e) => events.push(e),
    finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
    infer: scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'expr.mjs' }, 'c0'), call('write', { path: 'tmp/t.mjs' }, 'c1')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Implemented evaluate and checked it with tmp/t.mjs.' }, 'c2')] },
      { content: '', toolCalls: [call('rm', { path: 'tmp/t.mjs' }, 'c3'), call('task_done', { summary: 'Implemented evaluate; removed tmp/t.mjs.' }, 'c4')] },
      { content: 'should never be asked', toolCalls: [] },
    ]),
  });
  eq(result.stop, 'done', 'the run still ends done');
  eq(result.steps, 3, 'one extra step, no more');
  eq(events.filter((e) => e.type === 'finish-check').length, 1, 'exactly one note');
  assert(!ws.files.has('tmp/t.mjs'), 'the model removed it');
  const note = result.messages.find((m) => m.role === 'user' && /^\[coordination\] Before you finish/.test(m.content));
  assert(note && note.content.includes('`tmp/t.mjs`'), 'the note is in the transcript and names the file');
});

await test('a run that creates only what the ask names finishes without a note', async () => {
  const ws = fakeWorkspace([]);
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: ASK }], tools, executeTool: ws.executeTool, onEvent: (e) => events.push(e),
    finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
    infer: scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'expr.mjs' }, 'c0')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Implemented evaluate in expr.mjs.' }, 'c1')] },
    ]),
  });
  eq(result.stop, 'done', 'done');
  eq(result.steps, 2, 'no extra step');
  eq(events.filter((e) => e.type === 'finish-check').length, 0, 'no note');
});

await test('a reply with no tool calls is checked too (the plain finish path)', async () => {
  const ws = fakeWorkspace([]);
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: ASK }], tools, executeTool: ws.executeTool,
    finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
    infer: scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'check.mjs' }, 'c0')] },
      { content: 'Done.', toolCalls: [] },
      { content: '', toolCalls: [call('rm', { path: 'check.mjs' }, 'c1')] },
      { content: 'Done, and check.mjs is gone.', toolCalls: [] },
    ]),
  });
  eq(result.stop, 'done', 'done');
  eq(result.steps, 4, 'the note took one turn and the cleanup one more');
  assert(!ws.files.has('check.mjs'), 'removed');
});

await test('a gated run is checked after the gate passes, and the gate runs again before done', async () => {
  const ws = fakeWorkspace([]);
  let gateRuns = 0;
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: ASK }], tools, executeTool: ws.executeTool,
    verify: async () => { gateRuns++; return { ok: true, exit: 0, stdout: '', stderr: '' }; },
    finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
    infer: scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'tmp/t.mjs' }, 'c0'), call('task_done', { summary: 'Implemented evaluate; gate should pass.' }, 'c1')] },
      { content: '', toolCalls: [call('rm', { path: 'tmp/t.mjs' }, 'c2'), call('task_done', { summary: 'Implemented evaluate; removed tmp/t.mjs.' }, 'c3')] },
    ]),
  });
  eq(result.stop, 'done', 'done');
  eq(result.verified, true, 'verified');
  eq(gateRuns, 2, 'the gate ran on the first task_done and again after the cleanup');
});

await test('no note on the last step: a finished run never becomes a max-steps stop', async () => {
  const ws = fakeWorkspace([]);
  const events = [];
  const result = await runAgentLoop({
    messages: [{ role: 'user', content: ASK }], tools, executeTool: ws.executeTool, onEvent: (e) => events.push(e), maxSteps: 2,
    finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
    infer: scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'tmp/t.mjs' }, 'c0')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Implemented evaluate in expr.mjs.' }, 'c1')] },
    ]),
  });
  eq(result.stop, 'done', `done, not ${result.stop}`);
  eq(events.filter((e) => e.type === 'finish-check').length, 0, 'no note when no step is left');
});

// ── the capture's created() ──
await test('createWorkspaceCapture.created lists files new since the baseline, never directories', async () => {
  const tree = new Map([['expr.mjs', 'x']]);
  const fs = {
    async list(dir) {
      const pre = dir ? dir + '/' : '';
      const seen = new Map();
      for (const p of tree.keys()) if (p.startsWith(pre)) { const rest = p.slice(pre.length); const head = rest.split('/')[0]; seen.set(pre + head, rest.includes('/') ? 'dir' : 'file'); }
      return { ok: true, entries: [...seen].map(([path, type]) => ({ path, type })), truncated: false, snapshotConsistent: true };
    },
    async read(p) { return { ok: tree.has(p), bytes: new TextEncoder().encode(tree.get(p) || '') }; },
    async stat(p) { return tree.has(p) ? { ok: true, type: 'file', size: tree.get(p).length } : { ok: false }; },
  };
  const cap = createWorkspaceCapture(fs, 1);
  await cap.start();
  tree.set('tmp/t.mjs', 'y'); tree.set('expr.mjs', 'z');
  await cap.observe();
  eq(JSON.stringify(cap.created()), JSON.stringify(['tmp/t.mjs']), 'the new file only: no changed file, no folder');
});

// ── the record ──
await test('the note is on the chain, folds back into the transcript and the log, and replays', async () => {
  const ws = fakeWorkspace([]);
  const messages = [{ role: 'user', content: ASK }];
  const rec = createRunRecorder({ app: 'anvil', principal: 'scratch-test' });
  await rec.start({ messages, tools });
  const result = await runAgentLoop({
    messages, tools, executeTool: rec.wrapExecute ? rec.wrapExecute(ws.executeTool) : ws.executeTool,
    infer: rec.wrapInfer(scriptedInfer([
      { content: '', toolCalls: [call('write', { path: 'tmp/t.mjs' }, 'c0')] },
      { content: '', toolCalls: [call('task_done', { summary: 'Implemented evaluate in expr.mjs.' }, 'c1')] },
      { content: '', toolCalls: [call('rm', { path: 'tmp/t.mjs' }, 'c2'), call('task_done', { summary: 'Implemented evaluate; removed tmp/t.mjs.' }, 'c3')] },
    ])),
    onEvent: rec.onEvent, finishCheck: makeFinishCheck({ created: ws.created, ask: ASK }),
  });
  await rec.finish(result); await rec.settled();
  const chain = joined(rec.events(), rec.resolve);
  const checked = chain.filter((e) => e.tool === 'run.checked');
  eq(checked.length, 1, 'one run.checked event');
  const note = result.messages.find((m) => /^\[coordination\] Before you finish/.test(String(m.content)));
  eq(checked[0].output.content, note.content, 'the chain holds the exact bytes sent');
  const folded = foldTranscript(rec.events(), rec.resolve);
  assert(folded.some((m) => m.role === 'user' && m.content === note.content), 'the transcript fold rebuilds the note');
  const log = foldLog(rec.events(), rec.resolve);
  const rows = Array.isArray(log) ? log : (log.rows || []);
  assert(rows.some((r) => r.k === 'system' && /^Finish check: Before you finish/.test(r.text)), 'the log fold shows it');
  const replay = await replayEntry(rec.export());
  assert(replay.ok, `the record replays cleanly: ${replay.why}`);
});

for (const f of failures) console.log(`✖ ${f.n}\n    ${f.message}`);
console.log(`${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
