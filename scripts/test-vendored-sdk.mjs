// test-vendored-sdk.mjs — self-contained guard for the SDK-vendoring mechanism.
//
// The per-app freshness is enforced by each app's own vendor-sdk.yml (--check).
// This test guards the pieces that live in THIS repo: the canonical SDK's
// invariants and the splicer's adopt/check round-trip. No sibling repos needed.

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SDK = new URL('../sdk/naklios.js', import.meta.url);
const SPLICER = new URL('./vendor-naklios-sdk.mjs', import.meta.url).pathname;
const canonical = readFileSync(SDK, 'utf8');

// 1. Canonical carries a machine-readable vendor version.
assert.match(canonical, /@naklios-sdk-version\s+\d+/, 'canonical SDK must stamp @naklios-sdk-version');

// 2. Canonical must NOT contain literal begin/end markers — an inlined copy would
//    otherwise carry a spurious marker and confuse the splice on the next run.
assert.doesNotMatch(canonical, /\/\*\s*naklios-sdk:begin\b[^*]*\*\//,
  'canonical must not contain a literal naklios-sdk:begin marker (describe it in prose)');
assert.doesNotMatch(canonical, /\/\*\s*naklios-sdk:end\s*\*\//,
  'canonical must not contain a literal naklios-sdk:end marker (describe it in prose)');

// Build a synthetic vendoring app: the SDK inlined (</script> neutralised, as a real
// app would) inside a shared <script> with app code on both sides, and NO markers.
const inlined = canonical.replace(/<\/script/gi, '<\\/script');
const appHtml =
  '<!doctype html><body><script>\n' +
  '/* app head */ var before = 1;\n' +
  inlined + '\n' +
  '/* app tail */ var after = 2;\n' +
  '</script></body>\n';

const dir = mkdtempSync(join(tmpdir(), 'vsdk-'));
const file = join(dir, 'index.html');
writeFileSync(file, appHtml);

const run = (args) => {
  try { return { code: 0, out: execFileSync('node', [SPLICER, '--file', file, '--canonical', SDK.pathname, ...args], { encoding: 'utf8' }) }; }
  catch (e) { return { code: e.status ?? 1, out: (e.stdout || '') + (e.stderr || '') }; }
};

// 3. Adopt wraps the SDK in markers and splices; app code on both sides survives.
assert.equal(run(['--adopt']).code, 0, 'adopt should succeed on a fused, marker-less app');
let after = readFileSync(file, 'utf8');
assert.match(after, /\/\*\s*naklios-sdk:begin\b/, 'adopt inserts a begin marker');
assert.match(after, /\/\*\s*naklios-sdk:end\s*\*\//, 'adopt inserts an end marker');
assert.ok(after.includes('var before = 1;'), 'app code before the SDK must survive adopt');
assert.ok(after.includes('var after = 2;'), 'app code after the SDK must survive adopt');
assert.equal((after.match(/<\/script>/g) || []).length, 1, 'exactly one real </script> — the SDK\'s own are escaped');

// 4. --check is idempotent right after a splice.
assert.equal(run(['--check']).code, 0, 'check should pass immediately after adopt/splice');

// 5. A hand-edit inside the managed region is caught as drift.
after = readFileSync(file, 'utf8');
const begin = after.indexOf('*/', after.indexOf('naklios-sdk:begin')) + 2;
writeFileSync(file, after.slice(0, begin) + '\n/* tampered */' + after.slice(begin));
assert.equal(run(['--check']).code, 1, 'check must flag a hand-edit inside the managed region');

console.log('SDK vendoring: canonical invariants + splicer adopt/check round-trip: PASS');

// The host's declared SDK splice retains upstream app bytes and provenance.
const {prepareManagedSdk,sha256}=await import('./mirror-lib.mjs');
const raw=Buffer.from('before();/* naklios-sdk:begin ver=1 sha256=old */old();/* naklios-sdk:end */after();');
const managed=prepareManagedSdk(raw,'inline',Buffer.from(canonical));
assert.equal(managed.originalSourceSha256,sha256(raw));
assert.equal(managed.sdkSha256,sha256(Buffer.from(canonical)));
assert.ok(managed.bytes.toString().startsWith('before();'));
assert.ok(managed.bytes.toString().endsWith('after();'));
assert.ok(prepareManagedSdk(managed.bytes,'inline',Buffer.from(canonical)).bytes.equals(managed.bytes));
assert.ok(prepareManagedSdk(raw,'file',Buffer.from(canonical)).bytes.equals(Buffer.from(canonical)));
assert.throws(()=>prepareManagedSdk(Buffer.from('no markers'),'inline',Buffer.from(canonical)),/marker/);
assert.throws(()=>prepareManagedSdk(Buffer.concat([raw,raw]),'inline',Buffer.from(canonical)),/marker/);
