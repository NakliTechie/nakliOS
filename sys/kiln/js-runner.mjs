// js-runner — G9 (2026-09-24): run a workspace ES module as a gate, `node test.mjs` in the agent's shell.
//
// Why: the curated shell has no `node` / `npm` / `pytest`, so a JavaScript project could not gate on
// its own tests — only Python could (Kiln). This runs one entry module and everything it imports
// from the WORKSPACE in a Worker, with the network globals stubbed to throw (Kiln's list), console and
// process.stdout captured, process.exit / exitCode honoured, and an uncaught error → exit 1.
//
// What it is NOT: Node. There is no fs, no child_process, no npm packages. Relative imports resolve
// from the workspace; `node:assert`, `node:assert/strict`, `assert` and `node:test` are small shims
// here; ANY other bare specifier is refused by name before anything runs. A circular import is refused
// too — the graph is bundled leaves-first. A run that does not finish in `timeoutMs` is killed (124).
// The same boundary note as Kiln's: this is a sandbox for model-authored tests, not against a hostile
// author — the Worker's `import()` of a URL is still reachable; the host page's CSP is the backstop.
//
// Pure over three host callbacks, so the node lanes run the real worker path (worker_threads + data:
// URLs) and Anvil runs it in a module Worker with blob URLs:
//   read(path)            → the file's text, or null
//   makeModuleURL(source) → a URL a module can be imported from
//   spawn(entryURL)       → { onMessage(cb), onError(cb), terminate() } for a module worker at entryURL

export const DEFAULT_JS_TIMEOUT_MS = 60_000;
export const MAX_MODULES = 200;
const NETWORK_GLOBALS = ['fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'Request', 'importScripts', 'Worker', 'SharedWorker', 'WebTransport'];

// the workspace path of `spec` imported from `from` ('' is the root); null when it is not relative
export function resolveRelative(from, spec) {
  if (!/^\.\.?\//.test(spec)) return null;
  const base = from.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (!base.length) return undefined; base.pop(); continue; }
    base.push(seg);
  }
  return base.join('/');
}

// Which offsets sit inside a comment or a string/template body — an `import` there is text, not an import.
// A light lexer (', ", `, //, /* */); a regex literal is not tracked, the one gap, and it only matters for
// a regex containing a quote or the word import.
function inertSpans(src) {
  const inert = new Uint8Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; inert.fill(1, i, end); i = end; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; inert.fill(1, i, end); i = end - 1; continue; }
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (; j < src.length; j++) { if (src[j] === '\\') { j++; continue; } if (src[j] === c) break; if (c !== '`' && src[j] === '\n') break; }
      inert.fill(1, i + 1, j); i = j; continue;
    }
  }
  return inert;
}

// Every static `import … from 'x'`, `export … from 'x'`, `import 'x'` and dynamic `import('x')` with a
// string literal — with the span of the literal, so it can be rewritten in place. A match whose keyword
// is inside a comment or a string is text, not an import.
export function findSpecifiers(src) {
  const out = [];
  const inert = inertSpans(src);
  const re = /(\bimport\s*\(\s*|\b(?:import|export)\s+(?:[\w*{}\s,$]+?\s+from\s+)?)(['"])([^'"\n]+)\2/g;
  let m;
  while ((m = re.exec(src))) {
    if (inert[m.index]) continue;
    const start = m.index + m[1].length;
    out.push({ spec: m[3], start, end: start + m[3].length + 2, quote: m[2] });
  }
  return out;
}

const ASSERT_SHIM = `
class AssertionError extends Error { constructor(message) { super(message); this.name = 'AssertionError'; this.code = 'ERR_ASSERTION'; } }
const show = (v) => { try { return typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x + 'n' : x)) ?? String(v); } catch { return String(v); } };
const raise = (msg, dflt) => { throw (msg instanceof Error ? msg : new AssertionError(msg || dflt)); };
function deq(a, b) {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (a instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Map || a instanceof Set) { if (a.size !== b.size) return false; const bb = [...b]; return [...a].every((x, i) => deq(x, bb[i])); }
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deq(a[k], b[k]));
}
const matches = (err, expected) => expected == null || (typeof expected === 'function' ? (expected.prototype && err instanceof expected) || (!expected.prototype && expected(err) === true) : expected instanceof RegExp ? expected.test(String(err && err.message !== undefined ? err.message : err)) : typeof expected === 'object' ? Object.keys(expected).every((k) => (expected[k] instanceof RegExp ? expected[k].test(err[k]) : deq(err[k], expected[k]))) : false);
function assert(v, msg) { if (!v) raise(msg, 'The expression evaluated to a falsy value: ' + show(v)); }
assert.ok = assert;
assert.AssertionError = AssertionError;
assert.fail = (msg) => raise(msg, 'Failed');
assert.equal = assert.strictEqual = (a, b, msg) => { if (!Object.is(a, b)) raise(msg, 'Expected values to be strictly equal:\\n' + show(a) + ' !== ' + show(b)); };
assert.notEqual = assert.notStrictEqual = (a, b, msg) => { if (Object.is(a, b)) raise(msg, 'Expected "actual" to be strictly unequal to: ' + show(b)); };
assert.deepEqual = assert.deepStrictEqual = (a, b, msg) => { if (!deq(a, b)) raise(msg, 'Expected values to be strictly deep-equal:\\n' + show(a) + '\\n!==\\n' + show(b)); };
assert.notDeepEqual = assert.notDeepStrictEqual = (a, b, msg) => { if (deq(a, b)) raise(msg, 'Expected "actual" not to be strictly deep-equal to: ' + show(b)); };
assert.match = (s, re, msg) => { if (!re.test(s)) raise(msg, 'The input did not match the regular expression ' + re + '. Input: ' + show(s)); };
assert.doesNotMatch = (s, re, msg) => { if (re.test(s)) raise(msg, 'The input was expected to not match the regular expression ' + re + '. Input: ' + show(s)); };
assert.throws = (fn, expected, msg) => { try { fn(); } catch (e) { if (!matches(e, expected)) raise(typeof expected === 'string' ? expected : msg, 'The error did not match: ' + (e && e.message)); return; } raise(typeof expected === 'string' ? expected : msg, 'Missing expected exception.'); };
assert.doesNotThrow = (fn, msg) => { try { fn(); } catch (e) { raise(msg, 'Got unwanted exception: ' + (e && e.message)); } };
assert.rejects = async (p, expected, msg) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { if (!matches(e, expected)) raise(typeof expected === 'string' ? expected : msg, 'The rejection did not match: ' + (e && e.message)); return; } raise(typeof expected === 'string' ? expected : msg, 'Missing expected rejection.'); };
assert.doesNotReject = async (p, msg) => { try { await (typeof p === 'function' ? p() : p); } catch (e) { raise(msg, 'Got unwanted rejection: ' + (e && e.message)); } };
assert.strict = assert;
export default assert;
export const { ok, equal, strictEqual, notEqual, notStrictEqual, deepEqual, deepStrictEqual, notDeepEqual, notDeepStrictEqual, match, doesNotMatch, throws, doesNotThrow, rejects, doesNotReject, strict } = assert;
export const fail = assert.fail;
export { AssertionError };
`;

// node:test — test()/it() register; describe() groups; they run in order after the entry module has
// loaded, print ✔/✖ lines, and a failure sets process.exitCode = 1. before/after hooks run per file.
const TEST_SHIM = `
const queue = []; const prefix = []; const hooks = { before: [], after: [], beforeEach: [], afterEach: [] };
export function test(name, opts, fn) { if (typeof opts === 'function') fn = opts; if (typeof name === 'function') { fn = name; name = fn.name || 'test'; } queue.push({ name: [...prefix, name].join(' > '), fn, skip: !!(opts && opts.skip) }); }
export const it = test;
test.skip = (name, fn) => queue.push({ name: [...prefix, name].join(' > '), fn, skip: true });
export function describe(name, fn) { prefix.push(name); try { fn(); } finally { prefix.pop(); } }
export const before = (f) => hooks.before.push(f), after = (f) => hooks.after.push(f), beforeEach = (f) => hooks.beforeEach.push(f), afterEach = (f) => hooks.afterEach.push(f);
export default test;
globalThis.__runNodeTests = async () => {
  let pass = 0, fail = 0, skip = 0;
  for (const h of hooks.before) await h();
  for (const t of queue) {
    if (t.skip) { skip++; console.log('﹣ ' + t.name + ' # SKIP'); continue; }
    try { for (const h of hooks.beforeEach) await h(); await t.fn({ name: t.name }); for (const h of hooks.afterEach) await h(); pass++; console.log('✔ ' + t.name); }
    catch (e) { fail++; console.log('✖ ' + t.name + '\\n  ' + String((e && (e.stack || e.message)) || e).split('\\n').slice(0, 6).join('\\n  ')); }
  }
  for (const h of hooks.after) await h();
  if (queue.length) console.log('ℹ tests ' + queue.length + ' · pass ' + pass + ' · fail ' + fail + (skip ? ' · skipped ' + skip : ''));
  if (fail) process.exitCode = 1;
};
`;

// The worker's own source: stubs, capture, then the entry.
function workerSource({ entryURL, argv, cwd, stdin }) {
  return `
const post = (m) => self.postMessage(m);
const EXIT = Symbol('exit');
const fmt = (a) => a.map((x) => (typeof x === 'string' ? x : x instanceof Error ? (x.stack || String(x)) : (() => { try { return JSON.stringify(x, null, 2) ?? String(x); } catch { return String(x); } })())).join(' ');
for (const k of ['log', 'info', 'debug', 'warn', 'error']) console[k] = (...a) => post({ t: 'out', s: fmt(a) + '\\n' });
for (const name of ${JSON.stringify(NETWORK_GLOBALS)}) { const stub = function () { throw new Error(name + ': network access is disabled in a gate'); }; try { Object.defineProperty(globalThis, name, { value: stub, configurable: true, writable: true }); } catch (_) { try { globalThis[name] = stub; } catch (_) {} } }
const proc = { argv: ${JSON.stringify(argv)}, env: {}, exitCode: undefined, platform: 'browser', versions: {}, cwd: () => ${JSON.stringify(cwd || '/')},
  stdout: { write: (s) => { post({ t: 'out', s: String(s) }); return true; } }, stderr: { write: (s) => { post({ t: 'out', s: String(s) }); return true; } },
  stdin: { text: ${JSON.stringify(stdin || '')} },
  exit: (c) => { post({ t: 'exit', code: Number.isInteger(c) ? c : (proc.exitCode | 0) }); throw EXIT; } };
globalThis.process = proc;
const died = (e) => { if (e === EXIT) return; post({ t: 'out', s: 'Uncaught ' + String((e && (e.stack || e.message)) || e) + '\\n' }); post({ t: 'exit', code: 1 }); };
if (typeof self.addEventListener === 'function') { self.addEventListener('unhandledrejection', (ev) => { ev.preventDefault && ev.preventDefault(); died(ev.reason); }); self.addEventListener('error', (ev) => { ev.preventDefault && ev.preventDefault(); died(ev.error || ev.message); }); }
try {
  await import(${JSON.stringify(entryURL)});
  if (typeof globalThis.__runNodeTests === 'function') await globalThis.__runNodeTests();
  post({ t: 'exit', code: proc.exitCode | 0 });
} catch (e) { died(e); }
`;
}

export function createJsRunner({ read, makeModuleURL, spawn, revoke = () => {}, timeoutMs = DEFAULT_JS_TIMEOUT_MS } = {}) {
  if (typeof read !== 'function' || typeof makeModuleURL !== 'function' || typeof spawn !== 'function') throw new Error('createJsRunner needs read, makeModuleURL and spawn');

  // Bundle the graph leaves-first. Returns { url } or { error }.
  async function bundle(entry) {
    const urls = new Map(); const made = [];
    const shims = new Map();
    const shim = (name) => { if (!shims.has(name)) { const u = makeModuleURL(name === 'test' ? TEST_SHIM : ASSERT_SHIM); made.push(u); shims.set(name, u); } return shims.get(name); };
    const visiting = new Set();
    async function visit(path, from) {
      if (urls.has(path)) return urls.get(path);
      if (visiting.has(path)) throw new Error(`circular import: ${from} → ${path} — the gate runner bundles leaves-first and cannot run a cycle`);
      if (urls.size + visiting.size >= MAX_MODULES) throw new Error(`more than ${MAX_MODULES} modules — too large for a gate`);
      visiting.add(path);
      const src = await read(path);
      if (src == null) throw new Error(`cannot read ${path}${from ? ` (imported from ${from})` : ''}`);
      const specs = findSpecifiers(src);
      let out = ''; let at = 0;
      for (const s of specs) {
        let target;
        if (s.spec === 'node:test' || s.spec === 'test') target = shim('test');
        else if (/^(node:)?assert(\/strict)?$/.test(s.spec)) target = shim('assert');
        else {
          const rel = resolveRelative(path, s.spec);
          if (rel === null) throw new Error(`${path}: import '${s.spec}' — only relative imports and node:assert / node:test are available in a gate (no npm packages, no other node: modules)`);
          if (rel === undefined) throw new Error(`${path}: import '${s.spec}' climbs above the workspace`);
          target = await visit(rel, path);
        }
        out += src.slice(at, s.start) + JSON.stringify(target); at = s.end;
      }
      out += src.slice(at);
      visiting.delete(path);
      const url = makeModuleURL(out); made.push(url); urls.set(path, url);
      return url;
    }
    try { return { url: await visit(entry, ''), made }; }
    catch (e) { for (const u of made) try { revoke(u); } catch (_) {} return { error: String(e && e.message || e) }; }
  }

  // run → { code, output }. `source` runs a string instead of a file (node -e).
  async function run({ entry = null, source = null, cwd = '', argv = [], stdin = '', signal = null } = {}) {
    // `node -e`: the program is a virtual file in the cwd, so its relative imports resolve from there
    const virtual = (cwd ? cwd + '/' : '') + '[eval].mjs';
    const entryPath = entry || virtual;
    const b = source != null
      ? await createJsRunner({ read: (p) => (p === virtual ? String(source) : read(p)), makeModuleURL, spawn, revoke, timeoutMs })._bundle(virtual)
      : await bundle(entry);
    if (b.error) return { code: 1, output: `node: ${b.error}\n` };
    const bootURL = makeModuleURL(workerSource({ entryURL: b.url, argv: ['node', entryPath, ...argv], cwd, stdin }));
    const cleanup = () => { for (const u of [bootURL, ...(b.made || [])]) try { revoke(u); } catch (_) {} };
    return await new Promise((resolve) => {
      let out = ''; let done = false; let w = null;
      const finish = (code, extra = '') => { if (done) return; done = true; clearTimeout(timer); try { w && w.terminate(); } catch (_) {} cleanup(); resolve({ code, output: out + extra }); };
      const timer = setTimeout(() => finish(124, `node: timed out after ${Math.round(timeoutMs / 1000)} s — the gate was stopped\n`), timeoutMs);
      if (signal) { if (signal.aborted) return finish(130, 'node: stopped\n'); signal.addEventListener('abort', () => finish(130, 'node: stopped\n'), { once: true }); }
      try { w = spawn(bootURL); } catch (e) { return finish(1, `node: could not start a worker: ${e && e.message || e}\n`); }
      w.onMessage((m) => { if (!m || done) return; if (m.t === 'out') out += m.s; else if (m.t === 'exit') finish(Number.isInteger(m.code) ? m.code : 1); });
      w.onError((e) => finish(1, `Uncaught ${String((e && (e.message || e)) || e)}\n`));
    });
  }
  return { run, _bundle: bundle };
}
