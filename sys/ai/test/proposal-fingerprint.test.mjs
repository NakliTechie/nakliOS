// Conformance — proposal fingerprints (five stability properties) + poison memory.
//   node sys/ai/test/proposal-fingerprint.test.mjs
import { fingerprint, canonicalize, canonicalString, normToken, createProposalLedger, loadProposalLedger,
         isPoisoned, filterProposals, FINGERPRINT_VERSION, PROPOSAL_EVENTS, DEFAULT_COOLOFF_DAYS } from '../proposal-fingerprint.mjs';
import { RUN_EVENTS } from '../../history/run-record.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const P = { goal: 'Deploy the auth service safely', steps: ['run the tests', 'build the image', 'deploy to staging'], paths: ['src/auth.js', 'Dockerfile', 'deploy/staging.yml'] };
const DAY = 86_400_000;

await test('P1 determinism: same input → same fingerprint; the shape is fp:v1:<64 hex>', async () => {
  const a = await fingerprint(P), b = await fingerprint(structuredClone(P));
  eq(a, b, 'deterministic'); assert(/^fp:v1:[0-9a-f]{64}$/.test(a), a); eq(FINGERPRINT_VERSION, 'v1', 'version');
});

await test('P2 permutation invariance: goal token order, casing, and path order do not change it', async () => {
  const base = await fingerprint(P);
  eq(await fingerprint({ ...P, goal: 'SAFELY deploy the Auth service' }), base, 'goal tokens reordered + recased');
  eq(await fingerprint({ ...P, paths: [...P.paths].reverse() }), base, 'path order');
  eq(await fingerprint({ ...P, paths: ['./src/auth.js', 'Dockerfile', 'deploy//staging.yml'] }), base, 'path spelling normalised');
  assert(await fingerprint({ ...P, goal: 'Deploy the billing service safely' }) !== base, 'a different goal is a different proposal');
});

await test('P3 step ORDER is significant; words inside a step keep order and drop stopwords', async () => {
  const base = await fingerprint(P);
  assert(await fingerprint({ ...P, steps: ['build the image', 'run the tests', 'deploy to staging'] }) !== base, 'ABA ≠ AAB: reordered steps differ');
  eq(await fingerprint({ ...P, steps: ['run tests', 'build an image', 'deploy staging'] }), base, 'stopwords inside a step are ignored');
  const c = canonicalize(P);
  eq(c.steps.join('|'), 'run test|build image|deploy staging', 'skeleton: order kept, stopwords out, plurals stripped');
  assert(await fingerprint({ ...P, steps: ['tests run', 'build image', 'deploy staging'] }) !== base, 'word order inside a step matters');
});

await test('P4 top-K stability: a path sorting after the K-th does not change it (lexical top-K, not centrality); a 5th does', async () => {
  const five = { ...P, paths: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js'] };
  const base = await fingerprint(five);
  eq(await fingerprint({ ...five, paths: [...five.paths, 'zzz-low.js'] }), base, 'a 6th path beyond the sorted top-5 is absorbed');
  assert(await fingerprint({ ...five, paths: five.paths.slice(0, 4) }) !== base, 'dropping to four paths changes it');
  eq(canonicalize({ ...five, paths: [...five.paths, 'zzz-low.js'] }).paths.length, 5, 'canonical keeps five');
  assert(await fingerprint({ ...five, paths: [...five.paths, '0aaa.js'] }) !== base, 'honest limit: a path that sorts FIRST displaces one — the property is lexical');
});

await test('negation is never dropped: a goal and its opposite are different proposals', async () => {
  assert(await fingerprint({ goal: 'do not deploy' }) !== await fingerprint({ goal: 'deploy' }), 'do not deploy ≠ deploy');
  assert(await fingerprint({ steps: ['do not run tests'] }) !== await fingerprint({ steps: ['run tests'] }), 'negated step ≠ step');
  assert(await fingerprint({ goal: 'never deploy' }) !== await fingerprint({ goal: 'deploy' }), 'never deploy ≠ deploy');
  eq(canonicalize({ goal: 'do not deploy' }).goal.join(' '), 'deploy do not', 'negation tokens survive');
});

await test('P5 token normalisation: plurals and stopwords absorb surface perturbations', async () => {
  const base = await fingerprint(P);
  eq(await fingerprint({ ...P, goal: 'Deploys the auth services, safely!' }), base, 'plural + punctuation');
  eq(normToken('Deploys'), 'deploy', 'plural s'); eq(normToken('images'), 'image', 'plain s'); eq(normToken('boxes'), 'box', 'es after x'); eq(normToken('services'), 'service', 'es after c keeps the e'); eq(normToken('the'), '', 'stopword');
  eq(normToken('policies'), 'policy', 'ies → y'); eq(normToken('class'), 'class', 'ss is not a plural');
  assert(/^goal=auth deploy safely service\nsteps=/.test(canonicalString(canonicalize(P))), canonicalString(canonicalize(P)));
});

await test('POISON: a rejected proposal is not re-proposed from the same fixture; the cooloff expires; a fresh one passes', async () => {
  const t0 = Date.parse('2026-09-05T00:00:00Z');
  const led = createProposalLedger({ principal: 'prin_owner', now: () => t0 });
  const fp = await fingerprint(P);
  await led.reject({ fp, reason: 'we do not deploy from the agent', cooloffDays: 14 });
  await led.settled();
  eq(led.events().length, 1, 'one rejection event'); eq(led.events()[0].tool, 'proposal.rejected', 'verb');
  eq((await led.verify()).ok, true, 'chain verifies');
  assert(!JSON.stringify(led.events()).includes('do not deploy'), 'the chain carries hashes, not the reason');
  // the review fork's next output: the same proposal, reworded, plus a new one
  const proposals = [
    { ...P, goal: 'safely deploy the auth service', steps: ['run tests', 'build image', 'deploy to staging'] },
    { goal: 'Add a lint step', steps: ['add eslint', 'wire ci'], paths: ['.github/workflows/ci.yml'] },
  ];
  const r1 = await filterProposals(led, proposals, { now: t0 + DAY });
  eq(r1.dropped.length, 1, 'the reworded duplicate is dropped'); eq(r1.dropped[0].fp, fp, 'by fingerprint');
  assert(/do not deploy/.test(r1.dropped[0].reason) && r1.dropped[0].until === t0 + 14 * DAY, 'carries reason + until');
  eq(r1.kept.length, 1, 'the fresh proposal passes'); assert(r1.kept[0].fp.startsWith('fp:v1:'), 'kept carries its fp');
  const r2 = await filterProposals(led, proposals, { now: t0 + 15 * DAY });
  eq(r2.dropped.length, 0, 'after the cooloff it may be proposed again');
  eq(isPoisoned(led, fp, t0 + 13 * DAY).poisoned, true, 'day 13 poisoned'); eq(isPoisoned(led, fp, t0 + 14 * DAY).poisoned, false, 'day 14 free');
  eq(isPoisoned(led, 'fp:v1:' + '0'.repeat(64)).poisoned, false, 'unknown fp is not poisoned');
});

await test('POISON: the latest rejection wins; cooloff 0 never poisons; bad fingerprints are refused; export/load round-trips', async () => {
  let t = 1_000; const led = createProposalLedger({ now: () => t });
  const fp = await fingerprint(P);
  await led.reject({ fp, cooloffDays: 30 }); t = 2_000; await led.reject({ fp, cooloffDays: 0 }); await led.settled();
  eq(isPoisoned(led, fp, 3_000).poisoned, false, 'the later 0-day rejection lifts the earlier one');
  let err = null; try { await led.reject({ fp: 'nope' }); } catch (e) { err = e; } assert(err && /not a fingerprint/.test(err.message), 'refuses junk');
  const back = loadProposalLedger(led.export());
  eq((await back.verify()).ok, true, 'reloaded chain verifies'); eq(isPoisoned(back, fp, 1_500).poisoned, true, 'fold works on the reloaded ledger');
  eq(DEFAULT_COOLOFF_DAYS, 14, 'default cooloff');
  eq(PROPOSAL_EVENTS[0], 'proposal.rejected', 'own vocabulary'); assert(!RUN_EVENTS.includes('proposal.rejected'), 'the run vocabulary is untouched');
});

if (failures.length) { console.error(`proposal-fingerprint: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`proposal-fingerprint conformance: ${passed}/${passed} passed — P1–P5 stability, poison ledger with cooloff, rejected proposals not re-proposed`);
