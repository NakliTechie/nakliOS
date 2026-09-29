// C0 conformance suite — the gate artifact for Rig fileops.
//
//   node sys/rig/fileops/test/conformance.test.mjs
//
// Covers: every op exercised, byte-hash round-trip (text + binary), patch
// apply→revert byte-identical + atomic failure, and the traversal rejection
// matrix (every escape class fails closed). No deps; environment-neutral so it
// runs in node now and a browser harness later.

import { createFileops, MemoryBackend, applyPatch, reversePatch, createPatch } from '../index.mjs';

// ── tiny harness ──────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}
// FNV-1a over bytes — environment-neutral byte hash.
function hash(bytes) {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}
const bytesOf = (s) => new TextEncoder().encode(s);
const newFs = (root) => createFileops({ backend: new MemoryBackend(), root: root || '' });

// ── round-trips ─────────────────────────────────────────────────────────
await test('text write→read round-trip, byte-hash equal', async () => {
  const fs = newFs();
  const text = 'नमस्ते\nこんにちは\nhello 🌧\n';
  const w = await fs.write('a/b/note.txt', text, { createParents: true });
  assert(w.ok, 'write ok');
  const r = await fs.read('a/b/note.txt', { encoding: 'utf-8' });
  assert(r.ok, 'read ok');
  eq(r.data, text, 'text round-trips');
  const rb = await fs.read('a/b/note.txt');
  assert(rb.data instanceof Uint8Array, 'default read is Uint8Array');
  eq(hash(rb.data), hash(bytesOf(text)), 'byte-hash equal (text)');
});

await test('binary write→read round-trip, all 256 byte values', async () => {
  const fs = newFs();
  const buf = new Uint8Array(256);
  for (let i = 0; i < 256; i++) buf[i] = i;
  await fs.write('blob.bin', buf);
  const r = await fs.read('blob.bin');
  assert(r.ok && r.data instanceof Uint8Array, 'binary read is Uint8Array');
  eq(r.data.length, 256, 'length preserved');
  eq(hash(r.data), hash(buf), 'byte-hash equal (binary)');
  for (let i = 0; i < 256; i++) eq(r.data[i], i, `byte ${i} preserved`);
});

// ── stat / mkdir / list ────────────────────────────────────────────────
await test('stat reports file, dir, and sizes', async () => {
  const fs = newFs();
  await fs.write('dir/f.txt', 'abc');
  const sf = await fs.stat('dir/f.txt');
  assert(sf.ok, 'stat file ok'); eq(sf.stat.type, 'file', 'file type'); eq(sf.stat.size, 3, 'size');
  const sd = await fs.stat('dir');
  assert(sd.ok, 'stat dir ok'); eq(sd.stat.type, 'dir', 'implicit dir type');
  const miss = await fs.stat('nope');
  eq(miss.ok, false, 'missing not ok'); eq(miss.code, 'ENOENT', 'ENOENT');
});

await test('mkdir + list (direct and recursive)', async () => {
  const fs = newFs();
  await fs.mkdir('empty');
  await fs.write('src/a.js', '1');
  await fs.write('src/sub/b.js', '2');
  const direct = await fs.list('');
  const names = direct.entries.map((e) => e.name).sort();
  assert(names.includes('empty') && names.includes('src'), 'root lists empty + src');
  const srcList = await fs.list('src');
  const srcNames = srcList.entries.map((e) => `${e.name}:${e.type}`).sort();
  eq(JSON.stringify(srcNames), JSON.stringify(['a.js:file', 'sub:dir']), 'src direct children typed');
  const rec = await fs.list('src', { recursive: true });
  const recPaths = rec.entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  eq(JSON.stringify(recPaths), JSON.stringify(['src/a.js', 'src/sub/b.js']), 'recursive files');
});

// ── remove / move / copy ───────────────────────────────────────────────
await test('remove: file, non-empty guard, recursive', async () => {
  const fs = newFs();
  await fs.write('x/one.txt', 'a');
  await fs.write('x/two.txt', 'b');
  const guard = await fs.remove('x');
  eq(guard.code, 'ENOTEMPTY', 'non-empty without recursive fails closed');
  const rec = await fs.remove('x', { recursive: true });
  assert(rec.ok, 'recursive remove ok');
  eq((await fs.stat('x')).code, 'ENOENT', 'x is gone');
  eq((await fs.remove('x')).code, 'ENOENT', 'removing missing → ENOENT, no throw');
});

await test('copy + move with EEXIST guard', async () => {
  const fs = newFs();
  await fs.write('a.txt', 'hello');
  const c = await fs.copy('a.txt', 'b.txt');
  assert(c.ok, 'copy ok');
  eq((await fs.read('b.txt', { encoding: 'utf-8' })).data, 'hello', 'copy content');
  eq((await fs.copy('a.txt', 'b.txt')).code, 'EEXIST', 'copy onto existing fails closed');
  const m = await fs.move('a.txt', 'c.txt');
  assert(m.ok, 'move ok');
  eq((await fs.stat('a.txt')).code, 'ENOENT', 'source gone after move');
  eq((await fs.read('c.txt', { encoding: 'utf-8' })).data, 'hello', 'moved content');
});

// ── patch: apply → revert byte-identical, and atomic failure ────────────
await test('patch apply→revert byte-identical', async () => {
  const fs = newFs();
  const original = 'line1\nline2\nline3\n';
  await fs.write('f.txt', original);
  const diff = ['@@ -1,3 +1,3 @@', ' line1', '-line2', '+LINE2', ' line3'].join('\n');
  const p = await fs.patch('f.txt', diff);
  assert(p.ok, 'patch ok');
  eq((await fs.read('f.txt', { encoding: 'utf-8' })).data, 'line1\nLINE2\nline3\n', 'patched content');
  const rev = await fs.patch('f.txt', p.revert);
  assert(rev.ok, 'revert ok');
  const back = await fs.read('f.txt');
  eq(hash(back.data), hash(bytesOf(original)), 'revert restores original bytes');
});

await test('patch atomic: failed hunk names itself, file unchanged', async () => {
  const fs = newFs();
  const original = 'alpha\nbeta\n';
  await fs.write('f.txt', original);
  const before = hash((await fs.read('f.txt')).data);
  const badDiff = ['@@ -1,2 +1,2 @@', ' alpha', '-NOPE', '+zed'].join('\n');
  const p = await fs.patch('f.txt', badDiff);
  eq(p.ok, false, 'bad patch rejected');
  eq(p.code, 'EPATCH', 'EPATCH code');
  assert(/hunk #1/.test(p.message), `hunk named: ${p.message}`);
  eq(hash((await fs.read('f.txt')).data), before, 'file byte-unchanged after failed patch');
});

await test('patch preserves a no-trailing-newline file', async () => {
  const original = 'x\ny'; // no final newline
  // As `diff` writes it: each side's unterminated last line carries the marker.
  const diff = ['@@ -1,2 +1,2 @@', ' x', '-y', '\\ No newline at end of file', '+Y', '\\ No newline at end of file'].join('\n');
  const applied = applyPatch(original, diff);
  assert(applied.ok, 'apply ok');
  eq(applied.result, 'x\nY', 'no trailing newline preserved');
  const back = applyPatch(applied.result, reversePatch(diff));
  eq(back.result, original, 'reverse restores exactly');
  // A loose diff (the old side unmarked) still applies, and fs.patch's revert — computed from the
  // bytes — still restores the original exactly.
  const loose = ['@@ -1,2 +1,2 @@', ' x', '-y', '+Y', '\\ No newline at end of file'].join('\n');
  eq(applyPatch(original, loose).result, 'x\nY', 'a loose diff applies');
  const fs = newFs();
  await fs.write('n.txt', original);
  const p = await fs.patch('n.txt', loose);
  assert(p.ok, 'fs.patch applies the loose diff');
  assert((await fs.patch('n.txt', p.revert)).ok, 'its revert applies');
  eq((await fs.read('n.txt', { encoding: 'utf-8' })).data, original, 'and restores the bytes');
});

// createPatch is the inverse of applyPatch, final newline included; `diff -u` and `git diff` output
// ends in a newline, which parsePatch once read as an extra context line (every such patch failed).
await test('createPatch round-trips through applyPatch; a newline-terminated patch applies', async () => {
  eq(JSON.stringify(applyPatch('a\n', '@@ -1 +1 @@\n-a\n+b\n')), JSON.stringify({ ok: true, result: 'b\n' }), 'a patch ending in a newline');
  eq(applyPatch('a\nb\n', '@@ -1,0 +2 @@\n+x\n').result, 'a\nx\nb\n', '-N,0 inserts after line N');
  const cases = [['', 'a\n'], ['a\n', ''], ['a', 'a\n'], ['a\n', 'a'], ['\n', 'x'], ['x\ny', 'x\ny\n'],
    ['a\nb\nc\nd\ne\nf\ng\nh\n', 'a\nB\nc\nd\ne\nf\ng\nH\n'], ['r\r\n', 'r\n'], ['--- a\n', '-- a\n']];
  let seed = 3; const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const gen = () => { const l = []; for (let i = rnd(10); i > 0; i--) l.push(['a', 'b', '', ' x', '\\ No newline at end of file', '@@ -1 +1 @@'][rnd(6)]); const t = l.join('\n'); return rnd(2) && t ? t + '\n' : t; };
  for (let i = 0; i < 2000; i++) cases.push([gen(), gen()]);
  for (const [a, b] of cases) {
    const p = createPatch(a, b, { from: 'a/f', to: 'b/f' });
    const r = applyPatch(a, p);
    assert(r.ok && r.result === b, `round trip ${JSON.stringify(a)} -> ${JSON.stringify(b)}: ${JSON.stringify(r)}\n${p}`);
    if (p) { const back = applyPatch(b, reversePatch(p)); assert(back.ok && back.result === a, `reverse ${JSON.stringify(b)} -> ${JSON.stringify(a)}`); }
  }
  eq(createPatch('same\n', 'same\n'), '', 'equal texts give an empty patch');
});

// ── glob / grep ─────────────────────────────────────────────────────────
await test('glob matches by pattern within cwd', async () => {
  const fs = newFs();
  await fs.write('src/a.js', '');
  await fs.write('src/b.py', '');
  await fs.write('src/deep/c.js', '');
  const js = await fs.glob('**/*.js', { cwd: 'src' });
  eq(JSON.stringify(js.matches.sort()), JSON.stringify(['src/a.js', 'src/deep/c.js']), 'js glob');
  const top = await fs.glob('*.py', { cwd: 'src' });
  eq(JSON.stringify(top.matches), JSON.stringify(['src/b.py']), 'top-level py glob');
});

await test('grep finds lines, caps, reports truncation', async () => {
  const fs = newFs();
  await fs.write('a.txt', 'TODO one\nclean\nTODO two\n');
  await fs.write('b.txt', 'nothing\nTODO three\n');
  const all = await fs.grep('TODO', { glob: '*.txt' });
  eq(all.matches.length, 3, 'three TODOs');
  eq(all.truncated, false, 'not truncated');
  const capped = await fs.grep('TODO', { glob: '*.txt', maxResults: 2 });
  eq(capped.matches.length, 2, 'capped at 2');
  eq(capped.truncated, true, 'truncation reported');
});

// ── backend-agnostic: a recursive-list backend collapses correctly ───────
// The live Folder backend (fsList) lists one level; a Crate object-store may
// list recursively. fileops must be correct against both. This backend returns
// ALL descendants for any prefix; fileops must still yield correct children.
class RecursiveBackend extends MemoryBackend {
  async list(prefix) {
    const under = (k) => prefix === '' ? true : (k === prefix || k.startsWith(prefix + '/'));
    const out = new Set();
    for (const k of this.files.keys()) if (under(k) && k !== prefix) out.add(k);
    for (const k of this.symlinks.keys()) if (under(k) && k !== prefix) out.add(k);
    for (const d of this.dirs) if (under(d) && d !== prefix) out.add(d + '/');
    return [...out].sort();
  }
}

await test('fileops collapses a recursive-list backend to correct children', async () => {
  const fs = createFileops({ backend: new RecursiveBackend() });
  await fs.write('proj/src/a.js', '1');
  await fs.write('proj/src/deep/b.js', '2');
  await fs.write('proj/readme.md', 'r');
  const top = await fs.list('proj');
  eq(JSON.stringify(top.entries.map((e) => `${e.name}:${e.type}`).sort()),
    JSON.stringify(['readme.md:file', 'src:dir']), 'immediate children from a recursive backend');
  const rec = await fs.list('proj', { recursive: true });
  const files = rec.entries.filter((e) => e.type === 'file').map((e) => e.path).sort();
  eq(JSON.stringify(files), JSON.stringify(['proj/readme.md', 'proj/src/a.js', 'proj/src/deep/b.js']), 'recursive walk');
  const g = await fs.glob('**/*.js', { cwd: 'proj' });
  eq(JSON.stringify(g.matches.sort()), JSON.stringify(['proj/src/a.js', 'proj/src/deep/b.js']), 'glob over recursive backend');
});

// Model the live Crate object store: recursive list, dirs are implicit,
// delete() throws on a directory ("refuse to remove a folder"), mkdir is a
// no-op. fileops.remove/copy must still be correct against it.
class ObjectStoreBackend extends RecursiveBackend {
  async mkdir(_safePath) { /* implicit dirs — no-op */ }
  async delete(safePath) {
    const st = await this.stat(safePath);
    if (st && st.type === 'dir') throw new Error('refuse to remove a folder');
    this.files.delete(safePath);
    this.symlinks.delete(safePath);
  }
}

await test('object-store backend: recursive remove + copy work despite dir-delete throwing', async () => {
  const fs = createFileops({ backend: new ObjectStoreBackend() });
  await fs.write('proj/a.txt', 'A');
  await fs.write('proj/sub/b.txt', 'B');
  const cp = await fs.copy('proj', 'copyOfProj');
  assert(cp.ok, 'dir copy ok');
  eq((await fs.read('copyOfProj/sub/b.txt', { encoding: 'utf-8' })).data, 'B', 'nested file copied');
  const rm = await fs.remove('proj', { recursive: true });
  assert(rm.ok, `recursive remove ok (got ${rm.code || 'ok'})`);
  eq((await fs.stat('proj')).code, 'ENOENT', 'dir gone after remove');
  eq((await fs.stat('proj/sub/b.txt')).code, 'ENOENT', 'nested file gone');
});

// ── traversal rejection matrix — every class fails closed ───────────────
await test('traversal matrix: all escape classes rejected at the validator', async () => {
  const fs = newFs('mnt'); // non-empty mount root so ".." above it is meaningful
  const cases = [
    ['dotdot escape', '../secret'],
    ['nested dotdot escape', 'a/../../secret'],
    ['absolute escape', '/../secret'],
    ['encoded dot', '%2e%2e/secret'],
    ['encoded slash', 'a%2fb/../../secret'],
    ['backslash', '..\\secret'],
    ['control byte', 'a\u0001b'],
    ['non-string', 42],
  ];
  for (const [label, input] of cases) {
    let threw = false, res;
    try { res = await fs.read(input); } catch (_) { threw = true; }
    assert(!threw, `${label}: must not throw`);
    eq(res.ok, false, `${label}: rejected`);
    assert(res.code === 'EINVAL_PATH', `${label}: EINVAL_PATH (got ${res.code})`);
  }
});

await test('symlink escaping the mount is rejected; symlink inside resolves', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, root: 'mnt' });
  await fs.write('real.txt', 'inside');
  // Symlink inside the mount → resolves and reads through.
  backend.symlink('mnt/link-in', 'real.txt');
  const good = await fs.read('link-in', { encoding: 'utf-8' });
  assert(good.ok, 'in-mount symlink resolves'); eq(good.data, 'inside', 'follows to target');
  // Symlink whose target climbs above the mount root → rejected.
  backend.symlink('mnt/link-out', '../../etc/passwd');
  const bad = await fs.read('link-out');
  eq(bad.ok, false, 'out-of-mount symlink rejected');
  eq(bad.code, 'EINVAL_PATH', 'symlink escape → EINVAL_PATH');
});

await test('expected conditions return typed results, never throw', async () => {
  const fs = newFs();
  for (const call of [
    () => fs.read('missing'),
    () => fs.stat('missing'),
    () => fs.remove('missing'),
    () => fs.patch('missing', '@@ -1 +1 @@\n-a\n+b'),
    () => fs.list('missing'),
    () => fs.write('x', 12345), // invalid data type
  ]) {
    let threw = false, res;
    try { res = await call(); } catch (_) { threw = true; }
    assert(!threw, 'must not throw on expected condition');
    eq(res.ok, false, 'returns ok:false');
    assert(typeof res.code === 'string' && res.code.length > 0, 'has a typed code');
  }
});

// ── report ──────────────────────────────────────────────────────────────
// `mv d d/sub` copied d into itself and then removed d: both gone, exit 0 (2026-09-29).
await test('copy/move refuse a destination inside the source; overwrite replaces a file only', async () => {
  const fs = newFs();
  await fs.write('d/f.txt', 'keep');
  eq((await fs.move('d', 'd/sub')).code, 'EINVAL', 'move into its own subdirectory');
  eq((await fs.copy('d', 'd/sub')).code, 'EINVAL', 'copy into its own subdirectory');
  eq((await fs.move('d', 'd')).code, 'EINVAL', 'move onto itself');
  eq((await fs.read('d/f.txt', { encoding: 'utf-8' })).data, 'keep', 'd is intact');
  eq((await fs.move('d', 'dd')).ok, true, 'a sibling whose name starts the same is not inside');
  await fs.write('a.txt', 'A'); await fs.write('b.txt', 'B');
  eq((await fs.copy('a.txt', 'b.txt')).code, 'EEXIST', 'no overwrite by default');
  eq((await fs.copy('a.txt', 'b.txt', { overwrite: true })).ok, true, 'overwrite a file');
  eq((await fs.read('b.txt', { encoding: 'utf-8' })).data, 'A');
  await fs.write('c.txt', 'C');
  eq((await fs.move('c.txt', 'b.txt', { overwrite: true })).ok, true, 'move over a file');
  eq((await fs.read('b.txt', { encoding: 'utf-8' })).data, 'C');
  eq((await fs.stat('c.txt')).code, 'ENOENT', 'the source is gone');
  eq((await fs.copy('dd', 'b.txt', { overwrite: true })).code, 'EEXIST', 'a directory never replaces a file');
  eq((await fs.copy('b.txt', 'dd', { overwrite: true })).code, 'EEXIST', 'a file never replaces a directory');
  eq((await fs.copy('b.txt', 'b.txt', { overwrite: true })).code, 'EINVAL', 'a file onto itself');
});

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`C0 conformance: ${passed}/${total} passed`);
  process.exit(0);
} else {
  console.log(`C0 conformance: ${passed}/${total} passed, ${failures.length} FAILED`);
  for (const f of failures) console.log(`  ✗ ${f.name}: ${f.message}`);
  process.exit(1);
}
