import { createCanonicalContext } from './canonical-input.mjs';
import { utf8Length } from './u2-common.mjs';

export class DataError extends Error {
  constructor(command, message, code = 5) { super(`${command}: ${message}`); this.code = code; }
}
export const DATA_LIMITS = Object.freeze({
  maxInputBytes: 4 * 1024 * 1024, maxOutputBytes: 4 * 1024 * 1024, maxRetainedBytes: 32 * 1024 * 1024,
  maxDepth: 128, maxValues: 100000, maxResults: 65536, maxFilterBytes: 65536,
  maxSqlBytes: 1024 * 1024, maxDatabaseBytes: 8 * 1024 * 1024, maxSqlSteps: 1000000, maxRows: 10000,
});
const decoder = new TextDecoder('utf-8', { fatal: true });
export function createDataContext(command, io, stdin, signal, limits) {
  const ctx = createCanonicalContext({ command, io, stdin, signal, limits: { ...DATA_LIMITS, ...limits } });
  let values = 0, results = 0;
  return Object.assign(ctx, {
    fail(message, code = 5) { throw new DataError(command, message, code); },
    arguments(argv) { for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1); },
    value(bytes = 32) {
      ctx.budget.check(); if (++values > ctx.limits.maxValues) ctx.fail('value count exceeds the resource limit');
      ctx.budget.reserveRetained(bytes);
    },
    result() { if (++results > ctx.limits.maxResults) ctx.fail('result count exceeds the resource limit'); },
    decode(bytes) { try { return decoder.decode(bytes); } catch { ctx.fail('input is not valid UTF-8', 4); } },
    finish(code = 0) { const text = ctx.output.finish(); return { text, stdout: text, stderr: '', code, raw: true }; },
  });
}
export function own(object, key) { return Object.hasOwn(object, key) ? object[key] : null; }
export function setKey(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
}
export const objectValue = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// Count each alias occurrence before copying it. A path-local set rejects
// cycles without allowing a shared YAML graph to evade the materialized limit.
export async function normalizeValue(ctx, value, depth = 0, ancestors = new Set()) {
  await ctx.budget.checkpoint();
  if (depth > ctx.limits.maxDepth) ctx.fail('value nesting exceeds the resource limit', 4);
  if (value === null || typeof value === 'boolean') { ctx.value(); return value; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) ctx.fail('nonfinite numbers are unsupported', 4);
    ctx.value(); return value;
  }
  if (typeof value === 'string') { ctx.value(32 + value.length * 2); return value; }
  if (typeof value !== 'object' || value instanceof Date || ArrayBuffer.isView(value) || value instanceof Map || value instanceof Set) {
    ctx.fail('input contains a non-JSON value', 4);
  }
  if (ancestors.has(value)) ctx.fail('cyclic YAML aliases are unsupported', 4);
  ctx.value(); ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const out = [];
      for (const item of value) out.push(await normalizeValue(ctx, item, depth + 1, ancestors));
      return out;
    }
    const out = Object.create(null);
    for (const key of Object.keys(value)) {
      ctx.budget.reserveRetained(16 + key.length * 2);
      setKey(out, key, await normalizeValue(ctx, value[key], depth + 1, ancestors));
    }
    return out;
  } finally { ancestors.delete(value); }
}

// Split a JSON value stream without interpreting delimiters inside strings.
// Check nesting before JSON.parse, and validate every parsed graph afterward.
export async function parseJsonValues(ctx, text) {
  const values = []; let at = 0;
  while (at < text.length) {
    while (/[ \t\r\n]/.test(text[at] || '') && at < text.length) at++;
    if (at === text.length) break;
    const start = at, first = text[at]; let quoted = false, escaped = false, depth = 0;
    if (first === '{' || first === '[' || first === '"') {
      do {
        if ((at - start) % 4096 === 0) await ctx.budget.checkpoint();
        const c = text[at++];
        if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
        else if (c === '"') quoted = true;
        else if (c === '{' || c === '[') { if (++depth > ctx.limits.maxDepth) ctx.fail('JSON nesting exceeds the resource limit', 4); }
        else if (c === '}' || c === ']') depth--;
      } while (at < text.length && (quoted || depth > 0));
    } else {
      while (at < text.length && !/[\s\[\]{},"]/.test(text[at])) { if ((at - start) % 4096 === 0) await ctx.budget.checkpoint(); at++; }
    }
    if (at === start) ctx.fail(`invalid JSON at offset ${at}`, 4);
    let value;
    try { value = JSON.parse(text.slice(start, at)); } catch { ctx.fail(`invalid JSON at offset ${start}`, 4); }
    values.push(await normalizeValue(ctx, value));
  }
  return values;
}

export async function jsonText(ctx, value, compact = false) {
  // The evaluator may share subtrees. Count every serialized occurrence first.
  let estimated = 0;
  async function measure(item, depth) {
    await ctx.budget.checkpoint();
    if (depth > ctx.limits.maxDepth) ctx.fail('output nesting exceeds the resource limit');
    estimated += 8;
    if (typeof item === 'string') estimated += item.length * 6;
    else if (Array.isArray(item)) for (const child of item) await measure(child, depth + 1);
    else if (objectValue(item)) for (const key of Object.keys(item)) { estimated += key.length * 6; await measure(item[key], depth + 1); }
    if (estimated > ctx.limits.maxRetainedBytes) ctx.fail('serialized value exceeds the retained byte limit');
  }
  await measure(value, 0); ctx.budget.reserveRetained(estimated);
  return JSON.stringify(value, null, compact ? undefined : 2);
}

export function compareStrings(a, b) {
  const left = Array.from(a), right = Array.from(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const d = left[i].codePointAt(0) - right[i].codePointAt(0); if (d) return Math.sign(d);
  }
  return Math.sign(left.length - right.length);
}
