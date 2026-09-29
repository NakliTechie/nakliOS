import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createIO } from '../io.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';
import { createBcCommands } from '../cmds/bc.mjs';

const quote = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;
function fresh({ prefixes = [''], scopes = ['fs:read', 'fs:write', 'fs:remove'] } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend }), registry = buildRigRegistry({ fs });
  const opLog = createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) });
  const face = createAgentFace({ registry, grant: createGrant({ prefixes, scopes }), opLog, actor: 'bc-contract' });
  const shell = createShell({ registry, face });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const calculate = async (source, flags = '') => {
    const written = await fs.write('program', source); assert.equal(written.ok, true, written.message);
    return run(`bc ${flags} program`);
  };
  const read = async (path) => { const result = await fs.read(path, { encoding: 'utf-8' }); assert.equal(result.ok, true, result.message); return result.data; };
  return { backend, fs, face, shell, opLog, run, calculate, read, io: createIO({ invoke: (name, input) => face.invoke(name, input) }) };
}
async function equalProgram(source, expected, flags = '') {
  const ctx = fresh(), result = await ctx.calculate(source, flags);
  assert.equal(result.code, 0, result.output); assert.equal(result.output, expected); return ctx;
}

test('bc evaluates exact integer arithmetic and operator precedence', async () => {
  await equalProgram('9007199254740993+2\n2+3*4\n(2+3)*4\n2^3^2\n-7/3\n-7%3\n', '9007199254740995\n14\n20\n512\n-2\n-1');
});

test('bc preserves decimal scales with language-specific arithmetic rules', async () => {
  await equalProgram('scale=2\n1/3\n2/3\n1.20*3.0\nscale(1.20*3.0)\nscale(1.20+3.0)\nscale=0\n5.75%2\n', '.33\n.66\n3.60\n2\n2\n1.75');
});

test('bc handles negative fractions, truncation, power scale, and exact square root', async () => {
  await equalProgram('scale=4\n-1/8\n2^-3\nsqrt(2)\nscale=2\n1.20^3\n', '-.1250\n.1250\n1.4142\n1.72');
});

test('bc arithmetic retains precision beyond binary64 mantissas', async () => {
  await equalProgram('scale=40\nsqrt(2)\n1/7\n10000000000000000000000000000000000000001-10000000000000000000000000000000000000000\n',
    '1.4142135623730950488016887242096980785696\n.1428571428571428571428571428571428571428\n1');
});

test('bc assignments, compound assignments, increments, and comparisons preserve expression values', async () => {
  await equalProgram('a=3\na+=2\na\na++\n++a\na>3\na==7\na!=7\n(2<3)+10\n', '5\n5\n7\n1\n1\n0\n11');
});

test('bc conditionals and loops implement break and ordered side effects', async () => {
  await equalProgram('a=0\nfor(i=1;i<=4;i++)a+=i\na\ni=0\nwhile(i<10){i++;if(i==3)break;}\ni\nif(a==10)99\n', '10\n0\n1\n2\n3\n99');
});

test('bc arrays retain distinct integer-indexed values and zero-initialize missing cells', async () => {
  await equalProgram('a[0]=3\na[2]=7\na[0]+a[1]+a[2]\na[1]\ni=2\na[i]+=5\na[2]\n', '10\n0\n12');
});

test('bc user functions preserve local auto variables and return values', async () => {
  await equalProgram('define f(x) {\n auto y;\n y=x*x;\n return(y+1);\n}\ny=99\nf(4)\ny\n', '17\n99');
});

test('bc user functions accept arrays and recursive calls within the limit', async () => {
  await equalProgram('define s(a[]) {\n auto i,t;\n for(i=0;i<3;i++)t+=a[i];\n return(t);\n}\ndefine f(n) {\n if(n<=1)return(1);\n return(n*f(n-1));\n}\na[0]=2\na[1]=3\na[2]=4\ns(a[])\nf(10)\n', '9\n3628800');
});

test('bc function frames isolate auto arrays and default local values', async () => {
  await equalProgram('define f(x) {\n auto a[],n;\n a[0]=x;\n n+=a[0];\n return(n);\n}\nf(3)\nf(4)\n', '3\n4');
});

test('bc copies ordinary array parameters while explicit reference parameters mutate the caller', async () => {
  await equalProgram('define f(a[]) {\n a[0]=7;\n return(a[0]);\n}\ndefine g(*a[]) {\n a[0]=9;\n return(a[0]);\n}\na[0]=1\nf(a[])\na[0]\ng(a[])\na[0]\n', '7\n1\n9\n9');
});

test('bc converts input and output bases without decimal rounding', async () => {
  await equalProgram('obase=16\n255\nobase=2\n5\nobase=10\nibase=16\nFF\nibase=A\n10\n', 'FF\n101\n255\n10');
});

test('bc length and scale include stored decimal scale and handle zero', async () => {
  await equalProgram('length(123.45)\nscale(123.450)\nlength(0)\nscale(2)\nscale(.00120)\n', '5\n3\n1\n0\n5');
});

test('bc reads program operands in order before its pipeline input', async () => {
  const ctx = fresh(); await ctx.fs.write('one', 'a=1\n'); await ctx.fs.write('two', 'a+=2\n');
  const result = await ctx.run("printf 'a\n' | bc one two"); assert.equal(result.code, 0, result.output); assert.equal(result.output, '3');
  assert.deepEqual((await ctx.opLog.read()).filter((entry) => entry.command === 'fs.read').map((entry) => entry.status), ['ok', 'ok']);
});

test('bc accepts comments and source continuations and stops at quit', async () => {
  await equalProgram('/* a block\ncomment */\n12\\\n34+1\nquit\n999\n', '1235');
});

test('bc quiet mode produces no banner while preserving exact redirected framing', async () => {
  const ctx = fresh(); await ctx.fs.write('program', '1+1\n');
  const result = await ctx.run('bc -q program > output'); assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('output'), '2\n');
});

test('bc strict and warning modes identify supported GNU extensions explicitly', async () => {
  const ctx = fresh();
  const strict = await ctx.calculate('longname=1\nlongname\n', '-s'); assert.notEqual(strict.code, 0); assert.match(strict.output, /standard|POSIX|extension|identifier/i);
  const warning = await ctx.calculate('longname=1\nlongname\n', '-w'); assert.equal(warning.code, 0, warning.output);
  assert.match(warning.output, /warn|extension|standard/i); assert.match(warning.output, /1/);
});

test('bc math library initializes scale twenty and implements all six required functions', async () => {
  await equalProgram('scale\ns(1)\nc(1)\na(1)\nl(2)\ne(1)\nj(0,1)\n',
    '20\n.84147098480789650665\n.54030230586813971740\n.78539816339744830961\n.69314718055994530941\n2.71828182845904523536\n.76519768655796655144', '-l');
});

test('bc math library honors precision beyond double-precision approximations', async () => {
  await equalProgram('scale=40\ns(1)\nl(2)\n', '.8414709848078965066525023216302989996225\n.6931471805599453094172321214581765680755', '-l');
});

test('bc math library handles signs and integer-order Bessel symmetry', async () => {
  await equalProgram('scale=20\ns(-1)+s(1)\nc(-1)-c(1)\na(-1)+a(1)\nj(-1,1)+j(1,1)\ne(0)\n', '0\n0\n0\n0\n1.00000000000000000000', '-l');
});

test('bc rejects arithmetic domain errors and undefined functions with nonzero status', async () => {
  const ctx = fresh();
  for (const source of ['1/0\n', 'sqrt(-1)\n', 'missing(1)\n', 'scale=-1\n']) {
    const result = await ctx.calculate(source); assert.notEqual(result.code, 0, source); assert.match(result.output, /bc:/);
  }
  const log = await ctx.calculate('l(0)\n', '-l'); assert.notEqual(log.code, 0); assert.match(log.output, /domain|positive|log|bc:/i);
});

test('bc parses complete expressions and refuses malformed programs before treating a prefix as successful', async () => {
  const ctx = fresh();
  for (const source of ['1+\n', 'define f( {\n', 'a[1=2\n', '1+2 unexpected\n']) {
    const result = await ctx.calculate(source); assert.equal(result.code, 2, `${source}: ${result.output}`); assert.match(result.output, /bc:/);
  }
  assert.equal((await ctx.run('bc --unsupported-u2-option')).code, 2);
});

test('bc never delegates language input to a host evaluator or process launcher', async () => {
  const ctx = fresh();
  const result = await ctx.calculate('system("touch escaped")\n'); assert.notEqual(result.code, 0);
  assert.equal((await ctx.fs.stat('escaped')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.calculate('2+3\n')).output, '5');
});

test('bc program reads preserve grants and never reveal denied file contents', async () => {
  const ctx = fresh({ prefixes: ['allowed'] }); await ctx.fs.write('secret', '987654321\n');
  const result = await ctx.run('bc secret'); assert.notEqual(result.code, 0); assert.match(result.output, /EGRANT|grant/i);
  assert.doesNotMatch(result.output, /987654321/); assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('bc preflights oversized script metadata before backend content loading', async () => {
  const ctx = fresh(); await ctx.fs.write('huge', '1\n');
  const originalStat = ctx.backend.stat.bind(ctx.backend), originalRead = ctx.backend.readBinary.bind(ctx.backend); let reads = 0;
  ctx.backend.stat = async (path, options) => { const stat = await originalStat(path, options); return path === 'huge' && stat ? { ...stat, size: 262145 } : stat; };
  ctx.backend.readBinary = async (...args) => { reads++; return originalRead(...args); };
  const result = await ctx.run('bc huge'); assert.equal(result.code, 2, result.output); assert.match(result.output, /limit|exceed|EFBIG/i);
  assert.equal(reads, 0);
});

test('bc rejects oversized decimal operations before constructing excessive integers', async () => {
  const ctx = fresh();
  for (const source of ['10^10001\n', 'scale=1001\n1/3\n', '9'.repeat(10001) + '\n']) {
    const result = await ctx.calculate(source); assert.equal(result.code, 2, result.output); assert.match(result.output, /limit|exceed|scale|digit|exponent/i);
  }
});

test('small calculator limits bound computation and recursion without disabling ordinary arithmetic', async () => {
  const ctx = fresh(), tiny = createBcCommands(ctx.io, { limits: { maxSteps: 100, maxDecimalScale: 8, maxDecimalDigits: 32 } });
  assert.equal(new TextDecoder().decode((await tiny.bc([], '1+2\n')).text), '3\n');
  await assert.rejects(tiny.bc([], 'while(1){}\n'), /bc:.*limit|bc:.*exceed/i);
  await assert.rejects(tiny.bc([], 'scale=9\n1/3\n'), /bc:.*limit|bc:.*scale|bc:.*exceed/i);
  const recursive = await ctx.calculate('define f(n) {\n return(f(n+1));\n}\nf(0)\n');
  assert.equal(recursive.code, 2); assert.match(recursive.output, /recurs|depth|limit/i);
});

test('bc CPU loops yield to Stop and preserve a fresh independent invocation', async () => {
  const ctx = fresh(); await ctx.fs.write('program', 'while(1){}\n');
  const pending = ctx.run('bc program; touch after-stop'); setTimeout(() => ctx.shell.cancel(), 0);
  const result = await pending; assert.equal(result.code, 130);
  assert.equal((await ctx.fs.stat('after-stop')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  assert.equal((await ctx.calculate('4+5\n')).output, '9');
});

test('bc cancellation during a governed program read prevents subsequent shell writes', async () => {
  const ctx = fresh(); await ctx.fs.write('program', '1+1\n');
  const original = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => {
    const data = await original(...args); if (args[0] === 'program') ctx.shell.cancel(); return data;
  };
  const result = await ctx.run('bc program; touch after-read'); assert.equal(result.code, 130);
  assert.equal((await ctx.fs.stat('after-read')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  ctx.backend.readBinary = original;
  assert.equal((await ctx.calculate('6+7\n')).output, '13');
});
