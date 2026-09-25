// CRIB-E E1 (ZR-A1) — the follow-up queue, driven through Anvil's REAL handlers.
//   node scripts/test-anvil-queue-handlers.mjs
//
// sys/ai/test/followup-queue.test.mjs proves the queue MODULE (85 assertions). What it cannot prove
// is that the app calls it right: its last section is greps — "the app uses all of it" — and a grep
// passes on a call that runs in the wrong order, on the wrong outcome, or not at all. This file
// extracts the four places the app touches the queue and runs them:
//   submit()          — Send while a run is in flight queues; Send while idle runs (admission first)
//   the drain         — runTask's finally: claim → persist → start, and hold on Stop / error
//   the load pass     — legacy string queues migrate; a claim that outlived its tab is recovered
//   the queue rows    — ↑ ↓ ✎ ✕ act on the entry's id, even after the queue changed under them
// Mid-turn steering is deliberately not built (plan/anvil-capabilities.md): Send during a run
// queues, and that is asserted here too.
import assert from 'node:assert/strict';
import { inlineModule, extractFunction, extractRegion, instantiate, evaluate } from './anvil-harness.mjs';
import { migrateQueue, reconcileQueue, enqueue, removeEntry, moveEntry, editEntry,
         nextDispatch, completeDispatch, releaseDispatch, admitRun } from '../sys/ai/followup-queue.mjs';

const src = await inlineModule();
const Q = { qEnqueue: enqueue, qRemove: removeEntry, qMove: moveEntry, qEdit: editEntry, migrateQueue, reconcileQueue,
            nextDispatch, completeDispatch, releaseDispatch, admitRun };
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
const texts = (q) => (q || []).map((e) => e.text);
const states = (q) => (q || []).map((e) => e.state);

// ── submit() ────────────────────────────────────────────────────────────────────────────────
function submitBed({ running, t }) {
  const prompt = { value: '' };
  const calls = { runTask: [], system: [], saves: 0 };
  const ctx = { ...Q, running, state: {}, activeTask: () => t, $: (id) => (id === 'prompt' ? prompt : {}),
    autoGrow() {}, save() { calls.saves++; }, renderLog() {}, pushSystem: (x) => calls.system.push(x),
    runTask: (task, text) => calls.runTask.push(text) };
  const submit = instantiate(extractFunction(src, 'submit'), 'submit', ctx);
  return { submit, prompt, calls, ctx };
}

await test('Send during a run QUEUES (no mid-turn steering): an id-keyed pending entry, nothing started, the box cleared', () => {
  const t = { id: 't1', queued: [] };
  const b = submitBed({ running: true, t });
  b.prompt.value = 'also add tests'; b.submit();
  assert.deepEqual(texts(t.queued), ['also add tests']);
  assert.deepEqual(states(t.queued), ['pending']);
  assert.ok(t.queued[0].id, 'the entry carries an id');
  assert.equal(b.calls.runTask.length, 0, 'nothing ran');
  assert.equal(b.prompt.value, '', 'the composer is cleared');
  assert.ok(b.calls.saves >= 1, 'the queue is persisted at once');
});

await test('Send while idle runs; after a stopped run it holds once (the prompt stays), and the second Send runs', () => {
  const t = { id: 't1', queued: [], lastStop: 'aborted', status: 'idle' };
  const b = submitBed({ running: false, t });
  b.prompt.value = 'try again'; b.submit();
  assert.equal(b.calls.runTask.length, 0, 'held after a Stop');
  assert.match(b.calls.system[0], /ended 'aborted'.*Send again/, b.calls.system[0]);
  assert.equal(b.prompt.value, 'try again', 'the prompt is kept for the second Send');
  b.submit();
  assert.deepEqual(b.calls.runTask, ['try again'], 'the second Send goes through');
  const fresh = submitBed({ running: false, t: { id: 't2', queued: [], status: 'idle' } });
  fresh.prompt.value = 'go'; fresh.submit();
  assert.deepEqual(fresh.calls.runTask, ['go'], 'a clean task runs at once');
});

// ── the drain (runTask's finally) ───────────────────────────────────────────────────────────
const drain = extractRegion(src, 'const _out = { aborted: wasAborted', '\n    }\n  }\n  // Never disabled');
function drainBed({ t, wasAborted = false, runTaskThrows = false, busy = false }) {
  const calls = { runTask: [], system: [], saved: [], timers: [] };
  const ctx = { ...Q, t, wasAborted,
    save: () => calls.saved.push(JSON.parse(JSON.stringify(t.queued || []))),
    renderLog() {}, pushSystem: (x) => calls.system.push(x),
    // the real runTask: `if(!t||running) return;`, then a synchronous prefix that sets status 'running'
    runTask: (task, text) => { if (runTaskThrows) throw new Error('boom'); if (busy) return Promise.resolve(); calls.runTask.push(text); task.status = 'running'; return Promise.resolve(); },
    setTimeout: (fn) => calls.timers.push(fn) };
  evaluate(drain, ctx);
  return { calls, flush: () => { for (const f of calls.timers.splice(0)) f(); } };
}
const queueOf = (...xs) => xs.reduce((q, x) => enqueue(q, x).queue, []);

await test('drain after a done run: the next entry is CLAIMED and persisted before its run exists, then started and removed', () => {
  const t = { id: 't', status: 'done', lastStop: 'done', log: [], queued: queueOf('first', 'second') };
  const b = drainBed({ t });
  assert.deepEqual(states(b.calls.saved[0]), ['dispatching', 'pending'], 'the claim hits storage first — a tab closed now loses nothing');
  assert.equal(b.calls.runTask.length, 0, 'the run starts on the next tick, not inside the finally');
  b.flush();
  assert.deepEqual(b.calls.runTask, ['first']);
  assert.deepEqual(texts(t.queued), ['second'], 'the started entry leaves; the rest stay');
  assert.deepEqual(states(t.queued), ['pending']);
});

await test('Stop with items remaining: nothing drains, the queue holds and says why', () => {
  const t = { id: 't', status: 'idle', lastStop: 'aborted', log: [], queued: queueOf('a', 'b') };
  const b = drainBed({ t, wasAborted: true });
  b.flush();
  assert.equal(b.calls.runTask.length, 0);
  assert.deepEqual(states(t.queued), ['pending', 'pending'], 'both kept, neither claimed');
  assert.match(b.calls.system[0], /you stopped the run — the queue is holding/, b.calls.system[0]);
});

await test('a run that ended in error does not cascade the next follow-up', () => {
  const t = { id: 't', status: 'error', lastStop: 'error', log: [{ k: 'system', text: 'agent error: 500' }], queued: queueOf('a') };
  const b = drainBed({ t });
  b.flush();
  assert.equal(b.calls.runTask.length, 0);
  assert.match(b.calls.system[0], /ended in an error.*queue is holding/, b.calls.system[0]);
});

await test('failed dispatch: runTask throws → the claim is released, the entry is pending again, and the log says so', () => {
  const t = { id: 't', status: 'done', lastStop: 'done', log: [], queued: queueOf('first') };
  const b = drainBed({ t, runTaskThrows: true });
  b.flush();
  assert.deepEqual(texts(t.queued), ['first'], 'not lost');
  assert.deepEqual(states(t.queued), ['pending'], 'released, not stuck as dispatching');
  assert.match(b.calls.system.at(-1), /could not start the next follow-up — boom\. It is still queued/);
});

await test('another run took the tick: runTask returns without starting → the claim is released, the prompt is not deleted', () => {
  const t = { id: 't', status: 'done', lastStop: 'done', log: [], queued: queueOf('first') };
  const b = drainBed({ t, busy: true });
  b.flush();
  assert.deepEqual(texts(t.queued), ['first'], 'still queued (before E1: completed, then runTask returned — gone)');
  assert.deepEqual(states(t.queued), ['pending']);
  assert.match(b.calls.system.at(-1), /another run is in progress\. It is still queued/);
});

// ── the load pass: legacy queues and a claim that outlived its tab ─────────────────────────────
const loadPass = extractRegion(src, 'if(!t.queued) continue;', '\n      }\n    }\n  }catch');
function reload(tasks) {
  // evaluate() runs in a COPY of ctx, so the counters the load pass assigns are returned, not read back
  return evaluate(`var queueDropped = 0, queueRecovered = 0; for (const t of tasks) { ${loadPass} } ({ queueDropped, queueRecovered })`, { ...Q, tasks });
}

await test('reload between dequeue and dispatch: the dispatching claim is recovered as pending, not lost', () => {
  const t = { id: 't', queued: queueOf('first', 'second') };
  t.queued = nextDispatch(t.queued, { stop: 'done' }).queue; // claimed + persisted, then the tab closed
  const saved = JSON.parse(JSON.stringify(t));
  const ctx = reload([saved]);
  assert.deepEqual(texts(saved.queued), ['first', 'second'], 'both prompts survive the reload');
  assert.deepEqual(states(saved.queued), ['pending', 'pending'], 'the stale claim is released');
  assert.equal(ctx.queueRecovered, 1, 'and counted, so the load can say so');
});

await test('legacy state: a queue of plain strings (pre-AC-4) migrates to id-keyed pending entries', () => {
  const t = { id: 't', queued: ['one', '', 'two', 42] };
  const ctx = reload([t]);
  assert.deepEqual(texts(t.queued), ['one', 'two']);
  assert.ok(t.queued.every((e) => e.id && e.state === 'pending'));
  assert.equal(ctx.queueDropped, 2, 'the empty and the non-string are dropped, and counted');
});

// ── the queue rows: ↑ ↓ ✎ ✕ are keyed on the entry id ─────────────────────────────────────────
const rowsStart = '    for(const q of (t.queued||[])){';
const rowsEndMarker = 'd.appendChild(head); d.appendChild(body); w.appendChild(d);\n    }';
const rowsA = src.indexOf(rowsStart);
const rows = src.slice(rowsA, src.indexOf(rowsEndMarker, rowsA) + rowsEndMarker.length);
function renderRows(t, { promptAnswer = null } = {}) {
  const el = () => ({ children: [], appendChild(c) { this.children.push(c); }, className: '', innerHTML: '', textContent: '', title: '', onclick: null });
  const w = el();
  const ctx = { ...Q, t, w, document: { createElement: el }, save() {}, renderLog() {}, prompt: () => promptAnswer };
  evaluate(rows, ctx);
  // per row: { text, who, buttons: { '↑': fn, … } }
  return w.children.map((d) => {
    const [head, body] = d.children;
    const buttons = Object.fromEntries(head.children.map((b) => [b.textContent, b.onclick]));
    return { text: body.textContent, who: head.innerHTML, buttons };
  });
}

await test('✕ removes the entry it was drawn for, even after a drain changed the queue under it', () => {
  const t = { id: 't', queued: queueOf('A', 'B', 'C') };
  const drawn = renderRows(t);
  assert.deepEqual(drawn.map((r) => r.text), ['A', 'B', 'C']);
  // the run finishes and A drains between the render and the click
  const d = nextDispatch(t.queued, { stop: 'done' }); t.queued = completeDispatch(d.queue, d.entry.id);
  drawn[1].buttons['✕'](); // the user clicks ✕ on the row that says B
  assert.deepEqual(texts(t.queued), ['C'], 'B is removed — not C, which now sits at B\'s old index');
});

await test('✎ edits by id; ↑ ↓ reorder by id; a claimed entry shows "starting…"', () => {
  const t = { id: 't', queued: queueOf('A', 'B') };
  renderRows(t, { promptAnswer: 'B, edited' })[1].buttons['✎']();
  assert.deepEqual(texts(t.queued), ['A', 'B, edited']);
  renderRows(t)[1].buttons['↑']();
  assert.deepEqual(texts(t.queued), ['B, edited', 'A']);
  renderRows(t)[0].buttons['↓']();
  assert.deepEqual(texts(t.queued), ['A', 'B, edited']);
  renderRows(t, { promptAnswer: null })[0].buttons['✎']();
  assert.deepEqual(texts(t.queued), ['A', 'B, edited'], 'a cancelled edit changes nothing');
  t.queued = nextDispatch(t.queued, { stop: 'done' }).queue;
  const r = renderRows(t);
  assert.match(r[0].who, /starting…/, 'a claim is visible'); assert.match(r[1].who, /queued/);
});

if (failures.length) {
  console.error(`anvil-queue-handlers: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`anvil-queue-handlers: ${passed}/${passed} passed — submit, the drain, the load pass and the rows, driven`);
