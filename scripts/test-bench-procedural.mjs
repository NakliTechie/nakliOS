#!/usr/bin/env node
// N1: does the procedural bed run what the app runs? A deterministic check with NO live model.
//
// A stub that speaks the OpenAI shape stands in for the endpoint and RECORDS every request. It
// scripts one task to completion (write hello.txt, then task_done) so the gate passes, and then the
// requests are compared against the shared assembly: the system prompt the bed sent must be the
// bytes systemMessage() builds for that arm, the tool names must be runToolset('code', {verify})'s,
// and every arm must reach `success` through the bed's own gate. scripts/test-carry-forward.mjs is
// the same shape for the capture bed.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { systemMessage, gateNote, runToolset } from '../sys/ai/run-assembly.mjs';
import { DEFAULT_GRAPH, renderProcedural, proceduralEdges } from '../sys/ai/procedural.mjs';

const requests = []; // every body the stub received, in order
const STAGNATION = /^\[coordination\][\s\S]*different approach/; // sys/history/run-record.mjs stagnationNudge
function stub() {
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      requests.push(body);
      const priorTools = body.messages.filter((m) => m.role === 'tool').length;
      const redirected = body.messages.some((m) => m.role === 'user' && STAGNATION.test(String(m.content)));
      let msg;
      // The `-shell-to-verify` arm answers with PROSE until it is redirected. Under a gate, prose
      // is not 'done': the gate runs, fails, feeds back, three rounds → 'unverified' — and THEN
      // the supervisor folds the record, sees gate rounds with no new file, and injects one
      // redirect. The stub does the work only after that redirect, so the arm's success proves
      // the supervisor re-loop ran through the bed (the act-or-nudge is driven in
      // scripts/test-run-assembly.mjs; a gated run can never reach it by prose).
      if (priorTools === 0 && !redirected && !body.messages[0].content.includes('use shell to explore and verify')) {
        msg = { role: 'assistant', content: 'I would create hello.txt containing hello.' };
      } else if (priorTools === 0) {
        msg = { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: 'hello.txt', content: 'hello' }) } }] };
      } else if (priorTools === 1) {
        msg = { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'task_done', arguments: JSON.stringify({ summary: 'wrote hello.txt' }) } }] };
      } else {
        msg = { role: 'assistant', content: 'done' };
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'stub' }));
    });
  });
}

const srv = stub();
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const port = srv.address().port;
const args = ['scripts/bench-procedural.mjs', '--base', `http://127.0.0.1:${port}/v1`, '--model', 'stub', '--key', 'x', '--tasks', 'control-new-file', '--timeout', '30'];
const { stdout, stderr, code } = await new Promise((resolve, reject) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let o = '', e = '';
  p.stdout.on('data', (c) => { o += c; });
  p.stderr.on('data', (c) => { e += c; });
  p.on('close', (code) => resolve({ stdout: o, stderr: e, code }));
  p.on('error', reject);
});
srv.close();

let failed = 0;
const check = (name, cond, detail = '') => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}${cond ? '' : detail ? '\n        ' + detail : ''}`); if (!cond) failed++; };
console.log('bench-procedural (stub model):');
check('the bed exits 0', code === 0, stderr.slice(-400));

const EDGES = proceduralEdges();
const arms = ['full', ...EDGES.map((e) => '-' + e)];
check(`${arms.length} arms ran (one task × every edge)`, requests.length >= arms.length, `saw ${requests.length} requests`);

// The system prompt of each arm is the assembly's bytes for that arm — head + (prior minus the
// arm's edge) + tail + lesson note + the bench's gate note on the first loop (a re-loop repeats
// the prefix without it, as the app does). The bed did not hand-write a word.
const gate = gateNote('bench gate: control-new-file');
const expectedSystems = new Map(arms.flatMap((arm) => {
  const disable = arm === 'full' ? [] : [arm.slice(1)];
  const prior = renderProcedural(DEFAULT_GRAPH, { disable });
  return [[systemMessage({ mode: 'code', proceduralPrior: prior, extra: gate }).content, arm], [systemMessage({ mode: 'code', proceduralPrior: prior }).content, arm + ' (re-loop)']];
}));
const seenSystems = new Set(requests.map((b) => b.messages[0].content));
check('every request opens with a system message the assembly built', [...seenSystems].every((s) => expectedSystems.has(s)),
  [...seenSystems].filter((s) => !expectedSystems.has(s)).map((s) => s.slice(0, 120)).join('\n        '));
check('and every arm\'s first-loop prompt was sent', [...expectedSystems.entries()].filter(([, a]) => !/re-loop/.test(a)).every(([s]) => seenSystems.has(s)),
  [...expectedSystems.entries()].filter(([s, a]) => !/re-loop/.test(a) && !seenSystems.has(s)).map(([, a]) => a).join(', '));
check('the system message is the first and only system message', requests.every((b) => b.messages.filter((m) => m.role === 'system').length === 1));

// The tool list is the app's, in the app's order.
const wantTools = runToolset('code', { verify: true }).map((t) => t.function.name);
check(`the tool list is the app's ${wantTools.length}-tool code-mode set with task_done`, requests.every((b) => JSON.stringify((b.tools || []).map((t) => t.function.name)) === JSON.stringify(wantTools)),
  JSON.stringify((requests[0]?.tools || []).map((t) => t.function.name)));

// The supervisor re-loop reaches the bed: the prose-only arm was redirected with the record's
// stagnation nudge, and the re-loop's prefix is the same system message without the gate note.
const redirects = requests.filter((b) => b.messages.some((m) => m.role === 'user' && STAGNATION.test(String(m.content))));
check('the supervisor re-loop ran through the bed', redirects.length > 0);
// As in the app: the re-loop restarts from the CARRIED conversation plus the redirect — the spun
// loop's own turns live in the record, not in what is re-sent (runAgentLoop copies its messages).
check('and it re-sent the carried conversation with the redirect last', redirects.filter((b) => !b.messages.some((m) => m.role === 'tool')).every((b) => b.messages.length === 3 && b.messages[1].role === 'user' && /hello\.txt/.test(b.messages[1].content) && STAGNATION.test(b.messages[2].content)));
check('and its prefix is the re-loop\'s (no gate note)', redirects.every((b) => /re-loop/.test(expectedSystems.get(b.messages[0].content) || '')));
check('only the -shell-to-verify arm needed it', redirects.every((b) => /-shell-to-verify/.test(expectedSystems.get(b.messages[0].content) || '')) && !requests.some((b) => /^full/.test(expectedSystems.get(b.messages[0].content) || '') && b.messages.some((m) => STAGNATION.test(String(m.content)))));

// The outcome: every arm reached success through the gate, so the table has no failure and no
// void. (renderTable prints one row per capability with full/without labels.)
check('no arm is VOID', !/VOID/.test(stdout), stdout.slice(0, 300));
check('every arm succeeded', !/failure|max-steps|unverified/.test(stdout), stdout.slice(0, 600));
check('the run announces the app\'s model/base and the matrix', /1 task\(s\) x 7 arms = 7 runs/.test(stderr), stderr.slice(0, 200));

// --full-only: one arm, every edge ON — the shape the paid proof runs.
{
  requests.length = 0;
  const srv2 = stub();
  await new Promise((r) => srv2.listen(0, '127.0.0.1', r));
  const p2 = srv2.address().port;
  const r2 = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['scripts/bench-procedural.mjs', '--base', `http://127.0.0.1:${p2}/v1`, '--model', 'stub', '--key', 'x', '--tasks', 'control-new-file', '--timeout', '30', '--full-only'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let o = '', e = '';
    p.stdout.on('data', (c) => { o += c; }); p.stderr.on('data', (c) => { e += c; });
    p.on('close', (code) => resolve({ stdout: o, stderr: e, code })); p.on('error', reject);
  });
  srv2.close();
  check('--full-only exits 0', r2.code === 0, r2.stderr.slice(-300));
  check('--full-only announces one arm', /1 task\(s\) x 1 arms = 1 runs \(--full-only\)/.test(r2.stderr), r2.stderr.slice(0, 200));
  const fullPrompt = systemMessage({ mode: 'code', proceduralPrior: renderProcedural(DEFAULT_GRAPH), extra: gate }).content;
  check('--full-only sends the full prior (every edge on), not an ablated one', requests.length > 0 && requests.every((b) => b.messages[0].content === fullPrompt));
  check('--full-only reports the arm\'s outcome from the record', /control-new-file\/full: success \(score [0-9.]+\) — 2 step\(s\), 1 tool call\(s\), 0 failed gate round\(s\), 2 live call\(s\)/.test(r2.stdout), r2.stdout.slice(0, 200));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
