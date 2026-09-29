// B13 independent verifier draft. Do not execute before the whole-build release.
// Permanent destination: scripts/test-unix-portability.mjs.
// Run from the repository root:
// node --experimental-vm-modules scripts/test-unix-portability.mjs <completed-B12-SHA>
// This verifier never imports the manifest generator or application checkout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPOSITORY = 'https://github.com/NakliTechie/nakliOS';
const MANIFEST = 'docs/kothri-unix-imports.json';
const ENTRYPOINTS = [
  'sys/rig/agent/index.mjs',
  'sys/rig/cli/shell.mjs',
  'sys/rig/fileops/index.mjs',
  'sys/rig/git/git-core.mjs',
  'sys/rig/registry/index.mjs',
];
const SUPPORTING = [
  'LICENSE',
  'vendor/isomorphic-git/1.40.0/LICENSE.md',
  'vendor/isomorphic-git/1.40.0/README.md',
  'vendor/js-yaml/LICENSE',
  'vendor/js-yaml/PROVENANCE.json',
];
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sortedUnique = (values) => [...new Set(values)].sort();

function portablePath(value) {
  assert.equal(typeof value, 'string', 'path must be a string');
  assert.match(value, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, `portable relative path: ${value}`);
  assert.ok(value.split('/').every((part) => part !== '.' && part !== '..'), `no dot segments: ${value}`);
  return value;
}

function rowsByPath(rows, label) {
  assert.ok(Array.isArray(rows) && rows.length > 0, `${label}: nonempty array`);
  for (const row of rows) {
    assert.ok(row && typeof row === 'object' && !Array.isArray(row), `${label}: object row`);
    portablePath(row.path);
    assert.match(row.sha256, SHA256, `${row.path}: lowercase SHA-256`);
    assert.ok(Number.isSafeInteger(row.bytes) && row.bytes > 0, `${row.path}: positive byte length`);
  }
  const paths = rows.map((row) => row.path);
  assert.deepEqual(paths, sortedUnique(paths), `${label}: unique paths in lexical order`);
  return new Map(rows.map((row) => [row.path, row]));
}

test('B13 immutable source closure and browser-free Node integration', { timeout: 120000 }, async (t) => {
  const repository = process.cwd();
  const expectedCommit = process.argv[2];
  assert.equal(process.argv.length, 3, 'supply exactly one caller-owned completed B12 SHA');
  assert.equal(typeof expectedCommit, 'string', 'expected source SHA is required');
  assert.match(expectedCommit, SHA1, 'expected source must be a full immutable lowercase SHA');
  assert.equal(typeof vm.SourceTextModule, 'function', 'run Node with --experimental-vm-modules');
  const git = (...args) => execFileSync('git', args, { cwd: repository, maxBuffer: 64 * 1024 * 1024 });
  const sourceBytes = (name) => git('show', `${expectedCommit}:${portablePath(name)}`);
  let manifestText;
  await assert.doesNotReject(async () => {
    manifestText = await readFile(path.join(repository, MANIFEST), 'utf8');
  }, 'the published portability manifest must exist');
  const manifest = JSON.parse(manifestText);
  const blobs = new Map();
  let modules, supporting;

  await t.test('manifest schema and pin agree with the caller-owned release', () => {
    assert.ok(manifest && typeof manifest === 'object' && !Array.isArray(manifest));
    assert.equal(manifest.schemaVersion, 1);
    assert.deepEqual(manifest.source, { repository: REPOSITORY, commit: expectedCommit });
    assert.equal(git('rev-parse', '--verify', `${expectedCommit}^{commit}`).toString().trim(), expectedCommit);
    assert.ok(Array.isArray(manifest.entrypoints));
    assert.deepEqual(sortedUnique(manifest.entrypoints), ENTRYPOINTS);
    assert.equal(manifest.entrypoints.length, ENTRYPOINTS.length, 'no duplicate entrypoint');
    modules = rowsByPath(manifest.modules, 'modules');
    supporting = rowsByPath(manifest.supportingFiles, 'supportingFiles');
    for (const entrypoint of ENTRYPOINTS) assert.ok(modules.has(entrypoint), `entrypoint is shipped: ${entrypoint}`);
    for (const name of supporting.keys()) assert.equal(modules.has(name), false, `supporting file is not a code module: ${name}`);
  });

  await t.test('each module hash and import edge derives independently from immutable Git bytes', () => {
    assert.ok(modules instanceof Map, 'schema validation must succeed');
    for (const [name, row] of modules) {
      assert.match(name, /\.m?js$/, `JavaScript module: ${name}`);
      const bytes = sourceBytes(name);
      blobs.set(name, bytes);
      assert.equal(bytes.length, row.bytes, `${name}: exact pinned byte length`);
      assert.equal(digest(bytes), row.sha256, `${name}: exact pinned SHA-256`);
      // V8 parses imports and re-exports, including side-effect imports.
      // No module is linked or evaluated during independent graph discovery.
      const parsed = new vm.SourceTextModule(bytes.toString('utf8'), { identifier: name });
      const imports = sortedUnique(parsed.dependencySpecifiers.map((specifier) => {
        assert.match(specifier, /^\.{1,2}\//, `${name}: core imports must be relative local modules`);
        assert.doesNotMatch(specifier, /[\\%?#\s]/, `${name}: canonical local import`);
        const resolved = portablePath(path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier)));
        assert.ok(modules.has(resolved), `${name}: missing dependency ${resolved}`);
        return resolved;
      }));
      assert.deepEqual(row.imports, imports, `${name}: exact independently parsed dependency edges`);
    }
    const reached = new Set();
    const visit = (name) => {
      if (reached.has(name)) return;
      reached.add(name);
      for (const dependency of modules.get(name).imports) visit(dependency);
    };
    for (const entrypoint of ENTRYPOINTS) visit(entrypoint);
    assert.deepEqual([...modules.keys()], [...reached].sort(), 'core contains the exact reachable closure, without optional-only modules');
  });

  await t.test('root license and imported vendor license/provenance files match the same pin', () => {
    assert.ok(supporting instanceof Map, 'schema validation must succeed');
    for (const required of SUPPORTING) assert.ok(supporting.has(required), `required supporting file: ${required}`);
    for (const [name, row] of supporting) {
      const bytes = sourceBytes(name);
      blobs.set(name, bytes);
      assert.equal(bytes.length, row.bytes, `${name}: exact pinned byte length`);
      assert.equal(digest(bytes), row.sha256, `${name}: exact pinned SHA-256`);
    }
  });

  await t.test('optional runtimes remain a separate descriptive inventory', () => {
    assert.ok(Array.isArray(manifest.optionalRuntime), 'optionalRuntime is an array separate from modules');
    const ids = new Set();
    for (const runtime of manifest.optionalRuntime) {
      assert.ok(runtime && typeof runtime === 'object' && !Array.isArray(runtime));
      assert.equal(typeof runtime.id, 'string');
      assert.notEqual(runtime.id.trim(), '');
      assert.equal(ids.has(runtime.id), false, `unique optional runtime: ${runtime.id}`);
      ids.add(runtime.id);
      assert.ok(Array.isArray(runtime.localEntrypoints));
      for (const name of runtime.localEntrypoints) sourceBytes(portablePath(name));
      assert.ok(Object.hasOwn(runtime, 'requirements'), `${runtime.id}: requirements field`);
      assert.ok(Object.hasOwn(runtime, 'externalAssets'), `${runtime.id}: external assets field`);
    }
    // Optional adapters can share a static core helper. Exact graph reachability,
    // rather than optional prose or directory names, decides core membership.
  });

  await t.test('only extracted pinned files satisfy imports, byte commands and governed refusal', async () => {
    assert.ok(modules instanceof Map && supporting instanceof Map, 'schema validation must succeed');
    assert.equal(blobs.size, modules.size + supporting.size, 'all immutable bytes were checked before extraction');
    const extracted = await mkdtemp(path.join(tmpdir(), 'naklios-b13-pinned-'));
    try {
      for (const [name, bytes] of blobs) {
        const destination = path.join(extracted, name);
        await mkdir(path.dirname(destination), { recursive: true });
        await writeFile(destination, bytes);
      }
      const manifestPath = path.join(extracted, '.portability-manifest.json');
      await writeFile(manifestPath, JSON.stringify(manifest));
      const smoke = fileURLToPath(new URL('./unix-portability-node-smoke.mjs', import.meta.url));
      const child = spawnSync(process.execPath, [smoke, extracted, manifestPath], {
        cwd: extracted, encoding: 'utf8', timeout: 60000, maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      });
      assert.equal(child.error, undefined, `Node smoke launch: ${child.error?.message || ''}`);
      assert.equal(child.signal, null, `Node smoke signal: ${child.signal}`);
      assert.equal(child.status, 0, `Node smoke failed:\n${child.stdout}\n${child.stderr}`);
      assert.equal(child.stderr, '', 'isolated child has no runtime diagnostics');
      const report = JSON.parse(child.stdout);
      assert.equal(report.ok, true);
      assert.equal(report.sourceCommit, expectedCommit);
      assert.deepEqual(report.imported, [...modules.keys()], 'child imported every promised module');
      assert.deepEqual(report.checks, [
        'browser-globals-absent', 'imports', 'language', 'binary-streams',
        'gzip-interoperability', 'tar-bytes', 'yaml-json-vendor', 'grant-refusal',
        'staging', 'real-git', 'optional-runtime-refusal', 'browser-globals-still-absent',
      ], 'child completed every promised observation');
      t.diagnostic(JSON.stringify(report));
    } finally { await rm(extracted, { recursive: true, force: true }); }
  });
});
