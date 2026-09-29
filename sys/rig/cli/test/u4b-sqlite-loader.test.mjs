import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createKiln } from '../../../kiln/kiln.mjs';

// Additive assertions requested after the first actual Pyodide run established
// that sqlite3 was unvendored. The original SQL assertion snapshot is unchanged.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
async function body(path, name) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  const found = source.match(new RegExp('(?:async\\s+)?function\\s+' + name + '\\([^]*?^\\}', 'm'));
  assert.ok(found, `real ${name} initializer is available`); return found[0];
}

test('SQLite worker loader awaits package loading before runtime exposure and network denial', async () => {
  const ready = deferred(), events = [], py = {
    version: 'test-loader-only',
    loadPackage: async (name, options) => { events.push(['package-start', name, options?.checkIntegrity]); await ready.promise; events.push(['package-ready', name]); },
    runPython: code => events.push(['preload', code]),
    FS: { mount: () => events.push(['mount']), filesystems: { MEMFS: {} } },
  };
  const actual = await body('../../../kiln/worker.mjs', 'initialize');
  const context = {
    PYODIDE_ENTRY_SHA256: 'fixed-entry-hash', Uint8Array, runtime: null, pyodide: null, mountPath: '/workspace', rigRpcBytes: 1024, networkNeutered: false,
    importPyodideEntry: async () => ({ loadPyodide: async () => { events.push(['core-loaded']); return py; } }),
    ensureDirectory: () => events.push(['directory']), createPyodideRuntime: () => { events.push(['runtime-exposed']); return {}; },
    installRigModule: () => events.push(['rig-installed']), installFilesystemGuard: () => events.push(['fs-guard']),
    neuterNetworkEgress: () => events.push(['network-denied']),
  };
  const initialize = vm.runInNewContext(actual + ';initialize', context);
  const loading = initialize({ indexURL: 'https://invalid.example/pinned/', interruptBuffer: new ArrayBuffer(4), mountPath: '/disposable' });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(events, [['core-loaded'], ['package-start', 'sqlite3', true]], 'no user runtime or network denial before verified package resolves');
  ready.resolve(); await loading;
  assert.deepEqual(events, [['core-loaded'], ['package-start', 'sqlite3', true], ['package-ready', 'sqlite3'], ['preload', 'import json, base64, math, sqlite3'], ['directory'], ['mount'], ['runtime-exposed'], ['rig-installed'], ['fs-guard'], ['network-denied']]);
});

test('SQLite main-thread default loader awaits the fixed package before returning its runtime', async () => {
  const ready = deferred(), events = [], key = Symbol.for('naklios.b10.sqlite.loader-only');
  const py = { loadPackage: async (name, options) => { events.push([name, options?.checkIntegrity]); await ready.promise; }, runPython: code => events.push(['preload', code]) };
  globalThis[key] = py;
  try {
    const actual = await body('../../../kiln/main-thread-runtime.mjs', 'defaultLoadPyodide');
    // Only the imported module is substituted. The production loader body runs
    // unchanged, including its await and return statements.
    const url = 'data:text/javascript,' + encodeURIComponent('export async function loadPyodide(){return globalThis[Symbol.for("naklios.b10.sqlite.loader-only")];}//');
    const load = new Function('PYODIDE_INDEX_URL', actual + ';return defaultLoadPyodide;')(url);
    let returned = false; const loading = load().then(value => { returned = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, [['sqlite3', true]]); assert.equal(returned, false, 'loader must await verified package loading');
    ready.resolve(); assert.equal(await loading, py);
    assert.deepEqual(events, [['sqlite3', true], ['preload', 'import json, base64, math, sqlite3']]);
  } finally { delete globalThis[key]; }
});

test('SQLite package lifecycle remains behind Kiln consent and reports package failure', async () => {
  let consent = false, loads = 0;
  const kiln = createKiln({ consent: () => consent, loadRuntime: async () => { loads++; throw new Error('sqlite3 package unavailable'); } });
  const refused = await kiln.ensureReady(); assert.equal(refused.ok, false); assert.equal(refused.reason, 'consent-withheld'); assert.equal(loads, 0);
  consent = true; const unavailable = await kiln.ensureReady(); assert.equal(unavailable.ok, false); assert.match(unavailable.message, /sqlite3 package unavailable/); assert.equal(loads, 1);
});
