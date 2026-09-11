# Rig & Forge — Vision and Roadmap

*Rig is the toolroom under nakliOS: files and version control.
Forge is the shell on top of it.
Kiln is the kernel that runs code — and, for the model, is the only tool.*

**Status:** v0.3. Build opens immediately. No deferrals, no park walls.
**Repo:** `naklios` — `sys/rig/`, `apps/forge/`. **No new repo.**

**The four required projects, all v0.1:**

| Project | Doc | Role |
|---|---|---|
| **Rig** | this + `RIG-AGENT-HANDOFF.md` | Fileops, command bus, git, agent face, faux CLI |
| **Kiln** | `KILN-VISION-AND-ROADMAP.md` + handoff | Persistent Python kernel; the model's only tool |
| **Bridge: Git Egress** | `BRIDGE-GIT-EGRESS-SPEC.md` | Real remotes without a third-party proxy |
| **Forge** | `FORGE-UX-UI-REFERENCE.md` + `forge-mockup.html` | The shell, desktop **and** mobile |

Plus `LOCALMIND-CODE-AGENT-HANDOFF.md` — the model side.

---

## 1. The names

| | Rig | Kiln | Forge |
|---|---|---|---|
| Altitude | Substrate (`sys/rig`) | Runtime (`sys/kiln`) | Surface (`apps/forge`) |
| Holds | Files, git, registry, grants, op-log, goal records | Python namespace, subagents, harness state, verifier kernel | Panels, transcript, terminal, goal board |
| Serves | Both faces | **The model** | **The human** |

**D2 resolved.** Forge (May 2026) was specced as a browser-native mobile-first
coding agent with a proposed eighth primitive, Cogitator. The name survives and
moves up a floor. Cogitator is retired — goal records plus Kiln's harness state
supply persistence without a stateful cloud primitive. **Mobile is back in v0.1**;
it was Forge's founding premise and cutting it was wrong.

### The shape, in one picture

```
                    Forge  (apps/forge)      ← the human sits here
                       │
        ┌──────────────┴──────────────┐
        │                             │
      Rig  (sys/rig)  ──generates──▶  Kiln  (sys/kiln)   ← the model sits here
        │                             │
        ├── Crate (files) ────────────┘
        └── Bridge (git egress)        LocalMind ──drives──▶ Kiln
```

**Rig is the nouns. Kiln is the verbs. Forge is the window. LocalMind is the guest.**

| Project | Owns | Does **not** own |
|---|---|---|
| **Rig** | Fileops, command registry, git, path grants, op-log, **goal records** | Execution. Pixels. Models |
| **Kiln** | Python namespace, subagents, **harness state**, verifier kernel | Files (borrows Rig). Grants (inherits). Goal records. The verdict's meaning |
| **Forge** | Every pixel, desktop and mobile | Any capability — it is a view over the registry |
| **Bridge** | Remote git bytes leaving the machine | Local git, which is entirely Rig's |
| **LocalMind** | The model, context strategy, what to write in a cell | Tools. It has exactly one |

**Not in this stack:** Karkhana. General Linux, any binary, v86 speeds — a different
tool for a different job, with no dependency either way.

### Two boundaries stated once

**Goal record vs harness state.** Both are persisted agent memory, so:
*what to achieve and how we'll know* is Rig's goal record (`sys/rig/goals/`, one
task, operator-authored, dies with the goal). *How the agent works* is Kiln's harness
state (`sys/kiln/harness/`, across tasks, agent-proposed and operator-accepted,
accumulates). If state outlives the goal, it is Kiln's.

**Grants are Rig's, singular.** Kiln derives its mount from the Rig grant and never
sets its own. Two enforcement points, one source — otherwise they drift, and the
drift is a security hole.

---

## 2. The position

nakliOS has a filesystem and apps that persist as flat files. It lacks the three
things that make a filesystem a place work happens: a complete file surface, real
version control, and execution. Rig and Kiln supply them. Forge makes them a place
you sit.

**What we are not building.** Not a general process model — Karkhana holds that
ground. Not a shell, not a PTY. Kiln executes *the languages we build in*, at wasm
speed, inside a Worker. Narrow and sandboxed beats general and permissive: the job
is making "tests green" a machine-checkable condition inside a tab, and making it
one the model cannot forge.

---

## 3. Two doors, one core

**D10 resolved: RLM (b).** The model's tool surface is the Kiln kernel. Rig is
exposed to it as a Python module generated from the command registry.

```
                    Rig command registry (typed, serialisable)
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        │                           │                           │
   command palette            faux CLI (xterm)            window.rig
   ⌘K, humans                 /git diff, humans           scripts, MCP
        │                           │                           │
        └──────── the human door ───┴───────────────────────────┘
                                    │
                          generated bindings
                                    │
                            Kiln: rig.git.diff()
                            ──── the model door ────
```

The registry serves humans; the kernel serves the model. Any surface wanting its own
path to capability is a standing interrupt. The rationale for RLM lives in Kiln's
vision doc §2 and is not relitigated here.

---

## 4. Prior art we ride

| Piece | Source | Posture |
|---|---|---|
| Git engine | `isomorphic-git` (MIT) | Adapter to its interface. Never fork |
| Terminal renderer | `xterm.js` (MIT, v6, zero-dep core) | Vendor the ESM build. A screen, not a shell — fed from the registry, never a PTY |
| Python runtime | Pyodide, in a Worker | See Kiln |
| Agent architecture | The RLM shape + a persisted harness (see Kiln) | A Worker with no network and no process spawn — not a daemon running with user permissions |
| Interaction model | Our own | Approval profiles, plan/step decomposition, core↔UI event stream, stale-update protection |

---

## 5. Primitive check

No eighth primitive. Crate holds files. Bridge carries git egress. Vault holds
tokens. Identity signs commits. Sync and Grant stay v1+. Execution is a runtime
(Kiln). Long-horizon persistence is a record, not a primitive.

---

## 6. Role matrix (v0.1)

| Actor | Authority | Scope | Trust boundary | Attribution |
|---|---|---|---|---|
| **Operator** | Everything, including destructive and push | Whole mount | Inside | Git author identity |
| **Agent session** | Execute Kiln code; call `rig.*`; run iteration tests; stage changes; **push to `agent/*` branches only**. Never commits under the operator, never force-pushes, never touches a protected ref | Granted path prefix | Inside, sandboxed by the Worker | Committer `agent@rig.local` + session trailer; every op in the op-log |
| **Subagent** | Execute in a child namespace | Inherits parent grant; never widens | Inside, sandboxed | Parent + child id |
| **External agent** (script, MCP) | Registry access | Same grant model | Inside, behind the developer setting, **off by default** | Caller id |
| **Other nakliOS apps** | Own `apps/<tool>/` prefix | Own prefix | Inside | App id |
| **System** | Read + repair | Whole mount | Inside | `system` marker |
| **Verifier kernel** | Runs the operator's command only | Read-only run tree, fresh namespace | Inside, isolated from the working kernel | Run id; exit code is the artifact |
| **Goal record** | State, not an actor with rights | The grant recorded at creation | Inside | Attach/detach trail |
| **Bridge daemon** | Relays bytes | — | Inside — the user's own process | Op-log entry |
| **Remote host** | Receives what is pushed | Whatever the operator pushes | **Outside.** The one crossing | Remote + ref |

**Handoff map.** Operator → agent (grant) · agent → subagent (inherited, never
wider) · agent → operator (staged proposal) · operator → goal record (objective +
immutable verification command + budget) · goal → session (recorded grant) ·
session → verifier (fresh kernel) · operator → remote (push, operator-only) ·
operator → external agent (developer toggle).

---

## 7. Goal records

A goal mode holds a persistent directive across turns, budget resets, and
pauses. A browser tab is the worst host for a long-lived *process* — throttling,
suspension, GPU context loss. So we keep the **record**, not the run.

```
goal record (Crate)
  objective · verificationCommand (operator-authored, immutable to the model)
  constraints · grantPrefix · budget · currentStep · revision
  plan[]      {step, doneCondition, status: open|done|partial, note, keystone?}
  pending     {now[], parked[], openQuestions[]}
  sessions[]  append-only {closingWorkState, unfinished, shipped, verified,
                           decisions, rolledBack, surfaced}
  triedTrail[]   ← failures      rolledBack[]  ← deliberate reversals (not the same)
        ▲                                        │
        └── session attaches, works, writes back, detaches ──┘
```

**Windup and resume, ported from ntkit with the ceremony removed.** There, both are
human rituals: windup is an end-of-day ceremony that writes a summary, commits,
pushes, and prints a handoff; resume briefs a person and *pauses* so they can choose
the day's work. Neither ceremony survives here, because on both ends the reader is a
session, not a person. Windup is continuous and pressure-triggered — tab lifecycle,
context threshold, budget fraction. Resume is automatic: attach, reconstruct, state
what was picked up, continue. No question, no waiting.

What does survive is the honesty, and it is the entire value of the port:

- **Closing state is derived from evidence, never asserted.** An involuntary windup
  is always closing from `building`; the record says so and names the unfinished
  item. A windup that papers over a mid-chunk state is the one bug this mechanism can
  have.
- **Parked is not abandoned.** A "not now" that evaporates is the characteristic
  failure of an agent loop — it drops what it decided against and rediscovers it
  three sessions later.
- **Deliberate reversals are not failures.** `rolledBack[]` and `triedTrail[]` answer
  different questions.
- **The record is a claim; the tree is evidence.** On attach, a record claiming a
  clean close against a dirty tree is caught and surfaced, never silently corrected.

Two axes, kept separate: the goal's `status` is the task; a session's `workState`
(`fresh|briefed|building|verifying|blocked|shipped`) is the work. A goal can be
`active` while its last session closed from `building`.

This is deliberately the floor. A self-improving agent will rediscover the rest from
first principles and put it in harness state — that is what `refine()` is for.

Close the tab mid-goal; reopen tomorrow; it resumes cold, by itself. Stale-update protection
via `revision`. Budget exhaustion is a real exit. **`status: done` may only be written by a
verification run** — zero exit, fresh kernel, artifact marked `trust: verifier`. The
model runs tests freely all day via `rig.run` (`trust: none`) and none of it moves the
status. It cannot read the command and cannot reach it through harness state.

That is the answer to the failure Prime Intellect documented in Factorio, where the
refinement loop that had been building legitimate skills turned to building efficient
cheating skills once an exploit existed. Note where the wall sits: **the verifier is
fenced, the loop is not.** Refinement self-applies, the agent runs whatever it wants,
and pushes to its own branches — because none of that can reach the thing that
decides whether it succeeded.

---

## 8. Roadmap — continuous run

Four projects, interleaved. Rig's chunks are the spine; Kiln and Bridge run their own
chunk lists in parallel worktrees.

```
C0 fileops ─→ C1 registry ─→ C2 git core ─→ C4 agent face ─→ C4b faux CLI ─→ C5 Forge ─→ C6 LocalMind ─→ C7 goals
                   │              │                                              │
                   └→ K2 rig module   └→ B0–B3 bridge egress          K3 verifier ─┘
```

| Chunk | Content | Checkpoint |
|---|---|---|
| **C0** | Fileops over `naklios.fs`: read, write, list, stat, mkdir, move, copy, remove, patch, glob, grep | Conformance green; byte-hash round-trip; patch apply→revert identity; traversal fails closed |
| **C1** | Typed serialisable registry (NakliData command-bus pattern reused): `searchCommands` / `describeCommand` / `invokeCommand`, no-execution guarantee on discovery | Tests generated *from* registry metadata pass; valid schema per command; discovery leaves tree hash unchanged |
| **C2** | `isomorphic-git` fs adapter; init, clone, status, statusMatrix, add, commit, log, diff, branch, checkout. `Transport` seam with `FakeTransport` | Clone pinned repo at pinned SHA → head matches; known edit → commit → tree hash matches; ref set survives round-trip |
| **C3** | *Absorbed into Kiln.* Execution is `sys/kiln`, not a Rig module | See K0–K5 |
| **C4** | Agent face: `window.rig`, developer-gated; path grants; append-only op-log; registry→schema emission | Every escape class rejected; op-log replay reconstructs the tree; `window.rig` undefined with the setting off |
| **C4b** | Faux CLI: parser over the registry driving `xterm.js`; scrollback persisted via `addon-serialize` | Headless parser suite: every command reachable from a typed line; unknown → suggestions, never a throw; destructive requires confirm; scrollback round-trips byte-identically |
| **C5** | Forge shell, **desktop and mobile** | Screenshots at all three floor viewports **and** fresh-context rubric critique, zero open findings |
| **C6** | LocalMind on Kiln | See its handoff |
| **C7** | Goal records: schema, attach/detach, revision guard, budget, create/pause/resume/clear | Kill tab mid-goal → resumes at same step, trail intact; stale revision rejected; budget exhaustion halts; `done` without a zero-exit verifier run rejected by test |

---

## 9. Open decisions

| # | Decision | Default |
|---|---|---|
| **D1** | Substrate name | **Rig** |
| **D2** | Forge disposition | **Resolved** — surface layer; Cogitator retired; mobile in v0.1 |
| **D3** | Runtime order | **Python first**; JS/WASI later, own interrupt |
| **D4** | Op-log persistence | **Crate-backed append-only** |
| **D5** | Repo map | **A Rig command** (`rig_map`), shared |
| **D6** | Golden fixture | **Python + pytest** |
| **D7** | Type pairing | **IBM Plex Sans + IBM Plex Mono** |
| **D8** | Faux CLI syntax | **Slash-command** (`/git diff`) — no implication of a shell |
| **D10** | Agent tool surface | **Resolved: RLM.** Kiln kernel is the model's only tool |

---

## 10. What "done" looks like for v0.1

A person opens Forge on a laptop or a phone, points it at a repo in their own
storage, browses it, reads the working-tree diff, writes a change, runs the tests,
watches them go green, and commits — no server, no account, no install, no model.

Then they hand it a goal. A 27B model in the same tab writes Python against a
kernel that can only see the folder they granted, stages its changes under its own
name, and is judged by an exit code from a kernel it cannot touch. They close the
laptop. Tomorrow it picks up at the same step.

The second half is the demo. The first half is why the demo is safe.
