// INERT B12 PLANNING DRAFT. Do not execute, import, or syntax-check before whole-build release.
// Proposed promotion: scripts/test-anvil-unix-integration.mjs. Relative imports target that location.
// Ten additional cases supplement the existing 27 actual-Anvil integration cases.
// Execute actual extracted handlers, public tool executor, real registry, grants, shell, and MemoryBackend.
// UI edges alone are stubbed. stageWrites changes operation metadata without replacing execution.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inlineModule, extractFunction, evaluate } from './anvil-harness.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { createGitCore } from '../sys/rig/git/git-core.mjs';
import { buildRigRegistry, createRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';
import { makeToolExecutor } from '../sys/ai/agent-tools.mjs';
import { preHookReply, postHookNotes } from '../sys/ai/run-assembly.mjs';
import { gateAction, gateEvent, guardCriticalShellInvocation } from '../sys/ai/action-gate.mjs';
import { applyPolicy, grant as policyGrant, POLICY_HINT } from '../sys/ai/action-policy.mjs';
import { withShellContext, decideByRules, applyMode } from '../sys/ai/permission-rules.mjs';
import { SKILLS_DIR, explainSkillsRefusal } from '../sys/ai/skills.mjs';
import { GATE_DIR, explainGateRefusal } from '../sys/ai/gate.mjs';

const source = await inlineModule();
const executorSource = extractFunction(source, 'executeTool');
const stopSource = extractFunction(source, 'stopRun');
const gateHintSource = extractFunction(source, 'gateHint');
const declaration = (prefix) => {
  const line = source.split('\n').find((entry) => entry.trimStart().startsWith(prefix));
  assert.ok(line, `extract actual Anvil declaration: ${prefix}`);
  return line;
};
const agentShellSource = declaration('const agentShell = () => createShell(');
const grantSource = [declaration('const SEARCH_INDEX_PATH ='), declaration('const AGENT_SCOPES ='),
  declaration('const agentGrant =')].join('\n');

function fixture({ hooksCfg = { preTool: [], postTool: [] }, permissionRules = {},
  permissionMode = 'bypass', answer = 'once', prefixes, scopes, stageWrites = false } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  const base = buildRigRegistry({ fs, git });
  const registry = stageWrites ? createRegistry(base.commands.map((command) =>
    command.name === 'fs.write' ? { ...command, destructive: true } : command)) : base;
  const appGrant = evaluate(`${grantSource}\nagentGrant(scopes);`, { createGrant, SKILLS_DIR, GATE_DIR, scopes });
  const grant = prefixes ? createGrant({ ...appGrant.describe(), prefixes }) : appGrant;
  const face = createAgentFace({ registry, grant,
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'b12-independent-verifier' });
  const t = { id: 'unix-integration', verifyCmd: '', log: [],
    convo: [{ role: 'user', content: 'Edit and inspect the disposable fixture workspace.' }] };
  const state = { permissionRules, permissionMode, policy: {} };
  const system = [], questions = [], events = [], feeds = [], results = [];
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
    preHookReply, postHookNotes, gateAction, gateEvent, guardCriticalShellInvocation, applyPolicy, policyGrant, POLICY_HINT,
    withShellContext, decideByRules, applyMode, explainSkillsRefusal, explainGateRefusal,
    kilnRef: null, jsHost: null,
    runCtx: { t, messages: t.convo, rec: { onEvent: (event) => events.push(event) } },
    pushSystem: (text) => system.push(text),
    askChoice: async (question) => { questions.push(question); return answer; },
    renderLog() {}, renderFiles() {}, save() {},
  });
  const feed = runtime.shell.feed;
  runtime.shell.feed = async (line) => {
    feeds.push(line);
    const result = await feed(line);
    results.push(result);
    return result;
  };
  let calls = 0;
  const run = (command, args = {}) => runtime.executeTool('shell', { ...args, command }, { id: `b12-${++calls}` });
  const read = async (path) => {
    const result = await fs.read(path, { encoding: 'utf-8' });
    assert.equal(result.ok, true, `${path}: ${result.error || result.message || ''}`);
    return result.data;
  };
  const bytes = async (path) => {
    const result = await fs.read(path);
    assert.equal(result.ok, true, path);
    return Array.from(result.data);
  };
  return { ...runtime, fs, git, face, grant, state, t, system, questions, events, feeds, results, run, read, bytes };
}

const decode = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
const settled = (ctx) => {
  assert.equal(ctx.shell.awaitingConfirm, null);
  assert.deepEqual(ctx.face.pendingProposals(), []);
};
const seed = async (ctx, path, content) => assert.equal((await ctx.fs.write(path, content, { createParents: true })).ok, true);

test('B12 Anvil executes sed -i with backup bytes and grades the fresh exit after an earlier failure', async () => {
  const ctx = fixture();
  await seed(ctx, 'input', 'old\n');
  assert.match(await ctx.run('unknown-command'), /\[exit 127\]$/);
  const command = "sed -i.bak 's/old/new/' input";
  const output = await ctx.run(command, { expect: 'exit 0' });
  assert.ok(ctx.feeds.includes(command), 'the command reaches the real shell');
  assert.equal(await ctx.read('input'), 'new\n');
  assert.equal(await ctx.read('input.bak'), 'old\n');
  assert.equal(ctx.shell.lastCode, 0);
  assert.match(output, /\[exit 0\]\n\[expect\] VACUOUS \(exit 0\)/);
  assert.doesNotMatch(output, /Use the `edit` tool/);
  settled(ctx);
});

test('B12 Anvil executes recursive grep with hit, miss, error streams, and actual prediction grades', async () => {
  const ctx = fixture();
  await seed(ctx, 'tree/deep/file', 'needle\n');
  for (const option of ['-r', '-R']) {
    const command = `grep ${option} needle tree`;
    const output = await ctx.run(command, { expect: 'contains needle' });
    assert.ok(ctx.feeds.includes(command));
    assert.match(output, /tree\/deep\/file:needle/);
    assert.match(output, /\[exit 0\]\n\[expect\] MET \(contains needle\)/);
    assert.equal(decode(ctx.results.at(-1).stderr), '');
  }
  const miss = await ctx.run('grep -r absent tree', { expect: 'exit 1' });
  assert.match(miss, /\[exit 1\]\n\[expect\] MET \(exit 1\)/);
  assert.equal(decode(ctx.results.at(-1).stdout), '');
  const failure = await ctx.run('grep -r needle missing');
  assert.equal(ctx.shell.lastCode, 2);
  assert.match(failure, /\[exit 2\]$/);
  assert.ok(decode(ctx.results.at(-1).stderr).length > 0, 'real stderr survives the wrapper');
  assert.equal(await ctx.read('tree/deep/file'), 'needle\n');
  settled(ctx);
});

test('B12 Anvil executes empty cat redirection and quoted heredoc append without changing literal bytes', async () => {
  const ctx = fixture();
  await seed(ctx, 'empty', 'replace me');
  const empty = await ctx.run('cat > empty');
  assert.match(empty, /\[exit 0\]$/);
  assert.equal(await ctx.read('empty'), '');
  const command = "cat <<'EOF' > literal\n$HOME `echo bad` $(echo bad)\nEOF\ncat <<'EOF' >> literal\nsecond\nEOF";
  assert.match(await ctx.run(command), /\[exit 0\]$/);
  assert.ok(ctx.feeds.includes(command));
  assert.equal(await ctx.read('literal'), '$HOME `echo bad` $(echo bad)\nsecond\n');
  settled(ctx);
});

test('B12 Anvil preserves loop, substitution, and find-exec execution through the public wrapper', async () => {
  const ctx = fixture();
  await seed(ctx, 'src/one', 'old-one\n');
  await seed(ctx, 'src/two', 'old-two\n');
  const command = "for f in one two; do printf '%s\\n' \"$(cat src/$f)\" >> combined; done; find src -type f -exec sed -i 's/old/new/g' {} \\;";
  assert.match(await ctx.run(command), /\[exit 0\]$/);
  assert.ok(ctx.feeds.includes(command));
  assert.equal(await ctx.read('combined'), 'old-one\nold-two\n');
  assert.equal(await ctx.read('src/one'), 'new-one\n');
  assert.equal(await ctx.read('src/two'), 'new-two\n');
  settled(ctx);
});

test('B12 Anvil completes a real tar and gzip binary round trip', async () => {
  const ctx = fixture();
  const binary = Uint8Array.from([0, 255, 128, 10, 13, 65, 0, 66]);
  await seed(ctx, 'source/binary', binary);
  const command = 'tar -cf bundle.tar source; gzip -c bundle.tar > bundle.tar.gz; gunzip -c bundle.tar.gz > decoded.tar; mkdir out; tar -xf decoded.tar -C out';
  assert.match(await ctx.run(command), /\[exit 0\]$/);
  assert.deepEqual(await ctx.bytes('out/source/binary'), Array.from(binary));
  assert.deepEqual(await ctx.bytes('source/binary'), Array.from(binary));
  assert.deepEqual(await ctx.bytes('decoded.tar'), await ctx.bytes('bundle.tar'));
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
  settled(ctx);
});

test('B12 Anvil pre-hooks block supported edits and post-hooks read the actual edited file', async () => {
  const ctx = fixture({ hooksCfg: {
    preTool: [{ on: 'shell', commandMatch: 'sed -i s/old/blocked/', block: 'Keep this fixture unchanged.' }],
    postTool: [{ on: 'shell', commandMatch: 'sed -i s/old/new/', run: 'cat input' }],
  } });
  await seed(ctx, 'input', 'old\n');
  assert.equal(await ctx.run('sed -i s/old/blocked/ input'), '[blocked by a project hook] Keep this fixture unchanged.');
  assert.deepEqual(ctx.feeds, []);
  assert.equal(await ctx.read('input'), 'old\n');
  const output = await ctx.run('sed -i s/old/new/ input');
  assert.match(output, /\[exit 0\]\n\[hook\] cat input\nnew$/);
  assert.equal(await ctx.read('input'), 'new\n');
  settled(ctx);
});

test('B12 Anvil actual grant fences protect skills, gate criteria, and the search index from newly supported writes', async () => {
  const ctx = fixture();
  const targets = [`${SKILLS_DIR}/sample/SKILL.md`, `${GATE_DIR}/criterion`, '.anvil/search-index.json'];
  for (const path of targets) {
    await seed(ctx, path, 'old\n');
    const output = await ctx.run(`sed -i s/old/new/ ${path}`);
    assert.notEqual(ctx.shell.lastCode, 0, output);
    assert.match(output, /EGRANT|read.only|not granted|protected/i);
    assert.equal(await ctx.read(path), 'old\n');
    settled(ctx);
  }
  const heredoc = `cat <<'EOF' > ${GATE_DIR}/criterion\nnew\nEOF`;
  const output = await ctx.run(heredoc);
  assert.notEqual(ctx.shell.lastCode, 0, output);
  assert.equal(await ctx.read(`${GATE_DIR}/criterion`), 'old\n');
  settled(ctx);
});

test('B12 Anvil supported edits obey scoped grants and owner deny rules before mutation', async () => {
  const scoped = fixture({ prefixes: ['allowed'] });
  await seed(scoped, 'private/input', 'old\n');
  const denied = await scoped.run('sed -i s/old/new/ private/input');
  assert.notEqual(scoped.shell.lastCode, 0, denied);
  assert.equal(await scoped.read('private/input'), 'old\n');
  settled(scoped);
  const readOnly = fixture({ scopes: ['fs:read'] });
  await seed(readOnly, 'input', 'old\n');
  const write = await readOnly.run("cat <<'EOF' > input\nnew\nEOF");
  assert.notEqual(readOnly.shell.lastCode, 0, write);
  assert.equal(await readOnly.read('input'), 'old\n');
  settled(readOnly);
  const owner = fixture({ permissionRules: { deny: ['Bash(sed:*)'] } });
  await seed(owner, 'input', 'old\n');
  const output = await owner.run('sed -i s/old/new/ input');
  assert.match(output, /^Refused: .*deny rule/);
  assert.doesNotMatch(output, /\[exit |\[expect\]/);
  assert.deepEqual(owner.feeds, []);
  assert.equal(await owner.read('input'), 'old\n');
  settled(owner);
});

test('B12 Anvil drains backup and edit proposals with real receipts before an independent call', async () => {
  const ctx = fixture({ stageWrites: true });
  await seed(ctx, 'input', 'old\n');
  const feed = ctx.shell.feed, stages = [];
  ctx.shell.feed = async (line) => {
    const result = await feed(line);
    if (result.awaitingConfirm) stages.push({ input: await ctx.read('input'), backup: (await ctx.fs.stat('input.bak')).ok });
    return result;
  };
  const output = await ctx.run('sed -i.bak s/old/new/ input; echo FINISHED');
  assert.deepEqual(stages, [{ input: 'old\n', backup: false }, { input: 'old\n', backup: true }]);
  assert.equal((output.match(/^confirmed:/gm) || []).length, 2);
  assert.equal(ctx.feeds.filter((line) => line === 'y').length, 2);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.match(output, /FINISHED\n\[exit 0\]$/);
  assert.equal(await ctx.read('input'), 'new\n');
  assert.equal(await ctx.read('input.bak'), 'old\n');
  settled(ctx);
  assert.equal(await ctx.run('echo NEXT'), 'NEXT\n[exit 0]');
});

test('B12 actual Anvil Stop cancels a staged edit after its backup without consuming the next invocation', async () => {
  const ctx = fixture({ stageWrites: true });
  await seed(ctx, 'input', 'old\n');
  const feed = ctx.shell.feed;
  let stages = 0;
  ctx.shell.feed = async (line) => {
    const result = await feed(line);
    if (result.awaitingConfirm && ++stages === 2) ctx.stopRun();
    return result;
  };
  const output = await ctx.run('sed -i.bak s/old/new/ input; echo bad > after-stop');
  assert.equal(ctx.isAborted(), true);
  assert.deepEqual(ctx.system, ['Stopping…']);
  assert.equal((output.match(/^confirmed:/gm) || []).length, 1);
  assert.match(output, /interrupted/);
  assert.match(output, /\[exit 130\]$/);
  assert.doesNotMatch(output, /\[y\/N\]/);
  assert.equal(await ctx.read('input'), 'old\n');
  assert.equal(await ctx.read('input.bak'), 'old\n');
  assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  settled(ctx);
  ctx.nextRun();
  assert.equal(await ctx.run('cat input'), 'old\n[exit 0]');
});
