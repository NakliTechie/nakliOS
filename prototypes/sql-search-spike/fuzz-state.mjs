// Stateful differential fuzz for the base/overlay split (dc5d41f).
//
// The existing suite fuzzes PATTERNS against a static corpus. The overlay and the
// fold are a STATEFUL mechanism, so the interesting failures live in sequences of
// writes, deletes, recreates and folds — not in the pattern space. This drives
// random operation sequences and asserts, after every step, that an indexed grep
// returns byte-identical results to an unindexed one over the same backend.
//
//   node prototypes/sql-search-spike/fuzz-state.mjs [seed] [iterations]
//
// COVERAGE IS NOT SELF-VERIFYING, and that matters: the first version of this
// file ran 129,600 green checks having never once triggered a fold, because its
// path space was too small to reach indexFoldDue()'s 32-file threshold. A green
// run proved nothing. The workspace size and burst size below are chosen so folds
// DO fire, and the run fails loudly if globalThis.__FOLDS is unset.
//
// To re-verify coverage, temporarily add to sys/rig/fileops/fileops.mjs:
//     function indexFold() {
//       globalThis.__FOLDS = (globalThis.__FOLDS || 0) + 1;      // <-- add
// and confirm folds > 0 in the output. Without that line the run exits 2 rather
// than reporting a pass it cannot justify.

import { createFileops, MemoryBackend } from '../../sys/rig/fileops/index.mjs';

const SEED = Number(process.argv[2] || 1);
const ITERS = Number(process.argv[3] || 300);
let rnd = SEED >>> 0;
const next = () => (rnd = (Math.imul(rnd, 1103515245) + 12345) >>> 0);
const pick = (a) => a[next() % a.length];
const chance = (n) => (next() % 100) < n;

const WORDS = ['parseFact', 'MemoryBackend', 'requiredLiteral', 'deepThing', 'helper1',
               'helper2', 'TODO', 'FIXME', 'alphaDelta', 'betaGamma', 'Error', 'const',
               'export', 'import', 'rareSymbolXYZ', 'zzTopSecret', 'ÉLAN', 'straße'];
const PATTERNS = ['parseFact', 'MemoryBackend', 'requiredLiteral', 'TODO|FIXME',
                  '\\w+Error', 'rareSymbolXYZ', 'zzTopSecret', 'deepThing',
                  '(alpha|beta)(Delta|Gamma)', 'const', 'notPresentAnywhereQQQ',
                  'helper[12]', 'import \\{ (helper1|helper2) \\}', 'straße', 'élan',
                  'a', 'ab', 'abc'];
const FLAGS = ['', 'i'];

const DIRS = ['', 'src', 'src/deep', 'docs'];
const NAMES = Array.from({ length: 60 }, (_, i) => 'f' + i);
const EXTS = ['.mjs', '.md', '.html'];

function randomBody() {
  let t = '';
  const lines = 1 + (next() % 8);
  for (let i = 0; i < lines; i++) {
    let l = '';
    for (let k = 0; k < 1 + (next() % 5); k++) l += pick(WORDS) + ' ';
    t += l + '\n';
  }
  if (chance(8)) t = '<html>' + t;            // the old binary heuristic's victim
  if (chance(5)) t += 'x'.repeat(200);
  return t;
}
const randomPath = () => {
  const d = pick(DIRS);
  return (d ? d + '/' : '') + pick(NAMES) + pick(EXTS);
};

// Two fileops over the SAME backend: one indexed, one not. Same bytes, same walk.
async function makePair() {
  const be = new MemoryBackend();
  return {
    be,
    idx: createFileops({ backend: be, index: true, exclusive: true }),
    raw: createFileops({ backend: be, index: false }),
  };
}

function rowsOf(res) {
  if (!res || !res.ok) return `ERR:${res && res.code}`;
  return res.matches.map((m) => `${m.path}:${m.line}:${m.text}`).join('\n');
}

const failures = [];
let checks = 0;

const { be, idx, raw } = await makePair();
// seed a workspace big enough that indexFoldDue() can actually fire (>= 32 files)
for (let i = 0; i < 400; i++) await idx.write(randomPath(), randomBody());

for (let it = 0; it < ITERS && failures.length < 5; it++) {
  const op = next() % 100;
  let did = '';
  try {
    if (op < 45) { const p = randomPath(); did = `write ${p}`; await idx.write(p, randomBody()); }
    else if (op < 60) { const p = randomPath(); did = `remove ${p}`; await idx.remove(p); }
    else if (op < 70) {
      // delete then recreate at the SAME path — the aliasing case the design leans on
      const p = randomPath(); did = `recreate ${p}`;
      await idx.remove(p); await idx.write(p, randomBody());
    }
    else if (op < 78) {
      const a = randomPath(), b = randomPath(); did = `move ${a}->${b}`;
      await idx.move(a, b);
    }
    else if (op < 84) {
      const d = pick(DIRS.filter(Boolean)); did = `remove -r ${d}`;
      await idx.remove(d, { recursive: true });
    }
    else if (op < 90) {
      // force a fold burst
      did = 'burst';
      for (let k = 0; k < 60; k++) await idx.write(randomPath(), randomBody());
    }
    else { const p = randomPath(); did = `write(big) ${p}`; await idx.write(p, randomBody() + 'rareSymbolXYZ\n'); }
  } catch (e) { failures.push({ it, did, message: 'op threw: ' + e.message }); break; }

  // After every operation, every pattern must agree.
  for (const src of PATTERNS) {
    for (const fl of FLAGS) {
      const re = new RegExp(src, fl);
      const a = rowsOf(await idx.grep(re, { maxResults: 1000 }));
      const b = rowsOf(await raw.grep(re, { maxResults: 1000 }));
      checks++;
      if (a !== b) {
        const ax = a.split('\n').filter(Boolean), bx = b.split('\n').filter(Boolean);
        const missing = bx.filter((x) => !ax.includes(x));
        failures.push({
          it, did, pattern: `/${src}/${fl}`,
          message: missing.length
            ? `INDEX MISSED ${missing.length} row(s), e.g. ${JSON.stringify(missing[0])}`
            : `indexed returned ${ax.length - bx.length} EXTRA row(s)`,
        });
        break;
      }
    }
    if (failures.length) break;
  }
}

console.log(`  coverage: folds=${globalThis.__FOLDS||0} queries=${globalThis.__QUERIES||0} queriesWithDirtyOverlay=${globalThis.__OVERLAY_NONEMPTY||0} files=${be.files.size}`);
console.log(`fuzz-state seed=${SEED} iters=${ITERS} checks=${checks} failures=${failures.length}`);
for (const f of failures) console.log(`  FAIL it=${f.it} after "${f.did}" ${f.pattern || ''}: ${f.message}`);
if (!(globalThis.__FOLDS > 0)) {
  console.log('  COVERAGE FAILURE: no fold ever ran — this run proves nothing about the base/overlay split');
  process.exit(2);
}
process.exit(failures.length ? 1 : 0);
