// Bounded byte-oriented numeric tools with exact integers and decimal stepping.
import { ArgError, parseArgs } from '../args.mjs';
import { autoData, renderData } from '../io.mjs';
import { createU2Context, utf8Length, parseCount, compareBytes } from './u2-common.mjs';
import { createDecimalMath } from './u2-decimal.mjs';
import { createRepeatStream } from './streams.mjs';
import { parseRegex, findRegex } from './records-regex.mjs';

class NumericInputError extends Error {}
const fail = (command, message) => { throw new ArgError(`${command}: ${message}`); };
const flag = (short, long, value = false) => ({ ...(short ? { short } : {}), ...(long ? { long } : {}), ...(value ? { value } : {}) });
const encoder = new TextEncoder(), empty = new Uint8Array();
const binary = (bytes) => { const parts = []; for (let at = 0; at < bytes.length; at += 4096) parts.push(String.fromCharCode(...bytes.subarray(at, at + 4096))); return parts.join(''); };
const isSpace = (byte) => byte === 32 || byte >= 9 && byte <= 13;
const count = (ctx, text, label, min = 0, max = Number.MAX_SAFE_INTEGER) => parseCount(String(text), { command: ctx.command, label, min, max });
function invocation(command, io, signal, limits, argv, stdin) {
  const ctx = createU2Context({ command, io, signal, limits, stdin });
  for (const arg of argv) ctx.budget.spend('argumentBytes', utf8Length(arg) + 1);
  ctx.argument = (text) => { if (utf8Length(text) > ctx.limits.maxArgumentBytes) fail(command, 'argument exceeds the byte limit'); return encoder.encode(text); };
  return ctx;
}
const result = (ctx, code = 0) => ({ text: ctx.output.finish(), code, raw: true });
const decimal = (ctx) => createDecimalMath({ budget: ctx.budget, maxDigits: ctx.limits.maxDecimalDigits, maxScale: ctx.limits.maxDecimalScale, maxExponent: ctx.limits.maxExponent });
function decimalFormat(ctx, format, { onlyFixed = false } = {}) {
  let prefix = '', suffix = '', spec = null;
  for (let at = 0; at < format.length;) {
    if (format[at] !== '%') { if (spec) suffix += format[at++]; else prefix += format[at++]; continue; }
    if (format[at + 1] === '%') { if (spec) suffix += '%'; else prefix += '%'; at += 2; continue; }
    if (spec) fail(ctx.command, 'format requires exactly one numeric directive');
    const hit = /^%([-+ #0']*)(\d*)(?:\.(\d+))?([aAeEfFgG])/.exec(format.slice(at));
    if (!hit || /[aA]/.test(hit[4]) || onlyFixed && !/[fF]/.test(hit[4])) fail(ctx.command, 'unsupported numeric format directive');
    spec = { flags: hit[1], width: count(ctx, hit[2] || '0', 'format width', 0, ctx.limits.maxOutputBytes), precision: hit[3] == null ? null : count(ctx, hit[3], 'format precision', 0, ctx.limits.maxDecimalScale), type: hit[4] };
    at += hit[0].length;
  }
  if (!spec) fail(ctx.command, 'format requires one numeric directive');
  return { ...spec, prefix, suffix };
}
function formatDecimal(ctx, math, value, spec, rounding = 'half-even') {
  let v = math.abs(value), digits = math.digits(v), exponent = v.coefficient === 0n ? 0 : digits - v.scale - 1;
  let type = spec.type.toLowerCase(), precision = spec.precision ?? 6, text;
  const expText = (exponent) => (spec.type === spec.type.toUpperCase() ? 'E' : 'e') + (exponent < 0 ? '-' : '+') + String(Math.abs(exponent)).padStart(2, '0');
  const scientific = (places) => {
    const power = math.parse('1e' + Math.abs(exponent), { exponent: true });
    let mantissa = exponent >= 0 ? math.divide(v, power, { scale: places, rounding }) : math.quantize(math.multiply(v, power), places, rounding);
    if (math.compare(mantissa, math.integer(10n)) >= 0) { exponent++; mantissa = math.divide(mantissa, math.integer(10n), { scale: places, rounding }); }
    let body = math.toFixed(mantissa, { scale: places }); if (places === 0 && spec.flags.includes('#')) body += '.';
    return [body, expText(exponent)];
  };
  if (type === 'g') {
    precision = Math.max(1, precision);
    const pair = scientific(precision - 1);
    if (exponent < -4 || exponent >= precision) text = (spec.flags.includes('#') ? pair[0] : pair[0].replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')) + pair[1];
    else { text = math.toFixed(v, { scale: Math.max(0, precision - exponent - 1), rounding }); if (!spec.flags.includes('#')) text = text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''); else if (!text.includes('.')) text += '.'; }
  } else if (type === 'e') text = scientific(precision).join('');
  else { text = math.toFixed(v, { scale: precision, rounding }); if (!precision && spec.flags.includes('#')) text += '.'; }
  const sign = value.coefficient < 0n ? '-' : spec.flags.includes('+') ? '+' : spec.flags.includes(' ') ? ' ' : '';
  const padding = Math.max(0, spec.width - sign.length - text.length);
  const projected = spec.prefix.length + spec.suffix.length + sign.length + text.length + padding;
  if (projected > ctx.budget.remaining('outputBytes')) fail(ctx.command, 'formatted value exceeds the output limit');
  const release = ctx.budget.reserveRetained(projected * 2);
  try {
  if (spec.flags.includes('-')) text = sign + text + ' '.repeat(padding);
  else if (spec.flags.includes('0')) text = sign + '0'.repeat(padding) + text;
  else text = ' '.repeat(padding) + sign + text;
  return spec.prefix + text + spec.suffix;
  } finally { release(); }
}
async function tokens(ctx, bytes) {
  const result = []; let at = 0;
  while (at < bytes.length) {
    while (at < bytes.length && isSpace(bytes[at])) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; }
    const start = at;
    while (at < bytes.length && !isSpace(bytes[at])) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; }
    if (at > start) { ctx.budget.spend('records'); ctx.budget.reserveRetained(32); result.push(bytes.subarray(start, at)); }
  }
  return result;
}

export function createNumericCommands(io, { signal = () => null, randomBytes, limits = {} } = {}) {
  const entropy = randomBytes ?? ((count) => {
    if (!globalThis.crypto?.getRandomValues) fail('shuf', 'platform randomness is unavailable');
    return globalThis.crypto.getRandomValues(new Uint8Array(count));
  });
  return {
    async seq(argv, stdin) {
      const ctx = invocation('seq', io, signal, limits, argv, stdin), math = decimal(ctx);
      const { options, operands } = parseArgs(argv, { separator: flag('s', 'separator', true), equal: flag('w', 'equal-width'), format: flag('f', 'format', true) }, { command: 'seq', negativeNumbers: true });
      if (operands.length < 1 || operands.length > 3) fail('seq', 'expected one, two, or three numeric operands');
      if (options.equal && options.format != null) fail('seq', '-w and -f are mutually exclusive');
      const values = operands.map((text) => math.parse(text, { exponent: true }));
      const start = operands.length === 1 ? math.integer(1n) : values[0], step = operands.length === 3 ? values[1] : math.integer(1n), end = values.at(-1);
      if (!step.coefficient) fail('seq', 'increment must not be zero');
      const separator = ctx.argument(options.separator ?? '\n'), scale = Math.max(start.scale, step.scale), sign = step.coefficient < 0n ? -1 : 1;
      const spec = options.format == null ? null : decimalFormat(ctx, options.format);
      const width = options.equal ? Math.max(math.toFixed(start, { scale }).length, math.toFixed(end, { scale }).length) : 0;
      let current = start, emitted = false;
      while (math.compare(current, end) * sign <= 0) {
        await ctx.budget.checkpoint(); let text = spec ? formatDecimal(ctx, math, current, spec) : math.toFixed(current, { scale });
        if (width > text.length) text = text.startsWith('-') ? '-' + text.slice(1).padStart(width - 1, '0') : text.padStart(width, '0');
        if (emitted) ctx.output.append(separator); ctx.output.argument(text); emitted = true;
        const remaining = math.subtract(end, current);
        if (remaining.coefficient === 0n || math.compare(math.abs(step), math.abs(remaining)) > 0) break;
        current = math.add(current, step);
      }
      if (emitted) ctx.output.byte(10); return result(ctx);
    },
    async shuf(argv, stdin) {
      const ctx = invocation('shuf', io, signal, limits, argv, stdin);
      const { options, operands } = parseArgs(argv, { echo: flag('e', 'echo'), range: flag('i', 'input-range', true), number: flag('n', 'head-count', true), repeat: flag('r', 'repeat'), zero: flag('z', 'zero-terminated'), output: flag('o', 'output', true) }, { command: 'shuf' });
      if (options.echo && options.range != null || options.range != null && operands.length || !options.echo && options.range == null && operands.length > 1) fail('shuf', 'incompatible input operands');
      const number = options.number == null ? null : count(ctx, options.number, 'output count'), separator = options.zero ? 0 : 10;
      if (options.repeat && number == null && options.output != null) fail('shuf', 'unbounded repetition cannot write an output file');
      const pool = [], keep = (bytes) => { ctx.budget.reserveRetained(64); pool.push(bytes); };
      if (options.echo) for (const operand of operands) { ctx.budget.spend('records'); const bytes = ctx.argument(operand); ctx.budget.spend('inputBytes', bytes.length); keep(bytes); }
      else if (options.range != null) {
        const hit = /^(\d+)-(\d+)$/.exec(options.range); if (!hit) fail('shuf', 'invalid input range');
        const low = count(ctx, hit[1], 'range endpoint'), high = count(ctx, hit[2], 'range endpoint'); if (high < low) fail('shuf', 'range endpoints are reversed');
        if (high - low + 1 > ctx.limits.maxRecords) fail('shuf', 'input range exceeds the record limit');
        for (let value = low; value <= high; value++) { await ctx.budget.checkpoint(); ctx.budget.spend('records'); const bytes = encoder.encode(String(value)); ctx.budget.spend('inputBytes', bytes.length); keep(bytes); }
      } else {
        const source = ctx.inputs.operands(operands)[0], cursor = await source.open();
        for (;;) { const row = await cursor.nextRecord({ separator }); if (!row) break; keep(row.bytes); }
      }
      const choose = async (size) => {
        if (size <= 1) return 0;
        const ceiling = Math.floor(4294967296 / size) * size;
        for (;;) {
          await ctx.budget.checkpoint(); const bytes = await entropy(4); ctx.budget.check();
          if (!(bytes instanceof Uint8Array) || bytes.length !== 4) fail('shuf', 'random provider returned an invalid byte count');
          const value = bytes[0] * 16777216 + bytes[1] * 65536 + bytes[2] * 256 + bytes[3]; if (value < ceiling) return value % size;
        }
      };
      if (options.repeat && !pool.length && number !== 0) fail('shuf', 'no lines to repeat');
      if (options.repeat && number == null) {
        let current = null, offset = 0;
        return { stream: createRepeatStream(async (capacity) => {
          if (current == null) { current = pool[await choose(pool.length)]; offset = 0; }
          if (offset < current.length) { const bytes = current.subarray(offset, Math.min(current.length, offset + capacity)); offset += bytes.length; return bytes; }
          current = null; return Uint8Array.of(separator);
        }, { signal, limits, command: 'shuf', context: ctx }), code: 0, raw: true };
      }
      const total = options.repeat ? number : Math.min(number ?? pool.length, pool.length);
      for (let at = 0; at < total; at++) {
        await ctx.budget.checkpoint(); let bytes;
        if (options.repeat) bytes = pool[await choose(pool.length)];
        else { const selected = at + await choose(pool.length - at); [pool[at], pool[selected]] = [pool[selected], pool[at]]; bytes = pool[at]; }
        ctx.output.append(bytes); ctx.output.byte(separator);
      }
      if (options.output != null) { const bytes = ctx.output.finish(); await io.write(options.output, bytes); ctx.budget.check(); return { text: empty, code: 0, raw: true }; }
      return result(ctx);
    },
    async tsort(argv, stdin) {
      const ctx = invocation('tsort', io, signal, limits, argv, stdin), { operands } = parseArgs(argv, {}, { command: 'tsort' });
      if (operands.length > 1) fail('tsort', 'expected at most one input file');
      const bytes = await (await ctx.inputs.operands(operands)[0].open()).rest(), parts = await tokens(ctx, bytes);
      if (parts.length % 2) fail('tsort', 'input contains an odd number of tokens');
      const graph = new Map(), vertex = (bytes) => {
        const release = ctx.budget.reserveRetained(bytes.length * 2 + 128);
        const key = binary(bytes); if (graph.has(key)) { release(); return graph.get(key); }
        if (graph.size >= (limits.maxVertices ?? 100000)) fail('tsort', 'graph exceeds the vertex limit');
        const node = { key, bytes, incoming: 0, edges: new Set() }; graph.set(key, node); return node;
      };
      for (let at = 0; at < parts.length; at += 2) { await ctx.budget.checkpoint(); const a = vertex(parts[at]), b = vertex(parts[at + 1]); if (a !== b && !a.edges.has(b)) { ctx.budget.reserveRetained(48); a.edges.add(b); b.incoming++; } }
      const ready = []; for (const node of graph.values()) if (!node.incoming) ready.push(node);
      let emitted = 0;
      for (let at = 0; at < ready.length; at++) {
        await ctx.budget.checkpoint(); const node = ready[at]; ctx.output.append(node.bytes); ctx.output.byte(10); emitted++;
        for (const next of node.edges) { await ctx.budget.checkpoint(); if (--next.incoming === 0) ready.push(next); }
      }
      if (emitted !== graph.size) { ctx.output.argument('tsort: input contains a loop\n'); for (const node of graph.values()) if (node.incoming) { ctx.output.append(node.bytes); ctx.output.byte(10); } return result(ctx, 1); }
      return result(ctx);
    },
    async expr(argv, stdin) {
      const ctx = invocation('expr', io, signal, limits, argv, stdin), words = argv[0] === '--' ? argv.slice(1) : argv;
      if (argv[0]?.startsWith('--') && argv[0] !== '--') fail('expr', `unsupported option ${argv[0]}`);
      if (!words.length) fail('expr', 'missing operand');
      const precedence = { '|': 1, '&': 2, '=': 3, '==': 3, '!=': 3, '<': 3, '<=': 3, '>': 3, '>=': 3, '+': 4, '-': 4, '*': 5, '/': 5, '%': 5, ':': 6 };
      let at = 0, nesting = 0;
      const make = (kind, properties = {}) => {
        const depth = 1 + Math.max(0, ...Object.values(properties).filter((value) => value && typeof value === 'object' && value.depth).map((value) => value.depth));
        if (depth > 128) fail('expr', 'expression exceeds the 128-level limit'); ctx.budget.reserveRetained(96); return { kind, ...properties, depth };
      };
      function primary() {
        if (++nesting > 128) fail('expr', 'expression exceeds the 128-level limit');
        try {
          if (at === words.length) fail('expr', 'missing operand'); const token = words[at++];
          if (token === '(') { const node = expression(1); if (words[at++] !== ')') fail('expr', 'expected closing parenthesis'); return node; }
          if (token === ')') fail('expr', 'unexpected closing parenthesis');
          if (token === '+') { if (at === words.length) fail('expr', 'missing quoted operand'); return make('literal', { value: ctx.argument(words[at++]) }); }
          if (['length', 'index', 'substr', 'match'].includes(token)) {
            const args = []; for (let n = 0; n < ({ length: 1, index: 2, substr: 3, match: 2 })[token]; n++) args.push(primary());
            const depth = 1 + Math.max(...args.map((node) => node.depth)); if (depth > 128) fail('expr', 'expression exceeds the 128-level limit'); ctx.budget.reserveRetained(96 + args.length * 8); return { kind: token, args, depth };
          }
          return make('literal', { value: ctx.argument(token) });
        } finally { nesting--; }
      }
      function expression(minimum) {
        let left = primary();
        while ((precedence[words[at]] || 0) >= minimum) { const op = words[at++], right = expression(precedence[op] + 1); left = make('binary', { op, left, right }); }
        return left;
      }
      const tree = expression(1); if (at !== words.length) fail('expr', `unexpected argument ${words[at]}`);
      const asBytes = (value) => typeof value === 'bigint' ? encoder.encode(value.toString()) : value;
      const asInteger = (value, required = true) => {
        if (typeof value === 'bigint') return value;
        const text = binary(value); if (!/^[+-]?\d+$/.test(text)) { if (required) fail('expr', 'non-integer argument'); return null; }
        if (text.replace(/^[+-]/, '').length > ctx.limits.maxDecimalDigits) fail('expr', 'integer exceeds the digit limit'); return BigInt(text);
      };
      const truth = (value) => { const integer = asInteger(value, false); return integer == null ? value.length > 0 : integer !== 0n; };
      const checked = (value) => { if ((value < 0n ? -value : value).toString().length > ctx.limits.maxDecimalDigits) fail('expr', 'integer exceeds the digit limit'); return value; };
      const regexMatch = (value, pattern) => {
        const bytes = asBytes(value), source = asBytes(pattern); if (source.length > ctx.limits.maxRegexBytes) fail('expr', 'regular expression exceeds the byte limit');
        const releasePattern = ctx.budget.reserveRetained(source.length * 64 + 128);
        try {
        const regex = parseRegex(binary(source), 'expr'), release = ctx.budget.reserveRetained(4096 * (64 + regex.groups * 24));
        try { const hit = findRegex(regex, bytes, 0, { anchored: true, tick: () => ctx.budget.spend('steps') }); return regex.groups ? hit?.captures[1] ? bytes.subarray(...hit.captures[1]) : empty : BigInt(hit ? hit.end : 0); }
        finally { release(); }
        } finally { releasePattern(); }
      };
      async function evaluate(node) {
        await ctx.budget.checkpoint(); if (node.kind === 'literal') return node.value;
        if (node.kind === 'binary') {
          const left = await evaluate(node.left);
          if (node.op === '|') { if (truth(left)) return left; const right = await evaluate(node.right); return truth(right) ? right : 0n; }
          if (node.op === '&') { if (!truth(left)) return 0n; return truth(await evaluate(node.right)) ? left : 0n; }
          const right = await evaluate(node.right);
          if (node.op === ':') return regexMatch(left, right);
          if (['=', '==', '!=', '<', '<=', '>', '>='].includes(node.op)) {
            const a = asInteger(left, false), b = asInteger(right, false), order = a != null && b != null ? a < b ? -1 : a > b ? 1 : 0 : compareBytes(asBytes(left), asBytes(right));
            return BigInt(({ '=': order === 0, '==': order === 0, '!=': order !== 0, '<': order < 0, '<=': order <= 0, '>': order > 0, '>=': order >= 0 })[node.op]);
          }
          const a = asInteger(left), b = asInteger(right), estimate = a.toString().length + b.toString().length;
          if (node.op === '*' && estimate > ctx.limits.maxDecimalDigits + 2) fail('expr', 'integer multiplication exceeds the digit limit');
          const release = ctx.budget.reserveRetained(estimate * 4 + 64);
          try {
            ctx.budget.spend('steps', Math.max(1, Math.ceil(estimate / 64)));
            if ((node.op === '/' || node.op === '%') && b === 0n) fail('expr', 'division by zero');
            return checked(({ '+': () => a + b, '-': () => a - b, '*': () => a * b, '/': () => a / b, '%': () => a % b })[node.op]());
          } finally { release(); }
        }
        const args = []; for (const arg of node.args) args.push(await evaluate(arg));
        if (node.kind === 'match') return regexMatch(args[0], args[1]);
        const bytes = asBytes(args[0]);
        if (node.kind === 'length') return BigInt(bytes.length);
        if (node.kind === 'index') { const alphabet = new Set(asBytes(args[1])); for (let i = 0; i < bytes.length; i++) { if (i % 4096 === 0) await ctx.budget.checkpoint(); if (alphabet.has(bytes[i])) return BigInt(i + 1); } return 0n; }
        const start = asInteger(args[1]), length = asInteger(args[2]); if (start <= 0n || length <= 0n || start > BigInt(bytes.length)) return empty;
        const index = Number(start - 1n), take = Number(length > BigInt(bytes.length - index) ? BigInt(bytes.length - index) : length); return bytes.subarray(index, index + take);
      }
      const value = await evaluate(tree); ctx.output.append(asBytes(value)); ctx.output.byte(10); return result(ctx, truth(value) ? 0 : 1);
    },
    async factor(argv, stdin) {
      const ctx = invocation('factor', io, signal, limits, argv, stdin), { operands } = parseArgs(argv, {}, { command: 'factor' });
      const words = operands.length ? operands.map((value) => ctx.argument(value)) : await tokens(ctx, await (await ctx.inputs.operands([])[0].open()).rest());
      const maximum = (1n << 64n) - 1n;
      const modular = async (base, exponent, modulus) => { let result = 1n; base %= modulus; while (exponent) { await ctx.budget.checkpoint(); if (exponent & 1n) result = result * base % modulus; exponent >>= 1n; if (exponent) base = base * base % modulus; } return result; };
      const prime = async (n) => {
        if (n < 2n) return false;
        for (const p of [2n, 3n, 5n, 7n, 11n, 13n, 17n, 19n, 23n, 29n, 31n, 37n]) { if (n === p) return true; if (n % p === 0n) return false; }
        let d = n - 1n, count = 0; while (!(d & 1n)) { d >>= 1n; count++; }
        // Deterministic below 2^64: Forisek/Jancina, Theorem 3.
        // https://ceur-ws.org/Vol-1326/020-Forisek.pdf
        for (const base of [2n, 325n, 9375n, 28178n, 450775n, 9780504n, 1795265022n]) {
          if (base % n === 0n) continue; let value = await modular(base, d, n); if (value === 1n || value === n - 1n) continue;
          let witness = true; for (let i = 1; i < count; i++) { await ctx.budget.checkpoint(); value = value * value % n; if (value === n - 1n) { witness = false; break; } }
          if (witness) return false;
        }
        return true;
      };
      const gcd = async (a, b) => { while (b) { await ctx.budget.checkpoint(); [a, b] = [b, a % b]; } return a; };
      const divisor = async (n) => {
        if (n % 2n === 0n) return 2n;
        for (let c = 1n;; c++) {
          let x = 2n, y = 2n, d = 1n;
          while (d === 1n) { await ctx.budget.checkpoint(); x = (x * x + c) % n; y = (y * y + c) % n; y = (y * y + c) % n; d = await gcd(x > y ? x - y : y - x, n); }
          if (d !== n) return d;
        }
      };
      for (const bytes of words) {
        await ctx.budget.checkpoint(); if (bytes.length > ctx.limits.maxDecimalDigits + 1) fail('factor', 'integer text exceeds the digit limit');
        const release = ctx.budget.reserveRetained(bytes.length * 2 + 64);
        const text = binary(bytes); if (!/^\+?\d+$/.test(text) || text.replace(/^\+?0*/, '').length > 20) fail('factor', `invalid unsigned 64-bit integer ${text}`);
        const n = BigInt(text); if (n > maximum) fail('factor', 'integer exceeds the unsigned 64-bit range');
        const pending = n > 1n ? [n] : [], factors = [];
        while (pending.length) { await ctx.budget.checkpoint(); const value = pending.pop(); if (await prime(value)) factors.push(value); else { const part = await divisor(value); pending.push(part, value / part); } }
        factors.sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
        ctx.output.argument(n.toString() + ':'); for (const value of factors) ctx.output.argument(' ' + value); ctx.output.byte(10); release();
      }
      return result(ctx);
    },
    async numfmt(argv, stdin) {
      const ctx = invocation('numfmt', io, signal, limits, argv, stdin), math = decimal(ctx);
      const { options, operands } = parseArgs(argv, { from: flag(null, 'from', true), to: flag(null, 'to', true), fromUnit: flag(null, 'from-unit', true), toUnit: flag(null, 'to-unit', true), field: flag(null, 'field', true), delimiter: flag('d', 'delimiter', true), header: flag(null, 'header', 'optional'), padding: flag(null, 'padding', true), suffix: flag(null, 'suffix', true), round: flag(null, 'round', true), format: flag(null, 'format', true), invalid: flag(null, 'invalid', true), grouping: flag(null, 'grouping'), zero: flag('z', 'zero-terminated') }, { command: 'numfmt', negativeNumbers: true });
      const from = options.from ?? 'none', to = options.to ?? 'none', invalid = options.invalid ?? 'abort', rounding = options.round ?? 'from-zero';
      if (!['none', 'si', 'iec', 'iec-i', 'auto'].includes(from) || !['none', 'si', 'iec', 'iec-i'].includes(to)) fail('numfmt', 'invalid unit mode');
      if (!['abort', 'fail', 'warn', 'ignore'].includes(invalid)) fail('numfmt', 'invalid error-handling mode');
      if (!['up', 'down', 'from-zero', 'towards-zero', 'nearest'].includes(rounding)) fail('numfmt', 'invalid rounding mode');
      const delimiter = options.delimiter == null ? null : ctx.argument(options.delimiter);
      if (delimiter && delimiter.length !== 1) fail('numfmt', 'field delimiter must contain one byte');
      const header = options.header == null ? 0 : options.header === true ? 1 : count(ctx, options.header, 'header count');
      const separator = options.zero ? 0 : 10, suffix = options.suffix ?? '', suffixBytes = ctx.argument(suffix);
      let padding = 0;
      if (options.padding != null) { if (!/^-?\d+$/.test(options.padding)) fail('numfmt', 'invalid padding'); padding = Number(options.padding); if (!Number.isSafeInteger(padding) || Math.abs(padding) > ctx.limits.maxOutputBytes) fail('numfmt', 'padding exceeds the output limit'); }
      const format = options.format == null ? null : decimalFormat(ctx, options.format, { onlyFixed: true });
      ctx.budget.reserveRetained(String(options.field ?? '1').length * 32 + 64);
      const ranges = String(options.field ?? '1').split(',').map((part) => {
        if (part === '-') return [1, Infinity];
        const hit = /^(?:(\d+)(?:-(\d*)?)?|-(\d+))$/.exec(part); if (!hit) fail('numfmt', 'invalid field range');
        const low = hit[3] ? 1 : count(ctx, hit[1], 'field', 1), high = hit[3] ? count(ctx, hit[3], 'field', 1) : part.includes('-') ? hit[2] ? count(ctx, hit[2], 'field', 1) : Infinity : low;
        if (high < low) fail('numfmt', 'reversed field range'); return [low, high];
      });
      const selected = (index) => { for (const [low, high] of ranges) { ctx.budget.spend('steps'); if (index >= low && index <= high) return true; } return false; };
      const unit = (text) => {
        const hit = /^(\d+)([kKMGTPEZYRQ]i?)?$/.exec(text); if (!hit) fail('numfmt', 'invalid unit size');
        let value = math.parse(hit[1]); if (value.coefficient <= 0n) fail('numfmt', 'unit size must be positive');
        if (hit[2]) { const power = 'KMGTPEZYRQ'.indexOf(hit[2][0].toUpperCase()) + 1, base = hit[2].endsWith('i') ? 1024n : 1000n; value = math.multiply(value, math.integer(base ** BigInt(power))); }
        return value;
      };
      const fromUnit = unit(options.fromUnit ?? '1'), toUnit = unit(options.toUnit ?? '1');
      const signedRounding = (value) => ({ up: 'ceil', down: 'floor', 'towards-zero': 'trunc', nearest: 'half-away', 'from-zero': value.coefficient < 0n ? 'floor' : 'ceil' })[rounding];
      const convert = (bytes, automaticWidth = 0) => {
        const releaseInput = ctx.budget.reserveRetained(bytes.length * 2 + 256);
        try {
        let text = binary(bytes);
        if (suffixBytes.length && bytes.length >= suffixBytes.length && compareBytes(bytes.subarray(bytes.length - suffixBytes.length), suffixBytes) === 0) text = binary(bytes.subarray(0, bytes.length - suffixBytes.length));
        text = text.replace(/^[ \t]+|[ \t]+$/g, '');
        const hit = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))([kKMGTPEZYRQ]?)(i?)$/.exec(text);
        if (!hit || from === 'none' && hit[2] || hit[3] && !hit[2]) throw new NumericInputError('invalid number');
        let value = math.parse(hit[1]), inputPower = hit[2] ? 'KMGTPEZYRQ'.indexOf(hit[2].toUpperCase()) + 1 : 0;
        if (inputPower) {
          if (from === 'si' && hit[3] || from === 'iec' && hit[3] || from === 'iec-i' && !hit[3]) throw new NumericInputError('invalid suffix');
          const base = from === 'si' || from === 'auto' && !hit[3] ? 1000n : 1024n; value = math.multiply(value, math.integer(base ** BigInt(inputPower)));
        }
        value = math.multiply(value, fromUnit);
        let denominator = toUnit, outputPower = 0;
        const base = to === 'si' ? 1000n : 1024n;
        if (to !== 'none') while (outputPower < 10) {
          const threshold = math.multiply(denominator, math.integer(base)); if (math.compare(math.abs(value), threshold) < 0) break; denominator = threshold; outputPower++;
        }
        const preservedScale = to === 'none' && from === 'none' && options.fromUnit == null && options.toUnit == null ? value.scale : 0;
        const places = format?.precision ?? (outputPower && math.compare(math.abs(value), math.multiply(denominator, math.integer(10n))) < 0 ? 1 : preservedScale);
        let converted = math.divide(value, denominator, { scale: places, rounding: signedRounding(value) });
        if (to !== 'none' && outputPower < 10 && math.compare(math.abs(converted), math.integer(base)) >= 0) {
          denominator = math.multiply(denominator, math.integer(base)); outputPower++; converted = math.divide(value, denominator, { scale: format?.precision ?? 1, rounding: signedRounding(value) });
        }
        let out = format ? formatDecimal(ctx, math, converted, { ...format, prefix: '', suffix: '', width: 0, precision: converted.scale }, signedRounding(value)) : math.toFixed(converted);
        if (outputPower) out += (to === 'si' ? 'kMGTPEZYRQ' : 'KMGTPEZYRQ')[outputPower - 1] + (to === 'iec-i' ? 'i' : '');
        out += suffix;
        const width = options.padding != null ? Math.abs(padding) : format?.width || automaticWidth;
        const left = padding < 0 || format?.flags.includes('-'), projected = Math.max(utf8Length(out), width) + utf8Length(format?.prefix || '') + utf8Length(format?.suffix || '');
        if (projected > ctx.limits.maxOutputBytes) fail('numfmt', 'formatted number exceeds the output limit');
        const releaseOutput = ctx.budget.reserveRetained(projected * 3 + 64);
        try {
          if (out.length < width) {
            if (left) out = out.padEnd(width, ' ');
            else if (format?.flags.includes('0')) out = out.startsWith('-') ? '-' + out.slice(1).padStart(width - 1, '0') : out.padStart(width, '0');
            else out = out.padStart(width, ' ');
          }
          out = (format?.prefix || '') + out + (format?.suffix || '');
          const converted = encoder.encode(out);
          return { converted, release: releaseOutput };
        } catch (error) { releaseOutput(); throw error; }
        } finally { releaseInput(); }

      };
      let lineNumber = 0, code = 0, diagnosticBytes = 0; const diagnostics = [];
      const process = async (row) => {
        await ctx.budget.checkpoint(); if (lineNumber++ < header) { ctx.output.append(row.bytes); ctx.output.byte(separator); return true; }
        const spans = [], spanReleases = [], bytes = row.bytes; let start = 0, at = 0;
        const push = (a, b) => { if (spans.length >= ctx.limits.maxRecords) fail('numfmt', 'field count exceeds the limit'); spanReleases.push(ctx.budget.reserveRetained(96)); spans.push([a, b]); };
        if (delimiter) {
          for (; at < bytes.length; at++) { if (at % 4096 === 0) await ctx.budget.checkpoint(); if (bytes[at] === delimiter[0]) { push(start, at); start = at + 1; } } push(start, bytes.length);
        } else {
          while (at < bytes.length) {
            while (at < bytes.length && isSpace(bytes[at])) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; }
            if (at === bytes.length) break; start = at;
            while (at < bytes.length && !isSpace(bytes[at])) { if (at % 4096 === 0) await ctx.budget.checkpoint(); at++; } push(start, at);
          }
        }
        const replacements = [], replacementReleases = [];
        const release = () => { for (const release of spanReleases) release(); for (const release of replacementReleases) release(); };
        try {
          for (let i = 0; i < spans.length; i++) if (selected(i + 1)) {
            await ctx.budget.checkpoint(); const [start, end] = spans[i];
            try {
              const slotRelease = ctx.budget.reserveRetained(96); replacementReleases.push(slotRelease);
              const automaticWidth = !delimiter && (start > 0 || spans.length > 1) ? end - start : 0;
              const converted = convert(bytes.subarray(start, end), automaticWidth); replacementReleases.push(converted.release); replacements.push({ start, end, converted: converted.converted });
            }
            catch (error) {
              if (!(error instanceof NumericInputError)) throw error;
              if (invalid === 'abort' || invalid === 'fail') code = 2;
              if (invalid !== 'ignore') {
                const message = `numfmt: invalid number on line ${lineNumber}, field ${i + 1}`;
                diagnosticBytes += utf8Length(message) + 1;
                if (diagnosticBytes > ctx.limits.maxOutputBytes) fail('numfmt', 'diagnostics exceed the output limit'); ctx.budget.reserveRetained(utf8Length(message) * 2 + 48); diagnostics.push(message);
              }
              if (invalid === 'abort') return false;
            }
          }
          let previous = 0; for (const replacement of replacements) { ctx.output.append(bytes.subarray(previous, replacement.start)); ctx.output.append(replacement.converted); previous = replacement.end; }
          ctx.output.append(bytes.subarray(previous)); ctx.output.byte(separator); return true;
        } finally { release(); }
      };
      if (operands.length) {
        for (const operand of operands) { ctx.budget.spend('records'); if (!(await process({ bytes: ctx.argument(operand) }))) break; }
      } else {
        const cursor = await ctx.inputs.operands([])[0].open(); for (;;) { const row = await cursor.nextRecord({ separator }); if (!row || !(await process(row))) break; }
      }
      if (diagnosticBytes + ctx.output.length > ctx.limits.maxOutputBytes) fail('numfmt', 'result and diagnostics exceed the output limit');
      const output = result(ctx, code);
      return { ...output, ...(diagnostics.length ? { displayText: [renderData(autoData(output.text)).replace(/\n$/, ''), diagnostics.join('\n')].filter(Boolean).join('\n') } : {}) };
    },
  };
}
