import test from 'node:test';
import assert from 'node:assert/strict';
import { createU2Context, utf8Length, encodeArgument, compareBytes, parseCount } from '../cmds/u2-common.mjs';
import { createDecimalMath } from '../cmds/u2-decimal.mjs';
import { createBcMathLibrary } from '../cmds/bc-math.mjs';
import { createBcCommands } from '../cmds/bc.mjs';
import { parseBc } from '../cmds/bc-parser.mjs';
import { IOFailure } from '../io.mjs';
import { ShellInterrupted, ShellRefused } from '../execution.mjs';

const decode = (data) => new TextDecoder().decode(data);
const encode = (text) => new TextEncoder().encode(text);
const context = (limits = {}, extra = {}) => createU2Context({ command: 'fixture', limits, ...extra });
const decimal = (options = {}) => {
  const ctx = context(); return createDecimalMath({ budget: ctx.budget, ...options });
};

test('shared byte cursor preserves binary delimiters and consumes repeated stdin once', async () => {
  const ctx = context({}, { stdin: Uint8Array.of(255, 10, 0, 10, 65) });
  const [a, b] = ctx.inputs.operands(['-', '-']);
  const first = await a.open(), second = await b.open(); assert.equal(first, second);
  assert.deepEqual(await first.nextRecord(), { bytes: Uint8Array.of(255), terminated: true, separator: 10 });
  assert.deepEqual(await second.nextRecord(), { bytes: Uint8Array.of(0), terminated: true, separator: 10 });
  assert.deepEqual(await first.nextRecord(), { bytes: Uint8Array.of(65), terminated: false, separator: 10 });
  assert.equal(await second.nextRecord(), null); assert.equal(ctx.budget.snapshot().inputBytes, 5);
});

test('shared cursor does not invent a record after a trailing delimiter', async () => {
  const ctx = context({}, { stdin: Uint8Array.of(65, 0) }), cursor = await ctx.inputs.operands([])[0].open();
  assert.deepEqual(await cursor.nextRecord({ separator: 0 }), { bytes: Uint8Array.of(65), terminated: true, separator: 0 });
  assert.equal(await cursor.nextRecord({ separator: 0 }), null);
  assert.equal(cursor.position, 2); assert.equal(cursor.remaining, 0);
});

test('shared file reads receive serialized remaining aggregate byte budgets', async () => {
  const calls = [], ctx = context({ maxInputBytes: 5 }, { io: { async readBytes(path, options) {
    calls.push([path, options.maxBytes]); return path === 'one' ? Uint8Array.of(1, 2, 3) : Uint8Array.of(4, 5);
  } } });
  const [a, b] = ctx.inputs.operands(['one', 'two']);
  const opened = await Promise.all([a.open(), b.open()]);
  assert.deepEqual(calls, [['one', 5], ['two', 2]]); assert.equal(opened[1].length, 2);
  assert.equal(await a.open(), opened[0]); assert.equal(calls.length, 2);
});

test('shared reads turn EFBIG into resource errors while preserving refusal and unsupported capability', async () => {
  for (const code of ['EFBIG', 'ENOTSUP']) {
    const error = new IOFailure('fs.read', { code, message: code });
    const ctx = context({}, { io: { async readBytes() { throw error; } } });
    const pending = ctx.inputs.operands(['file'])[0].open();
    if (code === 'EFBIG') await assert.rejects(pending, /fixture:.*resource.*EFBIG/);
    else await assert.rejects(pending, (actual) => actual === error);
  }
  const refusal = new ShellRefused('read');
  const ctx = context({}, { io: { async readBytes() { throw refusal; } } });
  await assert.rejects(ctx.inputs.operands(['file'])[0].open(), (actual) => actual === refusal);
});

test('shared input preflight bounds Unicode encoding and defensive oversized backend results', async () => {
  const unicode = context({ maxInputBytes: 3 }, { stdin: '😀' });
  await assert.rejects(unicode.inputs.operands([])[0].open(), /input.*limit/);
  assert.equal(unicode.budget.snapshot().inputBytes, 0);
  const lying = context({ maxInputBytes: 1 }, { io: { async readBytes() { return Uint8Array.of(1, 2); } } });
  await assert.rejects(lying.inputs.operands(['file'])[0].open(), /inputBytes.*limit/);
});

test('shared descriptor limits precede allocation without spending destination counters', () => {
  const ctx = context({ maxInputFiles: 2, maxFiles: 1 });
  assert.throws(() => ctx.inputs.operands(['', '', '']), /inputFiles.*limit/);
  assert.equal(ctx.budget.snapshot().retainedBytes, 0);
  ctx.inputs.operands(['a', 'b']); ctx.budget.spend('files');
  assert.equal(ctx.budget.snapshot().inputFiles, 2); assert.equal(ctx.budget.snapshot().files, 1);
  assert.throws(() => ctx.inputs.operands(['c']), /inputFiles.*limit/);
});

test('shared output forks charge one cumulative allocation and fragment budget', () => {
  const ctx = context({ maxOutputBytes: 4, maxFragments: 3 });
  ctx.output.append(Uint8Array.of(0, 255)); const child = ctx.output.fork(); child.repeat(65, 2);
  assert.throws(() => child.repeat(1, Number.MAX_SAFE_INTEGER), /outputBytes.*limit/);
  assert.deepEqual(ctx.output.finish(), Uint8Array.of(0, 255));
  assert.deepEqual(child.finish(), Uint8Array.of(65, 65));
  assert.equal(ctx.budget.snapshot().outputBytes, 4); assert.equal(ctx.budget.snapshot().fragments, 2);
});

test('shared retained reservations release once and reject before changing counters', () => {
  const ctx = context({ maxRetainedBytes: 10 }), release = ctx.budget.reserveRetained(8);
  assert.throws(() => ctx.budget.reserveRetained(3), /retained.*limit/);
  assert.equal(ctx.budget.snapshot().retainedBytes, 8); release(); release();
  assert.equal(ctx.budget.snapshot().retainedBytes, 0);
});

test('shared invocation signal remains aborted after reset starts a different invocation', async () => {
  const first = new AbortController(), second = new AbortController(); let active = first.signal;
  const old = context({ yieldEvery: 1 }, { signal: () => active });
  const pending = old.budget.checkpoint(); first.abort(); active = second.signal;
  const next = context({ yieldEvery: 1 }, { signal: () => active });
  await assert.rejects(pending, ShellInterrupted);
  assert.throws(() => old.output.byte(1), ShellInterrupted);
  await next.budget.checkpoint(); next.output.byte(2); assert.deepEqual(next.output.finish(), Uint8Array.of(2));
});

test('shared argument and comparison helpers retain C-locale byte semantics', () => {
  assert.equal(utf8Length('a😀\ud800'), 8);
  const ctx = context({ maxArgumentBytes: 4 }); assert.deepEqual(encodeArgument('😀', ctx.budget), encode('😀'));
  assert.throws(() => encodeArgument('a', ctx.budget), /argument.*limit/);
  assert.equal(compareBytes(Uint8Array.of(255), Uint8Array.of(127)), 1);
  assert.equal(compareBytes(encode('A'), encode('a'), { ignoreCase: true }), 0);
  assert.equal(parseCount('00012', { max: 12 }), 12); assert.throws(() => parseCount('1e3'), /integer/);
});

test('decimal arithmetic preserves exact large coefficients and decimal scale', () => {
  const m = decimal();
  assert.equal(m.toFixed(m.add(m.parse('9007199254740993.25'), m.parse('0.75'))), '9007199254740994.00');
  assert.equal(m.toFixed(m.multiply(m.parse('1.20'), m.parse('3.0'))), '3.600');
  assert.equal(m.toFixed(m.parse('1.230e2', { exponent: true })), '123.0');
  assert.throws(() => m.parse('1e2'), /invalid decimal/);
});

test('decimal directed rounding and ties are sign-aware', () => {
  const m = decimal(), negative = m.parse('-1.25');
  assert.equal(m.toFixed(m.quantize(negative, 1, 'floor')), '-1.3');
  assert.equal(m.toFixed(m.quantize(negative, 1, 'ceil')), '-1.2');
  assert.equal(m.toFixed(m.quantize(negative, 1, 'half-away')), '-1.3');
  assert.equal(m.toFixed(m.quantize(negative, 1, 'half-even')), '-1.2');
  assert.equal(m.toFixed(m.quantize(m.parse('-0.0001'), 1, 'floor')), '-0.1');
  assert.equal(m.toFixed(m.divide(m.parse('-1'), m.parse('8'), { scale: 2, rounding: 'half-even' })), '-0.12');
});

test('decimal multiplication can truncate private scratch precision into public scale', () => {
  const m = decimal({ maxDigits: 8, maxScale: 2 });
  assert.equal(m.toFixed(m.multiply(m.parse('1.25'), m.parse('2.25'), { scale: 2, rounding: 'trunc' })), '2.81');
  assert.throws(() => m.multiply(m.parse('1.25'), m.parse('2.25')), /scale.*limit/);
});

test('decimal power, square root, and remainder use exact scaled integers', async () => {
  const m = decimal();
  assert.equal(m.toFixed(await m.power(m.parse('2'), -3n, { scale: 5, rounding: 'trunc' })), '0.12500');
  assert.equal(m.toFixed(await m.sqrt(m.parse('2'), { scale: 30, rounding: 'trunc' })), '1.414213562373095048801688724209');
  assert.equal(m.toFixed(await m.sqrt(m.parse('2.25'), { scale: 0, rounding: 'half-even' })), '2');
  assert.equal(m.toFixed(m.remainder(m.parse('5.75'), m.parse('2'))), '1.75');
  assert.equal(m.toFixed(m.remainder(m.parse('5.75'), m.parse('2'), { quotientScale: 1 })), '0.15');
});

test('decimal scratch threshold remains accounted and projected expansion refuses safely', async () => {
  const ctx = context(), m = createDecimalMath({ budget: ctx.budget, maxDigits: 8, maxScale: 3, maxExponent: 20, maxScratchDigits: 24, maxScratchScale: 24 });
  assert.ok(ctx.budget.snapshot().retainedBytes >= 24 * 4);
  await assert.rejects(m.power(m.parse('99999999'), 20n, { scale: 0, rounding: 'trunc' }), /scratch.*limit/);
  assert.throws(() => m.parse('123456789'), /digit.*limit/);
  assert.throws(() => m.quantize(m.parse('12345678'), 1, 'trunc'), /digit.*limit/);
  assert.equal(m.toFixed(m.parse('1.25')), '1.25');
});

test('certified math shortcuts enforce result digit limits and truncated Bessel order', async () => {
  const ctx = context(), lib = createBcMathLibrary({ budget: ctx.budget, maxDigits: 1, maxScale: 4 });
  await assert.rejects(lib.call('c', [{ coefficient: 0n, scale: 0 }], 1), /digit.*limit/);
  const value = await lib.call('j', [{ coefficient: 1n, scale: 1 }, { coefficient: 0n, scale: 0 }], 0);
  assert.deepEqual(value, { coefficient: 1n, scale: 0 });
});

test('calculator parser refuses unmatched braces and context errors before execution', () => {
  for (const source of ['}', 'break', 'return(1)', '1=2', 'a[]++', 'read()']) assert.throws(() => parseBc(source), /bc:/);
  assert.equal(parseBc('12\\\n34+1\n').body[0].value.left.text, '1234');
});

test('calculator retains completed output when a later program read fails', async () => {
  const commands = createBcCommands({ async readBytes(path) {
    if (path === 'first') return encode('42\n');
    throw new IOFailure('fs.read', { code: 'ENOENT', message: 'missing file' });
  } });
  const result = await commands.bc(['first', 'missing']);
  assert.equal(result.code, 2); assert.equal(decode(result.stdout), '42\n'); assert.match(result.stderr, /^bc: missing: ENOENT:/);
});

test('calculator retains completed expression output on later arithmetic failure', async () => {
  const result = await createBcCommands({}).bc([], '42\n1/0\n');
  assert.equal(result.code, 2); assert.equal(decode(result.stdout), '42\n'); assert.match(result.stderr, /^bc: division by zero/);
});

test('calculator bounded cells permit replacement while prohibiting additional variables', async () => {
  const commands = createBcCommands({}, { limits: { maxCells: 1 } });
  assert.equal(decode((await commands.bc([], 'a=1\na+=2\na\n')).text), '3\n');
  await assert.rejects(commands.bc([], 'a=1\nb=2\n'), /cell.*limit/);
});

test('calculator handles fractional input digits and seventy-character numeric lines', async () => {
  const commands = createBcCommands({});
  const fractional = await commands.bc([], 'ibase=2\n.9\n.09\n');
  assert.equal(decode(fractional.text), '4.5\n.25\n');
  const wrapped = await commands.bc([], '10^100\n');
  assert.equal(decode(wrapped.text), '1' + '0'.repeat(67) + '\\\n' + '0'.repeat(33) + '\n');
  await assert.rejects(commands.bc([], 'scale=-1\n'), /scale cannot be negative/);
});

test('calculator associates else across separators without consuming the next statement', async () => {
  const result = await createBcCommands({}).bc([], 'if(0)1;else 2\nif(1)3\nelse 4\nif(0)5\n6\n');
  assert.equal(decode(result.text), '2\n3\n6\n');
});

test('calculator diagnoses fractional exponent truncation explicitly', async () => {
  const result = await createBcCommands({}).bc([], '2^1.5\n');
  assert.equal(result.code, 0);
  assert.equal(decode(result.text), 'bc: warning: non-integer exponent truncated toward zero\n2\n');
});

test('calculator retains documented GNU function-base, length, and compile-time quit behavior', async () => {
  const commands = createBcCommands({});
  const bases = await commands.bc([], 'define f(x){ibase=2;return(10+x)}\nf(1)\n10\n');
  assert.equal(decode(bases.text), '11\n2\n');
  assert.equal(decode((await commands.bc([], 'length(.0001)\n')).text), '4\n');
  assert.equal(decode((await commands.bc([], '1;quit\n')).text), '');
  assert.equal(decode((await commands.bc([], '1\nif(0)quit\n2\n')).text), '1\n');
});
