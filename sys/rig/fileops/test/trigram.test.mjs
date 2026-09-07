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
  eq(requiredLiteral('hi\\sworldwide'), 'worldwide'); // \s breaks; the longer side wins
  eq(requiredLiteral('alpha.be'), 'alpha');             // ties are impossible here; longest wins
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

// A randomised differential sweep: the fixed battery above encodes what I
// thought to check, which is exactly the set most likely to miss something.
await test('DIFFERENTIAL: randomised patterns, 400 cases', async () => {
  const plain = await build({ index: false });
  const indexed = await build({ index: true });
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
