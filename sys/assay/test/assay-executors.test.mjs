// Conformance — Assay live role executors (the harness that runs a role as an agent
// and turns its emitted output into a validated ledger block). Uses a SCRIPTED model
// (runRole) so the plumbing — prompt/view assembly, emit capture, stamping, validation,
// and the wall-at-the-view — is proven without a live LLM.
//   node sys/assay/test/assay-executors.test.mjs
import { createAssayLedger } from '../ledger.mjs';
import { runCampaign } from '../runmode.mjs';
import { makeCampaignExecutors, viewFor, ROLE_INSTRUCTIONS } from '../executors.mjs';
import { verifyWall, verifyTests, replay } from '../verify.mjs';

let passed = 0; const failures = [];
async function test(n, fn) { try { await fn(); passed++; } catch (e) { failures.push({ n, message: e.message }); } }
function assert(c, m) { if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }

const C = 'camp-x';
const PM = (r) => [0.6, 0.8, 0.86, 0.865][r] ?? 0.87;
const WT = (r) => [10, 8, 4, 3][r] ?? 2;

// A scripted "model": returns what each role would emit via its `emit` tool. It reads
// only the role-scoped `view` it is handed — the same wall a real agent would see.
function scriptedRunRole({ action, round, view }) {
  switch (action) {
    case 'build-instrument': return { version: 1, ratchet_sha: 'sha256:x', areas: [{ id: 'view', description: 'view cmd', weight: 3 }], cases: [6,2,0.6,0.05,1.35].map((weight,id)=>({id:String(id),area:'view',command:'fixture '+id,expected:{exitCode:0,stdout:'ok'},weight})) };
    case 'build-candidate': {
      const d = (view.directives || []).slice(-1)[0];
      return { git_ref: 'c' + round, test_count: 5 + round, deleted: 0, from_directive: d ? d.id : '' };
    }
    case 'measure': return { pass_mass: PM(round), clusters: [{ id: 'cl' + round, area: 'view', weight: WT(round), representative_symptom: '-H header missing', repro_hint: 'view -H on a BAM' }] };
    case 'adjudicate': {
      const ids = (view.findings || []).filter((x) => x.round === round).flatMap((x) => (x.clusters || []).map((c) => c.id));
      return { id: 'd' + round, from_findings: ids.length ? ids : ['cl' + round], items: [{ area: 'view', weight: 3, instruction: 'address round ' + round }] };
    }
    case 'propose-ship': return { candidate_ref: 'c' + round, rationale: 'converged over bar' };
    default: return {};
  }
}
const scriptedCheck=(testCase,{round})=>({exitCode:0,stdout:Number(testCase.id)<=round?'ok':'fail',stderr:''});
const executors = (runRole = scriptedRunRole, runCheck = scriptedCheck) => makeCampaignExecutors({ campaign: C, goal: 'samtools view parity', ship_bar: 0.85, runRole, runCheck, access:async()=>({ok:true}), clock: (() => { let t = 0; return () => ++t; })() });

await test('role instructions carry the load-bearing constraints', () => {
  assert(/never see the instrument/i.test(ROLE_INSTRUCTIONS.builder), 'builder is told it never sees the instrument');
  assert(/never naming a case|never a case|never name/i.test(ROLE_INSTRUCTIONS.lead), 'lead is told never to name a case');
  assert(/never weaken/i.test(ROLE_INSTRUCTIONS.checker), 'checker is told never to weaken the instrument');
});

await test('the wall lives in the view: builder sees no findings/instrument; lead sees only summaries', async () => {
  const L = createAssayLedger();
  await L.append({ type: 'assay.instrument.v1', campaign: C, actor: 'actor:agent:checker:camp-x', ts: 1, version: 1, ratchet_sha: 'sha256:a' });
  await L.append({ type: 'assay.finding.v1', campaign: C, actor: 'actor:agent:checker:camp-x', ts: 2, round: 0, clusters: [{ id: 'cl0', area: 'view', weight: 3, representative_symptom: 'raw', repro_hint: 'raw' }] });
  const iv = viewFor('builder', L, C);
  assert(!('findings' in iv) && !('instrument' in iv) && !('measures' in iv), 'builder view excludes findings/instrument/measures');
  const fv = viewFor('lead', L, C);
  assert(Array.isArray(fv.findings) && !('instrument' in fv), 'lead gets finding summaries, not the instrument');
  const cl = fv.findings[0].clusters[0];
  assert(cl.id && cl.weight != null && !('representative_symptom' in cl) && !('repro_hint' in cl), 'lead finding summary carries no raw symptom/repro');
});

await test('a full LIVE-harness campaign runs start → ship and passes every verifier', async () => {
  const L = createAssayLedger();
  const res = await runCampaign({ ledger: L, campaign: C, executors: executors(), config: { weight_floor: 5, epsilon: 0.01 } });
  eq(res.status, 'ship', 'campaign ships');
  eq(L.ofType('assay.ship', C).length, 1, 'a ship block was proposed');
  eq(verifyWall(L, { campaign: C }).code, 0, 'wall clean');
  eq(verifyTests(L, { campaign: C }).code, 0, 'tests monotone');
  eq(replay(L, { campaign: C }).code, 0, 'lineage intact (candidate.from_directive resolved from the emitted directive ids)');
  assert((await L.verifyIntegrity()).ok, 'chain intact');
});

await test('a clean measurement (no failure clusters) emits only a measure, no finding', async () => {
  // A real Checker legitimately reports zero clusters when the candidate passed —
  // that must produce a valid measure, not an invalid empty finding (live-test bug).
  const clean = (ctx) => (ctx.action === 'measure' ? { pass_mass: 1.0, clusters: [] } : scriptedRunRole(ctx));
  const ex = executors(clean,()=>({exitCode:0,stdout:'ok',stderr:''}));
  await ex['build-instrument']({round:0,ledger:createAssayLedger()});
  const blocks = await ex.measure({ round: 0, ledger: createAssayLedger() });
  eq(blocks.length, 1, 'only the measure block'); eq(blocks[0].type, 'assay.measure', 'a measure');
  eq(blocks[0].cluster_count, 0, 'zero clusters recorded, no finding emitted');
});

await test('a role that emits nothing pauses the campaign', async () => {
  const silent = (ctx) => (ctx.action === 'build-instrument' ? null : scriptedRunRole(ctx));
  const res = await runCampaign({ ledger: createAssayLedger(), campaign: C, executors: executors(silent), config: { weight_floor: 5, epsilon: 0.01 } });
  eq(res.status, 'paused', 'a non-emitting role pauses');
  assert(/build-instrument/.test(res.reason), 'paused on the role that produced nothing');
});

if (failures.length) {
  console.error(`Assay executors: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  ✗ ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`Assay executors: ${passed} passed — role agents emit → validated blocks; the wall lives in the role-scoped view; a live-harness campaign runs start→ship and passes wall|tests|replay.`);
