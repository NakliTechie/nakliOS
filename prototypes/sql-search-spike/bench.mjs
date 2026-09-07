// Anvil search spike: the SHIPPED trigram index vs SQLite FTS5 `trigram`.
//
//   node --expose-gc prototypes/sql-search-spike/bench.mjs [corpusRoot]
//
// Both paths use the SAME hardened query planner (see trigram-lit.mjs); the only
// difference is where the postings live and how candidates are verified. That is
// deliberate — it isolates the INDEX ENGINE as the variable, so any difference is
// attributable to storage, not to plan quality.
//
// node:sqlite stands in for sqlite-wasm: same SQLite, same FTS5, same trigram
// tokenizer, without the wasm bundle. It measures FTS5's ALGORITHMIC behaviour.
// It does NOT measure wasm boot cost or bundle size — those are reported separately
// in plan/anvil-sql-search-spike.md.
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createFileops } from '../../sys/rig/fileops/index.mjs';
import { planQuery } from './trigram-lit.mjs';
import { loadCorpus, seedBackend, QUERIES } from './corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = process.argv[2] ? resolve(process.argv[2]) : resolve(HERE, '../..');
const gc = () => { if (global.gc) global.gc(); };
const NUL = String.fromCharCode(0);   // binary sentinel, as fs.grep uses

const files = loadCorpus(ROOT);
const dec = new TextDecoder();
const docs = files.map((f) => ({ path: f.path, text: dec.decode(f.bytes) }))
                  .filter((d) => !d.text.includes(NUL));
const corpusBytes = files.reduce((a, f) => a + f.bytes.length, 0);
console.log(`CORPUS ${ROOT}`);
console.log(`  ${files.length} files, ${(corpusBytes / 1024 / 1024).toFixed(2)} MiB\n`);

// ── shipped trigram index ────────────────────────────────────────────────
const be = await seedBackend(files);
const rec = [];
gc(); const m0 = process.memoryUsage().heapUsed;
const fs = createFileops({ backend: be, index: true, exclusive: true, onSearch: (s) => rec.push(s) });
const tb = performance.now();
await fs.grep('__warmup_no_match_zzz__');
const triBuild = performance.now() - tb;
gc(); const triMem = process.memoryUsage().heapUsed - m0;

const triRows = [];
for (const [cls, q] of QUERIES) {
  rec.length = 0;
  const t = performance.now();
  const r = await fs.grep(q, { maxResults: 1000 });
  const s = rec[rec.length - 1] || {};
  triRows.push({ cls, q, ms: performance.now() - t, m: r.matches.length, f: s.filesRead ?? -1, b: s.bytesRead ?? -1 });
}

// ── SQLite FTS5 trigram ──────────────────────────────────────────────────
const db = new DatabaseSync(':memory:');
const tf = performance.now();
db.exec("create virtual table docs using fts5(path unindexed, body, tokenize='trigram')");
db.exec('begin');
const ins = db.prepare('insert into docs(path, body) values (?, ?)');
for (const d of docs) ins.run(d.path, d.text);
db.exec('commit');
const ftsBuild = performance.now() - tf;
const ftsMem = db.prepare("select sum(pgsize) s from dbstat where name like 'docs%'").get().s;

const quote = (s) => '"' + s.replace(/"/g, '""') + '"';
// A plan tree becomes an FTS5 MATCH expression. `null` means "no constraint",
// i.e. fall back to the full scan — the same contract the shipped index uses.
function render(node) {
  if (!node || node.op === 'ALL') return null;
  if (node.op === 'TRI') return quote(node.run);
  const parts = node.subs.map(render);
  if (node.op === 'OR') return parts.some((p) => p === null) ? null : '(' + parts.join(' OR ') + ')';
  const kept = parts.filter((p) => p !== null);   // AND: an unconstrained sub is skipped
  return kept.length ? '(' + kept.join(' AND ') + ')' : null;
}

const byPath = new Map(docs.map((d) => [d.path, d.text]));
const sel = db.prepare('select path from docs where docs match ?');
const ftsRows = [];
for (const [cls, q] of QUERIES) {
  const t = performance.now();
  const re = new RegExp(q);
  const expr = render(planQuery(q, ''));
  const cands = expr === null ? docs.map((d) => d.path) : sel.all(expr).map((r) => r.path);
  cands.sort();                                    // match today's sorted-glob order
  let m = 0, b = 0, f = 0;
  outer: for (const p of cands) {
    const tx = byPath.get(p); if (tx === undefined) continue;
    f++; b += Buffer.byteLength(tx);
    for (const ln of tx.split('\n')) { re.lastIndex = 0; if (re.test(ln)) { m++; if (m >= 1000) break outer; } }
  }
  ftsRows.push({ cls, q, ms: performance.now() - t, m, f, b, expr });
}

// ── report ───────────────────────────────────────────────────────────────
console.log(`BUILD  trigram ${triBuild.toFixed(0).padStart(5)} ms   heap  ${(triMem / 1024 / 1024).toFixed(1).padStart(6)} MiB (${(triMem / corpusBytes).toFixed(2)}x corpus)`);
console.log(`       FTS5    ${ftsBuild.toFixed(0).padStart(5)} ms   index ${(ftsMem / 1024 / 1024).toFixed(1).padStart(6)} MiB (${(ftsMem / corpusBytes).toFixed(2)}x corpus)\n`);
console.log('query                     |  trigram ms  files     bytes |    FTS5 ms  files     bytes | differential');
let mismatches = 0;
for (let i = 0; i < QUERIES.length; i++) {
  const a = triRows[i], b = ftsRows[i];
  if (a.m !== b.m) mismatches++;
  console.log(`${a.q.slice(0, 25).padEnd(25)} | ${a.ms.toFixed(1).padStart(11)} ${String(a.f).padStart(6)} ${String(a.b).padStart(9)} | ${b.ms.toFixed(1).padStart(10)} ${String(b.f).padStart(6)} ${String(b.b).padStart(9)} | ${a.m === b.m ? 'OK ' + a.m : 'MISMATCH ' + a.m + '/' + b.m}`);
}
console.log(`\ndifferential: ${mismatches === 0 ? 'both engines returned identical match counts' : mismatches + ' MISMATCH'}`);
