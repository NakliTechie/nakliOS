// Anvil startup must not wait forever on a remembered folder (2026-11-22: Chrome left queryPermission unanswered on a
// remembered workspace folder and Anvil showed "still starting" for good on naklios.dev). The helper resolves
// 'timeout' after its limit, and every query on a REMEMBERED handle goes through it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../apps/anvil/index.html', import.meta.url), 'utf8');

function extractHelper() {
  const start = html.indexOf('function queryPermissionWithin(');
  assert.ok(start > 0, 'queryPermissionWithin is defined in apps/anvil/index.html');
  const end = html.indexOf('\n  }\n', start);
  const body = html.slice(start, end + 4);
  assert.ok(body.length > 100, 'the helper body was found');
  return new Function('PERMISSION_QUERY_MS', `${body}; return queryPermissionWithin;`)(1500);
}

test('the helper answers "timeout" when Chrome never answers, and passes a real answer through', async () => {
  const within = extractHelper();
  const never = { queryPermission: () => new Promise(() => {}) };
  const t0 = Date.now();
  assert.equal(await within(never, 50), 'timeout');
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(await within({ queryPermission: async () => 'granted' }, 50), 'granted');
  assert.equal(await within({ queryPermission: async () => 'prompt' }, 50), 'prompt');
});

test('the limit is short enough to keep startup inside the boot net', () => {
  const m = /const PERMISSION_QUERY_MS=(\d+);/.exec(html);
  assert.ok(m, 'PERMISSION_QUERY_MS is declared');
  assert.ok(Number(m[1]) <= 3000, `limit ${m[1]} ms`);
});

test('the boot checks on the remembered workspace and home use the helper, never a bare query', () => {
  const boot = html.slice(html.indexOf("const saved = await idbGet(DIR_KEY);"), html.indexOf('updateHomeChip();\n  // Startup backfill'));
  assert.ok(boot.length > 100, 'the boot block was found');
  assert.match(boot, /queryPermissionWithin\(saved\)/);
  assert.match(boot, /queryPermissionWithin\(h\)/);
  assert.doesNotMatch(boot, /\.queryPermission\(\{mode/);
  const connect = html.slice(html.indexOf('async function connectHome(h){'), html.indexOf('function updateHomeChip(){'));
  assert.ok(connect.length > 50, 'connectHome was found');
  assert.match(connect, /queryPermissionWithin\(h\)/);
});
