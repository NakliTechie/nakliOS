// Conformance — OverlayBackend: copy-on-write worktree over a base backend.
//   node sys/rig/fileops/test/overlay-backend.test.mjs
import { MemoryBackend } from '../memory-backend.mjs';
import { OverlayBackend, PIN_MAX_BYTES } from '../overlay-backend.mjs';
import { createFileops } from '../fileops.mjs';

let passed = 0; const failures = [];
async function test(n, fn){ try { await fn(); passed++; } catch (e){ failures.push({ n, message: e.message }); } }
function assert(c, m){ if (!c) throw new Error(m || 'assertion failed'); }
function eq(a, b, m){ if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
const enc = (s) => new TextEncoder().encode(s);
const dec = (u) => new TextDecoder().decode(u);

async function seed(){
  const base = new MemoryBackend();
  await base.write('README.md', enc('root readme'));
  await base.write('src/app.js', enc('app'));
  await base.write('src/util.js', enc('util'));
  await base.write('docs/guide.md', enc('guide'));
  return base;
}

await test('read falls through to base; base is not mutated by the overlay', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  eq(dec(await ov.readBinary('src/app.js')), 'app', 'reads base file');
  await ov.write('src/app.js', enc('CHANGED'));
  eq(dec(await ov.readBinary('src/app.js')), 'CHANGED', 'overlay shadows base');
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base untouched');
});

await test('delete tombstones in the overlay only', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.delete('README.md');
  eq(await ov.exists('README.md'), false, 'gone from overlay');
  let threw = false; try { await ov.readBinary('README.md'); } catch (_){ threw = true; }
  assert(threw, 'read of tombstoned throws');
  eq(await base.exists('README.md'), true, 'base still has it');
});

await test('write of a new deep file creates implicit dirs in the merged view', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('lib/deep/x.txt', enc('x'));
  eq((await ov.stat('lib')).type, 'dir', 'new dir exists');
  eq((await ov.stat('lib/deep')).type, 'dir', 'nested dir exists');
  const top = await ov.list('');
  assert(top.includes('lib/'), 'lib/ shows at root');
  assert(top.includes('README.md'), 'base root file still lists');
});

await test('list merges base + overlay, applies tombstones', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('src/new.js', enc('new'));
  await ov.delete('src/util.js');
  const kids = await ov.list('src');
  assert(kids.includes('src/app.js'), 'kept app.js');
  assert(kids.includes('src/new.js'), 'added new.js');
  assert(!kids.includes('src/util.js'), 'tombstoned util.js hidden');
});

await test('a base dir emptied purely by tombstones vanishes from the overlay view', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.delete('docs/guide.md'); // the only file under docs/
  eq(await ov.stat('docs'), null, 'docs dir gone');
  const top = await ov.list('');
  assert(!top.includes('docs/'), 'docs/ no longer listed');
  eq(await base.exists('docs'), true, 'base docs dir intact');
});

await test('two overlays over one base are isolated from each other', async () => {
  const base = await seed();
  const a = new OverlayBackend(base);
  const b = new OverlayBackend(base);
  await a.write('src/app.js', enc('from-A'));
  await b.write('src/app.js', enc('from-B'));
  await b.write('b-only.txt', enc('b'));
  eq(dec(await a.readBinary('src/app.js')), 'from-A', 'A sees its own write');
  eq(dec(await b.readBinary('src/app.js')), 'from-B', 'B sees its own write');
  eq(await a.exists('b-only.txt'), false, "A can't see B's new file");
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base still original');
});

await test('changes() reports written + deleted, sorted', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('z.txt', enc('z'));
  await ov.write('a.txt', enc('a'));
  await ov.delete('README.md');
  const ch = ov.changes();
  eq(JSON.stringify(ch.written), JSON.stringify(['a.txt', 'z.txt']), 'written sorted');
  eq(JSON.stringify(ch.deleted), JSON.stringify(['README.md']), 'deleted listed');
  assert(ov.hasChanges(), 'hasChanges true');
  assert(!new OverlayBackend(base).hasChanges(), 'fresh overlay has no changes');
});

await test('commit replays writes then deletes onto a target via the applier', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.write('src/app.js', enc('MERGED'));
  await ov.write('brand/new.txt', enc('n'));
  await ov.delete('docs/guide.md');
  const order = [];
  const applied = await ov.commit({
    write: async (p, bytes) => { order.push('w:' + p); await base.write(p, bytes); },
    remove: async (p) => { order.push('d:' + p); await base.delete(p); },
  });
  eq(dec(await base.readBinary('src/app.js')), 'MERGED', 'base updated');
  eq(dec(await base.readBinary('brand/new.txt')), 'n', 'new file landed');
  eq(await base.exists('docs/guide.md'), false, 'deleted on base');
  eq(order[0], 'w:brand/new.txt', 'writes before deletes, sorted');
  eq(order[order.length - 1], 'd:docs/guide.md', 'delete last');
  eq(applied.written.length, 2, 'reported 2 writes');
});

await test('delete isolation: a tombstone in overlay A is invisible to overlay B', async () => {
  const base = await seed();
  const a = new OverlayBackend(base);
  const b = new OverlayBackend(base);
  await a.delete('README.md');
  eq(await a.exists('README.md'), false, 'A hid it');
  eq(await b.exists('README.md'), true, "B still sees it (A's tombstone did not leak)");
  eq(dec(await b.readBinary('README.md')), 'root readme', 'B reads the base content');
});

await test('commit through a real fileops applier is BYTE-EXACT (fixes lossy text round-trip)', async () => {
  // Mirrors the production applier: overlay.commit → fs.write(rel, bytes). A byte
  // (0xFF) that a UTF-8 decode/encode would mangle must survive intact.
  const base = new MemoryBackend();
  const ov = new OverlayBackend(base);
  const blob = Uint8Array.from([0x00, 0xff, 0x10, 0x80, 0x41]); // 0xFF is invalid UTF-8
  await ov.write('blob.bin', blob);
  const realFs = createFileops({ backend: base });
  await ov.commit({
    write: async (p, bytes) => { await realFs.write(p, bytes); }, // byte-accurate, like production
    remove: async (p) => { await realFs.remove(p); },
  });
  const got = await base.readBinary('blob.bin');
  eq(got.length, blob.length, 'length preserved');
  assert(blob.every((v, i) => v === got[i]), 'every byte preserved (0xFF intact)');
});

// ── #9 snapshot-rooted overlays: pins, and the fence at merge ──────────────────────────────
await test('#9 pins: what the child has looked at does not move under it when the base changes', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  eq(dec(await ov.readBinary('src/app.js')), 'app', 'first read pins');
  eq(await ov.exists('src/new.js'), false, 'first exists pins an absence');
  eq((await ov.list('docs')).join(','), 'docs/guide.md', 'first list pins the listing');
  const st = await ov.stat('src/util.js'); eq(st.size, 4, 'first stat pins');
  // the base moves: a sibling merged, the owner edited
  await base.write('src/app.js', enc('app-v2'));
  await base.write('src/new.js', enc('new'));
  await base.write('docs/more.md', enc('more'));
  await base.write('src/util.js', enc('util-longer'));
  eq(dec(await ov.readBinary('src/app.js')), 'app', 'the pinned bytes, not the moved base');
  eq(await ov.exists('src/new.js'), false, 'still absent for this child');
  eq((await ov.list('docs')).join(','), 'docs/guide.md', 'the pinned listing');
  eq((await ov.stat('src/util.js')).size, 4, 'the pinned stat');
  eq(dec(await ov.readBinary('README.md')), 'root readme', 'a path never touched reads the live base (nothing pinned it)');
  eq(dec(await base.readBinary('src/app.js')), 'app-v2', 'the base itself did move');
});

await test('#9 moved(): exact fence — read that moved → read; write/delete over a moved base → wrote; untouched → neither', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  await ov.readBinary('src/app.js');                 // looked, not written
  await ov.readBinary('src/util.js');                // looked, unchanged later
  await ov.write('docs/guide.md', enc('mine'));      // written; base pre-image pinned at write
  await ov.delete('README.md');                      // deleted; pre-image pinned
  await ov.write('out/result.txt', enc('r'));        // written; base absent at pin
  eq(await ov.exists('later.txt'), false);           // looked, absent
  let m = await ov.moved();
  eq(m.wrote.join(','), '', 'nothing moved yet'); eq(m.read.join(','), '', 'nothing moved yet');
  await base.write('src/app.js', enc('APP'));        // a read moved
  await base.write('docs/guide.md', enc('guide-v2')); // a written path's base moved under it
  await base.delete('README.md');                    // the deleted path vanished from the base first
  await base.write('out/result.txt', enc('someone else'));  // the child's new file now exists in the base
  await base.write('later.txt', enc('x'));           // a pinned absence appeared
  await base.write('src/other.js', enc('o'));        // never touched by the child
  m = await ov.moved();
  eq(m.wrote.join(','), 'README.md,docs/guide.md,out/result.txt', 'written/deleted paths whose base moved — the run is held');
  eq(m.read.join(','), 'later.txt,src/app.js', 'looked-at paths that moved — merge, and say so');
  assert(!m.read.includes('src/util.js') && !m.read.includes('src/other.js'), 'unchanged and untouched paths are not moved');
  // a same-bytes rewrite is not a move: the fence is on content, not on mtime
  const ov2 = new OverlayBackend(base); await ov2.readBinary('src/util.js'); await base.write('src/util.js', enc('util'));
  eq((await ov2.moved()).read.join(','), '', 'identical bytes rewritten: not moved');
});

await test('#9 a file above PIN_MAX_BYTES pins a HASH, reads the live base, and the fence still catches a same-size rewrite with mtime 0', async () => {
  const base = new MemoryBackend();
  const big = new Uint8Array(PIN_MAX_BYTES + 1); big[0] = 7;
  await base.write('big.bin', big);
  const realStat = base.stat.bind(base); base.stat = async (p) => { const s = await realStat(p); return s && s.type === 'file' ? { ...s, mtimeMs: 0 } : s; }; // a Crate-like base: no mtime
  const ov = new OverlayBackend(base);
  eq((await ov.readBinary('big.bin')).length, PIN_MAX_BYTES + 1, 'readable');
  const pin = ov.pins.get('big.bin');
  assert(pin.hash && !pin.bytes, 'a hash is held, not the bytes');
  eq(ov.pinHeldBytes, 0, 'nothing counted against the budget');
  const big2 = new Uint8Array(PIN_MAX_BYTES + 1); big2[0] = 8; await base.write('big.bin', big2); // same size, one byte differs, mtime 0
  eq((await ov.readBinary('big.bin'))[0], 8, 'the live base — a hashed pin is not snapshotted (documented)');
  eq((await ov.moved()).read.join(','), 'big.bin', 'the fence re-hashes and sees the one-byte change');
});

await test('#9 the pin budget: past PIN_BUDGET_BYTES new pins are hashes; earlier pins keep their bytes', async () => {
  const base = new MemoryBackend();
  for (const n of ['a', 'b', 'c']) await base.write(n + '.txt', enc(n.repeat(100)));
  const ov = new OverlayBackend(base, { pinBudgetBytes: 250 });
  await ov.readBinary('a.txt'); await ov.readBinary('b.txt'); await ov.readBinary('c.txt');
  assert(ov.pins.get('a.txt').bytes && ov.pins.get('b.txt').bytes && ov.pins.get('c.txt').hash, 'two held, the third hashed');
  eq(ov.pinHeldBytes, 200);
  await base.write('a.txt', enc('A'.repeat(100))); await base.write('c.txt', enc('C'.repeat(100)));
  eq(dec(await ov.readBinary('a.txt')), 'a'.repeat(100), 'held: snapshotted'); eq(dec(await ov.readBinary('c.txt')), 'C'.repeat(100), 'hashed: live');
  eq((await ov.moved()).read.join(','), 'a.txt,c.txt', 'the fence is exact for both');
  eq(ov.pinned().join(','), 'a.txt,b.txt,c.txt', 'pinned() lists every pin');
});

await test('#9 (re-check): parallel first touches pin once; a write/delete pre-image is a hash, not held bytes; absent→dir is a move; a hashed pin\'s stat is live', async () => {
  const base = await seed();
  let reads = 0; const realRead = base.readBinary.bind(base); base.readBinary = async (p) => { reads++; return realRead(p); };
  const ov = new OverlayBackend(base);
  const [a, b, c] = await Promise.all([ov.readBinary('src/app.js'), ov.readBinary('src/app.js'), ov.stat('src/app.js')]);
  eq(dec(a), 'app'); eq(dec(b), 'app'); eq(c.size, 3);
  eq(reads, 1, 'three concurrent first touches → one base read'); eq(ov.pinHeldBytes, 3, 'counted once');
  await ov.write('docs/guide.md', enc('mine')); await ov.delete('README.md');
  assert(ov.pins.get('docs/guide.md').hash && !ov.pins.get('docs/guide.md').bytes, 'a write pre-image is hashed, never held');
  assert(ov.pins.get('README.md').hash && !ov.pins.get('README.md').bytes, 'a delete pre-image too');
  eq(ov.pinHeldBytes, 3, 'the budget is for what the child reads');
  await base.write('docs/guide.md', enc('guide-v2'));
  eq((await ov.moved()).wrote.join(','), 'docs/guide.md', 'the hashed pre-image still fences the write');
  // absent → dir: a file must not land over a directory
  eq(await ov.exists('p'), false); await ov.write('p', enc('file'));
  await base.write('p/inner.txt', enc('x'));
  eq((await ov.moved()).wrote.join(','), 'docs/guide.md,p', 'the pinned absence that became a dir is a move');
  // a hashed pin: stat is live, like its bytes
  const big = new Uint8Array(PIN_MAX_BYTES + 1); await base.write('big.bin', big);
  const ov2 = new OverlayBackend(base); await ov2.readBinary('big.bin'); await base.write('big.bin', new Uint8Array(PIN_MAX_BYTES + 5));
  eq((await ov2.stat('big.bin')).size, PIN_MAX_BYTES + 5, 'live stat for a hashed pin'); eq((await ov2.readBinary('big.bin')).length, PIN_MAX_BYTES + 5, 'live bytes');
  await base.delete('big.bin'); eq(await ov2.exists('big.bin'), false, 'and a live absence');
});

await test('#9 a base error is not pinned: it propagates, and the next call sees the base again', async () => {
  const base = await seed();
  let fail = 1; const realStat = base.stat.bind(base); base.stat = async (p) => { if (p === 'src/app.js' && fail-- > 0) throw new Error('host hiccup'); return realStat(p); };
  const ov = new OverlayBackend(base);
  let threw = null; try { await ov.readBinary('src/app.js'); } catch (e) { threw = e.message; }
  eq(threw, 'host hiccup', 'the first read surfaces the base error');
  assert(!ov.pins.has('src/app.js'), 'nothing pinned for it');
  eq(dec(await ov.readBinary('src/app.js')), 'app', 'the next read works — the failure was not made a run-long absence');
  eq((await ov.moved()).read.join(','), '', 'and the fence has nothing false to say');
});

await test('#9 a symlink pins stat-only: the fence compares its stat, never a false "moved" from missing bytes', async () => {
  const base = await seed();
  if (typeof base.symlink !== 'function') return; // MemoryBackend only
  await base.symlink('link', 'src/app.js');
  const ov = new OverlayBackend(base);
  const st = await ov.stat('link'); eq(st && st.type, 'symlink');
  assert(!ov.pins.get('link').bytes && !ov.pins.get('link').hash, 'stat-only');
  eq((await ov.moved()).read.join(','), '', 'unchanged symlink: not moved');
});

await test('through createFileops: an isolated agent-style fs works over the overlay', async () => {
  const base = await seed();
  const ov = new OverlayBackend(base);
  const ofs = createFileops({ backend: ov });
  const r = await ofs.read('src/app.js', { encoding: 'utf-8' });
  assert(r.ok && r.data === 'app', 'fileops reads base through overlay');
  const w = await ofs.write('src/app.js', 'via-fileops');
  assert(w.ok, 'fileops write ok');
  const r2 = await ofs.read('src/app.js', { encoding: 'utf-8' });
  eq(r2.data, 'via-fileops', 'fileops sees overlay write');
  eq(dec(await base.readBinary('src/app.js')), 'app', 'base still original through fileops');
  const ls = await ofs.list('', { recursive: true });
  assert(ls.ok && ls.entries.some(e => e.path === 'src/app.js'), 'recursive list works');
});

if (failures.length){
  console.error(`overlay-backend: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.n}: ${f.message}`);
  process.exit(1);
}
console.log(`overlay-backend conformance: ${passed}/${passed} passed`);
