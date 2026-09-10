// AC-9, the replay-validated half: does a written lesson EARN its place?
//
// MAX_REMEMBER_PER_RUN plus Jaccard dedup (sys/ai/memory-store.mjs) is volume hygiene — it stops
// the agent writing the same thing five times. Nothing checks that a write makes later runs
// better, or even that it does not make them worse. This is that check.
//
// PG's rule, and the one adopted here: commit only when held-out validation DOES NOT FALL. Not
// "improves" — non-inferiority is a far cheaper bar than superiority, and the thing we actually
// fear from a bad lesson is harm, not a missed gain.
//
// THE FAILURE MODE THIS MODULE EXISTS TO AVOID. At the n a real gate can afford, "did not fall" is
// nearly always satisfiable: with 3 reps an arm can lose two thirds of its completions and still
// clear a naive test. A gate like that admits everything and reports a verdict, which is worse than
// no gate, because it launders a guess as a check. So every verdict here carries `worstCaseDrop` —
// the largest true regression still consistent with what was observed — and `unpowered` is a real
// verdict, not an error. AC-2 is the cautionary case in this repo: the same comparison read
// "significant" at one n, reversed at another, and was a rate limit at a third.
//
// Pure arithmetic. No model, no I/O — the caller runs the arms (sys/ai/ablate.mjs) and brings
// counts. That keeps the decision testable without a provider and keeps this file replayable.

// Exact one-sided Fisher for "with-lesson finished FEWER than without-lesson", i.e. evidence of
// harm. Conditional on the margins, hypergeometric in the usual way.
function lchoose(n, k) {
  if (k < 0 || k > n) return -Infinity;
  return lgamma(n + 1) - lgamma(k + 1) - lgamma(n - k + 1);
}
// Lanczos; enough precision for the counts a gate deals in.
function lgamma(z) {
  const g = [676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
  z -= 1; let x = 0.99999999999980993;
  for (let i = 0; i < g.length; i++) x += g[i] / (z + i + 1);
  const t = z + g.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

// P(with-arm successes <= a) given both margins fixed. `a` successes out of nWith, `c` out of
// nWithout; total successes s = a + c.
export function fisherHarmP({ withDone, withN, withoutDone, withoutN }) {
  const s = withDone + withoutDone, n = withN + withoutN;
  const denom = lchoose(n, s);
  let p = 0;
  for (let i = Math.max(0, s - withoutN); i <= withDone; i++) {
    p += Math.exp(lchoose(withN, i) + lchoose(withoutN, s - i) - denom);
  }
  return Math.min(1, p);
}

// The number that keeps this honest. Scan candidate true drops and return the largest one that the
// observed counts CANNOT rule out at `alpha`. A gate reporting admitted with worstCaseDrop 0.66 is
// telling the caller it would not have noticed a two-thirds regression.
export function worstCaseDrop({ withDone, withN, withoutDone, withoutN, alpha = 0.05 }) {
  const pw = withDone / withN, pwo = withoutDone / withoutN;
  const observed = Math.max(0, pwo - pw);
  // Binomial tail: with a true rate of (pwo - d) in the with-arm, how surprising is withDone?
  let hi = 0;
  for (let d = 0; d <= 1.0001; d += 0.01) {
    const pTrue = Math.min(1, Math.max(0, pwo - d));
    // P(observe >= withDone | true rate pTrue). If that is not small, a drop of d survives.
    let tail = 0;
    for (let k = withDone; k <= withN; k++) {
      tail += Math.exp(lchoose(withN, k) + k * Math.log(pTrue || 1e-12) + (withN - k) * Math.log(1 - pTrue || 1e-12));
    }
    if (tail >= alpha) hi = d;
  }
  return { observed: Math.round(observed * 100) / 100, notRuledOut: Math.round(hi * 100) / 100 };
}

// Below this many reps per arm the gate cannot see even a total collapse, so it must not pretend to
// judge. The floor is derived, not chosen: for a total wipeout (0/n against n/n) the exact
// one-sided p is 1/C(2n,n) — n=2 gives 0.167, n=3 gives EXACTLY 0.05, n=4 gives 0.0143.
//
// n=3 is rejected even though it nominally clears the bar: 0.05 is not < 0.05, so the verdict
// there is decided by whether the lgamma round-trip lands a hair under or over. A threshold that
// depends on floating-point noise is not a threshold. n=4 is the smallest floor with margin.
// (Set to 5 first, with a comment asserting 5 was the minimum. It was not — a mutation test that
// lowered the constant survived, which is how the wrong number was found.)
export const MIN_REPS_PER_ARM = 4;

// The verdict. `harmed` rejects the lesson; `admitted` means no evidence of harm AT THE STATED
// POWER; `unpowered` means the matrix was too small to judge and is NOT an admission.
export function judgeLesson({ withDone, withN, withoutDone, withoutN, alpha = 0.05, minReps = MIN_REPS_PER_ARM } = {}) {
  for (const [k, v] of Object.entries({ withDone, withN, withoutDone, withoutN })) {
    if (!Number.isInteger(v) || v < 0) return { verdict: 'invalid', reason: `${k} must be a non-negative integer`, admit: false };
  }
  if (withDone > withN || withoutDone > withoutN) return { verdict: 'invalid', reason: 'completions exceed reps', admit: false };
  if (withN < minReps || withoutN < minReps) {
    return {
      verdict: 'unpowered', admit: false,
      reason: `${Math.min(withN, withoutN)} rep(s) per arm is below ${minReps}; a total collapse would not reach significance`,
      harmP: null, drop: null,
    };
  }
  const harmP = fisherHarmP({ withDone, withN, withoutDone, withoutN });
  const drop = worstCaseDrop({ withDone, withN, withoutDone, withoutN, alpha });
  if (harmP < alpha) {
    return { verdict: 'harmed', admit: false, harmP, drop,
      reason: `with-lesson finished ${withDone}/${withN} against ${withoutDone}/${withoutN} without (one-sided p=${harmP.toFixed(3)})` };
  }
  // What it would have taken to see a HALVING of the observed baseline. Reported on every
  // admission because "no evidence of harm" at an n that could not have found any is not a finding.
  const base = withoutDone / withoutN;
  const needed = repsForPower({ baseRate: base, drop: base / 2, alpha });
  return { verdict: 'admitted', admit: true, harmP, drop, repsUsed: Math.min(withN, withoutN), repsForHalving: needed,
    reason: `no evidence of harm (p=${harmP.toFixed(3)}); a true regression up to ${(drop.notRuledOut * 100).toFixed(0)}% is not ruled out at this n`
      + (needed ? `; seeing the baseline halve would take ${needed} reps/arm against the ${Math.min(withN, withoutN)} used` : '') };
}

// How many reps per arm would it take to SEE a drop of `drop` from `baseRate`? Exact power for the
// one-sided Fisher used above — no simulation, so the answer is stable across calls.
//
// This exists because MIN_REPS_PER_ARM is a floor for seeing a TOTAL wipeout and nothing more.
// Measured live (plan/bench-lesson-gate-2026-09-11.md): at 12 reps per arm the power to detect a
// real 0.33 -> 0.08 collapse is 0.30. The gate duly admitted a lesson that was deliberately wrong.
// A caller that does not know that number is not making a decision, it is being reassured.
export function repsForPower({ baseRate, drop, alpha = 0.05, power = 0.8, max = 400 } = {}) {
  const p2 = Math.min(1, Math.max(0, baseRate));
  const p1 = Math.min(1, Math.max(0, baseRate - drop));
  // INERT under mutation, deliberately kept: removing it does not change any answer, because a
  // zero or negative drop makes the arms equal-or-better and the ladder then runs to `max` and
  // returns null anyway. It is a fast path for a meaningless input, not a behaviour. Recorded here
  // so a future mutation run does not read the survivor as a missing test.
  if (!(drop > 0)) return null;
  for (const n of ladder(max)) {
    if (exactPower(n, p1, p2, alpha) >= power) return n;
  }
  return null; // more than `max` reps per arm — i.e. not a gate you can afford to run
}
function* ladder(max) { for (let n = 4; n <= max; n += (n < 40 ? 2 : n < 120 ? 5 : 20)) yield n; }

function exactPower(n, p1, p2, alpha) {
  // Precompute the decision for every (a, c) once, then weight by the two binomials.
  const lb1 = binomLog(n, p1), lb2 = binomLog(n, p2);
  let power = 0;
  for (let a = 0; a <= n; a++) {
    const wa = Math.exp(lb1[a]);
    if (wa < 1e-12) continue;
    for (let c = a; c <= n; c++) { // harm means the with-arm did worse; a > c can never be harm
      const wc = Math.exp(lb2[c]);
      if (wc < 1e-12) continue;
      if (fisherHarmP({ withDone: a, withN: n, withoutDone: c, withoutN: n }) < alpha) power += wa * wc;
    }
  }
  return power;
}
function binomLog(n, p) {
  const out = new Array(n + 1);
  const lp = Math.log(p || 1e-12), lq = Math.log(1 - p || 1e-12);
  for (let k = 0; k <= n; k++) out[k] = lchoose(n, k) + k * lp + (n - k) * lq;
  return out;
}

// A rejected candidate is NEGATIVE EVIDENCE, not just a non-event: without it the proposer
// re-proposes an equivalent next run and the gate pays for the same matrix again. This is distinct
// from `retracted` in memory-store, which needs an observation to DISPROVE a fact and says nothing
// about one that was merely never useful. The fingerprint itself comes from
// sys/ai/proposal-fingerprint.mjs so a reworded equivalent collides with the original.
export function rejectionRecord({ fingerprint, verdict, now = Date.now() }) {
  return { fp: String(fingerprint), verdict: verdict.verdict, harmP: verdict.harmP, at: now,
    why: verdict.reason };
}
