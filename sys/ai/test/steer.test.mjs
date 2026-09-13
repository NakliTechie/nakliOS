// Conformance — the steer queue (CRIB-B B2): completions land at the next turn, in order, and a
// waiting loop wakes on a push, on the last in-flight child settling, on abort, or on a timeout.
//   node sys/ai/test/steer.test.mjs
import { createSteerQueue } from '../steer.mjs';

let passed = 0; const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e && e.message || String(e) }); } }
const eq = (a, b, m = '') => { if (a !== b) throw new Error(`${m} — ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); };
const assert = (c, m) => { if (!c) throw new Error(m || 'assertion failed'); };
const tick = () => new Promise((r) => setTimeout(r, 0));
const raced = (p, ms) => Promise.race([p.then(() => 'resolved'), new Promise((r) => setTimeout(() => r('pending'), ms))]);

await test('push / take is FIFO and take empties the queue', () => {
  const q = createSteerQueue();
  eq(q.size(), 0); eq(q.take().length, 0, 'empty take');
  q.push({ content: 'a' }); q.push({ content: 'b' });
  eq(q.size(), 2);
  eq(q.take().map((m) => m.content).join(','), 'a,b', 'in push order');
  eq(q.size(), 0); eq(q.take().length, 0, 'taken once');
});

await test('next resolves at once when something is pending, when nothing is in flight, or when already aborted', async () => {
  const q = createSteerQueue();
  eq(await raced(q.next(), 20), 'resolved', 'nothing in flight → nothing to wait for');
  q.track(new Promise(() => {}));
  q.push({ content: 'x' });
  eq(await raced(q.next(), 20), 'resolved', 'a pending steer → deliver it now');
  q.take();
  const ac = new AbortController(); ac.abort();
  eq(await raced(q.next({ signal: ac.signal }), 20), 'resolved', 'already aborted → do not wait');
});

await test('next waits while a child is in flight and wakes on a push', async () => {
  const q = createSteerQueue();
  let resolveChild; q.track(new Promise((r) => { resolveChild = r; }));
  eq(q.inFlight(), 1);
  const w = q.next();
  eq(await raced(w, 20), 'pending', 'waiting');
  q.push({ content: 'child done' });
  eq(await raced(w, 20), 'resolved', 'woken by the push');
  eq(q.take()[0].content, 'child done');
  resolveChild(); await tick(); eq(q.inFlight(), 0);
});

await test('next wakes when the last in-flight child settles — resolved or rejected — with nothing pushed', async () => {
  const q = createSteerQueue();
  let a, b; q.track(new Promise((r) => { a = r; })); q.track(new Promise((_, j) => { b = j; }).catch(() => {}));
  eq(q.inFlight(), 2);
  const w = q.next();
  a(); await tick(); eq(q.inFlight(), 1);
  eq(await raced(w, 20), 'pending', 'one still in flight — keep waiting');
  b(new Error('boom')); await tick(); await tick(); eq(q.inFlight(), 0);
  eq(await raced(w, 20), 'resolved', 'the last one settling wakes the waiter (a rejection counts)');
  eq(q.take().length, 0, 'and nothing was pushed');
});

await test('next wakes on abort and on the timeout', async () => {
  const q = createSteerQueue();
  q.track(new Promise(() => {}));
  const ac = new AbortController();
  const w = q.next({ signal: ac.signal });
  eq(await raced(w, 20), 'pending');
  ac.abort();
  eq(await raced(w, 20), 'resolved', 'abort wakes it');
  const t0 = Date.now();
  await q.next({ timeoutMs: 30 });
  assert(Date.now() - t0 >= 25, 'the timeout wakes it');
  eq(await raced(q.next({ timeoutMs: 0 }), 20), 'resolved', 'a zero timeout is a poll');
});

await test('track returns the promise it was given and never swallows its value', async () => {
  const q = createSteerQueue();
  const v = await q.track(Promise.resolve(42));
  eq(v, 42);
  let threw = false; try { await q.track(Promise.reject(new Error('x'))); } catch (_) { threw = true; }
  assert(threw, 'a rejection still rejects for the caller');
  await tick(); eq(q.inFlight(), 0);
});

if (failures.length) {
  console.error(`steer: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`steer: ${passed}/${passed} passed — the queue delivers in order and wakes a waiting loop on push, settle, abort, timeout`);
