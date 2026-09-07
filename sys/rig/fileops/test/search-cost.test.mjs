// search-cost — the measurement patch's own gate.
//
//   node sys/rig/fileops/test/search-cost.test.mjs
//
// Two things must hold, and the second matters more than the first:
//   1. the counters count what they claim (files opened, bytes decoded, calls);
//   2. instrumenting grep changes NO result — same matches, same truncation,
//      same order, with a meter attached and with none.
// Plus the §1 claim this whole measurement exists to test: a query that matches
// nothing reads the whole workspace, while a query over the cap stops early.

import { createFileops, MemoryBackend } from '../index.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; }
  catch (e) { failures.push({ name, message: e.message }); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg || 'assertion failed'); }
function eq(a, b, msg) {
  if (a !== b) throw new Error(`${msg || 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
}

async function seed(fs, n, line) {
  for (let i = 0; i < n; i++) {
    await fs.write(`src/f${i}.txt`, `alpha\n${line}\ngamma\n`, { createParents: true });
  }
}

await test('counts files opened and bytes decoded', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await seed(fs, 5, 'beta');
  const r = await fs.grep('beta');
  assert(r.ok, 'grep ok');
  eq(r.matches.length, 5, 'matches');
  const s = fs.searchStats();
  eq(s.totals.calls, 1, 'one call');
  eq(s.totals.filesRead, 5, 'read every file');
  eq(s.totals.filesWalked, 5, 'walked every file');
  eq(s.totals.bytesRead, 5 * 'alpha\nbeta\ngamma\n'.length, 'bytes decoded');
  eq(s.recent[0].via, 'fs.grep', 'via');
});

await test('a no-match query reads the whole workspace (the expensive class)', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await seed(fs, 8, 'beta');
  await fs.grep('nothing-matches-this');
  const s = fs.searchStats();
  eq(s.totals.filesRead, 8, 'read all 8 despite zero matches');
  eq(s.totals.empty, 1, 'counted as an empty-result search');
  eq(s.emptyShare, 1, 'empty share');
});

await test('a query over the cap stops early and reads fewer files', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await seed(fs, 20, 'beta');
  const r = await fs.grep('beta', { maxResults: 3 });
  assert(r.truncated, 'truncated');
  const s = fs.searchStats();
  assert(s.totals.filesRead < 20, `capped search read ${s.totals.filesRead}, expected < 20`);
  eq(s.totals.truncated, 1, 'counted as truncated');
});

await test('the meter changes no result', async () => {
  const mk = async (opts) => {
    const fs = createFileops({ backend: new MemoryBackend(), ...opts });
    await seed(fs, 6, 'beta');
    await fs.write('src/other.txt', 'beta once\n', { createParents: true });
    return fs;
  };
  const plain = await mk({});
  let seen = 0;
  const metered = await mk({ onSearch: () => { seen++; } });
  const a = await plain.grep('beta');
  const b = await metered.grep('beta');
  eq(JSON.stringify(a), JSON.stringify(b), 'identical result with and without a sink');
  eq(seen, 1, 'sink called once');
});

await test('a throwing sink never breaks a search', async () => {
  const fs = createFileops({
    backend: new MemoryBackend(),
    onSearch: () => { throw new Error('meter exploded'); },
  });
  await seed(fs, 3, 'beta');
  const r = await fs.grep('beta');
  assert(r.ok, 'search still ok');
  eq(r.matches.length, 3, 'matches intact');
});

await test('reset clears counters', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await seed(fs, 2, 'beta');
  await fs.grep('beta');
  fs.searchStats({ reset: true });
  const s = fs.searchStats();
  eq(s.totals.calls, 0, 'calls cleared');
  eq(s.recent.length, 0, 'log cleared');
});

await test('the recent log is capped', async () => {
  const fs = createFileops({ backend: new MemoryBackend() });
  await seed(fs, 1, 'beta');
  for (let i = 0; i < 205; i++) await fs.grep('beta');
  const s = fs.searchStats();
  eq(s.totals.calls, 205, 'every call counted in totals');
  eq(s.recent.length, 200, 'log capped at 200');
});

console.log(`search-cost: ${passed} passed, ${failures.length} failed`);
for (const f of failures) console.log(`  FAIL ${f.name}: ${f.message}`);
if (failures.length) process.exit(1);
