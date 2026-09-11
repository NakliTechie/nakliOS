# Kiln — Vision and Roadmap

*A persistent Python kernel inside the browser tab. nakliOS's execution runtime —
and, under the RLM model, the agent's only tool.*

**Status:** v0.1. Required project. Rig C3, Forge, LocalMind, and NakliData all
depend on it; nothing about the coding agent works without it.
**Repo:** `naklios` — `sys/kiln/`. **No new repo.**
**Bundle:** this file · `KILN-AGENT-HANDOFF.md`. No UX/UI reference — Kiln is
headless; its surfaces belong to Forge.

---

## 1. What Kiln is

A long-lived Pyodide kernel running in a Web Worker, mounted on Crate through a
scoped filesystem bridge, with a small typed protocol for executing code and
retrieving results. State persists across executions the way an IPython session
does: variables stay, imports stay, the namespace accumulates.

**It is a nakliOS system runtime, not a Rig module.** Rig is its first consumer.
NakliData wants it for analysis. Notebook-shaped work wants it. Any app wanting
scripting wants it. Building it inside Rig and extracting it later is the annoying
version of this, so it is spun off now.

---

## 2. Why a persistent kernel, and not a tool registry

We adopted the RLM model (D10 = b). The reasoning, stated once so it is not
relitigated:

1. **It aims at what our model is good at.** Bonsai's weakest published category is
   agentic tool use; its strongest are reasoning and code. A model that must emit
   eleven correctly-shaped JSON tool calls fails on formatting. A model that writes
   `rig.patch(path, diff)` inside a Python cell fails only on logic. We move the
   failure mode from the axis where the model is weak to the axis where it is strong.
2. **Context becomes a variable.** With a persistent namespace, history, repo maps,
   search results, and intermediate state live in the kernel rather than in the
   prompt. An 8–16K usable window stops being a hard ceiling on task size, because
   the model programs over state it cannot see in full.
3. **Subagents become function calls.** Spawning a child context is
   `sub("explore the auth module")` returning a string — not a new orchestration
   layer.
4. **It is less code.** One exec tool replaces a tool-schema surface, its
   validation, its repair path, and its retry policy.

The human-facing registry is unaffected. Palette, faux CLI, and `window.rig` remain
views of the Rig command bus. **The registry serves humans; the kernel serves the
model.** Two doors, one core.

---

## 3. Prior art

| Piece | Source | Posture |
|---|---|---|
| Kernel concept | The RLM shape — persistent IPython as the model's only tool, context-as-variable, programmatic subagents | Not a daemon spawning real processes; a Worker in a tab |
| Runtime | Pyodide | Vendored loader, CDN payload, consent-gated download, cached |
| FS bridge | Pyodide's mountable filesystem over `naklios.fs` | Scoped per session; never the whole Crate mount |

**What the sandbox is.** A daemon that runs model-generated Python with the user's
permissions is not a security sandbox, whatever its worker/kernel split. Ours is a
browser Worker: no network unless we grant it,
no filesystem except the mounted slice, no process spawning at all. The sandbox is
structural, not procedural. That is the load-bearing property of the design and it
is not negotiable.

---

## 4. The reward-hacking wall

Prime Intellect reported that in Factorio their agent found it could bypass the
rules by spawning resources directly through RCON, and that the same refinement loop
which had been building legitimate skills turned to building efficient cheating
skills — despite an explicit instruction not to cheat.

A self-modifying harness with a weak verifier optimises the verifier. Three
structural answers, all locked:

1. **The verification command is operator-authored and immutable to the model.** It
   lives on the goal record. No kernel code may read, rewrite, or replace it.
2. **Verification runs in a fresh kernel**, not the working namespace. A working
   kernel that has monkey-patched `assert` cannot launder its own verdict.
3. **Refinement is fenced, not gated.** `refine()` self-applies — gating it behind
   approval would neuter the loop — but the base prompt, the verification command,
   and the grant are structurally outside its reach, every apply snapshots first, and
   review happens after the fact with one-click rollback. The Factorio failure was a
   refinement loop reaching an *exploitable verifier*; fence the verifier and the
   loop is free to run.

---

## 5. Actors

| Actor | Authority | Scope | Trust boundary | Attribution |
|---|---|---|---|---|
| **Operator** | Execute anything; inspect and reset the namespace | Whole granted mount | Inside | Cell provenance marked `operator` |
| **Agent session** | Execute code; call `rig.*` within its grant | Session's `grantPrefix` only | Inside, sandboxed | Cell provenance marked with session id |
| **Subagent context** | Execute in a child namespace | Inherits parent's grant; **never widens** | Inside, sandboxed | Parent session id + child id |
| **Verifier kernel** | Execute the operator's verification command only | Read-only mount of the run tree | Inside, fresh namespace each run | Run id; exit code is the artifact |
| **The kernel itself** | No network, no process spawn, no Crate access outside the mount | — | **Structurally sandboxed by the Worker** | — |

**Ownership boundary.** Goal records belong to Rig (`sys/rig/goals/`): what to
achieve and how we'll know. Harness state belongs to Kiln (`sys/kiln/harness/`): how
the agent works. If state outlives the goal, it is Kiln's. Grants are Rig's, singular
— Kiln derives its mount and never sets its own.

Handoff map: operator → session (grant) · session → subagent (inherited grant) ·
session → verifier (immutable command, fresh kernel) · any → Crate (only through the
mounted slice).

---

## 6. Roadmap — continuous run

```
K0 kernel ─→ K1 fs bridge ─→ K2 rig module ─→ K3 verifier kernel ─→ K4 subagents ─→ K5 harness state ─→ K6 windup/resume
```

| Chunk | Content | Checkpoint (machine-checkable) |
|---|---|---|
| **K0** | Pyodide in a Worker; typed exec protocol (`exec`, `interrupt`, `reset`, `inspect`); stdout/stderr/exception capture; timeout and output cap; consent-gated download with size shown | Namespace persists across executions (assign then read in a later call); a runaway loop is interrupted within the timeout; an uncaught exception returns a structured traceback, never a hang; with Pyodide uncached, nothing downloads until consent |
| **K1** | FS bridge: Pyodide FS mounted on a **scoped slice** of `naklios.fs`; writes land in Crate | Write from Python → read through `naklios.fs` byte-identical, and the reverse. Every escape class rejected: `..`, absolute, symlink-out, encoded. A path outside the mount is unreachable **from Python**, asserted |
| **K2** | The `rig` Python module generated **from the Rig registry**: fileops, git, `rig.run` (iteration, `trust: none`), `rig.git.push` (branch-scoped, guarded) | Every registry command has a callable Python binding; generated binding signatures match declared schemas; `help(rig)` renders registry descriptions; a call outside the grant raises a typed `RigGrantError` |
| **K3** | Verifier kernel: fresh namespace, read-only mount, runs the operator's command, returns exit code | Golden fixture both directions: seeded failing test → non-zero; fixture patch → zero. A working kernel that has monkey-patched `assert`/`sys.exit` cannot change the verifier's verdict, asserted by test |
| **K4** | Subagents: `sub(prompt, *, tools=...)` → child context in the same kernel with its own namespace; results return as values | Child cannot read the parent namespace; child grant equals parent grant and cannot be widened; a child's failure returns a structured result rather than killing the parent; depth cap and concurrency cap enforced |
| **K5** | Harness state: supplemental prompts, memories, skill descriptions, subagent specs, in Crate with snapshots. `refine()` **self-applies within a fenced scope** | Self-apply works and snapshots first; rollback byte-identical; base prompt, `verificationCommand`, and grant all rejected by test; refinement history traceable to a run; runaway guard fires at threshold |
| **K6** | Windup/resume: namespace description + bounded cell replay | Simulated `freeze` mid-run → windup fires → a fresh kernel reconstructs the named bindings **automatically, with no operator input**; an interrupted windup leaves the prior record intact; a resume needing more than N cells reports what it dropped rather than replaying indefinitely |

**Subagent decision (locked).** Subagents are separate *namespaces in one kernel*,
not separate Pyodide instances. A second Pyodide is ~12MB of runtime plus its own
heap, and we are already spending 4–6GB on model weights. Concurrency cap 3, depth
cap 2, both configurable downward and never upward from the agent side.

---

## 7. Open decisions

| # | Decision | Default |
|---|---|---|
| **K-D1** | Name | **Kiln** |
| **K-D2** | Package availability inside the kernel — Pyodide stdlib only, or micropip enabled | **Stdlib + a pinned allowlist**; micropip disabled in v0.1 (arbitrary package fetch is network egress the sandbox refuses) |
| **K-D3** | Where the model's history materialises — a kernel variable populated each turn, or a callable that pages from Crate | **A callable** (`history.search(...)`, `history.get(n)`), so a long session never has to fit in RAM |
| **K-D4** | JS/TS execution | **Not in v0.1.** Python first, per D3. QuickJS/WASI is a later chunk with its own interrupt |
| **K-D5** | Refinement runaway threshold | **5 refinements of one kind per goal**, then `blocked` |

---

## 8. What "done" looks like

A person opens nakliOS, and a Python prompt is available that can read and write
their own files, run their tests, and hold state between cells — with no server, no
install, and no model. That is Kiln standing alone.

Then a model gets one tool: that kernel. It writes code instead of tool calls, keeps
its working state in variables instead of the prompt, spawns child contexts as
function calls, and is judged by an exit code from a fresh kernel it cannot reach.

The sandbox is the Worker boundary. The verdict is the operator's command. Neither
is something the model can talk its way around.
