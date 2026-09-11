// Conformance — the incremental fold driver (projection.mjs).
//   node sys/history/test/projection.test.mjs
//
// The contract is a single equivalence, and it is checked against REAL recorded
// runs rather than a fixture: for every prefix of every corpus record, feeding the
// events to a projector one at a time must produce exactly what folding the whole
// prefix in one shot produces. The one-shot fold is the oracle — it is the fold
// Anvil shipped, and every other test in this repo already pins its output.
//
// The second contract is the change signal. `changed: false` must mean no applied
// event touched this unit, because a caller is entitled to skip a repaint on it.
// A FALSE unchanged is the bug this test exists to catch; a false CHANGED only
// costs a redraw, so the assertions are one-sided in exactly that direction.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  loadRecord, createProjector, runUnit,
  logUnit, statusUnit, transcriptUnit,
  foldLog, foldStatus, foldTranscript,
} from '../run-record.mjs';

const CORPUS = join(dirname(fileURLToPath(import.meta.url)), '..', 'corpus');
let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${a} !== ${b}`); }
const same = (a, b, m) => { const x = JSON.stringify(a), y = JSON.stringify(b); if (x !== y) throw new Error(`${m}\n  incremental: ${x}\n  one-shot   : ${y}`); };

const entries = existsSync(CORPUS)
  ? readdirSync(CORPUS).filter((f) => f.endsWith('.json') && !f.endsWith('.override.json') && !f.endsWith('.opts.json'))
  : [];
const load = (f) => loadRecord(JSON.parse(readFileSync(join(CORPUS, f), 'utf8')));

const UNITS = [
  ['log', () => logUnit(), (ev, rs) => foldLog(ev, rs)],
  ['status', () => statusUnit({ gated: true }), (ev, rs) => foldStatus(ev, rs, { gated: true })],
  ['status/ungated', () => statusUnit(), (ev, rs) => foldStatus(ev, rs)],
  ['transcript', () => transcriptUnit(), (ev, rs) => foldTranscript(ev, rs)],
  ['surface', () => transcriptUnit({ applyCompaction: true }), (ev, rs) => foldTranscript(ev, rs, { applyCompaction: true })],
];

await test('the corpus is present — an empty lane proves nothing', () => {
  assert(entries.length >= 3, `${entries.length} corpus entries in ${CORPUS}`);
});

// ── the equivalence, over every prefix of every real run ──────────────────
for (const [name, mk, oneShot] of UNITS) {
  await test(`${name}: every prefix of every recorded run folds the same incrementally`, () => {
    let prefixes = 0;
    for (const f of entries) {
      const rec = load(f);
      const all = rec.events();
      const proj = createProjector(mk());
      for (let n = 0; n <= all.length; n++) {
        const prefix = all.slice(0, n);              // a fresh array each time, as a caller's would be
        const got = proj.advance(prefix, rec.resolve);
        same(got.value, oneShot(prefix, rec.resolve), `${f} @ ${n} events: ${name} diverged`);
        eq(got.consumed, n, `${f} @ ${n}: consumed`);
        prefixes++;
      }
    }
    assert(prefixes > 100, `only ${prefixes} prefixes checked; the corpus cannot be this small`);
  });
}

// ── the change signal is one-sided-safe ───────────────────────────────────
await test('changed:false never hides a change', () => {
  for (const f of entries) {
    const rec = load(f);
    const all = rec.events();
    for (const [name, mk, oneShot] of UNITS) {
      const proj = createProjector(mk());
      let lastSeen = JSON.stringify(oneShot([], rec.resolve));
      for (let n = 1; n <= all.length; n++) {
        const got = proj.advance(all.slice(0, n), rec.resolve);
        const now = JSON.stringify(got.value);
        if (!got.changed) assert(now === lastSeen, `${f} @ ${n}: ${name} reported unchanged but the value moved`);
        lastSeen = now;
      }
    }
  }
});

await test('an event no unit cares about reports unchanged', () => {
  // `turn.started` is in the log's switch by omission only: it is the one verb the
  // status unit counts and the log unit ignores, so it separates the two signals.
  const rec = load(entries[0]);
  const all = rec.events();
  const at = all.findIndex((e) => e.tool === 'turn.started');
  assert(at >= 0, 'the corpus has no turn.started event to test with');
  const log = createProjector(logUnit());
  const status = createProjector(statusUnit());
  log.advance(all.slice(0, at), rec.resolve);
  status.advance(all.slice(0, at), rec.resolve);
  eq(log.advance(all.slice(0, at + 1), rec.resolve).changed, false, 'the log unit claimed a turn.started changed it');
  eq(status.advance(all.slice(0, at + 1), rec.resolve).changed, true, 'the status unit missed a turn.started');
});

// ── the extension check: a wrong answer must not be reachable ─────────────
await test('a shortened log rebuilds instead of continuing', () => {
  const rec = load(entries[0]);
  const all = rec.events();
  const proj = createProjector(logUnit());
  proj.advance(all, rec.resolve);
  const half = all.slice(0, Math.floor(all.length / 2));
  const got = proj.advance(half, rec.resolve);
  eq(got.rebuilt, true, 'a shorter array did not force a rebuild');
  same(got.value, foldLog(half, rec.resolve), 'a shortened log folded wrong');
});

await test('a different record rebuilds instead of continuing', () => {
  assert(entries.length >= 2, 'need two corpus entries');
  const a = load(entries[0]), b = load(entries[1]);
  const proj = createProjector(logUnit());
  proj.advance(a.events(), a.resolve);
  const bEv = b.events();
  const got = proj.advance(bEv, b.resolve);
  same(got.value, foldLog(bEv, b.resolve), 'a swapped record folded wrong');
});

await test('a rewritten prefix of the same length rebuilds', () => {
  const rec = load(entries[0]);
  const all = rec.events();
  const proj = createProjector(logUnit());
  proj.advance(all, rec.resolve);
  // Same length, different events: the identity witness must catch it.
  const forged = all.slice(0, all.length - 1).concat([{ ...all[all.length - 1] }]);
  const got = proj.advance(forged, rec.resolve);
  eq(got.rebuilt, true, 'a rewritten last event did not force a rebuild');
  same(got.value, foldLog(forged, rec.resolve), 'a rewritten prefix folded wrong');
});

// ── C2+C3 (N5): durable checkpoints ────────────────────────────────────────
// A store that remembers one checkpoint; `fail` makes load or save throw; `corrupt` swaps the
// stored value for something broken.
function memStore(initial = null) {
  const s = { cp: initial, loads: 0, saves: 0, failLoad: false, failSave: false };
  s.load = async () => { s.loads++; if (s.failLoad) throw new Error('disk gone'); return s.cp; };
  s.save = async (cp) => { s.saves++; if (s.failSave) throw new Error('quota'); s.cp = JSON.parse(JSON.stringify(cp)); };
  return s;
}

for (const [name, mk, oneShot] of UNITS) {
  await test(`${name}: a checkpoint restored mid-run folds identically to one built from scratch, over every corpus run`, async () => {
    let checked = 0;
    for (const f of entries) {
      const rec = load(f);
      const all = rec.events();
      for (const cut of [1, Math.floor(all.length / 3), Math.floor(all.length / 2), all.length - 1, all.length]) {
        if (cut < 1 || cut > all.length) continue;
        // session 1: fold to `cut`, checkpoint, and forget everything
        const store = memStore();
        const first = createProjector(mk(), { checkpoint: store });
        first.advance(all.slice(0, cut), rec.resolve);
        const saved = await first.checkpoint();
        eq(saved.saved, true, `${f}@${cut}: ${name} saved (${saved.reason})`);
        eq(store.saves, 1);
        assert(JSON.stringify(store.cp).length > 0 && store.cp.consumed === cut, 'the checkpoint is plain JSON and knows how far it got');
        // session 2: a NEW projector over a NEW array (no shared identity), restored from the store
        const second = createProjector(mk(), { checkpoint: store });
        const r = await second.restore();
        eq(r.restored, true, `${f}@${cut}: ${name} restored (${r.reason})`);
        eq(second.consumed, cut, 'it resumes where the checkpoint stopped');
        const fresh = rec.events(); // loadRecord hands out a fresh slice: same objects, but the restored projector never saw them
        let applied = 0;
        const counting = mk(); const inner = counting.apply; counting.apply = (s, e) => { applied++; return inner(s, e); };
        const counted = createProjector(counting, { checkpoint: store });
        await counted.restore();
        const got = counted.advance(fresh, rec.resolve);
        eq(got.rebuilt, false, `${f}@${cut}: ${name} continued from the checkpoint, no rebuild`);
        eq(applied, all.length - cut, `${f}@${cut}: ${name} applied only the tail`);
        same(got.value, oneShot(fresh, rec.resolve), `${f}@${cut}: ${name} restored fold diverged from scratch`);
        // and the plain restored projector, advanced, agrees too (the counting one proved the path)
        same(second.advance(fresh, rec.resolve).value, oneShot(fresh, rec.resolve), `${f}@${cut}: ${name} (plain) diverged`);
        checked++;
      }
    }
    assert(checked >= 20, `only ${checked} checkpoints checked`);
  });
}

await test('a stateVersion bump discards the checkpoint rather than reusing it', async () => {
  const rec = load(entries[0]);
  const all = rec.events();
  const store = memStore();
  const v1 = createProjector(logUnit(), { checkpoint: store });
  v1.advance(all.slice(0, 5), rec.resolve);
  await v1.checkpoint();
  eq(store.cp.stateVersion, 1);
  const bumped = { ...logUnit(), version: 2 };
  const v2 = createProjector(bumped, { checkpoint: store });
  const r = await v2.restore();
  eq(r.restored, false, 'a version-1 checkpoint is not installed into a version-2 unit');
  assert(/stateVersion 1 is not the unit's 2/.test(r.reason), `says why: ${r.reason}`);
  const typed = createProjector(logUnit(), { checkpoint: memStore({ ...store.cp, stateVersion: '1' }) });
  assert(/stateVersion "1" is not the unit's 1/.test((await typed.restore()).reason), 'a string version is named as a string');
  eq(v2.consumed, 0, 'the projector is untouched');
  same(v2.advance(all, rec.resolve).value, foldLog(all, rec.resolve), 'and folds from scratch, correctly');
});

await test('a corrupt or foreign checkpoint is ignored, not thrown', async () => {
  const rec = load(entries[0]);
  const all = rec.events();
  const good = memStore();
  const p0 = createProjector(transcriptUnit(), { checkpoint: good });
  p0.advance(all.slice(0, 4), rec.resolve);
  await p0.checkpoint();
  const cases = [
    ['garbage string', 'not an object'],
    ['no state', { stateVersion: 1, consumed: 3, witness: 'x' }],
    ['negative consumed', { ...good.cp, consumed: -1 }],
    ['missing witness', { ...good.cp, witness: undefined }],
    ['state of the wrong shape', { ...good.cp, state: { out: 'nope', pendingCalls: null, started: 0 } }],
    ['state with a bad message', { ...good.cp, state: { out: [{ nope: 1 }], pendingCalls: null, started: 0 } }],
    ['a log unit\'s state in a transcript checkpoint', { ...good.cp, state: { rows: [], open: [] } }],
    ['a string stateVersion', { ...good.cp, stateVersion: '1' }],
  ];
  for (const [label, cp] of cases) {
    const store = memStore(cp);
    const p = createProjector(transcriptUnit(), { checkpoint: store });
    const r = await p.restore();
    eq(r.restored, false, `${label}: not restored`);
    assert(typeof r.reason === 'string' && r.reason.length > 0, `${label}: has a reason`);
    eq(p.consumed, 0, `${label}: untouched`);
    same(p.advance(all, rec.resolve).value, foldTranscript(all, rec.resolve), `${label}: still folds correctly`);
  }
  // a log checkpoint whose open index points at a row that is not a tool row is rejected
  {
    const ls = memStore();
    const lp = createProjector(logUnit(), { checkpoint: ls });
    lp.advance(all.slice(0, 3), rec.resolve);
    await lp.checkpoint();
    const forged = { ...ls.cp, state: { ...ls.cp.state, open: [['x', 0]] } }; // row 0 is the user prompt
    const lq = createProjector(logUnit(), { checkpoint: memStore(forged) });
    const lr = await lq.restore();
    eq(lr.restored, false, 'an open index onto a non-tool row is rejected');
    assert(/rejected the state shape/.test(lr.reason), lr.reason);
  }
  // a checkpoint from a DIFFERENT record: the witness does not match → rebuild, right answer
  const other = load(entries[1]);
  const p = createProjector(transcriptUnit(), { checkpoint: good });
  eq((await p.restore()).restored, true);
  const got = p.advance(other.events(), other.resolve);
  eq(got.rebuilt, true, 'a checkpoint of another record forces a rebuild');
  same(got.value, foldTranscript(other.events(), other.resolve), 'and the answer is the scratch fold');
  // a checkpoint of a longer prefix than the array it meets → rebuild
  const shortStore = memStore(good.cp);
  const ps = createProjector(transcriptUnit(), { checkpoint: shortStore });
  eq((await ps.restore()).restored, true);
  const gs = ps.advance(all.slice(0, 2), rec.resolve);
  eq(gs.rebuilt, true, 'a checkpoint past the end of the array forces a rebuild');
  same(gs.value, foldTranscript(all.slice(0, 2), rec.resolve));
});

await test('every durable write and read is fail-soft', async () => {
  const rec = load(entries[0]);
  const all = rec.events();
  const store = memStore();
  const p = createProjector(statusUnit({ gated: true }), { checkpoint: store });
  p.advance(all, rec.resolve);
  store.failSave = true;
  const s = await p.checkpoint();
  eq(s.saved, false); assert(/save failed: quota/.test(s.reason), s.reason);
  same(p.advance(all, rec.resolve).value, foldStatus(all, rec.resolve, { gated: true }), 'a failed save changes nothing');
  store.failSave = false; await p.checkpoint();
  store.failLoad = true;
  const q = createProjector(statusUnit({ gated: true }), { checkpoint: store });
  const r = await q.restore();
  eq(r.restored, false); assert(/load failed: disk gone/.test(r.reason), r.reason);
  same(q.advance(all, rec.resolve).value, foldStatus(all, rec.resolve, { gated: true }), 'a failed load folds from scratch');
  // no store at all, and a unit without snapshot/restore: both report, neither throws
  const none = createProjector(statusUnit());
  eq((await none.restore()).restored, false); eq((await none.checkpoint()).saved, false);
  const bare = createProjector({ init: () => 0, apply: (s) => s }, { checkpoint: memStore() });
  assert(/no snapshot\/restore/.test((await bare.checkpoint()).reason));
  assert(/no snapshot\/restore/.test((await bare.restore()).reason));
});

await test('the log unit\'s restored rows are still patched in place by a later result', async () => {
  // `open` re-links to the restored row objects; a tool.responded after the restore must land on
  // the row a tool.called before the checkpoint created.
  for (const f of entries) {
    const rec = load(f);
    const all = rec.events();
    const idx = all.findIndex((e) => e.tool === 'tool.called');
    if (idx < 0) continue;
    const store = memStore();
    const a = createProjector(logUnit(), { checkpoint: store });
    a.advance(all.slice(0, idx + 1), rec.resolve); // the call is open
    await a.checkpoint();
    const b = createProjector(logUnit(), { checkpoint: store });
    await b.restore();
    const rows = b.advance(all, rec.resolve).value;
    same(rows, foldLog(all, rec.resolve), `${f}: an open call restored from a checkpoint still received its result`);
    return;
  }
  throw new Error('no corpus entry has a tool call');
});

// ── and it must actually do less work ─────────────────────────────────────
await test('advancing one event applies one event, not the whole log', () => {
  const rec = load(entries[0]);
  const all = rec.events();
  let applied = 0;
  const counting = { ...logUnit() };
  const inner = counting.apply;
  counting.apply = (s, e) => { applied++; return inner(s, e); };
  const proj = createProjector(counting);
  proj.advance(all.slice(0, all.length - 1), rec.resolve);
  const before = applied;
  proj.advance(all, rec.resolve);
  eq(applied - before, 1, 'the last advance re-walked the log instead of continuing');
});

console.log(`projection conformance: ${passed}/${passed + failures.length} passed (${entries.length} recorded runs, every prefix)`);
for (const f of failures) console.log(`  FAIL ${f.n}: ${f.message}`);
if (failures.length) process.exit(1);
