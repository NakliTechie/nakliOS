import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, toBytes } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { parseAwk } from './awk-parser.mjs';
import { awkBinary, awkByteLength, runAwk } from './awk-runtime.mjs';

export function createAwkCommands(io, { signal = () => null, environment = () => new Map(), limits = {} } = {}) {
  return {
    async awk(argv, stdin = '') {
      const { options, operands, occurrences } = parseArgs(argv, {
        separator: { short: 'F', value: true }, assignment: { short: 'v', value: true, multiple: true },
        script: { short: 'f', value: true, multiple: true },
      }, { command: 'awk', stopAtOperand: true });
      const files = operands.slice(), sources = [];
      const maxSourceBytes = limits.maxSourceBytes ?? 262144;
      if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) throw new ArgError('awk: invalid maxSourceBytes limit');
      let scriptBytes = 0, usedStdin = false;
      const sourceOverflow = () => { throw new ArgError(`awk: program exceeds the ${maxSourceBytes}-byte source limit (EFBIG)`); };
      const remainingSourceBytes = () => {
        const remaining = maxSourceBytes - scriptBytes - (sources.length ? 1 : 0);
        if (remaining < 0) sourceOverflow();
        return remaining;
      };
      const add = (data) => {
        const remaining = remainingSourceBytes();
        if (awkByteLength(data, remaining) > remaining) sourceOverflow();
        const raw = toBytes(data); scriptBytes += raw.length + (sources.length ? 1 : 0);
        if (scriptBytes > maxSourceBytes) sourceOverflow();
        sources.push(awkBinary(raw));
      };
      if (options.script) {
        for (const path of options.script) {
          if (signal()?.aborted) throw new ShellInterrupted();
          try {
            if (path === '-') { add(usedStdin ? '' : stdin); usedStdin = true; }
            else add(await io.readBytes(path, { maxBytes: remainingSourceBytes() }));
          } catch (error) {
            if (!(error instanceof IOFailure)) throw error;
            return { text: error.code === 'EFBIG'
              ? `awk: ${path}: program exceeds the ${maxSourceBytes}-byte source limit (EFBIG)`
              : `awk: ${path}: ${error.code}: ${error.message}`, code: 2 };
          }
        }
      } else {
        if (!files.length) throw new ArgError('awk: missing program operand');
        add(files.shift());
      }
      const program = parseAwk(sources.join('\n'), limits);
      return runAwk(program, { io, stdin: usedStdin ? '' : stdin, operands: files, preassignments: occurrences.filter((item) => item.key === 'assignment' || item.key === 'separator').map((item) => item.key === 'separator' ? 'FS=' + item.value : item.value),
        environ: environment(), signal, limits });
    },
  };
}
