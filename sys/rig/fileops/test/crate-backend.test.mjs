// Conformance — CrateBackend over a MOCK `naklios.fs` host (object-store shaped).
//
//   node sys/rig/fileops/test/crate-backend.test.mjs
//
// The mock implements the host surface CrateBackend depends on (readBinary /
// write / delete / exists / list), so the adapter's synthesized stat/mkdir/list
// logic is verified headlessly — and, crucially, through the real createFileops
// layer and a real createShell, proving the whole Forge stack persists against a
// Crate-shaped backend. Live Crate roaming is blocked on the parked SyncClient
// fix; this exercises the adapter only.

import { CrateBackend, stringHostAdapter } from '../crate-backend.mjs';
import { createFileops } from '../index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createShell } from '../../cli/shell.mjs';
import { MemoryBackend } from '../memory-backend.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

// ── a flat-object-store mock of `naklios.fs` (keys → bytes) ─────────────
class MockNakliosFs {
  constructor() { this.keys = new Map(); } // path -> Uint8Array
  async readBinary(path) {
    if (!this.keys.has(path)) throw new Error(`no such file: ${path}`);
    return this.keys.get(path).slice();
  }
  async write(path, data) { this.keys.set(path, data instanceof Uint8Array ? data.slice() : new Uint8Array(data)); }
  async delete(path) { this.keys.delete(path); }
  async exists(path) {
    return this.keys.has(path) || [...this.keys.keys()].some((k) => k.startsWith(path + '/'));
  }
  // Object-store listing: all descendant keys under the prefix (flat).
  async list(prefix) {
    const base = prefix === '' ? '' : prefix + '/';
    return [...this.keys.keys()].filter((k) => base === '' || k.startsWith(base));
  }
}

// ── direct backend contract ─────────────────────────────────────────────
await test('CrateBackend requires a host with the object-store methods', () => {
  let threw = false;
  try { new CrateBackend({}); } catch { threw = true; }
  assert(threw, 'rejects a non-host');
});

await test('write → readBinary round-trip; stat sizes the file', async () => {
  const be = new CrateBackend(new MockNakliosFs());
  await be.write('src/lib/a.txt', enc('hello'));
  eq(dec(await be.readBinary('src/lib/a.txt')), 'hello', 'round-trip');
  const st = await be.stat('src/lib/a.txt');
  eq(st.type, 'file', 'file type'); eq(st.size, 5, 'byte size');
  eq((await be.stat('src/lib')).type, 'dir', 'intermediate implicit dir');
  eq(await be.stat('nope.txt'), null, 'missing → null');
});

await test('list returns immediate children with dir suffix (derived from flat keys)', async () => {
  const be = new CrateBackend(new MockNakliosFs());
  await be.write('proj/a.txt', enc('a'));
  await be.write('proj/sub/b.txt', enc('b'));
  await be.mkdir('proj/empty');
  const ls = await be.list('proj');
  eq(JSON.stringify(ls), JSON.stringify(['proj/a.txt', 'proj/empty/', 'proj/sub/']), 'children + suffixes');
});

await test('mkdir markers are session-local; exists reflects them but they are not keys', async () => {
  const host = new MockNakliosFs();
  const be = new CrateBackend(host);
  await be.mkdir('build');
  assert(await be.exists('build'), 'empty dir exists in-session');
  eq((await be.stat('build')).type, 'dir', 'stat sees the marker');
  assert(!host.keys.has('build'), 'no phantom key written to the store');
});

await test('delete removes files; exists reflects it; root always exists', async () => {
  const be = new CrateBackend(new MockNakliosFs());
  await be.write('x.txt', enc('x'));
  assert(await be.exists('x.txt'), 'exists before');
  await be.delete('x.txt');
  assert(!(await be.exists('x.txt')), 'gone after');
  assert(await be.exists(''), 'root always exists');
});

await test('stringHostAdapter lets a read-only-string host serve bytes', async () => {
  const store = new Map([['note.txt', 'plain text']]);
  const minimalHost = {
    async read(p) { return store.get(p); },
    async write(p, d) { store.set(p, typeof d === 'string' ? d : new TextDecoder().decode(d)); },
    async delete(p) { store.delete(p); },
    async exists(p) { return store.has(p); },
    async list(prefix) { return [...store.keys()].filter((k) => prefix === '' || k.startsWith(prefix)); },
  };
  const be = new CrateBackend(stringHostAdapter(minimalHost));
  eq(dec(await be.readBinary('note.txt')), 'plain text', 'string host bytes');
});

// ── through the real fileops layer ──────────────────────────────────────
await test('createFileops over CrateBackend: write/read/list', async () => {
  const fs = createFileops({ backend: new CrateBackend(new MockNakliosFs()) });
  const w = await fs.write('notes/todo.txt', 'buy milk');
  assert(w.ok, 'write ok');
  const r = await fs.read('notes/todo.txt', { encoding: 'utf-8' });
  eq(r.data, 'buy milk', 'read back');
  const l = await fs.list('notes');
  assert(l.ok && l.entries.some((e) => e.name === 'todo.txt'), 'listed');
});

// ── through the shell (the full Forge stack) ────────────────────────────
await test('a shell over CrateBackend persists across a fresh shell (reload analogue)', async () => {
  const host = new MockNakliosFs(); // survives across shells, like the Crate across reloads
  function shellOn(backend) {
    const fs = createFileops({ backend });
    const registry = buildRigRegistry({ fs });
    const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
    const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
    return createShell({ registry, face });
  }
  const s1 = shellOn(new CrateBackend(host));
  await s1.feed('mkdir -p work');
  await s1.feed('echo persisted > work/data.txt');
  const s2 = shellOn(new CrateBackend(host)); // fresh backend over the SAME host store
  eq((await s2.feed('cat work/data.txt')).output, 'persisted', 'survived a fresh shell over the same store');
});

// Live 2026-09-24: a fresh project on Crate (workspace mounted at ws/<project>, no files yet) answered
// `ls` with ENOENT four times — an object store has no directory until a file sits under it.
await test('a fresh workspace mounted under a prefix: the empty root lists as empty, and `ls` exits 0', async () => {
  const fs = createFileops({ backend: new CrateBackend(new MockNakliosFs()), root: 'ws/p1' });
  const l = await fs.list('');
  assert(l.ok, 'list of the empty mount root is ok: ' + JSON.stringify(l));
  eq(l.entries.length, 0, 'and empty');
  const st = await fs.stat('');
  assert(st.ok && st.stat.type === 'dir', 'the root stats as a directory');
  assert(!(await fs.stat('nope')).ok, 'a missing path under it is still missing');
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const sh = createShell({ registry, face });
  const r = await sh.feed('ls -la');
  assert(!/ENOENT/.test(r.output || ''), '`ls -la` on the empty root does not say ENOENT: ' + JSON.stringify(r));
  await sh.feed('echo hi > c.txt');
  assert(/c\.txt/.test((await sh.feed('ls')).output), 'then lists what was written');
});

if (failures.length) {
  console.error(`crate-backend: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/rig/fileops/crate-backend conformance: ${passed}/${passed} passed`);
