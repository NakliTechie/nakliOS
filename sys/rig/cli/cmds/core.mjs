// Byte-preserving commands demonstrate the shared command context. U1 adds flags.
import { parseArgs } from '../args.mjs';
import { autoData, concatData, IOFailure, renderData, toBytes } from '../io.mjs';

export function createCoreCommands(io) {
  return {
    async cat(argv, stdin) {
      const { options, operands } = parseArgs(argv, Object.fromEntries([...'nbsAET'].map((short) => [short, { short }])), { command: 'cat' });
      const parts = []; let failed = false;
      for (const path of operands.length ? operands : ['-']) {
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
      const data = concatData(parts);
      if (!Object.keys(options).length) return { text: data, code: failed ? 1 : 0, raw: true };
      const bytes = toBytes(data), output = [];
      let number = 0, blankRun = 0;
      const ascii = (s) => output.push(...new TextEncoder().encode(s));
      for (let start = 0; start < bytes.length;) {
        let end = start; while (end < bytes.length && bytes[end] !== 10) end++;
        const blank = end === start;
        blankRun = blank ? blankRun + 1 : 0;
        if (!(options.s && blankRun > 1)) {
          if ((options.n || options.b) && (!options.b || !blank)) ascii(`${String(++number).padStart(6)}\t`);
          for (let i = start; i < end; i++) {
            let b = bytes[i];
            if ((options.T || options.A) && b === 9) ascii('^I');
            else if (options.E && b === 13 && i === end - 1 && end < bytes.length) ascii('^M');
            else if (options.A && b !== 9) {
              if (b >= 128) { ascii('M-'); b -= 128; }
              if (b < 32) ascii('^' + String.fromCharCode(b + 64));
              else if (b === 127) ascii('^?');
              else output.push(b);
            } else output.push(b);
          }
          if (end < bytes.length) { if (options.E || options.A) ascii('$'); output.push(10); }
        }
        start = end + 1;
      }
      return { text: autoData(Uint8Array.from(output)), code: failed ? 1 : 0, raw: true };
    },
    async tee(argv, stdin) {
      const { options, operands } = parseArgs(argv, { append: { short: 'a', long: 'append' } }, { command: 'tee' });
      const errors = [];
      for (const path of operands) {
        try {
          let before = '';
          if (options.append) {
            try { before = await io.read(path); }
            catch (error) { if (!(error instanceof IOFailure && error.code === 'ENOENT')) throw error; }
          }
          await io.write(path, concatData([before, stdin]), { createParents: true });
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          errors.push(`tee: ${path}: ${error.code}: ${error.message}\n`);
        }
      }
      return { text: concatData([...errors, stdin]), code: errors.length ? 1 : 0, raw: true,
        ...(errors.length ? { displayText: errors.join('') + renderData(stdin) } : {}) };
    },
  };
}
