#!/usr/bin/env node
// Free check (no model): run each wide task with its scripted `solve` and confirm the gate passes, and that the
// untouched seed fails the gate. A gate that passes the seed, or fails a correct workspace, would void a paid run.
import { WIDE_TASKS } from './battery-wide.mjs';
import { runTask, scriptedInfer } from './bed.mjs';
let bad = 0;
for (const t of WIDE_TASKS) {
  const solved = await runTask(t, { infer: scriptedInfer(t.solve), stamp: { id: 'scripted' } });
  const idle = await runTask(t, { infer: scriptedInfer([{ say: 'nothing' }]), stamp: { id: 'scripted' } });
  const good = solved.pass && !idle.pass;
  if (!good) bad++;
  console.log(`${good ? 'ok  ' : 'FAIL'} ${t.id.padEnd(22)} solved ${solved.pass ? 'pass' : 'FAIL: ' + solved.why}, seed-only ${idle.pass ? 'PASSES (bad)' : 'fails (good)'}`);
}
process.exit(bad ? 1 : 0);
