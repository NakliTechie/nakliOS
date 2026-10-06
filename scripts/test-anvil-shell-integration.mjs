import {classifyToolResult} from '../sys/ai/tool-result-kind.mjs';
// Exercise the actual inline Anvil handlers with the real executor and Rig shell.
// Only the UI/rendering edges are stubbed. No model call or copied executor wrapper.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineModule, extractFunction, evaluate } from './anvil-harness.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGitCore } from '../sys/rig/git/git-core.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { preHookReply, postHookNotes } from '../sys/ai/run-assembly.mjs';
import { gateAction, gateEvent, guardCriticalShellInvocation } from '../sys/ai/action-gate.mjs';
import { applyPolicy, grant as policyGrant, POLICY_HINT } from '../sys/ai/action-policy.mjs';
import { withShellContext, decideByRules, applyMode } from '../sys/ai/permission-rules.mjs';
import { explainSkillsRefusal } from '../sys/ai/skills.mjs';
import { explainGateRefusal } from '../sys/ai/gate.mjs';

const source = await inlineModule();
const executorSource = extractFunction(source, 'executeTool');
const stopSource = extractFunction(source, 'stopRun');
const gateHintSource = extractFunction(source, 'gateHint');
const agentShellSource = source.split('\n').find((line) => line.includes('const agentShell = () => createShell('));
assert.ok(agentShellSource, 'extract the actual agent shell factory');

function fixture({ hooksCfg = { preTool: [], postTool: [] }, permissionRules = {}, permissionMode = 'bypass', answer = 'no', extraScopes = [] } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const face = createAgentFace({ registry,
    grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write', ...extraScopes] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const t = { id: 'shell-integration', verifyCmd: '', log: [], convo: [{ role: 'user', content: 'Inspect the fixture workspace.' }] };
  const state = { permissionRules, permissionMode, policy: {} };
  const system = [], questions = [], events = [];
  const runtime = evaluate(`
    let abortController = new AbortController();
    let priming = false, primeAbortController = null;
    ${agentShellSource}
    const shell = agentShell();
    const baseExec = makeToolExecutor({ shell, face, mode });
    ${gateHintSource}
    ${executorSource}
    ${stopSource}
    ({ executeTool, stopRun, shell,
       nextRun: () => { abortController = new AbortController(); },
       isAborted: () => abortController.signal.aborted });
  `, {
    AbortController, createShell, makeToolExecutor, registry, face, fs, mode: 'code', t, state, hooksCfg,
    classifyToolResult, preHookReply, postHookNotes, gateAction, gateEvent, guardCriticalShellInvocation, applyPolicy, policyGrant, POLICY_HINT,
    withShellContext, decideByRules, applyMode, explainSkillsRefusal, explainGateRefusal,
    kilnRef: null, jsHost: null,
    runCtx: { t, messages: t.convo, rec: { onEvent: (event) => events.push(event) } },
    pushSystem: (text) => system.push(text),
    askChoice: async (question) => { questions.push(question); return answer; },
    renderLog() {}, renderFiles() {}, save() {},
  });
  const feeds = [];
  const feed = runtime.shell.feed;
  runtime.shell.feed = async (line) => { feeds.push(line); return feed(line); };
  const run = (command) => runtime.executeTool('shell', { command }, { id: `call-${feeds.length}` });
  return { ...runtime, fs, git, face, state, t, system, questions, events, feeds, run };
}

test('Anvil wrapper returns twelve real confirmation receipts, the final exit code, and an independent next call', async () => {
  const ctx = fixture();
  const paths = Array.from({ length: 12 }, (_, index) => `fixture-${index}`);
  for (const path of paths) await ctx.fs.write(path, 'remove this');
  const output = await ctx.run(paths.map((path) => `rm ${path}`).join('; ') + '; echo FINISHED');
  assert.equal((output.match(/^confirmed:/gm) || []).length, paths.length);
  assert.match(output, /FINISHED\n\[exit 0\]$/);
  assert.equal(ctx.feeds.filter((line) => line === 'y').length, paths.length);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.equal(ctx.shell.awaitingConfirm, null);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  for (const path of paths) assert.equal((await ctx.fs.stat(path)).ok, false, path);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
  assert.deepEqual(ctx.questions, []);
});

test('the actual Anvil Stop handler cancels a suspended shell operation and preserves its pending file', async () => {
  const ctx = fixture();
  await ctx.fs.write('first', 'accepted');
  await ctx.fs.write('second', 'preserved');
  const feed = ctx.shell.feed;
  let stages = 0;
  ctx.shell.feed = async (line) => {
    const result = await feed(line);
    if (result.awaitingConfirm && ++stages === 2) ctx.stopRun();
    return result;
  };
  const output = await ctx.run('rm first; rm second; echo bad > after-stop');
  assert.equal(ctx.isAborted(), true, 'the actual handler aborted the shell signal');
  assert.deepEqual(ctx.system, ['Stopping…']);
  assert.equal((output.match(/^confirmed:/gm) || []).length, 1);
  assert.match(output, /interrupted/);
  assert.match(output, /\[exit 130\]$/);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.equal((await ctx.fs.stat('first')).ok, false);
  assert.equal((await ctx.fs.read('second', { encoding: 'utf-8' })).data, 'preserved');
  assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.equal(ctx.shell.awaitingConfirm, null);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  ctx.nextRun();
  assert.equal(await ctx.run('cat second'), 'preserved\n[exit 0]', 'the next run is not consumed by the cancelled invocation');
});

test('Anvil preserves interceptor hints without running a shell command or attaching a stale exit code', async () => {
  const ctx = fixture();
  await ctx.fs.write('file', 'aaa');
  assert.match(await ctx.run('unknown-command'), /\[exit 127\]$/);
  const count = ctx.feeds.length;
  const output = await ctx.run('perl -i -pe s/a/b/ file');
  assert.match(output, /edit` tool/);
  assert.doesNotMatch(output, /\[exit /);
  assert.equal(ctx.feeds.length, count, 'neither wrapper sends the intercepted command to feed');
  assert.equal((await ctx.fs.read('file', { encoding: 'utf-8' })).data, 'aaa');
});

test('Anvil denies an owner-blocked shell command before auto-confirmation, including in bypass mode', async () => {
  const ctx = fixture({ permissionRules: { deny: ['Bash(rm:*)'] } });
  await ctx.fs.write('keep', 'unchanged');
  const output = await ctx.run('echo before; rm keep');
  assert.match(output, /^Refused: .*deny rule/);
  assert.doesNotMatch(output, /\[exit /);
  assert.deepEqual(ctx.feeds, []);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
  assert.equal(ctx.t.log.length, 1, 'the actual app wrapper records the permission refusal');
});

test('Anvil project pre-hooks block execution; post-hooks append actual shell output', async () => {
  const hooksCfg = {
    preTool: [{ on: 'shell', commandMatch: 'rm keep', block: 'Keep the fixture.' }],
    postTool: [{ on: 'shell', commandMatch: 'echo MAIN', run: 'echo POST > hook-file; cat hook-file' }],
  };
  const ctx = fixture({ hooksCfg });
  await ctx.fs.write('keep', 'unchanged');
  assert.equal(await ctx.run('rm keep'), '[blocked by a project hook] Keep the fixture.');
  assert.deepEqual(ctx.feeds, []);
  assert.equal((await ctx.fs.stat('keep')).ok, true);
  const output = await ctx.run('echo MAIN');
  assert.equal(output, 'MAIN\n[exit 0]\n[hook] echo POST > hook-file; cat hook-file\nPOST\n[exit 0]');
  assert.equal((await ctx.fs.read('hook-file', { encoding: 'utf-8' })).data, 'POST\n');
});

test('Anvil deny rules also hold through env and xargs wrappers', async () => {
  const ctx = fixture({ permissionRules: { deny: ['Bash(rm:*)'] } });
  await ctx.fs.write('keep', 'unchanged');
  for (const command of ['env -i rm keep', 'echo keep | xargs -n1 rm']) {
    assert.match(await ctx.run(command), /^Refused:/);
  }
  assert.deepEqual(ctx.feeds, []);
  assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
});

test('Anvil reports dirty git rm as a refusal with exit 1 and keeps the uncommitted file', async () => {
  const ctx = fixture();
  await ctx.git.init();
  await ctx.fs.write('tracked', 'committed');
  await ctx.git.add({ filepath: 'tracked' });
  await ctx.git.commit({ message: 'fixture', actor: 'agent' });
  await ctx.fs.write('tracked', 'uncommitted edit');
  const before = (await ctx.git.statusMatrix()).matrix;
  const output = await ctx.run('git rm tracked');
  assert.match(output, /local modifications/);
  assert.match(output, /\[exit 1\]$/);
  assert.doesNotMatch(output, /^confirmed:/m);
  assert.equal((await ctx.fs.read('tracked', { encoding: 'utf-8' })).data, 'uncommitted edit');
  assert.deepEqual((await ctx.git.statusMatrix()).matrix, before);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('a malformed deny rule still blocks wrapped commands in bypass mode when an ask rule exists', async () => {
  const ctx = fixture({ permissionRules: { deny: ['shell(rm:*'], ask: ['Bash(ls:*)'] } });
  await ctx.fs.write('keep', 'unchanged');
  for (const command of ['env rm keep', 'echo keep | xargs rm']) {
    assert.match(await ctx.run(command), /deny rule/);
    assert.equal(ctx.feeds.length, 0);
  }
  assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
});


// Review regressions use only MemoryBackend and an in-process recording transport.
// No host Git command, network request, or remote mutation occurs in these tests.
for (const permissionMode of ['default', 'bypass']) test(`Anvil refuses critical expanded function arguments in ${permissionMode} mode`, async () => {
  const ctx = fixture({ permissionMode, answer: 'once', extraScopes: ['git:push'] });
  const dispatched = [];
  ctx.git.push = async (args) => { dispatched.push(args); return { ok: true }; };
  assert.match(await ctx.run('f(){ git push "$1" origin main; }'), /\[exit 0\]$/);
  const output = await ctx.run('f --force; printf BAD > after-critical');
  assert.match(output, /whatever it was asked/);
  assert.match(output, /\[exit 126\]$/);
  assert.deepEqual(dispatched, [], 'the recording transport receives no call');
  assert.equal((await ctx.fs.stat('after-critical')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
});

for (const permissionMode of ['default', 'bypass']) test(`Anvil static critical actions remain non-liftable with an allow wildcard in ${permissionMode} mode`, async () => {
  const ctx = fixture({ permissionMode, permissionRules: { allow: ['Bash(*)'] }, answer: 'always' });
  for (const command of ["g'it' push --force origin main", 'env git push -f origin main', 'timeout 1 git push --force origin main',
    'if false; then git push --force origin main; fi']) {
    const output = await ctx.run(command);
    assert.match(output, /Refused/);
  }
  assert.deepEqual(ctx.feeds, [], 'static critical classification refuses before shell execution');
  assert.deepEqual(ctx.questions, [], 'no approval choice can lift a critical refusal');
});

for (const permissionMode of ['default', 'bypass']) test(`Anvil asks about dynamic executables with empty rules in ${permissionMode} mode`, async () => {
  const ctx = fixture({ permissionMode });
  for (const command of ['$COMMAND victim', 'f(){ "$1" victim; }; f rm']) {
    assert.match(await ctx.run(command), /^Refused: /);
  }
  assert.equal(ctx.questions.length, 2);
  assert.deepEqual(ctx.feeds, []);
});

test('Anvil approves an inspectable dynamic invocation once and asks again for a persisted dynamic function', async () => {
  const ctx = fixture({ answer: 'once' });
  assert.match(await ctx.run('f(){ "$1" "$2"; }'), /\[exit 0\]$/);
  assert.equal(ctx.questions.length, 1);
  assert.equal(await ctx.run('f echo FIRST'), 'FIRST\n[exit 0]');
  assert.equal(await ctx.run('f echo SECOND'), 'SECOND\n[exit 0]');
  assert.equal(ctx.questions.length, 3, 'each dynamic invocation retains its approval requirement');
});


for (const [name, body] of [
  ['variable', 'git push "$FLAG" origin main'],
  ['env', 'env git push "$FLAG" origin main'],
  ['timeout', 'timeout 1 git push "$FLAG" origin main'],
  ['xargs', "printf '%s' --force | xargs -n1 git push origin main"],
  ['find', "find . -type f -exec git push \"$FLAG\" origin main ';'"],
  ['substitution', 'printf "%s" "$(git push "$FLAG" origin main)"'],
  ['loop', 'for x in one two; do git push "$FLAG" origin main; done'],
]) test(`Anvil expanded critical guard survives ${name} dispatch`, async () => {
  const ctx = fixture({ answer: 'once', extraScopes: ['git:push'] });
  await ctx.fs.write('fixture', 'unchanged');
  const dispatched = [];
  ctx.git.push = async (args) => { dispatched.push(args); return { ok: true }; };
  const output = await ctx.run('FLAG=--force; ' + body + '; printf BAD > after-critical');
  assert.match(output, /whatever it was asked/);
  assert.match(output, /\[exit 126\]$/);
  assert.deepEqual(dispatched, []);
  assert.equal((await ctx.fs.stat('after-critical')).ok, false);
  assert.equal((await ctx.fs.read('fixture', { encoding: 'utf-8' })).data, 'unchanged');
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
});


for (const command of ['FLAGS=-rf; rm "$FLAGS" ""', 'FLAGS=-rf; fs.remove "$FLAGS" --path=/']) {
  test(`Anvil critical root guard uses resolved registry path forms: ${command}`, async () => {
    const ctx = fixture({ answer: 'once' });
    await ctx.fs.write('keep', 'unchanged');
    const output = await ctx.run(command + '; printf BAD > after-critical');
    assert.match(output, /whatever it was asked/);
    assert.match(output, /\[exit 126\]$/);
    assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
    assert.equal((await ctx.fs.stat('after-critical')).ok, false);
    assert.deepEqual(ctx.face.pendingProposals(), []);
    assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
  });
}


for (const permissionMode of ['default', 'bypass']) test(`Anvil recognizes root operands after -- in ${permissionMode} mode`, async () => {
  const ctx = fixture({ permissionMode, permissionRules: { allow: ['Bash(*)'] }, answer: 'always' });
  await ctx.fs.write('keep', 'unchanged');
  const output = await ctx.run('rm -rf -- /; printf BAD > after-critical');
  assert.match(output, /Refused/);
  assert.deepEqual(ctx.feeds, [], 'static refusal occurs before the shell executes');
  assert.deepEqual(ctx.questions, [], 'critical refusal has no override');
  assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
  assert.equal((await ctx.fs.stat('after-critical')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
});

test('Anvil runtime critical guard retains root operands after -- with dynamic flags', async () => {
  const ctx = fixture({ answer: 'once' });
  await ctx.fs.write('keep', 'unchanged');
  const invoke = ctx.face.invoke; let removals = 0;
  ctx.face.invoke = (name, args) => { if (name === 'fs.remove') removals++; return invoke(name, args); };
  const output = await ctx.run('FLAGS=-rf; rm "$FLAGS" -- /; printf BAD > after-critical');
  assert.match(output, /whatever it was asked/);
  assert.match(output, /\[exit 126\]$/);
  assert.equal(removals, 0, 'no remove operation reaches the governed face');
  assert.equal((await ctx.fs.read('keep', { encoding: 'utf-8' })).data, 'unchanged');
  assert.equal((await ctx.fs.stat('after-critical')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
});
