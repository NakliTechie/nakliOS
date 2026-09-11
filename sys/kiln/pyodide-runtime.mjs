// pyodide-runtime — the REAL runtime the MockRuntime stands in for.
//
// This is the executor that runs inside the Kiln Worker: it holds a persistent
// Python namespace, runs code against it, captures stdout/stderr/traceback,
// caps output, and honours an interrupt via a SharedArrayBuffer byte. It matches
// the same contract createKernelCore expects, so the mock and the real thing are
// interchangeable.
//
// Verification status: the kernel-core orchestration + consent gate are verified
// headlessly (test/conformance.test.mjs, 9/9). This adapter's real-Python
// behaviour (namespace persistence, KeyboardInterrupt on a runaway loop,
// tracebacks) is verified in the browser Worker with real Pyodide — see
// CHECKPOINT-K0.md "browser follow-on". No fabricated headless claim is made
// for it.

// Pinned Pyodide (hard rule #11: never auto-download — the loader shows this
// size and asks before fetching).
export const PYODIDE_VERSION = 'v0.26.4';
export const PYODIDE_INDEX_URL = `https://cdn.jsdelivr.net/pyodide/${PYODIDE_VERSION}/full/`;
export const PYODIDE_APPROX_BYTES = 12 * 1024 * 1024; // ~12 MiB core, for the consent prompt

// Pinned SHA-256 of the entry module (`pyodide.mjs`) for the version above, so
// the loader can prove the CDN served the exact bytes it expected before it runs
// them (M-K6). This covers the ENTRY module only; the core wasm/asm and package
// wheels loadPyodide subsequently fetches are still trusted to the CDN + their
// own pyodide-lock.json digests — see README "Stays sandboxed" for the residual
// trust boundary. Recompute with:
//   curl -sSL https://cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.mjs | shasum -a 256
export const PYODIDE_ENTRY_SHA256 = '7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51';

// Strip anything secret-shaped from a traceback before it crosses to the UI or
// the op-log (§9). Mirrors the scrollback redactor.
const TOKEN_PATTERNS = [
  /\b(sk|pk|ghp|gho|xox[baprs])[-_][A-Za-z0-9]{16,}\b/g,
  /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g,
  /\b[A-Fa-f0-9]{64,}\b/g,
];
// A Python `sys.exit(n)` surfaces from Pyodide as a thrown PythonError whose message ends in
// "SystemExit: n" (or a bare "SystemExit" for None). It is not an error: it is the program's
// exit code. Found live 2026-09-11 — a script ending `sys.exit(main())` returned 0 and Kiln
// reported a traceback with exit 1, so a green gate read as red and the agent "learned" a fact
// about a failure that never happened. Returns the exit code, or null when the message is not a
// SystemExit at all. A non-integer payload (`sys.exit('msg')`) exits 1, as CPython does.
export function systemExitCode(message) {
  const m = /(?:^|\n)\s*SystemExit(?::[ \t]*(.*?))?[ \t]*$/.exec(String(message == null ? '' : message).trimEnd());
  if (!m) return null;
  const payload = (m[1] == null ? '' : m[1]).trim();
  if (payload === '' || payload === 'None' || payload === '0') return 0;
  return /^-?\d+$/.test(payload) ? Number(payload) : 1;
}

export function sanitizeTraceback(text) {
  let out = String(text);
  for (const re of TOKEN_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/**
 * Wrap a loaded Pyodide instance as a Kiln runtime.
 *
 * @param {object} pyodide          a loaded Pyodide (loadPyodide result)
 * @param {Uint8Array} [interruptBuffer]  a Uint8Array over a SharedArrayBuffer;
 *   setting [0]=2 raises KeyboardInterrupt in the running cell. Set on the main
 *   thread while the Worker is busy — that is the whole point of the SAB.
 */
export function createPyodideRuntime(pyodide, interruptBuffer) {
  if (interruptBuffer) pyodide.setInterruptBuffer(interruptBuffer);
  // A dedicated namespace dict so reset() is clean and we never clobber builtins.
  let ns = pyodide.runPython('dict()');

  async function runCode(code, { outputCapBytes } = {}) {
    let stdout = '';
    let stderr = '';
    let truncated = false;
    const cap = (buf, s) => {
      if (truncated) return buf;
      const next = buf + s;
      if (outputCapBytes && next.length >= outputCapBytes) { truncated = true; return next.slice(0, outputCapBytes); }
      return next;
    };
    // `write` (raw bytes) rather than `batched`: batched is line-buffered and
    // strips the trailing newline, so print output was not captured byte-exact
    // (found in the browser verification pass). Streaming decoders handle a
    // multibyte character split across writes.
    const outDec = new TextDecoder('utf-8');
    const errDec = new TextDecoder('utf-8');
    pyodide.setStdout({ write: (buf) => { stdout = cap(stdout, outDec.decode(buf, { stream: true })); return buf.length; } });
    pyodide.setStderr({ write: (buf) => { stderr = cap(stderr, errDec.decode(buf, { stream: true })); return buf.length; } });
    if (interruptBuffer) interruptBuffer[0] = 0; // clear before each run

    let traceback = null;
    let result = null;
    let interrupted = false;
    let exitCode = null;
    try {
      const r = await pyodide.runPythonAsync(code, { globals: ns });
      result = r == null ? null : (typeof r === 'object' && r.toString ? r.toString() : String(r));
      if (r && typeof r.destroy === 'function') r.destroy();
    } catch (e) {
      const msg = String((e && e.message) || e);
      const sx = systemExitCode(msg);
      if (/KeyboardInterrupt/.test(msg)) interrupted = true;
      else if (sx !== null) exitCode = sx;   // `sys.exit(n)`: the program's answer, not a failure
      else traceback = sanitizeTraceback(msg);
    } finally {
      pyodide.setStdout({});
      pyodide.setStderr({});
    }
    return { stdout, stderr, result, traceback, interrupted, truncated, exitCode };
  }

  function interrupt() {
    if (interruptBuffer) interruptBuffer[0] = 2; // SIGINT
  }

  function listNames() {
    const proxy = pyodide.runPython('list(k for k in globals().keys() if not k.startswith("__"))', { globals: ns });
    const names = proxy.toJs ? proxy.toJs() : [];
    if (proxy.destroy) proxy.destroy();
    return names;
  }

  function inspect(name) {
    const info = pyodide.runPython(
      `__k = globals().get(${JSON.stringify(name)});\n`
      + '(None if __k is None else {"type": type(__k).__name__, "repr": repr(__k)[:200]})',
      { globals: ns },
    );
    if (info == null) return null;
    const obj = info.toJs ? Object.fromEntries(info.toJs()) : info;
    if (info.destroy) info.destroy();
    return obj;
  }

  function reset({ keepMounts } = {}) {
    if (ns && ns.destroy) ns.destroy();
    ns = pyodide.runPython('dict()');
    // keepMounts is honoured by the fs bridge (K1); the namespace is always fresh.
  }

  return { runCode, interrupt, listNames, inspect, reset };
}
