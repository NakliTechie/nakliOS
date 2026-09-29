import assert from 'node:assert/strict';

// Runtime downloads have one pinned destination. Reject malformed reports and
// ambiguous path spellings instead of trusting a hostname substring match.
export function assertHarnessNetwork(externalRequests) {
  assert.ok(Array.isArray(externalRequests), 'external requests must be an array');
  assert.ok(externalRequests.length <= 200, 'external request capture must remain bounded');
  const prefix = 'https://cdn.jsdelivr.net/pyodide/v0.26.4/full/';
  for (const request of externalRequests) {
    assert.equal(typeof request, 'string', 'external requests must be URL strings');
    assert.ok(request.startsWith(prefix) && !/[\\%\s]/.test(request), 'only canonical pinned CDN URLs are allowed');
    const url = new URL(request);
    assert.ok(url.href.startsWith(prefix) && !url.username && !url.password,
      'external requests must remain inside the pinned Pyodide directory');
  }
}

// The runner supplies independently fixed counts; page-provided totals cannot
// turn missing, duplicated or misdirected browser checks into a passing gate.
export function assertHarnessResult(report, { harness, expectedByMode, isolated }) {
  const modes = Object.keys(expectedByMode).sort();
  assert.ok(modes.length > 0 && modes.every(mode => ['worker', 'main'].includes(mode)));
  assert.ok(Object.values(expectedByMode).every(count => Number.isSafeInteger(count) && count > 0));
  const expected = Object.values(expectedByMode).reduce((sum, count) => sum + count, 0);
  assert.ok(report && typeof report === 'object' && !Array.isArray(report));
  assert.equal(report.done, true, 'harness must finish');
  assert.equal(report.ok, true, 'harness must report success');
  assert.equal(report.harness, harness, 'expected harness identity');
  assert.equal(report.crossOriginIsolated, isolated, 'expected browser isolation');
  assert.ok(Array.isArray(report.selectedModes));
  assert.deepEqual([...report.selectedModes].sort(), modes, 'expected runtime modes');
  for (const field of ['expectedTotal', 'total', 'passed']) assert.equal(report[field], expected, field);
  assert.equal(report.failed, 0, 'no failed assertions');
  assert.ok(Array.isArray(report.results));
  assert.equal(report.results.length, expected, 'every assertion must have a result');
  const names = new Set(), actual = Object.fromEntries(modes.map(mode => [mode, 0]));
  for (const row of report.results) {
    assert.ok(row && typeof row === 'object');
    assert.equal(row.ok, true, 'every assertion must pass');
    assert.ok(typeof row.name === 'string' && row.name.trim(), 'every assertion must be named');
    const prefix = /^(worker|main):/.exec(row.name)?.[1];
    if (prefix && row.mode !== undefined) assert.equal(row.mode, prefix, 'runtime attribution must agree');
    const mode = row.mode ?? prefix;
    assert.ok(Object.hasOwn(actual, mode), 'every assertion must identify an expected runtime');
    const key = `${mode}:${row.name}`;
    assert.ok(!names.has(key), 'assertion identities must be unique');
    names.add(key); actual[mode]++;
  }
  assert.deepEqual(actual, Object.fromEntries(modes.map(mode => [mode, expectedByMode[mode]])), 'exact assertions per runtime');
}
