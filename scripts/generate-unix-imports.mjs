#!/usr/bin/env node
// Inventory immutable Git bytes without linking or evaluating application code.
// node --experimental-vm-modules scripts/generate-unix-imports.mjs <full-commit> [output]
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const [commit, output = 'docs/kothri-unix-imports.json', ...extra] = process.argv.slice(2);
assert.ok(!extra.length && /^[0-9a-f]{40}$/.test(commit || ''), 'supply a full immutable lowercase Git commit');
assert.equal(typeof vm.SourceTextModule, 'function', 'use --experimental-vm-modules');
const git = (...args) => execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
assert.equal(git('rev-parse', '--verify', `${commit}^{commit}`).toString().trim(), commit);
const entrypoints = [
  'sys/rig/agent/index.mjs', 'sys/rig/cli/shell.mjs', 'sys/rig/fileops/index.mjs',
  'sys/rig/git/git-core.mjs', 'sys/rig/registry/index.mjs',
];
const supportingPaths = [
  'LICENSE', 'vendor/isomorphic-git/1.40.0/LICENSE.md', 'vendor/isomorphic-git/1.40.0/README.md',
  'vendor/js-yaml/LICENSE', 'vendor/js-yaml/PROVENANCE.json',
];
const optionalRuntime = [
  {
    id: 'kiln-python-sqlite',
    localEntrypoints: ['sys/kiln/index.mjs', 'sys/kiln/worker-runtime.mjs', 'sys/kiln/worker.mjs', 'sys/kiln/main-thread-runtime.mjs'],
    requirements: [
      'Copy the separate static closure of the selected adapter from this same commit; core modules alone do not supply Kiln.',
      'Inject kiln into createShell. Authorize runtime downloads in the embedding application; createKiln requires consent().',
      'Worker mode requires module Workers and cross-origin isolation with SharedArrayBuffer for synchronous interruption.',
      'The main-thread adapter needs application-controlled invocation consent and cannot interrupt synchronous general Python.',
      'SQLite uses a private interpreter, separate from general Python; retain SQL work/output limits and bounded initialization.',
      'Retain the generated Rig bridge, grant enforcement and staging for workspace Python access.',
      'Apply an embedding CSP; JavaScript network stubs do not block dynamic import().',
    ],
    externalAssets: [{
      baseURL: 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/',
      version: '0.26.4', approximateBytes: 13 * 1024 * 1024,
      workerEntrySHA256: '7f24c6655a79eacf0061d3d4e6a60dc0b1938812d15c52d7ff8b37d9e0689e51',
      integrity: 'Worker pins pyodide.mjs; main-thread loader imports the fixed version. Other runtime assets rely on CDN version and pyodide-lock.json package digests.',
    }],
  },
  {
    id: 'javascript-gate', localEntrypoints: ['sys/kiln/js-runner.mjs'],
    requirements: [
      'The helper is already in the core closure; execution remains optional.',
      'Inject js.makeModuleURL(source) and js.spawn(entryURL), plus URL cleanup when supplied by the host.',
      'Use a disposable Worker with termination and message/error callbacks. Retain its grant-scoped read callback and deadline.',
      'This is a workspace ES-module evaluator with limited assert/test shims, not the Node runtime or npm.',
      'Embedding CSP remains necessary for dynamic-import egress containment.',
    ], externalAssets: [],
  },
  {
    id: 'persistent-browser-storage',
    localEntrypoints: ['sys/rig/fileops/opfs.mjs', 'sys/rig/fileops/fsa-backend.mjs'],
    requirements: [
      'Copy the chosen backend static closure from this pin and inject it into createFileops.',
      'OPFS requires a secure browser origin with navigator.storage.getDirectory().',
      'Folder storage requires an owner-selected FileSystemDirectoryHandle and maintained browser permissions.',
      'Neither backend is necessary for the browser-free MemoryBackend portability check.',
    ], externalAssets: [],
  },
];
function source(name) {
  assert.match(name, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/);
  assert.ok(name.split('/').every(part => part !== '.' && part !== '..'));
  return git('show', `${commit}:${name}`);
}
function row(name, bytes) {
  return { path: name, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
}
const modules = new Map();
function visit(name) {
  if (modules.has(name)) return;
  const bytes = source(name);
  const parsed = new vm.SourceTextModule(bytes.toString('utf8'), { identifier: name });
  const imports = [...new Set(parsed.dependencySpecifiers.map(specifier => {
    assert.match(specifier, /^\.{1,2}\//, `${name}: nonlocal static import`);
    assert.doesNotMatch(specifier, /[\\%?#\s]/, `${name}: noncanonical import`);
    return path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
  }))].sort();
  modules.set(name, { ...row(name, bytes), imports });
  imports.forEach(visit);
}
entrypoints.forEach(visit);
for (const runtime of optionalRuntime) runtime.localEntrypoints.forEach(source);
const manifest = {
  schemaVersion: 1, source: { repository: 'https://github.com/NakliTechie/nakliOS', commit },
  entrypoints,
  modules: [...modules.keys()].sort().map(name => modules.get(name)),
  supportingFiles: supportingPaths.sort().map(name => row(name, source(name))),
  optionalRuntime,
};
writeFileSync(output, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${output}: ${manifest.modules.length} core modules, ${manifest.supportingFiles.length} supporting files, source ${commit}`);
