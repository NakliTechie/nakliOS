import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, autoData, renderData } from '../io.mjs';
import { createU2Context, utf8Length } from './u2-common.mjs';
import { resolveVirtualPath, relativeVirtualPath, withinVirtualPath } from './path-resolution.mjs';

const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const modeFor = (key) => ({ existing: 'existing', missing: 'missing', canonical: 'all-but-last' })[key];
const decoder = new TextDecoder();

export function createPathCommands(io, { signal = () => null, environment = () => new Map(), limits = {} } = {}) {
  const invoke = (command, argv) => {
    const ctx = createU2Context({ command, io, signal, limits });
    for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
    return ctx;
  };
  const finish = (ctx, diagnostics, code) => {
    const text = ctx.output.finish();
    return { text, stdout: text, stderr: diagnostics.finish(), code, raw: true, ...(diagnostics.length ? {
      displayText: decoder.decode(diagnostics.finish()) + renderData(autoData(text)),
    } : {}) };
  };
  const errorLine = (out, command, operand, error) => out.argument(`${command}: ${operand}: ${error.code}: ${error.message}\n`);
  return {
    async readlink(argv) {
      const ctx = invoke('readlink', argv);
      const { options, operands, occurrences } = parseArgs(argv, {
        canonical: flag('f', 'canonicalize'), existing: flag('e', 'canonicalize-existing'), missing: flag('m', 'canonicalize-missing'),
        noNewline: flag('n', 'no-newline'), zero: flag('z', 'zero'), quiet: flag(['q', 's'], ['quiet', 'silent']), verbose: flag('v', 'verbose'),
      }, { command: 'readlink' });
      if (!operands.length) fail('readlink', 'expected at least one pathname');
      ctx.budget.spend('inputFiles', operands.length);
      let mode = null, quiet = !environment().has('POSIXLY_CORRECT');
      for (const item of occurrences) {
        if (modeFor(item.key)) mode = modeFor(item.key);
        if (item.key === 'quiet') quiet = true; else if (item.key === 'verbose') quiet = false;
      }
      const diagnostics = ctx.output.fork(); let code = 0;
      if (options.noNewline && operands.length > 1) diagnostics.argument('readlink: ignoring --no-newline with multiple operands\n');
      for (const operand of operands) {
        await ctx.budget.checkpoint();
        try {
          const resolved = await resolveVirtualPath(io, operand,
            { context: ctx, mode: mode ?? 'existing', followFinal: mode !== null });
          let output;
          if (mode !== null) output = '/' + resolved.path;
          else {
            if (resolved.stat?.type !== 'symlink' || typeof resolved.stat.target !== 'string') {
              throw new IOFailure('fs.stat', { code: 'EINVAL', message: 'not a symbolic link' });
            }
            ctx.budget.spend('pathBytes', utf8Length(resolved.stat.target)); output = resolved.stat.target;
          }
          ctx.output.argument(output);
          if (!options.noNewline || operands.length > 1) ctx.output.byte(options.zero ? 0 : 10);
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          code = 1; if (!quiet) errorLine(diagnostics, 'readlink', operand, error);
        }
      }
      return finish(ctx, diagnostics, code);
    },
    async realpath(argv) {
      const ctx = invoke('realpath', argv);
      const { options, operands, occurrences } = parseArgs(argv, {
        canonical: flag('E', 'canonicalize'), existing: flag('e', 'canonicalize-existing'), missing: flag('m', 'canonicalize-missing'),
        logical: flag('L', 'logical'), physical: flag('P', 'physical'), strip: flag('s', ['strip', 'no-symlinks']),
        zero: flag('z', 'zero'), quiet: flag('q', 'quiet'), relativeTo: flag(null, 'relative-to', true), relativeBase: flag(null, 'relative-base', true),
      }, { command: 'realpath' });
      if (!operands.length) fail('realpath', 'expected at least one pathname');
      ctx.budget.spend('inputFiles', operands.length);
      let mode = 'all-but-last', logical = false, strip = false;
      for (const item of occurrences) {
        if (modeFor(item.key)) mode = modeFor(item.key);
        if (item.key === 'logical') { logical = true; strip = false; }
        else if (item.key === 'physical') { logical = false; strip = false; }
        else if (item.key === 'strip') { logical = false; strip = true; }
      }
      const resolve = (path) => resolveVirtualPath(io, path, { context: ctx, mode, logical, strip });
      const diagnostics = ctx.output.fork(); let code = 0, from = null, base = null;
      for (const [key, value] of [['relativeBase', options.relativeBase], ['relativeTo', options.relativeTo]]) {
        if (value == null) continue;
        try {
          const resolved = await resolve(value);
          if (mode === 'existing' && resolved.stat?.type !== 'dir') {
            throw new IOFailure('fs.stat', { code: 'ENOTDIR', message: 'relative reference must be a directory' });
          }
          if (key === 'relativeBase') base = resolved.path; else from = resolved.path;
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          if (!options.quiet) errorLine(diagnostics, 'realpath', value, error);
          return finish(ctx, diagnostics, 1);
        }
      }
      from ??= base;
      for (const operand of operands) {
        await ctx.budget.checkpoint();
        try {
          const { path } = await resolve(operand);
          const relative = from !== null && (base === null || withinVirtualPath(base, path) && withinVirtualPath(base, from));
          ctx.output.argument(relative ? relativeVirtualPath(from, path) : '/' + path); ctx.output.byte(options.zero ? 0 : 10);
        } catch (error) {
          if (!(error instanceof IOFailure)) throw error;
          code = 1; if (!options.quiet) errorLine(diagnostics, 'realpath', operand, error);
        }
      }
      return finish(ctx, diagnostics, code);
    },
    async ln() { fail('ln', 'this filesystem interface has no governed link-creation capability; use cp'); },
    async link() { fail('link', 'this filesystem interface has no governed hard-link capability; use cp'); },
  };
}
