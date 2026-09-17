# The `.anvil/` workspace files

What the app and its modules read from the workspace root, by literal path. Each is a contract with
the project's owner: a file that is read, a folder that is fenced, a JSON the agent must not edit.
Shared prerequisites: the launch in `../README.md`; `__anvil.test.fs` to seed and read back.

### file:.anvil/gate
- **Goal:** the acceptance criterion's home — readable by the agent, writable only by the owner.
- **Source:** `sys/ai/gate.mjs` (`GATE_DIR`, `underGateDir`, `explainGateRefusal`); the grant's `readOnlyPrefixes` at both sites in `apps/anvil/index.html`.
- **Prerequisites:** launch; a criterion armed.
- **Reach and drive:** prompt "Read .anvil/gate/test_x.py, then make it always pass." Also a `>` redirect and `rm` through the shell.
- **Observable success:** the read succeeds; the `edit`, the redirect and the `rm` are each refused `read-only under this grant` with the fence explanation appended; the file is byte-identical after (`__anvil.test.fs.read`).
- **Gotchas:** the fence is the GRANT on the normalised path, never a string match on the command (`guard-at-the-normalised-path`).

### file:.anvil/hooks.json
- **Goal:** pre-tool guards and post-tool commands the project configures run around every tool.
- **Source:** `sys/ai/hooks.mjs` (`parseHooks`, `preToolDecision`, `postToolCommands`), `sys/ai/run-assembly.mjs` (`loadHooks`, `preHookReply`, `postHookNotes`), the Hooks reader (`openHooks`).
- **Prerequisites:** launch; seed `{"preTool":[{"on":"write","pathMatch":"secret*","block":"no secrets"}],"postTool":[{"on":"write","run":"ls"}]}`.
- **Reach and drive:** prompt "Write secret.txt with x" then "Write a.txt with y".
- **Observable success:** the first is refused `[blocked by a project hook] no secrets` before any write; the second's result carries `[hook] ls` with the listing appended; the ⚓ chip is lit; the Hooks pane shows both rules.
- **Gotchas:** a missing file keeps the PREVIOUS run's config (`loadHooks(fs, hooksCfg)`) until reload; the post-hook shell is built only when a rule matched.

### file:.anvil/memory
- **Goal:** the project's facts, one file each, indexed into the context message every run.
- **Source:** `sys/ai/memory-store.mjs` (`MEMORY_DIR`, `parseFact`, `buildMemoryIndex`), the Memory reader.
- **Prerequisites:** launch.
- **Reach and drive:** seed `.anvil/memory/entry-point.md` with frontmatter (`name`, `description`, `type: project`, `status: verified`) and a body, and `.anvil/memory/no-force-push.md` with `type: rule`; start a run; open 🧠.
- **Observable success:** the run's transcript carries the `[coordination] Working context…` message listing the fact (read the record's `run.started`); the reader lists it with its status; a `rule`-typed fact is injected in full, first.
- **Gotchas:** the index is change-gated (`ctxDigest`) — an unchanged store is not re-sent on the next run of the same task.

### file:.anvil/procedural.json
- **Goal:** the procedural prior's edges can be ablated per project without editing code.
- **Source:** `sys/ai/procedural.mjs` (`PROCEDURAL_PATH`, `loadProceduralGraph`, `renderProcedural`), `proceduralPrior` in the app.
- **Prerequisites:** launch.
- **Reach and drive:** seed `{"edges":{"shell-to-verify":{"enabled":false}}}` (the shape `mergeProceduralGraph` reads — a `disable` list is ignored and reported); start a run; read the record's system message. Then seed the file with `{not json`; start another run.
- **Observable success:** the first run's system prompt lacks the shell-to-verify sentence and is otherwise byte-identical to the default (`test-run-assembly` pins the default bytes); the second run starts, its system prompt is the full default, and the log carries the fallback line — no crash.
- **Gotchas:** read once per run, so an edit mid-run takes effect on the next run.

### file:.anvil/search-index.json
- **Goal:** the trigram index persists in the workspace, derived and re-checked on load, and is read-only to the agent.
- **Source:** `sys/rig/fileops/fileops.mjs` (`indexPath`, `indexSave`, the load-time validation), the grant's read-only prefix for it.
- **Prerequisites:** launch; a project with a few files; one `rg` through the shell.
- **Reach and drive:** run `rg -n const` through the shell; read `.anvil/search-index.json` with `__anvil.test.fs.read`; run the same `rg` again; read it again; then prompt "Edit .anvil/search-index.json to be empty".
- **Observable success:** the file exists after the first search and is byte-identical after the second (nothing re-indexed); the model's edit is refused `read-only under this grant` and the file is unchanged. (The search meter itself — `searchStats()` — is not reachable through the door; `sys/rig/fileops/test/search-cost.test.mjs` pins its numbers.)
- **Gotchas:** never re-hashed on load (`plan/missed-invariants.md` 2026-09-09) — the grant is the fence.

### file:.anvil/skills
- **Goal:** the project's skills, one folder each, listed by status and loaded on demand.
- **Source:** `sys/ai/skills.mjs` (`SKILLS_DIR`, `buildSkillsIndex`), `sys/ai/skill-manage.mjs` (`SKILL_FILE`, `SKILL_SHAPE`), the Skills reader.
- **Prerequisites:** launch.
- **Reach and drive:** seed `.anvil/skills/k/SKILL.md` (frontmatter `name`, `description`, `status: active`) and a second with `status: staged`; start a run; open ✨.
- **Observable success:** the context message lists only the active skill; the reader shows both with statuses and lint notes; a fresh browser project is seeded with `working-in-anvil`.
- **Gotchas:** the folder's support files are scanned by the sentinel at load; a failing one quarantines the skill.

### file:.anvil/oplog.jsonl
- **Goal:** the app's OWN state writes, chained (CRIB-D D3, 2026-09-13) — every write of `state.json` and every refused stale write is one hash-chained NDJSON line: the state's lineage, replayable; a torn or tampered log is caught at the line and never extended.
- **Source:** `sys/history/state-oplog.mjs` (`createStateOplog`, `replayStateLog`, over the ledger's `appendEvent`/`verifyChain`); `apps/anvil/index.html` `writeRemoteState` appends under the same Web Lock that serialises the write, tagged with a per-page-load `TAB_ID`.
- **Prerequisites:** launch with a host fs mounted (the log lives next to `state.json`; localStorage-only sessions write no log).
- **Reach and drive:** change anything that saves state (rename a task) twice; read `.anvil/oplog.jsonl` through the host. Then open a second tab on the same project, save there, and save in the first (now stale) tab.
- **Observable success:** two `state.written` lines whose `prev_hash` chain and whose `input.rev` increases; `replayStateLog(text)` → `ok: true`; after the stale save, a `state.refused` line with `{ mine, diskRev }` and no third `state.written` from that tab.
- **Gotchas:** the append is best-effort and never fails or blocks the state write; the module is driven headless in `sys/history/test/state-oplog.test.mjs` and the app wiring is anchored in `scripts/test-run-assembly.mjs` — the lane cannot drive two real tabs. Rotation (2026-09-17): at 2,000 lines the file moves aside to `.anvil/oplog.<ts>.jsonl` (its own chain, untouched) and the live log restarts on an `oplog.rotated` line naming the archive and the hash of its last event; `replayStateLogs` (a module function; the app does not walk archives yet) walks the files in order and checks each link — a forged archive tail breaks the lineage at the link, never silently. Live 2026-09-17: the prod file (`apps/anvil/.anvil/oplog.jsonl`, 16 lines, two tabs) replayed `ok: true` through `replayStateLog` imported in the iframe.

### file:.anvil/memory/proposals.json
- **Goal:** the write-admission gate's negative evidence (PG-A3, 2026-09-17): the project's poison ledger — a hash-chained list of the proposals the owner rejected (fingerprint · label · reason · cool-off) plus the fingerprints of the skills the learn review staged — persisted so a rejection outlives the session, the next review is TOLD what was refused, and an equivalent proposal is never re-proposed. A fact carries its own fingerprint in its frontmatter (`fp:`).
- **Source:** `sys/ai/proposal-fingerprint.mjs` (`createProposalLedger({seed})`, `reject({fp,label,reason})`, `rejectedList`, `filterProposals`), `sys/ai/learn.mjs` (`buildReviewPrompt(record,{rejected})`), `apps/anvil/index.html` (`projectLedger`, `saveLedger`, `rejectProposal`, `activateSkill`, `earnFromRuns`/`earnPass`).
- **Prerequisites:** launch; a run whose review staged a skill or a fact ("Learned from this run — staged for your approval").
- **Reach and drive:** open the Skills pane → the staged skill → `✗ Reject` (or the Memory pane → `✗ reject <fact>`); then run another task that ends the same way and let the review run. Separately: recall the same hypothesis fact in two tasks whose gate passes.
- **Observable success:** the file appears with one `proposal.rejected` event; the rejected skill file is gone / the fact is `status: retracted`, `cause: rejected`; the next review's prompt (the record's `llm.requested` is a hash — read `rep.prompt` through the door or the log line `N already-rejected proposal(s) skipped`) carries `Rejected by the owner before — do not propose these`; a re-proposal of an equivalent is dropped. After the second verified run: the system row `Earned: <fact> (recalled in 2 runs the gate passed) — now verified.`, the fact `status: verified`, `cause: earned`, the index line `_(earned — recalled in runs the gate passed)_`.
- **Gotchas:** the cool-off is 14 days (`DEFAULT_COOLOFF_DAYS`); a fact staged before 2026-09-17 has no `fp` and rejecting it retracts without poisoning (the row says so); `revise` cannot claim `earned` or `rejected` (system causes); the earn threshold is `EARN_RUNS` = 2 recalls in runs whose record carries a `verify.passed` (the row's `gatePassed`) — an UNGATED finish is `verified: true` on the row and counts for nothing, a recall in a failed run likewise; a task-scoped note never earns; `✗ Reject` on a skill exists only for a skill the review staged (an owner's own re-staged skill has no one-click delete); a ledger file that fails to load is set aside as `proposals.<ts>.corrupt.json` and said, never overwritten in silence; the ledger is saved only into the project it was loaded for.

