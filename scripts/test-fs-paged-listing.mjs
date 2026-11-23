// Paged host listing (naklios.fs.list(prefix, { maxEntries, cursor })) and what it unlocks: Anvil's
// change capture on a NakliOS-hosted project. Before 2026-11-23 the host listed only whole folders, so
// CrateBackend refused the capture's paged listing with ENOTSUP and the scratch-file finish check never
// saw a created file on naklios.dev. No browser: the Folder handle and the host wire are fakes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { extractFunction, evaluate } from './anvil-harness.mjs';
import { CrateBackend } from '../sys/rig/fileops/crate-backend.mjs';
import { createFileops } from '../sys/rig/fileops/index.mjs';
import { createWorkspaceCapture } from '../sys/ai/workspace-capture.mjs';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const sdk = await readFile(new URL('../sdk/naklios.js', import.meta.url), 'utf8');

// A fake FileSystemDirectoryHandle tree: { name: string(file) | object(dir) }.
function dirHandle(tree) {
  return {
    kind: 'directory',
    async getDirectoryHandle(name) {
      const sub = tree[name];
      if (!sub || typeof sub !== 'object') throw Object.assign(new Error('missing'), { name: 'NotFoundError' });
      return dirHandle(sub);
    },
    entries() {
      const names = Object.keys(tree);
      let i = 0;
      return { [Symbol.asyncIterator]() { return this; },
        async next() { if (i >= names.length) return { done: true };
          const n = names[i++]; return { done: false, value: [n, { kind: typeof tree[n] === 'object' ? 'directory' : 'file' }] }; },
        async return() { return { done: true }; } };
    },
  };
}

function hostApi(tree, bound = 'fsa') {
  const context = { state: { fsHandle: dirHandle(tree), crate: {} }, fsEnsurePermission: async () => bound,
    fsRead: async () => '', fsReadBinary: async () => new Uint8Array(), fsList: async () => [] };
  const start = host.indexOf('const BACKENDS ='), end = host.indexOf('\n};', start) + 3;
  const code = ['const fsListCursors = new Map();', 'let fsListCursorSeq = 0;',
    extractFunction(host, 'fsListPage'), extractFunction(host, 'fsHostList'), host.slice(start, end),
    ';({ fsListPage, fsHostList })'].join('\n');
  return evaluate(code, context);
}

test('the host pages a Folder directory, binds the cursor to app, prefix and size, and strips the app prefix', async () => {
  const names = Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['f' + i + '.txt', 'x']));
  const api = hostApi({ apps: { anvil: { ws: { p: { ...names, sub: { 'a.txt': 'x' } } } } } });
  const first = await api.fsHostList({ prefix: 'ws/p', maxEntries: 4 }, 'anvil');
  assert.equal(first.entries.length, 4);
  assert.equal(first.truncated, true);
  assert.equal(first.snapshotConsistent, false);
  assert.ok(first.entries.every(e => e.startsWith('ws/p/')), 'entries are app-relative');
  await assert.rejects(api.fsHostList({ prefix: 'ws/p', maxEntries: 4, cursor: first.cursor }, 'other'), /EINVAL/,
    'another app cannot use the cursor');
  const second = await api.fsHostList({ prefix: 'ws/p', maxEntries: 4, cursor: first.cursor }, 'anvil');
  assert.equal(second.truncated, false);
  assert.equal(second.cursor, null);
  assert.deepEqual([...first.entries, ...second.entries].sort(),
    ['ws/p/f0.txt', 'ws/p/f1.txt', 'ws/p/f2.txt', 'ws/p/f3.txt', 'ws/p/f4.txt', 'ws/p/sub/']);
  await assert.rejects(api.fsHostList({ prefix: 'ws/p', maxEntries: 4, cursor: first.cursor }, 'anvil'), /EINVAL/,
    'a cursor is used once');
});

test('the host refuses bad page sizes, a missing directory, and paging on a backend without it', async () => {
  const api = hostApi({ apps: { anvil: { ws: {} } } });
  for (const maxEntries of [0, 1001, 2.5, '10']) await assert.rejects(api.fsHostList({ prefix: 'ws', maxEntries }, 'anvil'), /EINVAL/);
  await assert.rejects(api.fsHostList({ prefix: 'ws/none', maxEntries: 10 }, 'anvil'), e => e.code === 'ENOENT');
  const crate = hostApi({ apps: {} }, 'crate');
  await assert.rejects(crate.fsHostList({ prefix: '', maxEntries: 10 }, 'anvil'), e => e.code === 'ENOTSUP');
});

test('the host advertises paged listing for Folder only, and the SDK passes the page options through', () => {
  assert.match(host, /fsBoundedListing: fsCap && fsBackend === 'fsa',/);
  assert.match(sdk, /capabilities\.fsBoundedListing = msg\.fsBoundedListing === true;/);
  const m = /list:\s*(function \(prefix, options\) \{[\s\S]*?\n {6}\}),/.exec(sdk);
  assert.ok(m, 'the SDK list function was found');
  const sent = [];
  const list = evaluate(extractFunction(sdk, 'fsPayload') + '\n;(' + m[1] + ')',
    { capabilities: { fsBackend: 'fsa' }, rpc: (type, msg) => { sent.push({ type, msg }); return msg; } });
  list('ws/p', { maxEntries: 200, cursor: 'page-1' });
  list('ws/p');
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    { type: 'naklios:fs:list', msg: { backend: 'fsa', prefix: 'ws/p', maxEntries: 200, cursor: 'page-1' } },
    { type: 'naklios:fs:list', msg: { backend: 'fsa', prefix: 'ws/p' } }]);
});

// The SDK seen from inside an app: a map of app-relative keys over the real host paging code.
function sdkHost({ paged = true, hide = null } = {}) {
  const files = new Map([['ws/p/README.md', 'readme'], ['ws/p/src/app.js', 'code']]);
  function tree() {
    const root = {};
    for (const key of files.keys()) {
      if (hide && hide.has(key)) continue;
      const parts = ('apps/anvil/' + key).split('/');
      let node = root;
      for (const part of parts.slice(0, -1)) node = node[part] ||= {};
      node[parts.at(-1)] = 'x';
    }
    return root;
  }
  let api = null;
  return { files,
    supportsBoundedListing: paged, supportsBoundedReads: true,
    async list(prefix, options) {
      api = options?.cursor ? api : hostApi(tree());
      if (options?.maxEntries !== undefined) return api.fsHostList({ prefix, ...options }, 'anvil');
      return [...files.keys()].filter(k => k.startsWith(prefix + '/'));
    },
    async readBinary(path, { maxBytes } = {}) {
      const text = files.get(path);
      if (text === undefined) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      const bytes = new TextEncoder().encode(text);
      if (maxBytes !== undefined && bytes.length > maxBytes) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
      return bytes;
    },
    async stat(path) {
      if (files.has(path)) return { type: 'file', size: files.get(path).length };
      return [...files.keys()].some(k => k.startsWith(path + '/')) ? { type: 'dir', size: 0 } : null;
    },
    async exists(path) { return files.has(path) || [...files.keys()].some(k => k.startsWith(path + '/')); },
    async write(path, bytes) { files.set(path, new TextDecoder().decode(bytes)); },
    async delete(path) { files.delete(path); },
  };
}

test('a hosted Folder project: the capture lists it and reports a file the run created, never an existing one', async () => {
  const h = sdkHost();
  const fs = createFileops({ backend: new CrateBackend(h), root: 'ws/p' });
  const capture = createWorkspaceCapture(fs, 1);
  const started = await capture.start();
  assert.ok(!started.problems.some(p => /bounded listing failed/.test(p)), started.problems.join('; '));
  await fs.write('tmp/t.mjs', 'scratch');
  await capture.observe();
  await fs.write('livecheck/slug.py', 'def slugify(s): ...');
  await capture.observe();
  assert.deepEqual(capture.created(), ['livecheck/slug.py', 'tmp/t.mjs']);
});

test('a file one of the two starting listings missed is not called new', async () => {
  const hide = new Set(['ws/p/src/app.js']);
  const h = sdkHost({ hide });
  let pages = 0;
  const list = h.list;
  // The first listing (one page, the root) misses src/app.js; the second sees it.
  h.list = async (prefix, options) => { const page = await list(prefix, options);
    if (options?.maxEntries !== undefined && ++pages === 1) hide.clear(); return page; };
  const fs = createFileops({ backend: new CrateBackend(h), root: 'ws/p' });
  const capture = createWorkspaceCapture(fs, 2);
  await capture.start();
  await capture.observe();
  assert.deepEqual(capture.created(), []);
});

test('control: a file both starting listings missed is the one case reported as new', async () => {
  const hide = new Set(['ws/p/src/app.js']);
  const fs = createFileops({ backend: new CrateBackend(sdkHost({ hide })), root: 'ws/p' });
  const capture = createWorkspaceCapture(fs, 4);
  await capture.start();
  hide.clear();
  await capture.observe();
  assert.deepEqual(capture.created(), ['src/app.js']);
});

test('a host without paged listing still refuses before downloading a manifest, and created() reports none', async () => {
  const h = sdkHost({ paged: false });
  let full = 0;
  const list = h.list;
  h.list = async (prefix, options) => { if (options?.maxEntries === undefined) full++; return list(prefix, options); };
  const fs = createFileops({ backend: new CrateBackend(h), root: 'ws/p' });
  const capture = createWorkspaceCapture(fs, 3);
  const started = await capture.start();
  assert.ok(started.problems.some(p => /ENOTSUP/.test(p)));
  assert.equal(full, 0, 'the capture never asks for a whole listing');
  await fs.write('tmp/t.mjs', 'scratch');
  full = 0;
  await capture.observe();
  assert.equal(full, 0, 'nor does an observation');
  assert.deepEqual(capture.created(), []);
});
