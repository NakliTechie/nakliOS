// kernel-core — Kiln's K0 execution orchestrator, runtime-agnostic.
//
// The core owns the protocol contract; the injected `runtime` owns the Python
// (real Pyodide in the browser Worker, a MockRuntime in headless tests). This
// is the same seam pattern as Rig's fileops backend and git Transport.
//
// Protocol (RIG/KILN §3):
//   exec(cellId, code, {timeoutMs, outputCapBytes, provenance})
//     → {status: ok|error|timeout|interrupted, stdout, stderr, result, traceback?, ms}
//   interrupt(cellId)   reset({keepMounts})   inspect(name)   listNames()
//
// Invariants:
//   - The namespace persists across exec (the runtime holds it).
//   - Every exec carries provenance and is recorded in the cell log.
//   - Timeout + output cap on every call; a runaway loop is interrupted, never
//     a hung tab or an unbounded string.
//   - NEVER throw across the boundary — expected conditions are typed results,
//     a traceback is data.
//
// The `runtime` contract:
//   runCode(code, {outputCapBytes, signal}) ->
//     { stdout, stderr, result, traceback|null, interrupted, truncated }
//   interrupt()            // request the current run stop (sets the SAB byte)
//   listNames() -> string[]
//   inspect(name) -> {type, repr} | null
//   reset({keepMounts})

const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_OUTPUT_CAP = 1 << 20; // 1 MiB

export function createKernelCore({ runtime, now = () => Date.now() }) {
  if (!runtime) throw new Error('createKernelCore requires a runtime');
  const cells = [];
  let running = null; // { cellId }

  async function exec(cellId, code, opts = {}) {
    const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
    const outputCapBytes = opts.outputCapBytes != null ? opts.outputCapBytes : DEFAULT_OUTPUT_CAP;
    const provenance = opts.provenance || 'unknown';
    const started = now();
    running = { cellId };

    let timedOut = false;
    let timer = null;
    if (timeoutMs > 0 && timeoutMs !== Infinity) {
      timer = setTimeout(() => { timedOut = true; try { runtime.interrupt(); } catch (_) {} }, timeoutMs);
    }

    let out;
    try {
      out = await runtime.runCode(code, { outputCapBytes });
    } catch (e) {
      // The runtime should never throw; guard so the boundary stays typed.
      if (timer) clearTimeout(timer);
      running = null;
      const rec = { cellId, provenance, status: 'error', ms: now() - started };
      cells.push(rec);
      return {
        status: 'error', stdout: '', stderr: String(e && e.message ? e.message : e),
        result: null, traceback: String(e && e.stack ? e.stack : e), ms: rec.ms, cellId,
      };
    }
    if (timer) clearTimeout(timer);
    running = null;

    const ms = now() - started;
    let status;
    if (timedOut) status = 'timeout';
    else if (out.interrupted) status = 'interrupted';
    else if (out.traceback) status = 'error';
    else if (Number.isInteger(out.exitCode) && out.exitCode !== 0) status = 'error';
    else status = 'ok';

    cells.push({ cellId, provenance, status, ms, truncated: !!out.truncated });
    const result = {
      status,
      stdout: out.stdout || '',
      stderr: out.stderr || '',
      result: out.result !== undefined ? out.result : null,
      ms,
      cellId,
      truncated: !!out.truncated,
    };
    if (out.fsSync) result.fsSync = out.fsSync;
    if (out.traceback) result.traceback = out.traceback;
    if (Number.isInteger(out.exitCode)) result.code = out.exitCode; // sys.exit(n), n as the program said it
    return result;
  }

  function interrupt(cellId) {
    if (running && (cellId == null || running.cellId === cellId)) {
      try { runtime.interrupt(); return { ok: true }; } catch (e) { return { ok: false, message: String(e) }; }
    }
    return { ok: false, message: 'no matching running cell' };
  }

  function reset(opts = {}) {
    try { runtime.reset({ keepMounts: !!opts.keepMounts }); cells.length = 0; return { ok: true }; }
    catch (e) { return { ok: false, message: String(e) }; }
  }

  function inspect(name) {
    try { return { ok: true, info: runtime.inspect(name) }; }
    catch (e) { return { ok: false, message: String(e) }; }
  }

  function listNames() {
    try { return { ok: true, names: runtime.listNames() }; }
    catch (e) { return { ok: false, message: String(e) }; }
  }

  return { exec, interrupt, reset, inspect, listNames, cells: () => cells.slice() };
}

export { DEFAULT_TIMEOUT_MS, DEFAULT_OUTPUT_CAP };
