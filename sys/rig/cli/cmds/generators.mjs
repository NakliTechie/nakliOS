import { ArgError, parseArgs } from '../args.mjs';
import { createU2Context, utf8Length } from './u2-common.mjs';
import { createRepeatStream } from './streams.mjs';

export function createGeneratorCommands({ signal = () => null, environment = () => new Map(), limits = {} } = {}) {
  const context = (command, argv) => {
    const ctx = createU2Context({ command, signal, limits });
    for (const argument of argv) {
      try { ctx.budget.spend('argumentBytes', utf8Length(argument, ctx.budget.remaining('argumentBytes'))); }
      catch (error) {
        if (error instanceof ArgError) throw new ArgError(`${command}: argument bytes exceed the resource limit`);
        throw error;
      }
    }
    return ctx;
  };
  return {
    async printenv(argv) {
      const ctx = context('printenv', argv);
      const { options, operands } = parseArgs(argv, { null: { short: '0', long: 'null' } }, { command: 'printenv' });
      const vars = environment(), separator = options.null ? 0 : 10;
      let code = 0;
      if (operands.length) {
        for (const name of operands) {
          await ctx.budget.checkpoint();
          if (!vars.has(name)) { code = 1; continue; }
          ctx.output.argument(String(vars.get(name))); ctx.output.byte(separator);
        }
      } else {
        const entries = [];
        for (const entry of vars) {
          await ctx.budget.checkpoint();
          ctx.budget.spend('records'); ctx.budget.reserveRetained(32);
          entries.push(entry);
        }
        entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
        for (const [name, value] of entries) {
          await ctx.budget.checkpoint();
          ctx.output.argument(String(name)); ctx.output.byte(61);
          ctx.output.argument(String(value)); ctx.output.byte(separator);
        }
      }
      return { text: ctx.output.finish(), code, raw: true };
    },
    async yes(argv) {
      const ctx = context('yes', argv);
      const { operands } = parseArgs(argv, {}, { command: 'yes', stopAtOperand: true });
      const words = operands.length ? operands : ['y'];
      let length = words.length; // separators plus final LF
      for (const word of words) length += utf8Length(word, ctx.limits.maxArgumentBytes);
      ctx.budget.reserveRetained(length);
      const line = new TextEncoder().encode(words.join(' ') + '\n');
      let position = 0;
      return {
        code: 0, raw: true,
        stream: createRepeatStream(async (capacity) => {
          // Every allocation is bounded before construction. Chunks may split
          // a long argument line without changing its framing or payload.
          const chunk = new Uint8Array(capacity);
          const seed = Math.min(capacity, line.length);
          const tail = Math.min(seed, line.length - position);
          chunk.set(line.subarray(position, position + tail));
          if (tail < seed) chunk.set(line.subarray(0, seed - tail), tail);
          let offset = seed;
          while (offset < capacity) {
            await ctx.budget.checkpoint();
            const count = Math.min(capacity - offset, offset);
            chunk.set(chunk.subarray(0, count), offset);
            offset += count;
          }
          position = (position + capacity) % line.length;
          return chunk;
        }, { signal, limits, command: 'yes', context: ctx }),
      };
    },
  };
}
