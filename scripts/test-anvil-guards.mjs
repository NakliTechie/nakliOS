// Guards the honesty + reachability invariants in Anvil's task loop.
//
// Each assertion below pins a defect that shipped:
//   - a gated pass and "the model stopped calling tools" shared one green dot;
//   - the Must-pass gate was hidden behind a flag seedState() never set;
//   - two of the three gate-command examples could not run in this shell;
//   - five tools returned before the preTool hook guard could see them;
//   - the whole "Learn this project" run emitted no events at all;
//   - the debounced state.json write clobbered other tabs with no lock.
//
// Grep-based, like the other app-contract tests.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const anvil = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

// ── "done" is the verifier's word ───────────────────────────────────────
// Layer 2b: the honest-status rule is no longer inline in the app — status is DERIVED
// from foldStatus, and the rule (gate ∧ verified → done, else unclaimed) lives in
// statusOf. Pin both: the app reads the fold, and the fold encodes the rule.
assert.match(anvil, /t\.status = foldStatus\(recEvents, rec\.resolve, \{ gated \}\)\.status/,
  'the app derives status from the fold, not a parallel computation');
import { readFile as _rf } from 'node:fs/promises';
const runRecord = await _rf(new URL('../sys/history/run-record.mjs', import.meta.url), 'utf8');
assert.match(runRecord, /gated && verified\) \? 'done' : 'unclaimed'/,
  'the fold keeps the rule: a done stop without a green gate is unclaimed, not done');
assert.match(anvil, /const gated = !!String\(\(t\.verifyCmd\|\|''\)\)\.trim\(\)/,
  'gated is derived from the task\'s own verify command');
assert.match(anvil, /\.dot\.unclaimed\{/, 'unclaimed has its own dot style');
// Shape, not colour alone, must carry the distinction.
assert.match(anvil, /\.dot\.unclaimed\{background:transparent;box-shadow:inset/,
  'the unclaimed dot is a hollow ring, not a second solid colour');
assert.ok(!/if\(result\.stop==='done'\) state\.proven = true/.test(anvil),
  'the progressive-reveal flag is gone');
// No CODE reader may remain (the surviving mentions are comments explaining why).
const provenCode = anvil.split('\n').filter(l => l.includes('state.proven') && !l.trim().startsWith('//'));
assert.equal(provenCode.length, 0, `no code reader is left behind for state.proven: ${provenCode.join(' | ')}`);

// ── the gate is always reachable ────────────────────────────────────────
assert.match(anvil, /g\.hidden = false;/, 'the Must-pass gate is always visible');

// ── the gate examples must be runnable in the Forge browser shell ───────
const promptLine = anvil.match(/const v=prompt\('Gate command[^\n]*/)[0];
assert.ok(!/pytest/.test(promptLine), 'no pytest example (Kiln is stdlib + a pinned allowlist)');
assert.ok(!/"sh /.test(promptLine) && !/sh check\.sh/.test(promptLine),
  'no `sh` example (`sh` is not a shell builtin — exit 127)');
assert.match(promptLine, /python /, 'at least one runnable python example remains');

// ── every tool passes the hook guard ────────────────────────────────────
// The guard must sit above the first early-returning Anvil-layer tool.
const execIdx = anvil.indexOf('const executeTool = async (nm, ar, callObj)=>{');
const guardIdx = anvil.indexOf('preToolDecision(hooksCfg, nm, ar)', execIdx);
const firstToolIdx = anvil.indexOf("if(nm==='skill')", execIdx);
assert.ok(execIdx >= 0 && guardIdx > execIdx, 'the hook guard is inside executeTool');
assert.ok(guardIdx < firstToolIdx,
  'the hook guard runs BEFORE skill/recall/remember/revise/synthesize can return');
// Exactly one guard site — the old one was removed, not duplicated.
assert.equal((anvil.match(/preToolDecision\(hooksCfg/g) || []).length, 1,
  'the hook guard is not evaluated twice per call');
// Write-capable tools are refused outright outside code mode.
assert.match(anvil, /mode!=='code' && \(nm==='remember'\|\|nm==='revise'\|\|nm==='synthesize'\|\|nm==='skill_manage'\)/,
  'the write-capable tools are mode-gated defensively');

// ── priming is visible ──────────────────────────────────────────────────
const prime = anvil.slice(anvil.indexOf('You are PRIMING'), anvil.indexOf('You are PRIMING') + 2500);
assert.match(prime, /onEvent:\(e\)=>/, 'the priming run reports its tool calls');
assert.match(prime, /e\.type==='tool-call'/, 'priming surfaces tool calls');
assert.match(prime, /e\.type==='tool-error'/, 'priming surfaces tool errors');

// ── the shared state write is serialised and refuses to clobber ─────────
assert.match(anvil, /navigator\.locks\.request\('anvil-state'/,
  'the remote state write is serialised with Web Locks');
assert.match(anvil, /if\(disk && diskRev>mine\)/,
  'a stale tab detects that another tab is ahead');
assert.match(anvil, /did NOT overwrite it/, 'and says so instead of losing the other tab\'s work');
assert.match(anvil, /state\.rev=mine\+1/, 'a successful write advances the revision');
// The lock must not be assumed present.
assert.match(anvil, /navigator\.locks && navigator\.locks\.request/, 'Web Locks are feature-detected');

// ── an app must never await the host forever ────────────────────────────
// A permission prompt that never resolved used to hang the agent with no error;
// the loop's wall-clock budget cannot help, because it is only checked between
// turns. Every inference call is bounded and abortable.
assert.match(anvil, /const INFER_TIMEOUT_MS = \d+/, 'inference has a deadline');
assert.match(anvil, /withDeadline\(ai\.chat\.completions\.create\(req\), signal\)/,
  'the host call runs under the deadline + abort signal');
assert.match(anvil, /async function inferViaHost\(\{ messages, tools, maxTokens, signal \}\)/,
  'inferViaHost accepts the run\'s abort signal');
assert.match(anvil, /if\(signal && signal\.aborted\) throw new Error\('aborted'\)/,
  'a retry loop re-checks abort before each attempt');
assert.match(anvil, /if\(\/\^aborted\$\/\.test\(s\)\) throw e;/,
  'an abort is surfaced immediately, never retried as a transient fault');

// ── a run in flight must be visible ─────────────────────────────────────
assert.match(anvil, /e\.type==='turn-start'/, 'Anvil renders the turn-start placeholder');
assert.match(anvil, /thinking… \(step /, 'the placeholder names the step');
assert.match(anvil, /const clearThinking=\(\)=>/, 'the placeholder is cleared by whatever the turn produces');
// Orphan tool events are real (task_done emits only a result; bad arguments only
// an error) — dropping them made those paths invisible. Scope to the task loop's
// own handler: primeProject has a separate, simpler one.
const loopStart = anvil.indexOf('const onLoopEvent=(e)=>{');
assert.ok(loopStart > 0, 'the task loop event handler exists');
const onLoopEvent = anvil.slice(loopStart, anvil.indexOf("e.type==='error'", loopStart));
for (const [evt, label] of [['tool-result', 'result'], ['tool-error', 'error']]) {
  const branch = onLoopEvent.match(new RegExp(`e\\.type==='${evt}'\\)\\{[^\\n]*`));
  assert.ok(branch, `the loop handles ${evt}`);
  assert.match(branch[0], /else \{ t\.log\.push\(\{k:'tool'/,
    `a ${evt} with no preceding tool-call still renders`);
}

// ── the wall clock must fit a local model ───────────────────────────────
assert.match(anvil, /wallClockMs: 900000/, 'the task budget allows a slow local endpoint to finish a turn');

// B6: a dispatch/review subagent gets a RAW makeToolExecutor over its overlay (spawnIsolated),
// not the app's executeTool wrapper — so remember / skill_manage / history / checkpoint (which
// live only in the wrapper) do not exist for a subagent. A subagent's memory write cannot land
// anywhere because the tool is not there; the overlay-copy question is moot. Answer recorded, no code.
assert.match(anvil, /const executor = makeToolExecutor\(\{ shell: oshell, face: oface, mode:'code', infer: inferViaHost, subagentDepth: 1 \}\)/, 'a subagent executor is a raw makeToolExecutor over its overlay');
assert.ok(!/nm==='remember'/.test(anvil.slice(anvil.indexOf('async function spawnIsolated'), anvil.indexOf('const baseExec'))), 'the subagent factory adds no remember handler');

// ── the boot error net ────────────────────────────────────────────────────
// The whole app is one module script with a long static import list, and the
// markup is already painted before it runs. A failed import or a throw during
// boot therefore leaves a UI that looks alive and answers nothing. The net must
// be a CLASSIC script placed BEFORE the module, or it is not installed when the
// module is the thing that fails.
{
  const netAt = anvil.indexOf('window.__anvilBoot');
  const moduleAt = anvil.indexOf('<script type="module">');
  assert.ok(netAt > 0, 'the boot error net exists');
  assert.ok(moduleAt > 0 && netAt < moduleAt, 'the net is installed before the module script it guards');
  const net = anvil.slice(netAt, moduleAt);
  // Capture phase: a script that fails to LOAD fires a non-bubbling error event on
  // the element, which a plain window listener never sees.
  assert.match(net, /addEventListener\('error',[\s\S]*?,\s*true\)/, 'the error listener runs in the capture phase');
  assert.match(net, /addEventListener\('unhandledrejection'/, 'a rejected boot is caught too');
  assert.match(net, /setTimeout\(/, 'a boot that neither finishes nor throws is still reported');
  assert.match(anvil, /window\.__anvilBoot\.ok = true/, 'a completed boot stands the net down');
  assert.ok(anvil.indexOf('window.__anvilBoot.ok = true') > moduleAt, 'the stand-down is inside the module, not beside it');
}

console.log('anvil-guards: honesty, reachability, hook coverage, single-writer state, bounded inference and run visibility all hold');
