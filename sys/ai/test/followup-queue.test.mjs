// AC-4 — the follow-up queue as durable state.
//   node sys/ai/test/followup-queue.test.mjs
//
// Four defects found by auditing the code that shipped, each with a case here that the OLD
// behaviour fails. The queue was `t.queued = ['some text', …]` with an index-keyed ✕ button and a
// one-line drain, and every one of these was reachable by a user doing something ordinary.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateQueue, reconcileQueue, enqueue, removeEntry, moveEntry, editEntry,
         nextDispatch, completeDispatch, releaseDispatch, pendingCount, admitRun } from '../followup-queue.mjs';

const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
const texts = (q) => q.map((e) => e.text);

// ── DEFECT 1: the dequeue→dispatch window lost the prompt ──────────────────
// Old: `const next = t.queued.shift(); save(); … runTask(t, next)`. The entry left the queue and
// was PERSISTED gone before the run existed. Close the tab in that window and the prompt is in no
// queue, no log and no record.
{
  let { queue } = enqueue([], 'first');
  ({ queue } = enqueue(queue, 'second'));

  // Claim, and persist the claim. The entry is still in the queue — that is the fix.
  const d = nextDispatch(queue, { stop: 'done' });
  assert.equal(d.entry.text, 'first');
  assert.equal(d.queue.length, 2, 'the claimed entry has NOT left the queue yet');
  assert.equal(d.queue[0].state, 'dispatching', 'it is marked as claimed');

  // ---- the crash happens exactly here: the claim is on disk, the run never started ----
  const afterCrash = migrateQueue(JSON.parse(JSON.stringify(d.queue)));
  const rec = reconcileQueue(afterCrash.queue);
  assert.deepEqual(rec.recovered, ['first'], 'the claimed prompt is RECOVERED, not lost');
  assert.deepEqual(texts(rec.queue), ['first', 'second'], 'and both entries survive, in order');
  assert.equal(rec.queue[0].state, 'pending', 'the dead claim is demoted so it can run again');
  assert.equal(pendingCount(rec.queue), 2);

  // The happy path still removes it, but only once the run has genuinely begun.
  const after = completeDispatch(d.queue, d.entry.id);
  assert.deepEqual(texts(after), ['second'], 'a started run consumes its entry');
  // And a throw between claim and start releases the claim rather than eating the work.
  assert.deepEqual(texts(releaseDispatch(d.queue, d.entry.id)), ['first', 'second']);
  assert.equal(releaseDispatch(d.queue, d.entry.id)[0].state, 'pending');
}

// ── DEFECT 2: removal was keyed on a render-time INDEX ─────────────────────
// Old: `x.onclick = () => { t.queued.splice(idx, 1); … }` with `idx` captured at render. If the
// queue drained between render and click, the user deleted a different item than the one clicked.
{
  let { queue } = enqueue([], 'A'); ({ queue } = enqueue(queue, 'B')); ({ queue } = enqueue(queue, 'C'));
  const idOfB = queue[1].id;
  // The queue drains while the chip for B is on screen at index 1.
  const drained = completeDispatch(nextDispatch(queue, { stop: 'done' }).queue, queue[0].id);
  assert.deepEqual(texts(drained), ['B', 'C'], 'A ran; B is now at index 1-1=0');
  // The old code would splice(1) here and delete C. Keyed on the id, it deletes B.
  const after = removeEntry(drained, idOfB).queue;
  assert.deepEqual(texts(after), ['C'], 'the entry the user clicked is the entry removed');
  assert.equal(removeEntry(after, 'no-such-id').removed, false, 'an unknown id is a no-op, not a throw');
}

// ── DEFECT 3: a failing run cascaded the whole queue ───────────────────────
// Old guard was `!wasAborted`, so only a Stop held the queue. A run that ended in `error`,
// `budget`, `max-steps` or an unpassed gate handed the next prompt to a workspace nobody had
// looked at — and then the one after that.
{
  const { queue } = enqueue([], 'next thing');
  const holds = [
    [{ aborted: true }, /stopped the run/],
    [{ error: 'network died' }, /ended in an error/],
    [{ stop: 'error' }, /ended 'error'/],
    [{ stop: 'budget' }, /ended 'budget'/],
    [{ stop: 'max-steps' }, /ended 'max-steps'/],
    [{ stop: 'unverified' }, /ended 'unverified'/],
    [{ stop: 'no-progress' }, /ended 'no-progress'/],
  ];
  for (const [outcome, why] of holds) {
    const d = nextDispatch(queue, outcome);
    assert.equal(d.entry, null, `${JSON.stringify(outcome)} must NOT dispatch`);
    assert.equal(d.paused, true);
    assert.match(d.reason, why, 'and it says why — a queue that stops silently is the same defect again');
    assert.deepEqual(texts(d.queue), ['next thing'], 'the work is held, not dropped');
  }
  // Only a clean finish drains.
  assert.equal(nextDispatch(queue, { stop: 'done' }).entry.text, 'next thing');
  assert.equal(nextDispatch(queue, {}).entry.text, 'next thing', 'no outcome at all is treated as clean');
  // Nothing pending: not paused, nothing to say.
  const empty = nextDispatch([], { aborted: true });
  assert.equal(empty.entry, null); assert.equal(empty.paused, false); assert.equal(empty.reason, '');
}

// ── DEFECT 4: legacy queues are strings, and must survive ──────────────────
// A migration that drops the owner's pending work to tidy a shape is worse than the shape.
{
  const m = migrateQueue(['old one', 'old two']);
  assert.equal(m.migrated, 2);
  assert.deepEqual(texts(m.queue), ['old one', 'old two'], 'legacy strings are carried forward in order');
  assert.ok(m.queue.every((e) => e.state === 'pending' && e.id && e.at), 'each gains an id, a state and a time');
  assert.equal(new Set(m.queue.map((e) => e.id)).size, 2, 'ids are distinct');

  const mixed = migrateQueue(['legacy', { id: 'k1', text: 'modern', state: 'dispatching', at: 5 }, '', null, 42, { text: '  ' }]);
  assert.deepEqual(texts(mixed.queue), ['legacy', 'modern'], 'unusable entries are dropped');
  assert.equal(mixed.dropped, 4, 'and counted, so the app can say so rather than lose them quietly');
  assert.equal(mixed.queue[1].id, 'k1', 'an existing id is preserved — it is what the UI is keyed on');
  assert.equal(mixed.queue[1].state, 'dispatching', 'and its state survives migration, for reconcile to handle');
  assert.deepEqual(migrateQueue(undefined).queue, [], 'no queue at all is fine');
  assert.deepEqual(migrateQueue('not an array').queue, []);
  assert.equal(migrateQueue([{ text: 'x', state: 'bogus' }]).queue[0].state, 'pending', 'an unknown state is not honoured');
}

// ── reconcile is idempotent, and quiet when there is nothing to recover ────
{
  const clean = migrateQueue(['a', 'b']).queue;
  const r1 = reconcileQueue(clean);
  assert.deepEqual(r1.recovered, [], 'nothing claimed means nothing announced');
  const r2 = reconcileQueue(r1.queue);
  assert.deepEqual(r2.recovered, []);
  assert.deepEqual(texts(r2.queue), ['a', 'b']);
}

// ── edit and reorder, both keyed on id ─────────────────────────────────────
{
  let { queue } = enqueue([], 'A'); ({ queue } = enqueue(queue, 'B')); ({ queue } = enqueue(queue, 'C'));
  const [a, b, c] = queue.map((e) => e.id);
  assert.deepEqual(texts(moveEntry(queue, c, -1).queue), ['A', 'C', 'B']);
  assert.deepEqual(texts(moveEntry(queue, a, +2).queue), ['B', 'C', 'A']);
  assert.deepEqual(texts(moveEntry(queue, a, -1).queue), ['A', 'B', 'C'], 'clamped at the top, not wrapped');
  assert.equal(moveEntry(queue, a, -1).moved, false);
  assert.equal(moveEntry(queue, 'nope', +1).moved, false);
  assert.deepEqual(texts(editEntry(queue, b, 'B2').queue), ['A', 'B2', 'C']);
  assert.equal(editEntry(queue, b, 'B2').queue[1].id, b, 'editing keeps the id, so the chip keeps working');
  assert.deepEqual(texts(editEntry(queue, b, '   ').queue), ['A', 'C'], 'editing to empty is a removal');
  assert.deepEqual(texts(enqueue(queue, '  ').queue), ['A', 'B', 'C'], 'enqueueing blank is a no-op');
  assert.equal(enqueue(queue, '  ').entry, null);
}

// ── AC-8a: admission — may a NEW run start at all? ────────────────────────
// The queue has held on a bad ending since AC-4. A fresh Send did not, so the same question had
// two different answers depending only on where the prompt came from: press Send after three
// failed runs and the fourth started, into a workspace nobody had looked at.
//
// Neither refusal kills anything in flight. That is the entire distinction a quota draws against a
// fuse — budget, max-steps and no-progress all stop a run already going; none of them declines to
// start one.
{
  assert.equal(admitRun({}).admit, true, 'nothing wrong, nothing to say');
  assert.equal(admitRun({ lastStop: 'done' }).admit, true, 'a clean finish admits the next run');

  // The explicit hold. Cleared only by the owner.
  const held = admitRun({ held: true, heldReason: 'checking the diff' });
  assert.equal(held.admit, false);
  assert.equal(held.kind, 'held');
  assert.match(held.reason, /on hold: checking the diff/, 'the reason the owner gave is shown back');
  assert.match(admitRun({ held: true }).reason, /New runs are on hold\./, 'and it works without one');
  // A hold outranks everything, including an acknowledgement — otherwise sending twice would
  // walk straight through a switch the owner deliberately set.
  assert.equal(admitRun({ held: true, acknowledged: true }).admit, false,
    'acknowledging does not clear an explicit hold');

  // After a bad ending: hold ONCE.
  for (const [state, re] of [
    [{ lastWasError: true }, /ended in an error/],
    [{ lastStop: 'budget' }, /ended 'budget'/],
    [{ lastStop: 'max-steps' }, /ended 'max-steps'/],
    [{ lastStop: 'unverified' }, /ended 'unverified'/],
    [{ lastStop: 'aborted' }, /ended 'aborted'/],
    // 'interrupted' is produced by the startup reconciliation for a task left `running` by a tab
    // that closed mid-run — a real value the app writes, so it is named here rather than left to
    // the generic branch.
    [{ lastStop: 'interrupted' }, /ended 'interrupted'/],
  ]) {
    const a = admitRun(state);
    assert.equal(a.admit, false, `${JSON.stringify(state)} holds the next run`);
    assert.match(a.reason, re);
    assert.match(a.reason, /Send again to run anyway/, 'and says how to proceed — a dead end is not a speed bump');
    // Sending again goes through. A quota you cannot override by repeating yourself is a quota
    // that gets switched off.
    assert.equal(admitRun({ ...state, acknowledged: true }).admit, true, 'the second send is admitted');
  }
  // An error outranks a stop reason when both are present — it is the more specific thing to say.
  assert.equal(admitRun({ lastWasError: true, lastStop: 'budget' }).kind, 'after-error');
}

// ── the app actually uses all of it ────────────────────────────────────────
assert.match(anvil, /t\.queued=qEnqueue\(t\.queued, text\)\.queue/, 'submit enqueues through the reducer');
assert.match(anvil, /const _d = nextDispatch\(t\.queued, _out\)/, 'the drain goes through nextDispatch');
assert.match(anvil, /completeDispatch\(t\.queued, _d\.entry\.id\)/, 'and consumes the entry only once the run starts');
assert.match(anvil, /releaseDispatch\(t\.queued, _d\.entry\.id\)/, 'a throw before the run releases the claim');
assert.match(anvil, /t\.lastStop = result\.stop/, 'the run records how it ended, so the queue can hold on an ambiguous end');
assert.match(anvil, /const m = migrateQueue\(t\.queued\)/, 'load migrates every task queue');
assert.match(anvil, /const r = reconcileQueue\(m\.queue\)/, 'and reconciles dead claims');
assert.match(anvil, /if\(queueRecovered\) pushSystem\(/, 'a recovered entry is SAID, never silently restored');
// The index-keyed splice is gone — that is the whole of defect 2.
assert.ok(!/\(t\.queued\|\|\[\]\)\.splice\(idx,1\)/.test(anvil), 'no index-keyed removal survives');
assert.match(anvil, /qRemove\(t\.queued,q\.id\)/, 'removal is keyed on the entry id');
assert.match(anvil, /qMove\(t\.queued,q\.id/, 'so is reorder');
assert.match(anvil, /qEdit\(t\.queued,q\.id/, 'so is edit');
// The old drain must not still be there.
assert.ok(!/const next=t\.queued\.shift\(\)/.test(anvil), 'the shift-then-run drain is gone');

// The app: a fresh Send is admitted through the same question the queue asks.
assert.match(anvil, /const adm = admitRun\(\{ held: !!state\.runsHeld/, 'submit asks before starting a run');
// …and ACTS on the answer. Asserting the call without the guard let a mutation turn the whole
// feature off while every other assertion here still passed.
assert.match(anvil, /if\(!adm\.admit\)\{/, 'and a refusal actually stops the run starting');
assert.ok(anvil.indexOf('const adm = admitRun') < anvil.indexOf('runTask(t, text);'),
  'the question is asked BEFORE the run starts, not after');
assert.match(anvil, /if\(adm\.kind !== 'held'\)\{ t\.ackAfterBadRun = true; \$\('prompt'\)\.value = text; autoGrow\(\); \}/,
  'a speed-bump refusal KEEPS the prompt — losing what the owner typed would be its own defect');
assert.match(anvil, /if\(result\.stop === 'done'\) t\.ackAfterBadRun = false;/, 'a clean run restores the speed bump');
assert.match(anvil, /state\.runsHeld=true; state\.runsHeldReason=String\(why\|\|''\)\.trim\(\);/, 'the hold records its reason');
assert.match(anvil, /⏸ HOLD — new runs blocked/, 'and a held session says so in the taskbar');

// A task left `running` by a closed tab is reconciled on load. `running` is written when a run
// starts and replaced only when it ends, so on a fresh load nothing owns it — the in-memory flag
// is false, which is why it does not BLOCK a run, but the UI reads the persisted status and showed
// a pulsing "running" dot beside a Send button with no Stop.
assert.match(anvil, /if\(t\.status === 'running'\)\{/, 'an orphaned running status is reconciled on load');
assert.match(anvil, /t\.status = 'idle'; t\.lastStop = 'interrupted'; t\.ackAfterBadRun = false;/,
  'demoted, and routed through admitRun as the bad ending it is');
assert.match(anvil, /still running when Anvil last closed/, 'and the task says what happened');
assert.match(anvil, /if\(runsInterrupted\) pushSystem\(/, 'with a boot notice — a silent recovery is a defect too');
assert.match(anvil, /Nothing already running is stopped/, 'the dialog is explicit that it is not a fuse');

console.log('followup-queue: claim survives a crash, id-keyed edits, a bad ending holds the queue and the next SEND, legacy strings migrate');
