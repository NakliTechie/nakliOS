// Test-only transport. Every SQL statement runs through real CPython sqlite3.
// This is neither a SQL emulator nor a substitute for the real Kiln browser gate.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const exec = (file, argv, options, stdin) => new Promise((resolve, reject) => {
  const child = execFile(file, argv, options, (error, stdout, stderr) => {
    if (error) { error.stdout = stdout; error.stderr = stderr; reject(error); }
    else resolve({ stdout, stderr });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(stdin);
});
export function hostPython(t, { before, after } = {}) {
  const workspace = mkdtempSync(join(tmpdir(), 'naklios-b10-sqlite-'));
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const calls = [];
  return {
    calls, workspace,
    files: () => readdirSync(workspace),
    async exec(cellId, code, options = {}) {
      const call = { cellId, code, options }; calls.push(call);
      if (before) await before(call);
      // Match the main-thread facade's argument transport. Worker coverage uses
      // the genuine createKiln facade, which deliberately does not forward it.
      const prelude = 'import sys as _test_sys, json as _test_json\n'
        + `_test_sys.argv = _test_json.loads(${JSON.stringify(JSON.stringify(options.argv || ['']))})\n`;
      // Large real database requests exceed the operating system's argv limit.
      // A disposable script preserves Python semantics without that host limit.
      const script = join(workspace, `.sqlite-exec-${calls.length}.py`);
      writeFileSync(script, prelude + code, { mode: 0o600 });
      let result;
      try {
        const out = await exec(process.env.B10_SQLITE_PYTHON || 'python3', ['-I', script], {
          cwd: workspace, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' },
          timeout: 15000, maxBuffer: 32 * 1024 * 1024,
        }, options.stdin == null ? '' : String(options.stdin));
        result = { status: 'ok', stdout: out.stdout, stderr: out.stderr, output: out.stdout + out.stderr };
      } catch (error) {
        result = { status: 'error', stdout: error.stdout || '', stderr: error.stderr || error.message,
          code: typeof error.code === 'number' ? error.code : 1, output: (error.stdout || '') + (error.stderr || error.message) };
      } finally { rmSync(script, { force: true }); }
      return after ? after(result, call) : result;
    },
  };
}
