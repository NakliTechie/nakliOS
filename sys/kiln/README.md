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
- **Asks before it downloads.** Python-in-the-browser is a sizable download the
  first time. Kiln shows the size and waits for your go-ahead, then caches it —
  until then Kiln simply reports itself unavailable and the rest of nakliOS is
  unaffected. Nothing is fetched without that go-ahead, and the Pyodide **entry
  module** is checked against a pinned SHA-256 before it runs, so a tampered CDN
  response is rejected. Residual trust: the core wasm/asm and the Python package
  wheels that `loadPyodide` then pulls are still served by the CDN (jsdelivr,
  immutable-versioned) and verified only against Pyodide's own
  `pyodide-lock.json`, not an integrity constant we pin — see
  `pyodide-runtime.mjs` `PYODIDE_ENTRY_SHA256`.
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

> Unrelated to `~/Code/kiln`, a separate project that happens to share the name.

Design and roadmap live in `KILN-VISION-AND-ROADMAP.md` and
`KILN-AGENT-HANDOFF.md`; the cross-repo plan is in `NakliTechie/agentverse`.
