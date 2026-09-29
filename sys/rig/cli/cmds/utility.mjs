// U1a command wrappers and predicates. Nested commands retain the shell's I/O,
// staging and cancellation context; no command string is reparsed here.
import { lineData, resultEvents, streamResult } from '../command-streams.mjs';
import { parseArgs, ArgError } from '../args.mjs';
import { concatData, toText, IOFailure } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { unsupportedReason } from './unsupported.mjs';

const result = (text = '', code = 0) => ({ text, code });
const usage = (text) => result(text, 2);
const positive = (value, command) => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ArgError(`${command}: expected a positive integer: ${value}`);
  return Number(value);
};

// xargs has its own quoting rules: whitespace splits, quotes group, backslash
// quotes the next character. Shell variable/glob expansion never runs again.
function words(text, preserveSpaces = false) {
  const items = []; let word = '', active = false, quote = null, line = 0, trailingBlank = false;
  const flush = () => { if (active) items.push({ value: word, line }); word = ''; active = false; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; active = true; trailingBlank = false; }
    else if (c === '\\') {
      if (++i === text.length) throw new ArgError('xargs: trailing backslash');
      word += text[i]; active = true; trailingBlank = false;
    } else if (/\s/.test(c)) {
      if (preserveSpaces) { if (active) word += c; }
      else {
        flush();
        if (c === '\n') { if (!trailingBlank) line++; trailingBlank = false; }
        else trailingBlank = c === ' ' || c === '\t';
      }
    }
    else { word += c; active = true; trailingBlank = false; }
  }
  if (quote) throw new ArgError('xargs: unmatched quote');
  flush(); return items;
}

export function createUtilityCommands({ io, state, commandNames, signal, maxSleep, owner = () => null }) {
  async function stat(path) {
    try { return await io.stat(path); }
    catch (error) { if (error instanceof IOFailure && error.code === 'ENOENT') return null; throw error; }
  }

  async function evaluate(argv) {
    let i = 0;
    const binary = new Set(['=', '==', '!=', '-eq', '-ne', '-lt', '-le', '-gt', '-ge', '-nt', '-ot']);
    const unary = new Set(['-z', '-n', '-e', '-f', '-d', '-s']);
    const need = () => { if (i >= argv.length) throw new ArgError('test: missing operand'); return argv[i++]; };
    const compare = async (left, op, right) => {
      if (op === '=' || op === '==') return left === right;
      if (op === '!=') return left !== right;
      if (op === '-nt' || op === '-ot') {
        const a = await stat(left), b = await stat(right);
        return op === '-nt' ? !!a && (!b || a.mtimeMs > b.mtimeMs) : !!b && (!a || a.mtimeMs < b.mtimeMs);
      }
      if (!/^[+-]?\d+$/.test(left) || !/^[+-]?\d+$/.test(right)) throw new ArgError('test: integer expression expected');
      const a = BigInt(left), b = BigInt(right);
      return ({ '-eq': () => a === b, '-ne': () => a !== b, '-lt': () => a < b, '-le': () => a <= b, '-gt': () => a > b, '-ge': () => a >= b })[op]();
    };
    const atom = async () => {
      // Binary operators win over the ambiguous one-word forms (`test ! = !`).
      if (i + 2 < argv.length && binary.has(argv[i + 1])) {
        const left = need(), op = need(), right = need(); return compare(left, op, right);
      }
      const token = need();
      if (token === '!') return !(await atom());
      if (token === '(') { const yes = await or(); if (need() !== ')') throw new ArgError('test: expected )'); return yes; }
      if (token === ')') throw new ArgError('test: unexpected )');
      if (unary.has(token) && i < argv.length) {
        const value = need();
        if (token === '-z') return value === '';
        if (token === '-n') return value !== '';
        const st = await stat(value);
        return !!st && (token === '-e' || token === '-s' && st.size > 0 || token === '-f' && st.type === 'file' || token === '-d' && st.type === 'dir');
      }
      return token !== '';
    };
    const and = async () => { let yes = await atom(); while (argv[i] === '-a') { i++; const other = await atom(); yes = yes && other; } return yes; };
    const or = async () => { let yes = await and(); while (argv[i] === '-o') { i++; const other = await and(); yes = yes || other; } return yes; };
    if (!argv.length) return result('', 1);
    if (argv.length === 1) return result('', argv[0] === '' ? 1 : 0);
    const yes = await or();
    if (i !== argv.length) return usage(`test: unexpected operand '${argv[i]}'`);
    return result('', yes ? 0 : 1);
  }

  return {
    test: evaluate,
    '[': (argv) => argv.at(-1) !== ']' ? usage('[: missing `]`') : evaluate(argv.slice(0, -1)),
    which(argv) {
      const { operands } = parseArgs(argv, { all: { short: 'a', long: 'all' } }, { command: 'which' });
      if (!operands.length) return usage('which: missing operand');
      // One implementation exists per dispatch name, so -a has one result too.
      const names = commandNames();
      return streamResult(operands.map((name) => ({ channel: names.includes(name) ? 1 : 2, data: lineData(names.includes(name) ? name : `${name} not found`) })), operands.every((name) => names.includes(name)) ? 0 : 1);
    },
    type(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'type' });
      if (!operands.length) return usage('type: missing operand');
      const names = new Set(commandNames());
      const events = operands.map(name => {
        const known = names.has(name), reason = unsupportedReason(name);
        const description = !known ? `type: ${name}: not found`
          : state.functions.has(name) ? `${name} is a shell function`
          : reason ? `${name} is an unavailable capability refusal; requires ${reason}`
          : `${name} is a workspace shell command`;
        return { channel: known ? 1 : 2, data: lineData(description) };
      });
      return streamResult(events, operands.every(name => names.has(name)) ? 0 : 1);
    },
    basename(argv) {
      const { options, operands } = parseArgs(argv, { multiple: { short: 'a', long: 'multiple' }, suffix: { short: 's', long: 'suffix', value: true } }, { command: 'basename' });
      if (!operands.length) return usage('basename: missing operand');
      const multi = options.multiple || options.suffix !== undefined;
      if (!multi && operands.length > 2) return usage(`basename: extra operand '${operands[2]}' — basename NAME [SUFFIX]`);
      const suffix = options.suffix ?? (multi ? '' : operands[1]);
      return result((multi ? operands : operands.slice(0, 1)).map((name) => {
        let base = name.replace(/\/+$/, '').split('/').pop() || (name.startsWith('/') ? '/' : '');
        if (suffix && base !== suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length);
        return base;
      }).join('\n'));
    },
    dirname(argv) {
      const { operands } = parseArgs(argv, {}, { command: 'dirname' });
      if (!operands.length) return usage('dirname: missing operand');
      return result(operands.map((path) => {
        const p = path.replace(/\/+$/, ''), index = p.lastIndexOf('/');
        return index > 0 ? p.slice(0, index).replace(/\/+$/, '') || '/' : index === 0 || path.startsWith('/') ? '/' : '.';
      }).join('\n'));
    },
    async env(argv, stdin) {
      const { options, operands } = parseArgs(argv, { ignore: { short: 'i', long: 'ignore-environment' }, unset: { short: 'u', long: 'unset', value: true, multiple: true } }, { command: 'env', stopAtOperand: true });
      const saved = state.vars, savedCwd = state.cwd, invocation = owner();
      const savedFunctions = state.functions, savedPositionals = state.positionals;
      const vars = options.ignore ? new Map() : new Map(saved);
      if (!options.ignore && !state.explicitEnv) vars.set('PWD', '/' + state.cwd);
      for (const name of options.unset || []) vars.delete(name);
      let at = 0;
      while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(operands[at] || '')) {
        const word = operands[at++], cut = word.indexOf('='); vars.set(word.slice(0, cut), word.slice(cut + 1));
      }
      if (at === operands.length) return result([...vars].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${k}=${v}`).join('\n'));
      const explicit = state.explicitEnv;
      state.vars = vars; state.explicitEnv = true;
      if (state.functions) state.functions = new Map(state.functions);
      if (state.positionals) state.positionals = [...state.positionals];
      try { return await io.run(operands.slice(at), stdin); }
      finally {
        if (owner() === invocation) {
          state.vars = saved; state.cwd = savedCwd; state.explicitEnv = explicit;
          state.functions = savedFunctions; state.positionals = savedPositionals;
        }
      }
    },
    async sleep(argv) {
      if (!argv.length) return result('sleep: missing operand', 1);
      let seconds = 0;
      for (const interval of argv) {
        const m = /^(\d+(?:\.\d*)?|\.\d+)([smhd]?)$/.exec(interval);
        if (!m) return result(`sleep: invalid time interval '${interval}'`, 1);
        seconds += Number(m[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86400 })[m[2]];
      }
      if (!Number.isFinite(seconds) || seconds > maxSleep) return result(`sleep: interval exceeds the ${maxSleep} s cap`, 1);
      const sig = signal();
      if (sig?.aborted) throw new ShellInterrupted();
      const stopped = await new Promise((resolve) => {
        const finish = (value) => { clearTimeout(timer); sig?.removeEventListener('abort', stop); resolve(value); };
        const stop = () => finish(true);
        const timer = setTimeout(() => finish(false), Math.round(seconds * 1000));
        sig?.addEventListener('abort', stop, { once: true });
      });
      if (stopped) throw new ShellInterrupted();
      return result();
    },
    async xargs(argv, stdin) {
      const { options, operands, occurrences } = parseArgs(argv, {
        maxArgs: { short: 'n', long: 'max-args', value: true }, replace: { short: 'I', value: true },
        null: { short: '0', long: 'null' }, delimiter: { short: 'd', long: 'delimiter', value: true },
        noRun: { short: 'r', long: 'no-run-if-empty' }, maxLines: { short: 'L', long: 'max-lines', value: true },
      }, { command: 'xargs', stopAtOperand: true });
      // Batching modes are mutually exclusive; the final one wins. -n1 after
      // -I is the usual exception because replacement already handles one item.
      let batching;
      for (const entry of occurrences) {
        if (!['maxArgs', 'maxLines', 'replace'].includes(entry.key)) continue;
        if (entry.key === 'replace' && entry.value === '') return usage('xargs: replacement string must not be empty');
        if (entry.key !== 'replace') positive(entry.value, `xargs ${entry.flag}`);
        if (entry.key === 'maxArgs' && Number(entry.value) === 1 && batching?.key === 'replace') continue;
        batching = entry;
      }
      const limit = batching?.key === 'maxArgs' ? Number(batching.value) : Infinity;
      const lineLimit = batching?.key === 'maxLines' ? Number(batching.value) : Infinity;
      const replace = batching?.key === 'replace' ? batching.value : undefined;
      const text = toText(stdin), mode = occurrences.filter((o) => o.key === 'null' || o.key === 'delimiter').at(-1);
      if (text.length > 262144) throw new ArgError('xargs: input exceeds the argument byte limit');
      let items;
      if (mode) {
        const delimiter = mode.key === 'null' ? '\0' : mode.value.replace(/\\(n|t|r|0|\\)/g, (_, ch) => ({ n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\' })[ch]);
        if (new TextEncoder().encode(delimiter).length !== 1) return usage('xargs: delimiter must be one byte');
        const split = text.split(delimiter); if (split.at(-1) === '') split.pop();
        items = split.map((value, line) => ({ value, line }));
      } else if (replace !== undefined) {
        items = text.split('\n').filter((line) => line.trim() !== '').map((line, i) => ({ value: words(line, true).map((item) => item.value).join(''), line: i }));
      } else items = words(text);
      if (!items.length && (options.noRun || replace !== undefined)) return { ...result(), raw: true };
      const command = operands.length ? operands : ['echo'];
      const batches = [];
      if (replace !== undefined) for (const item of items) batches.push(command.map((arg) => arg.split(replace).join(item.value)));
      else {
        for (let at = 0; at < items.length;) {
          const batch = [], lines = new Set();
          while (at < items.length && batch.length < limit) {
            const item = items[at];
            if (!lines.has(item.line) && lines.size >= lineLimit) break;
            lines.add(item.line); batch.push(item.value); at++;
          }
          batches.push([...command, ...batch]);
        }
        if (!batches.length) batches.push(command);
      }
      const events = []; let code = 0;
      for (const batch of batches) {
        let r;
        try { r = await io.run(batch, ''); }
        catch (error) {
          if (!(error instanceof ShellInterrupted)) throw error;
          return streamResult([...events, { channel: 2, data: lineData(error.message) }], 130, { interrupted: true });
        }
        events.push(...resultEvents(r));
        if (r.cancelled || r.interrupted || r.timedOut || r.streamFailed) return streamResult(events, r.code, { cancelled: r.cancelled, interrupted: r.interrupted, timedOut: r.timedOut, streamFailed: r.streamFailed });
        if (r.code === 255) { code = 124; break; }
        if (r.code === 127 || r.code === 126) { code = r.code; break; }
        if (r.code) code = 123;
      }
      return streamResult(events, code);
    },
  };
}
