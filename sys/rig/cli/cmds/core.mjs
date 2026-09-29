// Byte-preserving commands demonstrate the shared command context. U1 adds flags.
import { parseArgs } from '../args.mjs';
import { concatData, IOFailure, toBytes } from '../io.mjs';

export function createCoreCommands(io) {
  return {
    async cat(argv, stdin) {
      const { operands } = parseArgs(argv, {}, { command: 'cat' });
      if (!operands.length) return { text: stdin, code: 0, raw: true };
      const parts = []; let failed = false;
      for (const path of operands) {
        try { parts.push(path === '-' ? stdin : await io.read(path)); }
        catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          // A missing file used to end cat and drop every operand after it. Its error takes its
          // place on a line of its own (this shell has one output stream) and cat goes on.
          const prev = parts.length ? toBytes(parts[parts.length - 1]) : null;
          parts.push(`${prev && prev.length && prev[prev.length - 1] !== 10 ? '\n' : ''}cat: ${path}: ${error.code || 'error'}\n`);
          failed = true;
        }
      }
      return { text: concatData(parts), code: failed ? 1 : 0, raw: true };
    },
    async tee(argv, stdin) {
      const { operands } = parseArgs(argv, {}, { command: 'tee' });
      for (const path of operands) await io.write(path, stdin, { createParents: true });
      return { text: stdin, code: 0, raw: true };
    },
  };
}
