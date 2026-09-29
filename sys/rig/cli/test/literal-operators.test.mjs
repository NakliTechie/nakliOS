import test from 'node:test';
import assert from 'node:assert/strict';
import { createShell } from '../shell.mjs';
import { createFileops, MemoryBackend } from '../../fileops/index.mjs';
import { buildRigRegistry } from '../../registry/index.mjs';
import { createAgentFace, createGrant, createOpLog } from '../../agent/index.mjs';

function fresh() {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const face = createAgentFace({ registry, actor: 'literal-operators',
    grant: createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] }),
    opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }) });
  const shell = createShell({ registry, face });
  return { fs, shell, run: async (line) => ({ ...await shell.feed(line), code: shell.lastCode }) };
}

test('quoted standalone operators remain arguments without redirection or execution', async () => {
  const ctx = fresh();
  for (const quote of ["'", '"']) {
    const operators = [';', '|', '&&', '||', '>', '>>', '<', '&', '(', ')'];
    const result = await ctx.run(`echo ${operators.map((op) => quote + op + quote).join(' ')}`);
    assert.equal(result.code, 0, result.output);
    assert.equal(result.output.trim(), operators.join(' '));
    assert.equal((await ctx.fs.stat('>>')).ok, false);
  }
});

test('escaped operators, spaces, quotes and comments survive as literal arguments', async () => {
  const ctx = fresh();
  const result = await ctx.run(String.raw`printf '%s\n' \; \| \&\& \> \< \( \) one\ two \# \' \"`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), ';\n|\n&&\n>\n<\n(\n)\none two\n#\n\'\n"');
});

test('double-quoted escaped dollars stay literal while ordinary dollars expand', async () => {
  const ctx = fresh();
  await ctx.run('export VALUE=expanded');
  const result = await ctx.run(String.raw`printf '%s\n' "$VALUE" "\$VALUE" '$VALUE' \$VALUE`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), 'expanded\n$VALUE\n$VALUE\n$VALUE');
});

test('escaped glob characters select a literal pathname', async () => {
  const ctx = fresh();
  await ctx.fs.write('a*', 'literal-star\n');
  await ctx.fs.write('ab', 'expanded-match\n');
  const result = await ctx.run(String.raw`cat a\*`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), 'literal-star');
});

test('escaped double quotes do not expose a quoted semicolon as a shell separator', async () => {
  const ctx = fresh();
  const result = await ctx.run(String.raw`echo "a\";b"; echo after`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), 'a";b\nafter');
});

test('escaped less-than characters do not begin a here-document', async () => {
  const ctx = fresh();
  const result = await ctx.run(String.raw`echo \<\<EOF`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), '<<EOF');
});

test('unquoted operators retain pipeline, conditional and redirection behavior', async () => {
  const ctx = fresh();
  const result = await ctx.run('printf a | wc -c > count; false && echo absent; true && cat count');
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trim(), '1');
  assert.equal((await ctx.fs.read('count', { encoding: 'utf-8' })).data, '1\n');
});


test('a hash after escaped whitespace remains part of the same argument', async () => {
  const ctx = fresh();
  const result = await ctx.run(String.raw`echo a\ #b`);
  assert.equal(result.code, 0, result.output);
  assert.equal(result.output.trimEnd(), 'a #b');
});

test('substitution detection does not mistake escaped whitespace for a comment boundary', async () => {
  const ctx = fresh();
  const result = await ctx.run(String.raw`echo a\ #$(rm x)`);
  assert.equal(result.code, 0, result.output);
  assert.match(result.stderr, /rm: x: ENOENT/);
  assert.equal(result.stdout, 'a #\n');
});
