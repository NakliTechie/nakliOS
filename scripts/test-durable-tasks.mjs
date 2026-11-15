// test-durable-tasks.mjs — the host's durable task ledger (sys/durable/tasks.mjs) on a fake clock.
import assert from 'node:assert/strict';
import { createTaskLedger, createMemoryTaskStore, TaskError } from '../sys/durable/tasks.mjs';

let clock = 1_000_000;
const now = () => clock;
const store = createMemoryTaskStore();
const ledger = createTaskLedger({ store, now, options: { leaseMs: 1000, restartLimit: 3 } });
const code = async (p) => { try { await p; return 'ok'; } catch (e) { assert.ok(e instanceof TaskError, String(e)); return e.code; } };

// 1. Submit is idempotent by request id, and scoped per app.
const a = await ledger.submit('app.a', { kind: 'reminder', requestId: 'r1', input: { text: 'call' } });
const again = await ledger.submit('app.a', { kind: 'reminder', requestId: 'r1', input: { text: 'other' } });
assert.equal(again.id, a.id, 'same request id returns the first task');
assert.deepEqual(again.input, { text: 'call' });
const b = await ledger.submit('app.b', { kind: 'reminder', requestId: 'r1' });
assert.notEqual(b.id, a.id, 'another app with the same request id gets its own task');
assert.equal(await code(ledger.get('app.b', a.id)), 'not_found', 'an app cannot read another app\'s task');
assert.equal((await ledger.list('app.a')).length, 1);

// 2. Claim, checkpoint, sleep, wake.
let [c] = await ledger.claim('app.a');
assert.equal(c.id, a.id); assert.equal(c.state, 'running');
await ledger.commit('app.a', a.id, c.lease, { checkpoint: { phase: 'wait' }, sleepUntil: clock + 5000 });
assert.equal((await ledger.claim('app.a')).length, 0, 'a sleeping task is not due');
let w = await ledger.wake();
assert.equal(w.nextAt, clock + 5000); assert.equal(w.due.size, 1, 'app.b still has its pending task');
clock += 5000;
[c] = await ledger.claim('app.a');
assert.equal(c.checkpoint.phase, 'wait', 'the checkpoint survives the sleep');
assert.equal(c.step, 1);
const done = await ledger.commit('app.a', a.id, c.lease, { done: true, result: 'delivered' });
assert.equal(done.state, 'done'); assert.equal(done.result, 'delivered');
assert.equal(await code(ledger.commit('app.a', a.id, c.lease, { done: true })), 'finished');

// 3. A lease that runs out counts a restart; the limit ends the task with a named reason.
const k = await ledger.submit('app.a', { kind: 'job' });
for (let i = 0; i < 3; i++) {
  const got = await ledger.claim('app.a', { kinds: ['job'] });
  assert.equal(got.length, 1, `claim ${i + 1}`);
  assert.equal(got[0].restarts, i);
  clock += 1001; // the app died: no commit before the lease ran out
}
assert.equal((await ledger.claim('app.a', { kinds: ['job'] })).length, 0);
const dead = await ledger.get('app.a', k.id);
assert.equal(dead.state, 'failed'); assert.equal(dead.error.code, 'restart_limit');

// 4. A stale lease cannot commit; a checkpoint resets the restart count.
const j = await ledger.submit('app.a', { kind: 'job2' });
let [l1] = await ledger.claim('app.a', { kinds: ['job2'] });
clock += 1001;
let [l2] = await ledger.claim('app.a', { kinds: ['job2'] });
assert.equal(l2.restarts, 1);
assert.equal(await code(ledger.commit('app.a', j.id, l1.lease, { checkpoint: 1 })), 'stale_lease');
const cp = await ledger.commit('app.a', j.id, l2.lease, { checkpoint: 2 });
assert.equal(cp.restarts, 0); assert.equal(cp.state, 'running', 'a plain checkpoint keeps the claim');

// 5. Bad input is refused; cancel ends a task.
assert.equal(await code(ledger.submit('app.a', { kind: '' })), 'invalid');
assert.equal(await code(ledger.submit('app.a', { kind: 'x', input: 'y'.repeat(70_000) })), 'invalid');
assert.equal(await code(ledger.commit('app.a', j.id, l2.lease, {})), 'invalid');
assert.equal((await ledger.cancel('app.a', j.id)).state, 'cancelled');

// 6. A future `until` at submit sleeps from the start; prune removes only old finished tasks by id.
const s = await ledger.submit('app.a', { kind: 'later', until: clock + 60_000 });
assert.equal(s.state, 'sleeping');
clock += 8 * 24 * 3600_000;
const removed = await ledger.prune('app.a');
assert.equal(removed, 3, 'the done, failed and cancelled tasks go');
assert.equal((await ledger.list('app.a')).length, 1, 'the sleeping task stays');

console.log('durable tasks: idempotent submit, per-app scope, checkpoint across sleep, lease restarts and limit, stale-lease refusal, prune — PASS');
