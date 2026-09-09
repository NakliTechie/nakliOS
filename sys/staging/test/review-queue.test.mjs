// Conformance — the host review queue reducer (Chunk 2 §5).
//   node sys/staging/test/review-queue.test.mjs
import { createReviewQueue } from '../review-queue.mjs';
import { registerAppDiffTypes } from '../diff-types.mjs';
import { clearRegistry } from '../envelope.mjs';
import { createProposalLedger } from '../../ai/proposal-fingerprint.mjs';
import { issueGrant, caveat, newRootKey, verifyGrant } from '../../identity/grant.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

clearRegistry();
registerAppDiffTypes(['reckon', 'draft']); // real normalizers so makeEnvelope accepts these apps
const RECKON_DIFF = { sheet: 'Sheet1', ops: [{ op: 'setCells', sheet: 'Sheet1', cells: { A1: { v: 2 } } }], inverse: [{ op: 'setCells', sheet: 'Sheet1', cells: { A1: { v: 1 } } }] };
const DRAFT_DIFF = { docId: 'd1', from: 0, to: 3, hunks: [{ index: 0, kind: 'replace', delText: 'old', insText: 'new' }] };

await test('stage returns an id and applies NOTHING; list carries the normalized preview', async () => {
  let applied = 0;
  const q = createReviewQueue({ onApply: () => applied++ });
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: true });
  assert(/^prop_/.test(proposal_id), 'a proposal id'); eq(applied, 0, 'stage never applies'); eq(q.size(), 1, 'one queued');
  const row = q.list()[0];
  eq(row.proposal_id, proposal_id, 'listed'); eq(row.renderer, 'cell-range', 'renderer key'); eq(row.reversible, true, 'reversible carried');
  assert(row.preview && row.preview.kind === 'cells' && row.preview.rows.length >= 1, 'the preview is the normalized diff');
  assert(/A1/.test(JSON.stringify(row.preview.rows)), 'the cell edit is in the preview');
});

await test('an unregistered app returns { error }, never throws', async () => {
  const q = createReviewQueue();
  const r = q.stage({ app: 'nope', tool: 'x', diff: {} });
  assert(r.error && /diff type/.test(r.error), `error surfaced: ${JSON.stringify(r)}`); eq(q.size(), 0, 'nothing queued');
});

await test('a person commit fires onApply exactly once and dequeues; a second commit is a no-op', async () => {
  let applied = []; const q = createReviewQueue({ onApply: (env) => applied.push(env.proposal_id) });
  const { proposal_id } = q.stage({ app: 'draft', tool: 'draft.commit', diff: DRAFT_DIFF, reversible: true });
  const r = await q.commit(proposal_id, { actor: 'person' });
  assert(r.ok && r.applied && r.mode === 'person', JSON.stringify(r)); eq(applied.length, 1, 'applied once'); eq(q.size(), 0, 'dequeued');
  eq((await q.commit(proposal_id, { actor: 'person' })).ok, false, 'a second commit finds nothing'); eq(applied.length, 1, 'not applied twice');
});

await test('an agent WITHOUT an auto-commit grant is refused and the proposal stays queued', async () => {
  let applied = 0; const q = createReviewQueue({ onApply: () => applied++ });
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: true });
  const r = await q.commit(proposal_id, { actor: 'agent' });
  eq(r.ok, false, 'refused'); assert(/person-only|auto-commit/.test(r.reason), r.reason); eq(applied, 0, 'not applied'); eq(q.size(), 1, 'still queued for a person');
});

await test('an agent WITH a reversible auto-commit grant commits a reversible op, but not an irreversible one', async () => {
  // The enforcement point retains the issuer root key and injects an authenticity
  // verifier (Med14): decideCommit only SCOPES the grant; the queue must VERIFY its
  // signature before auto-committing.
  const rootKey = newRootKey();
  const grant = await issueGrant(rootKey, { caveats: [caveat.tools(['setCells']), caveat.autoCommit(true)] });
  let applied = 0; const q = createReviewQueue({ onApply: () => applied++, verifyGrant: (g, ctx) => verifyGrant(g, rootKey, ctx) });
  const revId = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: true }).proposal_id;
  eq((await q.commit(revId, { actor: 'agent', grant })).mode, 'auto', 'reversible → auto-commit'); eq(applied, 1, 'applied');
  const irrId = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: false }).proposal_id;
  eq((await q.commit(irrId, { actor: 'agent', grant })).ok, false, 'irreversible still person-only under a reversible grant'); eq(q.size(), 1, 'left queued');
});

await test('a FORGED auto-commit grant (bad signature) is refused, not auto-committed (Med14)', async () => {
  const rootKey = newRootKey();
  const good = await issueGrant(rootKey, { caveats: [caveat.tools(['setCells']), caveat.autoCommit(true)] });
  const forged = { ...good, sig: 'AAAA' + String(good.sig || '').slice(4) }; // tamper the signature
  let applied = 0; const q = createReviewQueue({ onApply: () => applied++, verifyGrant: (g, ctx) => verifyGrant(g, rootKey, ctx) });
  const id = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: true }).proposal_id;
  const r = await q.commit(id, { actor: 'agent', grant: forged });
  eq(r.ok, false, 'forged grant refused'); eq(applied, 0, 'not applied'); eq(q.size(), 1, 'left queued');
});

await test('an expired proposal is refused even for a person, and stays queued', async () => {
  let t = 1000; let applied = 0; const q = createReviewQueue({ now: () => t, onApply: () => applied++ });
  const { proposal_id } = q.stage({ app: 'draft', tool: 'draft.commit', diff: DRAFT_DIFF, expires: 2000 });
  t = 3000; // past expiry
  const r = await q.commit(proposal_id, { actor: 'person' });
  eq(r.ok, false, 'refused'); eq(r.reason, 'expired', 'reason is expiry'); eq(applied, 0, 'never applied'); eq(q.size(), 1, 'left queued, not silently dropped');
  // a non-expired proposal a person commits does apply and dequeue (the control)
  t = 1500; const ok = q.stage({ app: 'draft', tool: 'draft.commit', diff: DRAFT_DIFF, expires: 5000 }).proposal_id;
  eq((await q.commit(ok, { actor: 'person' })).ok, true, 'a still-valid proposal commits'); eq(applied, 1, 'and applies');
});

await test('discard dequeues, fires onReject, and poisons the fingerprint so the SAME diff is re-detectable', async () => {
  let rejected = null; const led = createProposalLedger({ now: () => 5000 });
  const q = createReviewQueue({ ledger: led, now: () => 5000, onReject: (env, reason) => { rejected = { id: env.proposal_id, reason }; } });
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF, reversible: true });
  eq(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF }), false, 'not poisoned before discard');
  const r = await q.discard(proposal_id, { reason: 'wrong cell', cooloffDays: 30 });
  assert(r.ok, 'discarded'); eq(q.size(), 0, 'dequeued'); assert(rejected && /wrong cell/.test(rejected.reason), 'onReject fired with the reason');
  eq(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF }), true, 'the SAME diff is now poisoned');
  const OTHER = { sheet: 'Sheet1', ops: [{ op: 'setCells', sheet: 'Sheet1', cells: { B2: { v: 9 } } }], inverse: [] };
  eq(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: OTHER }), false, 'a DIFFERENT diff is not poisoned');
});

await test('isPoisoned is false with no ledger; unknown proposal_id on commit/discard → {ok:false}, no throw', async () => {
  const q = createReviewQueue();
  eq(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF }), false, 'no ledger → never poisoned');
  eq((await q.commit('prop_nope', { actor: 'person' })).ok, false, 'unknown commit');
  eq((await q.commit('prop_nope', { actor: 'person' })).reason, 'no such proposal', 'reason');
  eq((await q.discard('prop_nope', {})).ok, false, 'unknown discard, no throw');
});

await test('NAF-15: the staged diff is a SNAPSHOT — mutating it after review cannot change what commits', async () => {
  const applied = [];
  const q = createReviewQueue({ onApply: (env) => applied.push(env) });
  const diff = JSON.parse(JSON.stringify(RECKON_DIFF));
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff });
  const preview = JSON.stringify(q.list()[0].preview);
  // the caller mutates the object it handed over, AFTER the reviewer saw the preview
  diff.ops[0].cells.A1.v = 999;
  diff.sheet = 'Injected';
  eq(JSON.stringify(q.list()[0].preview), preview, 'the preview must not change under the reviewer');
  eq((await q.commit(proposal_id, { actor: 'person' })).ok, true, 'commits');
  eq(JSON.stringify(applied[0].diff.ops[0].cells.A1.v), '2', 'the REVIEWED value is what applied, not the mutated one');
  eq(applied[0].diff.sheet, 'Sheet1', 'and not the mutated sheet');
});

await test('NAF-16: an apply that fails keeps the proposal and reports honestly', async () => {
  const q = createReviewQueue({ onApply: async () => { throw new Error('disk full'); } });
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF });
  const r = await q.commit(proposal_id, { actor: 'person' });
  eq(r.ok, false, 'a failed apply is not a success');
  assert(/disk full/.test(r.reason), `the reason names the failure: ${r.reason}`);
  eq(q.size(), 1, 'the proposal is STILL QUEUED — losing it would drop the change silently');
  // and it can be committed once the sink works
  const q2 = createReviewQueue({ onApply: async () => {} });
  const p2 = q2.stage({ app: 'reckon', tool: 'setCells', diff: RECKON_DIFF }).proposal_id;
  eq((await q2.commit(p2, { actor: 'person' })).ok, true, 'a working sink still commits');
  eq(q2.size(), 0, 'and dequeues');
});

await test('NAF-17: fingerprints keep code punctuation — x=1 and x=-1 are different mutations', async () => {
  const ledger = createProposalLedger();
  const q = createReviewQueue({ ledger });
  const mk = (text) => ({ sheet: 'S', ops: [{ op: 'setCells', sheet: 'S', cells: { A1: { v: text } } }], inverse: [] });
  const { proposal_id } = q.stage({ app: 'reckon', tool: 'setCells', diff: mk('x=1') });
  await q.discard(proposal_id, { reason: 'no' });
  assert(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: mk('x=1') }), 'the SAME diff is poisoned');
  assert(!(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: mk('x=-1') })),
    'x=-1 is a DIFFERENT mutation — the prose tokenizer stripped the minus sign and poisoned it too');
  assert(!(await q.isPoisoned({ app: 'reckon', tool: 'setCells', diff: mk('x==1') })), 'and so is x==1');
});

if (failures.length) { console.error(`review-queue: ${passed} passed, ${failures.length} FAILED`); for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`); process.exit(1); }
console.log(`review-queue conformance: ${passed}/${passed} passed — stage/commit/discard, authority via decideCommit, expiry, poison-on-discard, guards`);
