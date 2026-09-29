// Byte-preserving commands demonstrate the shared command context. U1 adds flags.
import { parseArgs } from '../args.mjs';
import { concatData } from '../io.mjs';

export function createCoreCommands(io) {
  return {
    async cat(argv, stdin) {
      const { operands } = parseArgs(argv, {}, { command: 'cat' });
      if (!operands.length) return { text: stdin, code: 0, raw: true };
      const parts = [];
      for (const path of operands) {
        try { parts.push(path === '-' ? stdin : await io.read(path)); }
        catch (error) { return { text: `cat: ${path}: ${error.code || 'error'}`, code: 1 }; }
      }
      return { text: concatData(parts), code: 0, raw: true };
    },
    async tee(argv, stdin) {
      const { operands } = parseArgs(argv, {}, { command: 'tee' });
      for (const path of operands) await io.write(path, stdin, { createParents: true });
      return { text: stdin, code: 0, raw: true };
    },
  };
}
