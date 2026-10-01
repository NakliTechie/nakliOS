// The repo's CI gate, run locally for a candidate harness edit: every `run: node …` step of
// .github/workflows/test.yml, in order, each with a 300 s cap. A round compares the candidate's red
// set against the base commit's, so a lane that was already red does not reject an edit, and a lane
// the edit turns red always does. Results are cached by git tree hash: the same tree, the same gate.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The round's own lane runs a round; inside a round's gate it would recurse.
const SKIP = [/test-autoharness-round\.mjs/];

export function gateCommands(repo) {
  const yml = readFileSync(join(repo, '.github/workflows/test.yml'), 'utf8');
  return [...yml.matchAll(/^\s*run:\s*(node\s.+?)\s*$/gm)].map((m) => m[1]).filter((c) => !SKIP.some((re) => re.test(c)));
}

// A lane runs as CI runs it: CI has no Pyodide, so a loop that gives its runs python
// (AUTOHARNESS_PYODIDE) does not hand it to the lanes, and the tree-keyed cache stays CI's answer.
const LANE_ENV = (() => { const e = { ...process.env }; delete e.AUTOHARNESS_PYODIDE; return e; })();

function runOne(repo, command, timeoutMs) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const p = spawn('/bin/bash', ['-c', command], { cwd: repo, env: LANE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.stderr.on('data', (c) => { out += c; });
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('close', (code) => { clearTimeout(timer); resolve({ command, code: code ?? 124, seconds: Math.round((Date.now() - t0) / 100) / 10, tail: out.slice(-1200) }); });
  });
}

// The tree hash of the WORKING TREE (tracked + untracked, ignored files excluded), via a private
// index so the repo's own index is never touched.
export function treeOf(repo) {
  const idx = resolve(repo, execFileSync('git', ['rev-parse', '--git-path', 'autoharness-index'], { cwd: repo, encoding: 'utf8' }).trim());
  const env = { ...process.env, GIT_INDEX_FILE: idx };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: repo, env });
  execFileSync('git', ['add', '-A'], { cwd: repo, env });
  return execFileSync('git', ['write-tree'], { cwd: repo, env, encoding: 'utf8' }).trim();
}

// Run the gate on the WORKING TREE of `repo`. `commands` narrows it (a test uses three lanes).
// `cacheKey` (a tree hash) reuses an earlier result for the same tree.
export async function runGate(repo, { commands = gateCommands(repo), timeoutMs = 300_000, cacheDir = null, cacheKey = null, log = () => {} } = {}) {
  const file = cacheDir && cacheKey ? join(cacheDir, `${cacheKey}.json`) : null;
  if (file && existsSync(file)) return { ...JSON.parse(readFileSync(file, 'utf8')), cached: true };
  const t0 = Date.now();
  const results = [];
  for (const c of commands) { const r = await runOne(repo, c, timeoutMs); results.push(r); if (r.code !== 0) log(`gate red: ${c} (exit ${r.code})`); }
  const out = { lanes: results.length, red: results.filter((r) => r.code !== 0).map((r) => r.command), seconds: Math.round((Date.now() - t0) / 1000), results };
  if (file) { mkdirSync(cacheDir, { recursive: true }); writeFileSync(file, JSON.stringify(out)); }
  return out;
}
