// Byte-preserving commands demonstrate the shared command context. U1 adds flags.
import { streamResult } from '../command-streams.mjs';
import { parseArgs } from '../args.mjs';
import { autoData, concatData, IOFailure, renderData, toBytes } from '../io.mjs';

export function createCoreCommands(io) {
  return {
    async cat(argv, stdin) {
      const { options, operands } = parseArgs(argv, Object.fromEntries([...'nbsAET'].map((short) => [short, { short }])), { command: 'cat' });
      const parts = [], events = []; let failed = false;
      for (const path of operands.length ? operands : ['-']) {
        try { const data = path === '-' ? stdin : await io.read(path); parts.push(data); events.push({ channel: 1, data }); }
        catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          events.push({ channel: 2, data: `cat: ${path}: ${error.code || 'error'}\n` });
          failed = true;
        }
      }
      const data = concatData(parts);
      if (!Object.keys(options).length) {
        let displayText = '';
        for (const event of events) {
          if (event.channel === 2 && displayText && !displayText.endsWith('\n')) displayText += '\n';
          displayText += renderData(autoData(event.data));
        }
        return streamResult(events, failed ? 1 : 0, failed ? { displayText } : {});
      }
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
      return streamResult([{ channel: 1, data: autoData(Uint8Array.from(output)) }, ...events.filter((event) => event.channel === 2)], failed ? 1 : 0);
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
      return { text: concatData([...errors, stdin]), stdout: stdin, stderr: errors.join(''), code: errors.length ? 1 : 0, raw: true,
        ...(errors.length ? { displayText: errors.join('') + renderData(stdin) } : {}) };
    },
  };
}
