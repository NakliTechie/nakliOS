// C-locale byte record tools. Only governed I/O crosses the command boundary.
import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure } from '../io.mjs';
import { createU2Context, utf8Length, compareBytes, parseCount } from './u2-common.mjs';
import { parseRegex, findRegex } from './records-regex.mjs';

const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const empty = new Uint8Array();
const binary = (bytes) => { const parts = []; for (let at = 0; at < bytes.length; at += 4096) parts.push(String.fromCharCode(...bytes.subarray(at, at + 4096))); return parts.join(''); };
const equal = (a, b) => compareBytes(a, b) === 0;
const count = (ctx, text, label, min = 0, max = Number.MAX_SAFE_INTEGER) => parseCount(String(text), { command: ctx.command, label, min, max });
function invocation(command, io, signal, limits, argv, stdin) {
  const ctx = createU2Context({ command, io, signal, limits, stdin });
  for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
  ctx.argument = (text) => { const size = utf8Length(text); if (size > ctx.limits.maxArgumentBytes) fail(command, 'argument exceeds the byte limit'); return new TextEncoder().encode(text); };
  return ctx;
}
const result = (ctx, code = 0) => ({ text: ctx.output.finish(), code, raw: true });
function compile(ctx, text) {
  const bytes = ctx.argument(text);
  if (bytes.length > ctx.limits.maxRegexBytes) fail(ctx.command, 'regular expression exceeds the byte limit');
  ctx.budget.reserveRetained(bytes.length * 64 + 128);
  return parseRegex(binary(bytes), ctx.command);
}
function match(ctx, regex, bytes, at = 0, anchored = false) {
  const release = ctx.budget.reserveRetained(4096 * (64 + regex.groups * 24));
  try { return findRegex(regex, bytes, at, { anchored, tick: () => ctx.budget.spend('steps') }); }
  finally { release(); }
}
async function collect(ctx, source, separator = 10) {
  const cursor = await source.open(), rows = [], releases = [];
  for (;;) {
    await ctx.budget.checkpoint(); const row = await cursor.nextRecord({ separator }); if (!row) break;
    releases.push(ctx.budget.reserveRetained(64)); rows.push(row);
  }
  return { rows, release: () => { for (const release of releases) release(); } };
}
async function eachSource(ctx, operands, action) {
  let code = 0;
  for (const source of ctx.inputs.operands(operands)) {
    try { await action(source); }
    catch (error) {
      if (!(error instanceof IOFailure)) throw error;
      code = 1; ctx.output.argument(`${ctx.command}: ${source.display}: ${error.code}: ${error.message}\n`);
    }
  }
  return result(ctx, code);
}
function delimiters(ctx, value) {
  const bytes = ctx.argument(value), parts = [];
  for (let at = 0; at < bytes.length; at++) {
    if (bytes[at] !== 92) parts.push(bytes[at]);
    else {
      if (++at === bytes.length) fail(ctx.command, 'delimiter list ends with a backslash');
      const byte = bytes[at]; parts.push(({ 48: -1, 110: 10, 116: 9, 98: 8, 102: 12, 114: 13, 118: 11, 92: 92 })[byte] ?? byte);
    }
  }
  return parts.length ? parts : [-1];
}
function twoInputs(ctx, operands) {
  if (operands.length !== 2) fail(ctx.command, 'exactly two input operands are required');
  if (operands[0] === '-' && operands[1] === '-') fail(ctx.command, 'both inputs cannot share standard input');
  return ctx.inputs.operands(operands, { defaultStdin: false });
}
async function fields(ctx, bytes, separator) {
  const out = []; let at = 0;
  const push = (a, b) => { ctx.budget.spend('steps'); if (out.length >= ctx.limits.maxRecords) fail(ctx.command, 'field count exceeds the limit'); ctx.budget.reserveRetained(24); out.push(bytes.subarray(a, b)); };
  if (separator === -1) return [bytes];
  if (separator != null) {
    let start = 0;
    for (; at < bytes.length; at++) { if (at % 4096 === 0) await ctx.budget.checkpoint(); if (bytes[at] === separator) { push(start, at); start = at + 1; } }
    push(start, bytes.length);
  } else {
    while (at < bytes.length) {
      while (at < bytes.length && (bytes[at] === 32 || bytes[at] === 9)) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; }
      if (at === bytes.length) break;
      const start = at; while (at < bytes.length && bytes[at] !== 32 && bytes[at] !== 9) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; }
      push(start, at);
    }
  }
  return out;
}

export function createRecordCommands(io, { signal = () => null, limits = {} } = {}) {
  return {
    async rev(argv, stdin) {
      const ctx = invocation('rev', io, signal, limits, argv, stdin), { operands } = parseArgs(argv, {}, { command: 'rev' });
      return eachSource(ctx, operands, async (source) => {
        const cursor = await source.open();
        for (;;) {
          const row = await cursor.nextRecord({ separator: 10 }); if (!row) break;
          const release = ctx.budget.reserveRetained(row.bytes.length), reversed = new Uint8Array(row.bytes.length);
          for (let at = 0; at < row.bytes.length; at++) { if (at % 4096 === 0) await ctx.budget.checkpoint(); reversed[at] = row.bytes[row.bytes.length - at - 1]; }
          ctx.output.append(reversed); if (row.terminated) ctx.output.byte(10); release();
        }
      });
    },
    async tac(argv, stdin) {
      const ctx = invocation('tac', io, signal, limits, argv, stdin);
      const { options, operands } = parseArgs(argv, { before: flag('b', 'before'), regex: flag('r', 'regex'), separator: flag('s', 'separator', true) }, { command: 'tac' });
      const separator = ctx.argument(options.separator === '' ? '\0' : options.separator ?? '\n');
      const regex = options.regex ? compile(ctx, options.separator === '' ? '\0' : options.separator ?? '\n') : null;
      return eachSource(ctx, operands, async (source) => {
        const bytes = await (await source.open()).rest(); let end = bytes.length, scan = bytes.length - (regex ? 0 : separator.length), scans = 0;
        while (scan >= 0) {
          if (++scans % 4096 === 0) await ctx.budget.checkpoint();
          let found = false, stop = scan;
          if (regex) { const hit = match(ctx, regex, bytes.subarray(0, end), scan, true); if (hit && hit.end > scan) { found = true; stop = hit.end; } }
          else { found = true; for (let i = 0; i < separator.length; i++) { if (separator.length > 1) ctx.budget.spend('steps'); if (bytes[scan + i] !== separator[i]) { found = false; break; } } stop = scan + separator.length; }
          if (found) {
            const boundary = options.before ? scan : stop;
            if (boundary < end) { ctx.budget.spend('records'); ctx.output.append(bytes.subarray(boundary, end)); end = boundary; }
            scan -= regex ? 1 : separator.length;
          } else scan--;
        }
        if (end) { ctx.budget.spend('records'); ctx.output.append(bytes.subarray(0, end)); }
      });
    },
    async paste(argv, stdin) {
      const ctx = invocation('paste', io, signal, limits, argv, stdin);
      const { options, operands } = parseArgs(argv, { serial: flag('s', 'serial'), delimiters: flag('d', 'delimiters', true), zero: flag('z', 'zero-terminated') }, { command: 'paste' });
      const ds = delimiters(ctx, options.delimiters ?? '\t'), separator = options.zero ? 0 : 10, sources = ctx.inputs.operands(operands);
      const put = (index) => { const byte = ds[index % ds.length]; if (byte >= 0) ctx.output.byte(byte); };
      if (options.serial) {
        for (const source of sources) {
          const cursor = await source.open(); let row = await cursor.nextRecord({ separator }), index = 0;
          if (!row) { ctx.output.byte(separator); continue; }
          while (row) { await ctx.budget.checkpoint(); ctx.output.append(row.bytes); row = await cursor.nextRecord({ separator }); if (row) put(index++); }
          ctx.output.byte(separator);
        }
      } else {
        const cursors = []; for (const source of sources) cursors.push(await source.open());
        for (;;) {
          await ctx.budget.checkpoint(); const rows = []; let any = false;
          for (const cursor of cursors) { const row = await cursor.nextRecord({ separator }); rows.push(row); if (row) any = true; }
          if (!any) break;
          for (let at = 0; at < rows.length; at++) { if (at) put(at - 1); if (rows[at]) ctx.output.append(rows[at].bytes); }
          ctx.output.byte(separator);
        }
      }
      return result(ctx);
    },
    async nl(argv, stdin) {
      const ctx = invocation('nl', io, signal, limits, argv, stdin);
      const { options, operands } = parseArgs(argv, { body: flag('b', 'body-numbering', true), header: flag('h', 'header-numbering', true), footer: flag('f', 'footer-numbering', true), delimiter: flag('d', 'section-delimiter', true), increment: flag('i', 'line-increment', true), blank: flag('l', 'join-blank-lines', true), format: flag('n', 'number-format', true), noReset: flag('p', 'no-renumber'), separator: flag('s', 'number-separator', true), start: flag('v', 'starting-line-number', true), width: flag('w', 'number-width', true) }, { command: 'nl' });
      const signed = (text) => { if (!/^[+-]?\d+$/.test(text) || text.length > ctx.limits.maxDecimalDigits) fail('nl', 'invalid bounded line number'); return BigInt(text); };
      const start = signed(options.start ?? '1'), increment = signed(options.increment ?? '1'), width = count(ctx, options.width ?? '6', 'number width', 1, ctx.limits.maxOutputBytes);
      const blankGroup = count(ctx, options.blank ?? '1', 'blank line group', 1), separator = ctx.argument(options.separator ?? '\t'), format = options.format ?? 'rn';
      if (!['ln', 'rn', 'rz'].includes(format)) fail('nl', 'number format must be ln, rn, or rz');
      const styles = [options.header ?? 'n', options.body ?? 't', options.footer ?? 'n'].map((style) => {
        if (['a', 't', 'n'].includes(style)) return { style };
        if (style.startsWith('p')) return { style: 'p', regex: compile(ctx, style.slice(1)) };
        fail('nl', `invalid numbering style ${style}`);
      });
      let delimiter = ctx.argument(options.delimiter ?? '\\:'); if (delimiter.length === 1) delimiter = Uint8Array.of(delimiter[0], 58);
      const isDelimiter = (bytes, n) => delimiter.length && bytes.length === delimiter.length * n && bytes.every((byte, index) => byte === delimiter[index % delimiter.length]);
      let section = 1, number = start, blanks = 0;
      return eachSource(ctx, operands, async (source) => {
        const cursor = await source.open();
        for (;;) {
          await ctx.budget.checkpoint(); const row = await cursor.nextRecord({ separator: 10 }); if (!row) break;
          let nextSection = -1; for (let i = 0; i < 3; i++) if (isDelimiter(row.bytes, 3 - i)) nextSection = i;
          if (nextSection >= 0) { if (!options.noReset) number = start; section = nextSection; blanks = 0; ctx.output.byte(10); continue; }
          const style = styles[section]; let numbered = style.style === 'a' || style.style === 't' && row.bytes.length > 0 || style.style === 'p' && !!match(ctx, style.regex, row.bytes);
          if (style.style === 'a' && row.bytes.length === 0) numbered = ++blanks % blankGroup === 0; else blanks = 0;
          if (numbered) {
            const text = number.toString(); if (text.length > ctx.limits.maxDecimalDigits) fail('nl', 'line number exceeds the digit limit');
            const padding = Math.max(0, width - text.length);
            if (format === 'rz' && text.startsWith('-')) { ctx.output.byte(45); ctx.output.repeat(48, padding); ctx.output.argument(text.slice(1)); }
            else { if (format !== 'ln') ctx.output.repeat(format === 'rz' ? 48 : 32, padding); ctx.output.argument(text); if (format === 'ln') ctx.output.repeat(32, padding); }
            ctx.output.append(separator); number += increment;
          } else ctx.output.repeat(32, width + separator.length);
          ctx.output.append(row.bytes); ctx.output.byte(10);
        }
      });
    },
    async comm(argv, stdin) {
      const ctx = invocation('comm', io, signal, limits, argv, stdin);
      const { options, operands, occurrences } = parseArgs(argv, { one: flag('1'), two: flag('2'), both: flag('3'), zero: flag('z', 'zero-terminated'), check: flag(null, 'check-order'), noCheck: flag(null, 'nocheck-order'), delimiter: flag(null, 'output-delimiter', true) }, { command: 'comm' });
      const sources = twoInputs(ctx, operands), separator = options.zero ? 0 : 10, order = occurrences.filter((item) => ['check', 'noCheck'].includes(item.key)).at(-1)?.key !== 'noCheck';
      const ds = options.delimiter === undefined ? Uint8Array.of(9) : ctx.argument(options.delimiter === '' ? '\0' : options.delimiter);
      const left = await collect(ctx, sources[0], separator), right = await collect(ctx, sources[1], separator), rows = [left.rows, right.rows];
      if (order) for (let side = 0; side < 2; side++) for (let at = 1; at < rows[side].length; at++) {
        await ctx.budget.checkpoint(); if (compareBytes(rows[side][at - 1].bytes, rows[side][at].bytes) > 0) { ctx.output.argument(`comm: file ${side + 1} is not in sorted order\n`); return result(ctx, 1); }
      }
      const suppressed = [options.one, options.two, options.both];
      const emit = (column, row) => { if (suppressed[column]) return; for (let at = 0; at < column; at++) if (!suppressed[at]) ctx.output.append(ds); ctx.output.append(row.bytes); ctx.output.byte(separator); };
      let a = 0, b = 0;
      while (a < left.rows.length || b < right.rows.length) {
        await ctx.budget.checkpoint(); const x = left.rows[a], y = right.rows[b], order = !x ? 1 : !y ? -1 : compareBytes(x.bytes, y.bytes);
        if (order < 0) { emit(0, x); a++; } else if (order > 0) { emit(1, y); b++; } else { emit(2, x); a++; b++; }
      }
      left.release(); right.release(); return result(ctx);
    },
    async join(argv, stdin) {
      const ctx = invocation('join', io, signal, limits, argv, stdin);
      const { options, operands, occurrences } = parseArgs(argv, { one: flag('1', null, true), two: flag('2', null, true), field: flag('j', null, true), delimiter: flag('t', null, true), unmatched: { ...flag('a', null, true), multiple: true }, only: { ...flag('v', null, true), multiple: true }, empty: flag('e', null, true), output: flag('o', null, true), ignore: flag('i', 'ignore-case'), check: flag(null, 'check-order'), noCheck: flag(null, 'nocheck-order'), header: flag(null, 'header'), zero: flag('z', 'zero-terminated') }, { command: 'join' });
      const sources = twoInputs(ctx, operands), indexes = [0, 0], separator = options.zero ? 0 : 10;
      for (const item of occurrences) if (['one', 'two', 'field'].includes(item.key)) { const index = count(ctx, item.value, 'join field', 1) - 1; if (item.key !== 'two') indexes[0] = index; if (item.key !== 'one') indexes[1] = index; }
      const delimiter = options.delimiter == null ? null : ctx.argument(options.delimiter);
      if (delimiter && delimiter.length > 1) fail('join', 'field delimiter must contain at most one byte');
      const fieldSeparator = delimiter == null ? null : delimiter.length ? delimiter[0] : -1, outSeparator = delimiter?.length ? delimiter : Uint8Array.of(32), replacement = ctx.argument(options.empty ?? '');
      const selected = new Set(); for (const value of [...(options.unmatched || []), ...(options.only || [])]) { if (!['1', '2'].includes(value)) fail('join', '-a and -v require 1 or 2'); selected.add(+value - 1); }
      let output = null;
      if (options.output != null && options.output !== 'auto') {
        const spec = options.output.split(/[ ,]+/).filter(Boolean); if (!spec.length) fail('join', 'empty output format');
        output = spec.map((word) => { if (word === '0') return null; const hit = /^([12])\.([1-9]\d*)$/.exec(word); if (!hit) fail('join', `invalid output field ${word}`); return [+hit[1] - 1, count(ctx, hit[2], 'output field', 1) - 1]; });
      }
      const orderCheck = occurrences.filter((item) => ['check', 'noCheck'].includes(item.key)).at(-1)?.key !== 'noCheck';
      const raw = [await collect(ctx, sources[0], separator), await collect(ctx, sources[1], separator)], rows = [[], []];
      for (let side = 0; side < 2; side++) for (const record of raw[side].rows) {
        await ctx.budget.checkpoint(); const parts = await fields(ctx, record.bytes, fieldSeparator); ctx.budget.reserveRetained(32); rows[side].push({ parts, key: parts[indexes[side]] || empty });
      }
      const compare = (a, b) => compareBytes(a, b, { ignoreCase: !!options.ignore });
      if (orderCheck) for (let side = 0; side < 2; side++) for (let at = options.header ? 2 : 1; at < rows[side].length; at++) {
        await ctx.budget.checkpoint(); if (compare(rows[side][at - 1].key, rows[side][at].key) > 0) { ctx.output.argument(`join: input ${side + 1} is not in sorted order\n`); return result(ctx, 1); }
      }
      if (options.output === 'auto') {
        output = [null]; for (let side = 0; side < 2; side++) for (let i = 0; i < (rows[side][0]?.parts.length || 0); i++) if (i !== indexes[side]) output.push([side, i]);
      }
      const emit = (a, b) => {
        const pair = [a, b], key = (a || b)?.key || empty; let written = false;
        const field = (bytes) => { if (written) ctx.output.append(outSeparator); ctx.output.append(bytes?.length ? bytes : replacement); written = true; };
        if (output) for (const spec of output) field(spec == null ? key : pair[spec[0]]?.parts[spec[1]]);
        else { field(key); for (let side = 0; side < 2; side++) if (pair[side]) for (let at = 0; at < pair[side].parts.length; at++) if (at !== indexes[side]) field(pair[side].parts[at]); }
        ctx.output.byte(separator);
      };
      let a = 0, b = 0;
      if (options.header && (rows[0].length || rows[1].length)) { emit(rows[0][0], rows[1][0]); a = rows[0].length ? 1 : 0; b = rows[1].length ? 1 : 0; }
      while (a < rows[0].length || b < rows[1].length) {
        await ctx.budget.checkpoint(); const x = rows[0][a], y = rows[1][b], order = !x ? 1 : !y ? -1 : compare(x.key, y.key);
        if (order < 0) { if (selected.has(0)) emit(x, null); a++; }
        else if (order > 0) { if (selected.has(1)) emit(null, y); b++; }
        else {
          let ae = a + 1, be = b + 1;
          while (ae < rows[0].length && compare(rows[0][ae].key, x.key) === 0) { await ctx.budget.checkpoint(); ae++; }
          while (be < rows[1].length && compare(rows[1][be].key, y.key) === 0) { await ctx.budget.checkpoint(); be++; }
          if (!options.only) for (let i = a; i < ae; i++) for (let j = b; j < be; j++) { await ctx.budget.checkpoint(); emit(rows[0][i], rows[1][j]); }
          a = ae; b = be;
        }
      }
      for (const group of raw) group.release(); return result(ctx);
    },
    async split(argv, stdin) {
      const ctx = invocation('split', io, signal, limits, argv, stdin);
      const { options, operands, occurrences } = parseArgs(argv, { lines: flag('l', 'lines', true), bytes: flag('b', 'bytes', true), lineBytes: flag('C', 'line-bytes', true), length: flag('a', 'suffix-length', true), numeric: flag('d', 'numeric-suffixes', 'optional'), suffix: flag(null, 'additional-suffix', true) }, { command: 'split' });
      if (operands.length > 2) fail('split', 'expected at most an input and output prefix');
      const modes = occurrences.filter((item) => ['lines', 'bytes', 'lineBytes'].includes(item.key));
      if (new Set(modes.map((item) => item.key)).size > 1) fail('split', 'line, byte, and line-byte modes are mutually exclusive');
      const mode = modes.at(-1)?.key || 'lines';
      const size = (text) => {
        const hit = /^(\d+)(b|[kKMGTPE](?:i?B)?)?$/.exec(text); if (!hit) fail('split', `invalid byte count ${text}`);
        if (hit[1].length > 16) fail('split', 'byte count is out of range');
        const n = BigInt(hit[1]), suffix = hit[2] || '', exponent = suffix === 'b' ? 0 : 'KMGTPE'.indexOf(suffix[0]?.toUpperCase()) + 1;
        const multiplier = suffix === 'b' ? 512n : BigInt(suffix.endsWith('B') && !suffix.endsWith('iB') ? 1000 : 1024) ** BigInt(exponent);
        const result = n * multiplier; if (result < 1n || result > BigInt(Number.MAX_SAFE_INTEGER)) fail('split', 'byte count is out of range'); return Number(result);
      };
      const amount = mode === 'lines' ? count(ctx, options.lines ?? '1000', 'line count', 1) : size(String(options[mode]));
      let width = count(ctx, options.length ?? '0', 'suffix length', 0, Math.min(1024, ctx.limits.maxPathBytes)), numericStart = 0n;
      const fixed = width > 0 || typeof options.numeric === 'string'; if (!width) width = 2;
      if (typeof options.numeric === 'string') { if (!/^\d+$/.test(options.numeric) || options.numeric.length > width) fail('split', 'numeric suffix start exceeds the suffix length'); numericStart = BigInt(options.numeric); }
      const prefix = operands[1] ?? 'x', suffix = options.suffix ?? '';
      if (suffix.includes('/')) fail('split', 'additional suffix cannot contain a slash');
      const inspected = new Map();
      const preflightPath = async (path, destination) => {
        const parts = io.resolve(path).split('/').filter(Boolean); let current = '';
        for (let i = 0; i < parts.length; i++) {
          await ctx.budget.checkpoint(); current += (current ? '/' : '') + parts[i];
          let stat = inspected.get(current);
          if (!stat) {
            const release = ctx.budget.reserveRetained(utf8Length(current) * 2 + 128);
            try { stat = await io.stat('/' + current, { follow: false, metadataOnly: true }); inspected.set(current, stat); }
            catch (error) { release(); if (destination && i === parts.length - 1 && error instanceof IOFailure && error.code === 'ENOENT') return; throw error; }
          }
          if (stat.type === 'symlink') fail('split', 'symlinked input and output paths are unsupported');
          if (i < parts.length - 1 && stat.type !== 'dir') fail('split', 'a pathname ancestor is not a directory');
          if (destination && i === parts.length - 1 && stat.type === 'dir') fail('split', 'output pathname is a directory');
        }
      };
      const source = ctx.inputs.operands([operands[0] ?? '-'])[0];
      if (source.operand !== '-') await preflightPath(source.operand, false);
      const bytes = await (await source.open()).rest(), boundaries = [];
      if (bytes.length > ctx.budget.remaining('outputBytes')) fail('split', 'pieces exceed the aggregate output byte limit');
      let at = 0;
      while (at < bytes.length) {
        await ctx.budget.checkpoint(); let end;
        if (mode === 'bytes') end = Math.min(bytes.length, at + amount);
        else if (mode === 'lineBytes') {
          end = Math.min(bytes.length, at + amount);
          if (end < bytes.length) { let found = -1; for (let i = at; i < end; i++) { if ((i - at) % 4096 === 0) await ctx.budget.checkpoint(); if (bytes[i] === 10) found = i + 1; } if (found > at) end = found; }
        } else {
          end = at; let lines = 0;
          while (end < bytes.length && lines < amount) { if ((end - at) % 4096 === 0) await ctx.budget.checkpoint(); if (bytes[end++] === 10) lines++; }
        }
        ctx.budget.spend('files'); ctx.budget.reserveRetained(64); boundaries.push([at, end]); at = end;
      }
      const radix = options.numeric ? 10n : 26n, alphabet = options.numeric ? '0123456789' : 'abcdefghijklmnopqrstuvwxyz', destinations = [], names = new Set();
      let sequence = numericStart, extension = '';
      const normalize = (path) => {
        const normalized = io.resolve(path);
        if (/[\\\x00-\x1f]/.test(normalized) || /%(2e|2f|5c|00|25)/i.test(normalized)) fail('split', 'invalid output pathname');
        return normalized;
      };
      for (let i = 0; i < boundaries.length; i++) {
        await ctx.budget.checkpoint(); let digits = '', value = sequence;
        for (let n = 0; n < width; n++) { digits = alphabet[Number(value % radix)] + digits; value /= radix; }
        if (value) fail('split', 'output suffixes exhausted');
        if (!fixed && digits[0] === alphabet.at(-1)) { extension += alphabet.at(-1); width++; sequence = 0n; digits = alphabet[0].repeat(width); }
        const name = prefix + extension + digits + suffix;
        ctx.budget.spend('pathBytes', utf8Length(name)); ctx.budget.reserveRetained(utf8Length(name) * 2 + 32);
        const normalized = normalize(name);
        if (source.operand !== '-' && normalized === io.resolve(source.operand)) fail('split', 'output would overwrite the input file');
        if (names.has(normalized)) fail('split', 'duplicate output pathname'); names.add(normalized); await preflightPath(name, true); destinations.push(name); sequence++;
      }
      for (let i = 0; i < boundaries.length; i++) {
        await ctx.budget.checkpoint(); const part = ctx.output.fork(); part.append(bytes.subarray(...boundaries[i])); await io.write(destinations[i], part.finish()); ctx.budget.check();
      }
      return result(ctx);
    },
  };
}
