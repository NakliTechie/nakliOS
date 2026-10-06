#!/usr/bin/env node
// Layer 2 of the autoharness optimizer: does the split runner count what it claims? Stub model, zero spend.
//   node scripts/test-autoharness-runner.mjs
//
// A stub speaking the OpenAI shape answers "what is 17 times 23?" with "391" (a pass, 100 prompt
// tokens) and answers "list the files here" with HTTP 500 (a provider failure). The summary must
// score the first, count the second as VOID and never as a failure, and sum the provider's tokens.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const auths = new Set();
const srv = createServer((req, res) => {
  auths.add(req.headers.authorization);
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    const body = JSON.parse(raw || '{}');
    const ask = body.messages.filter((m) => m.role === 'user').map((m) => String(m.content)).join('\n');
    if (/list the files here/.test(ask)) { res.writeHead(500, { 'content-type': 'application/json' }); res.end('{"error":{"message":"stub outage"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '391' }, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5, cost: 0.00125 }, model: 'stub' }));
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const out = await mkdtemp(join(tmpdir(), 'ah-runner-'));
const keyFile = join(out, 'key.txt');
await writeFile(keyFile, 'sk-test-from-file\n'); // read at run time, trimmed, never on the command line
const argv = ['scripts/autoharness/run-split.mjs', '--tasks', 'battery-answer-fresh,battery-list-fresh', '--reps', '2', '--out', out,
  '--base', `http://127.0.0.1:${srv.address().port}/v1`, '--model', 'stub', '--key-from', `file:${keyFile}`, '--concurrency', '2', '--timeout', '30'];
const { code, stderr } = await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, argv, { stdio: ['ignore', 'pipe', 'pipe'] });
  let e = '';
  p.stderr.on('data', (c) => { e += c; });
  p.on('close', (code) => resolve({ code, stderr: e }));
  p.on('error', reject);
});
srv.close();

let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond || !detail ? '' : '\n        ' + detail}`); if (!cond) failed++; };
console.log('autoharness runner (stub model):');
check('the runner exits 0', code === 0, stderr.slice(-600));
const s = JSON.parse(await readFile(join(out, 'summary.json'), 'utf8'));
check('4 runs: 2 tasks × 2 reps', s.runs === 4, `runs ${s.runs}`);
check('the two provider failures are VOID, not failures', s.voids === 2 && s.scored === 2, `voids ${s.voids}, scored ${s.scored}`);
check('the answered task passes both reps', s.passes === 2 && s.passRateMicro === 1, `passes ${s.passes}`);
const list = s.perTask.find((p) => p.id === 'battery-list-fresh');
check('a task with only void reps has no pass rate (null, never 0)', list && list.passRate === null && list.outcomes.join() === 'void,void', JSON.stringify(list));
check('input tokens are the provider\'s, summed over scored runs (2 × 100)', s.inputTokens === 200, `inputTokens ${s.inputTokens}`);
check('the summary names the model, the harness fingerprint and the bed', s.model === 'stub' && /^[0-9a-f]{16}$/.test(s.harness) && /node bed/.test(s.bed));
// CI runs this without AUTOHARNESS_PYODIDE; a local run with it set must say so instead
const withPython = !!process.env.AUTOHARNESS_PYODIDE;
check(`the summary records whether the bed had python (${withPython})`, s.python?.present === withPython && /no Kiln\/python/.test(s.bed) === !withPython && (!withPython || /^\d+\.\d+/.test(s.python.version)), JSON.stringify(s.python) + ' | ' + s.bed);
check('a file: key source reaches the provider trimmed, and only it', auths.size === 1 && auths.has('Bearer sk-test-from-file'), [...auths].join(' | '));
check('the per-call cost the provider reports is summed (2 scored calls × 0.00125)', s.costReported === 0.0025, `costReported ${s.costReported}`);
const runs = await readdir(join(out, 'runs', 'battery-answer-fresh'));
const one = JSON.parse(await readFile(join(out, 'runs', 'battery-answer-fresh', runs[0]), 'utf8'));
check('every run keeps its full record for the optimizer', runs.length === 2 && typeof one.record?.events === 'string' && one.record.events.includes('llm.responded'));
if (failed) { console.log(`${failed} check(s) failed`); process.exit(1); }
