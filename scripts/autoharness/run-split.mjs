#!/usr/bin/env node
// Layer 2 of the autoharness optimizer: run one split of the battery, N reps per task, on a live
// model, and write summary.json plus every run's record.
//
//   node scripts/autoharness/run-split.mjs --split dev --reps 3 --out DIR \
//     --base https://api.deepseek.com/v1 --model deepseek-flash --key-from opencode:deepseek
//     [--tasks id,id] [--concurrency 4] [--timeout 180]
//
// The key comes from --key-from (opencode's credential store, provider name after the colon), the
// BENCH_KEY environment variable, or --key — in that order of preference, so it stays off the
// process list. Nothing retries: a call that fails makes its run VOID, counted apart and never
// scored (plan/bench-playbook.md §2). The summary names the bed, the model, the harness fingerprint
// and the git head, because a number without them cannot be compared with the next one.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { TASKS, tasksIn } from './battery.mjs';
import { runTask, liveInfer, harnessFingerprint } from './bed.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const SPLIT = opt('--split', 'dev');
const REPS = Number(opt('--reps', '3'));
const OUT = opt('--out');
const BASE = opt('--base', 'https://api.deepseek.com/v1');
const MODEL = opt('--model', 'deepseek-flash');
const CONC = Math.max(1, Number(opt('--concurrency', '4')));
const TIMEOUT = Number(opt('--timeout', '180')) * 1000;
const ONLY = (opt('--tasks') || '').split(',').filter(Boolean);
if (!OUT) { console.error('--out DIR is required'); process.exit(2); }

async function resolveKey() {
  const from = opt('--key-from');
  if (from) {
    const [store, provider] = from.split(':');
    if (store !== 'opencode') throw new Error(`--key-from knows only opencode:<provider>, not ${store}`);
    const auth = JSON.parse(await readFile(join(homedir(), '.local/share/opencode/auth.json'), 'utf8'));
    const k = auth?.[provider]?.key;
    if (!k) throw new Error(`opencode has no key for ${provider}`);
    return k;
  }
  return process.env.BENCH_KEY || opt('--key') || 'local';
}
const KEY = await resolveKey();

// The provider's own balance, read before and after: the measured cost of the run. Only DeepSeek
// exposes one; elsewhere the field is null and the token counts are the measure.
async function balance() {
  if (!/api\.deepseek\.com/.test(BASE)) return null;
  try {
    const r = await fetch(BASE.replace(/\/v1\/?$/, '') + '/user/balance', { headers: { authorization: `Bearer ${KEY}` } });
    const j = await r.json();
    const b = (j.balance_infos || []).find((x) => x.currency === 'USD') || (j.balance_infos || [])[0];
    return b ? { currency: b.currency, total: Number(b.total_balance) } : null;
  } catch (_) { return null; }
}

function gitHead() {
  try {
    const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain', '--', 'sys/ai'], { encoding: 'utf8' }).trim().length > 0;
    return { head, dirtySysAi: dirty };
  } catch (_) { return null; }
}
const ist = (ms) => new Date(ms).toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';

const tasks = (ONLY.length ? TASKS.filter((t) => ONLY.includes(t.id)) : tasksIn(SPLIT));
if (!tasks.length) { console.error(`no tasks selected (split ${SPLIT}, --tasks ${ONLY.join(',')})`); process.exit(2); }
const jobs = tasks.flatMap((t) => Array.from({ length: REPS }, (_, rep) => ({ t, rep })));

const t0 = Date.now();
const log = (m) => process.stderr.write(`  [${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${m}\n`);
log(`autoharness ${ONLY.length ? 'custom' : SPLIT}: ${tasks.length} task(s) × ${REPS} rep(s) = ${jobs.length} runs, concurrency ${CONC}, model ${MODEL} @ ${BASE}`);
const before = await balance();
await mkdir(join(OUT, 'runs'), { recursive: true });

const stamp = { id: MODEL, provider: (() => { try { return new URL(BASE).host; } catch (_) { return null; } })(), label: MODEL };
const results = [];
let next = 0, finished = 0;
async function worker() {
  while (next < jobs.length) {
    const { t, rep } = jobs[next++];
    const infer = liveInfer({ base: BASE, model: MODEL, key: KEY, timeoutMs: TIMEOUT, label: `${t.id}#${rep}`, log: () => {} });
    const r = await runTask(t, { infer, stamp });
    finished++;
    log(`${String(finished).padStart(3)}/${jobs.length} ${t.id}#${rep}: ${r.void ? 'VOID' : r.pass ? 'pass' : 'FAIL'} — ${r.steps} step(s), ${r.usage.input} in-tok, ${Math.round(r.wallMs / 1000)}s${r.pass || r.void ? '' : ` — ${r.why}`}`);
    await mkdir(join(OUT, 'runs', t.id), { recursive: true });
    await writeFile(join(OUT, 'runs', t.id, `${rep}.json`), JSON.stringify({ ...r, rep, split: t.split, family: t.family, prompt: t.prompt }));
    results.push({ ...r, rep, record: undefined });
  }
}
await Promise.all(Array.from({ length: Math.min(CONC, jobs.length) }, worker));
const after = await balance();
const wallMs = Date.now() - t0;

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r2 = (x) => (x === null ? null : Math.round(x * 100) / 100);
const perTask = tasks.map((t) => {
  const rs = results.filter((r) => r.id === t.id).sort((a, b) => a.rep - b.rep);
  const scored = rs.filter((r) => !r.void);
  const passes = scored.filter((r) => r.pass).length;
  return {
    id: t.id, family: t.family, split: t.split, reps: rs.length, voids: rs.length - scored.length,
    passes, passRate: scored.length ? r2(passes / scored.length) : null,
    meanSteps: r2(mean(scored.map((r) => r.steps))), meanInputTokens: Math.round(mean(scored.map((r) => r.usage.input)) || 0),
    meanOutputTokens: Math.round(mean(scored.map((r) => r.usage.output)) || 0), meanWallS: r2(mean(scored.map((r) => r.wallMs / 1000))),
    outcomes: rs.map((r) => (r.void ? 'void' : r.pass ? 'pass' : 'fail')),
    whys: [...new Set(scored.filter((r) => !r.pass).map((r) => r.why))],
  };
});
const scored = results.filter((r) => !r.void);
const rated = perTask.filter((p) => p.passRate !== null);
const summary = {
  bed: 'node bed (scripts/autoharness/bed.mjs): in-memory workspace, the app assembly via sys/ai/run-assembly.mjs, node via the app js-runner, no Kiln/python, no host context message',
  split: ONLY.length ? 'custom' : SPLIT, tasks: tasks.length, reps: REPS, model: MODEL, base: BASE, concurrency: CONC,
  harness: harnessFingerprint(), git: gitHead(),
  started: ist(t0), ended: ist(Date.now()), wallS: Math.round(wallMs / 1000),
  runs: results.length, voids: results.length - scored.length, scored: scored.length,
  passes: scored.filter((r) => r.pass).length,
  passRateMicro: scored.length ? r2(scored.filter((r) => r.pass).length / scored.length) : null,
  passRateMacro: r2(mean(rated.map((p) => p.passRate))), // mean over tasks of per-task pass@1
  inputTokens: scored.reduce((s, r) => s + r.usage.input, 0), outputTokens: scored.reduce((s, r) => s + r.usage.output, 0),
  meanInputTokensPerRun: Math.round(mean(scored.map((r) => r.usage.input)) || 0),
  meanStepsPerRun: r2(mean(scored.map((r) => r.steps))),
  unpricedCalls: results.reduce((s, r) => s + (r.usage.calls - r.usage.priced), 0),
  balanceBefore: before, balanceAfter: after,
  costMeasured: before && after ? r2(before.total - after.total) : null,
  perTask,
};
await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
log(`done: ${summary.passes}/${summary.scored} pass (micro ${summary.passRateMicro}, macro ${summary.passRateMacro}), ${summary.voids} void, ${summary.inputTokens} input tokens, ${summary.wallS}s, cost ${summary.costMeasured ?? 'n/a'} ${before?.currency || ''}`);
console.log(join(OUT, 'summary.json'));
