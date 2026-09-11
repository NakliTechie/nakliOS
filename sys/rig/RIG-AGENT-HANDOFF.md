# Rig & Forge — Agent Handoff

*Read `RIG-VISION-AND-ROADMAP.md` first. Kiln and Bridge have their own handoffs and
run in parallel worktrees. Read `FORGE-UX-UI-REFERENCE.md` before any surface work.*

---

## 0. How to run this

**Continuous run.** Chunks in order; green checkpoint → proceed immediately. No
milestone stops, no park walls. The only stops are the three standing interrupts:
a conflict with a locked decision, a dependency not in §2, or scope ambiguity that
changes what the product is.

**Loop discipline.** Maker never grades its own homework — verification in a fresh
context. "Done" is the verifier's word. The checker's first question is whether the
goal was gamed; a skipped or deleted test turning the suite green is a hard fail.
No-progress exit at three repeats. Per-chunk budget cap as the second exit. Isolated
git worktree. Every run writes the state file.

**Cross-project dependencies.** C4b needs C1. C5 needs C4b and Kiln K2. C7 needs
Kiln K3. Nothing waits on Bridge — C2 runs on `FakeTransport`, permanently, as the
test seam.

---

## 1. Repo, build, deploy

| | |
|---|---|
| Repo | `naklios`. Paths `sys/rig/`, `apps/forge/`. **No new repo** |
| Build step | **None.** Vanilla ESM, no npm at runtime, no bundler, no framework |
| Deps | Vendored to `vendor/`, pinned exactly, lazy-loaded, degrade when absent |
| Deploy | Cloudflare Pages |
| Version | Visible version string in UI and meta tag; bump before every push |
| Browser floor | Chromium 121+ desktop and mobile. Firefox/Safari: fileops, git, CLI must work; WebGPU paths degrade with one honest line, never an error wall |
| Conventions | `CLAUDE.md` / `AGENTS.md` at repo root are authoritative for anything unstated |

---

## 2. Dependencies (complete list)

| Dep | Chunk | Notes |
|---|---|---|
| `isomorphic-git` | C2 | MIT, vendored, pinned. **Do not fork** — adapter only |
| `@xterm/xterm` v6 | C4b | MIT, zero-dep core. Vendor ESM build + `css/xterm.css` |
| `@xterm/addon-fit` | C4b | Resize to container |
| `@xterm/addon-serialize` | C4b | Scrollback → VT sequences → Crate |
| `@xterm/addon-webgl` | C5 | Must degrade to DOM renderer cleanly |
| `@xterm/addon-search`, `@xterm/addon-web-links` | C5 | Optional |
| unified-diff apply | C0 | ~5KB vendored, or hand-rolled if smaller |

**Forbidden:** `@xterm/addon-attach` (websocket process transport), `node-pty` or any
PTY, Electron, any bundler, any hosted CORS proxy.

---

## 3. C0 — Fileops

Extend `naklios.fs`. **Read the existing implementation first; do not write a
parallel fs.** If an op exists, wrap it; if not, add it there. One ingress: all
external data passes a single schema validator.

```
read(path,{encoding})   write(path,data,{createParents})   list(path,{recursive})
stat(path)   mkdir(path)   remove(path,{recursive})   move(from,to)   copy(from,to)
patch(path,unifiedDiff)   glob(pattern,{cwd})   grep(pattern,{cwd,glob,maxResults})
```

- POSIX paths, absolute within the mount, normalised on ingress. `..`, absolute
  escapes, symlink escapes rejected **at the validator**. Security-critical.
- Binary-safe; `read` returns `Uint8Array` without an encoding.
- `patch` is atomic and exactly reversible; a failed hunk names itself.
- `grep` streams and caps.
- Crate is the store. **No content, credentials, or op-log in `localStorage`** —
  UI preferences only.
- Expected conditions return typed results, never throws.

**Checkpoint.** Conformance green, every op exercised. Byte-hash round-trip, text and
binary. Patch apply→revert byte-identical. All traversal classes fail closed.

---

## 4. C1 — Command registry

Reuse the NakliData command-bus pattern. **Do not invent a second registry shape.**

- Each op registers with: name, description, parameter schema, return schema,
  destructive flag, required grant scope, one-line help.
- Meta-tools: `searchCommands`, `describeCommand`, `invokeCommand`.
- **No-execution guarantee:** search and describe are provably side-effect free.
- Conformance tests generated *from* metadata — a new command cannot exist without a
  test.
- This registry feeds four consumers: palette, faux CLI, `window.rig`, and Kiln's
  generated Python bindings. **Any surface wanting its own path is an interrupt.**

**Checkpoint.** Generated tests pass; valid schema per command; discovery-only run
leaves the tree hash unchanged.

---

## 5. C2 — Git core

fs adapter for `isomorphic-git` over `naklios.fs`:
`readFile · writeFile · unlink · readdir · mkdir · rmdir · stat · lstat · symlink ·
readlink`.

`stat`/`lstat` return `type, mode, size, mtimeMs, ino, uid, gid, dev`. Synthesise
`ino`/`dev` from a path hash — **stable across calls**, or git sees phantom changes.
If Crate cannot represent symlinks, `symlink` fails loudly; never a silent no-op.

**In scope:** init, clone, status, statusMatrix, add, commit, log, diff (working tree
and between refs), branch, checkout, listRemotes.
**Out:** merge, rebase, submodules, LFS.

**Transport seam.** All remote I/O through one `Transport` interface. `FakeTransport`
(a bare repo in Crate) is the permanent test seam; the Bridge project supplies the
real ones. Every Bridge checkpoint re-runs this chunk's checkpoint unchanged.

**Commit identity.** Operator commits use Identity. Agent commits use
`agent@rig.local` plus a session trailer. **Never let an agent commit under the
operator's identity.** Push is operator-only and is not exposed to the kernel.

**Checkpoint.** Clone pinned repo at pinned SHA → head matches. Known edit → commit →
tree hash matches. `statusMatrix` correct on a fixture. Ref set survives round-trip.

---

## 6. C4 — Agent face

- `window.rig` over the C1 registry, plus a cross-tab channel on the same registry.
- **Developer setting, off by default.** No exceptions.
- **Path grants.** Explicit prefix per session, validated on every command, visible
  while active, revocable in one action. Kiln's mount is derived from this same
  grant — one grant, both doors.
- **Destructive ops stage.** `remove`, out-of-root `move`, discarding `checkout`, and
  `commit` return staged proposals the operator accepts. Cost opt-in; consequence
  opt-in.
- **Op-log.** Append-only in Crate: timestamp, actor id, caller id, command, args
  digest, result status. Kernel calls log with their session and subagent provenance.
- Emit tool-schema JSON *from* the registry; Kiln generates its Python bindings from
  the same source. Nothing hand-maintained.

**Checkpoint.** Every escape class rejected (`../`, absolute, symlink-out, encoded,
grant edges). Op-log replay reconstructs the exact tree. With the setting off,
`window.rig` is undefined.

---

## 7. C4b — Faux CLI

A real terminal *look* over the registry. No shell, no PTY; the first-run help says
so plainly.

`term.onData` → line editor → parser → `invokeCommand` → `term.write`.

```
/ls -R src      /read src/main.py     /grep "TODO" --glob "*.py"
/git status     /git diff HEAD~1      /run pytest -q
/py x = 1       /goal show            /help    /help git.diff
```

- `/help` renders registry metadata. **No hand-written help text.**
- `/py` forwards a line to the Kiln kernel — the operator's own door to the same
  namespace the model uses. Provenance `operator`.
- Unknown command → closest matches from `searchCommands`. Never a throw or stack
  trace.
- Destructive commands print the staged proposal and wait for explicit `y`.
- History (↑/↓), Ctrl-C cancels, Ctrl-L clears, tab-completion on names and paths.
- Scrollback persists via `addon-serialize`, redacted for token-shaped strings before
  write.
- **The parser is a separate module from the chrome and is tested headlessly.**
  `xterm.js` is the screen, not the system under test.

**Checkpoint.** Headless suite: every command reachable from a typed line; argument
coercion matches declared schemas; unknown yields suggestions; destructive cannot run
without confirmation; scrollback serialise→restore byte-identical.

---

## 8. C5 — Forge shell

Build strictly against `FORGE-UX-UI-REFERENCE.md` and `forge-mockup.html`.

- **The reference leads; the agent follows.** Build toward the drawn target.
- Tokens as CSS custom properties from day one. If a value is not a token it is not
  in the system.
- One accent doing real work — state, primary action, focus. Never mood.
- Dim, never hide, in tree and graph views; true hiding only for lists.
- **Desktop and mobile both ship.** Mobile is not a squeezed desktop: the reference
  specifies a distinct single-column shape with a surface switcher.
- Help (`?`) on the welcome screen, not only the toolbar. In-app prompt/confirm,
  never native dialogs.
- Empty and error states are designed screens: no-repo, no-kernel, no-model,
  no-grant, offline, no-bridge, goal-blocked.
- Keyboard-first; conflicts resolved in the reference. `xterm.js` screen-reader mode
  behind a setting.
- a11y: focus order verified, contrast checked, `prefers-reduced-motion` first-class.
- i18n/l10n baseline from the first commit.

**Checkpoint.** Screenshots reproducibly captured at **all three** floor viewports via
the `/guide` path, per surface and per state, **and** a fresh-context critique against
the eight-principle rubric, worst-first, zero open findings.

---

## 9. C7 — Goal records

```
sys/rig/goals/<goalId>.json
  id · createdAt · status(draft|active|paused|blocked|done|abandoned)
  objective · verificationCommand · constraints · grantPrefix
  plan[]{step,doneCondition,status} · triedTrail[]{at,step,attempt,signal}
  budget{capTokens,capWallMs,spentTokens,spentWallMs} · currentStep · lastWriterId · revision
```

0. **Rig owns the record.** It lives in `sys/rig/goals/`, not under Forge. Forge
   renders it; LocalMind attaches to it; neither holds it. It is operator-owned state
   that outlives any UI. **Kiln never writes a goal record.**
1. **Record, not process.** Sessions attach, work, write back, detach. Closing the
   tab is normal, not a failure.
2. **Stale-update protection.** Writes carry the `revision` read at attach; mismatch
   is rejected. A second tab cannot clobber the first.
3. **Budget is a real exit.** Exhaustion → `blocked`, trail written, stop.
4. **No-progress exit.** Same failure three times in `triedTrail` → `blocked`.
5. **`verificationCommand` is operator-authored and immutable to the model.** Not
   exposed in the `rig` module, not in Kiln harness state, not in any kernel variable.
6. **`status: done` may only be written by a verification run** — a zero-exit run of
   `verificationCommand` in a fresh Kiln kernel, artifact marked `trust: verifier`.
   An iteration run (`rig.run`, `trust: none`) exiting zero proves nothing to the goal
   machinery, however many times it does so. The `trust` field is set by the caller
   and is not writable by the code being run.
7. Sessions inherit `grantPrefix` exactly and never widen it.
8. Controls — create, pause, resume, clear — are operator-only.
9. **Two axes, not one.** The goal has a `status` lifecycle
   (`draft|active|paused|blocked|done|abandoned`) — that is the *task*. Each session
   within it has a `workState` (`fresh|briefed|building|verifying|blocked|shipped`) —
   that is the *work*. A goal can be `active` while its last session closed from
   `building`. Conflating them is how a resume lies about where it is.

10. **Windup — continuous, pressure-triggered, never a ritual.** ntkit's windup is a
   human end-of-day ceremony: write the summary, commit, push, print a handoff for a
   person to read tomorrow. Ours is a machine event and the ceremony is dropped
   entirely. No day files, no printed handoff, no commit-and-push step — the record
   *is* the handoff and the next reader is a session, not a person.

   What survives the translation is the honesty, and it is the whole value:

   - **Closing state is derived, never asserted.** On windup, compute `workState`
     from evidence — a cell in flight, unstaged changes, a verification run that is
     stale or not green. If it closes from `building` rather than `verifying`, the
     record says so and names the unfinished item. **A windup that papers over a
     mid-chunk state is the one bug this mechanism can have.**
   - **Triggers:** `visibilitychange`→hidden and the `freeze` lifecycle event;
     `pagehide` as last-chance; context pressure at the compaction threshold; budget
     pressure at a configured fraction; explicit `/goal windup`. An involuntary
     windup is *always* closing from `building` — which is why the guard is derived
     rather than optional.
   - **Atomic.** Temp key, then swap. An interrupted windup leaves the prior record
     byte-intact; a half-written state is worse than a stale one.

11. **Three artifacts on the record**, kept separate because they answer different
   questions:

   ```
   sessions[]   append-only, immutable, one per session
                {startedAt, endedAt, closingWorkState, unfinished,
                 shipped[], verified[], decisions[], rolledBack[], surfaced[]}
   pending      {now[], parked[], openQuestions[]}   ← flat source of truth
   plan[]       {step, doneCondition, status, note}  ← the curated play
   ```

   - **`rolledBack[]` is not `triedTrail[]`.** A dead end deliberately reversed is
     different information from a test that went red; conflating them means the next
     session re-walks a path this one already rejected on purpose.
   - **`parked[]` is mandatory.** A "not now" that evaporates is the characteristic
     failure of an agent loop — it silently drops what it decided against and
     rediscovers it three sessions later. Deferred is not abandoned.
   - **`plan[].status` is tri-state** — `open | done | partial`. A `partial` states
     what is done, what is left, and **what would un-defer it**. That last field is
     what stops a resume from re-deriving a blocker from scratch.
   - Chunks may carry a `keystone` flag where later steps depend on them.

12. **Resume — automatic, no pause.** ntkit's `/resume-nt` pauses for direction
   because a human is starting a day and wants to choose. Ours is a session attaching
   to a record: it reads, reconstructs, states what it picked up, and continues. No
   question, no waiting.

   Three things still halt it, and none is a request for direction:
   - the goal is `blocked` (no-progress or budget exit already fired)
   - a **consistency check fails** (below)
   - a staged proposal is awaiting operator accept

13. **Consistency checks on attach — the record is a claim, the tree is evidence.**
   Flag, never silently fix:
   - `plan[]` says mid-step but the tree is clean and nothing recent in the log →
     stale step state
   - a `partial` item's un-defer condition is already satisfied → it should have moved
   - open findings from a forward pass exist but appear nowhere in `plan[]` →
     unexecuted findings
   - **the last session's `closingWorkState` claims `verifying` or `shipped` but
     there is uncommitted work → dishonest windup. Trust the tree.**

   A failed check writes to `surfaced[]` and surfaces in Forge. It does not
   auto-correct the record.

14. **Deliberately minimal.** This is the floor, not the ceiling. A self-improving
   agent will rediscover most of the rest from first principles and encode it in
   harness state — which is what `refine()` is for. Do not pre-build a richer
   planning apparatus; ship the honest record and the fences, and let the loop grow
   what it actually needs.

**Checkpoint.** Kill tab mid-goal → reopen → **resumes automatically** at the same
step with the trail intact and no operator input. Simulated `freeze` fires windup and
records `closingWorkState: building` with the unfinished item named. An interrupted
windup leaves the previous record byte-intact, asserted. Each consistency check has a
fixture that trips it, and a tripped check surfaces without mutating the record — in
particular, a record claiming a clean close against a dirty tree is caught. A
`partial` item without an un-defer condition fails schema validation. Stale-revision write rejected. Budget exhaustion halts and reports. Setting
`done` without a zero-exit verifier run rejected by test. A kernel attempt to read
`verificationCommand` rejected by test.

---

## 10. Security posture

- CSP: no `unsafe-eval` in the main document. Python lives in Kiln's Worker; that
  boundary is the sandbox.
- Credentials in Vault only — never `localStorage`, op-log, run artifact, goal record,
  scrollback, kernel namespace, traceback, or URL.
- Redact token-shaped strings by pattern before any write.
- One ingress validator for all external data, including typed CLI lines and kernel
  calls.
- Push boundary notice fires once, plainly, before the first push. Flag, do not block.

---

## 11. Hard rules — what NOT to do

1. **Do not create a new repo.**
2. **Do not build a parallel filesystem.** Extend `naklios.fs`.
3. **Do not fork `isomorphic-git`.**
4. **Do not invent a second registry shape**, and do not give any surface its own path
   to capability.
5. **Do not propose an eighth primitive.**
5b. **Do not put goal records under `apps/forge/`,** and do not let Kiln write them.
5c. **Do not let Kiln set, widen, or cache a grant.** Rig is the single source; Kiln
    derives its mount from it.
6. **Do not build a PTY, a shell, or a general process model.** No Karkhana, no v86,
   no container.
7. **Do not use `@xterm/addon-attach`** or any websocket-process transport.
8. **Do not use or offer a hosted CORS proxy.**
9. **Do not put content, credentials, or the op-log in `localStorage`.**
10. **Do not let any AI become load-bearing.** Every Forge surface works fully with no
    model configured.
11. **Do not add a build step, framework, or npm runtime dependency.**
12. **Do not let an agent commit under the operator's identity.** Agent push is
    allowed but only to `agent/<goalId>-<n>` branches, never a default or protected
    ref, and never with force.
13. **Do not let a model write `status: done`** or read `verificationCommand`.
14. **Do not skip, delete, or weaken a test to pass a checkpoint.**
15. **Do not copy third-party agent code into the repo.** Port semantics; write JS.
16. **Do not defer mobile.**

---

## 12. Gate artifacts

| Chunk | Artifact |
|---|---|
| C0 | Conformance output + hash round-trips + traversal rejection matrix |
| C1 | Generated test manifest + tree-hash-unchanged assertion |
| C2 | SHA-match log (clone, commit) + FakeTransport ref round-trip |
| C4 | Escape-class matrix + op-log replay diff (empty) |
| C4b | Headless parser suite + scrollback serialise/restore hash |
| C5 | Screenshots at three viewports + fresh-context rubric critique, zero findings |
| C7 | Kill/resume transcript + stale-revision rejection + budget halt + `done`-forgery rejection |

State file updated on every run, without exception.

---

## 13. Escalation

Standing interrupt or no-progress exit: write the tried-trail to the nakliOS state
file, leave partial work unmerged in the worktree, escalate with numbered options and
trade-offs. Escalating with a readable trail is success behaviour.

**READMEs:** `sys/rig/README.md`, `apps/forge/README.md` — what each does for a user,
plain words, no model names, no line counts. Update the portfolio entry after the
first ship.
