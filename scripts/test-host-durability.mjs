// DUR (2026-09-24): the host half of the durability contract, run from the real index.html text.
//   1. Ops on one app path apply in arrival order (fsHostSerial) — an autosave's urgent write can be
//      issued while an older write is still running, and the older one must never land last.
//   2. The host's close guard prompts only while an open window reports unsaved state.
//   3. The `naklios:fs:dirty` report is routed before the generic `naklios:fs:*` branch (which would
//      answer it as an unknown fs op) and sets the window's flag.
//   node scripts/test-host-durability.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const host = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// 1. fsHostSerial, extracted and run.
const serialSrc = host.match(/const fsHostPathQueues = new Map\(\);\nfunction fsHostSerial\(key, fn\)\{[\s\S]*?\n\}/);
assert.ok(serialSrc, 'fsHostSerial found in index.html');
assert.match(host, /function fsHostHandle\(msg, type, appId\)\{\n  return fsHostSerial\(appId \+ '\\0' \+ String\(msg\.path \|\| ''\), \(\) => fsHostHandleNow\(msg, type, appId\)\);/,
  'every app fs op goes through the per-path queue');
const { fsHostSerial, queues } = new Function(`${serialSrc[0]}; return { fsHostSerial, queues: fsHostPathQueues };`)();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
{
  const landed = [];
  // the older write is slow, the newer fast — without the queue the older lands last
  const older = fsHostSerial('app\0ws.json', async () => { await sleep(30); landed.push('older'); });
  const newer = fsHostSerial('app\0ws.json', async () => { await sleep(1); landed.push('newer'); });
  const other = fsHostSerial('app\0other.json', async () => { landed.push('other'); });
  await Promise.all([older, newer, other]);
  assert.deepEqual(landed, ['other', 'older', 'newer'], 'same path in arrival order; another path is not held behind it');
  await sleep(0);
  assert.equal(queues.size, 0, 'drained queues are removed');
}
{
  const landed = [];
  const failing = fsHostSerial('k', async () => { throw new Error('boom'); });
  const next = fsHostSerial('k', async () => { landed.push('next'); return 7; });
  await assert.rejects(failing, /boom/, 'the failing op still rejects to its caller');
  assert.equal(await next, 7, 'a failure does not poison the ops after it');
}

// 2. The close guard, extracted and run against a fake openWindows.
const guardSrc = host.match(/window\.addEventListener\('beforeunload', e => \{\n  if \(!Object\.values\(openWindows\)\.some\(w => w && w\._appDirty\)\) return;\n  e\.preventDefault\(\);\n  e\.returnValue = '';\n\}\);/);
assert.ok(guardSrc, 'the host close guard found in index.html');
{
  let listener = null;
  const openWindows = Object.create(null);
  const window = { addEventListener: (t, fn) => { if (t === 'beforeunload') listener = fn; } };
  new Function('window', 'openWindows', guardSrc[0])(window, openWindows);
  const fire = () => { const ev = { prevented: false, preventDefault() { this.prevented = true; } }; listener(ev); return ev; };
  assert.equal(fire().prevented, false, 'no windows → no prompt');
  openWindows.a = { _appDirty: false }; openWindows.b = {};
  assert.equal(fire().prevented, false, 'clean windows → no prompt');
  openWindows.b._appDirty = true;
  const ev = fire();
  assert.equal(ev.prevented, true, 'one unsaved window → prompt');
  assert.equal(ev.returnValue, '', 'returnValue set for older browsers');
  delete openWindows.b;
  assert.equal(fire().prevented, false, 'closing the unsaved window disarms the guard');
}

// 3. The dirty report's routing.
const dirtyAt = host.indexOf("} else if (msg.type === 'naklios:fs:dirty'){");
const fsAt = host.indexOf("} else if (typeof msg.type === 'string' && msg.type.startsWith('naklios:fs:')){");
assert.ok(dirtyAt > 0 && fsAt > 0 && dirtyAt < fsAt, 'the dirty branch precedes the generic fs branch');
assert.match(host.slice(dirtyAt, dirtyAt + 400), /if \(win\) win\._appDirty = msg\.dirty === true;/, 'the report sets the window flag');

console.log('host-durability: ok');
