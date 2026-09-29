// Independent B10 browser network gate contract. No live network calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHarnessNetwork } from './sqlite-browser-results.mjs';

const base = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
const good = base + 'pyodide.asm.wasm';

test('browser-network accepts no external requests', () => {
  assert.doesNotThrow(() => assertHarnessNetwork([]));
});

for (const suffix of ['', 'pyodide.mjs', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip',
  'sqlite3-1.0.0-py3-none-any.whl', 'packages/ascii_asset-1.2.3.tar.gz', 'pyodide.mjs?cache=1',
  'nested/../pyodide.asm.wasm']) {
  test(`browser-network accepts the pinned normalized CDN subtree: ${suffix || '(root)'}`, () => {
    assert.doesNotThrow(() => assertHarnessNetwork([base + suffix]));
  });
}

test('browser-network accepts mixed pinned assets without changing captured evidence', () => {
  const requests = [base + 'pyodide.mjs', good, base + 'python_stdlib.zip', good];
  const before = [...requests];
  assert.doesNotThrow(() => assertHarnessNetwork(requests));
  assert.deepEqual(requests, before);
});

test('browser-network accepts exactly 200 permitted requests', () => {
  assert.doesNotThrow(() => assertHarnessNetwork(Array(200).fill(good)));
});

test('browser-network rejects 201 permitted requests', () => {
  assert.throws(() => assertHarnessNetwork(Array(201).fill(good)));
});

test('browser-network inspects the last permitted request', () => {
  const requests = Array(200).fill(good); requests[199] = 'https://unapproved.invalid/leak';
  assert.throws(() => assertHarnessNetwork(requests));
});

for (const [label, value] of [
  ['null', null], ['undefined', undefined], ['boolean', false], ['number', 1], ['string', good],
  ['object', {}], ['array-like object', { 0: good, length: 1 }], ['set', new Set([good])],
]) test(`browser-network rejects a non-array input: ${label}`, () => {
  assert.throws(() => assertHarnessNetwork(value));
});

for (const [label, value] of [
  ['null', null], ['undefined', undefined], ['boolean', true], ['number', 1], ['object', {}],
  ['array', [good]], ['boxed string', new String(good)], ['URL object', new URL(good)],
]) test(`browser-network rejects a non-string row: ${label}`, () => {
  assert.throws(() => assertHarnessNetwork([good, value, good]));
});

test('browser-network rejects a sparse request array', () => {
  const requests = [good, good]; delete requests[0];
  assert.throws(() => assertHarnessNetwork(requests));
});

const rejectedURLs = [
  ['', 'empty URL'],
  ['pyodide.asm.wasm', 'relative asset'],
  ['/pyodide/v0.26.4/full/pyodide.asm.wasm', 'origin-relative asset'],
  ['//cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm', 'protocol-relative URL'],
  [good.replace('https:', 'http:'), 'HTTP'],
  [good.replace('https:', 'ftp:'), 'FTP'],
  [good.replace('https:', 'wss:'), 'WebSocket'],
  ['data:text/plain,https://cdn.jsdelivr.net/pyodide/v0.26.4/full/', 'data URL'],
  ['blob:' + good, 'blob URL'],
  ['file:///pyodide/v0.26.4/full/pyodide.asm.wasm', 'file URL'],
  ['https://example.invalid/pyodide/v0.26.4/full/pyodide.asm.wasm', 'other host'],
  ['https://cdn.jsdelivr.net.example.invalid/pyodide/v0.26.4/full/pyodide.asm.wasm', 'host suffix deception'],
  ['https://cdn.jsdelivr.net./pyodide/v0.26.4/full/pyodide.asm.wasm', 'noncanonical trailing-dot host'],
  ['https://cdn.jsdelivr.net:444/pyodide/v0.26.4/full/pyodide.asm.wasm', 'different port'],
  ['https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.asm.wasm', 'newer version'],
  ['https://cdn.jsdelivr.net/pyodide/v0.26.3/full/pyodide.asm.wasm', 'older version'],
  ['https://cdn.jsdelivr.net/pyodide/dev/full/pyodide.asm.wasm', 'floating version'],
  ['https://cdn.jsdelivr.net/npm/pyodide@0.26.4/pyodide.asm.wasm', 'other CDN subtree'],
  ['https://cdn.jsdelivr.net/pyodide/v0.26.4/full', 'missing subtree slash'],
  ['https://cdn.jsdelivr.net/pyodide/v0.26.4/fullness/pyodide.asm.wasm', 'prefix-like sibling'],
  ['https://cdn.jsdelivr.net/pyodide/v0.26.4/full.evil/pyodide.asm.wasm', 'dotted sibling'],
  ['https://user@cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm', 'username'],
  ['https://user:password@cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm', 'username and password'],
  ['https://:password@cdn.jsdelivr.net/pyodide/v0.26.4/full/pyodide.asm.wasm', 'password'],
  ['https://cdn.jsdelivr.net@unapproved.invalid/pyodide/v0.26.4/full/pyodide.asm.wasm', 'trusted host in username'],
  [base + '../outside.js', 'parent traversal outside full'],
  [base + '../../v0.27.0/full/pyodide.asm.wasm', 'parent traversal into another version'],
  [base + 'nested/../../outside.js', 'nested traversal outside full'],
  [base + '%2e%2e/outside.js', 'encoded dot traversal'],
  [base + '%2E%2E/outside.js', 'uppercase encoded dot traversal'],
  [base + '.%2e/outside.js', 'mixed encoded dot traversal'],
  [base + '%2e./outside.js', 'reversed mixed encoded dot traversal'],
  [base + '%252e%252e/outside.js', 'double encoded dot traversal'],
  [base + '%2f..%2foutside.js', 'encoded separators'],
  [base + '%5c..%5coutside.js', 'encoded backslashes'],
  [base + '%70yodide.asm.wasm', 'unnecessary encoded ASCII asset'],
  [base + 'asset%20name.whl', 'encoded space'],
  [base + 'asset%00.whl', 'encoded NUL'],
  [base + 'asset%.whl', 'malformed percent encoding'],
  [base + 'asset%2.whl', 'incomplete percent encoding'],
  [base + '..\\outside.js', 'backslash traversal'],
  [base + 'nested\\asset.whl', 'backslash path separator'],
  [' ' + good, 'leading whitespace'],
  [good + ' ', 'trailing whitespace'],
  [base + 'asset name.whl', 'path whitespace'],
  [base + '\npyodide.asm.wasm', 'embedded newline'],
  [base + '\tpyodide.asm.wasm', 'embedded tab'],
  [base + '\rpyodide.asm.wasm', 'embedded carriage return'],
];
for (const [url, label] of rejectedURLs) test(`browser-network rejects ${label}`, () => {
  assert.throws(() => assertHarnessNetwork([url]));
});

test('browser-network rejects an invalid request between permitted requests', () => {
  assert.throws(() => assertHarnessNetwork([good, 'https://unapproved.invalid/leak', good]));
});
