// Bounded archive primitives. All filesystem access is supplied by governed I/O.
import { ArgError } from '../args.mjs';
import { createU2Context, utf8Length } from './u2-common.mjs';
import { toBytes } from '../io.mjs';

export class ArchiveError extends Error {
  constructor(message) { super(message); this.name = 'ArchiveError'; this.code = 1; }
}
export const ARCHIVE_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
  maxRetainedBytes: 64 * 1024 * 1024, maxExpandedBytes: 16 * 1024 * 1024,
  maxFiles: 4096, maxHeaderBytes: 65536,
});
export function createArchiveContext({ command, io, stdin = '', signal = () => null, limits = {} }) {
  const ctx = createU2Context({ command, io, stdin, signal, limits: { ...ARCHIVE_LIMITS, ...limits } });
  let expanded = 0;
  Object.defineProperty(ctx, 'remainingExpanded', { get: () => ctx.limits.maxExpandedBytes - expanded });
  return Object.assign(ctx, {
    signal: signal(),
    fail(message) { throw new ArchiveError(`${command}: ${message}`); },
    expand(size) {
      ctx.budget.check();
      if (!Number.isSafeInteger(size) || size < 0 || size > ctx.limits.maxExpandedBytes - expanded) {
        throw new ArchiveError(`${command}: expanded bytes exceed the resource limit`);
      }
      expanded += size;
    },
    allocate(size) { ctx.budget.reserveRetained(size); return new Uint8Array(size); },
    retain(data) { ctx.budget.reserveRetained(data.byteLength); return data; },
    arguments(argv) { for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1); },
  });
}
export function checkRange(ctx, bytes, offset, length) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset > bytes.length - length) ctx.fail('truncated archive');
}
export function read16(ctx, bytes, offset) { checkRange(ctx, bytes, offset, 2); return bytes[offset] | bytes[offset + 1] << 8; }
export function read32(ctx, bytes, offset) { checkRange(ctx, bytes, offset, 4); return (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0; }
export function put16(bytes, offset, value) { bytes[offset] = value; bytes[offset + 1] = value >>> 8; }
export function put32(bytes, offset, value) { put16(bytes, offset, value); put16(bytes, offset + 2, value >>> 16); }
export function joinBytes(ctx, parts, maximum = ctx.limits.maxOutputBytes) {
  const views = parts.map(toBytes); let size = 0;
  for (const part of views) { size += part.length; if (size > maximum) ctx.fail('archive output exceeds the byte resource limit'); }
  const result = ctx.allocate(size); let at = 0;
  for (const part of views) { result.set(part, at); at += part.length; }
  return result;
}
export function archiveCount(text, command, name) {
  if (!/^[0-9]+$/.test(text) || !Number.isSafeInteger(Number(text))) throw new ArgError(`${command}: ${name} requires a nonnegative integer`);
  return Number(text);
}
