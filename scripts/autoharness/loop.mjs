#!/usr/bin/env node
// Layer 4 of the autoharness optimizer: the loop. Each iteration runs one round (round.mjs), then
// scores the candidate against the incumbent on the dev split IN THE SAME BATCH — each from its own
// checkout, at the same time, on the same endpoint — and keeps the candidate only if
//   1. its net paired gain reaches --margin (dev runs that flipped fail→pass, minus pass→fail; set it
//      above the measured batch-to-batch noise) AND the paired z = net / √(discordant pairs) reaches
//      --z (default 1.96, HarnessBank's bar). On space-bunny one dev pair in six flips between two
//      batches of the SAME harness (2026-10-01), so a flat margin alone admits noise;
//   2. its mean input tokens per run grew by at most 20% (AutoHarness's cost rule);
//   3. its beacon fired, where one can be checked (HarnessBank): a tool-description edit must have
//      been exercised by a run that flipped (that tool was called); an ACT_NUDGE edit must have been
//      sent in one. A system-prompt edit rides every request, so its beacon is "always present".
// A rejected candidate is git-reverted, so the branch keeps every attempt. Every verdict is a JSONL
// row in .autoharness/ledger.jsonl (RRSI's shape: hypothesis, diff, ΔS, ΔC, verdict), and the
// optimizer's history.md is rebuilt from the ledger before each round. Stops after `--patience`
// rounds in a row without a kept edit, or after `--rounds`.
//
//   node scripts/autoharness/loop.mjs --margin 3 [--z 1.96] [--rounds 6] [--patience 2] [--reps 3] [--start 1]
//     [--endpoint openrouter-bunny] [--concurrency 6] [--n 20] [--dev-tasks id,id]
//     [--optimizer-model gpt-5.6-luna | --optimizer-cmd CMD] [--gate full | lanes] [--train-dir DIR]
//
// Run it in the run worktree (never on main), detached, registered with `delegate`.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreArms, readScore, compare } from './score.mjs';

const args = process.argv.slice(2);
const opt = (f, d = null) => { const i = args.indexOf(f); return i < 0 ? d : args[i + 1]; };
const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MARGIN = Number(opt('--margin'));
const ROUNDS = Number(opt('--rounds', '6'));
const PATIENCE = Number(opt('--patience', '2'));
const REPS = Number(opt('--reps', '3'));
const START = Number(opt('--start', '1'));
const TOKEN_RULE = Number(opt('--token-rule', '0.20'));
const ZMIN = Number(opt('--z', '1.96'));
const AH = join(REPO, '.autoharness');
const LEDGER = join(AH, 'ledger.jsonl');
const HISTORY = join(AH, 'history.md');
const t0 = Date.now();
const log = (m) => process.stderr.write(`[loop ${String(Math.round((Date.now() - t0) / 1000)).padStart(5)}s] ${m}\n`);
const git = (...a) => execFileSync('git', a, { cwd: REPO, encoding: 'utf8' }).trim();
const ist = () => new Date().toLocaleString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false }) + ' IST';
const pass = (flags) => flags.flatMap((f) => (opt(f) !== null ? [f, opt(f)] : []));

function run(cmd, argv, cwd) {
  return new Promise((res, rej) => {
    const p = spawn(cmd, argv, { cwd, stdio: ['ignore', 'pipe', 'inherit'] });
    let out = '';
    p.stdout.on('data', (c) => { out += c; });
    p.on('close', (c) => (c === 0 ? res(out) : rej(new Error(`${cmd} ${argv.slice(0, 2).join(' ')} exited ${c}`))));
  });
}

// Score commits on dev from detached worktrees, all at once (score.mjs).
const scoreAll = (arms, dir) => scoreArms({ repo: REPO, arms, reps: REPS, outDir: dir, wtDir: join(AH, 'score'),
  select: opt('--dev-tasks') ? ['--tasks', opt('--dev-tasks')] : ['--split', 'dev'],
  passArgs: pass(['--endpoint', '--base', '--model', '--key-from', '--key', '--concurrency', '--timeout']) });
export { readScore, compare };

// The act-or-nudge re-loop ran: a second run.started with no tool called before it (the supervisor's
// re-loop needs a stall, which needs tool calls). Read from the record, not by matching nudge text,
// because the candidate may have changed that text.
function nudged(r) {
  const ev = String(r.record?.events || '').split('\n').filter(Boolean).map((l) => JSON.parse(l).tool);
  const second = ev.indexOf('run.started', ev.indexOf('run.started') + 1);
  return second > 0 && !ev.slice(0, second).includes('tool.called');
}

// Did the edit fire in the runs that flipped? Determined from what the round changed.
export function beacon(roundRec, cand, cmp) {
  const tools = (roundRec.pins?.inventory || []).map((d) => /tool:([a-z_]+)/.exec(d)?.[1]).filter(Boolean);
  const nudge = (roundRec.pins?.added || []).some((id) => /act-nudge/.test(id));
  const prompt = (roundRec.pins?.added || []).some((id) => /-prompt-/.test(id)) || roundRec.pins?.procedural;
  const flipped = [...cand.runs.values()].filter((r) => r.pass && !r.void && cmp.flippedTasks.includes(r.id));
  const checks = [];
  if (tools.length) checks.push({ kind: 'tool-called', tools, fired: flipped.some((r) => (r.tools || []).some((t) => tools.includes(t))) });
  if (nudge) checks.push({ kind: 'act-nudge-sent', fired: flipped.some(nudged) });
  if (prompt) checks.push({ kind: 'system-prompt', fired: true, note: 'always present in every request' });
  if (!checks.length) checks.push({ kind: 'code-path', fired: null, note: 'executor code without a schema or text change; not instrumented' });
  const determinable = checks.filter((c) => c.fired !== null);
  return { checks, fired: determinable.length ? determinable.some((c) => c.fired) : null };
}

function historyMarkdown(rows) {
  if (!rows.length) return '';
  return '# Harness edits so far in this run, and the held-out verdicts\n\n' + rows.map((r) =>
    `## Round ${r.round}: ${r.verdict.toUpperCase()}${r.reason ? ` (${r.reason})` : ''}\n- hypothesis: ${r.hypothesis}\n- files: ${(r.component || []).join(', ') || '—'}\n` +
    (r.dS ? `- dev, paired: +${r.dS.up} −${r.dS.down} (net ${r.dS.delta}, z ${r.dS.z}, margin ${r.margin}); input tokens per run ${r.dS.tokInc} → ${r.dS.tokCand}\n` : '') +
    (r.diff ? `- diff:\n\`\`\`diff\n${r.diff.slice(0, 3000)}\n\`\`\`\n` : '')).join('\n');
}
const readLedger = () => (existsSync(LEDGER) ? readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

// ── the loop ───────────────────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!Number.isFinite(MARGIN) || MARGIN < 1) { console.error('--margin N (the net paired dev gain to keep an edit; above the measured noise floor) is required'); process.exit(2); }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (['main', 'master', 'HEAD'].includes(branch)) { console.error(`refusing to run on ${branch}`); process.exit(2); }
  mkdirSync(AH, { recursive: true });
  let dry = 0;
  for (let n = START; n < START + ROUNDS && dry < PATIENCE; n++) {
    const base = git('rev-parse', 'HEAD');
    writeFileSync(HISTORY, historyMarkdown(readLedger()));
    log(`round ${n}: base ${base.slice(0, 8)}`);
    const roundArgs = ['--round', String(n), '--history', HISTORY, ...pass(['--endpoint', '--base', '--model', '--key-from', '--key', '--concurrency', '--timeout', '--n', '--optimizer-model', '--optimizer-cmd', '--gate', '--train-dir'])];
    await run(process.execPath, [join(REPO, 'scripts/autoharness/round.mjs'), ...roundArgs], REPO);
    const rr = JSON.parse(readFileSync(join(AH, `round-${n}`, 'round.json'), 'utf8'));
    const row = { round: n, ts: ist(), base, hypothesis: rr.rationale || null, component: rr.edited || [], margin: MARGIN, zMin: ZMIN, endpoint: opt('--endpoint') || 'default', optimizer: rr.optimizer };
    if (rr.outcome !== 'committed') {
      Object.assign(row, { verdict: 'no-candidate', reason: rr.outcome, gate: rr.gate ? { newRed: rr.gate.newRed } : null });
      appendFileSync(LEDGER, JSON.stringify(row) + '\n'); dry++; log(`round ${n}: no candidate (${rr.outcome})`); continue;
    }
    row.commit = rr.commit;
    row.diff = existsSync(join(AH, `round-${n}`, 'candidate.diff')) ? readFileSync(join(AH, `round-${n}`, 'candidate.diff'), 'utf8') : null;
    const dir = join(AH, `round-${n}`, 'dev');
    log(`round ${n}: scoring incumbent ${base.slice(0, 8)} and candidate ${rr.commit.slice(0, 8)} on dev ×${REPS}, same batch`);
    const [inc, cand] = await scoreAll([{ label: 'incumbent', sha: base }, { label: 'candidate', sha: rr.commit }], dir);
    const cmp = compare(inc, cand);
    const bc = beacon(rr, cand, cmp);
    Object.assign(row, { dS: cmp, dC: { tokGrowth: cmp.tokGrowth, rule: TOKEN_RULE }, beacon: bc,
      cost: { incumbent: inc.summary.costReported ?? inc.summary.costMeasured, candidate: cand.summary.costReported ?? cand.summary.costMeasured },
      voids: { incumbent: inc.summary.voids, candidate: cand.summary.voids } });
    const reasons = [];
    if (cmp.delta < MARGIN) reasons.push(`net ${cmp.delta} is below the margin ${MARGIN}`);
    if (cmp.z < ZMIN) reasons.push(`paired z ${cmp.z} is below ${ZMIN}`);
    if (cmp.tokGrowth !== null && cmp.tokGrowth > TOKEN_RULE) reasons.push(`input tokens +${Math.round(cmp.tokGrowth * 100)}% > ${Math.round(TOKEN_RULE * 100)}%`);
    if (bc.fired === false) reasons.push('beacon did not fire in any flipped run');
    if (reasons.length) {
      git('revert', '--no-edit', rr.commit);
      Object.assign(row, { verdict: 'rejected', reason: reasons.join('; '), revert: git('rev-parse', 'HEAD') });
      dry++;
    } else { Object.assign(row, { verdict: 'kept' }); dry = 0; }
    appendFileSync(LEDGER, JSON.stringify(row) + '\n');
    log(`round ${n}: ${row.verdict} — paired +${cmp.up} −${cmp.down} (net ${cmp.delta}, z ${cmp.z}, margin ${MARGIN}), tokens ${cmp.tokInc} → ${cmp.tokCand}${row.reason ? ' — ' + row.reason : ''}`);
  }
  writeFileSync(HISTORY, historyMarkdown(readLedger()));
  log(`stopped: ${dry >= PATIENCE ? `patience ${PATIENCE} reached` : 'round limit'}; ledger ${LEDGER}`);
}
