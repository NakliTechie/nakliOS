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
