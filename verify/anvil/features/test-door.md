# The test door — `window.__anvil.test`

Present only under the test opt-in (`?anviltest` in the URL or `localStorage['anvil-test']`), on the
iframe's window (`iframe.contentWindow.__anvil.test`). It is the OWNER's programmatic door: the
ungranted fileops edge, the gate, task state, the campaign, synthesis, inference and git. Nothing here
is reachable by the model. Shared prerequisites: the launch in `../README.md`; the recipes below run
from the host page's console or a browser-automation script against the iframe.

### hook:fs
- **Goal:** read, write, list and remove in the workspace through the owner's ungranted edge — including under `.anvil/gate/`, which every agent route refuses.
- **Source:** `apps/anvil/index.html` (`fs:` in the door), `sys/rig/fileops`.
- **Prerequisites:** launch.
- **Reach and drive:** `await t.fs.write('.anvil/gate/x.py','assert 1\n')`, `await t.fs.read('.anvil/gate/x.py')`, `await t.fs.list('.')`, `await t.fs.remove('.anvil/gate/x.py')`.
- **Observable success:** the write lands and reads back; the listing names it; the remove clears it — while the same path through a prompt ("write .anvil/gate/x.py") is refused `read-only under this grant`.
- **Gotchas:** `read` returns the fileops result `{ok, data}`; check `ok`.

### hook:setGate
- **Goal:** set the active task's verify command exactly as the ✓ Must-pass button does.
- **Source:** the door's `setGate`; `t.verifyCmd`; `renderTaskbar`.
- **Prerequisites:** launch; an active task.
- **Reach and drive:** `t.setGate('python .anvil/gate/x.py')`; then `t.taskState()`.
- **Observable success:** `{ok:true, verifyCmd:'python .anvil/gate/x.py'}`; the ✓ chip shows the gate; `taskState().verifyCmd` matches; with no active task `{ok:false, error:'no active task'}`.
- **Gotchas:** this sets the command without authoring a criterion — `armGate` is the honest one-call form.

### hook:armGate
- **Goal:** author a criterion under `.anvil/gate/` AND set the gate in one call; the half-states and a weak criterion are refused before anything is written.
- **Source:** the door's `armGate`; `sys/ai/gate.mjs` (`planGate`, `lintGateCriterion`, `GATE_DIR`).
- **Prerequisites:** launch; an active task.
- **Reach and drive:** `t.armGate({file:'test_x.py', source:'assert type(f()) is int and f() == 42\nassert type(f(1)) is int and f(1) == 43\n'})`; then `t.armGate({file:'t.py', source:'assert 1\n'})`; then `{file:'tests/t.py', …}`; then a source with `__eq__ = lambda s, o: True`.
- **Observable success:** the first returns `{ok:true, path:'.anvil/gate/test_x.py', verifyCmd:'python .anvil/gate/test_x.py', gated:true}` and the file exists; the one-assert source is refused `did not pass the lint: has 1 independent assertion`; the outside path `must live under .anvil/gate/`; the `__eq__` source `defines __eq__`; none of the refused calls writes a file (`t.fs.list('.anvil/gate')`).
- **Gotchas:** the lint reads the criterion FILE only — a solver-side `__eq__` still passes (`plan/missed-invariants.md`).

### hook:taskState
- **Goal:** the active task's id, title, status, gate and mode as the UI holds them.
- **Source:** the door's `taskState`.
- **Prerequisites:** launch.
- **Reach and drive:** `t.taskState()` before and after a run.
- **Observable success:** `{id, title, status, verifyCmd, mode}`; `status` moves `idle → running → idle/done/error` with the run; `null` with no task.
- **Gotchas:** `status` is the fold's word (`foldStatus`), not the loop's; `done` needs a gate.

### hook:goal
- **Goal:** the active task's GOAL row — a projection over the task's run rows (LX-3, 2026-09-17): status in the closed set `active · paused · blocked · budget_limited · complete`, the quota summed over every run (a subagent's spend included — its record rides the parent's chain), and `complete` only with the passing gate's hash as evidence.
- **Source:** the door's `goal`; `goalOf` in `apps/anvil/index.html` (by the task index); `foldGoal`, `foldQuota`, `goalLine`, `GOAL_STATUSES` in `sys/history/run-record.mjs`; the row's `tokens/calls/seconds/evidence/gatePassed/chainOk` from `runIndexRow`; `ROW_SHAPE` + `SHAPE_KEY` for the one-shot re-derive at boot.
- **Prerequisites:** launch; an active task with at least one finished run (a row in the IndexedDB `runs` store).
- **Reach and drive:** `await t.goal()` after a gated run that passed; again after an ungated `task_done`; again after `#stop` mid-run.
- **Observable success:** `{objective, status, why, quota:{tokens, seconds, runs}, evidence, lastRun, since}`; the gated pass folds to `status:'complete'` with `evidence:'sha256:…'` (the line reads `complete ✓`); the ungated finish to `paused` with `why:'unverified — no passing gate on record'` (done is the verifier's word — the owner sets a gate or accepts the claim); the stop to `paused — stopped by the owner`; a row whose chain is broken to `blocked`; `quota.tokens` is the sum of every `llm.responded` count the provider reported, children included (0 when it reported none, the row's `calls` still counted). The same line sits on the task bar (`#tb-meta`, e.g. `complete ✓ · 2 runs · 1.2k tokens · 14s`) whenever the task has at least one run, nothing louder (HOLD / BYPASS) is on and no run is live; `null` with no task; with a task and no rows the door answers `status:'paused', why:'not started'` and the bar shows nothing (nothing to project).
- **Gotchas:** the row is derived — `rebuildIndex` re-derives it from the records, and the first boot after a `ROW_SHAPE` bump re-derives every reachable row once (`[anvil] run index re-derived …` in the console; a home reconnected later re-derives once more, for the rows it holds); a row lands only at the end of a run, so DURING a run `goal()` answers the previous runs (the bar shows the run's own status) — `active` is only what the doctor folds from a record with no `run.stopped` (a run that died mid-flight); the goal never reads a fact or a proposal, only the task's own runs.

### hook:demoCampaign
- **Goal:** the Assay campaign runs offline on scripted roles and reaches a verdict through the Grant wall.
- **Source:** the door's `demoCampaign` → `startCampaign(goal, {live:false})`; `sys/assay/*`.
- **Prerequisites:** launch.
- **Reach and drive:** `await t.demoCampaign()`.
- **Observable success:** the campaign pane shows rounds with findings and directives; the ledger verifies (`verifyWall`, `verifyTests`); no model call is made.
- **Gotchas:** the default goal is `samtools view parity`; pass your own string to change it.

### hook:liveCampaign
- **Goal:** the same campaign on the configured endpoint, bounded by `maxIters`.
- **Source:** the door's `liveCampaign` → `startCampaign(goal, {live:true, maxIters})`.
- **Prerequisites:** launch with a real endpoint (DeepSeek as configured; never Ollama).
- **Reach and drive:** `await t.liveCampaign('add a README with a usage section', 2)`.
- **Observable success:** ≤ 2 rounds, each recorded, the lineage replayable (`replayLineage`); the pane's verdict matches the ledger.
- **Gotchas:** fuel — cap the iterations; a void round (provider returned nothing) is reported, not counted.

### hook:synthesize
- **Goal:** run the evolutionary synthesis directly.
- **Source:** the door's `synthesize` → `runSynthesize`.
- **Prerequisites:** launch on the COI serve; a real endpoint.
- **Reach and drive:** `await t.synthesize('double it', [{input:1,output:2},{input:3,output:6}], 2, 2)`.
- **Observable success:** returns the best program and fitness; `solver.py` written; `t.score` on it → 1.
- **Gotchas:** `popSize`/`maxGen` are clamped to 4.

### hook:score
- **Goal:** score a `solve(x)` source against examples in the Kiln.
- **Source:** the door's `score` → `scoreSolver`.
- **Prerequisites:** launch on the COI serve.
- **Reach and drive:** `await t.score('def solve(x):\n    return x*2\n', [{input:2,output:4}])`; then `await t.score('def solve(x):\n    return 0\n', [{input:2,output:4},{input:3,output:6}])`; then `await t.score('import time\ndef solve(x):\n    time.sleep(30)\n', [{input:1,output:1}])`.
- **Observable success:** `{score:1, detail:{ok:1,total:1,failed:[]}}`; the wrong solver `{score:0, detail:{ok:0,total:2,failed:[0,1]}}`; the sleeping one `{score:0, detail:{timeout:true}}` after about 6 s.
- **Gotchas:** `score:-1` means the kernel threw, not that the solver failed.

### hook:infer
- **Goal:** one bare model call through the host, to prove the endpoint before a run.
- **Source:** the door's `infer` → `inferViaHost`.
- **Prerequisites:** launch with a granted endpoint.
- **Reach and drive:** `await t.infer('Say OK.', 8)`.
- **Observable success:** `{ok:true, content:'OK…', finishReason, toolCalls:0}`; with no grant `{ok:false, error}` naming the refusal.
- **Gotchas:** this is the `plan/bench-playbook.md` SETTINGS check — run it before blaming the model.

### hook:gitClone
- **Goal:** clone a public repository through the sovereign egress into the workspace.
- **Source:** the door's `gitClone` → `git.clone` over `HttpTransport` / `naklios.net.fetch`.
- **Prerequisites:** launch with an egress transport configured (nakli-egress or the local bridge).
- **Reach and drive:** `await t.gitClone('https://github.com/NakliTechie/naklios-sdk-test.git')` (or any small public repo).
- **Observable success:** `{ok:true}` and the files exist; without a transport `{ok:false, error:'no egress transport'}`.
- **Gotchas:** every fetch is Grant-gated (`net:<host>`) and History-logged (host only).

### hook:gitLsRemote
- **Goal:** list a remote's refs through the egress without cloning.
- **Source:** the door's `gitLsRemote` → `git.listServerRefs`.
- **Prerequisites:** as `gitClone`.
- **Reach and drive:** `await t.gitLsRemote('https://github.com/NakliTechie/nakliOS.git')`.
- **Observable success:** `{ok:true, refs:[…]}` naming `refs/heads/main`.
- **Gotchas:** none beyond the transport.

### hook:gitPushTest
- **Goal:** the last unproven hop — init, commit a marker file, push `main` through the egress with the owner's token.
- **Source:** the door's `gitPushTest`.
- **Prerequisites:** launch; a token in Settings → Git auth (the owner's own action — never entered by an agent); a scratch remote you own.
- **Reach and drive:** `await t.gitPushTest('<your scratch remote>', 'm1')`.
- **Observable success:** `{ok:true, oid, marker:'m1', pushErr:null}` and the remote's `main` shows `HELLO.md` with the marker.
- **Gotchas:** OWED and owner-gated (`pending.md` Now); a run without the token returns `pushErr`, which is the honest outcome, not a bug.

### hook:rebuildIndex
- **Goal:** run the run-index doctor — rebuild the IndexedDB `runs` rows from the record files — and read how many rows resumed from their own checkpoint (WIRE, 2026-09-13).
- **Source:** the door's `rebuildIndex`; `rebuildRunIndex`, `runIndexRow`, `foldIndexStatus` in `apps/anvil/index.html`; `sys/history/projection.mjs` (`createProjector`, `restore`/`checkpoint`).
- **Prerequisites:** launch; at least one finished run in the project (a record under `anvil/runs/<project>/<task>/`).
- **Reach and drive:** `await t.rebuildIndex()` twice; between them nothing.
- **Observable success:** `{indexed, broken, resumed, stops, stopsLine}`; the first call has `resumed` ≤ the rows that already carried a checkpoint, the second has `resumed === indexed` — every row's status fold continued from its checkpoint (`rebuilt:false`) and the rows' `status`/`stop` are unchanged between the two calls.
- **Gotchas:** a row whose checkpoint does not fit its record (a bumped `stateVersion`, a witness from another array) is refolded from event zero and counted as not resumed — same status, one more rebuild; that is the design, not a defect.

### hook:runRow
- **Goal:** read one IndexedDB run row by id (`<project>/<task>/<file>.json`) — the row the doctor writes, with its `checkpoint` and `resumed`.
- **Source:** the door's `runRow`; `runsGet`.
- **Prerequisites:** launch; the row exists (after a run or a rebuild).
- **Reach and drive:** `await t.runRow('<project>/<task>/<ts>.json')`.
- **Observable success:** `{id, status, stop, events, checkpoint:{stateVersion, consumed, witness, state}, resumed}`; `checkpoint.consumed === events`.
- **Gotchas:** `null` for an unknown id; the row is derived — the record file is the truth.

### hook:shell
- **Goal:** run one line through the AGENT's shell — the same `createShell` instance a run uses, with its Kiln `python` — so a change under `sys/kiln/` or the shell's `python` branch is proven on real Pyodide (the 2026-09-12 rule) without spending a model call.
- **Source:** the door's `shell`; `shell.feed` in `sys/rig/cli/shell.mjs`; `sys/kiln/main-thread-runtime.mjs` for `python`.
- **Prerequisites:** launch; a mounted workspace (the shell exists once a project is mounted); for `python`, cross-origin isolation (`?anviltest` on the standalone page has it; inside the host the app runs without SAB and `python` is unavailable).
- **Reach and drive:** `await t.shell("python -c \"open('b.bin','wb').write(bytes(range(256)))\"")`, then `await t.shell('ls')`, then read the file's bytes from OPFS.
- **Observable success:** `{output, code, awaitingConfirm}`; `code` is the line's exit code; a `python` line's `output` is the interpreter's stdout+stderr in write order.
- **Gotchas:** a destructive line (`rm`) stages and returns `awaitingConfirm:true` — answer with `t.shell('y')`; the door never auto-confirms (the agent's executor does).
