#!/usr/bin/env node
// Layer 5 of the autoharness optimizer: the one-shot comparison on the held-out TEST split. The
// baseline harness and the loop's final harness run the test split in the same batch, each from a
// detached worktree of its commit, on the same endpoint; the report is a paired comparison over the
// (task, rep) pairs neither side voided: discordant counts, the paired z and the exact McNemar p,
// broken down by family. Nothing in the loop ever read the test split, and this script refuses a
// second look at the same final commit — a test set consulted twice is a dev set.
//
//   node scripts/autoharness/compare.mjs --baseline SHA --final SHA [--reps 3] [--endpoint opencode-bunny]
//     [--concurrency 6] [--tasks id,id]   (--tasks narrows the split, for the stub lane)
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreArms, compare } from './score.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const BASE = opt('--baseline'), FINAL = opt('--final');
if (!BASE || !FINAL) { console.error('--baseline SHA and --final SHA are required'); process.exit(2); }
const base = git('rev-parse', BASE), fin = git('rev-parse', FINAL);
const REPS = Number(opt('--reps', '3'));
const AH = join(REPO, '.autoharness');
const USED = join(AH, 'test-used.json');
const used = existsSync(USED) ? JSON.parse(readFileSync(USED, 'utf8')) : [];
if (used.some((u) => u.final === fin)) { console.error(`the test split was already used for ${fin.slice(0, 8)} (${USED}); a second look turns it into a dev set`); process.exit(2); }
mkdirSync(AH, { recursive: true });
used.push({ baseline: base, final: fin, at: new Date().toISOString() });
writeFileSync(USED, JSON.stringify(used, null, 2)); // recorded BEFORE the runs: an aborted look still counts

const out = join(AH, `test-${fin.slice(0, 8)}`);
const passArgs = ['--endpoint', '--base', '--model', '--key-from', '--key', '--concurrency', '--timeout'].flatMap((f) => (opt(f) !== null ? [f, opt(f)] : []));
const t0 = Date.now();
const [b, f] = await scoreArms({ repo: REPO, arms: [{ label: 'baseline', sha: base }, { label: 'final', sha: fin }], reps: REPS, outDir: out, wtDir: join(AH, 'score'),
  select: opt('--tasks') ? ['--tasks', opt('--tasks')] : ['--split', 'test'], passArgs });
const all = compare(b, f);
const families = [...new Set([...b.runs.values()].map((r) => r.family))].sort();
const byFamily = Object.fromEntries(families.map((fam) => {
  const pick = (s) => ({ summary: s.summary, runs: new Map([...s.runs].filter(([, r]) => r.family === fam)) });
  const c = compare(pick(b), pick(f));
  return [fam, { pairs: c.pairs, up: c.up, down: c.down, delta: c.delta }];
}));
const report = { baseline: base, final: fin, reps: REPS, endpoint: b.summary.endpoint, model: b.summary.model, wallS: Math.round((Date.now() - t0) / 1000),
  voids: { baseline: b.summary.voids, final: f.summary.voids }, ...all, byFamily,
  harness: { baseline: b.summary.harness, final: f.summary.harness } };
writeFileSync(join(out, 'compare.json'), JSON.stringify(report, null, 2));
const md = [`# Test-split comparison: ${base.slice(0, 8)} → ${fin.slice(0, 8)}`, '',
  `Endpoint ${report.endpoint} (${report.model}), ${REPS} reps, ${all.pairs} paired runs (voids: baseline ${report.voids.baseline}, final ${report.voids.final}), ${report.wallS} s.`, '',
  `| | baseline | final |`, `|---|---|---|`, `| pass / scored | ${all.passInc}/${all.scoredInc} | ${all.passCand}/${all.scoredCand} |`, `| input tokens per run | ${all.tokInc} | ${all.tokCand} |`, '',
  `Paired: +${all.up} −${all.down} (net ${all.delta}), z ${all.z}, exact McNemar p ${all.p}.`, '',
  '| family | pairs | up | down | net |', '|---|---|---|---|---|', ...families.map((fam) => `| ${fam} | ${byFamily[fam].pairs} | ${byFamily[fam].up} | ${byFamily[fam].down} | ${byFamily[fam].delta} |`)].join('\n');
writeFileSync(join(out, 'report.md'), md + '\n');
console.log(md);
