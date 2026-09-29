import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { createGitCore } from '../../git/git-core.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';
import { createShell } from '../shell.mjs';
import { makeToolExecutor } from '../../../ai/agent-tools.mjs';

async function fixture({ files = { file: 'committed' }, scopes, readOnlyPrefixes = [] } = {}) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const git = createGitCore({ fs, dir: '/' });
  await git.init();
  for (const [filepath, data] of Object.entries(files)) {
    await fs.write(filepath, data, { createParents: true });
    await git.add({ filepath });
  }
  await git.commit({ message: 'fixture', actor: 'agent' });
  const registry = buildRigRegistry({ fs, git });
  const face = createAgentFace({ registry,
    grant: createGrant({ prefixes: [''], readOnlyPrefixes,
      scopes: scopes || ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  const exec = makeToolExecutor({ shell, face });
  const content = async (path = 'file') => {
    const result = await fs.read(path, { encoding: 'utf-8' });
    return result.ok ? result.data : null;
  };
  const rows = async () => (await git.statusMatrix()).matrix;
  return { fs, git, face, shell, exec, content, rows };
}

async function change(ctx, kind) {
  if (kind === 'clean') return;
  if (kind === 'dirty') { await ctx.fs.write('file', 'working edit'); return; }
  if (kind === 'new') {
    await ctx.fs.write('new', 'new content');
    await ctx.git.add({ filepath: 'new' });
    return;
  }
  await ctx.fs.write('file', 'staged edit');
  await ctx.git.add({ filepath: 'file' });
  if (kind === 'both') await ctx.fs.write('file', 'later working edit');
  if (kind === 'restored') await ctx.fs.write('file', 'committed');
  if (kind === 'staged-missing') await ctx.fs.remove('file');
}

test('git rm through the agent refuses uncommitted work and staged content without changing any file or index entry', async (t) => {
  for (const kind of ['dirty', 'staged', 'both', 'restored', 'new']) {
    await t.test(kind, async () => {
      const ctx = await fixture();
      await change(ctx, kind);
      const path = kind === 'new' ? 'new' : 'file';
      const before = await ctx.rows(), bytes = await ctx.content(path);
      const output = await ctx.exec('shell', { command: `git rm ${path}` });
      assert.match(output, /\[exit 1\]$/);
      assert.match(output, /local modifications|staged/);
      assert.doesNotMatch(output, /^confirmed:/m);
      assert.equal(await ctx.content(path), bytes);
      assert.deepEqual(await ctx.rows(), before);
      assert.deepEqual(ctx.face.pendingProposals(), []);
      assert.equal(ctx.shell.awaitingConfirm, null);
    });
  }
});

test('git rm stages clean removal and preserves it when the owner declines', async () => {
  const ctx = await fixture();
  const before = await ctx.rows();
  const pending = await ctx.shell.feed('git rm file');
  assert.ok(pending.awaitingConfirm);
  assert.equal(await ctx.content(), 'committed');
  assert.deepEqual(await ctx.rows(), before);
  const refused = await ctx.shell.feed('n');
  assert.match(refused.output, /cancelled:/);
  assert.equal(ctx.shell.lastCode, 1);
  assert.equal(await ctx.content(), 'committed');
  assert.deepEqual(await ctx.rows(), before);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  const accepted = await ctx.exec('shell', { command: 'git rm file' });
  assert.match(accepted, /^confirmed:/m);
  assert.match(accepted, /\[exit 0\]$/);
  assert.equal(await ctx.content(), null);
  assert.deepEqual(await ctx.rows(), [['file', 1, 0, 0]]);
});

test('git rm --cached removes only index content preserved in HEAD or the working tree', async (t) => {
  for (const kind of ['clean', 'dirty', 'staged', 'new']) {
    await t.test(kind, async () => {
      const ctx = await fixture();
      await change(ctx, kind);
      const path = kind === 'new' ? 'new' : 'file';
      const bytes = await ctx.content(path);
      const output = await ctx.exec('shell', { command: `git rm --cached ${path}` });
      assert.match(output, /\[exit 0\]$/);
      assert.equal(await ctx.content(path), bytes, 'the worktree copy survives exactly');
      assert.equal((await ctx.rows()).find(([name]) => name === path)[3], 0, 'only the index entry is removed');
      assert.deepEqual(ctx.face.pendingProposals(), []);
    });
  }
  for (const kind of ['both', 'restored', 'staged-missing']) {
    await t.test(`refuses ${kind}`, async () => {
      const ctx = await fixture();
      await change(ctx, kind);
      const before = await ctx.rows(), bytes = await ctx.content();
      const output = await ctx.exec('shell', { command: 'git rm --cached file' });
      assert.match(output, /staged content differs from both/);
      assert.match(output, /\[exit 1\]$/);
      assert.equal(await ctx.content(), bytes);
      assert.deepEqual(await ctx.rows(), before);
      assert.deepEqual(ctx.face.pendingProposals(), []);
    });
  }
});

test('git rm -f overrides content checks but still goes through destructive confirmation', async (t) => {
  for (const kind of ['dirty', 'staged', 'both', 'restored', 'new']) {
    await t.test(kind, async () => {
      const ctx = await fixture();
      await change(ctx, kind);
      const path = kind === 'new' ? 'new' : 'file';
      const bytes = await ctx.content(path);
      const staged = await ctx.shell.feed(`git rm -f ${path}`);
      assert.ok(staged.awaitingConfirm, 'force does not bypass the governed confirmation');
      assert.equal(await ctx.content(path), bytes);
      const accepted = await ctx.shell.feed('y');
      assert.equal(accepted.confirmation.ok, true);
      assert.equal(ctx.shell.lastCode, 0);
      assert.equal(await ctx.content(path), null);
      assert.equal((await ctx.rows()).find(([name]) => name === path)?.[3] || 0, 0);
      assert.deepEqual(ctx.face.pendingProposals(), []);
    });
  }
  await t.test('--cached -f preserves the later working copy', async () => {
    const ctx = await fixture();
    await change(ctx, 'both');
    const output = await ctx.exec('shell', { command: 'git rm --cached --force file' });
    assert.match(output, /\[exit 0\]$/);
    assert.equal(await ctx.content(), 'later working edit');
    assert.equal((await ctx.rows())[0][3], 0);
  });
});

test('git rm accepts files already removed from the working tree', async () => {
  const ctx = await fixture();
  await ctx.fs.remove('file');
  const output = await ctx.exec('shell', { command: 'git rm file' });
  assert.match(output, /\[exit 0\]$/);
  assert.deepEqual(await ctx.rows(), [['file', 1, 0, 0]]);
});

test('git rm preflights every target before removing an earlier clean target', async (t) => {
  for (const command of ['git rm a b', 'git rm -r folder', 'git rm a missing']) {
    await t.test(command, async () => {
      const ctx = await fixture({ files: { a: 'clean', b: 'before', 'folder/a': 'clean', 'folder/b': 'before' } });
      await ctx.fs.write('b', 'uncommitted');
      await ctx.fs.write('folder/b', 'uncommitted');
      const before = await ctx.rows();
      const output = await ctx.exec('shell', { command });
      assert.match(output, /\[exit 1\]$/);
      assert.equal(await ctx.content('a'), 'clean');
      assert.equal(await ctx.content('folder/a'), 'clean');
      assert.equal(await ctx.content('b'), 'uncommitted');
      assert.deepEqual(await ctx.rows(), before);
      assert.deepEqual(ctx.face.pendingProposals(), []);
    });
  }
});

test('git rm preflights grants before accepting any index or working-tree deletion', async (t) => {
  for (const options of [
    { scopes: ['fs:read', 'fs:write', 'git:read', 'git:write'] },
    { readOnlyPrefixes: ['b'] },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const ctx = await fixture({ ...options, files: { a: 'first', b: 'second' } });
      const before = await ctx.rows();
      const output = await ctx.exec('shell', { command: 'git rm -f a b' });
      assert.match(output, /EGRANT/);
      assert.match(output, /\[exit 1\]$/);
      assert.equal(await ctx.content('a'), 'first');
      assert.equal(await ctx.content('b'), 'second');
      assert.deepEqual(await ctx.rows(), before, 'no allowed index deletion precedes a denied operation');
      assert.deepEqual(ctx.face.pendingProposals(), []);
      assert.equal(ctx.shell.awaitingConfirm, null);
    });
  }
});
