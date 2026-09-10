import assert from 'node:assert/strict';
import { judgeLesson, fisherHarmP, worstCaseDrop, rejectionRecord, MIN_REPS_PER_ARM } from '../lesson-gate.mjs';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log(`  ok    ${name}`); };

console.log('lesson-gate:');

// ── the exact test ────────────────────────────────────────────────────────────
t('fisherHarmP is far from significant when the arms are identical', () => {
  // It is a CUMULATIVE P(X <= observed), so identical arms sit near the middle of the
  // distribution (~0.67 here) rather than at 1. What matters is that it is nowhere near alpha.
  const p = fisherHarmP({ withDone: 5, withN: 10, withoutDone: 5, withoutN: 10 });
  assert.ok(p > 0.5, `identical arms must not read as harm, got ${p}`);
});
t('fisherHarmP is small when the lesson arm collapses', () => {
  assert.ok(fisherHarmP({ withDone: 0, withN: 9, withoutDone: 9, withoutN: 9 }) < 0.001);
});
t('fisherHarmP is NOT small when the lesson arm WINS (it is one-sided, on harm)', () => {
  assert.ok(fisherHarmP({ withDone: 9, withN: 9, withoutDone: 0, withoutN: 9 }) > 0.99);
});
t('fisherHarmP matches the hand-computable 5/5 vs 0/5 case', () => {
  // Only one table is as or more extreme; C(5,0)*C(5,5)/C(10,5) = 1/252.
  const p = fisherHarmP({ withDone: 0, withN: 5, withoutDone: 5, withoutN: 5 });
  assert.ok(Math.abs(p - 1 / 252) < 1e-9, `expected 1/252, got ${p}`);
});

// ── the honesty number ────────────────────────────────────────────────────────
t('worstCaseDrop admits it cannot rule out a large regression at small n', () => {
  const d = worstCaseDrop({ withDone: 5, withN: 5, withoutDone: 5, withoutN: 5 });
  assert.equal(d.observed, 0, 'nothing was observed to fall');
  assert.ok(d.notRuledOut >= 0.3, `a tiny matrix must confess its blindness, got ${d.notRuledOut}`);
});
t('worstCaseDrop shrinks as n grows (more reps, less room to hide)', () => {
  const small = worstCaseDrop({ withDone: 5, withN: 5, withoutDone: 5, withoutN: 5 }).notRuledOut;
  const big = worstCaseDrop({ withDone: 40, withN: 40, withoutDone: 40, withoutN: 40 }).notRuledOut;
  assert.ok(big < small, `expected the bound to tighten, got ${big} vs ${small}`);
});

// ── the verdicts ──────────────────────────────────────────────────────────────
t('a collapsing lesson is HARMED and is not admitted', () => {
  const v = judgeLesson({ withDone: 0, withN: 9, withoutDone: 8, withoutN: 9 });
  assert.equal(v.verdict, 'harmed'); assert.equal(v.admit, false);
});
t('an equal lesson is ADMITTED — the bar is non-inferiority, not improvement', () => {
  const v = judgeLesson({ withDone: 6, withN: 9, withoutDone: 6, withoutN: 9 });
  assert.equal(v.verdict, 'admitted'); assert.equal(v.admit, true);
});
t('a helping lesson is admitted', () => {
  const v = judgeLesson({ withDone: 9, withN: 9, withoutDone: 2, withoutN: 9 });
  assert.equal(v.admit, true);
});
t('an admitted verdict STATES the regression it could not have seen', () => {
  const v = judgeLesson({ withDone: 5, withN: 5, withoutDone: 5, withoutN: 5 });
  assert.equal(v.admit, true);
  assert.ok(v.drop.notRuledOut > 0, 'an admission with no stated blindness is the failure mode');
  assert.match(v.reason, /not ruled out/);
});

// ── the guard that stops the gate being theatre ────────────────────────────────
t('below MIN_REPS_PER_ARM the verdict is UNPOWERED, and unpowered does not admit', () => {
  const v = judgeLesson({ withDone: 3, withN: 3, withoutDone: 0, withoutN: 3 });
  assert.equal(v.verdict, 'unpowered');
  assert.equal(v.admit, false, 'unpowered must never be an admission');
});
t('a total collapse at the minimum n DOES reach significance (the constant is not arbitrary)', () => {
  const v = judgeLesson({ withDone: 0, withN: MIN_REPS_PER_ARM, withoutDone: MIN_REPS_PER_ARM, withoutN: MIN_REPS_PER_ARM });
  assert.equal(v.verdict, 'harmed', `${MIN_REPS_PER_ARM} reps must be enough to see a wipeout`);
});
t('one rep below the minimum, the same wipeout cannot be seen', () => {
  const v = judgeLesson({ withDone: 0, withN: MIN_REPS_PER_ARM - 1, withoutDone: MIN_REPS_PER_ARM - 1, withoutN: MIN_REPS_PER_ARM - 1 });
  assert.equal(v.verdict, 'unpowered');
});
// Pinned with LITERALS, not with the constant: the two tests above are satisfied by any value the
// constant happens to hold, so on their own they let it drift. These say what the floor must BE.
t('the floor is 4 — derived from the wipeout p, not chosen', () => {
  assert.equal(MIN_REPS_PER_ARM, 4);
  assert.ok(fisherHarmP({ withDone: 0, withN: 4, withoutDone: 4, withoutN: 4 }) < 0.02,
    'n=4 must clear alpha with real margin');
  const atThree = fisherHarmP({ withDone: 0, withN: 3, withoutDone: 3, withoutN: 3 });
  assert.ok(Math.abs(atThree - 0.05) < 1e-9,
    'n=3 sits exactly ON alpha, so its verdict would turn on float noise — that is why it is excluded');
});
t('harm is judged ONE-sided at alpha, not two-sided', () => {
  // p = 0.0283 here: harmful at a one-sided 0.05, invisible at 0.025. Without a case in that band
  // a two-sided test passes every other assertion in this file.
  const v = judgeLesson({ withDone: 2, withN: 9, withoutDone: 7, withoutN: 9 });
  assert.ok(v.harmP > 0.025 && v.harmP < 0.05, `need a case in the alpha band, got ${v.harmP}`);
  assert.equal(v.verdict, 'harmed');
});

// ── input hygiene ─────────────────────────────────────────────────────────────
t('nonsense counts are refused, not judged', () => {
  assert.equal(judgeLesson({ withDone: 9, withN: 5, withoutDone: 1, withoutN: 5 }).verdict, 'invalid');
  assert.equal(judgeLesson({ withDone: -1, withN: 5, withoutDone: 1, withoutN: 5 }).verdict, 'invalid');
  assert.equal(judgeLesson({}).verdict, 'invalid');
});
t('every non-admitting verdict carries admit:false', () => {
  for (const args of [{ withDone: 9, withN: 5, withoutDone: 1, withoutN: 5 }, { withDone: 0, withN: 2, withoutDone: 2, withoutN: 2 },
    { withDone: 0, withN: 9, withoutDone: 9, withoutN: 9 }]) {
    assert.equal(judgeLesson(args).admit, false);
  }
});

// ── negative evidence ─────────────────────────────────────────────────────────
t('a rejection is recorded as negative evidence, carrying why', () => {
  const v = judgeLesson({ withDone: 0, withN: 9, withoutDone: 9, withoutN: 9 });
  const r = rejectionRecord({ fingerprint: 'sha256:abc', verdict: v, now: 42 });
  assert.equal(r.fp, 'sha256:abc'); assert.equal(r.verdict, 'harmed');
  assert.equal(r.at, 42); assert.ok(r.why.length > 0);
});

// ── the module must stay replayable: no clock, no I/O, no hidden state ─────────
t('judgeLesson is pure — same input, same verdict, and no module-level mutation', () => {
  const args = { withDone: 4, withN: 9, withoutDone: 6, withoutN: 9 };
  const a = judgeLesson(args), b = judgeLesson(args);
  assert.deepEqual(a, b);
  const src = String(judgeLesson);
  assert.ok(!/Date\.now\(\)/.test(src), 'a verdict that depends on the clock cannot be replayed');
});

console.log(`\n${n} assertions passed`);
