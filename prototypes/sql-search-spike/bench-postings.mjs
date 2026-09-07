// Is the shipped index's memory cost the ALGORITHM, or the DATA STRUCTURE?
//
//   node --expose-gc prototypes/sql-search-spike/bench-postings.mjs <root> set
//   node --expose-gc prototypes/sql-search-spike/bench-postings.mjs <root> ids
//
// §2 of plan/anvil-indexed-search.md specified "postings: Map<trigramHash,
// Uint32Array> — sorted file ids". fileops.mjs ships Map<hash, Set<pathString>>.
// Each variant runs in its OWN process: measuring both in one process gave a
// negative delta, because GC of the first variant's garbage crossed the second
// variant's baseline.
import { trigrams, foldCase } from '../../sys/rig/fileops/trigram.mjs';
import { loadCorpus } from './corpus.mjs';
const MODE = process.argv[3];
const files = loadCorpus(process.argv[2]);
const dec = new TextDecoder();
const NUL = String.fromCharCode(0);
const corpus = files.reduce((a,f)=>a+f.bytes.length,0);
// Build postings streaming, so nothing intermediate is retained.
global.gc(); const m0 = process.memoryUsage().heapUsed;
const P = new Map();
let entries = 0;
for (let i=0;i<files.length;i++) {
  const t = dec.decode(files[i].bytes);
  if (t.includes(NUL)) continue;
  for (const h of trigrams(foldCase(t))) {
    entries++;
    if (MODE==='set') { let s=P.get(h); if(!s){s=new Set();P.set(h,s);} s.add(files[i].path); }
    else { let a=P.get(h); if(!a){a=[];P.set(h,a);} a.push(i); }
  }
  files[i].bytes = null;                       // drop source bytes either way
}
if (MODE!=='set') for (const [h,a] of P) P.set(h, Uint32Array.from(a));
global.gc();
const mem = process.memoryUsage().heapUsed - m0;
console.log(`${MODE.padEnd(5)} postings: ${(mem/1024/1024).toFixed(1)} MiB (${(mem/corpus).toFixed(2)}x corpus ${(corpus/1024/1024).toFixed(1)} MiB), ${entries} entries, ${P.size} trigrams`);
