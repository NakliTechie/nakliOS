// The AI slot limiter, and the reason it exists: the host refuses a 4th pending AI request per app.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSlots } from '../slots.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));

// A stand-in host with the real per-app cap: it refuses a call when 3 are already pending.
function fakeHost(cap) {
  let pending = 0, peak = 0, refused = 0;
  return {
    async call(ms) {
      if (pending >= cap) { refused++; throw new Error('This app already has too many Local AI requests'); }
      pending++; peak = Math.max(peak, pending);
      await new Promise((r) => setTimeout(r, ms));
      pending--; return 'ok';
    },
    get peak() { return peak; }, get refused() { return refused; },
  };
}

// Without slots, a 4-way fan-out loses its fourth call.
{
  const host = fakeHost(3);
  const r = await Promise.allSettled([1, 2, 3, 4].map(() => host.call(5)));
  assert.equal(r.filter((x) => x.status === 'rejected').length, 1, 'the bare fan-out loses one call');
}
// With 3 slots, all 4 land, never more than 3 at once, in arrival order.
{
  const host = fakeHost(3);
  const slots = createSlots(3);
  const order = [];
  const run = async (i) => { const release = await slots.acquire(); try { order.push(i); return await host.call(5); } finally { release(); } };
  const r = await Promise.all([1, 2, 3, 4, 5, 6].map(run));
  assert.deepEqual(r, Array(6).fill('ok'), 'every call lands');
  assert.equal(host.refused, 0, 'the host refuses nothing');
  assert.equal(host.peak, 3, 'at most 3 in flight');
  assert.deepEqual(order, [1, 2, 3, 4, 5, 6], 'waiting calls go in arrival order');
  assert.equal(slots.inFlight, 0); assert.equal(slots.waiting, 0);
}
// An abort while waiting rejects that call and frees its place; release is idempotent.
{
  const slots = createSlots(1);
  const first = await slots.acquire();
  const ac = new AbortController();
  const waiting = slots.acquire(ac.signal);
  const behind = slots.acquire();
  await tick();
  assert.equal(slots.waiting, 2);
  ac.abort();
  await assert.rejects(waiting, /aborted/);
  assert.equal(slots.waiting, 1, 'the aborted call left the line');
  first(); first();
  const second = await behind;
  assert.equal(slots.inFlight, 1, 'a double release frees one slot only');
  second();
  await assert.rejects(slots.acquire(AbortSignal.abort()), /aborted/, 'an already-aborted signal is refused at once');
}
// The slot count matches the host's cap, and Anvil routes every host call through it.
{
  const host = await readFile(new URL('../../../index.html', import.meta.url), 'utf8');
  const anvil = await readFile(new URL('../../../apps/anvil/index.html', import.meta.url), 'utf8');
  const cap = Number((host.match(/const AI_MAX_QUEUE_PER_APP = (\d+);/) || [])[1]);
  const n = Number((anvil.match(/const aiSlots = createSlots\((\d+)\);/) || [])[1]);
  assert.ok(cap > 0 && n === cap, `Anvil's slots (${n}) equal the host's per-app cap (${cap})`);
  assert.match(anvil, /async function inferViaHost\(\{ messages, tools, maxTokens, signal, agentRole \}\)\{\s*const release = await aiSlots\.acquire\(signal\);/, 'every host call takes a slot');
}
console.log('slots: a 4-way fan-out lands all calls under the host cap of 3; aborts leave the line');
