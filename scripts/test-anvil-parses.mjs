// The check the grep-based app-contract tests lacked: EXTRACT Anvil's inline module and actually
// parse it. A duplicated function header (2026-09-06 run 5) left every grep test green while the
// app was syntactically dead — a browser module script throws at load. This closes that gap.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const html = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');
const blocks = [...html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)].map((m) => m[1]);
assert.ok(blocks.length >= 1, 'Anvil has an inline module');
// Strip the import lines (their bare specifiers do not resolve under a bare node --check) and
// parse the rest — a syntax error (unbalanced braces, a duplicated header) fails here.
const body = blocks.join('\n').split('\n').filter((l) => !/^\s*import\s/.test(l)).join('\n');
const f = join(tmpdir(), 'anvil-module-parse-check.mjs');
await writeFile(f, body);
execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); // throws on a syntax error

// A branch disabled by a constant guard parses, runs, and passes every grep anchor inside it —
// a cross-family review turned the whole `history` handler off with `if(false) if(nm===…)` and
// the suite stayed green. There is no legitimate use of a constant-false guard in this module,
// so its ABSENCE is a check worth making cheaply, over the whole file at once.
const dead = body.split('\n')
  .map((line, i) => [i + 1, line])
  .filter(([, line]) => /\bif\s*\(\s*(false|0|!\s*1|null|undefined)\s*\)/.test(line) && !/^\s*(\/\/|\*)/.test(line));
if (dead.length) {
  throw new Error(`a constant-false guard disables live code (line${dead.length === 1 ? '' : 's'} ${dead.map(([i]) => i).join(', ')}):\n` +
    dead.map(([i, l]) => `  ${i}: ${l.trim().slice(0, 120)}`).join('\n'));
}
console.log(`anvil-parses: the inline module (${body.split('\n').length} lines) parses`);
