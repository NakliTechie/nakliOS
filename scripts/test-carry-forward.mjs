#!/usr/bin/env node
// Does --carry actually carry? A deterministic check with NO live model.
//
// The question matters because AC-8's whole re-gating rests on it: the i.i.d. bed cannot answer
// "after N failures, stop offering to start", and --carry is the flag that makes the bed model a
// retry instead of an independent draw (plan/bench-quota-2026-09-10.md). If the flag silently did
// nothing, the next quota measurement would look valid and mean nothing — the same failure shape as
// the rate-limit confound that made AC-2 wrong twice.
//
// NOTE the arg name: the agent `write` tool takes `content` (sys/ai/agent-tools.mjs:50). The rig
// fs face takes `data`. Getting that wrong makes rep 1's write a no-op and the carry check fails
// for a reason that has nothing to do with carry — which is exactly what happened writing this.
//
// A live run cannot show this. The `find-entry` agent writes answer.txt every rep regardless, so
// seeing answer.txt in rep 2 is consistent with both carry and no-carry. So: stand up a stub that
// speaks the OpenAI shape, script it to WRITE a marker in rep 1 and READ it back in rep 2, and let
// the read decide. Under --carry the read finds it; without --carry it must not.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const MARKER = 'carry-marker.txt';
const BODY = 'written-by-rep-1';

// One stub per child run. `phase` flips after the first task's run finishes, so the second rep of
// the SAME task reads instead of writes. Tasks are fixed by the script (3 of them) and reps are the
// outer loop, so calls arrive as: rep1{t1,t2,t3} then rep2{t1,t2,t3}.
function stub() {
  let turn = 0;
  return createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      const priorTools = body.messages.filter((m) => m.role === 'tool').length;
      turn++;
      // Rep is decided by wall position: the harness sends 3 tasks per rep, so the first 3 runs are
      // rep 1. Counting runs, not calls, keeps this independent of how many steps a run takes.
      const rep = runsSeen < 3 ? 1 : 2;
      let msg;
      if (priorTools === 0) {
        msg = rep === 1
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write', arguments: JSON.stringify({ path: MARKER, content: BODY }) } }] }
          : { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: MARKER }) } }] };
      } else {
        // Second turn: end the run. The stub reads the tool RESULT here rather than asserting on
        // the child's stderr — the assistant's final content rides the transcript and is never
        // logged, so stderr could not have shown it. Observing it in-process is both simpler and
        // the only place the value actually appears.
        const last = [...body.messages].reverse().find((m) => m.role === 'tool');
        if (rep === 2 && String(last?.content ?? '').includes(BODY)) sawBodyInRep2 = true;
        msg = { role: 'assistant', content: 'done' };
        runsSeen++;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 }, model: 'stub' }));
    });
  });
}
let runsSeen = 0;
let sawBodyInRep2 = false; // set by the stub when a rep-2 read returns rep 1's marker

async function run(extraArgs) {
  runsSeen = 0;
  sawBodyInRep2 = false;
  const srv = stub();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const out = await mkdtemp(join(tmpdir(), 'carry-'));
  const args = ['scripts/capture-context-corpus.mjs', '--out', out, '--n', '2', '--pace', '0',
    '--base', `http://127.0.0.1:${port}/v1`, '--model', 'stub', '--key', 'x', ...extraArgs];
  const stderr = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let e = '';
    p.stderr.on('data', (c) => { e += c; });
    p.on('close', () => resolve(e));
    p.on('error', reject);
  });
  srv.close();
  await rm(out, { recursive: true, force: true });
  return { stderr, sawBodyInRep2 };
}

let failed = 0;
const check = (name, cond) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${name}`); if (!cond) failed++; };

console.log('carry-forward:');

const withCarry = await run(['--carry']);
check('--carry announces the carry-forward bed', /CARRY-FORWARD/.test(withCarry.stderr));

const noCarry = await run([]);
check('default announces the i.i.d. bed', /i\.i\.d\./.test(noCarry.stderr));
check('default warns the sequences cannot answer AC-8', /CANNOT answer AC-8/.test(noCarry.stderr));
check('--carry drops that warning', !/CANNOT answer AC-8/.test(withCarry.stderr));

// The load-bearing pair. Rep 2 reads the marker rep 1 wrote. Under --carry the workspace persisted
// so the read returns the body; without --carry rep 2 got a fresh workspace and the read must miss.
// If BOTH pass the read, --carry is a no-op and every quota number measured on it is void.
check('--carry: rep 2 reads the file rep 1 wrote', withCarry.sawBodyInRep2 === true);
check('no --carry: rep 2 does NOT see rep 1\'s file', noCarry.sawBodyInRep2 === false);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
