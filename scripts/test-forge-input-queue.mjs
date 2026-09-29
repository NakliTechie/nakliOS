// Forge must never lose a line typed while a command is still running.
//
// Live 2026-09-29 (local COI serve, /apps/forge/): `git commit` asked for a confirm, the user
// answered `y`, then typed `git status` + Enter before the commit returned. Forge fed every Enter
// straight into shell.feed, and a second feed while one is in flight throws `shell: feed already
// in progress` (U0, sys/rig/cli/shell.mjs). Forge printed that in red and the line was gone.
//
// This drives Forge's REAL code, lifted out of apps/forge/index.html: the input pump, runCommand,
// runAgent, mountWorkspace and the statement that wires them. It runs against the real line
// editor, shell, git core and agent loop. Only xterm and the host's model are stand-ins.
// Run: node scripts/test-forge-input-queue.mjs
import assert from 'node:assert/strict';
import { inlineModule, extractFunction, extractRegion, evaluate } from './anvil-harness.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGitCore } from '../sys/rig/git/git-core.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { createLineEditor } from '../sys/rig/cli/lineeditor.mjs';
import { runAgentLoop } from '../sys/ai/agent-loop.mjs';
import { codingToolset, makeToolExecutor } from '../sys/ai/agent-tools.mjs';

const src = await inlineModule(new URL('../apps/forge/index.html', import.meta.url));

// Call sites: xterm and the mobile key bar both reach the shell only through the pump.
assert.match(src, /term\.onData\(\(d\) => pump\.input\(d\)\)/, 'xterm input goes through the pump');
assert.match(src, /pump\.input\(seq\)/, 'the mobile key bar goes through the pump');
assert.equal(src.split('shell.feed(').length - 1, 1, 'Forge calls shell.feed in one place');
assert.ok(extractFunction(src, 'runCommand').includes('shell.feed('), '... and that place is runCommand');

const toCRLF = src.match(/^\s*const toCRLF = .+$/m);
assert.ok(toCRLF, "Forge's toCRLF found");
const wiring = extractRegion(src, 'const pump = createInputPump({', '\n    });') + '\n    });';
const script = [
  toCRLF[0],
  ...['mountWorkspace', 'refreshCache', 'promptNow', 'writeOut', 'createInputPump',
    'runAgent', 'runCommand', 'cancelConfirm'].map((name) => extractFunction(src, name)),
  "mountWorkspace(new MemoryBackend(), 'memory · scratch');",
  wiring,
  // evaluate() copies ctx into the realm, so Forge's own assignments are read back from there.
  '({ pump, get shell() { return shell; }, get face() { return face; }, get agentCtl() { return agentCtl; } })',
].join('\n');

let passed = 0;
const failures = [];
async function bounded(promise, ms = 3000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`did not settle within ${ms} ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function test(name, fn) {
  try { await bounded(fn()); passed++; }
  catch (error) { failures.push({ name, message: error.message }); }
}

// A fresh Forge: module scope as the page has it, with xterm and the host model stubbed.
function forge({ infer = async () => ({ content: 'done', toolCalls: [] }) } = {}) {
  const written = [];
  const term = { write: (s) => written.push(String(s)), clear: () => written.push('<clear>'), focus() {} };
  const ctx = {
    createFileops, MemoryBackend, createGitCore, buildRigRegistry, createGrant, createOpLog,
    createAgentFace, createShell, runAgentLoop, codingToolset, makeToolExecutor,
    AbortController, setTimeout,
    pyReady: false, backend: null, fs: null, git: null, registry: null, grant: null, opLog: null,
    face: null, kiln: null, shell: null, workspaceLabel: '', pyAnnounced: false,
    agentCtl: null, inflight: null, dirCache: {},
    ACCENT: '', DIM: '', RESET: '', RED: '',
    term, nak: null, cwdEl: { textContent: '' },
    editor: createLineEditor({ complete: () => [] }),
    inferViaHost: infer,
  };
  const scope = evaluate(script, ctx);
  const { pump } = scope;
  pump.showPrompt();
  const screen = () => written.join('');
  return { scope, editor: ctx.editor, pump, written, screen,
    // type: one xterm onData event; run: type a line and wait for the prompt to come back
    type: (s) => pump.input(s),
    run: async (line) => { pump.input(line + '\r'); await pump.settled(); },
    exists: async (path) => (await scope.face.invoke('fs.stat', { path })).ok };
}
const IN_PROGRESS = /feed already in progress/;
const order = (screen, ...parts) => {
  let at = -1;
  for (const part of parts) {
    const next = screen.indexOf(part, at + 1);
    assert.ok(next > at, `"${part}" appears after the previous part in:\n${JSON.stringify(screen)}`);
    at = next;
  }
};

await test('guard: the shell really does refuse a second feed while one is in flight', async () => {
  const { scope } = forge();
  const first = scope.shell.feed('echo one');
  await assert.rejects(scope.shell.feed('echo two'), IN_PROGRESS);
  await first;
});

await test('two lines typed back to back both run, in order', async () => {
  const f = forge();
  f.type('echo one > a\r');
  f.type('cat a\r'); // arrives while the first line's feed is still in flight
  assert.equal(f.pump.busy, true, 'the second line arrived while the first was running');
  await f.pump.settled();
  assert.doesNotMatch(f.screen(), IN_PROGRESS);
  // `cat a` prints `one` only if the echo ran first. The type-ahead line reappears at its prompt.
  order(f.screen(), '/ $ echo one > a\r\n', '/ $ cat a\r\n', 'one\r\n', '/ $ ');
  assert.ok(f.screen().endsWith('/ $ '), 'the prompt comes back once the queue is empty');
});

await test('the reported case: answer a confirm, then type the next command before it returns', async () => {
  const f = forge();
  await f.run('echo hello > t/a; git init && git add t/a && git commit -m first');
  assert.match(f.screen(), /git\.commit is destructive\. confirm\? \[y\/N\]/);
  f.type('y\r');
  f.type('git status\r');
  await f.pump.settled();
  assert.doesNotMatch(f.screen(), IN_PROGRESS);
  order(f.screen(), 'y\r\n', 'git status\r\n', /\[[0-9a-f]{7}\]/.exec(f.screen())?.[0] ?? '<no commit id>',
    '/ $ git status\r\n', '(clean)', '/ $ ');
});

await test('a pasted block runs every line, not only the first', async () => {
  const f = forge();
  f.type('echo a\recho b\recho c\r');
  await f.pump.settled();
  order(f.screen(), 'a\r\n', '/ $ echo b\r\n', 'b\r\n', '/ $ echo c\r\n', 'c\r\n');
});

await test('^C while a command runs stops it and drops the lines typed ahead', async () => {
  const f = forge();
  f.type('sleep 5\r');
  f.type('echo never > flag\r');
  f.type('\x03');
  await f.pump.settled(); // bounded: a sleep that ignored ^C would hold this for 5 s
  assert.match(f.screen(), /interrupted/);
  assert.equal(await f.exists('flag'), false, 'the flushed type-ahead line never ran');
  await f.run('echo after');
  assert.match(f.screen(), /after\r\n\/ \$ $/, 'the next line runs normally');
});

await test('^C at a confirm refuses it; the next line runs as a command, not as the answer', async () => {
  const f = forge();
  await f.run('echo hello > t/a');
  await f.run('rm t/a');
  assert.match(f.screen(), /fs\.remove is destructive\. confirm\? \[y\/N\]/);
  f.type('\x03');
  await f.pump.settled();
  assert.equal(f.scope.shell.awaitingConfirm, null, 'no confirm is left pending');
  const before = f.screen().length;
  await f.run('ls t');
  assert.match(f.screen().slice(before), /\ba\r\n/, '`ls t` ran and listed the file');
  assert.equal(await f.exists('t/a'), true, 'the refused rm removed nothing');
});

await test('no prompt while a command runs; unfinished type-ahead reappears after it', async () => {
  const f = forge();
  f.type('sleep 0.05\r');
  f.type('ec');
  assert.equal(f.editor.prompt(), '', 'type-ahead echoes with no prompt');
  await f.pump.settled();
  assert.ok(f.screen().endsWith('/ $ ec'), `prompt then the unfinished line, got ${JSON.stringify(f.screen().slice(-20))}`);
  f.type('ho back\r');
  await f.pump.settled();
  assert.match(f.screen(), /back\r\n\/ \$ $/);
});

await test('unfinished type-ahead is erased before a queued line is re-echoed (live 2026-09-29)', async () => {
  const f = forge();
  f.type('sleep 0.05\r');
  f.type('echo queued\r');
  f.type('ec'); // on the cursor line when `echo queued` starts
  await f.pump.settled();
  assert.doesNotMatch(f.screen(), /ec\/ \$ echo queued/, 'the re-echo does not land after the unfinished line');
  order(f.screen(), 'ec', '\r\x1b[K/ $ echo queued\r\n', 'queued\r\n', '/ $ ec');
  assert.equal(f.editor.line, 'ec', 'the unfinished line is still being edited');
});

await test('^L repaints the prompt once (it used to write a second one: `/ $ / $ `)', async () => {
  const f = forge();
  f.type('ab');
  f.written.length = 0;
  f.type('\x0c');
  assert.equal(f.written.filter((s) => s.includes('/ $ ')).length, 1, 'one prompt in the repaint');
  assert.equal(f.written.at(-1), '<clear>', 'nothing is written after the clear');
});

await test('^C during `agent` aborts the run and cuts its shell command', async () => {
  let calls = 0, toolIssued;
  const issued = new Promise((resolve) => { toolIssued = resolve; });
  const f = forge({ infer: async () => {
    calls++;
    if (calls > 1) return { content: 'finished', toolCalls: [] };
    toolIssued();
    return { content: '', toolCalls: [{ id: 'c0', type: 'function', function: { name: 'shell', arguments: '{"command":"sleep 5"}' } }] };
  } });
  f.type('agent "wait"\r');
  await issued;
  await new Promise((resolve) => setTimeout(resolve, 20)); // let the tool's feed start its sleep
  f.type('\x03');
  await f.pump.settled(); // bounded: an uncut sleep would hold this for 5 s
  assert.match(f.screen(), /agent aborted/);
  assert.equal(calls, 1, 'the loop stopped instead of asking the model again');
  assert.equal(f.scope.agentCtl, null, 'the aborted controller is released');
  // A still-aborted signal would leave the shell read-only; a write proves it was released.
  await f.run('echo after > b');
  await f.run('cat b');
  assert.match(f.screen(), /after\r\n\/ \$ $/);
});

if (failures.length) {
  for (const { name, message } of failures) console.error(`FAIL ${name}\n  ${message}`);
  console.error(`forge-input-queue: ${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`forge-input-queue: ${passed}/${passed} — typed-ahead lines queue and run in order; ^C stops the command in flight`);
