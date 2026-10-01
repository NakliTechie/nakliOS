// Scoring harness commits against each other, shared by the loop (dev, layer 4) and the one-shot
// test comparison (layer 5). Each arm runs from a detached worktree of its commit — run-split imports
// the harness from its own checkout — and all arms run at once, on the same endpoint: the same batch.
import { execFileSync, spawn } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

function run(argv, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(process.execPath, argv, { cwd, stdio: ['ignore', 'ignore', 'inherit'] });
    p.on('close', (c) => (c === 0 ? res() : rej(new Error(`run-split exited ${c}`))));
  });
}

// arms: [{ label, sha }]; select: ['--split', 'dev'] or ['--tasks', 'a,b']; passArgs: endpoint flags.
export async function scoreArms({ repo, arms, select, reps, passArgs = [], outDir, wtDir }) {
  const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' }).trim();
  try { git('worktree', 'prune'); } catch (_) {}
  const wts = arms.map(({ label, sha }) => { const wt = join(wtDir, label); rmSync(wt, { recursive: true, force: true }); git('worktree', 'add', '--detach', '--force', wt, sha); return wt; });
  try {
    await Promise.all(arms.map(({ label }, i) => run([join(wts[i], 'scripts/autoharness/run-split.mjs'), ...select, '--reps', String(reps), '--out', join(outDir, label), ...passArgs], wts[i])));
  } finally { for (const wt of wts) { try { git('worktree', 'remove', '--force', wt); } catch (_) {} } }
  return arms.map(({ label }) => readScore(join(outDir, label)));
}

export function readScore(out) {
  const summary = JSON.parse(readFileSync(join(out, 'summary.json'), 'utf8'));
  const runs = new Map();
  for (const t of summary.perTask) {
    for (let r = 0; r < t.reps; r++) {
      const f = join(out, 'runs', t.id, `${r}.json`);
      if (existsSync(f)) { const x = JSON.parse(readFileSync(f, 'utf8')); runs.set(`${t.id}#${r}`, { pass: x.pass, void: x.void, tools: x.tools, record: x.record, id: t.id, family: x.family }); }
    }
  }
  return { summary, runs };
}

// Exact two-sided McNemar: the discordant pairs are Binomial(up + down, 1/2) under "no difference".
export function mcnemarP(up, down) {
  const n = up + down, k = Math.min(up, down);
  if (!n) return 1;
  let c = 1, tail = 0; // C(n, i) built incrementally
  for (let i = 0; i <= k; i++) { if (i) c = (c * (n - i + 1)) / i; tail += c; }
  return Math.min(1, (2 * tail) / 2 ** n);
}

// Paired comparison over the (task, rep) pairs where neither run is void.
export function compare(inc, cand) {
  let up = 0, down = 0, pairs = 0;
  const flippedTasks = new Set();
  for (const [k, a] of inc.runs) {
    const b = cand.runs.get(k);
    if (!b || a.void || b.void) continue;
    pairs++;
    if (!a.pass && b.pass) { up++; flippedTasks.add(a.id); }
    if (a.pass && !b.pass) down++;
  }
  const tokInc = inc.summary.meanInputTokensPerRun, tokCand = cand.summary.meanInputTokensPerRun;
  return { pairs, up, down, delta: up - down, z: up + down ? Math.round(((up - down) / Math.sqrt(up + down)) * 100) / 100 : 0,
    p: Math.round(mcnemarP(up, down) * 10000) / 10000,
    passInc: inc.summary.passes, passCand: cand.summary.passes, scoredInc: inc.summary.scored, scoredCand: cand.summary.scored,
    tokInc, tokCand, tokGrowth: tokInc ? Math.round(((tokCand - tokInc) / tokInc) * 1000) / 1000 : null, flippedTasks: [...flippedTasks] };
}
