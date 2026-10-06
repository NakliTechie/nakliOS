#!/usr/bin/env node
// Layer 5 of the autoharness optimizer: the one-shot test comparison reports a paired result and
// refuses a second look. Stub model, scratch repo, zero spend.
//   node scripts/test-autoharness-compare.mjs
//
// The stub answers "what is 17 times 23?" with 391 only when the system prompt carries MARKER. The
// baseline commit lacks it, the final commit has it; the two "answer" battery cases (test split) × 3
// reps give +6 −0: z 2.45, exact McNemar p 2/64 = 0.0313.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { scratchRepo } from './autoharness/scratch.mjs';

const MARKER = 'Answer arithmetic exactly.';
const { REPO, git } = scratchRepo('ah-compare-');
const baseline = git('rev-parse', 'HEAD');
const f = join(REPO, 'sys/ai/run-assembly.mjs');
writeFileSync(f, readFileSync(f, 'utf8').replace('End with a one-line summary.', 'End with a one-line summary. ' + MARKER));
git('commit', '-qam', 'final harness');
const final = git('rev-parse', 'HEAD');

const srv = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
  const ok = String(JSON.parse(raw || '{}').messages?.[0]?.content || '').includes(MARKER);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: ok ? '391' : '390' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 2 }, model: 'stub' }));
}); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const runCompare = () => new Promise((resolve) => {
  const c = spawn(process.execPath, ['scripts/autoharness/compare.mjs', '--baseline', baseline, '--final', final, '--reps', '3', '--tasks', 'battery-answer-fresh,battery-answer-finished',
    '--base', `http://127.0.0.1:${srv.address().port}/v1`, '--model', 'stub', '--key', 'x', '--concurrency', '3', '--timeout', '30'], { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { e += d; });
  c.on('close', (code) => resolve({ code, o, e }));
});
const first = await runCompare();
const second = await runCompare();
srv.close();

let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n        ' + String(detail).slice(0, 600)}`); if (!cond) failed++; };
console.log('autoharness compare (stub model, scratch repo):');
const file = join(REPO, '.autoharness', `test-${final.slice(0, 8)}`, 'compare.json');
const r = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
check('the comparison exits 0', first.code === 0, first.e.slice(-600));
check('paired +6 −0 over 6 pairs, z 2.45, exact McNemar p 0.0313', r && r.pairs === 6 && r.up === 6 && r.down === 0 && r.z === 2.45 && r.p === 0.0313, JSON.stringify(r && { pairs: r.pairs, up: r.up, down: r.down, z: r.z, p: r.p }));
check('the family breakdown accounts for every pair', r && Object.values(r.byFamily).reduce((n, x) => n + x.pairs, 0) === r.pairs, JSON.stringify(r?.byFamily));
check('the report names both harness fingerprints, and they differ', r && r.harness.baseline !== r.harness.final, JSON.stringify(r?.harness));
check('a second look at the same final commit is refused', second.code === 2 && /already used/.test(second.e), second.e.slice(-300));
check('the scoring worktrees were removed', !/score/.test(git('worktree', 'list')), git('worktree', 'list'));
if (failed) { console.log(`${failed} check(s) failed — scratch repo kept at ${REPO}`); process.exit(1); }
