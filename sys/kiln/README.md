# Kiln — a real Python kernel inside your browser tab

Kiln runs Python in nakliOS with nothing installed and no server. It's a
long-lived kernel living in a background Worker: you run some code, and the
variables, imports, and functions you defined are still there the next time —
like a notebook that remembers.

## What it does

- **Keeps its state.** Assign a value or import a module in one run and it's
  available in the next. A stateless "evaluate and forget" would miss the point.
- **Stays sandboxed.** The kernel can't launch other programs, and the standard
  network-egress APIs are actively denied, not merely assumed: before the first
  line of your code runs, the Worker replaces `fetch`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `Request`, `importScripts`, `Worker`,
  `SharedWorker`, `WebTransport`, `navigator.sendBeacon`, and `caches` with stubs
  that throw, so `import js; js.fetch(...)` fails closed. This is a strong denial,
  not a complete sandbox: the syntactic `import()` operator can't be stubbed, and
  stubbing `eval`/`Function` would break Pyodide, so a determined `js.eval("import(…)")`
  is not blocked at the JS layer — a CSP `connect-src` on the hosting document is
  the network-layer backstop (a hardening follow-up). It can only touch the slice of your
  files you explicitly grant it — and reaches those through the very same safety
  checks the rest of nakliOS uses. Calls into Rig from Python are locked to the
  exact commands the generated `rig` module exposes; a forged call to any other
  command is refused before it reaches the registry.
- **Supports application-controlled download consent.** `createKiln` requires a
  `consent()` callback and does not load either interpreter while it returns false.
  Forge and Anvil currently authorize lazy loading when Python or SQLite is invoked;
  they do not present a separate approval dialog. Forge announces its first runtime download.
  The main-thread facade loads on `exec()` and has no built-in consent prompt.
  Embedders requiring a prompt must authorize that invocation before calling it.
  The Worker checks the Pyodide entry module against a pinned SHA-256.
  The main-thread loader imports the fixed CDN version directly.
  Core wasm/asm and package wheels rely on the immutable CDN version and Pyodide's
  `pyodide-lock.json`; see `pyodide-runtime.mjs` for the Worker entry digest.
- **Never freezes the tab.** A runaway loop is interrupted and reported, output
  is capped so it can't balloon, and an error comes back as a readable traceback
  — never a hung page.

## What it is for

Kiln is the verbs to Rig's nouns. An app can run Python against your files; and
in the assistant model, code *is* the way an agent works — it writes
`rig.write(path, text)` in a cell instead of emitting a special tool call. Kiln
also holds the wall that keeps a task honest: whether a goal is actually "done"
is decided by running the operator's own check in a **fresh** kernel that the
working session can't reach or tamper with.

Kiln does not own your files (it borrows Rig's), does not decide what it's
allowed to touch (that's your grant, held by Rig), and draws no screens of its
own (that's Forge).

## Status

The default Worker and main-thread loaders include Pyodide's unvendored `sqlite3` standard-library module.
The consent estimate includes this package: approximately 13 MiB for the runtime and SQLite.
The Worker awaits package loading before disabling network egress and accepting user cells.
Both loaders import SQLite and its shell transport modules before workspace paths can shadow those imports.
The pinned v0.26.4 lockfile names `sqlite3-1.0.0.zip`, with SHA-256
`e05c4defc15eac256607c87c3533af267fc072f3a1749a4f6b8bfe074e1be7f6` and no dependencies.
Package integrity uses that version's lockfile; its CDN trust boundary remains as described above.
The main-thread facade retains the embedding application's invocation policy; it does not ask for download approval itself.
It cannot interrupt synchronous Python; bounded SQLite commands enforce their own VM-work and output limits.

The shell's fixed SQLite bridge selects `exec(..., {interpreter: 'sqlite'})`.
Both default facades keep that interpreter separate from general Python, including its modules and builtins.
The Worker facade asks `loadRuntime({purpose: 'sqlite'})` for a distinct runtime behind the same consent gate.
Forge and Anvil create that Worker without a workspace bridge or generated Rig bindings.
The main-thread facade creates a separate Pyodide instance with an empty filesystem adapter.
SQL requests serialize within their private interpreter; Worker interrupts target the matching cell ID.
Reusing the ordinary runtime or failing private initialization returns an error, with no fallback.
General Python cannot select this channel through shell arguments or inspect its namespace through Kiln's ordinary inspection methods.
This adds one lazily allocated interpreter heap per facade that uses SQL; downloaded runtime assets can use the browser cache.
`createKiln.status()` reports ordinary Python readiness; `status({purpose: 'sqlite'})` reports private SQL readiness.
Initializing one channel does not mark the other ready.
Private SQL initialization waits at most 30 seconds; `loadTimeoutMs` can shorten that wait.
Stop ends the initialization wait immediately. Already-started runtime downloads may still finish and populate the private cache.
An abandoned initialization request never proceeds to SQL execution or workspace publication.
Once SQL execution starts, cancellation retains its owned execution lifetime and existing interruption or VM-work limits.

Implemented and tested: the kernel, dedicated Worker transport, interrupt path,
scoped file bridge, and generated Python `rig` module. Browser checks cover real
Pyodide, byte-identical file writes, traversal rejection, grant errors, and
staged destructive actions. The verifier kernel and assistant side come later.

Hardening pass (audit fixes C-K1 / M-K2…M-K6 / L-K7): network egress is stubbed
inside the Worker before user code runs; rig-call is locked to the generated
binding allowlist; the main-thread proxy has per-request timeouts plus
`messageerror`/error settle paths so a wedged Worker can't hang forever; staged
`os.remove` is masked from the snapshot so a deletion no longer resurrects
mid-session; a face-less storage session refuses writes unless
`allowUngovernedWrites` is set; the Pyodide entry module is SHA-256 pinned; and
over-long Rig errors truncate on a UTF-8 boundary. Headless coverage is in
`test/worker-runtime.test.mjs`; the full Worker+Pyodide path stays in
`test/kiln-worker-harness.html`.

### Required SQLite browser gate

`node scripts/test-sqlite-browser.mjs` runs real Pyodide in a disposable Chrome profile.
It uses Node 24's WebSocket client and Chrome DevTools; no npm browser driver is required.
Chrome must be installed; `CHROME_BIN` can select its executable.
The test loads pinned public Pyodide assets, so this integration gate requires network access.
The `sqlite-browser` CI job runs it alongside the ordinary deterministic suites.

The runner serves only the checkout through disposable loopback servers.
It checks all four SQLite harnesses with Worker/main isolation and main-thread operation without isolation.
It requires 86 successful runtime assertions and rejects 12 invalid mode selections before any CDN runtime request.
Captured external HTTP requests must stay inside the pinned Pyodide CDN directory; excess requests fail the gate.
Fixed per-runtime counts, individual results, unique identities, isolation state and harness identity must all agree.
Empty or incomplete result sets fail. Browser profiles and servers are removed after the run.

> Unrelated to `~/Code/kiln`, a separate project that happens to share the name.

Design and roadmap live in `KILN-VISION-AND-ROADMAP.md` and
`KILN-AGENT-HANDOFF.md`; the cross-repo plan is in `NakliTechie/agentverse`.
