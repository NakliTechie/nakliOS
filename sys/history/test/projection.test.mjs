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
