# The loop's own tools

Handled by `runAgentLoop` (`clarify`, `task_done`) or by the executor's subagent paths (`task`,
`dispatch`, `review`). `task_done` exists only when a gate is armed (`runToolset(mode,{verify:true})`).
Shared prerequisites: the launch in `../README.md`; a gate armed with
`__anvil.test.armGate({file:'test_x.py', source:'<two independent assertions>'})` where the recipe
says "gated" (the lint refuses a one-assert or `__eq__`-defining criterion — that refusal is
`features/test-door.md` `hook:armGate`).

### tool:clarify
- **Goal:** the model asks the owner one question and the run pauses; the next Send is the answer.
- **Source:** `sys/ai/agent-loop.mjs` (`clarifyTool`, the `clarify` intercept → `stop:'clarify'`); the app's `admitRun` + held state (`sys/ai/followup-queue.mjs`).
- **Prerequisites:** launch; a prompt with a real ambiguity ("Rename the config file to what the team prefers").
- **Reach and drive:** send the ambiguous prompt; wait for the ❓ system row; send an answer.
- **Observable success:** the record ends the first loop with `run.stopped` `stop:'clarify'` and a `clarify` event carrying the question; the log shows "❓ … (the run is paused — your next message is the answer)"; the next Send resumes in the same task and the answer is the next user turn in the transcript.
- **Gotchas:** an empty question is refused as `invalid_args` and the run continues; `clarify` is never pooled with reads (F9).

### tool:task
- **Goal:** a bounded sub-task runs in a fresh context over the SAME workspace and hands back a digest; its record lands on the parent's chain.
- **Source:** `sys/ai/agent-tools.mjs` (`taskTool`, `runRecorded`, `SUBAGENT_MAX_STEPS`), `sys/history/run-record.mjs` (`foldSubagents`, `verifySubagents`).
- **Prerequisites:** launch; the endpoint reachable (a subagent needs `infer`).
- **Reach and drive:** "Use the task tool to have a subagent create notes.md with three bullet points, then read it back yourself."
- **Observable success:** the parent record carries `subagent.started` then `subagent.ran` with a loadable child dump (`loadRecord(entry.dump)` verifies its own chain); the live feed row for the child updates in place (ESS-2); `notes.md` exists; the parent's `read` sees it.
- **Gotchas:** depth cap 1 — a child cannot spawn; a child's own memory writes are impossible (raw executor, no store tools). Budgets per call (`max_steps`, `wall_clock_s`) are clamped and stated in the digest.

### tool:dispatch
- **Goal:** several subagents run in parallel, each over a copy-on-write overlay; non-conflicting changes merge back through the audited face; a conflict is reported, not merged.
- **Source:** `sys/ai/agent-tools.mjs` (`dispatchTool`, `spawnIsolated`), `sys/ai/subagents.mjs` (`DISPATCH_MAX`, the child feed), `sys/rig/fileops/overlay-backend.mjs`.
- **B1 liveness (2026-09-13):** while a child runs its feed row reads `live (last event Ns ago)` or, after 90 s of silence, `unverifiable (no event for Ns — … not killed, not re-dispatched)`; the parent chain carries one `subagent.beat` per child turn / tool call, and `foldSubagentFleet(rec.events(), rec.resolve, { now: Date.now() })` types every child `live · unverifiable · exited` with zero model calls (pass `now` for a live reading; without it the clock is the record's last event, right only once the run has stopped). A child that never reports back before the run ends is `unverifiable` in the recovery note, with how long before the end it was last seen — never "exited".
- **B2 completion as a steer (2026-09-13):** `dispatch` no longer waits for the whole cohort. Its tool result is composed at the first of "every child complete" or "the first completion + a 250 ms settle window"; a child still running is listed under `still in flight` and its completion arrives later as a `[coordination] subagent [n] "label" finished — merged | held …` message at the parent's next turn (event `steer`, chain `run.steered`, a system row `⇆ …` in the log). A no-tool-call turn while a child is in flight WAITS (system row `waiting for N subagents …`); `task_done` is answered "Not yet" until they report. Merges are first-come across dispatches: a straggler touching a path anyone merged after it launched is held. A re-dispatch of a label still in flight is refused. The run's signal is aborted when the run ends, so no straggler merges after it. The tool description says the result may be partial — the inventory hash of `tool:dispatch` moved with it.
- **B3 ownership at dispatch (2026-09-13):** a `dispatch` sub-task may carry `target` · `change` · `constraints` · `ownership` (paths / `dir/` prefixes it may WRITE) · `acceptance`; the child is briefed with them (`renderTaskSpec`). Two sub-tasks whose ownership overlaps refuse the CALL before any child runs (`Refused: sub-tasks [1] … and [2] … claim overlapping ownership (…)`); a claim on ownership a still-in-flight child declared is refused for that sub-task and named under `### refused:`; a child that wrote outside what it declared is `held — wrote outside its declared ownership (paths)` — batch and straggler alike, never merged. The tool schema documents the fields; the inventory hash of `tool:dispatch` moved again.
- **#9 snapshot-rooted overlays (2026-09-17):** a child's overlay PINS what it touches — a file read once reads the same bytes for the rest of the run even after the owner edits it or a sibling merges it; a listing or an absence, likewise. At merge the fence compares the base NOW against the pins: a clean child whose WRITTEN path moved in the base is `held — path conflict — the workspace moved under it since it started (paths changed in the base — your own edits, or another writer); un-merging is not possible` (the steer says the same); a child that READ a file that moved but wrote elsewhere still merges, with `· read N files that changed under it since (paths) — its result may rest on stale content` on its digest line / steer. Drive it: dispatch a child that reads `shared.txt` twice with a `sleep 20` between, edit `shared.txt` in the workspace during the sleep — the child's report shows the ORIGINAL both times; if it rewrote `shared.txt` the run is held and the base keeps the edit. Files above 4 MiB, and everything past a 32 MiB per-child budget, are pinned as hashes — reads of those fall through live; the fence still sees them move (it re-hashes). A read-only child gets the same notice on its `no file changes` line. Listings are pinned for the child's view but not fenced.
- **Prerequisites:** launch; code mode.
- **Reach and drive:** "Dispatch two subagents: one writes a.txt with A, the other writes b.txt with B." Then the conflict: "Dispatch two subagents that both write c.txt with different content."
- **Observable success:** both files exist after the first; the digest names each worker's outcome and files; the second reports the conflict and leaves `c.txt` as the merge rule says (first writer, or unmerged with the digest naming it) — read the digest and the file, do not assume.
- **Gotchas:** capped at 4 workers; `dispatch` is exclusive in the F9 pool. A worker's stale edit over a file the parent changed is F8's refusal, inside the worker.

### tool:review
- **Goal:** a read-only reviewer over the current workspace returns findings without changing anything.
- **Source:** `sys/ai/agent-tools.mjs` (`reviewTool`, `REVIEW_SYSTEM`; the reviewer's toolset is `read`, `read_lines`, `shell`, `todowrite` over an overlay).
- **Prerequisites:** launch; a file with an obvious bug seeded.
- **Reach and drive:** "Ask the review tool for a second opinion on bug.js, then fix what it finds."
- **Observable success:** the review digest names the bug with a line; the workspace is unchanged until the parent's own `edit`; the child record is on the parent's chain.
- **Gotchas:** "review stopped with the run" when Stop is pressed mid-review.

### tool:task_done
- **Goal:** the model claims completion; the gate decides. A placeholder summary is bounced; a failing gate feeds its output back; three failed rounds end `unverified`.
- **Source:** `sys/ai/agent-loop.mjs` (the `task_done` intercept, `placeholderSummary`, `runGate`, `maxVerifyRounds`), `sys/ai/agent-tools.mjs` (`makeShellVerifier`), `sys/rig/cli/shell.mjs` + `sys/ai/gate.mjs` (`kilnIsolate` — the gate's python runs on a reset interpreter).
- **Prerequisites:** launch; gated with a two-assert criterion validated red-on-seed / green-on-reference in CPython.
- **Reach and drive:** a task the criterion can pass; then one it cannot (an unsatisfiable but lint-clean criterion); then, gated or not, "Call task_done with the summary 'done' and nothing else."
- **Observable success:** the passing task's record has `verify.passed` and `run.stopped` `stop:'done'`, `foldStatus(gated:true)` → `done`; the failing one shows `verify.failed` rounds 1–3 with the gate's output in the transcript as `[coordination] Gate failed …` and ends `stop:'unverified'`; a `task_done` with summary "done" is refused `invalid_args` and no gate runs.
- **Gotchas:** ungated runs accept `task_done` as-is and end `unclaimed` — the test opt-in warns at start. **Do not quote a gated pass as quality evidence without reading the criterion it passed** (`plan/missed-invariants.md` 2026-09-10).
