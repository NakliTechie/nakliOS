#!/usr/bin/env node
// Layer 2 of the autoharness optimizer: run one split of the battery, N reps per task, on a live
// model, and write summary.json plus every run's record.
//
//   node scripts/autoharness/run-split.mjs --split dev --reps 3 --out DIR [--endpoint openrouter-bunny]
//     [--base URL --model ID --key-from SOURCE]   (override the endpoint's fields; SOURCE: opencode:<p>, file:<path>, env:<VAR>)
//     [--tasks id,id] [--concurrency 4] [--timeout 180]
//   AUTOHARNESS_PYODIDE=<dir>   give the agent python (python.mjs; `npm i --prefix <dir> pyodide@0.27`)
//
// Endpoints are named in endpoints.mjs (default openrouter-bunny); keys are read at run time and stay
// off the process list. Nothing retries: a call that fails makes its run VOID, counted apart and never
// scored (plan/bench-playbook.md §2). The summary names the bed (with or without python), the endpoint
// and model, the harness fingerprint and the git head, because a number without them cannot be compared
// with the next one.
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TASKS, tasksIn } from './battery.mjs';
import { runTask, liveInfer, harnessFingerprint, bedDescription } from './bed.mjs';
import { loadBedPython, LIMIT_MS } from './python.mjs';
import { resolveEndpoint, spend } from './endpoints.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const SPLIT = opt('--split', 'dev');
const REPS = Number(opt('--reps', '3'));
const OUT = opt('--out');
const CONC = Math.max(1, Number(opt('--concurrency', '4')));
const TIMEOUT = Number(opt('--timeout', '180')) * 1000;
const ONLY = (opt('--tasks') || '').split(',').filter(Boolean);
if (!OUT) { console.error('--out DIR is required'); process.exit(2); }
const EP = await resolveEndpoint({ endpoint: opt('--endpoint'), base: opt('--base'), model: opt('--model'), keyFrom: opt('--key-from'), key: opt('--key') });
const { base: BASE, model: MODEL, key: KEY } = EP;

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
const PY = await loadBedPython(); // before any run spends tokens: a wrong directory fails here
log(PY ? `python: Pyodide ${PY.version} from ${PY.dir}, one interpreter loaded in ${PY.loadMs} ms` : 'python: none (AUTOHARNESS_PYODIDE unset)');
const before = await spend(EP);
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
const after = await spend(EP);
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
// What python cost: the startup load, and per run that called it, its own interpreter's load (the
// private SQLite one too, if the run ran sqlite3). Two beds' numbers are never compared: loop.mjs refuses.
const loaded = results.filter((r) => r.python?.loads);
const python = PY ? {
  present: true, version: PY.version, dir: PY.dir, limitMs: LIMIT_MS, startupLoadMs: PY.loadMs,
  runsCalling: results.filter((r) => r.python?.calls).length, calls: results.reduce((n, r) => n + (r.python?.calls || 0), 0),
  runsLoading: loaded.length, meanLoadMsPerLoadingRun: loaded.length ? Math.round(mean(loaded.map((r) => r.python.loadMs))) : null,
} : { present: false };
const summary = {
  bed: bedDescription(PY), python,
  split: ONLY.length ? 'custom' : SPLIT, tasks: tasks.length, reps: REPS, endpoint: EP.name, model: MODEL, base: BASE, concurrency: CONC,
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
  spendBefore: before, spendAfter: after,
  // the provider's own counter, after minus before (DeepSeek's balance falls; OpenRouter's usage rises)
  costMeasured: before && after ? Math.round(Math.abs(after.total - before.total) * 1e6) / 1e6 : null,
  // the sum of the per-call costs the provider reported (OpenRouter's usage.cost), null when none did
  costReported: results.some((r) => r.costReported !== null) ? Math.round(results.reduce((s, r) => s + (r.costReported || 0), 0) * 1e6) / 1e6 : null,
  perTask,
};
await writeFile(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
log(`done: ${summary.passes}/${summary.scored} pass (micro ${summary.passRateMicro}, macro ${summary.passRateMacro}), ${summary.voids} void, ${summary.inputTokens} input tokens, ${summary.wallS}s, cost ${summary.costMeasured ?? 'n/a'} ${before?.currency || ''}`);
console.log(join(OUT, 'summary.json'));
