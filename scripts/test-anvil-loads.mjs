// S2 (2026-09-24): the Anvil inline module LOADS — its whole top level runs, the boot finishes.
//
// test-anvil-parses proves the module is syntactically valid; `instantiate` proves single functions.
// Neither runs the module's own top level, so a name referenced at module scope that only exists
// inside a function (the B1 `runCtx` class), a const used before its declaration, or a boot step that
// throws, all stay green there while the real app paints "Anvil did not start". This lane evaluates
// the real module in node against a permissive DOM stub — every element access returns a harmless
// object — with storage that fails cleanly (IndexedDB errors, no OPFS, no network), and requires the
// boot to reach `window.__anvilBoot.ok = true` with no uncaught error.
//   node scripts/test-anvil-loads.mjs            (the lane)
//   node scripts/test-anvil-loads.mjs --probe    (print the first error with its stack, for debugging)
import assert from 'node:assert/strict';
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { inlineModule } from './anvil-harness.mjs';

const ROOT = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..') + '/').href;

// A DOM-ish object that accepts anything: property writes are kept, reads of unknown properties return
// another such object, calls and `new` return one, it iterates as empty, and it converts to '' / 0.
function anything() {
  const store = new Map();
  const target = function () {};
  return new Proxy(target, {
    get(_, k) {
      if (store.has(k)) return store.get(k);
      if (k === Symbol.toPrimitive) return (hint) => (hint === 'number' ? 0 : '');
      if (k === Symbol.iterator) return function* () {};
      if (k === 'then') return undefined; // never a thenable — `await el` must not hang
      if (k === 'length' || k === 'size' || k === 'scrollHeight' || k === 'clientWidth' || k === 'innerWidth') return 0;
      if (k === 'matches' || k === 'open' || k === 'checked' || k === 'hidden' || k === 'isConnected') return false;
      if (k === 'contains') return () => false;
      if (k === 'getAttribute' || k === 'closest' || k === 'querySelector' || k === 'getElementById') return () => null;
      if (k === 'querySelectorAll' || k === 'getElementsByClassName') return () => [];
      if (k === 'textContent' || k === 'innerHTML' || k === 'value' || k === 'innerText' || k === 'className') return '';
      const child = anything(); store.set(k, child); return child;
    },
    set(_, k, v) { store.set(k, v); return true; },
    apply() { return anything(); },
    construct() { return anything(); },
    has() { return true; },
  });
}

// Elements: getElementById / querySelector return a real stub element, so `$('x').onclick = …` works.
function element() { const el = anything(); return el; }
const errors = [];
const ls = new Map();
const win = globalThis;
const doc = anything();
doc.getElementById = () => element();
doc.querySelector = () => element();
doc.querySelectorAll = () => [];
doc.createElement = () => element();
doc.createTextNode = () => element();
doc.addEventListener = () => {};
doc.body = element(); doc.documentElement = element(); doc.head = element();
doc.visibilityState = 'visible'; doc.readyState = 'complete'; doc.referrer = '';
const idbFail = () => { const req = anything(); setTimeout(() => { try { req.error = new Error('no IndexedDB in the load lane'); req.onerror && req.onerror({ target: req }); } catch (_) {} }, 0); return req; };
Object.assign(win, {
  window: win, self: win, top: win, parent: win,
  document: doc,
  location: { search: '', href: 'http://anvil.test/apps/anvil/index.html', origin: 'http://anvil.test', hash: '', pathname: '/apps/anvil/index.html', reload() {} },
  localStorage: { getItem: (k) => (ls.has(k) ? ls.get(k) : null), setItem: (k, v) => ls.set(k, String(v)), removeItem: (k) => ls.delete(k), key: () => null, get length() { return ls.size; } },
  sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  indexedDB: { open: idbFail, deleteDatabase: idbFail, databases: async () => [] },
  matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {} }),
  getComputedStyle: () => anything(),
  requestAnimationFrame: (f) => setTimeout(() => f(0), 0), cancelAnimationFrame: (h) => clearTimeout(h),
  requestIdleCallback: (f) => setTimeout(() => f({ timeRemaining: () => 0 }), 0),
  addEventListener() {}, removeEventListener() {}, postMessage() {}, dispatchEvent() { return true; },
  fetch: async () => { throw new Error('no network in the load lane'); },
  ResizeObserver: class { observe() {} disconnect() {} unobserve() {} },
  MutationObserver: class { observe() {} disconnect() {} takeRecords() { return []; } },
  IntersectionObserver: class { observe() {} disconnect() {} },
  CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
  Worker: class { constructor() { throw new Error('no workers in the load lane'); } },
  alert() {}, confirm() { return false; }, prompt() { return null; },
  innerWidth: 1280, innerHeight: 800, devicePixelRatio: 1,
  isSecureContext: true, crossOriginIsolated: false,
  __anvilBoot: { ok: false },
  naklios: undefined, // standalone: the SDK script is not loaded here, as when naklios.js fails to fetch
});
try { Object.defineProperty(win, 'navigator', { value: { userAgent: 'node', language: 'en', languages: ['en'], hardwareConcurrency: 4, storage: { getDirectory: async () => { throw new Error('no OPFS in the load lane'); }, persisted: async () => false, persist: async () => false, estimate: async () => ({}) }, clipboard: { writeText: async () => {} }, locks: undefined, onLine: true }, configurable: true }); } catch (_) {}
process.on('uncaughtException', (e) => errors.push(e));
process.on('unhandledRejection', (e) => errors.push(e));

let src = await inlineModule();
// the module's relative imports resolve against the repo, exactly as they do from apps/anvil/
src = src.replace(/from\s+'\.\.\/\.\.\/([^']+)'/g, (_, p) => `from '${ROOT}${p}'`).replace(/import\(\s*'\.\.\/\.\.\/([^']+)'\s*\)/g, (_, p) => `import('${ROOT}${p}')`);
const dir = await mkdtemp(join(tmpdir(), 'anvil-load-'));
const file = join(dir, 'anvil-module.mjs');
await writeFile(file, src);

let loadError = null;
try { await import(pathToFileURL(file).href); } catch (e) { loadError = e; }
// the boot runs past the first await; give it the time a real boot gets before its net fires
const deadline = Date.now() + 8000;
while (!win.__anvilBoot.ok && !loadError && !errors.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));

// Stop collecting: the listeners that gather the module's own uncaught errors would otherwise swallow
// this lane's failing assertion and exit 0 (the first cut did exactly that — green on every mutant).
process.removeAllListeners('uncaughtException'); process.removeAllListeners('unhandledRejection');
const first = loadError || errors[0] || null;
if (process.argv.includes('--probe') && first) { console.error(first && first.stack || first); }
assert.equal(first, null, `the module threw while loading: ${first && (first.stack || first).toString().split('\n').slice(0, 3).join(' | ')}`);
assert.equal(win.__anvilBoot.ok, true, 'the boot reached `window.__anvilBoot.ok = true` (the net stands down) within 8 s');
console.log(`anvil-loads: the inline module (${src.split('\n').length} lines) evaluates and its boot finishes — no module-scope error, no uncaught rejection`);
process.exit(0);
