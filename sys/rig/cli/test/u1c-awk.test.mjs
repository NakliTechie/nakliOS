import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry, createRegistry } from '../../registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../../agent/index.mjs';

// Public shell, actual command registry, and actual governed face. A memory
// backend keeps every fixture and proposed mutation independent of host files.
function fresh({ scopes = ['fs:read', 'fs:write', 'fs:remove'], prefixes = [''],
  readOnlyPrefixes = [], stageWrites = false, signal } = {}) {
  const backend = new MemoryBackend(), fs = createFileops({ backend });
  const base = buildRigRegistry({ fs });
  const registry = stageWrites ? createRegistry(base.commands.map((command) =>
    command.name === 'fs.write' ? { ...command, destructive: true } : command)) : base;
  const face = createAgentFace({ registry,
    grant: createGrant({ prefixes, scopes, readOnlyPrefixes }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'awk-contract' });
  const shell = createShell({ registry, face, signal });
  const run = async (command) => ({ ...await shell.feed(command), code: shell.lastCode });
  const read = async (path) => {
    const result = await fs.read(path, { encoding: 'utf-8' });
    assert.equal(result.ok, true, `${path}: ${result.message || result.code}`);
    return result.data;
  };
  const bytes = async (path) => Array.from((await fs.read(path)).data);
  return { fs, backend, registry, face, shell, run, read, bytes };
}
const quote = (text) => `'${String(text).replaceAll("'", "'\\''")}'`;
const quoteCommand = (program) => `awk ${quote(program)}`;
async function transform(ctx, program, { flags = '', files = 'input', output = 'output', code = 0 } = {}) {
  const result = await ctx.run(`awk ${flags} ${quote(program)} ${files} > ${output}`);
  assert.equal(result.code, code, result.output);
  assert.equal(Boolean(result.awaitingConfirm), false);
  return ctx.read(output);
}

// Expected records and bytes describe language behavior; no parser, evaluator,
// or runtime helper is imported to construct the expectations.
test('awk applies BEGIN, END, expression patterns, regex patterns and implicit print actions', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'alpha 2\nbeta 5\nalpha 8\n');
  assert.equal(await transform(ctx, 'BEGIN { print "start" } $2 > 3 { print NR, $1 } END { print "end", NR }'),
    'start\n2 beta\n3 alpha\nend 3\n');
  assert.equal(await transform(ctx, '/^alpha/'), 'alpha 2\nalpha 8\n');
  assert.equal(await transform(ctx, '$1 == "beta"'), 'beta 5\n');
  assert.equal(await transform(ctx, ''), '');
  await ctx.fs.write('empty', '');
  assert.equal(await transform(ctx, 'BEGIN {print "B"} {print "unexpected"} END {print "E", NR}', { files: 'empty' }), 'B\nE 0\n');
});

test('awk keeps independent inclusive pattern ranges and closes a range on its starting record', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'gap\nstart\nmiddle\nend\ngap\nstart\nend\n');
  assert.equal(await transform(ctx, '/start/,/end/'), 'start\nmiddle\nend\nstart\nend\n');
  assert.equal(await transform(ctx, 'NR==2,NR==3 {print "A",NR} NR==3,NR==4 {print "B",NR}'),
    'A 2\nA 3\nB 3\nB 4\n');
  await ctx.fs.write('input', 'x\nskip\nx\n');
  assert.equal(await transform(ctx, '/x/,/x/'), 'x\nx\n');
});

test('awk distinguishes numeric strings, strings, numbers, uninitialized values and truth values', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', '010 10 x\n');
  assert.equal(await transform(ctx,
    '{ print ($1==$2), ($1=="10"), ($1+0==$2), ("010"==10), ("10"==10), ("2"<10), ($3==0); print $1; print (u==0), (u==""), (u?1:0), ("0"?1:0) }'),
    '1 0 1 0 1 0 0\n010\n1 1 0 1\n');
  await ctx.fs.write('input', '0\n');
  assert.equal(await transform(ctx, '{ print ($1?1:0), ($1 "" ? 1 : 0) }'), '0 1\n');
});

test('awk arithmetic, concatenation, assignment, short circuiting and exponentiation have their intended precedence', async () => {
  const ctx = fresh();
  const program = 'BEGIN { a=2; b=3; print a+b*4, (a+b)*4, 2^3^2, -2^2, (-2)^2, 5%2; x=1; y=x++; z=++x; print y,z,x; 0 && (x=7); 1 || (x=8); print x; print "v" 1+2, (1<2 ? "yes" : "no") ":" 5; a=(b=4)+2; print a,b }';
  assert.equal(await transform(ctx, program, { files: '' }), '14 20 512 -4 4 1\n1 3 3\n3\nv3 yes:5\n6 4\n');
  assert.equal(await transform(ctx, 'BEGIN {x=0;print 0?1:x=2,x}', { files: '' }), '2 2\n');
});

test('awk field assignment and NF assignment rebuild records using OFS', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', '  a\tb  c  \n');
  assert.equal(await transform(ctx, 'BEGIN {OFS="|"} {$2="X"; print $0,NF; $5="z"; print $0,NF; NF=2; print $0,NF}'),
    'a|X|c|3\na|X|c||z|5\na|X|2\n');
  assert.equal(await transform(ctx, 'BEGIN {FS=":";OFS="|"} {$0="u:v"; print NF,$1,$2; NF=0; print "[" $0 "]",NF}'),
    '2|u|v\n[]|0\n');
});

test('awk FS, RS, ORS and paragraph records preserve their distinct splitting rules', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a::b:\n');
  assert.equal(await transform(ctx, '{ print NF,"[" $2 "]","[" $4 "]" }', { flags: '-F:' }), '4 [] []\n');
  await ctx.fs.write('input', 'a,,b::c\n');
  assert.equal(await transform(ctx, '{print NF,$1,$2,$3}', { flags: "-F '[,:]+'" }), '3 a b c\n');
  await ctx.fs.write('input', 'a:b:c');
  assert.equal(await transform(ctx, 'BEGIN {RS=":";ORS="|"} {print NR,$0}'), '1 a|2 b|3 c|');
  await ctx.fs.write('input', '\nalpha beta\nline two\n\n\nlast\n\n');
  assert.equal(await transform(ctx, 'BEGIN {RS=""} {print NR,NF,$1}'), '1 4 alpha\n2 1 last\n');
});

test('awk paragraph records preserve newline field splitting through record changes and distinguish regex FS', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a:b\nc:d\n');
  assert.equal(await transform(ctx, 'BEGIN {RS="";FS=":";OFS="|"} {$0=$0;print NF,$1,$2,$3,$4}'),
    '4|a|b|c|d\n');
  assert.equal(await transform(ctx, 'BEGIN {RS="";FS=":";OFS="|"} {sub(/a/,"A");print NF,$1,$2,$3,$4}'),
    '4|A|b|c|d\n');
  assert.equal(await transform(ctx, 'BEGIN {RS="";FS="[:]";OFS="|"} {print NF,$1,$2,$3}'),
    '3|a|b\nc|d\n');
});

test('awk NR, FNR and FILENAME track each file while operand assignments apply during traversal', async () => {
  const ctx = fresh();
  await ctx.fs.write('one', 'a\nb\n'); await ctx.fs.write('two', 'c\n');
  assert.equal(await transform(ctx, 'BEGIN {print "B",mark} {print NR,FNR,FILENAME,mark,$0} END {print "E",NR,FNR,FILENAME}',
    { flags: '-v mark=before', files: 'one mark=after two' }),
    'B before\n1 1 one before a\n2 2 one before b\n3 1 two after c\nE 3 1 two\n');
});

test('awk -f files combine in order and -v values exist before BEGIN', async () => {
  const ctx = fresh();
  await ctx.fs.write('work/input', 'left:right\n', { createParents: true });
  await ctx.fs.write('work/first.awk', 'BEGIN { prefix=prefix "-B" }\n');
  await ctx.fs.write('work/second.awk', '{print prefix,$2}\nEND {print NR}\n');
  assert.equal((await ctx.run('cd work')).code, 0);
  const result = await ctx.run("awk -F: -v prefix=V -f first.awk -f second.awk input > result");
  assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('work/result'), 'V-B right\n1\n');
  const escaped = await ctx.run("awk -v 'value=a\\tb' 'BEGIN {printf \"[%s]\",value}' > escapes");
  assert.equal(escaped.code, 0, escaped.output); assert.equal(await ctx.read('work/escapes'), '[a\tb]');
});

test('awk applies -F and -vFS in their command-line order before BEGIN', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a:b,c\n');
  const program = 'BEGIN {print FS} {print NF,$1,$2}';
  assert.equal(await transform(ctx, program, { flags: '-F: -vFS=,' }), ',\n2 a:b c\n');
  assert.equal(await transform(ctx, program, { flags: '-vFS=, -F:' }), ':\n2 a b,c\n');
});

test('awk mutable ARGC and ARGV can suppress input operands without exposing host arguments', async () => {
  const ctx = fresh();
  await ctx.fs.write('one', 'skip\n'); await ctx.fs.write('two', 'keep\n');
  assert.equal(await transform(ctx, 'BEGIN {print ARGC,ARGV[0],ARGV[1],ARGV[2]; delete ARGV[1]} {print FILENAME,$0}',
    { files: 'one two' }), '3 awk one two\ntwo keep\n');
  assert.equal(await transform(ctx, 'BEGIN {ARGC=2;ARGV[1]="two"} {print FILENAME,$0}',
    { files: 'one two' }), 'two keep\n');
});

test('awk ENVIRON uses virtual shell variables and does not mutate its caller environment', async () => {
  const ctx = fresh();
  await ctx.run('export SHELL_ONLY=outer');
  assert.equal(await transform(ctx, 'BEGIN { print ENVIRON["HOME"],ENVIRON["SHELL_ONLY"],("PATH" in ENVIRON); ENVIRON["SHELL_ONLY"]="inner"; print ENVIRON["SHELL_ONLY"] }',
    { files: '' }), '/ outer 0\ninner\n');
  assert.equal((await ctx.run('echo $SHELL_ONLY')).output, 'outer');
});

test('awk arrays support membership, deletion, iteration and composite SUBSEP indices', async () => {
  const ctx = fresh();
  const program = 'BEGIN { a["x"]=2; a["y"]=3; total=0; for(k in a) total+=a[k]; print total,("missing" in a); delete a["x"]; print ("x" in a),a["y"]; a[1,2]="joined"; key=1 SUBSEP 2; print a[key],((1,2) in a); SUBSEP=":"; a[3,4]=9; print a["3:4"] }';
  assert.equal(await transform(ctx, program, { files: '' }), '5 0\n0 3\njoined 1\n9\n');
});

test('awk user functions pass arrays by reference, scalars by value and omit parameters as locals', async () => {
  const ctx = fresh();
  const program = 'function bump(a,n,temporary) {a["x"]+=n; temporary=9; n=0; return a["x"]} function fill(a) {a[1]="yes"} function call(a) {fill(a)} function factorial(n) {return n<=1 ? 1 : n*factorial(n-1)} BEGIN {x=2; b["x"]=1; result=bump(b,x); print result,b["x"],x,(temporary==""); call(data); print data[1],factorial(6)}';
  assert.equal(await transform(ctx, program, { files: '' }), '3 3 2 1\nyes 720\n');
});

test('awk for, while, do-while, break and continue update their intended loop state', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {s=0; for(i=0;i<6;i++){if(i==2)continue;if(i==5)break;s+=i} j=0;while(j<2){s+=10;j++} do{s++}while(0); print s}',
    { files: '' }), '29\n');
});

test('awk next skips remaining rules and exit still runs END with its requested status', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\n');
  assert.equal(await transform(ctx, 'BEGIN {print "start"} NR%2==0 {next} {print NR,$0} END {print "end",NR}'),
    'start\n1 a\n3 c\nend 3\n');
  assert.equal(await transform(ctx, '{print;exit 7} END {print NR}', { code: 7 }), 'a\n1\n');
  assert.equal(await transform(ctx, 'BEGIN {print "B";exit 5} END {print "E"}', { files: 'missing', code: 5 }), 'B\nE\n');
});

test('awk print, printf and sprintf implement separators, numeric formats, widths and precisions', async () => {
  const ctx = fresh();
  const program = 'BEGIN {OFS=":";ORS="|";print 1,2;printf "%-5s:%04d:%.2f:%x:%o:%c\\n","hi",7,1.25,255,8,65;printf "[%*.*f]\\n",6,2,1.25;print sprintf("%s-%d","item",3)}';
  assert.equal(await transform(ctx, program, { files: '' }), '1:2|hi   :0007:1.25:ff:10:A\n[  1.25]\nitem-3|');
  assert.equal(await transform(ctx, 'BEGIN {OFMT="%.2f";CONVFMT="%.3f";n=1.23456;print n;print "[" n "]";printf "%s\\n",n}',
    { files: '' }), '1.23\n[1.235]\n1.235\n');
});

test('awk printf refuses insufficient arguments before a subsequent write', async () => {
  const ctx = fresh();
  const result = await ctx.run(quoteCommand('BEGIN {printf "%d %d",1;print "BAD" > "out"}'));
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /argument|format/i);
  assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk finite high-precision g and large fixed-point formats avoid host formatter limits', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {printf "%.100g",0.0001}', { files: '' }),
    '0.000100000000000000004792173602385929598312941379845142364501953125');
  assert.equal(await transform(ctx, 'BEGIN {printf "%.0f",1e21}', { files: '' }), `1${'0'.repeat(21)}`);
});

test('awk printf rounds exact binary ties to even for fixed and scientific forms', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {printf "%.0f %.0f %.0f %.0f %.1g %.1e %.1e",2.5,3.5,-2.5,-3.5,2.5,1.25,1.75}',
    { files: '' }), '2 4 -2 -4 2 1.2e+00 1.8e+00');
  assert.equal(await transform(ctx, 'BEGIN {printf "%d %i %d %.1f",-0,-0.9,-1.9,-0}',
    { files: '' }), '0 0 -1 -0.0');
});

test('awk printf evaluates excess arguments without reusing its format', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {n=0;printf "%s %s\\n","a","b",++n;print n}',
    { files: '' }), 'a b\n1\n');
});

test('awk print preserves integer conversion when OFMT specifies fractional digits', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {OFMT="%.2f";print 1,-0,1.25}',
    { files: '' }), '1 0 1.25\n');
});

test('awk treats a missing main input as fatal before later operands or END actions', async () => {
  const ctx = fresh();
  await ctx.fs.write('good', 'record\n');
  const result = await ctx.run(`${quoteCommand('{print FILENAME ":" $0} END {print "BAD" > "after-error"}')} missing good`);
  assert.equal(result.code, 2, result.output);
  assert.match(result.output, /ENOENT/);
  assert.doesNotMatch(result.output, /good:record/);
  assert.equal((await ctx.fs.stat('after-error')).ok, false);
});

test('awk string, match and split builtins update results and match metadata', async () => {
  const ctx = fresh();
  const program = 'BEGIN {print length("abcdef"),index("banana","na"),substr("abcdef",2,3),tolower("AZ!"),toupper("az!"); position=match("ab12cd",/[0-9]+/);print position,RSTART,RLENGTH;position=match("xyz",/[0-9]+/);print position,RSTART,RLENGTH; a["old"]="remove";n=split("a::b:",a,":");print n,a[1],"[" a[2] "]",a[3],"[" a[4] "]",("old" in a);n=split("",a,":");print n,("1" in a)}';
  assert.equal(await transform(ctx, program, { files: '' }), '6 3 bcd az! AZ!\n3 3 2\n0 0 -1\n4 a [] b [] 0\n0 0\n');
});

test('awk sub and gsub mutate only the requested target and match ERE alternatives longest first', async () => {
  const ctx = fresh();
  const program = 'BEGIN {x="aba";n=sub(/a/,"<&>",x);print n,x;n=gsub(/a/,"X",x);print n,x;position=match("ab",/a|ab/);print position,RLENGTH;pattern="[0-9]+";print ("a12" ~ pattern),("abc" !~ pattern)}';
  assert.equal(await transform(ctx, program, { files: '' }), '1 <a>ba\n2 <X>bX\n1 2\n1 1\n');
  await ctx.fs.write('input', 'a:b\n');
  assert.equal(await transform(ctx, 'BEGIN {FS=":"} {gsub(/:/," ");print $0,NF,$1}'), 'a b 1 a b\n');
});

test('awk math builtins use numeric values and seeded random sequences repeat within a run', async () => {
  const ctx = fresh();
  const program = 'BEGIN {printf "%d %d %d %d %d %d %.3f\\n",int(-2.8),sqrt(9),exp(0),log(1),sin(0),cos(0),atan2(0,-1);srand(123);a=rand();b=rand();srand(123);sameA=(a==rand());sameB=(b==rand());print sameA,sameB,(a>=0&&a<1),(b>=0&&b<1)}';
  assert.equal(await transform(ctx, program, { files: '' }), '-2 3 1 0 0 1 3.142\n1 1 1 1\n');
});

test('awk main getline with a target increments counters without replacing the current record', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb\nc\n');
  assert.equal(await transform(ctx, '{print "before",NR,FNR,$0;r=getline value;print "read",r,NR,FNR,value,$0}'),
    'before 1 1 a\nread 1 2 2 b a\nbefore 3 3 c\nread 0 3 3 b c\n');
});

test('awk main getline without a target installs fields and END sees the final counters', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a\nb c\n');
  assert.equal(await transform(ctx, 'BEGIN {while((getline)>0)print NR,FNR,NF,$0;print "eof",NR,FNR} END {print "end",NR}'),
    '1 1 1 a\n2 2 2 b c\neof 2 2\nend 2\n');
});

test('awk file getline keeps counters unchanged, retains the target at EOF and close rewinds a later open', async () => {
  const ctx = fresh();
  await ctx.fs.write('extra', 'x\ny\n');
  const program = 'BEGIN {print NR,FNR;status=(getline value < "extra");print status,value,NR,FNR;status=(getline value < "extra");print status,value,NR,FNR;status=(getline value < "extra");print status,value;print close("extra");status=(getline value < "extra");print status,value;print (getline missing < "absent")}';
  assert.equal(await transform(ctx, program, { files: '' }), '0 0\n1 x 0 0\n1 y 0 0\n0 y\n0\n1 x\n-1\n');
  await ctx.fs.write('extra', 'a:b\n');
  assert.equal(await transform(ctx, 'BEGIN {FS=":";status=(getline < "extra");print status,$0,NF,$1,NR,FNR}',
    { files: '' }), '1 a:b 2 a 0 0\n');
});

test('awk getline aliases have independent cursors and close matches the exact literal stream name', async () => {
  const ctx = fresh();
  await ctx.fs.write('out', 'first\nsecond\nthird\n');
  const program = 'BEGIN {getline a < "out";getline b < "./out";print a,b;getline a < "out";print a;close("out");getline b < "./out";print b;getline a < "out";print a}';
  assert.equal(await transform(ctx, program, { files: '' }), 'first first\nsecond\nsecond\nfirst\n');
});

test('awk output streams truncate once, append subsequent writes, and close permits a new truncating open', async () => {
  const ctx = fresh();
  await ctx.fs.write('out', 'old\n'); await ctx.fs.write('append', 'keep\n');
  const result = await ctx.run(quoteCommand('BEGIN {print "first" > "out";print "second" > "out";print close("out");print "third" > "out";print "fourth" >> "out";print "new" >> "append"}'));
  assert.equal(result.code, 0, result.output); assert.equal(result.output, '0');
  assert.equal(await ctx.read('out'), 'third\nfourth\n'); assert.equal(await ctx.read('append'), 'keep\nnew\n');
  await ctx.fs.write('input', 'a\nb\nc\n');
  const records = await ctx.run(`${quoteCommand('{print $0 > "out"}')} input`);
  assert.equal(records.code, 0, records.output); assert.equal(await ctx.read('out'), 'a\nb\nc\n');
});

test('awk output aliases remain distinct streams under governed immediate writes', async () => {
  const ctx = fresh();
  const program = 'BEGIN {print "a" > "out";print "b" > "./out";close("out");print "c" > "./out";close("./out")}';
  const result = await ctx.run(quoteCommand(program));
  assert.equal(result.code, 0, result.output);
  assert.equal(await ctx.read('out'), 'b\nc\n');
});

test('awk distinguishes comparison expressions from print redirection and regex literals from division', async () => {
  const ctx = fresh();
  assert.equal(await transform(ctx, 'BEGIN {x=8/2/2;print (x>1),(x<1),x,"# literal"} # comment\n', { files: '' }),
    '1 0 2 # literal\n');
  await ctx.fs.write('input', '#match\nother\n');
  assert.equal(await transform(ctx, '/#/ {print $0}'), '#match\n');
});

test('awk parses the whole program before BEGIN writes and rejects unsupported process execution explicitly', async () => {
  const ctx = fresh();
  await ctx.fs.write('out', 'keep\n');
  for (const program of [
    'BEGIN {print "BAD" > "out"} {if(}',
    'BEGIN {print "BAD" > "out"} function f(x,x) {return x}',
    'BEGIN {print "BAD" > "out"} {1=2}',
    'BEGIN {print "BAD" > "out"} {break}',
    'BEGIN {print "BAD" > "out"} {return 1}',
    'BEGIN {print "BAD" > "out"} /unterminated',
    'BEGIN {print "BAD" > "out"} {(x)=3}',
    'BEGIN {print "BAD" > "out"} {++(x)}',
    'BEGIN {print "BAD" > "out"} {print (x)++}',
    'BEGIN {print "BAD" > "out";print 1>=0}',
    'BEGIN {print "BAD" > "out";print 1 ?\n2 : 3}',
    'BEGIN {print "BAD" > "out";print 0 ? 2 :\n3}',
    'BEGIN {print "BAD" > "out"} /[/]/ {print}',
  ]) {
    const result = await ctx.run(quoteCommand(program));
    assert.equal(result.code, 2, program); assert.match(result.output, /awk:/, program);
    assert.equal(await ctx.read('out'), 'keep\n', program);
    assert.equal(ctx.shell.awaitingConfirm, null);
  }
  for (const program of ['BEGIN {system("touch escaped")}', 'BEGIN {"echo escaped" | getline x}', 'BEGIN {print "escaped" | "cat"}']) {
    const result = await ctx.run(quoteCommand(program));
    assert.equal(result.code, 2, program); assert.match(result.output, /unsupported|not supported|unavailable|cannot/i, program);
    assert.equal((await ctx.fs.stat('escaped')).ok, false);
  }
  for (const command of ['awk', 'awk -F', 'awk -v', 'awk -f', "awk --unsupported 'BEGIN{print 1}'"]) {
    assert.equal((await ctx.run(command)).code, 2, command);
  }
});

test('awk refuses scalar-array conflicts, unknown functions and invalid fields without applying a later write', async () => {
  const ctx = fresh();
  for (const program of ['BEGIN {a=1;a[1]=2;print "BAD">"out"}', 'BEGIN {missing();print "BAD">"out"}',
    'BEGIN {$(-1)="bad";print "BAD">"out"}', 'BEGIN {x=1/0;print "BAD">"out"}']) {
    const result = await ctx.run(quoteCommand(program));
    assert.notEqual(result.code, 0, program); assert.match(result.output, /awk:/, program);
    assert.equal((await ctx.fs.stat('out')).ok, false, program);
  }
});

test('awk script reads, input reads, redirected writes and append reads obey grants', async () => {
  const readOnly = fresh({ scopes: ['fs:read'] });
  await readOnly.fs.write('input', 'source\n'); await readOnly.fs.write('out', 'keep\n');
  for (const program of ['{print > "out"}', '{print >> "out"}', 'BEGIN {printf "bad" > "out"}']) {
    const result = await readOnly.run(`${quoteCommand(program)} input`);
    assert.notEqual(result.code, 0, program); assert.match(result.output, /EGRANT|not granted/, program);
    assert.equal(await readOnly.read('out'), 'keep\n');
  }
  const protectedPath = fresh({ readOnlyPrefixes: ['out'] });
  await protectedPath.fs.write('out', 'keep\n');
  assert.notEqual((await protectedPath.run(quoteCommand('BEGIN {print "bad" > "out"}'))).code, 0);
  assert.equal(await protectedPath.read('out'), 'keep\n');
  const writeOnly = fresh({ scopes: ['fs:write'] });
  await writeOnly.fs.write('out', 'keep\n');
  const append = await writeOnly.run(quoteCommand('BEGIN {print "bad" >> "out"}'));
  assert.notEqual(append.code, 0, append.output); assert.match(append.output, /EGRANT|not granted/);
  assert.equal(await writeOnly.read('out'), 'keep\n', 'append cannot read existing bytes without a read grant');
  const restricted = fresh({ prefixes: ['allowed'] });
  await restricted.fs.write('allowed/input', 'public\n', { createParents: true });
  await restricted.fs.write('private/input', 'secret content\n', { createParents: true });
  await restricted.fs.write('private/script', '{print}\n');
  for (const command of ["awk '{print}' private/input", 'awk -f private/script allowed/input']) {
    const result = await restricted.run(command);
    assert.notEqual(result.code, 0, command); assert.match(result.output, /EGRANT|not granted|outside/, command);
    assert.doesNotMatch(result.output, /secret content/);
  }
  const deniedGetline = await restricted.run(quoteCommand('BEGIN {status=(getline value < "private/input");print status,value}'));
  assert.doesNotMatch(deniedGetline.output, /secret content/);
  assert.ok(deniedGetline.code !== 0 || /^-1(?:\s|$)/.test(deniedGetline.output), deniedGetline.output);
});

test('awk checks oversized input, script and append metadata before asking the backend for full bytes', async () => {
  const fixtures = [
    { path: 'input', content: 'small input\n', command: `${quoteCommand('{print "BAD" > "created"}')} input` },
    { path: 'program.awk', content: 'BEGIN {print "BAD" > "created"}', command: 'awk -f program.awk' },
    { path: 'out', content: 'keep append destination\n', command: quoteCommand('BEGIN {print "BAD" >> "out"}') },
  ];
  for (const fixture of fixtures) {
    const ctx = fresh();
    await ctx.fs.write(fixture.path, fixture.content);
    const originalStat = ctx.backend.stat.bind(ctx.backend);
    const originalRead = ctx.backend.readBinary.bind(ctx.backend);
    let fullReads = 0;
    ctx.backend.stat = async (path) => {
      const stat = await originalStat(path);
      return path === fixture.path && stat ? { ...stat, size: 1073741824 } : stat;
    };
    ctx.backend.readBinary = async (path) => {
      if (path === fixture.path) fullReads++;
      return originalRead(path);
    };
    const result = await ctx.run(fixture.command);
    assert.notEqual(result.code, 0, fixture.command);
    assert.match(result.output, /limit|too large|exceed|EFBIG/i, fixture.command);
    assert.equal(fullReads, 0, `${fixture.path}: oversized metadata must prevent a full backend read`);
    ctx.backend.stat = originalStat; ctx.backend.readBinary = originalRead;
    assert.equal(await ctx.read(fixture.path), fixture.content, 'preflight refusal leaves the source or append destination intact');
    assert.equal((await ctx.fs.stat('created')).ok, false);
  }
});

test('awk bounded reads keep grants ahead of metadata or content access', async () => {
  const ctx = fresh({ scopes: ['fs:write'] });
  await ctx.fs.write('out', 'keep\n');
  const originalStat = ctx.backend.stat.bind(ctx.backend);
  const originalRead = ctx.backend.readBinary.bind(ctx.backend);
  let metadataReads = 0, fullReads = 0;
  ctx.backend.stat = async (path) => {
    if (path === 'out') metadataReads++;
    const stat = await originalStat(path);
    return path === 'out' && stat ? { ...stat, size: 1073741824 } : stat;
  };
  ctx.backend.readBinary = async (path) => {
    if (path === 'out') fullReads++;
    return originalRead(path);
  };
  const result = await ctx.run(quoteCommand('BEGIN {print "BAD" >> "out"}'));
  assert.notEqual(result.code, 0, result.output); assert.match(result.output, /EGRANT|not granted/);
  assert.equal(metadataReads, 0); assert.equal(fullReads, 0);
  ctx.backend.stat = originalStat; ctx.backend.readBinary = originalRead;
  assert.equal(await ctx.read('out'), 'keep\n');
});

test('awk resumes staged writes in program order before executing the following shell statement', async () => {
  const ctx = fresh({ stageWrites: true });
  await ctx.fs.write('out', 'keep\n');
  let result = await ctx.run(`${quoteCommand('BEGIN {print "first" > "out";print "second" > "out"}')} ; echo FINISHED`);
  assert.ok(result.awaitingConfirm); assert.equal(await ctx.read('out'), 'keep\n');
  let confirmations = 0;
  while (result.awaitingConfirm) {
    assert.doesNotMatch(result.output, /FINISHED/);
    assert.ok(++confirmations < 10, 'a two-write program has a bounded number of confirmations');
    result = await ctx.run('y');
  }
  assert.equal(result.code, 0, result.output); assert.match(result.output, /FINISHED$/);
  assert.equal(await ctx.read('out'), 'first\nsecond\n');
  assert.deepEqual(ctx.face.pendingProposals(), []);
});

test('Stop cancels a suspended awk write and later commands while allowing the next independent invocation', async () => {
  const ctx = fresh({ stageWrites: true });
  await ctx.fs.write('out', 'keep\n');
  const first = await ctx.run(`${quoteCommand('BEGIN {print "BAD" > "out"}')} ; echo BAD > after-stop`);
  assert.ok(first.awaitingConfirm); assert.equal(await ctx.read('out'), 'keep\n');
  const stopped = await ctx.shell.cancel();
  assert.equal(ctx.shell.lastCode, 130); assert.match(stopped.output, /interrupted/);
  assert.equal(await ctx.read('out'), 'keep\n'); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []); assert.equal(ctx.shell.awaitingConfirm, null);
  assert.equal((await ctx.run(quoteCommand('BEGIN {print "next"}'))).output, 'next');
});

test('awk preserves arbitrary bytes through printf and counts characters under its stated C byte locale', async () => {
  const ctx = fresh();
  const input = Uint8Array.of(255, 65, 0, 128);
  await ctx.fs.write('input', input);
  const copied = await ctx.run(`cat input | ${quoteCommand('{printf "%s",$0}')} | cat > copy`);
  assert.equal(copied.code, 0, copied.output); assert.deepEqual(await ctx.bytes('copy'), Array.from(input));
  await ctx.fs.write('input', Uint8Array.of(255, 10, 128));
  assert.equal((await ctx.run(`${quoteCommand('{print}')} input > copy`)).code, 0);
  assert.deepEqual(await ctx.bytes('copy'), [255, 10, 128, 10], 'print adds ORS even to an unterminated final record');
  await ctx.fs.write('input', new TextEncoder().encode('\ufeffé'));
  const bomCopy = await ctx.run(`${quoteCommand('{printf "%s",$0}')} input > copy`);
  assert.equal(bomCopy.code, 0, bomCopy.output);
  assert.deepEqual(await ctx.bytes('copy'), Array.from(new TextEncoder().encode('\ufeffé')));
  assert.equal(await transform(ctx, '{print length($0)}'), '5\n');
});

test('awk bounds CPU loops, recursive calls and growing values with explicit diagnostics', { timeout: 20000 }, async () => {
  const ctx = fresh();
  for (const program of ['BEGIN {while(1) x++}',
    'function f(n) {return f(n+1)} BEGIN {f(0)}',
    'BEGIN {value="x";while(1)value=value value}',
    'BEGIN {for(i=0;;i++)a[i]=i}']) {
    const result = await ctx.run(quoteCommand(program));
    assert.notEqual(result.code, 0, program);
    assert.match(result.output, /limit|bound|too (?:many|large)|recursion/i, program);
    assert.doesNotMatch(result.output, /RangeError|call stack/i);
  }
});

test('awk enforces an output cap before an unbounded print loop exhausts its instruction budget', { timeout: 5000 }, async () => {
  const ctx = fresh();
  const result = await ctx.run(quoteCommand('BEGIN {while(1)printf "%65536s","x"}'));
  assert.notEqual(result.code, 0, result.output); assert.match(result.output, /output.*limit|limit.*output/i);
  const wide = await ctx.run(quoteCommand('BEGIN {printf "%1000000000s","x"}'));
  assert.notEqual(wide.code, 0); assert.match(wide.output, /limit|too (?:large|wide)/i);
});

test('awk bounds aggregate retained array bytes before a subsequent write', { timeout: 5000 }, async () => {
  const ctx = fresh();
  const result = await ctx.run(quoteCommand('BEGIN {value=sprintf("%262144s","x");for(i=0;i<128;i++)a[i]=value i;print "BAD" > "out"}'));
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /array.*(?:storage|limit)/i);
  assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk limits simultaneously open output streams explicitly', { timeout: 10000 }, async () => {
  const ctx = fresh();
  const result = await ctx.run(quoteCommand('BEGIN {for(i=0;i<4096;i++)print i > ("stream-" i)}'));
  assert.notEqual(result.code, 0, result.output); assert.match(result.output, /stream|open.*limit/i);
  const entries = (await ctx.fs.list('', { recursive: true })).entries;
  assert.ok(entries.length < 4096, 'stream bounds stop file creation before all requested names open');
});

test('awk source nesting limits fail explicitly before any BEGIN mutation', async () => {
  const ctx = fresh();
  const program = `BEGIN {print "BAD" > "out";print ${'('.repeat(512)}1${')'.repeat(512)}}`;
  const result = await ctx.run(quoteCommand(program));
  assert.equal(result.code, 2, result.output); assert.match(result.output, /nest|depth|limit/i);
  assert.doesNotMatch(result.output, /RangeError|call stack/i); assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk bounds record counts and rejects an excessive field count before a later mutation', { timeout: 20000 }, async () => {
  const ctx = fresh();
  await ctx.fs.write('input', '\n'.repeat(262145));
  const records = await ctx.run(`${quoteCommand('{}')} input`);
  assert.notEqual(records.code, 0, records.output); assert.match(records.output, /record.*limit/i);
  const fields = await ctx.run(quoteCommand('BEGIN {NF=1000000000;print "BAD" > "out"}'));
  assert.notEqual(fields.code, 0, fields.output); assert.match(fields.output, /NF|field|limit/i);
  assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk rejects an oversized OFS record rebuild before a subsequent write', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', 'a b c\n');
  const program = 'BEGIN {OFS="x";for(i=0;i<23;i++)OFS=OFS OFS} {$1="x";print "BAD" > "out"}';
  const result = await ctx.run(`${quoteCommand(program)} input`);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /buffer.*limit|limit.*buffer|record.*limit/i);
  assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk limits actual field splitting before executing a later write', async () => {
  const ctx = fresh();
  await ctx.fs.write('input', `${Array(100001).fill('x').join(' ')}\n`);
  const result = await ctx.run(`${quoteCommand('{count=NF;print "BAD" > "out"}')} input`);
  assert.notEqual(result.code, 0, result.output);
  assert.match(result.output, /field.*limit/i);
  assert.equal((await ctx.fs.stat('out')).ok, false);
});

test('awk bounds expensive regex evaluation while preserving a correct result when matching completes', { timeout: 5000 }, async () => {
  const ctx = fresh();
  const result = await ctx.run(quoteCommand(`BEGIN {print ("${'a'.repeat(64)}" ~ /^(a|aa)*b$/)}`));
  if (result.code === 0) assert.equal(result.output, '0');
  else assert.match(result.output, /limit|bound|too (?:many|large)/i);
  assert.doesNotMatch(result.output, /RangeError|call stack/i);
});

test('awk yields CPU loops so scheduled Stop prevents subsequent writes', { timeout: 5000 }, async () => {
  const controller = new AbortController(), ctx = fresh({ signal: controller.signal });
  const timer = setTimeout(() => controller.abort(), 10);
  try {
    const result = await ctx.run(`${quoteCommand('BEGIN {while(1)x++}')} ; echo BAD > after-stop`);
    assert.equal(result.code, 130, result.output); assert.match(result.output, /interrupted/);
    assert.equal((await ctx.fs.stat('after-stop')).ok, false); assert.deepEqual(ctx.face.pendingProposals(), []);
  } finally { clearTimeout(timer); }
});

test('awk observes Stop during input I/O before its action or continuation can write', async () => {
  const controller = new AbortController(), ctx = fresh({ signal: controller.signal });
  await ctx.fs.write('input', 'keep\n');
  const originalRead = ctx.backend.readBinary.bind(ctx.backend);
  ctx.backend.readBinary = async (...args) => {
    const result = await originalRead(...args); if (args[0] === 'input') controller.abort(); return result;
  };
  const result = await ctx.run(`${quoteCommand('{print "BAD" > "out"}')} input ; echo BAD > after-stop`);
  assert.equal(result.code, 130, result.output); assert.match(result.output, /interrupted/);
  assert.equal((await ctx.fs.stat('out')).ok, false); assert.equal((await ctx.fs.stat('after-stop')).ok, false);
  assert.deepEqual(ctx.face.pendingProposals(), []);
});
