#!/usr/bin/env node
// check-gate-coverage.mjs — a test file that nobody runs is not coverage.
//
//   node scripts/check-gate-coverage.mjs
//
// Why this exists: on 2026-09-07 four suites were found, in one day, sitting in the tree and
// never named by any `run:` step — sys/ai/test/skills.test.mjs, the C4 agent-face conformance
// artifact, sys/ai/test/compaction.test.mjs, and the search-cost meter's own suite. Sweeping for
// the rest turned up 24, every one of them passing headlessly. That is a large amount of real
// coverage that could rot silently, and the failure mode is invisible by construction: a green
// gate says nothing about the suites it never invoked.
//
// Two directions, because both are the same mistake:
//   orphan — a test file exists that no gate step names. Coverage that does not run.
//   stale  — a gate step names a file that does not exist. A step that cannot fail.
//
// EXCLUSIONS are deliberate and must carry a reason. A suite that genuinely cannot run in CI
// (needs a browser, a GPU, a live endpoint) belongs here with the reason written down — not
// quietly left out. An empty list is the healthy state, and it is empty today.
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOW = 'test.yml';

// path -> why it is not in the gate. Keep this empty if you can.
const EXCLUDED = Object.freeze({
  // 'sys/foo/test/needs-webgpu.test.mjs': 'requires navigator.gpu; covered by /live-check-nt',
});

// Where tests live, and what a test looks like there.
const ROOTS = [
  { dir: 'sys', match: (f) => f.endsWith('.test.mjs') },
  { dir: 'scripts', match: (f) => /^test-.*\.mjs$/.test(f), shallow: true },
  { dir: 'prototypes', match: (f) => f.endsWith('.test.mjs') },
];

function walk(dir, match, shallow, out = []) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) return out;
  for (const name of readdirSync(abs)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(abs, name);
    const st = statSync(p);
    if (st.isDirectory()) { if (!shallow) walk(relative(ROOT, p), match, false, out); }
    else if (match(name)) out.push(relative(ROOT, p));
  }
  return out;
}

const workflowPath = join(ROOT, '.github', 'workflows', WORKFLOW);
if (!existsSync(workflowPath)) { console.error(`gate-coverage: no ${workflowPath}`); process.exit(1); }
const workflow = readFileSync(workflowPath, 'utf8');
const runLines = workflow.split('\n').filter((l) => /^\s*run:/.test(l)).map((l) => l.replace(/^\s*run:\s*/, ''));
const gateText = runLines.join('\n');

const tests = ROOTS.flatMap(({ dir, match, shallow }) => walk(dir, match, !!shallow)).sort();
const orphans = tests.filter((t) => !gateText.includes(t) && !(t in EXCLUDED));

// The other direction: a step naming a file that is gone can never fail again.
const named = new Set();
for (const line of runLines) {
  for (const m of line.matchAll(/[\w./-]+\.(?:mjs|js)/g)) named.add(m[0]);
}
const stale = [...named].filter((f) => /(^|\/)(test-|.*\.test\.)/.test(f) && !existsSync(join(ROOT, f)));

// An exclusion for a file that no longer exists is stale bookkeeping too.
const deadExclusions = Object.keys(EXCLUDED).filter((f) => !existsSync(join(ROOT, f)));

let bad = false;
if (orphans.length) {
  bad = true;
  console.error(`gate-coverage: ${orphans.length} test file(s) exist that no gate step runs.\n`);
  console.error('A green gate says nothing about a suite it never invoked. Add a step to');
  console.error(`.github/workflows/${WORKFLOW}, or add the file to EXCLUDED here WITH A REASON:\n`);
  for (const f of orphans) console.error(`      - name: <what this proves>\n        run: node ${f}\n`);
}
if (stale.length) {
  bad = true;
  console.error(`gate-coverage: ${stale.length} gate step(s) name a file that does not exist — they can never fail:`);
  for (const f of stale) console.error(`  ${f}`);
}
if (deadExclusions.length) {
  bad = true;
  console.error(`gate-coverage: ${deadExclusions.length} EXCLUDED entr(ies) name a file that is gone; drop them:`);
  for (const f of deadExclusions) console.error(`  ${f}`);
}
if (bad) process.exit(1);

const ex = Object.keys(EXCLUDED).length;
console.log(`gate-coverage: ${tests.length} test files, all run by the gate${ex ? ` (${ex} excluded, each with a reason)` : ''}`);
