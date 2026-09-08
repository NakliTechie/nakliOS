// trigram — the index's correctness gate.
//
//   node sys/rig/fileops/test/trigram.test.mjs
//
// The load-bearing test is the DIFFERENTIAL one: for a battery of patterns over
// a fixture corpus, an indexed grep must return byte-identical results to an
// unindexed one. Not "close", not "same count" — the same rows in the same
// order. Any pattern where they differ is a pattern the extractor must refuse.
//
// Everything else here exists to make that test's failures diagnosable.

import { createFileops, MemoryBackend } from '../index.mjs';
import { requiredLiteral, trigrams, triHash, planQuery, evaluateQuery, evaluateQueryIds, foldCase } from '../trigram.mjs';

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

// ── requiredLiteral: what it extracts ─────────────────────────────────────
await test('extracts a plain literal', () => {
  eq(requiredLiteral('parseFact'), 'parseFact');
  eq(requiredLiteral('function main'), 'function main');
});

await test('takes the longest certain run', () => {
  eq(requiredLiteral('ab.cdefg'), 'cdefg');
  eq(requiredLiteral('alpha.be'), 'alpha');             // '.' breaks the run; the longer side wins
  eq(requiredLiteral('worldwide.x'), 'worldwide');
});

await test('a required-but-repeating atom ends the run', () => {
  // 'c' is required but may repeat, so text either side of it is not contiguous.
  // Equal-length runs keep the first — arbitrary but deterministic.
  eq(requiredLiteral('abc+def'), 'abc');
  eq(requiredLiteral('abcd+ef'), 'abcd');
  eq(requiredLiteral('ab+cdef'), 'cdef');
});

await test('an optional atom is dropped, not counted', () => {
  eq(requiredLiteral('abcx?defg'), 'defg');
  // 'colo' IS required by every match of /colou?r/ — the optional 'u' ends the
  // run without joining it. Keeping 'colo' is correct and useful; taking
  // 'colour' would be the bug, since 'color' matches and does not contain it.
  eq(requiredLiteral('colou?r'), 'colo');
});

await test('refuses everything it does not fully understand', () => {
  eq(requiredLiteral('foo|bar'), null, 'alternation');
  eq(requiredLiteral('(abc)def'), null, 'group');
  eq(requiredLiteral('[a-z]+abc'), null, 'class');
  eq(requiredLiteral('ab'), null, 'shorter than 3');
  eq(requiredLiteral('\\w+'), null, 'no literal at all');
  eq(requiredLiteral('a.c'), null, 'runs of 1');
});

await test('escaped metacharacters are literal', () => {
  eq(requiredLiteral('a\\.b\\.c'), 'a.b.c');
});

await test('trigram hashing is order-sensitive and total', () => {
  assert(triHash(97, 98, 99) !== triHash(99, 98, 97), 'abc !== cba');
  eq(trigrams('abcd').size, 2, 'abc, bcd');
  eq(trigrams('ab').size, 0, 'too short');
});

// ── the differential gate ─────────────────────────────────────────────────
const CORPUS = {
  'src/parse.js': 'export function parseFact(x) {\n  // parseFact does the thing\n  return x;\n}\n',
  'src/main.js': 'import { parseFact } from "./parse.js";\nconst y = 1;\nfunction main() {}\n',
  'src/util.ts': 'export const COLOR = "red";\nexport const color = "blue";\nlet n = 42;\n',
  'docs/readme.md': '# Title\n\nSee parseFact for details.\nversion 1.2.3\n',
  'docs/page.html': '<html><body>parseFact appears here too</body></html>\n',
  'data/empty.txt': '',
  'data/odd.txt': 'a.b.c\nx?y\nfoo|bar\n[bracket]\n',
  'deep/a/b/c/nested.js': 'function deepThing() { return "parseFact"; }\n',
};

const PATTERNS = [
  'parseFact', 'function', 'parse', 'nothing-here', 'COLOR', 'color',
  'foo|bar', '(abc)def', '[a-z]+', '\\w+', 'a.c', 'ab', 'x?y', 'a\\.b\\.c',
  'version 1', 'deepThing', 'export const', '\\bconst\\b', 'html', 'e',
  '^import', 'thing$', 'par.eFact', 'parseFact|main', 'colou?r', 'n\\s+=',
];

async function build(opts) {
  const fs = createFileops({ backend: new MemoryBackend(), ...opts });
  for (const [p, body] of Object.entries(CORPUS)) {
    await fs.write(p, body, { createParents: true });
  }
  return fs;
}

await test('DIFFERENTIAL: indexed results are identical to unindexed, every pattern', async () => {
  const plain = await build({ index: false });
  const indexed = await build({ index: true });
  const diffs = [];
  for (const pat of PATTERNS) {
    for (const maxResults of [1000, 2]) {
      const a = await plain.grep(pat, { maxResults });
      const b = await indexed.grep(pat, { maxResults });
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        diffs.push(`${pat} (cap ${maxResults}): ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
      }
    }
  }
  assert(diffs.length === 0, `${diffs.length} divergence(s):\n  ${diffs.join('\n  ')}`);
});

await test('DIFFERENTIAL: still identical after writes, edits and deletes', async () => {
  const plain = await build({ index: false });
  const indexed = await build({ index: true });
  for (const fs of [plain, indexed]) {
    await fs.grep('parseFact');                                  // warm the index
    await fs.write('src/new.js', 'parseFact again\n');           // new file
    await fs.write('src/parse.js', 'nothing in here now\n');     // changed file
    await fs.remove('src/main.js');                              // vanished file
  }
  for (const pat of ['parseFact', 'nothing in here', 'main', 'again']) {
    const a = await plain.grep(pat);
    const b = await indexed.grep(pat);
    eq(JSON.stringify(b), JSON.stringify(a), `after mutation: ${pat}`);
  }
});

await test('DIFFERENTIAL: a file changed behind the index is not missed', async () => {
  // The host-fs case: bytes change without the index being told. We simulate it
  // by writing through the backend directly, bypassing fileops entirely.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true });
  await fs.write('a.txt', 'alpha\n', { createParents: true });
  await fs.grep('alpha');                       // index now knows a.txt as 'alpha'
  await new Promise((r) => setTimeout(r, 2));   // ensure a distinct mtime
  await backend.write('a.txt', new TextEncoder().encode('omega\n'));
  const r = await fs.grep('omega');
  eq(r.matches.length, 1, 'found the externally written content');
  eq(r.matches[0].path, 'a.txt', 'right file');
});

await test('the index actually skips files', async () => {
  const indexed = await build({ index: true });
  // Let the corpus age past the coherency window first: a file indexed in the
  // same millisecond it was written is deliberately distrusted, so warming
  // straight after a write burst costs one extra read per file.
  await new Promise((r) => setTimeout(r, 4));
  await indexed.grep('parseFact');              // warm
  indexed.searchStats({ reset: true });
  const r = await indexed.grep('deepThing');
  eq(r.matches.length, 1, 'one match');
  const s = indexed.searchStats();
  const rec = s.recent[0];
  assert(rec.indexUsed, 'index was used');
  eq(rec.plan, 'TRI', 'a plain literal plans to a single TRI node');
  assert(rec.candidates < Object.keys(CORPUS).length,
    `narrowed to ${rec.candidates} of ${Object.keys(CORPUS).length}`);
  eq(rec.filesRead, rec.candidates, 'read only the candidates on a warm index');
});

await test('a pattern with NO usable literal falls back and still answers', async () => {
  const indexed = await build({ index: true });
  const r = await indexed.grep('[a-z]+');            // nothing is required anywhere
  const s = indexed.searchStats();
  assert(!s.recent[0].indexUsed, 'fell back');
  assert(r.matches.length > 0, 'still found matches on the fallback path');
});

await test('a class or escape no longer disqualifies its literal neighbours', async () => {
  // The old extractor refused the whole pattern on seeing [ or \\w, even though a
  // neighbouring literal was still required by every match.
  const indexed = await build({ index: true });
  const r = await indexed.grep('[a-z]+Fact');
  const rec = indexed.searchStats().recent.at(-1);
  assert(rec.indexUsed, 'the index is used now');
  eq(rec.plan, 'TRI', 'planned down to the required literal');
  assert(r.matches.length > 0, 'and still finds the matches');
});

// ── exclusive mode ────────────────────────────────────────────────────────
// Where a bug would be SILENT: no stat sweep, so correctness rests entirely on
// the mutators invalidating exactly. The whole battery runs here too.

await test('DIFFERENTIAL (exclusive): identical to unindexed, every pattern', async () => {
  const plain = await build({ index: false });
  const excl = await build({ index: true, exclusive: true });
  const diffs = [];
  for (const pat of PATTERNS) {
    for (const maxResults of [1000, 2]) {
      const a = await plain.grep(pat, { maxResults });
      const b = await excl.grep(pat, { maxResults });
      if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${pat} (cap ${maxResults})`);
    }
  }
  assert(diffs.length === 0, `${diffs.length} divergence(s): ${diffs.join(', ')}`);
});

await test('DIFFERENTIAL (exclusive): every mutator invalidates exactly', async () => {
  const plain = await build({ index: false });
  const excl = await build({ index: true, exclusive: true });
  for (const fs of [plain, excl]) {
    await fs.grep('parseFact');                                   // warm
    await fs.write('src/parse.js', 'nothing in here now\n');      // write over an indexed file
    await fs.write('src/added.js', 'parseFact added later\n');    // brand new file
    await fs.patch('src/added.js',
      '--- a\n+++ b\n@@ -1 +1 @@\n-parseFact added later\n+patched parseFact line\n'); // patch
    await fs.copy('src/util.ts', 'src/util-copy.ts');             // copy → new path
    await fs.move('docs/readme.md', 'docs/moved.md');             // move → both paths
    await fs.remove('deep', { recursive: true });                 // recursive subtree removal
  }
  for (const pat of ['parseFact', 'nothing in here', 'patched', 'deepThing', 'COLOR', 'Title', 'added later']) {
    const a = await plain.grep(pat);
    const b = await excl.grep(pat);
    eq(JSON.stringify(b), JSON.stringify(a), `after mutations: ${pat}`);
  }
});

await test('exclusive mode does no per-file stat on an unchanged workspace', async () => {
  const excl = await build({ index: true, exclusive: true });
  await excl.grep('parseFact');                 // cold: stats + reads everything
  excl.searchStats({ reset: true });
  await excl.grep('deepThing');                 // warm: should stat nothing
  const rec = excl.searchStats().recent[0];
  eq(rec.filesStatted, 0, 'no stats on a warm exclusive index');
  eq(rec.filesRead, rec.candidates, 'read only the candidates');
});

await test('non-exclusive mode DOES stat, and that is what catches an outside write', async () => {
  const shared = await build({ index: true });  // exclusive defaults to false
  await shared.grep('parseFact');
  shared.searchStats({ reset: true });
  await shared.grep('deepThing');
  assert(shared.searchStats().recent[0].filesStatted > 0, 'stats every file');
});

await test('exclusive mode trades away outside-write detection, by contract', async () => {
  // Documented, not a bug: declaring `exclusive` asserts nothing else writes here.
  // This test pins the consequence so nobody sets the flag by accident.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('a.txt', 'alpha\n', { createParents: true });
  await fs.grep('alpha');
  await backend.write('a.txt', new TextEncoder().encode('omega\n')); // behind our back
  const r = await fs.grep('omega');
  eq(r.matches.length, 0, 'exclusive mode does NOT see a write it was promised would not happen');
});

// ── regressions found by an external review (codex/gpt-6-astra, 2026-09-07) ──
// Every one of these was a FALSE NEGATIVE that the 400-pattern randomised sweep
// missed, because its alphabet never produced them. They are pinned by hand.

await test('REGRESSION: an unknown escape refuses, it does not leak its tail', () => {
  // /\123abc/ is an octal escape for 'S'. Consuming '\1' and folding '23abc' into
  // the next run claimed '23abc' was required — "Sabc" matches without it.
  eq(requiredLiteral('\\123abc'), null);
  eq(requiredLiteral('a\\d+b'), null);
  eq(requiredLiteral('hello\\sworld'), null);
  eq(requiredLiteral('\\x41BCDEF'), null);
  eq(requiredLiteral('\\u0041BCDEF'), null);
});

await test('REGRESSION: astral characters are one atom, not two units', () => {
  // /ab\u{1F600}?cd/u matches "abcd"; reporting 'ab\uD83D' as required excluded it.
  eq(requiredLiteral('ab\u{1F600}?cd'), null);
  eq(requiredLiteral('\u{1F600}?abcdef'), 'abcdef');
});

await test('REGRESSION: every extracted literal is a real substring of every match', async () => {
  // The guarantee itself, asserted directly over the cases that broke it.
  const cases = [
    ['\\123abc', 'Sabc'], ['ab\u{1F600}?cd', 'abcd'], ['a\\d+b', 'a7b'],
    ['hello\\sworld', 'hello world'], ['colou?r', 'color'], ['ab+cdef', 'abbcdef'],
  ];
  for (const [pat, subject] of cases) {
    const lit = requiredLiteral(pat);
    const re = new RegExp(pat, /\\u\{|\u{1F600}/u.test(pat) ? 'u' : '');
    assert(re.test(subject), `fixture broken: ${pat} should match ${subject}`);
    if (lit !== null) {
      assert(subject.includes(lit),
        `GUARANTEE VIOLATED: /${pat}/ matches ${JSON.stringify(subject)} which lacks ${JSON.stringify(lit)}`);
    }
  }
});

await test('REGRESSION: case-sensitive search is not answered from a folded index', async () => {
  // 'ABΣ'.toLowerCase() ends in a final sigma; 'ABΣX'.toLowerCase() does not.
  // Folding both sides therefore lost a literal that WAS present.
  const fs = createFileops({ backend: new MemoryBackend(), index: true });
  await fs.write('g.txt', 'ABΣX marks it\n', { createParents: true });
  const r = await fs.grep('ABΣ');
  eq(r.matches.length, 1, 'final-sigma literal still found');
});

await test('an ignoreCase regex is now ANSWERED from the index, not scanned', async () => {
  // It used to fall back entirely. The index is case-folded per character, so an
  // -i query is a first-class indexed query, and a case-sensitive one merely
  // over-matches — which the real regex then rejects.
  const fs = createFileops({ backend: new MemoryBackend(), index: true });
  await fs.write('h.txt', 'Needle here\n', { createParents: true });
  for (let i = 0; i < 20; i++) await fs.write(`pad${i}.txt`, `nothing ${i}\n`, { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep(/needle/i); await fs.grep(/needle/i);       // build + settle
  fs.searchStats({ reset: true });
  const r = await fs.grep(/needle/i);
  const rec = fs.searchStats().recent[0];
  eq(r.matches.length, 1, 'case-insensitive still matches');
  assert(rec.indexUsed, 'and the index was used');
  assert(rec.candidates < 21, `narrowed to ${rec.candidates} of 21`);

  // Case-sensitive over-matching is admissible, never wrong.
  const plain = createFileops({ backend: new MemoryBackend(), index: false });
  await plain.write('h.txt', 'Needle here\n', { createParents: true });
  eq((await fs.grep('needle')).matches.length, (await plain.grep('needle')).matches.length,
    'a case-SENSITIVE query still answers exactly');
});

await test('REGRESSION: removing the mount root drops the whole index', async () => {
  // indexDropSubtree('') built the prefix '/', which matches no mount-relative
  // key, so every posting survived a root wipe and a recreated path served stale.
  const fs = createFileops({ backend: new MemoryBackend(), index: true, exclusive: true });
  await fs.write('hit.txt', 'alpha\n', { createParents: true });
  await fs.grep('alpha');
  await fs.remove('', { recursive: true });
  await fs.write('source.txt', 'omega\n', { createParents: true });
  await fs.copy('source.txt', 'hit.txt');
  eq((await fs.grep('omega')).matches.length, 2, 'both source and the recreated path found');
  eq((await fs.grep('alpha')).matches.length, 0, 'nothing stale survives');
});

await test('REGRESSION: copy into a path the index once held is not stale', async () => {
  const fs = createFileops({ backend: new MemoryBackend(), index: true, exclusive: true });
  await fs.write('a.txt', 'alpha\n', { createParents: true });
  await fs.write('b.txt', 'omega\n', { createParents: true });
  await fs.grep('alpha');
  await fs.remove('a.txt');
  await fs.copy('b.txt', 'a.txt');
  eq((await fs.grep('omega')).matches.length, 2, 'copied content visible at the reused path');
});

await test('REGRESSION: a symlink-capable backend keeps the stat sweep', async () => {
  // Two mount paths can alias one file; the index is keyed by path, so exact
  // invalidation cannot see the alias. The sweep can, because stat follows.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('target.txt', 'alpha\n', { createParents: true });
  if (typeof backend.symlink === 'function') backend.symlink('alias.txt', 'target.txt');
  else backend.symlinks.set('alias.txt', { target: 'target.txt', mtimeMs: Date.now() });
  await fs.grep('alpha');
  await fs.write('target.txt', 'omega\n');
  const viaAlias = await fs.grep('omega');
  eq(viaAlias.matches.length, 2, 'both the target and its alias report the new content');
});

await test('REGRESSION: a same-size rewrite in the same millisecond is not missed', async () => {
  // mtime+size compare equal when a file is rewritten at the same size within the
  // millisecond it was indexed. Found by the symlink case failing only inside the
  // full suite, where the writes land close enough together to collide.
  for (let attempt = 0; attempt < 50; attempt++) {
    const backend = new MemoryBackend();
    const fs = createFileops({ backend, index: true });   // sweep mode
    await fs.write('x.txt', 'alpha\n', { createParents: true });
    await fs.grep('alpha');
    await backend.write('x.txt', new TextEncoder().encode('omega\n')); // same size, outside fileops
    eq((await fs.grep('omega')).matches.length, 1, `same-ms rewrite missed on attempt ${attempt}`);
  }
});

await test('REGRESSION: fs.grep skips binary files, and agrees with shell rg', async () => {
  // Pre-dated the index: the comment said binaries were skipped, nothing checked,
  // so fs.grep matched inside binaries while the rg builtin skipped them.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('code.js', 'function parseFact(){}\n', { createParents: true });
  await backend.write('blob.bin', new Uint8Array([0x50, 0x4b, 0x00, 0x70, 0x61, 0x72, 0x73, 0x65, 0x46, 0x61, 0x63, 0x74]));
  const hits = (await fs.grep('parseFact')).matches.map((m) => m.path);
  eq(JSON.stringify(hits), JSON.stringify(['code.js']), 'binary excluded');
  const plain = createFileops({ backend, index: false });
  eq(JSON.stringify((await plain.grep('parseFact')).matches.map((m) => m.path)),
     JSON.stringify(hits), 'indexed and unindexed agree');
});

await test('REGRESSION: a /g or /y regex gives the same answer indexed or not', async () => {
  // lastIndex carried between test() calls, so which lines had been tested
  // changed the verdict — and an indexed run tests fewer files.
  for (const flags of ['g', 'y', 'gu']) {
    const plain = createFileops({ backend: new MemoryBackend(), index: false });
    const idx = createFileops({ backend: new MemoryBackend(), index: true, exclusive: true });
    for (const fs of [plain, idx]) {
      await fs.write('a.txt', 'alpha\n', { createParents: true });
      await fs.write('b.txt', 'xxxxx\n', { createParents: true });
      await fs.write('c.txt', 'alpha\n', { createParents: true });
    }
    const a = await plain.grep(new RegExp('alpha', flags));
    const b = await idx.grep(new RegExp('alpha', flags));
    eq(JSON.stringify(b), JSON.stringify(a), `/${flags} indexed matches unindexed`);
    eq(a.matches.length, 2, `/${flags} finds BOTH files, not every other one`);
  }
});

await test('REGRESSION: a backend that reports no mtime never settles', async () => {
  // CrateBackend falls back to mtimeMs 0 when the host supplies no stat. Treating
  // that as a valid timestamp made every file look permanently unchanged, so a
  // same-size external rewrite was invisible.
  class NoMtimeBackend extends MemoryBackend {
    async stat(p) { const s = await super.stat(p); return s ? { ...s, mtimeMs: 0 } : s; }
  }
  const backend = new NoMtimeBackend();
  const fs = createFileops({ backend, index: true });   // sweep mode
  await fs.write('x.txt', 'alpha\n', { createParents: true });
  await fs.grep('alpha');
  await backend.write('x.txt', new TextEncoder().encode('omega\n')); // same size, outside fileops
  eq((await fs.grep('omega')).matches.length, 1, 'rewrite seen despite no usable mtime');
});

await test('REGRESSION: a mutation that throws still invalidates', async () => {
  // A backend that writes and THEN throws changed the bytes anyway. Invalidating
  // only on the success path left the index serving content that no longer exists.
  class ThrowAfterWrite extends MemoryBackend {
    async write(p, bytes) { await super.write(p, bytes); if (this.armed) { this.armed = false; throw new Error('backend exploded after committing'); } }
  }
  const backend = new ThrowAfterWrite();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('hit.txt', 'alpha\n', { createParents: true });
  await fs.grep('alpha');
  backend.armed = true;
  await fs.write('hit.txt', 'omega\n').catch(() => {});   // commits, then throws
  eq((await fs.grep('omega')).matches.length, 1, 'the committed bytes are visible');
  eq((await fs.grep('alpha')).matches.length, 0, 'the replaced bytes are gone');
});

await test('REGRESSION: a write racing the index read is not installed stale', async () => {
  // The refresh read a file, a write landed mid-read, and the read then installed
  // its older bytes on top of the invalidation. In exclusive mode, which never
  // re-stats a file it believes it knows, that entry would never be revisited.
  class SlowRead extends MemoryBackend {
    async readBinary(p) { if (this.stall) { const s = this.stall; this.stall = null; await s; } return super.readBinary(p); }
  }
  const backend = new SlowRead();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('hit.txt', 'alpha\n', { createParents: true });
  let release;
  backend.stall = new Promise((r) => { release = r; });
  const searching = fs.grep('alpha');                 // begins reading hit.txt, then stalls
  await new Promise((r) => setTimeout(r, 5));
  const writing = fs.write('hit.txt', 'omega\n');     // lands mid-read
  release();
  await Promise.all([searching, writing]);
  eq((await fs.grep('omega')).matches.length, 1, 'the newer bytes win the race');
  eq((await fs.grep('alpha')).matches.length, 0, 'the raced-over bytes are gone');
});

await test('REGRESSION: symlink aliases invalidate through a wrapper backend', async () => {
  // The old guard sniffed backend.symlinks, which a wrapper does not expose.
  // Invalidation now goes by RESOLVED path, so it works through any wrapper.
  const inner = new MemoryBackend();
  const wrapper = {
    readBinary: (p) => inner.readBinary(p), write: (p, b) => inner.write(p, b),
    delete: (p) => inner.delete(p), exists: (p) => inner.exists(p),
    stat: (p) => inner.stat(p), mkdir: (p) => inner.mkdir && inner.mkdir(p),
    list: (p) => inner.list(p),
  };
  const fs = createFileops({ backend: wrapper, index: true, exclusive: true });
  await fs.write('target.txt', 'alpha\n', { createParents: true });
  inner.symlink('alias.txt', 'target.txt');
  await fs.grep('alpha');
  await fs.write('target.txt', 'omega\n');
  const hits = (await fs.grep('omega')).matches.map((m) => m.path).sort();
  eq(JSON.stringify(hits), JSON.stringify(['alias.txt', 'target.txt']), 'both alias and target updated');
});

await test('REGRESSION: a binary file is not re-read on every search', async () => {
  // Dropping binaries from the index meant the refresh re-read each one on every
  // query to rediscover it was binary. Measured at 4.29 MB per search on a real
  // folder — exactly cancelling the bytes the index saved.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true });
  await fs.write('code.js', 'function parseFact(){}\n', { createParents: true });
  const blob = new Uint8Array(4096); blob[10] = 0; blob.set([0x70, 0x61, 0x72, 0x73, 0x65], 20);
  await backend.write('blob.bin', blob);
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep('parseFact');                    // cold: reads both
  fs.searchStats({ reset: true });
  await fs.grep('parseFact');                    // warm
  const rec = fs.searchStats().recent[0];
  eq(rec.filesRead, 1, 'only the one real candidate is read; the binary is remembered');
  eq((await fs.grep('parseFact')).matches.map((m) => m.path).join(), 'code.js', 'binary still excluded from results');
});

await test('EXPERIMENT: reconcileMs trusts the index between sweeps, and says so', async () => {
  // Option (b) for folder mounts. Default 0 keeps the per-query sweep; a non-zero
  // window skips the per-file stat until the timer falls due. This test pins BOTH
  // halves — the saving and the exposure — so the trade cannot be adopted by
  // accident.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, reconcileMs: 60000 });
  await fs.write('a.txt', 'alpha\n', { createParents: true });
  for (let i = 0; i < 10; i++) await fs.write(`f${i}.txt`, `filler ${i}\n`, { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep('alpha');                         // first query sweeps and indexes
  fs.searchStats({ reset: true });
  await fs.grep('alpha');                         // inside the window
  const rec = fs.searchStats().recent[0];
  eq(rec.swept, false, 'no sweep inside the window');
  eq(rec.filesStatted, 0, 'and therefore no per-file stat');

  // The cost, stated: a change made outside this fileops is invisible until the
  // window closes. A change made THROUGH it is still exact.
  await backend.write('a.txt', new TextEncoder().encode('omega\n'));
  eq((await fs.grep('omega')).matches.length, 0, 'outside edit deferred, as the contract says');
  await fs.write('b.txt', 'omega\n', { createParents: true });
  eq((await fs.grep('omega')).matches.length, 1, 'a write THROUGH fileops is still seen at once');

  // A new file is found regardless: the walk always runs.
  await backend.write('c.txt', new TextEncoder().encode('brandnew\n'));
  eq((await fs.grep('brandnew')).matches.length, 1, 'new files are never deferred');
});

await test('EXPERIMENT: reconcileMs default keeps the guarantee', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true });   // reconcileMs defaults to 0
  await fs.write('a.txt', 'alpha\n', { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep('alpha');
  await backend.write('a.txt', new TextEncoder().encode('omega\n'));
  eq((await fs.grep('omega')).matches.length, 1, 'per-query sweep still catches an outside edit');
});

// ── the query planner ───────────────────────────────────────────────────────
// The guarantee, restated for a tree: if a string matches the regex, the file
// holding it must satisfy the plan. Under-matching is a silent false negative.
// This helper checks it directly by building a one-file postings map.
function planAdmits(pattern, subject) {
  const plan = planQuery(pattern);
  if (plan.op === 'ALL') return true;                 // no constraint, admits everything
  const postings = new Map();
  // Fold exactly as indexAdd does — the index is case-folded, so a harness that
  // built raw postings would be testing something the index never sees.
  for (const h of trigrams(foldCase(subject))) {
    if (!postings.has(h)) postings.set(h, new Set());
    postings.get(h).add('f');
  }
  const got = evaluateQuery(plan, postings);
  return got === null || got.has('f');
}

await test('planner: alternation becomes an OR instead of giving up', () => {
  const p = planQuery('TODO|FIXME');
  eq(p.op, 'OR', 'top-level alternation plans to OR');
  eq(p.subs.length, 2, 'one branch each');
  assert(planAdmits('TODO|FIXME', 'a TODO here'), 'admits the first branch');
  assert(planAdmits('TODO|FIXME', 'a FIXME here'), 'admits the second');
});

await test('planner: a group under a literal becomes AND(TRI, OR(...))', () => {
  const p = planQuery('def (solve|main)');
  eq(p.op, 'AND', 'sequence of literal + group');
  assert(planAdmits('def (solve|main)', 'def solve(x)'), 'admits solve');
  assert(planAdmits('def (solve|main)', 'def main()'), 'admits main');
});

await test('planner: a class or escape no longer poisons the sequence', () => {
  eq(planQuery('\\w+Error').op, 'TRI', 'the literal survives the escape');
  eq(planQuery('[A-Z][a-z]+Service').op, 'TRI', 'the literal survives the class');
  eq(planQuery('\\bconst\\b').op, 'TRI', 'zero-width escapes are transparent');
  assert(planAdmits('\\w+Error', 'TypeError'), 'admits a real match');
  assert(planAdmits('[A-Z][a-z]+Service', 'UserService'), 'admits a real match');
});

await test('planner: an OR is only as strong as its weakest branch', () => {
  // /TODO|./ can match anything, so the union must not constrain.
  eq(planQuery('TODO|.').op, 'ALL', 'an unconstrained branch makes the whole OR ALL');
  eq(planQuery('TODO|ab').op, 'ALL', 'a branch too short to have a trigram, likewise');
});

await test('planner: optional and lookaround constructs stay opaque', () => {
  eq(planQuery('(abc)?def').op, 'TRI', 'an optional group drops out, def survives');
  assert(planAdmits('(abc)?def', 'def'), 'admits a match without the optional group');
  assert(planAdmits('(?=abc)abcdef', 'abcdef'), 'lookahead treated as opaque, not required');
  assert(planAdmits('(?!abc)defghi', 'defghi'), 'negative lookahead never contributes');
});

await test('PLANNER GUARANTEE: randomised, 6000 patterns × real subjects', () => {
  let seed = 20260908; const rnd = () => ((seed = (seed*1103515245+12345) & 0x7fffffff) / 0x7fffffff);
  const atoms = ['a','b','c','ab','abc','def','Fact','.','?','*','+','|','(',')','[a-z]','[A-Z]',
    '\\w','\\d','\\s','\\b','\\.','\\\\','{0,2}','{2,}','(?:','(?=','(?!','^','$','-','ß','\u{1F600}'];
  const subjects = ['', 'a', 'ab', 'abc', 'abcdef', 'def', 'Fact', 'TypeError', 'UserService',
    'def solve(x)', 'TODO here', 'FIXME here', 'aaa', 'zzz', 'a.c', 'ßß', 'x\u{1F600}y'];
  let checked = 0; const bad = [];
  for (let n = 0; n < 6000; n++) {
    let pat = ''; const len = 1 + Math.floor(rnd()*5);
    for (let k = 0; k < len; k++) pat += atoms[Math.floor(rnd()*atoms.length)];
    let re; try { re = new RegExp(pat, 'u'); } catch(_) { try { re = new RegExp(pat); } catch(__) { continue; } }
    for (const s of subjects) {
      let m; try { m = re.test(s); } catch(_) { continue; }
      if (!m) continue;
      checked++;
      if (!planAdmits(pat, s)) bad.push(`/${pat}/ matches ${JSON.stringify(s)} but the plan excludes it`);
    }
  }
  assert(checked > 500, `enough matching pairs exercised: ${checked}`);
  assert(bad.length === 0, `${bad.length} guarantee violation(s):\n  ${bad.slice(0,6).join('\n  ')}`);
});

// ── persistence ─────────────────────────────────────────────────────────────
// The index is written through the same fileops, so it lands wherever the
// workspace lives. It is DERIVED: every loaded entry is re-checked against the
// filesystem before it is trusted, so a stale or corrupt index costs a read,
// never a wrong answer. These tests pin that, not just the round trip.

async function seeded(opts) {
  const fs = createFileops({ backend: new MemoryBackend(), ...opts });
  for (const [p, body] of Object.entries(CORPUS)) await fs.write(p, body, { createParents: true });
  return fs;
}

await test('persistence: save and load round-trips, and results stay identical', async () => {
  const backend = new MemoryBackend();
  const a = createFileops({ backend, index: true, exclusive: true, indexPath: '.anvil/index.json' });
  for (const [p, body] of Object.entries(CORPUS)) await a.write(p, body, { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await a.grep('parseFact');
  const saved = await a.indexSave();
  assert(saved.ok, 'index saved');

  const b = createFileops({ backend, index: true, exclusive: true, indexPath: '.anvil/index.json' });
  const loaded = await b.indexLoad();
  assert(loaded.ok && loaded.loaded > 0, `index loaded (${loaded.loaded} files)`);

  const plain = createFileops({ backend, index: false });
  for (const pat of ['parseFact', 'deepThing', 'notPresentAnywhereXYZ', 'COLOR']) {
    const x = await plain.grep(pat);
    const y = await b.grep(pat);
    eq(JSON.stringify(y), JSON.stringify(x), `loaded index agrees on ${pat}`);
  }
});

await test('persistence: the index file never indexes itself', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true, indexPath: 'idx.json' });
  await fs.write('a.txt', 'parseFact here\n', { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep('parseFact');
  await fs.indexSave();
  const r = await fs.grep('parseFact');
  eq(r.matches.map((m) => m.path).join(), 'a.txt', 'the saved index is not itself a result');
});

await test('persistence: a file changed while the index was on disk is not missed', async () => {
  const backend = new MemoryBackend();
  const a = createFileops({ backend, index: true, indexPath: 'idx.json' });
  await a.write('x.txt', 'alpha\n', { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await a.grep('alpha');
  await a.indexSave();
  // The workspace moves on without any fileops watching it.
  await backend.write('x.txt', new TextEncoder().encode('omega\n'));
  const b = createFileops({ backend, index: true, indexPath: 'idx.json' });
  await b.indexLoad();
  eq((await b.grep('omega')).matches.length, 1, 'the new content is found');
  eq((await b.grep('alpha')).matches.length, 0, 'the stale content is gone');
});

await test('persistence: a corrupt or foreign index is refused, not trusted', async () => {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, indexPath: 'idx.json' });
  await fs.write('a.txt', 'parseFact\n', { createParents: true });

  await fs.write('idx.json', 'this is not json at all', { createParents: true });
  eq((await fs.indexLoad()).code, 'EBADINDEX', 'garbage refused');

  await fs.write('idx.json', JSON.stringify({ v: 999, files: [] }));
  eq((await fs.indexLoad()).code, 'EBADINDEX', 'a future format refused');

  // And after a refusal the search still answers correctly from a cold build.
  eq((await fs.grep('parseFact')).matches.length, 1, 'refusing the index costs a read, not an answer');
});

await test('REGRESSION: an escape whose width is not certain refuses the pattern', async () => {
  // Guessing escape widths was worth 20,862 false negatives in review. Each of
  // these matched its subject while the plan excluded it.
  const cases = [
    ['(?<word>abc)\\k<word>', 'abcabc', ''],
    ['\\x(abcd)?foo', 'xfoo', ''],
    ['\\u(abcdef)?foo', 'ufoo', ''],
    ['\\p{Letter}abc', 'Zabc', 'u'],
  ];
  for (const [src, subject, flags] of cases) {
    const mk = async (index) => {
      const fs = createFileops({ backend: new MemoryBackend(), index });
      await fs.write('hit.txt', subject + '\n', { createParents: true });
      return fs;
    };
    const plain = await mk(false); const idx = await mk(true);
    await new Promise((r) => setTimeout(r, 3));
    const re = new RegExp(src, flags);
    const a = (await plain.grep(re)).matches.map((m) => m.path);
    const b = (await idx.grep(re)).matches.map((m) => m.path);
    eq(JSON.stringify(b), JSON.stringify(a), `/${src}/${flags} on ${JSON.stringify(subject)}`);
  }
});

await test('REGRESSION: -i folds the way a regex does, not the way toLowerCase does', async () => {
  // /σ/i matches ς and /s/iu matches ſ, but neither pair is equal under
  // toLowerCase, so a lowercased index silently missed them.
  for (const [pat, text, flags] of [['σσσ', 'ςςς', 'i'], ['sss', 'ſſſ', 'iu']]) {
    const fs = createFileops({ backend: new MemoryBackend(), index: true });
    await fs.write('g.txt', text + '\n', { createParents: true });
    await new Promise((r) => setTimeout(r, 3));
    eq((await fs.grep(new RegExp(pat, flags))).matches.length, 1, `/${pat}/${flags} finds ${text}`);
  }
});

await test('walk cache: reused when nothing changed, dropped when anything does', async () => {
  // The walk is 56% of a warm query's floor. Caching it is only safe where this
  // fileops is the sole writer, so file creation goes through the same
  // invalidation as content changes.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  for (let i = 0; i < 20; i++) await fs.write(`f${i}.txt`, `alpha ${i}\n`, { createParents: true });
  await new Promise((r) => setTimeout(r, 4));
  await fs.grep('alpha'); await fs.grep('alpha');

  // A file created afterwards must still be found — the write invalidates the walk.
  await fs.write('late.txt', 'brandnew here\n', { createParents: true });
  eq((await fs.grep('brandnew')).matches.length, 1, 'a file added after the cache is still found');

  // And one removed must stop being found.
  await fs.remove('late.txt');
  eq((await fs.grep('brandnew')).matches.length, 0, 'a file removed after the cache is gone');

  // The cache must never be used on a shared mount, where creation can bypass us.
  const shared = createFileops({ backend, index: true });      // not exclusive
  await shared.grep('alpha');
  await backend.write('outside.txt', new TextEncoder().encode('brandnew outside\n'));
  eq((await shared.grep('brandnew')).matches.length, 1, 'a shared mount re-walks and sees it');
});

await test('REGRESSION: three more planner false negatives from re-review', async () => {
  // Each matched its subject while the plan excluded it.
  //  - /abß/iu vs "abẞ": ß folds to "ss" (two chars), ẞ folds to "ß" — a fold that
  //    changes length is not a per-character map and the two sides diverged.
  //  - /[[a]bc]def/v vs "adef": the v flag nests character classes, so scanning to
  //    the first ']' found the wrong end and read the rest as required text.
  //  - /\uDC00ab/ vs "𐐀ab": an unpaired surrogate means the regex is matching UTF-16
  //    code units, which a code-point-wise planner cannot model.
  const cases = [
    ['abß', 'abẞ', 'iu'],
    ['[[a]bc]def', 'adef', 'v'],
    ['𐀀ab'.slice(1), '𐐀ab', ''],
  ];
  for (const [src, subject, flags] of cases) {
    let re; try { re = new RegExp(src, flags); } catch (_) { continue; }
    const mk = async (index) => {
      const fs = createFileops({ backend: new MemoryBackend(), index });
      await fs.write('hit.txt', subject + '\n', { createParents: true });
      return fs;
    };
    const plain = await mk(false); const idx = await mk(true);
    await new Promise((r) => setTimeout(r, 3));
    const a = (await plain.grep(re)).matches.map((m) => m.path);
    const b = (await idx.grep(re)).matches.map((m) => m.path);
    eq(JSON.stringify(b), JSON.stringify(a), `/${src}/${flags} on ${JSON.stringify(subject)}`);
  }
});

await test('REGRESSION: two more from a third review pass', async () => {
  //  - /abᾀ/iu vs "abᾈ": both characters uppercase to TWO code points, so the
  //    "only fold 1:1" rule left both unfolded and distinct — while /i equates
  //    them. A character that cannot fold 1:1 is now opaque in a pattern.
  //  - /[]?([]?ab)/u vs "ab": '[]' is a VALID EMPTY class in JS. Skipping the ']'
  //    immediately after '[' is a POSIX rule; here it ran the class past the
  //    group boundary and read "ab)" as required text.
  const cases = [
    ['abᾀ', 'abᾈ', 'iu'],
    ['[]?([]?ab)', 'ab', 'u'],
    ['[]?([]?ab)', 'ab', ''],
  ];
  for (const [src, subject, flags] of cases) {
    const mk = async (index) => {
      const fs = createFileops({ backend: new MemoryBackend(), index });
      await fs.write('hit.txt', subject + '\n', { createParents: true });
      return fs;
    };
    const plain = await mk(false); const idx = await mk(true);
    await new Promise((r) => setTimeout(r, 3));
    const re = new RegExp(src, flags);
    const a = (await plain.grep(re)).matches.map((m) => m.path);
    const b = (await idx.grep(re)).matches.map((m) => m.path);
    eq(JSON.stringify(b), JSON.stringify(a), `/${src}/${flags} on ${JSON.stringify(subject)}`);
  }
});

// A randomised differential sweep: the fixed battery above encodes what I
// thought to check, which is exactly the set most likely to miss something.
await test('DIFFERENTIAL: randomised patterns, 400 cases', async () => {
  const plain = await build({ index: false });
  const indexed = await build({ index: true, exclusive: true });
  const alphabet = 'abcdefghijklmnopqrstuvwxyzFC.?+*|()[]\\^$ 123';
  let seed = 20260907;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const diffs = [];
  for (let n = 0; n < 400; n++) {
    let pat = '';
    const len = 1 + Math.floor(rnd() * 8);
    for (let k = 0; k < len; k++) pat += alphabet[Math.floor(rnd() * alphabet.length)];
    let a; let b;
    try { a = await plain.grep(pat); } catch (_) { continue; } // invalid regex: both throw
    try { b = await indexed.grep(pat); } catch (e) { diffs.push(`${pat}: indexed threw ${e.message}`); continue; }
    if (JSON.stringify(a) !== JSON.stringify(b)) diffs.push(`${JSON.stringify(pat)} diverged`);
  }
  assert(diffs.length === 0, `${diffs.length} divergence(s):\n  ${diffs.slice(0, 8).join('\n  ')}`);
});

// ── evaluateQueryIds agrees with evaluateQuery ───────────────────────────
// The Set version is the one three review passes hardened, so it is the oracle.
// The id version only changes WHERE postings live; if the two ever disagree, the
// id version is the wrong one.
await test('evaluateQueryIds agrees with evaluateQuery on random plans', () => {
  const PATTERNS = [
    'parseFact', 'TODO|FIXME', '\\w+Error', 'import \\{ (helper1|helper2) \\}',
    'const', 'ab', 'deepThing', 'export const', '\\bconst\\b', 'x(y|z)w',
    'notPresentAnywhere', '(alpha|beta|gamma)Delta', 'a.c', '[A-Z]{2,}',
  ];
  // 40 synthetic files, each a random pick of words, so postings are non-trivial.
  const WORDS = ['parseFact','TODO','FIXME','helper1','helper2','deepThing','const',
                 'export','import','alphaDelta','betaDelta','xyw','xzw','Error','value'];
  let rnd = 12345;
  const next = () => (rnd = (rnd * 1103515245 + 12345) & 0x7fffffff);
  const docs = [];
  for (let i = 0; i < 40; i++) {
    let t = '';
    for (let k = 0; k < 12; k++) t += WORDS[next() % WORDS.length] + ' ';
    docs.push(t);
  }
  // Build both shapes from the same source.
  const byPath = new Map();      // hash -> Set<path>
  const byId = new Map();        // hash -> number[]
  docs.forEach((t, i) => {
    for (const h of trigrams(foldCase(t))) {
      let s = byPath.get(h); if (!s) { s = new Set(); byPath.set(h, s); } s.add('f' + i);
      let a = byId.get(h); if (!a) { a = []; byId.set(h, a); } a.push(i);
    }
  });
  const ids = new Map();
  for (const [h, a] of byId) ids.set(h, Uint32Array.from(a));   // already ascending

  const diffs = [];
  for (const src of PATTERNS) {
    const plan = planQuery(src, '');
    const a = evaluateQuery(plan, byPath);
    const b = evaluateQueryIds(plan, ids);
    if ((a === null) !== (b === null)) { diffs.push(`${src}: null-ness differs`); continue; }
    if (a === null) continue;
    const A = [...a].sort().join(',');
    const B = [...b].map((i) => 'f' + i).sort().join(',');
    if (A !== B) diffs.push(`${src}: ${A} !== ${B}`);
  }
  assert(diffs.length === 0, `${diffs.length} divergence(s): ${diffs.slice(0, 5).join(' | ')}`);
});

// A sorted-merge intersection is easy to get subtly wrong at the boundaries.
await test('evaluateQueryIds handles empty, disjoint and identical posting lists', () => {
  const P = new Map();
  const tri = (s) => [...trigrams(foldCase(s))];
  const H = tri('abcd');
  P.set(H[0], Uint32Array.from([1, 3, 5, 7]));
  P.set(H[1], Uint32Array.from([3, 7, 9]));
  const plan = planQuery('abcd', '');
  eq([...evaluateQueryIds(plan, P)].join(), '3,7', 'intersection is the merge');
  const P2 = new Map(P); P2.set(H[1], Uint32Array.from([2, 4]));
  eq([...evaluateQueryIds(plan, P2)].length, 0, 'disjoint lists intersect empty');
  const P3 = new Map(); for (const h of H) P3.set(h, Uint32Array.from([2, 4]));
  eq([...evaluateQueryIds(plan, P3)].join(), '2,4', 'identical lists survive');
  eq(evaluateQueryIds(plan, new Map()), (function(){ const m = new Map(); return evaluateQueryIds(plan, m); })(), 'missing trigram is empty, not null');
  eq(evaluateQueryIds(plan, new Map()).length, 0, 'a trigram nothing holds means no file can match');
});

// ── a persisted index is validated before it is trusted ──────────────────
// The exclusive shortcut used to skip validation BEFORE anything inspected
// indexedAt, so a saved index was trusted blindly: a file rewritten between save
// and load stayed invisible. No external writer and no concurrency needed — an
// ordinary reload was enough. Silent, and exit 0.
await test('REGRESSION: a file rewritten between indexSave and indexLoad is found', async () => {
  const be = new MemoryBackend();
  const opts = { backend: be, index: true, exclusive: true, indexPath: '.rig-index.json' };
  const a = createFileops(opts);
  await a.write('x.txt', 'alpha\n');
  await a.grep('alpha');
  eq((await a.indexSave()).ok, true, 'index saved');
  await a.write('x.txt', 'omega\n');            // through fileops, same instance

  const b = createFileops(opts);
  eq((await b.indexLoad()).loaded >= 1, true, 'index loaded');
  const indexed = await b.grep('omega', { glob: '*.txt' });
  const plain = await createFileops({ backend: be }).grep('omega', { glob: '*.txt' });
  eq(indexed.matches.length, plain.matches.length, 'indexed agrees with the scan');
  eq(indexed.matches.length, 1, 'the rewritten content is found');
});

// The fix must not cost the reads persistence exists to avoid: an UNCHANGED file
// is stat'ed once to validate it, and must not be re-read.
await test('a loaded index re-stats but does not re-read unchanged files', async () => {
  const be = new MemoryBackend();
  const opts = { backend: be, index: true, exclusive: true, indexPath: '.rig-index.json' };
  const a = createFileops(opts);
  for (let i = 0; i < 12; i++) await a.write(`f${i}.txt`, `deepThing body ${i}\n`);
  // `settled` deliberately refuses to trust a file indexed in the SAME millisecond
  // it was written — inside that window mtime+size cannot tell "unchanged" from
  // "rewritten at the same size". Without this wait every file is legitimately
  // re-read and the test measures the coherency window, not the load path.
  await new Promise((r) => setTimeout(r, 5));
  await a.grep('deepThing');
  eq((await a.indexSave()).ok, true, 'index saved');

  const rec = [];
  const b = createFileops({ ...opts, onSearch: (s) => rec.push(s) });
  await b.indexLoad();
  await b.grep('nothingMatchesThisQQQ');
  const s = rec[rec.length - 1];
  eq(s.filesRead, 0, 'no unchanged file is re-read after a load');
  assert(s.filesStatted >= 12, `every loaded entry is stat'ed once (got ${s.filesStatted})`);
});

await test('REGRESSION: a walk finishing after a write does not reinstall its stale snapshot', async () => {
  // Only an invalidation drops the walk cache, so a walk already in flight when a
  // write landed used to install its pre-write snapshot AFTERWARDS — and nothing
  // re-walks until the next invalidation, so one interleaving hid the new file
  // from every later query for the rest of the session. fileops supplies the
  // interleaving itself (the debounced indexSave is fire-and-forget), and so does
  // any caller that starts a write without awaiting it — Anvil's post-run review
  // is one (apps/anvil/index.html, learnThisRun).
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  for (let i = 0; i < 20; i++) await fs.write(`f${i}.txt`, 'alpha\n', { createParents: true });
  await fs.grep('alpha');

  let release; const paused = new Promise((r) => { release = r; });
  let reached; const atRoot = new Promise((r) => { reached = r; });
  const list = backend.list.bind(backend);
  let once = true;
  backend.list = async (p) => {
    const out = await list(p);
    if (p === '' && once) { once = false; reached(); await paused; }
    return out;
  };
  const walking = fs.grep('a');                     // suspended part-way through its walk
  await atRoot;
  await fs.write('new.txt', 'brandnew\n');          // lands before that walk finishes
  release();
  await walking;
  backend.list = list;

  // The raced walk itself may legitimately predate the file — an unindexed glob
  // racing the same write misses it too. What must not survive is the SNAPSHOT.
  const plain = createFileops({ backend, index: false });
  eq((await fs.grep('brandnew')).matches.length, (await plain.grep('brandnew')).matches.length,
     'the next query sees the file the raced walk missed');
  eq((await fs.grep('brandnew')).matches.length, 1, 'and every query after it');
});

await test('REGRESSION: an in-flight alias read cannot install bytes older than a write', async () => {
  // indexDropBySafe only visits aliases already installed in idx.files. A symlink
  // whose read was still in flight had no entry, so nothing bumped its sequence,
  // and it landed holding pre-write bytes — dropping the alias path out of every
  // later grep. The sequence is now bumped by resolved path, unconditionally.
  const backend = new MemoryBackend();
  const fs = createFileops({ backend, index: true, exclusive: true });
  await fs.write('z-target.txt', 'alpha\n', { createParents: true });
  for (let i = 0; i < 20; i++) await fs.write(`f${i}.txt`, 'filler\n');
  backend.symlink('a-alias.txt', 'z-target.txt');   // sorts first, so it is read first

  let release; const paused = new Promise((r) => { release = r; });
  let reached; const atTarget = new Promise((r) => { reached = r; });
  const readBinary = backend.readBinary.bind(backend);
  let once = true;
  backend.readBinary = async (p) => {
    const out = await readBinary(p);
    if (p === 'z-target.txt' && once) { once = false; reached(); await paused; }
    return out;
  };
  const searching = fs.grep('alpha');               // the alias read holds the old bytes
  await atTarget;
  await fs.write('z-target.txt', 'omega\n');        // the alias has no entry to invalidate
  release();
  await searching;
  backend.readBinary = readBinary;

  const plain = createFileops({ backend, index: false });
  const expected = (await plain.grep('omega')).matches.length;
  eq(expected, 2, 'the target and its alias both hold the new content');
  eq((await fs.grep('omega')).matches.length, expected, 'the indexed grep finds both paths');
  eq((await fs.grep('alpha')).matches.length, 0, 'and the raced-over bytes are gone');
});

console.log(`trigram: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
if (failures.length) process.exit(1);
