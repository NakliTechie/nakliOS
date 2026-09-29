import { ArgError } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';

const encoder = new TextEncoder();
export const U2_LIMITS = Object.freeze({
  maxInputBytes: 64 * 1024 * 1024, maxOutputBytes: 16 * 1024 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024, maxArgumentBytes: 256 * 1024,
  maxRecords: 262144, maxFragments: 262144, maxSteps: 1000000, yieldEvery: 256,
  maxFiles: 4096, maxInputFiles: 4096, maxPathBytes: 1024 * 1024, maxRegexBytes: 16384,
  maxDecimalDigits: 10000, maxDecimalScale: 1000, maxExponent: 10000,
});
const capName = (kind) => 'max' + kind[0].toUpperCase() + kind.slice(1);
const counters = ['inputBytes', 'outputBytes', 'argumentBytes', 'records', 'fragments', 'steps', 'files', 'inputFiles', 'pathBytes'];
const bytesView = (data) => {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('expected Uint8Array or ArrayBuffer');
};

export function utf8Length(text, ceiling = Number.MAX_SAFE_INTEGER) {
  if (typeof text !== 'string') throw new TypeError('expected a string');
  let size = 0;
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at);
    if (code < 128) size++;
    else if (code < 2048) size += 2;
    else if (code >= 0xd800 && code <= 0xdbff && text.charCodeAt(at + 1) >= 0xdc00 && text.charCodeAt(at + 1) <= 0xdfff) { size += 4; at++; }
    else size += 3;
    if (size > ceiling) throw new ArgError(`text exceeds the ${ceiling}-byte limit`);
  }
  return size;
}

export function encodeArgument(text, budget) {
  let size;
  try { size = utf8Length(text, budget.remaining('argumentBytes')); }
  catch (error) { if (error instanceof ArgError) throw new ArgError(`${budget.command}: argument bytes exceed the resource limit`); throw error; }
  budget.spend('argumentBytes', size);
  return encoder.encode(text);
}

export const foldAscii = (byte) => byte >= 65 && byte <= 90 ? byte + 32 : byte;
export function compareBytes(a, b, { ignoreCase = false } = {}) {
  const count = Math.min(a.length, b.length);
  for (let i = 0; i < count; i++) {
    const left = ignoreCase ? foldAscii(a[i]) : a[i], right = ignoreCase ? foldAscii(b[i]) : b[i];
    if (left !== right) return left < right ? -1 : 1;
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

export function parseCount(text, { command, label, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const fail = () => { throw new ArgError(`${command || 'command'}: ${label || 'count'} must be an integer from ${min} to ${max}`); };
  if (typeof text !== 'string' || !/^[0-9]+$/.test(text)) fail();
  const digits = text.replace(/^0+/, '') || '0';
  if (digits.length > String(max).length) fail();
  const value = Number(digits);
  if (!Number.isSafeInteger(value) || value < min || value > max) fail();
  return value;
}

export function createU2Context({ command = 'command', io, stdin = '', signal = () => null, limits = {} } = {}) {
  const cap = { ...U2_LIMITS, ...limits };
  const fail = (message) => { throw new ArgError(`${command}: ${message}`); };
  for (const [name, value] of Object.entries(cap)) {
    if (!Number.isSafeInteger(value) || value < 0 || name === 'yieldEvery' && value === 0) fail(`invalid ${name} limit`);
  }
  const used = Object.fromEntries(counters.map((name) => [name, 0]));
  let retained = 0, yieldedAt = 0;
  const invocationSignal = signal();
  const check = () => { if (invocationSignal?.aborted) throw new ShellInterrupted(); };
  const spend = (kind, count = 1) => {
    check();
    if (!Object.hasOwn(used, kind) || !Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid resource charge');
    if (count > cap[capName(kind)] - used[kind]) fail(`${kind} exceeds the ${cap[capName(kind)]} resource limit`);
    used[kind] += count;
  };
  const budget = {
    command, check, spend,
    remaining(kind) {
      if (!Object.hasOwn(used, kind)) throw new TypeError('invalid resource counter');
      return cap[capName(kind)] - used[kind];
    },
    reserveRetained(count) {
      check();
      if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid retained byte reservation');
      if (count > cap.maxRetainedBytes - retained) fail(`retained bytes exceed the ${cap.maxRetainedBytes}-byte limit`);
      retained += count; let active = true;
      return () => { if (active) { retained -= count; active = false; } };
    },
    async checkpoint(cost = 1) {
      spend('steps', cost);
      if (used.steps - yieldedAt >= cap.yieldEvery) {
        yieldedAt = used.steps;
        await new Promise((resolve) => setTimeout(resolve, 0)); check();
      }
    },
    snapshot() { return Object.freeze({ ...used, retainedBytes: retained }); },
  };

  const textSize = (text, ceiling, kind) => {
    try { return utf8Length(text, ceiling); }
    catch (error) { if (error instanceof ArgError) fail(`${kind} exceeds its byte resource limit`); throw error; }
  };
  function makeCursor(bytes) {
    let position = 0;
    return {
      get position() { return position; }, get length() { return bytes.length; }, get remaining() { return bytes.length - position; },
      async nextRecord({ separator = 10 } = {}) {
        if (!Number.isInteger(separator) || separator < 0 || separator > 255) throw new TypeError('separator must be one byte');
        check(); if (position === bytes.length) return null;
        const start = position; let scanned = 0;
        while (position < bytes.length && bytes[position] !== separator) {
          position++;
          if (++scanned === 4096) { scanned = 0; await budget.checkpoint(); }
        }
        await budget.checkpoint(); budget.spend('records');
        const end = position, terminated = position < bytes.length;
        if (terminated) position++;
        return { bytes: bytes.subarray(start, end), terminated, separator };
      },
      async take(count) {
        if (!Number.isSafeInteger(count) || count < 0) throw new TypeError('take count must be a nonnegative integer');
        await budget.checkpoint(); const end = position + Math.min(count, bytes.length - position);
        const result = bytes.subarray(position, end); position = end; return result;
      },
      async rest() { return this.take(bytes.length - position); },
    };
  }
  let stdinCursor, stdinPromise, inputTail = Promise.resolve();
  const serialInput = (open) => {
    const result = inputTail.then(open);
    inputTail = result.then(() => undefined, () => undefined);
    return result;
  };
  async function openStdin() {
    if (!stdinCursor) {
      check(); let bytes;
      if (typeof stdin === 'string') {
        const size = textSize(stdin, budget.remaining('inputBytes'), 'input');
        budget.spend('inputBytes', size); bytes = encoder.encode(stdin);
      } else {
        const size = stdin?.byteLength;
        if (!Number.isSafeInteger(size)) throw new TypeError('stdin must contain bytes or text');
        budget.spend('inputBytes', size); bytes = bytesView(stdin);
      }
      stdinCursor = makeCursor(bytes);
    }
    return stdinCursor;
  }
  const inputs = {
    operands(operands, { defaultStdin = true } = {}) {
      if (!Array.isArray(operands) || operands.some((value) => typeof value !== 'string')) throw new TypeError('input operands must be strings');
      const values = !operands.length && defaultStdin ? ['-'] : operands;
      budget.spend('inputFiles', values.length);
      budget.reserveRetained(values.length * 64); // descriptors live for this invocation
      return values.map((operand) => {
        let cursorPromise;
        return { operand, display: operand === '-' ? 'standard input' : operand,
          open() {
            if (operand === '-') return stdinPromise ??= serialInput(openStdin);
            cursorPromise ??= serialInput(async () => {
              check();
              if (!io || typeof io.readBytes !== 'function') fail('file input is unavailable');
              let data;
              try { data = await io.readBytes(operand, { maxBytes: budget.remaining('inputBytes') }); }
              catch (error) { if (error instanceof IOFailure && error.code === 'EFBIG') fail('input exceeds its byte resource limit (EFBIG)'); throw error; }
              check(); const size = data?.byteLength;
              if (!Number.isSafeInteger(size)) fail('file input did not return bytes');
              budget.spend('inputBytes', size);
              return makeCursor(bytesView(data));
            });
            return cursorPromise;
          },
        };
      });
    },
  };

  function makeOutput() {
    let length = 0, finished = null, chunks = [];
    const reserve = (size) => {
      if (finished) throw new TypeError('output builder is already finished');
      budget.spend('outputBytes', size); if (size) budget.spend('fragments');
      length += size;
    };
    const out = {
      get length() { return length; },
      append(data) { const bytes = bytesView(data); reserve(bytes.length); if (bytes.length) chunks.push(bytes); return out; },
      byte(value) { return out.repeat(value, 1); },
      repeat(value, count) {
        if (!Number.isInteger(value) || value < 0 || value > 255 || !Number.isSafeInteger(count) || count < 0) throw new TypeError('invalid repeated byte');
        reserve(count); if (count) chunks.push(new Uint8Array(count).fill(value)); return out;
      },
      argument(text) {
        const size = textSize(text, budget.remaining('outputBytes'), 'output');
        reserve(size); if (size) chunks.push(encoder.encode(text)); return out;
      },
      record(record, { separator = 10, terminate = record.terminated } = {}) {
        out.append(record.bytes); if (terminate) out.byte(separator); return out;
      },
      finish() {
        check();
        if (!finished) {
          finished = new Uint8Array(length); let offset = 0;
          for (const chunk of chunks) { finished.set(chunk, offset); offset += chunk.length; }
          chunks = [];
        }
        return finished;
      },
      fork: makeOutput,
    };
    return out;
  }
  return { command, limits: Object.freeze(cap), budget, inputs, output: makeOutput() };
}
