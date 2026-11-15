// test-pi-env-conformance.mjs — pi-durable's own ExecutionEnv conformance cases against NakliOS's env
// (scripts/pi/src/naklios-env.mjs over rig fileops and the rig shell).
//
// The cases come from pi-durable's testing entry (createEnvConformance). NakliOS's env answers watchers,
// temp files and line readers with `not_supported`, has no symbolic links, and runs the rig shell, so the
// cases that need those are listed in EXPECTED_GAPS by name and reported, not failed. Any other failure,
// or a listed gap that starts passing, fails the test so the list stays true. Needs `npm ci --prefix scripts/pi`.
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { createEnvConformance } from './pi/node_modules/@earendil-works/pi-durable/dist/testing/env-conformance.js';
import { createExpectAssertions } from './pi/node_modules/@earendil-works/pi-durable/dist/testing/assertions.js';
import { createNakliosEnv } from './pi/src/naklios-env.mjs';
import { createFileops, MemoryBackend } from '../sys/rig/fileops/index.mjs';
import { buildRigRegistry } from '../sys/rig/registry/index.mjs';
import { createGrant, createOpLog, createAgentFace } from '../sys/rig/agent/index.mjs';
import { createShell } from '../sys/rig/cli/shell.mjs';

// A Jest-shaped expect with the seven matchers the conformance assertions use.
function matchObject(actual, expected) {
  if (expected === null || typeof expected !== 'object') return isDeepStrictEqual(actual, expected);
  if (actual === null || typeof actual !== 'object') return false;
  return Object.keys(expected).every((k) => matchObject(actual[k], expected[k]));
}
function expect(actual) {
  const m = {
    toBe: (e) => assert.ok(Object.is(actual, e), `expected ${String(actual)} to be ${String(e)}`),
    toEqual: (e) => assert.deepStrictEqual(actual, e),
    toMatchObject: (e) => assert.ok(matchObject(actual, e), `expected ${JSON.stringify(actual)} to match ${JSON.stringify(e)}`),
    toBeTruthy: () => assert.ok(actual),
    toBeGreaterThan: (n) => assert.ok(actual > n, `expected ${actual} > ${n}`),
    toThrow: (e) => assert.throws(actual, e === undefined ? undefined : (err) => (typeof e === 'string' ? String(err?.message).includes(e) : true)),
  };
  m.rejects = { toThrow: async (e) => assert.rejects(actual, e === undefined ? undefined : (err) => (typeof e === 'string' ? String(err?.message).includes(e) : true)) };
  return m;
}

let n = 0;
async function withEnv(use) {
  const fs = createFileops({ backend: new MemoryBackend() });
  const registry = buildRigRegistry({ fs });
  const grant = createGrant({ prefixes: [''], scopes: ['fs:read', 'fs:write', 'fs:remove'] });
  const face = createAgentFace({ registry, grant, opLog: createOpLog({ fs: createFileops({ backend: new MemoryBackend() }) }), actor: 'agent' });
  const shell = createShell({ registry, face });
  const cwd = `/work${++n}`;
  await fs.mkdir(cwd.slice(1), { recursive: true });
  await use(createNakliosEnv({ fs, shell, cwd }));
}

const cases = createEnvConformance({ assertions: createExpectAssertions(expect), withEnv, symlinks: false });

// Cases NakliOS's env does not support by design; each name must fail, or this list is stale.
// Watching: rig storage reports no changes, so `watch` answers not_supported. Exec: the env runs the rig
// shell, not a POSIX `sh` (no positional parameters, loops, separate stderr, sleep or timeouts); Pi's
// instructions say so. Both are design gaps, recorded on 2026-11-15 with the pi-durable 1.5.2 upgrade.
const EXPECTED_GAPS = new Set([
  "watch reports a missing file's creation, changes, replacement and removal",
  'watch reports a missing target whose ancestors are created',
  'watch follows directories created together with their contents',
  'watch keeps watching a path whose parent is renamed and recreated',
  'watch skips excluded entries and reports a rename out of them',
  'watch keeps recursive coverage where a non-recursive target overlaps',
  'watch follows a directory replaced at the same path',
  'watch stops reporting once stopped',
  'argv exec passes arguments to the program without shell parsing',
  'exec reports the stream of every chunk in both forms',
  'argv exec honors cwd and exit codes',
  'argv exec reports missing programs and empty argv as spawn errors',
  'windowed exec keeps the exact tail and counts what it skips',
  'argv exec distinguishes timeout from abort',
]);

const passed = [], failed = [];
for (const c of cases) {
  try {
    await Promise.race([c.run(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), c.timeoutMs || 5000))]);
    passed.push(c.name);
  } catch (e) {
    failed.push({ name: c.name, error: String(e?.message || e).split('\n')[0].slice(0, 160) });
  }
}
console.log(`pi env conformance: ${passed.length} of ${cases.length} cases pass`);
for (const f of failed) console.log(`  ${EXPECTED_GAPS.has(f.name) ? 'gap ' : 'FAIL'}  ${f.name} — ${f.error}`);
const unexpected = failed.filter((f) => !EXPECTED_GAPS.has(f.name));
const staleGaps = [...EXPECTED_GAPS].filter((g) => passed.includes(g));
if (staleGaps.length) console.log('  stale gaps (now passing):', staleGaps.join(', '));
process.exit(unexpected.length || staleGaps.length ? 1 : 0);
