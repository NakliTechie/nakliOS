// Narrow byte-producer transport for U2. No host streams or process handles.
import { ArgError } from '../args.mjs';
import { createU2Context } from './u2-common.mjs';
import { parseEndArguments } from './text.mjs';

const CHUNK_BYTES = 64 * 1024;
const owned = new WeakSet();
export const isByteStream = (value) => value != null && typeof value[Symbol.asyncIterator] === 'function';

// One iterator owns cleanup even when a consumer fails before its first read.
// return() is idempotent, including through nested shell error boundaries.
export function ownByteStream(source) {
  if (!isByteStream(source)) throw new ArgError('shell: invalid byte stream');
  if (owned.has(source)) return source;
  const iterator = source[Symbol.asyncIterator]();
  if (!iterator || typeof iterator.next !== 'function') throw new ArgError('shell: invalid byte iterator');
  let closed = false;
  const stream = {
    async next() {
      if (closed) return { done: true, value: undefined };
      const result = await iterator.next();
      if (!result || typeof result !== 'object') throw new ArgError('shell: invalid stream result');
      if (result.done) { closed = true; return { done: true, value: undefined }; }
      if (!(result.value instanceof Uint8Array) || !result.value.length || result.value.length > CHUNK_BYTES) {
        throw new ArgError(`shell: stream chunks must contain 1–${CHUNK_BYTES} bytes`);
      }
      return { done: false, value: result.value };
    },
    async return() {
      if (!closed) { closed = true; if (typeof iterator.return === 'function') await iterator.return(); }
      return { done: true, value: undefined };
    },
    [Symbol.asyncIterator]() { return this; },
  };
  owned.add(stream);
  return stream;
}

export async function closeByteStream(source, { suppress = false } = {}) {
  if (!isByteStream(source)) return;
  try { await ownByteStream(source).return(); }
  catch (error) { if (!suppress) throw error; }
}

export function createRepeatStream(nextChunk, { signal = () => null, limits = {}, command = 'producer', context } = {}) {
  if (typeof nextChunk !== 'function') throw new TypeError('repeat producer requires a chunk function');
  const ctx = context ?? createU2Context({ command, signal, limits });
  return ownByteStream((async function* () {
    while (true) {
      await ctx.budget.checkpoint();
      const capacity = Math.min(CHUNK_BYTES, ctx.budget.remaining('outputBytes'));
      if (!capacity) throw new ArgError(`${command}: generated output exceeds the ${ctx.limits.maxOutputBytes}-byte limit`);
      const chunk = await nextChunk(capacity);
      ctx.budget.check();
      if (!(chunk instanceof Uint8Array) || !chunk.length || chunk.length > capacity) {
        throw new ArgError(`${command}: invalid bounded producer chunk`);
      }
      ctx.budget.spend('outputBytes', chunk.length);
      yield chunk;
    }
  })());
}

export async function collectByteStream(source, { signal = () => null, limits = {}, command = 'shell' } = {}) {
  const ctx = createU2Context({ command, signal, limits });
  const stream = ownByteStream(source);
  let failed = false;
  try {
    while (true) {
      await ctx.budget.checkpoint();
      const next = await stream.next();
      ctx.budget.check();
      if (next.done) break;
      ctx.budget.spend('inputBytes', next.value.length);
      ctx.output.append(next.value);
    }
    return ctx.output.finish();
  } catch (error) { failed = true; throw error; }
  finally { await closeByteStream(stream, { suppress: failed }); }
}

export function createStreamingHead({ fallback, signal = () => null, limits = {} } = {}) {
  if (typeof fallback !== 'function') throw new TypeError('streaming head requires its ordinary command');
  return async (argv, stdin) => {
    if (!isByteStream(stdin)) return fallback(argv, stdin);
    const stream = ownByteStream(stdin);
    let failed = false;
    try {
      const { operands, count, byteMode } = parseEndArguments('head', argv);
      // Explicit file-only operands never consume the pipeline's stdin.
      if (operands.length && !operands.includes('-')) {
        await closeByteStream(stream);
        return fallback(argv, '');
      }
      // Negative counts need EOF; mixed inputs keep the existing header/cursor
      // behavior. Their materialization is bounded and cannot drain infinity.
      if (String(count).startsWith('-') || operands.length > 1) {
        return fallback(argv, await collectByteStream(stream, { signal, limits, command: 'head' }));
      }
      const ctx = createU2Context({ command: 'head', signal, limits });
      let remaining = Number(count);
      while (remaining > 0) {
        await ctx.budget.checkpoint();
        const next = await stream.next();
        ctx.budget.check();
        if (next.done) break;
        const bytes = next.value;
        ctx.budget.spend('inputBytes', bytes.length);
        let end = 0;
        if (byteMode) { end = Math.min(bytes.length, remaining); remaining -= end; }
        else {
          while (end < bytes.length) {
            if ((end & 4095) === 0) await ctx.budget.checkpoint();
            if (bytes[end++] === 10 && --remaining === 0) break;
          }
        }
        ctx.output.append(bytes.subarray(0, end));
      }
      return { text: ctx.output.finish(), code: 0, raw: true };
    } catch (error) { failed = true; throw error; }
    finally { await closeByteStream(stream, { suppress: failed }); }
  };
}
