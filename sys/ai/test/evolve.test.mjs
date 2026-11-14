// Conformance — the generational evolutionary loop (AVO crib). Injected generate/score
// (a scripted "model"), so the loop's climb-by-reseeding + graded selection + stopping
// are proven without a real model.
//   node sys/ai/test/evolve.test.mjs
import { evolve } from '../evolve.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

// Toy problem: climb an int toward 5. Fitness = how close (1.0 at 5). The generator
// REPAIRS toward the target using ctx.best — exactly the reseed the loop provides.
const climb = ({ best, index }) => (best == null ? index : Math.min(5, best + 1));
const closeness = (c) => 1 - Math.abs(5 - c) / 5;

await test('reseeding makes the population climb to the target, then stops', async () => {
  const r = await evolve({ generate: climb, score: closeness, popSize: 1, maxGen: 10, target: 1 });
  assert(r.solved, 'reached the target'); eq(r.best, 5, 'best candidate is the optimum');
  eq(r.bestScore, 1, 'best score is 1.0');
  assert(r.generations <= 6, `stopped early once solved (took ${r.generations} gens, not the full 10)`);
});

await test('the next generation is seeded with the best-so-far (lineage feedback)', async () => {
  const seenBest = [];
  const gen = (ctx) => { seenBest.push(ctx.best); return climb(ctx); };
  await evolve({ generate: gen, score: closeness, popSize: 1, maxGen: 4, target: 99 });
  eq(seenBest[0], null, 'gen 0 has no best');
  assert(seenBest[1] != null && seenBest[1] >= seenBest[0], 'gen 1 is handed a best to build on');
  assert(seenBest[3] > seenBest[1], 'the seed improves across generations');
});

await test('graded selection keeps the best across a diverse population', async () => {
  // gen 0 fans out 0,1,2,3 (via index); the best (3) is selected and climbed.
  const r = await evolve({ generate: climb, score: closeness, popSize: 4, maxGen: 5, target: 1 });
  assert(r.solved && r.best === 5, 'converged from a diverse first generation');
  // history records every candidate with its graded score.
  assert(r.history.every((h) => typeof h.score === 'number'), 'every candidate is graded');
});

await test('maxGen bounds a run that never reaches the target', async () => {
  const r = await evolve({ generate: climb, score: closeness, popSize: 1, maxGen: 3, target: 2 /*unreachable*/ });
  eq(r.solved, false, 'not solved'); eq(r.generations, 3, 'ran exactly maxGen generations');
  assert(r.best != null, 'still returns the best-so-far');
});

await test('a null candidate is skipped and a throwing score is survived', async () => {
  const gen = ({ index }) => (index === 0 ? null : 4); // first candidate fails to generate
  const score = (c) => { if (c === 4) throw new Error('scorer blew up on 4'); return 0.5; };
  const r = await evolve({ generate: gen, score, popSize: 2, maxGen: 1, target: 1 });
  assert(r.history.some((h) => h.skipped), 'the null candidate is recorded as skipped');
  eq(r.bestScore, -Infinity, 'a throwing score does not crash the loop or fake a win');
});

await test('score may return {score, detail}; the winning detail is carried for reseeding', async () => {
  const gen = ({ index }) => index;
  const score = (c) => ({ score: c / 10, detail: { failed: [c] } });
  const r = await evolve({ generate: gen, score, popSize: 3, maxGen: 1, target: 99 });
  eq(r.best, 2, 'highest-scoring candidate selected'); eq(r.bestDetail.failed[0], 2, 'its detail is kept');
});

await test('evolve rejects a missing generator/scorer', async () => {
  let threw = false; try { await evolve({ generate: () => 1 }); } catch (_) { threw = true; }
  assert(threw, 'a missing score() is refused');
});

// Multi-parent (RSA K = 2). A toy where neither parent alone holds the answer: a candidate is a
// set of solved example indices; combining two parents unions them.
await test('parents: 1 (the default) hands every candidate the best alone, as before', async () => {
  const seen = [];
  await evolve({ generate: (ctx) => { seen.push(ctx.parents.length); return ctx.index; }, score: (c) => c / 10, popSize: 3, maxGen: 2, target: 99 });
  eq(seen.slice(0, 3).join(','), '0,0,0', 'gen 0 has no parents');
  eq(seen.slice(3).join(','), '1,1,1', 'gen 1: one parent each');
});

await test('parents: 2 hands each candidate the best plus a different runner-up, best first', async () => {
  const seen = [];
  const gen = (ctx) => { if (ctx.gen === 1) seen.push(ctx.parents.map((p) => p.candidate)); return ctx.gen === 0 ? [10, 30, 20][ctx.index] : 0; };
  await evolve({ generate: gen, score: (c) => c / 100, popSize: 3, maxGen: 2, target: 99, parents: 2 });
  eq(seen.length, 3, 'three gen-1 candidates');
  assert(seen.every((ps) => ps.length === 2 && ps[0] === 30), 'every candidate gets the best (30) first');
  eq(new Set(seen.map((ps) => ps[1])).size, 2, 'siblings are paired with different runners-up (20 and 10)');
  assert(seen.every((ps) => typeof ps[0] === 'number'), 'parents carry the candidate itself');
});

await test('parents: 2 lets a combine operator solve what repair of the best alone cannot', async () => {
  // Candidates are sorted arrays of solved indices out of [0..3]. Gen 0 makes {0,1} and {2,3}.
  // "Repair" (K = 1) can only keep the best; "combine" (K = 2) unions two parents.
  const score = (c) => c.length / 4;
  const seeds = [[0, 1], [2, 3]];
  const generate = (ctx) => {
    if (ctx.gen === 0) return seeds[ctx.index];
    return [...new Set(ctx.parents.flatMap((p) => p.candidate))].sort();
  };
  const one = await evolve({ generate, score, popSize: 2, maxGen: 3, target: 1, parents: 1 });
  const two = await evolve({ generate, score, popSize: 2, maxGen: 3, target: 1, parents: 2 });
  assert(!one.solved, 'K = 1 never gets past half');
  assert(two.solved && two.generations === 2, `K = 2 solves in gen 1 (took ${two.generations})`);
  eq(two.best.join(','), '0,1,2,3', 'the union of both parents');
});

if (failures.length) {
  console.error(`evolve: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`evolve: ${passed} passed — generational climb via reseeding, graded selection, best-so-far carry, target/maxGen stops, bad-candidate survival.`);
