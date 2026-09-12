// Drive Anvil's inline module HEADLESSLY.
//
// The gate could parse the inline module (test-anvil-parses.mjs) and grep it for strings, but it
// could not RUN it — so a scope error, an unassigned variable, an unwired import and a mis-bound
// button all survived a green 76-step gate (forward-pass 2026-09-07, NAF-04/08/09/19). A grep
// cannot see any of those. This extracts a named function or a marked region out of the inline
// module and evaluates it in a fresh `vm` realm with dependencies you inject, so a test can call
// the REAL handler and assert on what it returns.
//
// Deliberately not a DOM emulator: you pass in exactly the bindings the extracted code touches,
// so a test states its assumptions instead of inheriting a browser.
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const APP = new URL('../apps/anvil/index.html', import.meta.url);

// The concatenated inline module text (imports included — strip them yourself if you re-parse).
export async function inlineModule(appUrl = APP) {
  const html = await readFile(appUrl, 'utf8');
  const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (!blocks.length) throw new Error('anvil-harness: no inline module found');
  return blocks.join('\n');
}

// Walk from `i` (which must index the opening brace) to its match, skipping over string literals,
// template literals, regex-ish slashes and comments so a brace inside text never miscounts.
function matchBrace(src, i) {
  let depth = 0;
  for (let p = i; p < src.length; p++) {
    const c = src[p], n = src[p + 1];
    if (c === '/' && n === '/') { p = src.indexOf('\n', p); if (p < 0) break; continue; }
    if (c === '/' && n === '*') { p = src.indexOf('*/', p + 2); if (p < 0) break; p++; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      for (p++; p < src.length; p++) {
        if (src[p] === '\\') { p++; continue; }
        if (src[p] === q) break;
        // a template's ${ } may itself contain braces and quotes; skip it wholesale
        if (q === '`' && src[p] === '$' && src[p + 1] === '{') { const e = matchBrace(src, p + 1); if (e < 0) return -1; p = e; }
      }
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return p; }
  }
  return -1;
}

// Source text of a top-level function, by name. Handles `function f(`, `async function f(`,
// `const f = (…) =>`, `const f = async (…) =>` and `const f = async function(`.
export function extractFunction(src, name) {
  const pats = [
    new RegExp(`(?:^|\\n)\\s*(?:async\\s+)?function\\s+${name}\\s*\\(`),
    new RegExp(`(?:^|\\n)\\s*(?:const|let|var)\\s+${name}\\s*=\\s*(?:async\\s*)?(?:function\\s*)?\\(`),
  ];
  for (const re of pats) {
    const m = re.exec(src);
    if (!m) continue;
    const open = src.indexOf('{', m.index + m[0].length - 1);
    if (open < 0) continue;
    const close = matchBrace(src, open);
    if (close < 0) continue;
    // back up to the start of the declaration line so the returned text is self-contained
    const from = src.lastIndexOf('\n', m.index + 1) + 1;
    return src.slice(from, close + 1);
  }
  throw new Error(`anvil-harness: function "${name}" not found in the inline module`);
}

// Source text between two literal markers (inclusive of `start`, exclusive of `end`). Use when the
// region is a branch inside a bigger function rather than a named function of its own.
export function extractRegion(src, start, end) {
  const a = src.indexOf(start);
  if (a < 0) throw new Error(`anvil-harness: start marker not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  if (b < 0) throw new Error(`anvil-harness: end marker not found: ${end}`);
  return src.slice(a, b);
}

// Evaluate `expr` in a fresh realm whose globals are `ctx`, and return its value. `ctx` is mutated
// in place, so the caller can read back anything the code assigned.
export function evaluate(expr, ctx = {}) {
  const sandbox = { console, JSON, String, Number, Boolean, Array, Object, Math, Date, Promise,
    RegExp, Error, TypeError, Set, Map, Symbol, structuredClone, ...ctx };
  return vm.runInNewContext(expr, vm.createContext(sandbox));
}

// Wrap an extracted function's source so it becomes a callable value, then evaluate it.
// `name` must be the same name used to extract it.
export function instantiate(fnSource, name, ctx = {}) {
  return evaluate(`${fnSource}\n;${name}`, ctx);
}

// A minimal in-memory fs shaped like the app's `fs` face: read/write/list/remove.
// `files` is a plain object of path -> contents, and stays readable after the call.
// Writes keep what a real store keeps: UTF-8, decoded again on read — a lone surrogate comes back
// as U+FFFD, exactly as OPFS hands it back. A ledger that tokens the un-encoded string is caught here.
const asStored = (s) => new TextDecoder('utf-8').decode(new TextEncoder().encode(String(s ?? '')));
export function memFs(files = {}) {
  const store = { ...files };
  return {
    store,
    read: async (p) => (p in store ? { ok: true, data: store[p] } : { ok: false, error: 'ENOENT' }),
    write: async (p, d) => { store[p] = asStored(d); return { ok: true }; },
    remove: async (p) => { delete store[p]; return { ok: true }; },
    list: async (dir) => ({ ok: true, entries: Object.keys(store)
      .filter((p) => p.startsWith(dir))
      .map((p) => ({ path: p, name: p.slice(dir.length).replace(/^\//, ''), kind: 'file' })) }),
  };
}

// An fs whose writes always fail — for asserting that a failed write is REPORTED, not swallowed.
export function failingFs(error = 'disk full') {
  const base = memFs();
  return { ...base, write: async () => ({ ok: false, error }) };
}
