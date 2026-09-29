// B08 public harness. Imported only by the independently authored focused suites.
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

export const encode = (value) => new TextEncoder().encode(value);
export const decode = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
export const bytesOf = (value) => Array.from(typeof value === 'string' ? encode(value) : value);
export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
export function fresh({ backend = new MemoryBackend(), scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], readOnlyPrefixes = [], stageWrites = false, beforeOperation, ...shellOptions } = {}) {
  const fs = createFileops({ backend }), base = buildRigRegistry({ fs });
  const registry = stageWrites || beforeOperation ? createRegistry(base.commands.map((command) => ({ ...command,
    ...(stageWrites && command.name === 'fs.write' ? { destructive: true } : {}),
    ...(beforeOperation ? { run: async (input, context) => {
      await beforeOperation(command.name, input); return command.run(input, context);
    } } : {}),
  }))) : base;
  const face = createAgentFace({ registry, grant: createGrant({ scopes, prefixes, readOnlyPrefixes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'u3-independent-verifier' });
  const shell = createShell({ registry, face, ...shellOptions });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const bytes = async (path) => { const result = await fs.read(path); assert.equal(result.ok, true, result.message); return bytesOf(result.data); };
  const read = async (path) => decode(Uint8Array.from(await bytes(path)));
  return { backend, fs, registry, face, shell, run, bytes, read };
}
export async function seed(ctx, entries) {
  for (const [path, data] of Object.entries(entries)) assert.equal((await ctx.fs.write(path, data, { createParents: true })).ok, true);
}
export async function expect(ctx, command, stdout, code = 0, stderr = '') {
  const result = await ctx.run(command);
  assert.equal(result.code, code, `${command}: ${result.output}`);
  assert.deepEqual(bytesOf(result.stdout), bytesOf(stdout), `${command}: stdout`);
  assert.deepEqual(bytesOf(result.stderr), bytesOf(stderr), `${command}: stderr`);
  return result;
}
export async function absent(ctx, ...paths) {
  for (const path of paths) assert.equal((await ctx.fs.stat(path)).code, 'ENOENT', `${path} must not exist`);
}
export async function accept(ctx, command) {
  let result = await ctx.run(command), count = 0;
  while (result.awaitingConfirm) { assert.ok(++count <= 32, 'bounded number of confirmations'); result = await ctx.run('y'); }
  return result;
}
