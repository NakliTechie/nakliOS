// Load a real workspace's text files, for search benchmarking.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// The spike's own directory is excluded: it contains the query strings below, so
// indexing it would turn the zero-match class into a one-match class and quietly
// destroy the very worst case this benchmark exists to measure.
const SKIP_DIR = new Set(['.git', 'node_modules', '.claude', 'vendor', 'sql-search-spike']);
const TEXT_EXT = new Set(['mjs','js','json','md','html','css','svg','txt','yml','yaml','sh','ts']);

export function loadCorpus(root) {
  const files = [];
  (function walk(d) {
    for (const name of readdirSync(d)) {
      if (SKIP_DIR.has(name)) continue;
      const p = join(d, name);
      let st; try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) {
        if (!TEXT_EXT.has(name.split('.').pop())) continue;
        if (st.size > 2 * 1024 * 1024) continue;
        files.push({ path: relative(root, p), bytes: readFileSync(p) });
      }
    }
  })(root);
  return files;
}
