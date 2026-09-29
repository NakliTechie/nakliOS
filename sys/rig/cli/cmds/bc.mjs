import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { createU2Context, utf8Length } from './u2-common.mjs';
import { parseBc } from './bc-parser.mjs';
import { createBcRuntime } from './bc-runtime.mjs';

export function createBcCommands(io, { signal = () => null, limits = {} } = {}) {
  return {
    async bc(argv, stdin = '') {
      const maxSourceBytes = limits.maxSourceBytes ?? 262144;
      const maxNodes = limits.maxNodes ?? 100000;
      if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) throw new ArgError('bc: invalid source byte limit');
      if (!Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new ArgError('bc: invalid syntax node limit');
      const ctx = createU2Context({ command: 'bc', io, stdin, signal, limits: {
        ...limits, maxInputBytes: Math.min(limits.maxInputBytes ?? maxSourceBytes, maxSourceBytes),
      } });
      if (!Array.isArray(argv) || argv.length > ctx.limits.maxInputFiles + 16) throw new ArgError('bc: too many arguments');
      for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg, ctx.budget.remaining('argumentBytes')));
      const { options, operands } = parseArgs(argv, {
        math: { short: 'l', long: 'mathlib' }, quiet: { short: 'q', long: 'quiet' },
        strict: { short: 's', long: 'standard' }, warn: { short: 'w', long: 'warn' },
      }, { command: 'bc' });
      const inputs = ctx.inputs.operands([...operands, '-'], { defaultStdin: false });
      const runtime = createBcRuntime({ context: ctx, mathLibrary: !!options.math, limits });
      let nodes = 0, display = 'standard input';
      try {
        for (const input of inputs) {
          if (runtime.stopped) break;
          display = input.display;
          const bytes = await (await input.open()).rest();
          ctx.budget.reserveRetained(bytes.length * 2);
          let source = '';
          for (let at = 0; at < bytes.length; at += 8192) {
            await ctx.budget.checkpoint(); source += String.fromCharCode(...bytes.subarray(at, at + 8192));
          }
          if (nodes >= maxNodes && bytes.length) throw new ArgError(`bc: program exceeds the ${maxNodes}-node syntax limit`);
          const program = parseBc(source, { maxSourceBytes, maxNodes: Math.max(1, maxNodes - nodes), maxDepth: limits.maxDepth ?? 128,
            strict: !!options.strict, warn: !!options.warn, reserveNode: (bytes = 96) => ctx.budget.reserveRetained(bytes) });
          nodes += program.nodes;
          await runtime.execute(program);
        }
      } catch (error) {
        if (!(error instanceof IOFailure) && !(error instanceof ArgError)) throw error;
        // A later file or runtime failure must not erase already completed output.
        if (!ctx.output.length && error instanceof ArgError) throw error;
        let message = error instanceof IOFailure ? `bc: ${display}: ${error.code}: ${error.message}` : error.message;
        message = message.slice(0, 2048);
        return { text: ctx.output.finish(), stdout: ctx.output.finish(), stderr: message + '\n', code: 2, raw: true };
      }
      return { text: ctx.output.finish(), code: 0, raw: true };
    },
  };
}
