// Kiln Worker-runtime headless seams. The actual Worker + Pyodide execution is
// covered by test/kiln-worker-harness.html in a cross-origin-isolated browser.

import { readFile } from 'node:fs/promises';
import { MemoryBackend } from '../../rig/fileops/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createFsBridge } from '../fs-bridge.mjs';
import { generateRigModule } from '../rig-bindings.mjs';
import {
  createWorkerRuntime,
  deriveRigAllowlist,
  fromRigJsonValue,
  snapshotBridge,
  syncWorkerSnapshot,
  toRigJsonValue,
  truncateUtf8Bytes,
} from '../worker-runtime.mjs';
import { neuterNetworkEgress, NETWORK_EGRESS_GLOBALS } from '../worker.mjs';

// ── Low11: the response channel is authenticated by a nonce Python never sees ──
//
// The Rig back-channel needs `postMessage` un-neutered, so model-authored Python shares the
// Worker's postMessage and can forge a `{type:'response'}`. Request ids were made unguessable
// first, which was not enough: a session that plants its own `self` 'message' listener READS the
// id off the incoming request. The id cannot fix that — it has to ride on the request to be
// matched at all.
//
// So the auth tag is a second value that never travels toward the Worker after `init`: a session
// nonce, held in a worker.mjs module closure (not a global — `js.<x>` from Python resolves
// globals) and stamped on every reply. A forger holding every request id has nothing to stamp.
//
// This drives the REAL message loop through the injected WorkerClass seam. Before it, that loop
// had no test at all — every other case in this file is a pure helper.
class FakeWorker {
  constructor() { this.sent = []; this.listeners = {}; FakeWorker.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  postMessage(msg) { this.sent.push(msg); }
  terminate() {}
  emit(data) { for (const fn of (this.listeners.message || [])) fn({ data }); }
  get lastRequest() { return this.sent[this.sent.length - 1]; }
}

async function withFakeWorker(fn) {
  const realSAB = globalThis.SharedArrayBuffer;
  const realCreate = globalThis.URL.createObjectURL, realRevoke = globalThis.URL.revokeObjectURL;
  if (typeof globalThis.SharedArrayBuffer !== 'function') globalThis.SharedArrayBuffer = ArrayBuffer;
  globalThis.URL.createObjectURL = () => 'blob:fake';
  globalThis.URL.revokeObjectURL = () => {};
  try { return await fn(); }
  finally {
    globalThis.SharedArrayBuffer = realSAB;
    globalThis.URL.createObjectURL = realCreate; globalThis.URL.revokeObjectURL = realRevoke;
  }
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; } catch (error) { failures.push({ name, message: error.message }); }
}
function assert(condition, message) { if (!condition) throw new Error(message || 'assert'); }
function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || 'ne'}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`);
}

async function lowElevenCases() {
  await test('Low11: a response with the right id but no nonce is dropped', async () => {
    await withFakeWorker(async () => {
      const started = createWorkerRuntime({ WorkerClass: FakeWorker, allowUngovernedWrites: true });
      started.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      const w = FakeWorker.last;
      const init = w.lastRequest;
      eq(init.op, 'init', 'the first request is init');
      assert(typeof init.sessionNonce === 'string' && init.sessionNonce.length > 8, 'init carries a nonce');

      let settled = false;
      started.then(() => { settled = true; }, () => { settled = true; });
      // What Python can build today: the correct id, read off a planted listener, and no nonce.
      w.emit({ type: 'response', id: init.id, ok: true, value: { version: 'forged' } });
      await new Promise((r) => setTimeout(r, 0));
      assert(!settled, 'no nonce → dropped');
      w.emit({ type: 'response', id: init.id, ok: true, nonce: 'not-the-nonce', value: { version: 'forged' } });
      await new Promise((r) => setTimeout(r, 0));
      assert(!settled, 'wrong nonce → dropped');
      // The genuine reply carries both and settles it.
      w.emit({ type: 'response', id: init.id, ok: true, nonce: init.sessionNonce, value: { version: 'real', mountPath: '/workspace' } });
      await new Promise((r) => setTimeout(r, 0));
      assert(settled, 'id AND nonce settles the request');
    });
  });

  await test('Low11: no request after init carries the nonce', async () => {
    await withFakeWorker(async () => {
      const started = createWorkerRuntime({ WorkerClass: FakeWorker, allowUngovernedWrites: true });
      started.catch(() => {});
      await new Promise((r) => setTimeout(r, 0));
      const w = FakeWorker.last;
      const init = w.lastRequest;
      w.emit({ type: 'response', id: init.id, ok: true, nonce: init.sessionNonce, value: { version: 'real', mountPath: '/workspace' } });
      const rt = await started;
      const before = w.sent.length;
      try { const p = rt.runCode('1', {}); p.catch(() => {}); } catch (_) { /* fine */ }
      await new Promise((r) => setTimeout(r, 0));
      for (const msg of w.sent.slice(before)) {
        assert(!('sessionNonce' in msg) && !('nonce' in msg),
          'the nonce never travels toward the Worker again — that is why a planted listener cannot forge');
      }
    });
  });

  // The FakeWorker above simulates the Worker's replies — it never EXECUTES worker.mjs, and the
  // real one needs a cross-origin-isolated browser (see this file's header). So the Worker half
  // is checked at the source level. Weaker than behavioural, and said plainly rather than left to
  // look like the same kind of check as the cases above: mutation testing showed all three of
  // these survive every behavioural case in this file.
  await test('Low11: worker.mjs stamps the nonce, keeps it off globals, and cannot be re-keyed', async () => {
    const src = await readFile(new URL('../worker.mjs', import.meta.url), 'utf8');
    assert(/self\.postMessage\(\{ type: 'response', id, ok, value, nonce: sessionNonce \}\)/.test(src),
      'every reply carries the nonce');
    assert(/^let sessionNonce = null;$/m.test(src), 'it is a module-scope binding');
    assert(!/globalThis\.sessionNonce|self\.sessionNonce/.test(src),
      'and never a global — js.<x> from Python resolves globals, not module closures');
    assert(/if \(sessionNonce === null && typeof message\.sessionNonce === 'string'\)/.test(src),
      'only the FIRST init sets it — a second init must not be able to re-key the channel');
    // And it is captured before Pyodide loads, so no user code exists yet to look for it.
    const initAt = src.indexOf('sessionNonce = message.sessionNonce');
    const loadAt = src.indexOf('await initialize(message)');
    assert(initAt > 0 && loadAt > initAt, 'the nonce is captured BEFORE initialize() loads Pyodide');
  });

  await test('Low11/Low12: an empty allowlist fails closed', () => {
    const empty = deriveRigAllowlist('');
    eq(empty.size, 0, 'no bindings means an empty allowlist');
    assert(!empty.has('fs.read'), 'and an empty allowlist admits nothing');
  });
}

function makeGovernedMount({ prefixes = [''] } = {}) {
  const backend = new MemoryBackend();
  const bridge = createFsBridge({ backend, mount: 'workspace' });
  const registry = buildRigRegistry({ fs: bridge._fs });
  const grant = createGrant({ prefixes, scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const logFs = createFsBridge({ backend: new MemoryBackend(), mount: 'audit' })._fs;
  const opLog = createOpLog({ fs: logFs, now: () => 42 });
  const face = createAgentFace({ registry, grant, opLog, actor: 'agent', caller: 'kiln-test' });
  return { backend, bridge, face, opLog };
}

await test('Rig JSON codec preserves nested binary values', async () => {
  const source = { ok: true, data: new Uint8Array([0, 1, 127, 255]), nested: [new Uint8Array([9])] };
  const decoded = fromRigJsonValue(JSON.parse(JSON.stringify(toRigJsonValue(source))));
  assert(decoded.data instanceof Uint8Array, 'data decoded to Uint8Array');
  eq([...decoded.data].join(','), '0,1,127,255', 'data bytes');
  eq([...decoded.nested[0]].join(','), '9', 'nested bytes');
});

await test('snapshotBridge captures directories and files byte-identically', async () => {
  const { bridge } = makeGovernedMount();
  await bridge.mkdir('nested', { createParents: true });
  await bridge.write('nested/a.bin', new Uint8Array([0, 2, 4, 8]));
  const snapshot = await snapshotBridge(bridge);
  assert(snapshot.dirs.includes('nested'), 'directory captured');
  const file = snapshot.files.find((entry) => entry.path === 'nested/a.bin');
  assert(file, 'file captured');
  eq([...file.data].join(','), '0,2,4,8', 'file bytes');
});

await test('Worker snapshot writes route through Rig and removals stage', async () => {
  const { bridge, face, opLog } = makeGovernedMount();
  await bridge.write('old.txt', 'old');
  const before = await snapshotBridge(bridge);
  const after = {
    dirs: ['new'],
    files: [{ path: 'new/value.bin', data: new Uint8Array([3, 1, 4]) }],
  };
  const synced = await syncWorkerSnapshot({ before, after, face, fsBridge: bridge });
  eq(synced.errors.length, 0, 'no sync errors');
  eq(synced.staged.length, 1, 'one staged removal');
  eq(synced.staged[0].command, 'fs.remove', 'removal command staged');
  eq([...(await bridge.read('new/value.bin')).data].join(','), '3,1,4', 'write persisted');
  assert((await bridge.readText('old.txt')).ok, 'staged removal did not delete');
  const log = await opLog.read();
  assert(log.some((entry) => entry.command === 'fs.write' && entry.status === 'ok'), 'write logged');
  assert(log.some((entry) => entry.command === 'fs.remove' && entry.status === 'staged'), 'removal logged');
  eq(face.pendingProposals().length, 1, 'proposal visible to operator');
});

await test('Worker snapshot cannot persist outside the active grant', async () => {
  const { bridge, face } = makeGovernedMount({ prefixes: ['allowed'] });
  const before = await snapshotBridge(bridge);
  const after = { dirs: [], files: [{ path: 'denied.txt', data: new Uint8Array([1]) }] };
  const synced = await syncWorkerSnapshot({ before, after, face, fsBridge: bridge });
  eq(synced.errors.length, 1, 'one grant error');
  eq(synced.errors[0].result.code, 'EGRANT', 'typed grant denial');
  eq((await bridge.read('denied.txt')).code, 'ENOENT', 'denied write absent');
});

await test('network-egress globals are stubbed to throwing functions (C-K1)', async () => {
  // The Worker neuters these before any user cell; assert every stub throws the
  // Kiln denial rather than reaching the network.
  const fakeGlobal = { navigator: { sendBeacon: () => 'sent' } };
  neuterNetworkEgress(fakeGlobal);
  for (const name of NETWORK_EGRESS_GLOBALS) {
    assert(typeof fakeGlobal[name] === 'function', `${name} replaced with a function`);
    let threw = false;
    try { fakeGlobal[name](); } catch (error) { threw = /network access is disabled in Kiln/.test(error.message); }
    assert(threw, `${name} throws the Kiln network-disabled error`);
  }
  let beaconThrew = false;
  try { fakeGlobal.navigator.sendBeacon('http://x'); } catch (error) { beaconThrew = /network access is disabled in Kiln/.test(error.message); }
  assert(beaconThrew, 'navigator.sendBeacon throws the Kiln network-disabled error');
  // postMessage must NOT be neutered — the Rig channel depends on it.
  assert(!NETWORK_EGRESS_GLOBALS.includes('postMessage'), 'postMessage left intact for the Rig channel');
});

await test('rig-call allowlist rejects a name with no generated binding (M-K2)', async () => {
  const { bridge } = makeGovernedMount();
  const registry = buildRigRegistry({ fs: bridge._fs });
  const allowlist = deriveRigAllowlist(generateRigModule(registry).source);
  assert(allowlist.has('fs.read'), 'a real command is on the allowlist');
  // The exact predicate handleRigCall enforces before face.invoke:
  const denied = (name) => allowlist.size > 0 && !allowlist.has(name);
  assert(denied('fs.__forged'), 'a forged fs command is denied');
  assert(denied('admin.wipe'), 'an unexposed namespaced command is denied');
  assert(!denied('fs.read'), 'an exposed command is admitted');
});

await test('face-less snapshot writes are refused unless explicitly ungoverned (M-K5)', async () => {
  const { bridge } = makeGovernedMount();
  const before = { dirs: [], files: [] };
  const after = { dirs: [], files: [{ path: 'x.txt', data: new Uint8Array([1]) }] };
  const refused = await syncWorkerSnapshot({ before, after, face: null, fsBridge: bridge });
  eq(refused.errors.length, 1, 'ungoverned write refused');
  eq(refused.errors[0].result.code, 'EUNGOVERNED', 'typed ungoverned refusal');
  eq((await bridge.read('x.txt')).code, 'ENOENT', 'no silent write landed');
  const allowed = await syncWorkerSnapshot({ before, after, face: null, fsBridge: bridge, allowUngoverned: true });
  eq(allowed.errors.length, 0, 'opt-in write permitted');
  eq([...(await bridge.read('x.txt')).data].join(','), '1', 'opt-in write landed');
});

await test('Rig error truncation cuts on a UTF-8 boundary (L-K7)', async () => {
  const bytes = new TextEncoder().encode('abc€'); // '€' = 3 bytes E2 82 AC
  const cut = truncateUtf8Bytes(bytes, 4); // 4 would split the euro after its first byte
  eq(cut.length, 3, 'partial trailing sequence dropped');
  eq(new TextDecoder('utf-8', { fatal: true }).decode(cut), 'abc', 'decodes cleanly, no split codepoint');
  const whole = truncateUtf8Bytes(bytes, 100);
  eq(whole.length, bytes.length, 'under-cap input is returned unchanged');
});

await lowElevenCases();
const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`K0-K2/worker-runtime conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`K0-K2/worker-runtime conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.log(`  FAIL ${failure.name}: ${failure.message}`);
  process.exit(1);
}
