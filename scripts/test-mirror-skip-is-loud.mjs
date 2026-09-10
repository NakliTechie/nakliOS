#!/usr/bin/env node
// A skipped mirror must never be readable as a success.
//
// Why this exists: NakliTechie/nakliamp is private, the scheduled workflow runs with the
// repo-scoped `github.token`, GitHub answers 404 for a source it may not see, and sync-mirrors
// SKIPS an unreadable source so one bad mirror does not stop the sweep. That skip was a
// console.warn on a process that exited 0, inside a workflow step that then went green. The
// mirror sat at 0.1.0-m0 from August to 2026-09-10 while every run reported success.
//
// `validate-mirrors` cannot catch it: a skipped mirror keeps its lock entry, so the lock and
// the on-disk files still agree. The staleness is only visible at the moment of the skip.
//
// Runs the real script against a stub GitHub (a local HTTP server that 404s one source), so it
// exercises the actual fetch/skip path rather than a re-implementation of it.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
const ok = (name, cond) => { if (cond) { pass++; } else { fail++; console.error('FAIL:', name); } };

// ── a stub GitHub: `readable` resolves and serves; `secret` 404s like a private repo ──
const SHA = 'a'.repeat(40);
const server = createServer((req, res) => {
  if (req.url.includes('/secret/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"message":"Not Found"}'); return; }
  if (req.url.includes('/commits/')) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ sha: SHA })); return; }
  res.writeHead(200, { 'content-type': 'text/plain' }); res.end('<!doctype html>mirrored\n');
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// The script hardcodes api.github.com / raw.githubusercontent.com, so point them at the stub
// through a tiny fetch shim injected with --import.
const dir = await mkdtemp(path.join(tmpdir(), 'mirrorskip-'));
await mkdir(path.join(dir, 'apps'), { recursive: true });
await writeFile(path.join(dir, 'shim.mjs'), `
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => realFetch(
  String(url).replace('https://api.github.com', '${base}').replace('https://raw.githubusercontent.com', '${base}'),
  init,
);
`);
const manifest = { apps: [
  { id: 'readable', repo: 'org/readable', ref: 'main', files: [{ source: 'index.html', destination: 'index.html' }] },
  { id: 'secret', repo: 'org/secret', ref: 'main', files: [{ source: 'index.html', destination: 'index.html' }] },
] };
await writeFile(path.join(dir, 'apps', 'manifest.json'), JSON.stringify(manifest, null, 2));
// `secret` needs a prior lock entry, or the script errors instead of skipping.
await writeFile(path.join(dir, 'apps', 'manifest.lock.json'), JSON.stringify({ version: 1, apps: [
  { id: 'secret', repo: 'org/secret', requestedRef: 'main', resolvedCommit: 'b'.repeat(40),
    files: [{ source: 'index.html', destination: 'index.html', sha256: 'x', bytes: 1 }] },
], }, null, 2));
await mkdir(path.join(dir, 'apps', 'secret'), { recursive: true });
await writeFile(path.join(dir, 'apps', 'secret', 'index.html'), 'stale\n');

// sync-mirrors derives its root from its OWN location (`import.meta.url`/..), not from cwd, so
// running the real script from a scratch cwd still writes into THIS repo's apps/ — it did,
// once, during development. Copy it into the scratch tree so its root resolves there.
await mkdir(path.join(dir, 'scripts'), { recursive: true });
const script = path.join(dir, 'scripts', 'sync-mirrors.mjs');
for (const file of ['sync-mirrors.mjs', 'mirror-lib.mjs']) {
  await writeFile(path.join(dir, 'scripts', file), await readFile(path.resolve('scripts', file), 'utf8'));
}

function run(args, env = {}) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, ['--import', path.join(dir, 'shim.mjs'), script, ...args],
      { cwd: dir, env: { ...process.env, ...env } });
    let out = '', err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('close', code => resolve({ code, out, err }));
  });
}

// ── 1. a skip is reported, and the readable mirror still syncs ──
{
  const r = await run([]);
  ok('the readable mirror still syncs despite a skipped sibling', /readable\/index\.html/.test(r.out));
  ok('the skip names the mirror', /secret/.test(r.out + r.err));
  ok('the skip says the copy may be any age', /may be any age/.test(r.out + r.err));
  ok('the skip names the remedy', /MIRROR_SYNC_TOKEN/.test(r.out + r.err));
  ok('it warns that validate-mirrors will NOT catch this', /validate-mirrors will still pass/.test(r.out + r.err));
}

// ── 2. --strict makes an undeclared skip fatal ──
{
  const r = await run(['--strict']);
  ok('--strict exits non-zero on an undeclared skip', r.code !== 0);
  ok('--strict says why it failed', /not be read as "up to date"|not read as "up to date"/.test(r.out + r.err));
}

// ── 3. a DECLARED skip is tolerated, and stays visible ──
{
  const r = await run(['--strict', '--allow-skip=secret']);
  ok('--allow-skip lets a known-unreadable mirror pass', r.code === 0);
  ok('a declared skip is still reported', /secret/.test(r.out + r.err));
}

// ── 4. the job output the workflow gates on ──
{
  const outFile = path.join(dir, 'gh-output');
  await writeFile(outFile, '');
  await run([], { GITHUB_OUTPUT: outFile });
  const written = await readFile(outFile, 'utf8');
  ok('an undeclared skip is written to GITHUB_OUTPUT', /skipped=secret/.test(written));
  await writeFile(outFile, '');
  await run(['--allow-skip=secret'], { GITHUB_OUTPUT: outFile });
  ok('a declared skip is NOT written to GITHUB_OUTPUT', !/skipped=/.test(await readFile(outFile, 'utf8')));
}

// ── 5. Actions annotations, so it lands on the run summary ──
//
// Content assertions alone are too weak here: a plain console.warn prints the same words and
// passes them, while being invisible on a green Actions run — which is the whole failure being
// fixed. So assert the ANNOTATION specifically, per mirror, not just somewhere in the output.
// (A mutation reverting the per-mirror annotate() to console.warn survived until this existed.)
{
  const r = await run([], { GITHUB_ACTIONS: 'true' });
  const lines = r.out.split('\n');
  const perMirror = lines.filter(l => l.startsWith('::error::') && /\bsecret\b/.test(l));
  ok('the skipped mirror gets its OWN error annotation', perMirror.length >= 1);
  ok('that annotation carries the staleness warning', perMirror.some(l => /may be any age/.test(l)));
  ok('that annotation carries the remedy', perMirror.some(l => /MIRROR_SYNC_TOKEN/.test(l)));

  const declared = await run(['--allow-skip=secret'], { GITHUB_ACTIONS: 'true' });
  const dLines = declared.out.split('\n').filter(l => /\bsecret\b/.test(l) && l.startsWith('::'));
  ok('a DECLARED skip annotates as a warning, not an error',
    dLines.some(l => l.startsWith('::warning::')) && !dLines.some(l => l.startsWith('::error::')));
}

server.close();
console.log(`mirror-skip-is-loud: ${pass}/${pass + fail} passed`);
process.exit(fail ? 1 : 0);
