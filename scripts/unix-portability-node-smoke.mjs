// B13 independent execution child. Do not execute before the whole-build release.
// Permanent destination: scripts/unix-portability-node-smoke.mjs.
// Application modules come only from an extracted, independently checked Git pin.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync, gunzipSync } from 'node:zlib';
import { webcrypto } from 'node:crypto';

assert.equal(process.argv.length, 4, 'expected extracted root and manifest path');
const root = resolve(process.argv[2]);
const manifest = JSON.parse(await readFile(process.argv[3], 'utf8'));
const removed = [
  'window', 'document', 'navigator', 'self', 'location', 'localStorage', 'sessionStorage',
  'indexedDB', 'caches', 'Worker', 'SharedWorker', 'ServiceWorker', 'XMLHttpRequest',
  'WebSocket', 'EventSource', 'WebTransport', 'fetch', 'Request', 'importScripts',
];
for (const name of removed) {
  assert.ok(Reflect.deleteProperty(globalThis, name), `can remove ${name}`);
}
// Node crypto and web-standard byte/stream primitives remain host capabilities.
if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const checks = [], imported = [], namespaces = new Map();
function absentGlobals() {
  for (const name of removed) {
    assert.equal(name in globalThis, false, `${name} is absent`);
    assert.equal(typeof globalThis[name], 'undefined', `${name} has no fallback`);
  }
}
absentGlobals(); checks.push('browser-globals-absent');
for (const row of manifest.modules) {
  const absolute = resolve(root, row.path), local = relative(root, absolute);
  assert.ok(local && !local.startsWith('..') && !isAbsolute(local), 'imports remain inside extracted root');
  namespaces.set(row.path, await import(pathToFileURL(absolute).href));
  imported.push(row.path);
}
checks.push('imports');
const { createShell } = namespaces.get('sys/rig/cli/shell.mjs');
const { createFileops, MemoryBackend } = namespaces.get('sys/rig/fileops/index.mjs');
const { buildRigRegistry } = namespaces.get('sys/rig/registry/index.mjs');
const { createGrant, createOpLog, createAgentFace } = namespaces.get('sys/rig/agent/index.mjs');
const { createGitCore } = namespaces.get('sys/rig/git/git-core.mjs');
for (const factory of [createShell, createFileops, MemoryBackend, buildRigRegistry, createGrant, createOpLog, createAgentFace, createGitCore]) {
  assert.equal(typeof factory, 'function', 'promised factory is available');
}

const bytes = (value) => Array.from(typeof value === 'string' ? new TextEncoder().encode(value) : value);
const text = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
const binary = Uint8Array.of(0, 255, 128, 13, 10, 27, 65, 0, 254);
const secret = 'B13 private bytes: never emitted';
function snapshot(backend) {
  return {
    files: [...backend.files].map(([name, entry]) => [name, { bytes: bytes(entry.bytes), mtimeMs: entry.mtimeMs }]),
    dirs: [...backend.dirs], symlinks: [...backend.symlinks],
  };
}
function fixture({ prefixes = ['allowed'], gitEnabled = false } = {}) {
  const backend = new MemoryBackend(), effects = [];
  const observed = new Proxy(backend, { get(target, name) {
    const value = Reflect.get(target, name);
    return typeof value !== 'function' ? value : (...args) => {
      effects.push([String(name), args[0]]);
      return Reflect.apply(value, target, args);
    };
  } });
  const fs = createFileops({ backend: observed });
  const git = gitEnabled ? createGitCore({ fs, dir: '/' }) : undefined;
  const registry = buildRigRegistry({ fs, git });
  const grant = createGrant({ prefixes, scopes: ['fs:read', 'fs:write', 'fs:remove', 'git:read', 'git:write'] });
  const face = createAgentFace({ registry, grant,
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'b13-independent-verifier' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const seed = async (name, value) => assert.equal((await fs.write(name, value, { createParents: true })).ok, true);
  const file = async (name) => {
    const result = await fs.read(name);
    assert.equal(result.ok, true, result.message);
    return bytes(result.data);
  };
  return { backend, effects, fs, git, registry, grant, face, shell, run, seed, file };
}
async function okay(ctx, command, stdout) {
  const result = await ctx.run(command);
  assert.equal(result.code, 0, `${command}: ${text(result.stderr)}`);
  assert.deepEqual(bytes(result.stderr), [], `${command}: empty stderr`);
  assert.ok(!result.awaitingConfirm, `${command}: no unexpected confirmation`);
  if (stdout !== undefined) assert.deepEqual(bytes(result.stdout), bytes(stdout), `${command}: exact stdout bytes`);
  return result;
}

const ctx = fixture();
await ctx.seed('allowed/payload', binary);
await ctx.seed('allowed/external.gz', gzipSync(binary));
await ctx.seed('allowed/data.yaml', 'name: portable\nvalues: [1, 2]\n');
await ctx.seed('private/secret', secret);
await okay(ctx, 'for x in one two; do printf "%s:" "$x"; done; printf "%s\\n" "$(printf tail)"', 'one:two:tail\n');
checks.push('language');
await okay(ctx, 'cat allowed/payload | base64', Buffer.from(binary).toString('base64') + '\n');
await okay(ctx, 'cat allowed/payload | base64 | base64 -d', binary);
checks.push('binary-streams');
const compressed = await okay(ctx, 'gzip -c allowed/payload');
assert.deepEqual(bytes(gunzipSync(Uint8Array.from(bytes(compressed.stdout)))), bytes(binary));
await okay(ctx, 'gunzip -c allowed/external.gz', binary);
checks.push('gzip-interoperability');
await okay(ctx, 'mkdir allowed/out', '');
await okay(ctx, 'tar -cf allowed/bundle.tar -C allowed payload', '');
await okay(ctx, 'tar -tf allowed/bundle.tar', 'payload\n');
await okay(ctx, 'tar -xf allowed/bundle.tar -C allowed/out', '');
assert.deepEqual(await ctx.file('allowed/out/payload'), bytes(binary));
checks.push('tar-bytes');
await okay(ctx, 'yq -jc . allowed/data.yaml | jq -c .values', '[1,2]\n');
checks.push('yaml-json-vendor');

// Calibrate the observer using a permitted read before relying on its absence.
ctx.effects.length = 0;
await okay(ctx, 'cat allowed/payload', binary);
assert.ok(ctx.effects.some(([method, name]) => method === 'readBinary' && name === 'allowed/payload'));
for (const command of ['cat private/secret', 'printf changed > private/secret', 'rm private/secret']) {
  const before = snapshot(ctx.backend);
  ctx.effects.length = 0;
  const denied = await ctx.run(command);
  assert.notEqual(denied.code, 0, `${command}: denied status`);
  assert.deepEqual(bytes(denied.stdout), [], `${command}: no data leakage`);
  assert.match(text(denied.stderr), /EGRANT|outside grant|not granted/i, `${command}: governed diagnostic`);
  assert.equal(denied.output.includes(secret), false);
  assert.ok(!denied.awaitingConfirm);
  assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.deepEqual(ctx.effects, [], `${command}: no backend read, metadata or mutation`);
  assert.deepEqual(snapshot(ctx.backend), before, `${command}: all authoritative bytes and metadata stay unchanged`);
}
checks.push('grant-refusal');
await ctx.seed('allowed/victim', binary);
const staged = await ctx.run('rm allowed/victim');
assert.ok(staged.awaitingConfirm);
assert.deepEqual(await ctx.file('allowed/victim'), bytes(binary));
assert.equal(ctx.face.pendingProposals().length, 1);
const rejected = await ctx.run('n');
assert.notEqual(rejected.code, 0);
assert.deepEqual(await ctx.file('allowed/victim'), bytes(binary));
assert.deepEqual(ctx.face.pendingProposals(), []);
assert.equal(ctx.shell.awaitingConfirm, null);
await okay(ctx, 'printf recovered', 'recovered');
checks.push('staging');

// Real bundled isomorphic-git, real fileops adapter, real registry and grant face.
const gitCtx = fixture({ prefixes: [''], gitEnabled: true });
await gitCtx.seed('payload', binary);
await okay(gitCtx, 'git init');
await okay(gitCtx, 'git add payload');
const commitPrompt = await gitCtx.run('git commit -m portability');
assert.ok(commitPrompt.awaitingConfirm, 'git commit retains governed staging');
assert.equal(gitCtx.face.pendingProposals().length, 1);
const committed = await gitCtx.run('y');
assert.equal(committed.code, 0, text(committed.stderr));
assert.deepEqual(bytes(committed.stderr), []);
assert.deepEqual(gitCtx.face.pendingProposals(), []);
assert.equal(gitCtx.shell.awaitingConfirm, null);
const history = await gitCtx.git.log({ depth: 1 });
assert.equal(history.ok, true);
assert.equal(history.commits.length, 1);
assert.equal(history.commits[0].commit.author.email, 'agent@rig.local');
assert.match(history.commits[0].commit.message, /^portability\n/);
const stored = await gitCtx.git.readBlob({ filepath: 'payload', ref: 'HEAD' });
assert.equal(stored.ok, true);
assert.deepEqual(bytes(stored.data), bytes(binary), 'committed blob preserves all bytes');
assert.deepEqual((await gitCtx.git.statusMatrix()).matrix, [['payload', 1, 1, 1]]);
await okay(gitCtx, 'git log -1 --oneline');
checks.push('real-git');

for (const [command, reason] of [
  ['python -c "print(1)"', /Kiln|kernel/i],
  ['sqlite3 :memory: "SELECT 1"', /Kiln|runtime/i],
  ['node -e "console.log(1)"', /JS|runner/i],
]) {
  const unavailable = await ctx.run(command);
  assert.notEqual(unavailable.code, 0, `${command}: absent optional runtime refuses`);
  assert.deepEqual(bytes(unavailable.stdout), []);
  assert.match(text(unavailable.stderr), reason);
  assert.match(text(unavailable.stderr), /unavailable|not available|requires|needs/i);
  assert.ok(!unavailable.awaitingConfirm);
  assert.deepEqual(ctx.face.pendingProposals(), []);
}
checks.push('optional-runtime-refusal');
absentGlobals(); checks.push('browser-globals-still-absent');
process.stdout.write(JSON.stringify({ ok: true, sourceCommit: manifest.source.commit, imported, checks }) + '\n');
