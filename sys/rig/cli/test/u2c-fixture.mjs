import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createIO } from '../io.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

export const encode = (value) => new TextEncoder().encode(value);
export const decode = (value) => typeof value === 'string' ? value : new TextDecoder().decode(value);
export const names = ['base64', 'base32', 'basenc', 'md5sum', 'sha1sum', 'sha224sum', 'sha256sum', 'sha384sum', 'sha512sum', 'b2sum', 'cksum', 'sum'];
export function fresh({ backend = new MemoryBackend(), scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''], readOnlyPrefixes = [], stageWrites = false, beforeOperation } = {}) {
  const fs = createFileops({ backend }), base = buildRigRegistry({ fs });
  const registry = stageWrites || beforeOperation ? createRegistry(base.commands.map((command) => ({
    ...command,
    ...(stageWrites && command.name === 'fs.write' ? { destructive: true } : {}),
    ...(beforeOperation ? { run: async (input, context) => {
      await beforeOperation(command.name, input, { backend, fs }); return command.run(input, context);
    } } : {}),
  }))) : base;
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant: createGrant({ scopes, prefixes, readOnlyPrefixes }), opLog, actor: 'u2c-independent' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const bytes = async (path) => { const result = await fs.read(path); assert.equal(result.ok, true, result.message); return Array.from(result.data); };
  const read = async (path) => { const result = await fs.read(path, { encoding: 'utf-8' }); assert.equal(result.ok, true, result.message); return result.data; };
  const io = createIO({ invoke: (name, input) => face.invoke(name, input) });
  return { backend, fs, registry, face, shell, opLog, run, bytes, read, io };
}
export async function seed(ctx, entries) {
  for (const [path, data] of Object.entries(entries)) assert.equal((await ctx.fs.write(path, data, { createParents: true })).ok, true);
}
export async function output(ctx, command, expected) {
  const result = await ctx.run(`${command} > /captured`); assert.equal(result.code, 0, `${command}: ${result.output}`);
  assert.deepEqual(await ctx.bytes('captured'), Array.from(typeof expected === 'string' ? encode(expected) : expected), command);
}
export function observeReads(ctx) {
  const paths = [], original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (path, options) => { paths.push(path); return original(path, options); };
  return paths;
}
export async function accept(ctx, command) {
  let result = await ctx.run(command), count = 0;
  while (result.awaitingConfirm) { assert.ok(++count <= 32); result = await ctx.run('y'); }
  return result;
}
