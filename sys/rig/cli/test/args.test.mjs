// U0 shared argument parser. Run with node sys/rig/cli/test/args.test.mjs.
import assert from 'node:assert/strict';
import { ArgError, formatSupportedFlags, parseArgs } from '../args.mjs';

let passed = 0;
const failures = [];
function test(name, fn) {
  try { fn(); passed++; }
  catch (error) { failures.push({ name, message: error.message }); }
}

const spec = {
  verbose: { short: 'v', long: 'verbose' },
  quiet: { short: 'q', long: 'quiet' },
  lines: { short: 'n', long: 'lines', value: true },
  expression: { short: 'e', long: 'expression', value: true, multiple: true },
  file: { short: 'f', long: 'file', value: true, multiple: true },
  inPlace: { short: 'i', long: 'in-place', value: 'optional' },
};
const parse = (argv, settings) => parseArgs(argv, spec, { command: 'sample', ...settings });
function refuses(argv, reason) {
  assert.throws(() => parse(argv), (error) => {
    assert.ok(error instanceof ArgError);
    assert.equal(error.code, 2);
    assert.equal(error.text, error.message);
    assert.ok(error.message.includes(reason), error.message);
    assert.ok(error.message.startsWith('sample: '), error.message);
    assert.ok(error.message.endsWith(`sample supports ${formatSupportedFlags(spec)}`), error.message);
    return true;
  });
}

test('bundles boolean flags and preserves operands around options', () => {
  const result = parse(['first', '-vq', 'second', '--verbose']);
  assert.equal(result.options.verbose, true);
  assert.equal(result.options.quiet, true);
  assert.deepEqual(result.operands, ['first', 'second']);
  assert.equal(result.occurrences.length, 3);
});

test('required short values consume attached remainder or the next word', () => {
  const attached = parse(['-vqn12', 'input']);
  assert.equal(attached.options.lines, '12');
  assert.equal(attached.options.verbose, true);
  assert.deepEqual(attached.operands, ['input']);
  assert.equal(parse(['-n', '-3']).options.lines, '-3');
  assert.equal(parse(['-n', '--']).options.lines, '--');
  assert.equal(parse(['-n', '']).options.lines, '');
});

test('long values accept equals or separate words without abbreviation', () => {
  assert.equal(parse(['--lines=12']).options.lines, '12');
  assert.equal(parse(['--lines', '12']).options.lines, '12');
  assert.equal(parse(['--expression=a=b']).options.expression[0], 'a=b');
  assert.equal(parse(['--expression=']).options.expression[0], '');
  refuses(['--lin=12'], 'unsupported flag --lin');
});

test('terminator preserves flag-looking filenames and lone dash is an operand', () => {
  const result = parse(['-', '-v', '--', '--unknown', '-q', '--']);
  assert.equal(result.options.verbose, true);
  assert.equal(result.options.quiet, undefined);
  assert.deepEqual(result.operands, ['-', '--unknown', '-q', '--']);
  assert.deepEqual(parse(['--']).operands, []);
});

test('optional values attach without consuming a filename', () => {
  assert.equal(parse(['-i.bak']).options.inPlace, '.bak');
  assert.equal(parse(['--in-place=.old']).options.inPlace, '.old');
  assert.equal(parse(['--in-place=']).options.inPlace, '');
  const short = parse(['-vi', 'input']);
  assert.equal(short.options.inPlace, true);
  assert.deepEqual(short.operands, ['input']);
  const long = parse(['--in-place', 'input']);
  assert.equal(long.options.inPlace, true);
  assert.deepEqual(long.operands, ['input']);
  assert.equal(parse(['-iv']).options.inPlace, 'v');
});

test('repeated options collect values only when configured', () => {
  const result = parse(['-n1', '--lines=2', '-ea', '-f', 'script', '--expression=b']);
  assert.equal(result.options.lines, '2');
  assert.deepEqual(result.options.expression, ['a', 'b']);
  assert.deepEqual(result.options.file, ['script']);
  assert.deepEqual(result.occurrences.slice(2), [
    { key: 'expression', flag: '-e', value: 'a' },
    { key: 'file', flag: '-f', value: 'script' },
    { key: 'expression', flag: '--expression', value: 'b' },
  ]);
});

test('wrapper mode leaves nested command flags and terminators intact', () => {
  const result = parse(['-q', 'nested', '-x', '--', 'file'], { stopAtOperand: true });
  assert.equal(result.options.quiet, true);
  assert.deepEqual(result.operands, ['nested', '-x', '--', 'file']);
  assert.deepEqual(parse(['-', '-x'], { stopAtOperand: true }).operands, ['-', '-x']);
});

test('numeric operands opt in without rewriting option values or weakening ordinary flag refusal', () => {
  const result = parse(['-3', '-.5', '-n', '-1', '--expression=-2', '\u0002-9'], { negativeNumbers: true });
  assert.deepEqual(result.operands, ['-3', '-.5', '\u0002-9']);
  assert.equal(result.options.lines, '-1');
  assert.deepEqual(result.options.expression, ['-2']);
  refuses(['-3'], 'unsupported flag -3');
  assert.throws(() => parse(['-x'], { negativeNumbers: true }), /unsupported flag -x/);
  assert.deepEqual(parse(['-3', '-x'], { negativeNumbers: true, stopAtOperand: true }).operands, ['-3', '-x']);
});

test('every unsupported spelling refuses with exit 2 and supported flags', () => {
  refuses(['-x'], 'unsupported flag -x');
  refuses(['-vqx'], 'unsupported flag -x');
  refuses(['--unknown'], 'unsupported flag --unknown');
  refuses(['--unknown=value'], 'unsupported flag --unknown');
  assert.throws(() => parseArgs(['-x'], {}, { command: 'bare' }), {
    code: 2,
    text: 'bare: unsupported flag -x; bare supports no flags',
  });
});

test('missing required values and values on boolean flags refuse', () => {
  refuses(['-n'], 'flag -n requires a value');
  refuses(['-vqn'], 'flag -n requires a value');
  refuses(['--lines'], 'flag --lines requires a value');
  refuses(['--quiet=false'], 'flag --quiet does not take a value');
});

test('aliases share one result and parsing never mutates input', () => {
  const aliases = { extended: { short: ['E', 'r'], long: ['extended', 'regexp-extended'] } };
  const argv = Object.freeze(['-Er', '--regexp-extended']);
  Object.freeze(aliases.extended.short);
  Object.freeze(aliases.extended.long);
  Object.freeze(aliases.extended);
  Object.freeze(aliases);
  assert.equal(parseArgs(argv, aliases).options.extended, true);
  assert.equal(formatSupportedFlags(aliases), '-E -r --extended --regexp-extended');
});

test('option names cannot access or mutate an object prototype', () => {
  const result = parseArgs(['--proto', '--constructor'], {
    ['__proto__']: { long: 'proto', multiple: true },
    constructor: { long: 'constructor' },
  });
  assert.equal(Object.getPrototypeOf(result.options), null);
  assert.deepEqual(result.options.__proto__, [true]);
  assert.equal(result.options.constructor, true);
});

test('invalid definitions fail as programming errors, not user refusals', () => {
  assert.throws(() => parseArgs([], { a: { short: 'x' }, b: { short: 'x' } }), TypeError);
  assert.throws(() => parseArgs([], { a: {} }), TypeError);
  assert.throws(() => parseArgs([], { a: { short: 'xy' } }), TypeError);
  assert.throws(() => parseArgs([], { a: { long: '-bad' } }), TypeError);
  assert.throws(() => parseArgs([], { a: { long: 'bad=name' } }), TypeError);
  assert.throws(() => parseArgs([], { a: { short: 'a', value: 'required' } }), TypeError);
  assert.throws(() => parseArgs([42], spec), TypeError);
});

if (failures.length) {
  console.error(`shell args: ${passed} passed, ${failures.length} FAILED`);
  for (const failure of failures) console.error(`  FAIL ${failure.name}\n        ${failure.message}`);
  process.exit(1);
}
console.log(`shell args: ${passed}/${passed} passed`);
