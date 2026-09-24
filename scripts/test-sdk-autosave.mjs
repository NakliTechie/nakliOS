// DUR (2026-09-24): naklios.fs.experimental_autosave — the SDK owns WHEN an app's state is saved.
// Loads the real sdk/naklios.js in a vm with a fake window/document and drives the timing contract:
// a throttled save, an immediate save when the page hides (issued in the same task, never behind an
// in-flight one), the host's beforeclose waiting for it, a close guard only while unsaved, the dirty
// report to the host on transitions only, a failed save staying dirty and retrying.
//   node scripts/test-sdk-autosave.mjs
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../sdk/naklios.js', import.meta.url), 'utf8');
const HOST = 'https://naklios.dev';

function load({ hosted }) {
  const winL = {}; const docL = {}; const sent = [];
  const on = (m) => (t, cb) => { (m[t] ||= []).push(cb); };
  const win = { location: { search: '' }, addEventListener: on(winL), postMessage() {} };
  const parent = { postMessage: (msg) => sent.push(msg) };
  win.parent = hosted ? parent : win;
  win.self = win;
  const doc = { referrer: '', visibilityState: 'visible', addEventListener: on(docL) };
  const ctx = { window: win, self: win, document: doc, setTimeout, clearTimeout, Promise };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  const fire = (m, t, ev = {}) => (m[t] || []).forEach((cb) => cb(ev));
  return {
    nak: win.naklios, sent,
    hide() { doc.visibilityState = 'hidden'; fire(docL, 'visibilitychange'); },
    pagehide() { fire(winL, 'pagehide'); },
    beforeunload() {
      const ev = { prevented: false, returnValue: undefined, preventDefault() { this.prevented = true; } };
      fire(winL, 'beforeunload', ev);
      return ev;
    },
    host(data) { fire(winL, 'message', { source: parent, origin: HOST, data }); },
  };
}

function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tick = () => new Promise((r) => setImmediate(r));

let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.error('FAIL:', n); } };

// 1. The member exists and refuses a missing save.
{
  const { nak } = load({ hosted: false });
  ok('fs.experimental_autosave is a function', typeof nak.fs.experimental_autosave === 'function');
  let threw = false;
  try { nak.fs.experimental_autosave({}); } catch (_) { threw = true; }
  ok('no save → throws', threw);
}

// 2. Throttle: three changes inside the window → ONE save, at most `delay` after the first change.
{
  const { nak } = load({ hosted: false });
  let saves = 0;
  const a = nak.fs.experimental_autosave({ save: () => { saves++; }, delay: 30 });
  ok('clean at start', a.dirty === false);
  a.markDirty(); await sleep(10); a.markDirty(); await sleep(10); a.markDirty();
  ok('dirty after markDirty', a.dirty === true);
  ok('no save before the delay', saves === 0);
  await sleep(25); await tick();
  ok('one save for three changes', saves === 1);
  ok('clean after the save resolved', a.dirty === false);
  a.markDirty();
  await sleep(45); await tick();
  ok('a later change saves again', saves === 2);
}

// 3. Hidden → the save is ISSUED synchronously, inside the event, not after the timer.
{
  const t = load({ hosted: false });
  let saves = 0;
  const a = t.nak.fs.experimental_autosave({ save: () => { saves++; }, delay: 10_000 });
  a.markDirty();
  t.hide();
  ok('visibilitychange→hidden issues the save in the same task', saves === 1);
  await tick();
  ok('clean after the hidden save', a.dirty === false);
  t.pagehide();
  ok('pagehide with nothing unsaved issues nothing', saves === 1);
  a.markDirty();
  t.pagehide();
  ok('pagehide issues the save in the same task', saves === 2);
}

// 4. An urgent save never waits behind an in-flight one; a plain flush does, and never duplicates.
{
  const t = load({ hosted: false });
  const d1 = deferred(); const calls = [];
  const a = t.nak.fs.experimental_autosave({ save: () => { calls.push(calls.length + 1); return calls.length === 1 ? d1.promise : undefined; }, delay: 10_000 });
  a.markDirty();
  const f1 = a.flush(); await tick();
  ok('first save in flight', calls.length === 1);
  const f1b = a.flush();
  ok('flush with no new change does not issue a second save', calls.length === 1);
  a.markDirty();
  t.hide();
  ok('hidden issues save #2 while #1 is still in flight', calls.length === 2);
  d1.resolve(); await f1; await f1b; await tick();
  ok('clean once both landed', a.dirty === false);
}

// 5. The host's beforeclose waits for the autosave before acking.
{
  const t = load({ hosted: true });
  t.host({ type: 'naklios:capabilities', fs: true });
  const d = deferred(); let saves = 0;
  const a = t.nak.fs.experimental_autosave({ save: () => { saves++; return d.promise; }, delay: 10_000 });
  a.markDirty();
  t.host({ type: 'naklios:beforeclose', requestId: 'c1' });
  ok('beforeclose issues the save in the same task', saves === 1);
  await tick(); await tick();
  ok('no ack while the save is running', !t.sent.some((m) => m.type === 'naklios:beforeclose-ready'));
  d.resolve(); await tick(); await tick(); await tick();
  ok('ack after the save landed', t.sent.some((m) => m.type === 'naklios:beforeclose-ready' && m.requestId === 'c1'));
}

// 6. The dirty report reaches the host on transitions only.
{
  const t = load({ hosted: true });
  t.host({ type: 'naklios:capabilities', fs: true });
  const a = t.nak.fs.experimental_autosave({ save: () => {}, delay: 10_000 });
  const b = t.nak.fs.experimental_autosave({ save: () => {}, delay: 10_000 });
  const dirty = () => t.sent.filter((m) => m.type === 'naklios:fs:dirty').map((m) => m.dirty);
  a.markDirty(); a.markDirty(); b.markDirty();
  ok('one true report for three changes across two savers', JSON.stringify(dirty()) === '[true]');
  await a.flush();
  ok('still dirty while b is unsaved', JSON.stringify(dirty()) === '[true]');
  await b.flush();
  ok('false once every saver is clean', JSON.stringify(dirty()) === '[true,false]');
  b.markDirty(); b.dispose();
  ok('dispose withdraws the saver from the report', JSON.stringify(dirty()) === '[true,false,true,false]');
}

// 7. The close guard: standalone only, and only while unsaved.
{
  const t = load({ hosted: false });
  let saves = 0;
  const a = t.nak.fs.experimental_autosave({ save: () => { saves++; }, delay: 10_000 });
  ok('clean → no prompt', t.beforeunload().prevented === false);
  a.markDirty();
  const ev = t.beforeunload();
  ok('unsaved → prompt', ev.prevented === true && ev.returnValue === '');
  ok('beforeunload still starts the save', saves === 1);
  const h = load({ hosted: true });
  const b = h.nak.fs.experimental_autosave({ save: () => new Promise(() => {}), delay: 10_000 });
  b.markDirty();
  ok('hosted → the frame never prompts (the host guards)', h.beforeunload().prevented === false);
}

// 8. A failed save stays dirty, reports the error, and the next flush retries.
{
  const { nak } = load({ hosted: false });
  const errors = []; let n = 0;
  const a = nak.fs.experimental_autosave({ save: () => { n++; if (n === 1) throw new Error('disk full'); }, onError: (e) => errors.push(e.message), delay: 10_000 });
  a.markDirty();
  let rejected = false;
  try { await a.flush(); } catch (_) { rejected = true; }
  ok('flush rejects on a failed save', rejected);
  ok('onError told', errors.join() === 'disk full');
  ok('still dirty after the failure', a.dirty === true);
  await a.flush();
  ok('the next flush retries and lands', n === 2 && a.dirty === false);
}

// 9. dispose stops the pending timer.
{
  const { nak } = load({ hosted: false });
  let saves = 0;
  const a = nak.fs.experimental_autosave({ save: () => { saves++; }, delay: 15 });
  a.markDirty(); a.dispose();
  await sleep(30);
  ok('no save after dispose', saves === 0);
  a.markDirty();
  await sleep(30);
  ok('markDirty after dispose schedules nothing', saves === 0);
}

console.log(`sdk-autosave: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
