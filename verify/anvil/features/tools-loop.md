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
