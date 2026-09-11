# Kiln — Agent Handoff

*Read `KILN-VISION-AND-ROADMAP.md` first. This is the build contract.*

---

## 0. How to run this

**Continuous run.** Chunks in order, green checkpoint → proceed immediately. No
milestone stops. The only stops are the three standing interrupts: a conflict with a
locked decision, a dependency not in §2, or scope ambiguity that changes the product.

**Loop discipline.** Maker never grades its own homework — verification in a fresh
context. "Done" is the verifier's word. The checker's first question is whether the
goal was gamed; a skipped or deleted test turning the suite green is a hard fail.
No-progress exit at three repeats; per-chunk budget cap as the second exit. Isolated
git worktree. Every run writes the state file.

---

## 1. Repo, build, deploy

| | |
|---|---|
| Repo | `naklios`. Path `sys/kiln/`. **No new repo** |
| Build step | None. Vanilla ESM, no bundler, no framework |
| Surfaces | None. Kiln is headless; Forge owns every pixel |
| Browser floor | Chromium 121+. Firefox/Safari must load the kernel or fail with one honest line — never an error wall |
| Deploy | Cloudflare Pages, with the rest of nakliOS |

---

## 2. Dependencies

| Dep | Chunk | Notes |
|---|---|---|
| `pyodide` | K0 | CDN payload, pinned version, cached after first load. **Never auto-download** — show the size, ask, cache |

Nothing else. No micropip in v0.1 (K-D2). QuickJS, WASI, `esbuild-wasm` are out of
scope and each is a separate interrupt.

---

## 3. K0 — Kernel

A Worker hosting Pyodide, with a typed message protocol.

```
exec(cellId, code, {timeoutMs, outputCapBytes, provenance})
  → {status: ok|error|timeout|interrupted, stdout, stderr, result, traceback?, ms}
interrupt(cellId)     reset({keepMounts})     inspect(name)     listNames()
```

**Rules.**
- The namespace persists across `exec` calls. Assignments, imports, and definitions
  survive. This is the whole point; a stateless eval is a failed chunk.
- Every execution carries `provenance` — `operator`, a session id, or a subagent id —
  recorded with the cell.
- Timeout and a hard output cap on every call. A runaway loop is interrupted and
  reported; never a hung tab, never an unbounded string.
- Exceptions return a structured traceback as data. **Never throw across the Worker
  boundary**; expected conditions are typed results.
- The Worker has no network access granted and no ability to spawn processes.
  Do not add either.
- Pyodide is large: show the size, ask, cache. Until cached, Kiln reports
  unavailable in one line and every other nakliOS surface is unaffected.

**Checkpoint K0.** Assign in one `exec`, read in a later one — value persists. A
`while True:` loop is interrupted within the timeout and the kernel remains usable
afterwards. An uncaught exception returns a traceback, not a hang. With Pyodide
uncached and consent withheld, no network request is made.

---

## 4. K1 — Filesystem bridge

Mount a **scoped slice** of `naklios.fs` into the Pyodide filesystem.

- The mount is a path prefix, set at session start. The kernel sees that subtree and
  nothing above it.
- Writes from Python land in Crate through the same `naklios.fs` ingress validator
  used everywhere else. **One door, and it checks coats** — Python is not a second
  door.
- Path normalisation and escape rejection happen at the bridge, not deeper: `..`,
  absolute paths, symlink-out, and URL-encoded variants all fail closed.
- Binary-safe both directions.
- Large files stream; never load a tree into the Worker heap.

**Checkpoint K1.** Write from Python → read via `naklios.fs`, byte-identical; and
the reverse. Every escape class rejected **from inside Python** — not merely at the
JS API. A file one level above the mount is provably unreachable.

---

## 5. K2 — The `rig` module

Python bindings generated **from the Rig command registry**. Not hand-written.

```python
rig.read("src/main.py")            rig.write("src/x.py", text)
rig.patch("src/x.py", diff)        rig.grep("TODO", glob="*.py")
rig.git.status()                   rig.git.diff("HEAD~1")
rig.git.commit("message")          rig.git.log(n=10)
rig.run("pytest -q")               # iteration run — untrusted by construction
rig.git.push(branch)               # gated; see §5b
```

### The two kinds of run — the distinction that matters

`rig.run` is restored and is **essential**: an agent that cannot run a test until Rig
decides to check the goal is debugging blind, and the red→green loop is the product.
What must be unreachable is the *verdict*, never the *ability to run code*.

| | **Iteration run** (`rig.run`) | **Verification run** (K3) |
|---|---|---|
| Called by | The model, freely, any time | Rig's goal machinery only |
| Kernel | Its own working namespace | Fresh, isolated |
| Command | Anything it wants | The operator's, immutable, unreadable |
| Output is | Information | The verdict |
| Can set `status: done` | **Never** | **Only this** |
| Artifact | `sys/kiln/runs/<id>.json`, marked `trust: none` | Same path, marked `trust: verifier` |

Both write run artifacts; the `trust` field is what separates them and it is set by
the caller, never by the code being run. An iteration run that exits zero proves
nothing to the goal machinery — it is a hint the model uses to decide what to do next.

**Why this is safe without blocking it.** Running Python in the kernel was never
actually preventable — `rig.run` is a convenience over what the namespace can already
do. Removing the wrapper would have bought nothing while leaving the real path open.
The wall is at the verdict, and the verdict lives in a kernel the working namespace
cannot address.

- The binding layer reads registry metadata and emits functions with matching
  signatures, docstrings from the registry descriptions, and typed exceptions.
  A new Rig command yields a new Python function with no Kiln change.
- `help(rig)` and `help(rig.git.diff)` render registry metadata. **No hand-written
  help strings anywhere.**
- Grant violations raise `RigGrantError` with the attempted path and the active
  grant. Never a silent no-op, never a bare exception.
- Destructive commands return a **staged proposal object**, not a completed action.
  The operator accepts through Forge. Calling `rig.git.commit(...)` stages; it does
  not commit.

**Checkpoint K2.** Every registry command has a callable binding; generated
signatures match declared schemas (asserted by a generated test); `help` renders
registry text; an out-of-grant call raises `RigGrantError`; a destructive call
returns a proposal and leaves the tree hash unchanged.

---

## 6. K3 — Verifier kernel

The wall against reward hacking. Build it exactly as specified.

- Verification runs in a **fresh kernel with a clean namespace**, never the working
  one.
- The mount is **read-only** and covers only the run tree.
- The command comes from the goal record's `verificationCommand`, which is
  operator-authored. **Kernel code cannot read, write, or influence it** — it is not
  exposed in the `rig` module, not in harness state, not in any variable.
- The artifact is `{exitCode, stdout, stderr, ms, inputTreeHash}`, persisted to
  `sys/kiln/runs/<runId>.json`.

**Checkpoint K3.** Golden fixture both directions: seeded failing test → non-zero
with the failure named in stderr; fixture patch applied → zero. **Adversarial test,
required:** a working kernel that has monkey-patched `assert`, `sys.exit`, and the
test runner's entry point still produces a truthful verdict from the verifier
kernel. If this test does not exist, the chunk is not green.

---

## 7. K4 — Subagents

```python
result = sub("Find every call site of parse_config and summarise the signatures")
results = sub_many([...])   # concurrency-capped
```

- A subagent is a **separate namespace inside the same kernel**, not a second
  Pyodide. Locked decision — a second runtime is ~12MB plus its own heap, and model
  weights already own the memory budget.
- Child cannot read or write the parent namespace. Isolation is asserted, not
  assumed.
- Child inherits the parent's grant exactly. **Never widens it**, regardless of the
  prompt.
- Concurrency cap 3, depth cap 2. Both may be lowered by the operator and never
  raised from inside the kernel.
- A child failure returns a structured result; it never kills the parent.
- Every child execution carries its own provenance into the op-log.

**Checkpoint K4.** Namespace isolation asserted both directions. A child attempting
to widen its grant raises. Depth and concurrency caps enforced by test. A child
raising an exception returns a result object and the parent continues.

---

## 8. K5 — Harness state

The harness is a persisted, refinable record; one point below is deliberate.

**Persisted in Crate** (`sys/kiln/harness/`): supplemental prompts, memories, skill
descriptions, subagent specifications. Snapshotted on every accepted change.

```python
refine(kind, content, evidence)   # applies within scope; snapshots; logs
```

**Self-applying, within a fenced scope.** The agent refines its own harness state
during a run without waiting on the operator — that is the mechanism, and gating it
behind approval would neuter the loop. Safety comes from *what it can reach*, not
from a human in the path.

| Kind | Self-apply | Note |
|---|---|---|
| Memory | **Yes** | Facts learned about this repo |
| Skill description | **Yes** | Reusable procedure, described |
| Subagent spec | **Yes** | How to brief a child context |
| Supplemental prompt | **Yes** | Layered above the base |
| Base system prompt | **No** | Immutable. Write attempt rejected |
| `verificationCommand` | **No** | Unreachable — cannot be named, wrapped, or shadowed |
| Grant / mount | **No** | Rig's, singular |

**Rules.**
1. **Every apply writes a snapshot first.** Rollback restores byte-identically.
   Nothing is destructive; the history is the safety net rather than the approval.
2. **The three fenced items above are outside scope entirely** and rejection is
   structural, not advisory.
3. **Refinement history is readable and reviewable after the fact**: what changed,
   when, on what evidence, and which run applied it. Forge's refine tray shows applied
   refinements with a one-click rollback — review-after, not approve-before.
4. **A refinement is scoped to the repo by default.** Promotion to personal or global
   scope is an operator action.
5. **Runaway guard:** more than N refinements of the same kind within one goal sets
   the goal to `blocked` with the refinement trail. A loop that spends its time
   rewriting itself instead of the code has stopped making progress, and the
   no-progress exit applies to refinement as much as to failing tests.

**Checkpoint K5.** Self-apply works and snapshots (asserted). Base-prompt,
verification, and grant writes rejected by test. Snapshot → rollback byte-identical.
Refinement history readable and each entry traceable to a run. Runaway guard fires at
the threshold.

---

## 5b. Agent push

Push is available to the agent, with four structural guards. The reasoning: an agent
that can open a branch and let CI run is worth far more than one that stops at a
staged diff, and the risk is bounded by what it can push *to*.

1. **Never the default branch.** Push targets a branch matching the session or goal
   id (`agent/<goalId>-<n>`). Pushing to `main`, `master`, or any configured protected
   ref is rejected at the Transport layer, not by prompt.
2. **Never force.** `--force` and `--force-with-lease` are unavailable to any actor in
   v0.1. Non-fast-forward pushes are rejected.
3. **Requires the bridge or a scoped token.** No egress path, no push — and the
   failure is one honest line, not a hang.
4. **Boundary notice fires once, before the first agent push**, naming the remote. The
   operator can revoke agent push in one action thereafter.

The op-log records every push with the session identity, the branch, and the ref. An
agent push is a visible, reversible, branch-scoped act — not a merge and not a deploy.

---

## 8b. Boundary — goal record vs harness state

Both are persisted agent memory, so the line is stated once, here and in Rig, and not
relitigated:

| | Goal record (**Rig** owns, `sys/rig/goals/`) | Harness state (**Kiln** owns, `sys/kiln/harness/`) |
|---|---|---|
| Scope | One task | Across all tasks |
| Author | Operator | Agent proposes, operator accepts |
| Contains | Objective, verification command, plan, tried-trail, budget, grant | Supplemental prompts, memories, skill descriptions, subagent specs |
| Lifetime | Dies when the goal closes | Accumulates |

**Rule:** *what to achieve and how we'll know* is Rig's. *How the agent works* is
Kiln's. If a piece of state would still matter after this goal closes, it belongs to
Kiln. Kiln never writes a goal record; Rig never writes harness state.

**Grants are Rig's, singular.** Kiln derives its mount from the Rig grant and never
sets, widens, or caches its own. Two enforcement points, one source — otherwise they
drift, and the drift is a security hole.

---

## 8c. K6 — Windup and resume (kernel side)

Rig owns the goal record and its `workingSet`; Kiln owns what a *namespace* needs to
come back. Two things, both required:

1. **A serialisable summary, not a memory image.** Pyodide heaps are not portable and
   attempting to snapshot one is a trap. On windup, emit a compact description of the
   namespace: names bound, their types, a short repr, and — critically — **the cells
   that produced them**. Resume replays the cells it needs rather than restoring state
   it cannot.
2. **Cell log with provenance**, persisted continuously (not only on windup), so a
   resume can reconstruct by replay and a reader can see how a namespace got the way
   it is.

**Triggers** are Rig's (`visibilitychange`, `freeze`, `pagehide`, context pressure,
budget pressure, explicit). Kiln responds to a `windup()` call; it does not listen for
lifecycle events itself.

**Resume is automatic.** No brief, no prompt, no waiting. Rig calls `resume(record)`
and the kernel reconstructs. Reporting what it reconstructed — and what it dropped —
is a return value, not a question.

**Atomicity.** Write to a temp key and swap. An interrupted windup leaves the previous
state intact — a half-written namespace description is worse than a stale one.

**Checkpoint K6.** Bind values across several cells → windup → fresh kernel → resume →
the named values are present with the same types and reprs. An interrupted windup
leaves the prior record byte-intact. Replay is bounded: a resume that would need more
than N cells reports what it dropped rather than replaying indefinitely.

---

## 9. Security posture

- The Worker is the sandbox and it is structural. **No network grant, no process
  spawn, no filesystem beyond the mount.** Do not add any of the three.
- No `unsafe-eval` in the main document. Python evaluation lives in the Worker,
  which is exactly why the boundary exists.
- Credentials never enter the kernel namespace, a run artifact, harness state, or a
  traceback. Redact token-shaped strings by pattern before any write.
- Tracebacks are data crossing a boundary: sanitise paths and strip anything
  secret-shaped before they reach the UI or the op-log.

---

## 10. Hard rules — what NOT to do

1. **Do not grant the Worker network access** or add `micropip` in v0.1.
2. **Do not spawn processes.** There is no shell here and there will not be one.
3. **Do not mount more than the granted slice**, and never the whole Crate mount.
4. **Do not hand-write the `rig` bindings or their help text.** Generate from the
   registry.
5. **Do not run verification in the working kernel.**
6. **Do not expose `verificationCommand` to kernel code** in any form, and do not
   let an iteration run's exit code reach the goal record's `status`.
6b. **Do not let `rig.run` execute in, or write to, the verifier kernel.**
6c. **Do not allow agent push to a default or protected branch, and do not implement
    force-push for any actor.**
6d. **Do not write goal records from Kiln**, and do not let Kiln set or widen a grant.
7. **Do not let a self-applied refinement touch the base prompt, the verification
   command, or the grant** — those three are outside the self-apply scope entirely.
8. **Do not let a subagent widen an inherited grant.**
9. **Do not use a second Pyodide instance for subagents.**
10. **Do not throw across the Worker boundary.** Typed results only.
11. **Do not auto-download Pyodide.**
12. **Do not copy third-party agent-harness code into the repo.** Port semantics.
13. **Do not skip, delete, or weaken a test to make a checkpoint pass** — least of
    all the K3 adversarial test.

---

## 11. Gate artifacts

| Chunk | Artifact |
|---|---|
| K0 | Namespace-persistence transcript + interrupt log + no-consent-no-fetch network trace |
| K1 | Byte-identical round-trip hashes + escape rejection matrix (from Python) |
| K2 | Generated binding manifest + schema-match assertions + `RigGrantError` cases |
| K3 | Golden red→green pair **+ the monkey-patch adversarial transcript** |
| K4 | Isolation assertions + grant-widening rejection + cap enforcement log |
| K5 | Proposal-never-applies assertion + snapshot/rollback hash + verification-untouchable test |

State file updated on every run.

---

## 12. Escalation

Standing interrupt or no-progress exit: write the tried-trail to the nakliOS state
file, leave partial work in the worktree unmerged, escalate with numbered options
and trade-offs.
