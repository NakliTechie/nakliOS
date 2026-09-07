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
import { requiredLiteral, trigrams, triHash } from '../trigram.mjs';

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
  eq(rec.literal, 'deepThing', 'literal extracted');
  assert(rec.candidates < Object.keys(CORPUS).length,
    `narrowed to ${rec.candidates} of ${Object.keys(CORPUS).length}`);
  eq(rec.filesRead, rec.candidates, 'read only the candidates on a warm index');
});

await test('an unindexable pattern falls back and still answers', async () => {
  const indexed = await build({ index: true });
  const r = await indexed.grep('[a-z]+Fact');
  const s = indexed.searchStats();
  assert(!s.recent[0].indexUsed, 'fell back');
  assert(r.matches.length > 0, 'still found matches on the fallback path');
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

await test('REGRESSION: an ignoreCase regex falls back instead of using the index', async () => {
  const fs = createFileops({ backend: new MemoryBackend(), index: true });
  await fs.write('h.txt', 'Needle here\n', { createParents: true });
  const r = await fs.grep(/needle/i);
  eq(r.matches.length, 1, 'case-insensitive still matches');
  assert(!fs.searchStats().recent.at(-1).indexUsed, 'took the full scan');
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

console.log(`trigram: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
if (failures.length) process.exit(1);
