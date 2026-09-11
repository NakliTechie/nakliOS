// Conformance — the coding-agent tool set (read/write/edit/apply_patch) and the
// edit replacer chain, over a real Rig face.
//
//   node sys/ai/test/agent-tools.test.mjs

import { applyEdit, parseApplyPatch, makeToolExecutor, codingToolset, makeShellVerifier } from '../agent-tools.mjs';
import { createFileops, MemoryBackend } from '../../rig/fileops/index.mjs';
import { buildRigRegistry } from '../../rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../rig/agent/index.mjs';
import { createShell } from '../../rig/cli/shell.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) { try { await fn(); passed++; } catch (e) { failures.push({ name, message: e.message }); } }
function eq(a, b, m) { if (a !== b) throw new Error(`${m || 'ne'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`); }
function assert(c, m) { if (!c) throw new Error(m || 'assert'); }

function fresh() {
  const backend = new MemoryBackend();
  const fs = createFileops({ backend });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  return { face, registry, shell, exec: makeToolExecutor({ shell, face }) };
}

// ── replacer chain ──────────────────────────────────────────────────────
await test('applyEdit: exact match', () => {
  const r = applyEdit('const x = 1;\nconst y = 2;\n', 'const x = 1;', 'const x = 42;');
  assert(r.ok && r.strategy === 'exact', 'exact'); assert(r.content.includes('x = 42'), 'applied');
});
await test('applyEdit: uniqueness gate (non-unique needs replace_all)', () => {
  const c = 'a\na\n';
  const r = applyEdit(c, 'a', 'b');
  assert(!r.ok && /multiple matches/i.test(r.error), 'blocked non-unique (instructive error)');
  const r2 = applyEdit(c, 'a', 'b', true);
  assert(r2.ok && r2.count === 2 && r2.content === 'b\nb\n', 'replace_all');
});
await test('applyEdit: line-trimmed tolerates indentation drift', () => {
  const c = 'function f() {\n      return 1;\n}\n';           // 6-space indent in file
  const r = applyEdit(c, 'function f() {\n  return 1;\n}', 'function f() {\n  return 2;\n}'); // 2-space in old_string
  assert(r.ok && r.strategy === 'line-trimmed', `strategy: ${r.strategy} ${r.error || ''}`);
  assert(r.content.includes('return 2;'), 'applied via line-trim');
});
await test('applyEdit: block-anchor matches a slightly-off middle (≥0.65)', () => {
  // Middle differs only slightly (a typo) → similarity above the 0.65 threshold.
  const c = 'function greet(name) {\n  return "Hello, " + naem;\n}\n';
  const r = applyEdit(c, 'function greet(name) {\n  return "Hello, " + name;\n}', 'function greet(name) {\n  return `Hi, ${name}`;\n}');
  assert(r.ok && r.strategy === 'block-anchor', `strategy: ${r.strategy} ${r.error || ''}`);
  assert(r.content.includes('Hi, '), 'applied via anchor');
});
await test('applyEdit: block-anchor REFUSES a too-different middle', () => {
  const c = 'start\n  junk the model did not reproduce at all here\nend\n';
  const r = applyEdit(c, 'start\n  COMPLETELY DIFFERENT\nend', 'start\n  x\nend');
  assert(!r.ok, 'a dissimilar middle is not a safe anchor match');
});
await test('applyEdit: whitespace-normalized and indentation-flexible', () => {
  const ws = applyEdit('const   x    =  1;\n', 'const x = 1;', 'const x = 2;');
  assert(ws.ok && ws.strategy === 'whitespace-normalized', `ws: ${ws.strategy} ${ws.error || ''}`);
  const ind = applyEdit('    if (a) {\n        go();\n    }\n', 'if (a) {\n  go();\n}', 'if (a) {\n  stop();\n}');
  assert(ind.ok && /indentation-flexible|line-trimmed/.test(ind.strategy), `ind: ${ind.strategy} ${ind.error || ''}`);
  assert(ind.content.includes('stop();'), 'indentation-flexible applied');
});
await test('applyEdit: escape-normalized and trimmed-boundary', () => {
  // File has real newlines; old_string came through double-escaped.
  const esc = applyEdit('line one\nline two\n', 'line one\\nline two', 'line one\nEDITED');
  assert(esc.ok && esc.strategy === 'escape-normalized', `esc: ${esc.strategy} ${esc.error || ''}`);
  // old_string carries stray boundary whitespace the file doesn't have.
  const tb = applyEdit('const y = 2;\n', '  const y = 2;  ', 'const y = 3;');
  assert(tb.ok, `trimmed-boundary applied: ${tb.strategy} ${tb.error || ''}`);
});
await test('applyEdit: not found and identical', () => {
  assert(!applyEdit('abc', 'xyz', 'q').ok, 'not found');
  assert(/Could not find/i.test(applyEdit('abc', 'xyz', 'q').error), 'instructive not-found');
  assert(!applyEdit('abc', 'abc', 'abc').ok, 'identical rejected');
  assert(!applyEdit('abc', '', 'q').ok, 'empty old rejected');
});

// ── apply_patch parsing ─────────────────────────────────────────────────
await test('parseApplyPatch: add / delete / update hunk', () => {
  const p = [
    '*** Begin Patch',
    '*** Add File: a.txt',
    '+hello',
    '+world',
    '*** Delete File: old.txt',
    '*** Update File: b.txt',
    '@@',
    ' keep',
    '-remove me',
    '+added',
    '*** End Patch',
  ].join('\n');
  const r = parseApplyPatch(p);
  assert(r.ok, 'parsed');
  eq(r.ops.length, 3, 'three ops');
  eq(r.ops[0].kind, 'add'); eq(r.ops[0].content, 'hello\nworld', 'add body');
  eq(r.ops[1].kind, 'delete');
  eq(r.ops[2].kind, 'update');
  eq(r.ops[2].hunks[0].before, 'keep\nremove me', 'hunk before');
  eq(r.ops[2].hunks[0].after, 'keep\nadded', 'hunk after');
});
await test('parseApplyPatch: missing envelope errors', () => {
  assert(!parseApplyPatch('nope').ok, 'no begin');
});

// ── executor over a real Rig face ───────────────────────────────────────
await test('shell reports the exit code, so a failure is not read as success', async () => {
  const { exec } = fresh();
  eq(await exec('shell', { command: 'echo hi' }), 'hi\n[exit 0]', 'success carries exit 0');
  // The load-bearing case: no output AND a non-zero code. Without the marker the
  // model saw "(no output)" and had no way to tell this from a clean run.
  eq(await exec('shell', { command: 'test -f missing.txt' }), '(no output)\n[exit 1]', 'silent failure is legible');
  assert(/\[exit 127\]$/.test(await exec('shell', { command: 'nosuchcommand' })), 'unknown command reports 127');
});
// D3 expect through the real runner. The live-found case (2026-09-10): a silent exit-0 command
// predicted `exit 0` must not come back as a plain MET the agent reads as "found it".
await test('expect: a silent exit-0 command graded `exit 0` is VACUOUS; `output` is falsifiable', async () => {
  const { exec, shell } = fresh();
  await shell.feed('printf "needle here\\n" > hay.txt');
  const silent = await exec('shell', { command: 'echo', expect: 'exit 0' });
  assert(/\[exit 0\]\n\[expect\] VACUOUS \(exit 0\) — /.test(silent), `vacuous, not MET: ${silent}`);
  assert(/"output"/.test(silent), `the line tells the agent which predicate to use: ${silent}`);
  const loud = await exec('shell', { command: 'grep needle hay.txt', expect: 'exit 0' });
  assert(/\[expect\] MET \(exit 0\)/.test(loud), `exit 0 with output is a plain MET: ${loud}`);
  assert(/\[expect\] MISS \(output\)/.test(await exec('shell', { command: 'echo', expect: 'output' })), 'output on silence misses');
  assert(/\[expect\] MET \(output\)/.test(await exec('shell', { command: 'grep needle hay.txt', expect: 'output' })), 'output on a hit is met');
  // a real search miss in this shell is exit 1 (grep semantics); predicting exit 1 on silence is a real hit
  assert(/\[exit 1\]\n\[expect\] MET \(exit 1\)/.test(await exec('shell', { command: 'grep nomatch hay.txt', expect: 'exit 1' })), 'a met non-zero exit is not vacuous');
});
await test('an intercepted command reports NO exit code (lastCode would be stale)', async () => {
  const { exec } = fresh();
  // interceptBashCommand redirects this to the edit tool without ever calling
  // shell.feed, so shell.lastCode still holds some earlier command's result.
  const out = await exec('shell', { command: 'sed -i s/a/b/ f.txt' });
  assert(/edit` tool/.test(out), `redirected: ${out}`);
  assert(!/\[exit /.test(out), `no exit code invented for an unrun command: ${out}`);
});
await test('read returns line-numbered content', async () => {
  const { exec, shell } = fresh();
  await shell.feed('printf "alpha\\nbeta\\n" > f.txt');
  const out = await exec('read', { path: 'f.txt' });
  assert(/1  alpha/.test(out) && /2  beta/.test(out), `numbered: ${out}`);
});
await test('write creates a file the shell can read back', async () => {
  const { exec, shell } = fresh();
  const r = await exec('write', { path: 'dir/new.txt', content: 'hello world' });
  assert(/Wrote/.test(r), `write ok: ${r}`);
  eq((await shell.feed('cat dir/new.txt')).output, 'hello world', 'persisted');
});
await test('edit applies a surgical change through the face', async () => {
  const { exec, shell } = fresh();
  await exec('write', { path: 'code.js', content: 'const version = "1.0.0";\nexport default version;\n' });
  const r = await exec('edit', { path: 'code.js', old_string: 'const version = "1.0.0";', new_string: 'const version = "2.0.0";' });
  assert(/Edited/.test(r), `edited: ${r}`);
  assert((await shell.feed('cat code.js')).output.includes('2.0.0'), 'change landed');
});
await test('edit reports a non-unique match instead of guessing', async () => {
  const { exec } = fresh();
  await exec('write', { path: 'd.txt', content: 'x\nx\n' });
  const r = await exec('edit', { path: 'd.txt', old_string: 'x', new_string: 'y' });
  assert(/multiple matches/i.test(r), `blocked: ${r}`);
});
await test('apply_patch adds, updates, and deletes files', async () => {
  const { exec, shell } = fresh();
  await exec('write', { path: 'b.txt', content: 'keep\nremove me\n' });
  await exec('write', { path: 'old.txt', content: 'bye\n' });
  const patch = [
    '*** Begin Patch',
    '*** Add File: a.txt',
    '+hello',
    '*** Update File: b.txt',
    '@@',
    ' keep',
    '-remove me',
    '+added',
    '*** Delete File: old.txt',
    '*** End Patch',
  ].join('\n');
  const r = await exec('apply_patch', { patch });
  assert(/Applied patch/.test(r), `applied: ${r}`);
  eq((await shell.feed('cat a.txt')).output, 'hello', 'added');
  assert((await shell.feed('cat b.txt')).output.includes('added'), 'updated');
  const gone = (await shell.feed('cat old.txt')).output;
  assert(/error|not|ENOENT/i.test(gone), `deleted: ${gone}`);
});
await test('modes: plan/ask gate the tool set and refuse mutation', async () => {
  eq(codingToolset('plan').map((t) => t.function.name).sort().join(','), 'read,todowrite', 'plan exposes read+todo');
  eq(codingToolset('ask').map((t) => t.function.name).join(','), 'read', 'ask exposes read only');
  assert(codingToolset('code').length === 6, 'code = all tools');
  const { face, shell } = fresh();
  const planExec = makeToolExecutor({ shell, face, mode: 'plan' });
  assert(/not available in plan/.test(await planExec('write', { path: 'x', content: 'y' })), 'plan refuses write');
  assert(/not available in plan/.test(await planExec('shell', { command: 'ls' })), 'plan refuses shell');
  assert(!/not available/.test(await planExec('read', { path: 'nope' })), 'plan allows read');
});

await test('subagents: task spawns a depth-capped child loop over the same workspace', async () => {
  assert(codingToolset('code', { subagents: true }).some((t) => t.function.name === 'task'), 'task added with subagents flag');
  assert(!codingToolset('code').some((t) => t.function.name === 'task'), 'task off by default');
  const { face, shell } = fresh();
  let calls = 0;
  const infer = async () => {
    calls++;
    if (calls === 1) return { content: '', toolCalls: [{ id: 'c', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: 'echo hi > sub.txt' }) } }] };
    return { content: 'Created sub.txt with hi.', toolCalls: [] };
  };
  const exec = makeToolExecutor({ shell, face, infer });
  const out = await exec('task', { description: 'make file', prompt: 'Create sub.txt containing hi.' });
  assert(/Created sub\.txt/.test(out), `subagent returned a summary: ${out}`);
  eq((await shell.feed('cat sub.txt')).output, 'hi', 'subagent worked in the shared workspace');
  const childExec = makeToolExecutor({ shell, face, infer, subagentDepth: 1 });
  assert(/not available/.test(await childExec('task', { prompt: 'x' })), 'depth cap blocks nesting');
  assert(/not available/.test(await makeToolExecutor({ shell, face })('task', { prompt: 'x' })), 'no infer → no subagents');
});

await test('read-before-edit ledger: edit refuses an unread file; read or cat unlocks it', async () => {
  const { exec, shell } = fresh();
  await shell.feed('printf "const v = 1;\\n" > cfg.js'); // written via the shell, NOT the tools
  const blocked = await exec('edit', { path: 'cfg.js', old_string: 'const v = 1;', new_string: 'const v = 2;' });
  assert(/has not been read/.test(blocked), `blocked: ${blocked}`);
  await exec('read', { path: 'cfg.js' });
  assert(/Edited/.test(await exec('edit', { path: 'cfg.js', old_string: 'const v = 1;', new_string: 'const v = 2;' })), 'read unlocks edit');
  await shell.feed('printf "x = 1\\n" > other.txt');
  await exec('shell', { command: 'cat other.txt' });
  assert(/Edited/.test(await exec('edit', { path: 'other.txt', old_string: 'x = 1', new_string: 'x = 2' })), 'cat unlocks edit');
});

await test('read: line-numbered slice with an offset + "showing lines" footer', async () => {
  const { exec, shell } = fresh();
  await shell.feed('printf "a\\nb\\nc\\nd\\ne\\n" > f.txt');
  const out = await exec('read', { path: 'f.txt', offset: 2, limit: 2 });
  assert(/2  b/.test(out) && /3  c/.test(out), `numbered: ${out}`);
  assert(/Showing lines 2.3 of [0-9]/.test(out), `footer: ${out}`);
});
await test('bulky shell output spills to a .forge artifact the model can read', async () => {
  const { exec } = fresh();
  const big = Array.from({ length: 2100 }, (_, i) => 'line' + i).join('\n');
  await exec('write', { path: 'big.txt', content: big });
  const out = await exec('shell', { command: 'cat big.txt' });
  assert(/Full output saved to \.forge\/out-\d+\.txt/.test(out), `spilled: ${out.slice(-160)}`);
  // the spill file is readable back
  const back = await exec('read', { path: '.forge/out-1.txt', offset: 2099, limit: 2 });
  assert(/line2099/.test(back), `re-read tail: ${back}`);
});
await test('todowrite renders the checklist and enforces one in_progress', async () => {
  const { exec } = fresh();
  const out = await exec('todowrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }, { content: 'c', status: 'pending' }] });
  assert(/\[x\] a/.test(out) && /\[~\] b/.test(out) && /\[ \] c/.test(out), `rendered: ${out}`);
  assert(/1\/3/.test(out), 'progress count');
  assert(/only one/.test(await exec('todowrite', { todos: [{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }] })), 'two in_progress rejected');
});

await test('YOLO: the shell tool auto-confirms a staged destructive op', async () => {
  const { exec, shell } = fresh();
  await shell.feed('echo x > gone.txt');
  await exec('shell', { command: 'rm gone.txt' });
  assert(!shell.awaitingConfirm, 'confirm auto-resolved, not left pending');
  const after = await shell.feed('cat gone.txt');
  assert(/error|not|ENOENT/i.test(after.output), `file was removed: ${after.output}`);
});

await test('unknown tool is reported, never thrown', async () => {
  const { exec } = fresh();
  assert(/unknown tool/.test(await exec('frobnicate', {})), 'unknown');
});
await test('makeShellVerifier runs a fixed command in a fresh shell → exit-coded verdict', async () => {
  const { face, registry, shell } = fresh();
  await shell.feed('echo PASS > status.txt');
  const pass = makeShellVerifier({ createShell, registry, face, command: '[ -f status.txt ] && grep PASS status.txt' });
  const r1 = await pass();
  eq(r1.ok, true, 'passes when the check holds'); eq(r1.exit, 0, 'exit 0');
  const fail = makeShellVerifier({ createShell, registry, face, command: 'grep NOPE status.txt' });
  const r2 = await fail();
  eq(r2.ok, false, 'fails when the check does not hold'); assert(r2.exit !== 0, 'non-zero exit');
});

await test('codingToolset advertises read/edit/write/apply_patch/shell', () => {
  const names = codingToolset().map((t) => t.function.name);
  for (const n of ['read', 'edit', 'write', 'apply_patch', 'todowrite', 'shell']) assert(names.includes(n), `has ${n}`);
});


// ── a shell call whose command went in the wrong parameter ─────────────
// Live-found 2026-09-10 (Anvil on Ollama qwen3:8b): the model sent {"cmd": "rg …"}
// three times. Each came back "requires a non-empty command" WITH "[exit 0]"
// appended, because the exit code was read from a shell that had never run. The
// model read exit 0 as success and the loop stopped `done` having executed nothing.
await test('a shell call with the wrong parameter name is refused, names "command", and reports NO exit code', async () => {
  const { exec, shell } = fresh();
  await exec('shell', { command: 'echo priming' });   // make lastCode a real, stale 0
  const out = await exec('shell', { cmd: 'rg -n "def solve" --type py' });
  assert(!/\[exit \d+\]/.test(out), `a refusal that never reached the shell must carry no exit code: ${out}`);
  assert(/"command"/.test(out), `the refusal must name the parameter that works: ${out}`);
  assert(/"cmd"/.test(out), `the refusal must name the key that was actually sent: ${out}`);
  assert(/Nothing was run/.test(out), `the refusal must say nothing ran: ${out}`);
  eq(shell.lastCode, 0, 'the priming call is untouched');
});

await test('a shell call with no arguments at all is refused the same way', async () => {
  const { exec } = fresh();
  const out = await exec('shell', {});
  assert(!/\[exit \d+\]/.test(out), `no exit code: ${out}`);
  assert(/"command"/.test(out), `names the parameter: ${out}`);
  assert(/no arguments/.test(out), `says what arrived: ${out}`);
});

await test('a real shell call still reports its exit code', async () => {
  const { exec } = fresh();
  const ok = await exec('shell', { command: 'echo hello' });
  assert(/\[exit 0\]/.test(ok), `a command that ran keeps its exit code: ${ok}`);
  const bad = await exec('shell', { command: 'definitely-not-a-command' });
  assert(/\[exit [1-9]/.test(bad), `a failing command reports a non-zero code: ${bad}`);
});

// Live 2026-09-11: a model wrote `/workspace/inv/store.py`; the leading slash resolves against the
// root, the file landed in a folder literally named workspace/, and the bare "Wrote
// workspace/inv/store.py" read to it as proof that /workspace existed — 24 steps lost. The result
// line now says what happened when, and only when, the path was absolute.
await test('write: an absolute path is resolved against the root AND the result says so', async () => {
  const { exec, face } = fresh();
  const abs = await exec('write', { path: '/workspace/inv/store.py', content: 'x = 1\n' });
  assert(/^Wrote workspace\/inv\/store\.py \(6 bytes\)/.test(abs), `resolved against the root: ${abs}`);
  assert(/absolute paths resolve against the workspace root/.test(abs), `and the line says so: ${abs}`);
  assert(/there is no \/workspace/.test(abs), 'naming the prefix the model invented');
  const r = await face.invoke('fs.read', { path: 'workspace/inv/store.py', encoding: 'utf-8' });
  assert(r.ok, 'the file is where the line says it is');
  const rel = await exec('write', { path: 'inv/store.py', content: 'x = 2\n' });
  eq(rel, 'Wrote inv/store.py (6 bytes)', 'a relative path gets the plain line — the note is not noise on every write');
});

if (failures.length) {
  console.error(`agent-tools: ${passed} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error(`  FAIL ${f.name}: ${f.message}`);
  process.exit(1);
}
console.log(`sys/ai/agent-tools conformance: ${passed}/${passed} passed`);
