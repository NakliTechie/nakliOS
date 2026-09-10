// Guards that Anvil actually RECORDS its runs — the wiring, not the module.
//
// sys/history/run-record.mjs is unit-tested in isolation; twice today a correct,
// tested helper sat behind a call site that never used it (belief-revision status,
// the first version of the convo-carry test). This pins every seam the record
// depends on inside apps/anvil/index.html.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');
const runTask = anvil.slice(anvil.indexOf('async function runTask(t, text){'));
assert.ok(runTask.length > 1000, 'runTask found');

{ const imp = anvil.match(/import \{([^}]*)\} from '\.\.\/\.\.\/sys\/history\/run-record\.mjs'/);
  assert.ok(imp, 'the run record is imported');
  for (const n of ['createRunRecorder','foldStatus','foldLog','loadRecord']) assert.ok(imp[1].includes(n), `imports ${n}`); }

// Every loop in runTask is recorded: started before, finished after, infer wrapped, events chained.
const loops = [...runTask.matchAll(/runAgentLoop\(\{/g)].length;
assert.equal(loops, 3, 'runTask runs the loop in exactly three places (main + act-or-nudge + D2 supervisor)');
// Match the CALL, not its exact argument list — this anchor broke once when a field was
// added to rec.start, reporting 0 of 3 call sites that were all still there.
const startCalls = [...runTask.matchAll(/await rec\.start\(\{[^}]*\}\)/g)].map((m) => m[0]);
assert.equal(startCalls.length, 3, 'each loop is preceded by rec.start (main + act-or-nudge + D2 supervisor)');
for (const call of startCalls) {
  assert.match(call, /messages: \w+/, `rec.start must carry the messages it started with: ${call}`);
  assert.match(call, /\btools\b/, `rec.start must carry the toolset: ${call}`);
  // Provider+model identity on the chain. Without it a replayed record reproduces the bytes
  // but not the responder, and foldOutcome's failure signals land on whichever endpoint is
  // selected when the record is read, not the one that actually answered.
  assert.match(call, /model: runModel\(\)/, `rec.start must stamp who answered: ${call}`);
}
assert.match(runTask, /const runModel = \(\) => \{[\s\S]*?capabilities[\s\S]*?aiModel[\s\S]*?aiProvider[\s\S]*?\}/,
  'the model stamp is read from the host capability broadcast at run time, not cached at boot');
assert.equal([...runTask.matchAll(/await rec\.finish\(result\)/g)].length, 3, 'each loop is followed by rec.finish (main + act-or-nudge + D2 supervisor)');
assert.equal([...runTask.matchAll(/infer: recInfer/g)].length, 3, 'each loop infers through the recorder (main + act-or-nudge + D2 supervisor)');
assert.equal([...runTask.matchAll(/onEvent:recEvent/g)].length, 3, 'each loop reports through the recorder (main + act-or-nudge + D2 supervisor)');
// Check each runAgentLoop CALL SITE itself — the subagent executor
// (makeToolExecutor({ infer: inferViaHost })) is deliberately unrecorded in this
// layer (tree-scoped subagent records are a later move), so a file-wide grep for
// `infer: inferViaHost` would be wrong.
for (const m of runTask.matchAll(/runAgentLoop\(\{[\s\S]*?\}\);/g)) {
  const site = m[0];
  assert.match(site, /infer: recInfer/, `a loop bypasses the recorder for inference: ${site.slice(0, 80)}…`);
  assert.match(site, /onEvent:recEvent/, `a loop bypasses the recorder for events: ${site.slice(0, 80)}…`);
  assert.ok(!/infer: inferViaHost|onEvent:onLoopEvent\b/.test(site), `a loop still uses the unrecorded seams: ${site.slice(0, 80)}…`);
}
assert.match(runTask, /const recEvent = ?\(e\)=>\{ onLoopEvent\(e\); rec\.onEvent\(e\); \}/,
  'the live-UI handler runs for in-run feedback AND the recorder sees every event (the record is the durable copy)');
// shape, not signature: wrapInfer now also takes the F1 divergence hook
assert.match(runTask, /rec\.wrapInfer\(inferViaHost/, 'the model exchange is content-addressed through wrapInfer');
assert.match(runTask, /onDivergence/, 'F1: a request that cannot be reconstructed from the chain is surfaced');

// The record is read only after it settles, and the folds are checked against the live state.
assert.match(runTask, /await rec\.settled\(\);/, 'the record is settled before it is read');
// Layer 2b: status and the carried transcript are DERIVED from the record's folds, not written
// in parallel — so there is no dual-write to self-check. The two ⚠ lines are gone.
assert.match(runTask, /t\.status = foldStatus\(recEvents, rec\.resolve, \{ gated \}\)\.status/, 'status IS the fold, not a parallel computation');
// shape, not signature: F4 hands the recorder to carryForward so the lossy carry is logged
assert.match(runTask, /t\.convo = await carryForward\(foldTranscript\(recEvents, rec\.resolve\)/, 'the carried transcript IS the fold, paired by construction');
assert.match(anvil, /rec\.compacted\(\{ method:'carry-forward'/, 'F4: the carry records its replacement on the chain, so foldSurface reproduces what was sent');
assert.ok(!/run record disagrees/.test(anvil), 'the dual-write self-check is deleted (the record is the source of truth, nothing to disagree with)');
assert.ok(!/logStart/.test(anvil), 'the self-check\'s logStart bookkeeping is gone with it');

// Persisted OUTSIDE the agent's mount.
assert.match(anvil, /async function saveRunRecord\(t, rec(, \{[^)]*\})?\)\{/, 'a run store exists');
assert.match(anvil, /createOpfsBackend\(\{ path:'anvil\/'\+rel \}\)/, 'records go to OPFS');
assert.match(anvil, /const rel='runs\/'\+String\(state\.activeProject/, 'under anvil/runs/<project>/<task>/, not the workspace mount');
assert.ok(!/fs\.write\([^)]*runs\//.test(anvil), 'never written through the agent-facing `fs`');
assert.match(runTask, /await saveRunRecord\(t, rec(, \{ gated \})?\)/, 'every run is persisted');
assert.match(runTask, /record: could not persist/, 'a persistence failure is surfaced');

// ── the storage ladder: rung 1 (Anvil home) and the honest durability line ──
// navigator.storage.persisted() was FALSE on naklios.dev on 2026-09-04, so OPFS
// is eviction-eligible; the home is a disk folder outside every workspace.
assert.match(anvil, /const HOME_KEY='anvil-home'/, 'the home handle has its own IDB key');
assert.match(anvil, /async function connectHome\(h\)/, 'connectHome exists');
assert.match(anvil, /h\.requestPermission\(\{mode:'readwrite'\}\)/, 'the home is re-granted through requestPermission');
assert.match(anvil, /id="home-chip"/, 'the home has a visible affordance');
assert.match(anvil, /\$\('home-chip'\)\.onclick = async/, 'and a click handler (the picker needs a gesture)');
assert.match(anvil, /showDirectoryPicker\(\{ mode:'readwrite', id:'anvil-home' \}\)/, 'the picker is keyed so the browser remembers the choice');
assert.match(anvil, /const h=await idbGet\(HOME_KEY\); if\(h&&typeof h\.queryPermission==='function'\)\{ homeSaved=true;/, 'boot re-checks the remembered home');
assert.match(anvil, /opfsPersisted=await navigator\.storage\.persisted\(\)/, 'boot learns whether browser storage is persisted');
// write-through: both rungs attempted, each reported, neither silently skipped
const save = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec'), anvil.indexOf('async function runTask(t, text){'));
assert.ok(save.length > 200, 'the saveRunRecord slice is non-empty (a stale anchor here once pushed a red test to main)');
assert.match(save, /createOpfsBackend\(\{ path:'anvil\/'\+rel \}\)/, 'rung 0: OPFS');
assert.match(save, /if\(homeHandle\)\{/, 'rung 1: the home, when connected');
assert.match(save, /fh\.createWritable\(\)/, 'the home is written through raw FSA handles, not the agent-facing fs');
assert.match(save, /'browser storage \(evictable\)'/, 'an unpersisted OPFS copy is labelled evictable');
assert.match(save, /return \{ path, name, tiers, errors(, count)? \}/, 'every rung and every failure is returned');
assert.ok(!/fs\.write/.test(save), 'saveRunRecord never touches the agent-facing fs');
// the closing line
assert.match(runTask, /const where = saved\.tiers\.length \? saved\.tiers\.join\(' \+ '\) : 'NOT saved'/, 'the closing line names every rung the record reached');
assert.match(runTask, /browser storage only; the browser may evict it\. Pick an Anvil home/, 'browser-only + unpersisted → the line says so and says what fixes it');
assert.match(runTask, /saved\.errors\.join/, 'a failed rung is reported, not swallowed');

// ── the index: derived, rebuildable, and actually READ ──
// An index nobody reads is dead code (today's lesson, twice). The closing line
// reads it back, so the read path is exercised on every run.
assert.match(anvil, /indexedDB\.open\(DIR_DB,2\)/, 'the IDB schema is v2');
assert.match(anvil, /createObjectStore\(RUNS_STORE,\{keyPath:'id'\}\)/, 'a runs store keyed by id');
for (const ix of ['project','task','endedAt']) assert.match(anvil, new RegExp(`createIndex\\('${ix}','${ix}'\\)`), `indexed by ${ix}`);
assert.match(anvil, /if\(!db\.objectStoreNames\.contains\(DIR_STORE\)\) db\.createObjectStore\(DIR_STORE\)/, 'the v1 store survives the upgrade');
assert.match(anvil, /function runIndexRow\(/, 'rows are derived by one function');
assert.match(anvil, /const st=foldStatus\(ev, rec\.resolve, \{ gated \}\)/, 'a row\'s status is the FOLD, not a copy of t.status');
const save2 = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec'), anvil.indexOf('async function runTask(t, text){'));
assert.match(save2, /await runsPut\(runIndexRow\(/, 'saveRunRecord writes the row after the files');
assert.match(save2, /count=\(await runsForTask\(String\(t\.id\)\)\)\.length/, 'and reads the task\'s run count back');
assert.match(runTask, /' · run '\+saved\.count\+' of this task'/, 'the closing line is a real reader of the index');
assert.match(anvil, /async function rebuildRunIndex\(\)/, 'the doctor exists');
const doctor = anvil.slice(anvil.indexOf('async function rebuildRunIndex(){'), anvil.indexOf('async function saveRunRecord('));
assert.match(doctor, /const rec=loadRecord\(dump\); const v=await rec\.verify\(\)/, 'every file is chain-verified on the way in');
assert.match(doctor, /row\.chainOk=v\.ok; row\.brokenAt=v\.brokenAt/, 'a broken chain is indexed as broken, not hidden');
assert.match(doctor, /getDirectoryHandle\('anvil'\)/, 'scans OPFS');
assert.match(doctor, /homeHandle\.getDirectoryHandle\('runs'\)/, 'and the home when connected');
assert.match(anvil, /if\(\(await runsCount\(\)\)===0\)\{ (?:const r=)?await rebuildRunIndex\(\)/, 'boot backfills an empty index from files');

// ── rung 2: the host store (Crate / host Folder) ──
const save3 = anvil.slice(anvil.indexOf('async function saveRunRecord(t, rec'), anvil.indexOf('async function runTask(t, text){'));
assert.match(save3, /if\(hostFsReady\(\)\)\{/, 'rung 2 is attempted when the host has a store');
assert.match(save3, /new CrateBackend\(nak\.fs\), root:''/, 'through the same CrateBackend the workspace uses, rooted at the store root');
assert.match(save3, /hx\.write\(rel\+'\/'\+name, text\)/, 'written under runs/, outside the ws/<project> mount');
assert.match(save3, /which==='crate' \? 'Crate' : 'host '\+which/, 'the tier is labelled by what the host actually is');
const doctor2 = anvil.slice(anvil.indexOf('async function rebuildRunIndex(){'), anvil.indexOf('async function saveRunRecord('));
assert.match(doctor2, /hx\.list\('runs',\{recursive:true\}\)/, 'the doctor scans the host store too');
assert.match(doctor2, /prev\.tiers\.push\(tier\)/, 'a record found on several rungs is one row with all its tiers');

console.log('anvil-run-record: every loop is recorded, folds are self-checked, records persist outside the mount, the durability line is honest, and the index is derived, rebuildable and read');

// D1: the doctor folds the stop-reason distribution over every record it read and
// surfaces it — khiladi's Q3 answered from the record, never from a counter.
assert.match(anvil, /foldStopReasons\(\[\.\.\.found\.values\(\)\]\.map\(f=>f\.rec\)/, 'rebuildRunIndex folds stop reasons over the records it read');
assert.match(anvil, /stopsLine: stopReasonsLine\(stops\)/, 'and returns the one-line histogram');
assert.match(anvil, /run index rebuilt: .*r\.stopsLine/, 'the boot backfill surfaces it');

// Layer 2b (2026-09-06): the writers t.status/t.convo are gone (derived above). t.log stays a
// written array — it is what renderLog draws and it carries change/diff chips the record cannot
// reproduce until pre-images are folded (a parked follow-up: fold the log pane so reload rebuilds
// it from the record). The record is the tamper-evident source of truth and what history searches.
assert.match(anvil, /t\.log stays a written array/, 'the code is honest: t.log is written, the record is the source of truth');

// B3: the recovery record. A resumed run is prefaced with a note built from the PRIOR run's
// record (foldRecovery), and it rides beside the carried transcript — additive, not a replace.
assert.match(anvil, /t\.recovery = recoveryNote\(foldRecovery\(recEvents, rec\.resolve\)\)/, 'the recovery note is a pure fold of this run\'s record, stashed for the next run');
assert.match(anvil, /const recoveryPreface = \(t\.recovery/, 'the next run is prefaced with the recovery note');
// F3 moved it out of the system prefix (which is the cache boundary) into the change-gated
// context message that rides at the END of the conversation — still additive, never a replace.
// The indexes are change-gated; the recovery note is per-run, so it rides as its own message —
// bundling it into the gated block made the digest differ every run and the gate never engaged
// (live check 2026-09-07).
assert.match(anvil, /const volatileCtx = \(projectContext\+memoryIndex\+skillsIndex\)\.trim\(\)/, 'only the indexes are change-gated');
assert.ok(!/volatileCtx = \([^)]*recoveryPreface/.test(anvil), 'the per-run recovery note is NOT inside the gated block');
assert.match(anvil, /const recoveryMsg = recoveryPreface\.trim\(\);\s*\n\s*if\(recoveryMsg\) convo\.push\(\{role:'user', content:'\[coordination\] '\+recoveryMsg\}\)/, 'the recovery note is still delivered, as its own tagged message');
assert.match(anvil, /firstMessages=\[sysMsg\(gateNote\), \.\.\.convo\]/, 'the carried transcript is still what follows the system message');
assert.ok(!/sysMsg\(gateNote\+recoveryPreface\)/.test(anvil), 'the volatile note is OUT of the cache prefix');
// and the prefix itself carries only stable text — one volatile index in it invalidates everything
assert.match(anvil, /const sysMsg=\(extra\)=>\(\{role:'system',content:SYSTEM\+\(MODE_NOTE\[mode\]\|\|''\)\+\(mode==='code'\?LESSON_NOTE:''\)\+\(extra\|\|''\)\}\)/, 'the system message is stable text only');
for (const volatile of ['projectContext', 'memoryIndex', 'skillsIndex']) {
  assert.ok(!new RegExp(`content:SYSTEM\\+[^}]*${volatile}`).test(anvil), `${volatile} is back in the cache prefix`);
}

// D2 supervisor: after a loop, a record-fold (foldStagnation) catches spinning the loop's own
// consecutive-identical guard misses, and injects ONE capped redirect — fired at most once per
// run, never on a 'done' run, and not for no-tools (the act-or-nudge above owns that).
assert.match(anvil, /const stag=foldStagnation\(rec\.events\(\), rec\.resolve\)/, 'the supervisor folds stagnation over the record');
assert.match(anvil, /if\(stag\.stalled && stag\.signal!=='no-tools'\)/, 'it redirects on repeat/gate-stuck, not the act-or-nudge case');
assert.match(anvil, /if\(mode==='code' && result\.stop!=='done' &&/, 'the supervisor never second-guesses a run that finished done');
assert.match(anvil, /content: stagnationNudge\(stag\)/, 'the redirect message is the tagged coordination nudge');

// C2/C5: the post-run review fork stages skills/facts (never active) and the automatic trigger is
// guarded by the scheduler — a local model defers, an aborted run is skipped.
assert.match(anvil, /async function learnThisRun\(t, rec\)/, 'the explicit review fork exists');
assert.match(anvil, /runLearnReview\(\{ record:\{ events:rec\.events, resolve:rec\.resolve \}, infer:inferViaHost/, 'it reviews the finished record through the model');
assert.match(anvil, /shouldAutoReview\(\{[^}]*outcome:[^}]*stop:/, 'C5 gates the auto-review on the scheduler');
// forward-pass NAF-04: a local model must DEFER, not skip forever (idleMs was hardcoded 0).
assert.match(anvil, /autoReviewTimer=setTimeout/, 'the deferred review is actually scheduled');
assert.match(anvil, /if\(decide\(0\)\.review\) learnThisRun\(t, rec\)\.catch\(\(\)=>\{\}\)/, 'the immediate auto-review stays GATED on the scheduler, not unconditional');
// and it sits AFTER saveRunRecord (the review reads the saved record)
assert.ok(anvil.indexOf('const saved=await saveRunRecord') < anvil.indexOf('decide(0).review'), 'the auto-review runs after the record is saved');

