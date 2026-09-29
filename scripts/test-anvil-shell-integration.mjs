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
import { gateAction, gateEvent } from '../sys/ai/action-gate.mjs';
import { applyPolicy, grant as policyGrant, POLICY_HINT } from '../sys/ai/action-policy.mjs';
import { decideByRules, applyMode } from '../sys/ai/permission-rules.mjs';
import { explainSkillsRefusal } from '../sys/ai/skills.mjs';
import { explainGateRefusal } from '../sys/ai/gate.mjs';

const source = await inlineModule();
const executorSource = extractFunction(source, 'executeTool');
const stopSource = extractFunction(source, 'stopRun');
const gateHintSource = extractFunction(source, 'gateHint');

function fixture({ hooksCfg = { preTool: [], postTool: [] }, permissionRules = {}, permissionMode = 'bypass', answer = 'no' } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const registry = buildRigRegistry({ fs, git });
  const face = createAgentFace({ registry,
    grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const t = { id: 'shell-integration', verifyCmd: '', log: [], convo: [{ role: 'user', content: 'Inspect the fixture workspace.' }] };
  const state = { permissionRules, permissionMode, policy: {} };
  const system = [], questions = [], events = [];
  const runtime = evaluate(`
    let abortController = new AbortController();
    const shell = createShell({ registry, face, signal: () => abortController.signal });
    const baseExec = makeToolExecutor({ shell, face, mode });
    ${gateHintSource}
    ${executorSource}
    ${stopSource}
    ({ executeTool, stopRun, shell,
       nextRun: () => { abortController = new AbortController(); },
       isAborted: () => abortController.signal.aborted });
  `, {
    AbortController, createShell, makeToolExecutor, registry, face, fs, mode: 'code', t, state, hooksCfg,
    preHookReply, postHookNotes, gateAction, gateEvent, applyPolicy, policyGrant, POLICY_HINT,
    decideByRules, applyMode, explainSkillsRefusal, explainGateRefusal,
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
  const output = await ctx.run('sed -i s/a/b/ file');
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
  assert.equal(output, 'MAIN\n[exit 0]\n[hook] echo POST > hook-file; cat hook-file\nPOST');
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
