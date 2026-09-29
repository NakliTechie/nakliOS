// U1a text tools. Locale-sensitive ordering and character classes use the C
// locale; byte consumers never decode before counting, slicing, or dumping.
import { ArgError, parseArgs } from '../args.mjs';
import { IOFailure, autoData, concatData, toBytes, toText } from '../io.mjs';

const flags = (letters) => Object.fromEntries([...letters].map((short) => [short, { short }]));
const value = (short, long) => ({ short, ...(long ? { long } : {}), value: true });
const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const raw = (text, code = 0) => ({ text, code, raw: true });
const records = (text) => text === '' ? [] : (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
const lines = (items) => items.length ? items.join('\n') + '\n' : '';
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const integer = (command, text, label, { signed = false } = {}) => {
  if (!(signed ? /^[+-]?\d+$/ : /^\d+$/).test(String(text)) || !Number.isSafeInteger(Number(text))) {
    fail(command, `invalid ${label}: ${text}`);
  }
  return Number(text);
};

// Return data plus failures without catching cancellation/control-flow errors.
async function inputs(io, command, operands, stdin, { stop = false } = {}) {
  const entries = [];
  for (const path of operands.length ? operands : ['-']) {
    try { entries.push({ path, data: path === '-' ? stdin ?? '' : await io.readBytes(path) }); }
    catch (error) {
      if (!(error instanceof IOFailure)) throw error;
      entries.push({ path, error: `${command}: ${path}: ${error.code}` });
      if (stop) break;
    }
  }
  return entries;
}

function numberArgs(command, argv) {
  const normalized = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') { normalized.push(...argv.slice(i)); break; }
    normalized.push(/^-\d+$/.test(arg) ? '-n' + arg.slice(1) : arg);
    if (['-n', '-c', '--lines', '--bytes'].includes(arg) && i + 1 < argv.length) normalized.push(argv[++i]);
  }
  return parseArgs(normalized, { n: value('n', 'lines'), c: value('c', 'bytes') }, { command });
}

function lineBoundaries(bytes) {
  const ends = [];
  for (let i = 0; i < bytes.length; i++) if (bytes[i] === 10) ends.push(i + 1);
  if (bytes.length && bytes.at(-1) !== 10) ends.push(bytes.length);
  return ends;
}

function selectEnd(command, bytes, count, byteMode) {
  const n = Math.abs(Number(count)), fromStart = String(count).startsWith('+');
  const ends = byteMode ? null : lineBoundaries(bytes);
  const length = byteMode ? bytes.length : ends.length;
  const boundary = (index) => byteMode ? index : index <= 0 ? 0 : ends[index - 1] ?? bytes.length;
  let begin = 0, end = length;
  if (command === 'head') end = String(count).startsWith('-') ? Math.max(0, length - n) : Math.min(length, n);
  else begin = fromStart ? Math.min(length, Math.max(0, n - 1)) : Math.max(0, length - n);
  return bytes.slice(boundary(begin), boundary(end));
}

function sortKey(spec) {
  const m = /^(\d+)(?:\.(\d+))?([bdfghnVr]*)(?:,(\d+)(?:\.(\d+))?([bdfghnVr]*))?$/.exec(spec);
  if (!m || +m[1] < 1 || (m[2] != null && +m[2] < 1) || (m[4] != null && +m[4] < 1)) fail('sort', `invalid key: ${spec}`);
  for (const n of [m[1], m[2], m[4], m[5]].filter((x) => x != null)) integer('sort', n, 'key position');
  if (m[4] && (+m[4] < +m[1] || (+m[4] === +m[1] && m[5] && +m[5] < +(m[2] || 1)))) fail('sort', `invalid key range: ${spec}`);
  const modifiers = m[3] + (m[6] || '');
  return { first: +m[1], char: +(m[2] || 1), last: m[4] ? +m[4] : null,
    lastChar: +(m[5] || 0), modifiers, startBlank: m[3].includes('b'), endBlank: (m[6] || '').includes('b') };
}

function fieldSpans(line, separator) {
  if (separator != null) {
    const spans = []; let start = 0, end;
    while ((end = line.indexOf(separator, start)) !== -1) { spans.push([start, end]); start = end + separator.length; }
    spans.push([start, line.length]); return spans;
  }
  const spans = []; let end = 0;
  for (const match of line.matchAll(/[^\t ]+/g)) { spans.push([end, match.index + match[0].length]); end = match.index + match[0].length; }
  return spans;
}

function extractKey(line, key, separator, options) {
  if (!key) return options.b ? line.replace(/^[\t ]+/, '') : line;
  const spans = fieldSpans(line, separator), first = spans[key.first - 1];
  if (!first) return '';
  const unblank = (start, end) => start + (line.slice(start, end).match(/^[\t ]*/)?.[0].length || 0);
  let start = first[0];
  if (key.startBlank || (!key.modifiers && options.b)) start = unblank(start, first[1]);
  start = Math.min(line.length, start + key.char - 1);
  let end = line.length;
  if (key.last != null) {
    const last = spans[key.last - 1];
    if (last) {
      let lastStart = last[0];
      if (key.endBlank || (!key.modifiers && options.b)) lastStart = unblank(lastStart, last[1]);
      end = key.lastChar ? Math.min(line.length, lastStart + key.lastChar) : last[1];
    }
  }
  return line.slice(start, Math.max(start, end));
}

function versionCompare(a, b) {
  const digit = (c) => c != null && c >= '0' && c <= '9';
  const order = (c) => c === '~' ? -1 : c == null || digit(c) ? 0 : /[A-Za-z]/.test(c) ? c.charCodeAt(0) : c.charCodeAt(0) + 256;
  if (a.startsWith('.') !== b.startsWith('.')) return a.startsWith('.') ? -1 : 1;
  let ai = 0, bi = 0;
  while (ai < a.length || bi < b.length) {
    while ((ai < a.length && !digit(a[ai])) || (bi < b.length && !digit(b[bi]))) {
      const c = compare(order(a[ai]), order(b[bi])); if (c) return c;
      if (ai < a.length) ai++; if (bi < b.length) bi++;
    }
    while (a[ai] === '0') ai++; while (b[bi] === '0') bi++;
    const firstA = ai, firstB = bi;
    while (digit(a[ai])) ai++; while (digit(b[bi])) bi++;
    const c = compare(ai - firstA, bi - firstB) || compare(a.slice(firstA, ai), b.slice(firstB, bi));
    if (c) return c;
  }
  return 0;
}

// -n compares decimal strings exactly. Floating conversion would collapse two
// adjacent large integers under -u, or lose significant fractional digits.
function decimalNumber(text) {
  const m = /^\s*([+-]?)(\d*)(?:\.(\d*))?/.exec(text);
  const whole = (m?.[2] || '').replace(/^0+/, '') || '0';
  const fraction = (m?.[3] || '').replace(/0+$/, '');
  const sign = whole === '0' && !fraction ? 0 : m[1] === '-' ? -1 : 1;
  return { whole, fraction, sign };
}

function decimalCompare(a, b) {
  const sign = compare(a.sign, b.sign); if (sign) return sign;
  const width = Math.max(a.fraction.length, b.fraction.length);
  return a.sign * (compare(a.whole.length, b.whole.length) || compare(a.whole, b.whole)
    || compare(a.fraction.padEnd(width, '0'), b.fraction.padEnd(width, '0')));
}

function keyCompare(a, b, options) {
  const transform = (s) => {
    if (options.b) s = s.replace(/^[\t ]+/, '');
    if (options.d) s = s.replace(/[^A-Za-z0-9\t ]/g, '');
    if (options.f) s = s.toLowerCase();
    return s;
  };
  a = transform(a); b = transform(b);
  let c;
  if (options.V) c = versionCompare(a, b);
  else if (options.h) {
    // Human order compares sign, suffix rank, then value within that rank.
    const human = (s) => {
      const m = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+))([kKMGTPEZYRQ]?)/.exec(s);
      return { number: decimalNumber(m?.[1] || ''), power: m?.[2] ? 'KMGTPEZYRQ'.indexOf(m[2].toUpperCase()) + 1 : 0 };
    };
    const x = human(a), y = human(b), sign = x.number.sign;
    c = compare(sign, y.number.sign) || sign * compare(x.power, y.power) || decimalCompare(x.number, y.number);
  } else if (options.n) c = decimalCompare(decimalNumber(a), decimalNumber(b));
  else if (options.g) {
    const x = parseFloat(a), y = parseFloat(b);
    c = Number.isNaN(x) ? Number.isNaN(y) ? 0 : -1 : Number.isNaN(y) ? 1 : compare(x, y);
  } else c = compare(a, b);
  return options.r ? -c : c;
}

function selection(command, spec) {
  const ranges = String(spec).split(',').map((part) => {
    const m = /^(?:(\d+)(?:-(\d*)?)?|-(\d+))$/.exec(part);
    if (!m) fail(command, `invalid list: ${spec}`);
    const start = m[3] ? 1 : Number(m[1]);
    const end = m[3] ? Number(m[3]) : part.includes('-') ? m[2] ? Number(m[2]) : Infinity : start;
    if (!Number.isSafeInteger(start) || start < 1 || (end !== Infinity && (!Number.isSafeInteger(end) || end < start))) fail(command, `invalid list: ${spec}`);
    return [start, end];
  });
  return (i) => ranges.some(([start, end]) => i >= start && i <= end);
}

const escapeChars = { a: '\x07', b: '\b', e: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\' };
function escapeAt(text, at, octalZero = false) {
  const c = text[at + 1];
  if (c === 'c') return { data: '', end: at + 2, stopped: true };
  if (c in escapeChars) return { data: escapeChars[c], end: at + 2 };
  const tail = text.slice(at + 1);
  const oct = (octalZero ? /^0([0-7]{0,3})/ : /^([0-7]{1,3})/).exec(tail);
  if (oct) return { data: Uint8Array.of(parseInt(oct[1] || '0', 8) & 255), end: at + 1 + oct[0].length };
  const hex = /^x([0-9a-f]{1,2})/i.exec(tail);
  if (hex) return { data: Uint8Array.of(parseInt(hex[1], 16)), end: at + 1 + hex[0].length };
  const unicode = /^(?:u([0-9a-f]{4})|U([0-9a-f]{8}))/i.exec(tail);
  if (unicode) {
    const cp = parseInt(unicode[1] || unicode[2], 16);
    if (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) fail('printf', 'invalid Unicode escape');
    return { data: String.fromCodePoint(cp), end: at + 1 + unicode[0].length };
  }
  return { data: c == null ? '\\' : '\\' + c, end: at + (c == null ? 1 : 2) };
}

function escapes(text, octalZero = false) {
  const parts = [];
  for (let i = 0; i < text.length;) {
    if (text[i] !== '\\') { const cp = String.fromCodePoint(text.codePointAt(i)); parts.push(cp); i += cp.length; continue; }
    const result = escapeAt(text, i, octalZero); parts.push(result.data); i = result.end;
    if (result.stopped) return { data: concatData(parts), stopped: true };
  }
  return { data: concatData(parts), stopped: false };
}

const CLASS = {
  alnum: (c) => /[A-Za-z0-9]/.test(c), alpha: (c) => /[A-Za-z]/.test(c),
  blank: (c) => c === ' ' || c === '\t', cntrl: (_, n) => n < 32 || n === 127,
  digit: (c) => /[0-9]/.test(c), graph: (_, n) => n >= 33 && n <= 126,
  lower: (c) => /[a-z]/.test(c), print: (_, n) => n >= 32 && n <= 126,
  punct: (c, n) => n >= 33 && n <= 126 && !/[A-Za-z0-9]/.test(c),
  space: (c) => /[\t\n\v\f\r ]/.test(c), upper: (c) => /[A-Z]/.test(c),
  xdigit: (c) => /[A-Fa-f0-9]/.test(c),
};

function trSet(source) {
  const items = [];
  for (let i = 0; i < source.length;) {
    const named = /^\[:([a-z]+):\]/.exec(source.slice(i));
    if (named) {
      const predicate = CLASS[named[1]];
      if (!predicate) fail('tr', `unknown character class: ${named[1]}`);
      items.push({ values: Array.from({ length: 256 }, (_, n) => n).filter((n) => predicate(String.fromCharCode(n), n)) });
      i += named[0].length; continue;
    }
    if (source[i] === '\\') {
      const e = escapeAt(source, i); if (e.stopped) fail('tr', 'unsupported escape: \\c');
      const data = typeof e.data === 'string' && e.data.length === 2 && e.data[0] === '\\' ? e.data.slice(1) : e.data;
      items.push({ values: [...toBytes(data)] }); i = e.end; continue;
    }
    const cp = String.fromCodePoint(source.codePointAt(i));
    items.push({ values: [...toBytes(cp)], dash: cp === '-' }); i += cp.length;
  }
  const out = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].values.length === 1 && items[i + 1]?.dash && items[i + 2]?.values.length === 1) {
      const start = items[i].values[0], end = items[i + 2].values[0];
      if (start > end) fail('tr', 'range endpoints are reversed');
      for (let n = start; n <= end; n++) out.push(n);
      i += 2;
    } else out.push(...items[i].values);
  }
  return out;
}

function formatTokens(format) {
  const tokens = [];
  for (let i = 0; i < format.length;) {
    if (format[i] === '\\') { const e = escapeAt(format, i); tokens.push({ literal: e.data, stopped: e.stopped }); i = e.end; if (e.stopped) break; continue; }
    if (format[i] !== '%') { const cp = String.fromCodePoint(format.codePointAt(i)); tokens.push({ literal: cp }); i += cp.length; continue; }
    const match = /^%([-+ #0]*)(\d+|\*)?(?:\.(\d*|\*))?([%sdiuoxXfFeEgGcb])/.exec(format.slice(i));
    if (!match) fail('printf', `unsupported format near ${format.slice(i, i + 16)}; supports %s %d %i %u %x %X %o %f %F %e %E %g %G %c %b %%`);
    tokens.push({ modifiers: match[1], width: match[2], precision: match[3], type: match[4] }); i += match[0].length;
  }
  return tokens;
}

function printfCommand(argv) {
  const { operands } = parseArgs(argv, {}, { command: 'printf', stopAtOperand: true });
  if (!operands.length) return raw('');
  const tokens = formatTokens(operands[0]), args = operands.slice(1), parts = [];
  let ai = 0, bad = null, stopped = false;
  const take = () => ai < args.length ? args[ai++] : '';
  const numeric = (input, floating = false) => {
    const text = String(input).trim();
    if (text === '') return floating ? 0 : 0n;
    if (/^['"]./u.test(text)) return floating ? text.codePointAt(1) : BigInt(text.codePointAt(1));
    if (floating) {
      const n = Number(text); if (!Number.isNaN(n) || /^[-+]?nan$/i.test(text)) return n;
      bad ??= input; return parseFloat(text) || 0;
    }
    const sign = text[0] === '-' ? -1n : 1n, unsigned = text.replace(/^[-+]/, '');
    if (/^0x[0-9a-f]+$/i.test(unsigned)) return sign * BigInt(unsigned);
    if (/^0[0-7]+$/.test(unsigned)) return sign * BigInt('0o' + unsigned.slice(1));
    if (/^(?:0|[1-9]\d*)$/.test(unsigned)) return sign * BigInt(unsigned);
    bad ??= input; return BigInt(parseInt(text, 10) || 0);
  };
  do {
    const before = ai;
    for (const token of tokens) {
      if ('literal' in token) { parts.push(token.literal); if (token.stopped) { stopped = true; break; } continue; }
      const { type } = token;
      if (type === '%') { parts.push('%'); continue; }
      let modifiers = token.modifiers;
      let width = token.width === '*' ? Number(numeric(take())) : Number(token.width || 0);
      let precision = token.precision === undefined ? null : token.precision === '*' ? Number(numeric(take())) : Number(token.precision || 0);
      if (width < 0) { modifiers += '-'; width = -width; }
      if (precision < 0) precision = null;
      if (!Number.isSafeInteger(width) || width > 100000 || (precision != null && (!Number.isSafeInteger(precision) || precision > 100000))) fail('printf', 'width or precision exceeds 100000');
      const input = take(); let result, numericOutput = false, prefix = '';
      if (type === 's' || type === 'c') result = type === 'c' ? [...input][0] || '\0' : precision == null ? input : [...input].slice(0, precision).join('');
      else if (type === 'b') {
        const expanded = escapes(input, true); result = expanded.data; stopped = expanded.stopped;
        if (precision != null) result = toBytes(result).slice(0, precision);
      } else if ('diuoxX'.includes(type)) {
        numericOutput = true;
        let n = numeric(input), radix = 'xX'.includes(type) ? 16 : type === 'o' ? 8 : 10;
        if ('uoxX'.includes(type)) n = BigInt.asUintN(64, n);
        else if (n < 0) { prefix = '-'; n = -n; }
        else if (modifiers.includes('+')) prefix = '+'; else if (modifiers.includes(' ')) prefix = ' ';
        result = n === 0n && precision === 0 ? '' : n.toString(radix);
        if (precision != null) result = result.padStart(precision, '0');
        if (modifiers.includes('#')) {
          if (type === 'o' && !result.startsWith('0')) prefix += '0';
          if ('xX'.includes(type) && n !== 0n) prefix += type === 'X' ? '0X' : '0x';
        }
        if (type === 'X') result = result.toUpperCase();
      } else {
        numericOutput = true;
        const n = numeric(input, true), p = precision == null ? 6 : precision;
        if (p > 100) fail('printf', 'floating-point precision exceeds 100');
        const magnitude = Math.abs(n);
        result = 'fF'.includes(type) ? magnitude.toFixed(p) : 'eE'.includes(type) ? magnitude.toExponential(p) : magnitude.toPrecision(p || 1);
        if ('gG'.includes(type) && !modifiers.includes('#')) result = result.replace(/(\.\d*?)0+(e|$)/, '$1$2').replace(/\.(e|$)/, '$1');
        if (modifiers.includes('#') && !result.includes('.') && Number.isFinite(n)) result = result.replace(/(e|$)/, '.$1');
        result = result.replace(/e([+-])(\d)$/, 'e$10$2');
        if (n < 0 || Object.is(n, -0)) prefix = '-'; else if (modifiers.includes('+')) prefix = '+'; else if (modifiers.includes(' ')) prefix = ' ';
        if (type === type.toUpperCase()) result = result.toUpperCase();
      }
      const length = typeof result === 'string' ? [...result].length : result.length;
      const padding = ' '.repeat(Math.max(0, width - length - prefix.length));
      if (numericOutput && modifiers.includes('0') && !modifiers.includes('-') && (precision == null || !'diuoxX'.includes(type))) parts.push(prefix, '0'.repeat(padding.length), result);
      else if (modifiers.includes('-')) parts.push(prefix, result, padding);
      else parts.push(padding, prefix, result);
      if (stopped) break;
    }
    if (stopped || ai === before) break;
  } while (ai < args.length);
  let output = concatData(parts);
  if (bad != null) {
    const bytes = toBytes(output);
    output = concatData([output, bytes.length && bytes.at(-1) !== 10 ? '\n' : '', `printf: ${bad}: invalid number`]);
  }
  return raw(autoData(output), bad == null ? 0 : 1);
}

export function createTextCommands(io) {
  const endCommand = (command) => async (argv, stdin = '') => {
    const { operands, occurrences } = numberArgs(command, argv);
    const selected = occurrences.at(-1), byteMode = selected?.key === 'c', count = selected?.value ?? '10';
    integer(command, count, byteMode ? 'byte count' : 'line count', { signed: true });
    const entries = await inputs(io, command, operands, stdin), out = []; let failed = false;
    for (const entry of entries) {
      if (out.length && operands.length > 1) out.push('\n');
      if (entry.error) { out.push(entry.error + '\n'); failed = true; continue; }
      if (operands.length > 1) out.push(`==> ${entry.path === '-' ? 'standard input' : entry.path} <==\n`);
      out.push(selectEnd(command, toBytes(entry.data), count, byteMode));
    }
    return raw(autoData(concatData(out)), failed ? 1 : 0);
  };
  return {
    head: endCommand('head'), tail: endCommand('tail'),
    async wc(argv, stdin = '') {
      const { options, operands } = parseArgs(argv, flags('lwcm'), { command: 'wc' });
      const columns = ['l', 'w', 'm', 'c'].filter((key) => options[key]); if (!columns.length) columns.push('l', 'w', 'c');
      const entries = await inputs(io, 'wc', operands, stdin), total = { l: 0, w: 0, m: 0, c: 0 }, output = []; let failed = false;
      const row = (count) => columns.map((key) => count[key]).join(' ');
      for (const entry of entries) {
        if (entry.error) { output.push(entry.error); failed = true; continue; }
        const bytes = toBytes(entry.data), text = toText(bytes);
        const count = { l: lineBoundaries(bytes).length, w: text.split(/\s+/u).filter(Boolean).length, m: [...text].length, c: bytes.length };
        for (const key of Object.keys(total)) total[key] += count[key];
        output.push(row(count) + (operands.length > 1 ? ' ' + entry.path : ''));
      }
      if (operands.length > 1) output.push(row(total) + ' total');
      return raw(lines(output), failed ? 1 : 0);
    },
    async sort(argv, stdin = '') {
      const { options, operands } = parseArgs(argv, { ...flags('rnufhVsbdgc'),
        k: { ...value('k', 'key'), multiple: true }, t: value('t', 'field-separator'), o: value('o', 'output') }, { command: 'sort' });
      if (options.t != null && [...options.t].length !== 1) fail('sort', 'field separator must be one character');
      if (['n', 'g', 'h', 'V'].filter((key) => options[key]).length > 1) fail('sort', 'numeric, general-numeric, human-numeric and version modes are mutually exclusive');
      if (options.c && options.o != null) fail('sort', '-c cannot be combined with -o');
      const keys = (options.k || []).map(sortKey);
      for (const key of keys) if (['n', 'g', 'h', 'V'].filter((ch) => key.modifiers.includes(ch)).length > 1) fail('sort', 'incompatible key ordering modes');
      const entries = await inputs(io, 'sort', operands, stdin, { stop: true });
      const error = entries.find((entry) => entry.error); if (error) return raw(error.error, 1);
      const input = entries.flatMap((entry) => records(toText(entry.data)));
      const byKey = (a, b) => {
        for (const key of keys.length ? keys : [null]) {
          const modifiers = key?.modifiers ? Object.fromEntries([...key.modifiers].map((ch) => [ch, true])) : options;
          const c = keyCompare(extractKey(a, key, options.t, options), extractKey(b, key, options.t, options), modifiers);
          if (c) return c;
        }
        return 0;
      };
      const order = (a, b) => byKey(a, b) || (options.s || options.u ? 0 : (options.r ? -1 : 1) * compare(a, b));
      if (options.c) {
        for (let i = 1; i < input.length; i++) if (order(input[i - 1], input[i]) > 0 || (options.u && byKey(input[i - 1], input[i]) === 0)) return raw(`sort: disorder at line ${i + 1}: ${input[i]}\n`, 1);
        return raw('');
      }
      let sorted = input.slice().sort(order);
      if (options.u) sorted = sorted.filter((line, i) => i === 0 || byKey(sorted[i - 1], line) !== 0);
      const output = lines(sorted);
      if (options.o != null) { await io.write(options.o, output); return raw(''); }
      return raw(output);
    },
    async uniq(argv, stdin = '') {
      const { options, operands } = parseArgs(argv, { ...flags('cdui'), f: value('f', 'skip-fields'), s: value('s', 'skip-chars'), w: value('w', 'check-chars') }, { command: 'uniq' });
      if (operands.length > 1) fail('uniq', `an OUTPUT operand ('${operands[1]}') is not supported; redirect instead: uniq INPUT > OUTPUT`);
      const skipFields = integer('uniq', options.f ?? '0', 'field count'), skipChars = integer('uniq', options.s ?? '0', 'character count');
      const width = options.w == null ? Infinity : integer('uniq', options.w, 'comparison width');
      const entries = await inputs(io, 'uniq', operands, stdin, { stop: true });
      if (entries[0].error) return raw(entries[0].error, 1);
      const key = (line) => {
        let text = line;
        for (let i = 0; i < skipFields && text; i++) text = text.replace(/^[\t ]*[^\t ]*/, '');
        text = [...text].slice(skipChars, skipChars + width).join('');
        return options.i ? text.toLowerCase() : text;
      };
      const groups = [];
      for (const line of records(toText(entries[0].data))) {
        const k = key(line), previous = groups.at(-1);
        if (previous?.key === k) previous.count++; else groups.push({ key: k, line, count: 1 });
      }
      return raw(lines(groups.filter((group) => (!options.d || group.count > 1) && (!options.u || group.count === 1))
        .map((group) => (options.c ? String(group.count).padStart(7) + ' ' : '') + group.line)));
    },
    async cut(argv, stdin = '') {
      const { options, operands } = parseArgs(argv, { b: value('b', 'bytes'), c: value('c', 'characters'), f: value('f', 'fields'),
        d: value('d', 'delimiter'), s: { short: 's', long: 'only-delimited' }, complement: { long: 'complement' }, outputDelimiter: { long: 'output-delimiter', value: true } }, { command: 'cut' });
      const modes = ['b', 'c', 'f'].filter((mode) => options[mode] != null);
      if (modes.length !== 1) fail('cut', 'specify exactly one of -b, -c or -f');
      const mode = modes[0], selected = selection('cut', options[mode]), delimiter = options.d ?? '\t';
      if ([...delimiter].length !== 1) fail('cut', 'delimiter must be one character');
      if (mode !== 'f' && (options.d != null || options.s)) fail('cut', '-d and -s require -f');
      const want = (i) => selected(i) !== !!options.complement;
      const entries = await inputs(io, 'cut', operands, stdin);
      // Keep the existing merged-stream contract: read failures lead the
      // selected data, regardless of the missing operand's position.
      const errors = entries.filter((entry) => entry.error).map((entry) => entry.error);
      const output = errors.length ? [lines(errors)] : [];
      for (const entry of entries) {
        if (entry.error) continue;
        const bytes = toBytes(entry.data); let begin = 0;
        for (const end of lineBoundaries(bytes)) {
          const hasNewline = bytes[end - 1] === 10, record = bytes.slice(begin, hasNewline ? end - 1 : end); begin = end;
          if (mode === 'b') {
            const groups = []; let previous = -2;
            for (let i = 0; i < record.length; i++) if (want(i + 1)) {
              if (options.outputDelimiter != null && groups.length && previous !== i - 1) groups.push(options.outputDelimiter);
              groups.push(record.slice(i, i + 1)); previous = i;
            }
            output.push(concatData(groups), hasNewline ? '\n' : ''); continue;
          }
          const text = toText(record);
          if (mode === 'f' && !text.includes(delimiter)) { if (!options.s) output.push(text, hasNewline ? '\n' : ''); continue; }
          const units = mode === 'f' ? text.split(delimiter) : [...text];
          const chosen = []; let previous = -2;
          for (let i = 0; i < units.length; i++) if (want(i + 1)) {
            if (chosen.length && (mode === 'f' || (options.outputDelimiter != null && previous !== i - 1))) chosen.push(options.outputDelimiter ?? delimiter);
            chosen.push(units[i]); previous = i;
          }
          output.push(chosen.join(''), hasNewline ? '\n' : '');
        }
      }
      return raw(autoData(concatData(output)), errors.length ? 1 : 0);
    },
    tr(argv, stdin = '') {
      const { options, operands } = parseArgs(argv, { ...flags('ds'), complement: { short: ['c', 'C'], long: 'complement' } }, { command: 'tr' });
      const required = options.d ? options.s ? 2 : 1 : options.s && operands.length === 1 ? 1 : 2;
      if (operands.length !== required) fail('tr', `expected ${required} set operand${required === 1 ? '' : 's'}`);
      let from = trSet(operands[0]), to = operands[1] == null ? [] : trSet(operands[1]);
      if (options.complement) { const excluded = new Set(from); from = Array.from({ length: 256 }, (_, n) => n).filter((n) => !excluded.has(n)); }
      const translating = !options.d && operands.length === 2;
      if (translating && !to.length) fail('tr', 'STRING2 must not be empty');
      const fromSet = new Set(from), mapping = new Map(from.map((n, i) => [n, to[Math.min(i, to.length - 1)]]));
      const squeeze = new Set(operands.length === 2 ? to : from), output = [];
      for (const byte of toBytes(stdin)) {
        if (options.d && fromSet.has(byte)) continue;
        const next = translating && mapping.has(byte) ? mapping.get(byte) : byte;
        if (options.s && output.at(-1) === next && squeeze.has(next)) continue;
        output.push(next);
      }
      return raw(autoData(Uint8Array.from(output)));
    },
    echo(argv) {
      const { options, operands, occurrences } = parseArgs(argv, flags('neE'), { command: 'echo', stopAtOperand: true });
      const mode = occurrences.filter(({ key }) => key === 'e' || key === 'E').at(-1)?.key;
      const expanded = mode === 'e' ? escapes(operands.join(' '), true) : { data: operands.join(' '), stopped: false };
      return raw(autoData(concatData([expanded.data, options.n || expanded.stopped ? '' : '\n'])));
    },
    printf: printfCommand,
    async od(argv, stdin = '') {
      const { options, operands, occurrences } = parseArgs(argv, { ...flags('cbxod'), t: { ...value('t', 'format'), multiple: true },
        A: value('A', 'address-radix'), N: value('N', 'read-bytes'), j: value('j', 'skip-bytes') }, { command: 'od' });
      const radix = options.A ?? 'o'; if (!['o', 'd', 'x', 'n'].includes(radix)) fail('od', 'address radix must be o, d, x or n');
      const types = occurrences.filter(({ key }) => 'cbxodt'.includes(key)).map(({ key, value: format }) => ({ c: 'c', b: 'o1', x: 'x2', o: 'o2', d: 'u2' })[key] || format);
      if (!types.length) fail('od', 'give a format; od supports -c -b -x -o -d -t x1 -t c -A -N -j');
      for (const type of types) if (type !== 'c' && !/^[xoud][1248]$/.test(type)) fail('od', `unsupported type ${type}; supported types: c x1 x2 x4 x8 o1 o2 o4 o8 u1 u2 u4 u8 d1 d2 d4 d8`);
      const size = (text, label) => {
        const m = /^(0x[0-9a-f]+|\d+)([bkmgt]?)$/i.exec(text);
        if (!m) fail('od', `invalid ${label}: ${text}`);
        const n = Number(m[1]) * ({ '': 1, b: 512, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()]);
        if (!Number.isSafeInteger(n)) fail('od', `${label} exceeds safe integer range`); return n;
      };
      const skip = size(options.j ?? '0', 'skip count'), maximum = options.N == null ? Infinity : size(options.N, 'read count');
      const entries = await inputs(io, 'od', operands, stdin), errors = entries.filter((e) => e.error).map((e) => e.error);
      const all = toBytes(concatData(entries.filter((e) => !e.error).map((e) => e.data)));
      if (skip > all.length) return raw(lines([...errors, 'od: cannot skip past end of input']), 1);
      const bytes = all.slice(skip, Math.min(all.length, skip + maximum)), out = [...errors];
      const address = (n) => n.toString({ o: 8, d: 10, x: 16 }[radix]).padStart(7, '0');
      const escaped = { 0: '\\0', 7: '\\a', 8: '\\b', 9: '\\t', 10: '\\n', 11: '\\v', 12: '\\f', 13: '\\r' };
      for (let start = 0; start < bytes.length; start += 16) {
        const row = bytes.slice(start, start + 16);
        types.forEach((type, ti) => {
          const cells = [];
          if (type === 'c') for (const b of row) cells.push((escaped[b] ?? (b >= 32 && b < 127 ? String.fromCharCode(b) : b.toString(8).padStart(3, '0'))).padStart(4));
          else {
            const length = +type[1], base = type[0] === 'x' ? 16 : type[0] === 'o' ? 8 : 10;
            const width = type[0] === 'x' ? length * 2 : type[0] === 'o' ? Math.ceil(length * 8 / 3) : type[0] === 'd' ? String(-(2n ** BigInt(length * 8 - 1))).length : String(2n ** BigInt(length * 8) - 1n).length;
            for (let i = 0; i < row.length; i += length) {
              let n = 0n; for (let j = 0; j < length; j++) n |= BigInt(row[i + j] || 0) << BigInt(j * 8);
              if (type[0] === 'd') n = BigInt.asIntN(length * 8, n);
              cells.push(' ' + n.toString(base).padStart(width, type[0] === 'x' || type[0] === 'o' ? '0' : ' '));
            }
          }
          out.push((radix === 'n' ? '' : ti === 0 ? address(skip + start) : ' '.repeat(7)) + cells.join(''));
        });
      }
      if (radix !== 'n') out.push(address(skip + bytes.length));
      return raw(lines(out), errors.length ? 1 : 0);
    },
  };
}
