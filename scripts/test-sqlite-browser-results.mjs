// Independently frozen B10 browser-result contract tests.
// Counts come from this caller-owned fixture, never from a reported count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHarnessResult } from './sqlite-browser-results.mjs';

const expected = () => ({ harness: 'independent-sqlite-harness', expectedByMode: { worker: 2, main: 1 }, isolated: true });
const valid = () => ({
  done: true, ok: true, harness: 'independent-sqlite-harness',
  selectedModes: ['worker', 'main'], expectedTotal: 3, total: 3, passed: 3, failed: 0,
  crossOriginIsolated: true,
  results: [
    { mode: 'worker', name: 'first worker assertion', ok: true },
    { mode: 'worker', name: 'second worker assertion', ok: true },
    { mode: 'main', name: 'main assertion', ok: true },
  ],
});

function rejected(name, change) {
  test(`browser-result rejects ${name}`, () => {
    const report = valid(), options = expected();
    const changed = change(report, options);
    assert.throws(() => assertHarnessResult(changed === undefined ? report : changed, options));
  });
}

test('browser-result accepts a complete positive report with caller-owned mode counts', () => {
  const report = valid(), options = expected();
  const beforeReport = structuredClone(report), beforeOptions = structuredClone(options);
  assert.doesNotThrow(() => assertHarnessResult(report, options));
  assert.deepEqual(report, beforeReport, 'validation does not rewrite browser evidence');
  assert.deepEqual(options, beforeOptions, 'validation does not rewrite caller expectations');
});

test('browser-result accepts modes inferred from worker and main name prefixes', () => {
  const report = valid();
  report.results = report.results.map(({ mode, name, ok }) => ({ name: `${mode}: ${name}`, ok }));
  assert.doesNotThrow(() => assertHarnessResult(report, expected()));
});

test('browser-result accepts consistent explicit and prefix mode attribution', () => {
  const report = valid();
  report.results = report.results.map((row) => ({ ...row, name: `${row.mode}: ${row.name}` }));
  assert.doesNotThrow(() => assertHarnessResult(report, expected()));
});

test('browser-result accepts a different row order and selected-mode order', () => {
  const report = valid(); report.results.reverse(); report.selectedModes.reverse();
  assert.doesNotThrow(() => assertHarnessResult(report, expected()));
});

test('browser-result permits the same assertion name once in each different mode', () => {
  const report = valid(); report.results[0].name = 'shared assertion'; report.results[2].name = 'shared assertion';
  assert.doesNotThrow(() => assertHarnessResult(report, expected()));
});

for (const [mode, isolated] of [['worker', true], ['main', true], ['main', false]]) {
  test(`browser-result accepts an explicitly expected ${mode}-only report with isolation=${isolated}`, () => {
    const report = valid(), options = expected();
    options.expectedByMode = { [mode]: 1 }; options.isolated = isolated;
    report.selectedModes = [mode]; report.expectedTotal = report.total = report.passed = 1;
    report.crossOriginIsolated = isolated; report.results = [{ mode, name: 'one asserted case', ok: true }];
    assert.doesNotThrow(() => assertHarnessResult(report, options));
  });
}

for (const bad of [null, false, true, '', 'PASS 3/3', 0, 3, [], {}]) {
  rejected(`malformed report ${JSON.stringify(bad)}`, () => bad);
}
test('browser-result rejects an absent report', () => {
  assert.throws(() => assertHarnessResult(undefined, expected()));
});

for (const key of ['done', 'ok']) {
  for (const bad of [false, null, 0, 1, 'true']) rejected(`${key}=${JSON.stringify(bad)}`, (report) => { report[key] = bad; });
  rejected(`missing ${key}`, (report) => { delete report[key]; });
}

rejected('PASS 0/0 despite positive caller counts', (report) => {
  report.expectedTotal = report.total = report.passed = report.failed = 0; report.results = [];
});
rejected('self-consistent smaller totals that omit a caller-required mode', (report) => {
  report.selectedModes = ['worker']; report.expectedTotal = report.total = report.passed = 2;
  report.results = report.results.slice(0, 2);
});
rejected('self-consistent larger totals that exceed caller counts', (report) => {
  report.expectedTotal = report.total = report.passed = 4;
  report.results.push({ mode: 'main', name: 'unrequested extra assertion', ok: true });
});

for (const key of ['expectedTotal', 'total', 'passed']) {
  for (const bad of [0, -1, 1, 2, 4, 3.5, '3', null, true, NaN, Infinity]) {
    rejected(`${key}=${String(bad)} (${typeof bad})`, (report) => { report[key] = bad; });
  }
  rejected(`missing ${key}`, (report) => { delete report[key]; });
}
for (const bad of [1, -1, 0.5, '0', null, false, NaN, Infinity]) {
  rejected(`failed=${String(bad)} (${typeof bad})`, (report) => { report.failed = bad; });
}
rejected('missing failed count', (report) => { delete report.failed; });

for (const bad of [null, {}, 'PASS', 3]) rejected(`malformed results ${JSON.stringify(bad)}`, (report) => { report.results = bad; });
rejected('missing results', (report) => { delete report.results; });
rejected('missing rows while claiming complete counts', (report) => { report.results.pop(); });
rejected('extra rows while claiming expected counts', (report) => {
  report.results.push({ mode: 'main', name: 'surplus', ok: true });
});
rejected('a sparse results array', (report) => { delete report.results[1]; });
for (const bad of [null, false, 'PASS', [], 1]) rejected(`malformed row ${JSON.stringify(bad)}`, (report) => { report.results[1] = bad; });
for (const bad of [false, undefined, null, 0, 1, 'true']) {
  rejected(`failed or nonboolean row ok=${String(bad)} with forged failed=0`, (report) => { report.results[1].ok = bad; });
}
for (const bad of ['', '   ', '\n\t', undefined, null, 1, true]) {
  rejected(`missing or empty assertion name ${JSON.stringify(bad)}`, (report) => { report.results[1].name = bad; });
}

rejected('duplicate assertion names in the same mode', (report) => { report.results[1].name = report.results[0].name; });
rejected('duplicate prefix-attributed rows', (report) => {
  report.results[0] = { name: 'worker: duplicated assertion', ok: true };
  report.results[1] = { name: 'worker: duplicated assertion', ok: true };
});
rejected('wrong per-mode counts despite correct aggregate counts', (report) => { report.results[1].mode = 'main'; });
rejected('unattributed rows', (report) => { delete report.results[1].mode; });
rejected('unrecognized explicit row mode', (report) => { report.results[1].mode = 'other'; });
rejected('unrecognized prefixed row mode', (report) => { report.results[1] = { name: 'other: assertion', ok: true }; });
rejected('a numeric row mode', (report) => { report.results[1].mode = 1; });
rejected('conflicting explicit and prefix mode attribution', (report) => { report.results[1].name = 'main: contradictory worker row'; });
rejected('a mode name inherited from Object.prototype', (report) => { report.results[1].mode = 'constructor'; });

for (const bad of [null, undefined, {}, 'worker,main', [], ['worker'], ['main'], ['worker', 'worker'], ['worker', 'main', 'worker'], ['worker', 'main', 'other']]) {
  rejected(`malformed or mismatched selectedModes ${JSON.stringify(bad)}`, (report) => { report.selectedModes = bad; });
}
for (const bad of ['', undefined, null, 1, 'other-harness']) rejected(`wrong harness ${JSON.stringify(bad)}`, (report) => { report.harness = bad; });
for (const bad of [false, undefined, null, 0, 1, 'true']) {
  rejected(`wrong or nonboolean isolation ${JSON.stringify(bad)}`, (report) => { report.crossOriginIsolated = bad; });
}
rejected('isolated report when caller requires non-isolated evidence', (_, options) => { options.isolated = false; });

for (const bad of [null, undefined, [], {}, { worker: 0 }, { worker: -1 }, { worker: 1.5 }, { worker: '2', main: 1 },
  { worker: NaN }, { worker: Infinity }, { worker: Number.MAX_SAFE_INTEGER + 1 }, { other: 3 }]) {
  rejected(`invalid caller expectedByMode ${JSON.stringify(bad)}`, (_, options) => { options.expectedByMode = bad; });
}
rejected('zero caller count even with forged zero report', (report, options) => {
  options.expectedByMode = { worker: 0 }; report.selectedModes = ['worker'];
  report.expectedTotal = report.total = report.passed = 0; report.results = [];
});
rejected('zero count for one selected mode despite positive aggregate', (report, options) => {
  options.expectedByMode = { worker: 3, main: 0 };
  report.results = report.results.map((row) => ({ ...row, mode: 'worker' }));
});
rejected('caller count sum beyond safe integer range', (_, options) => {
  options.expectedByMode = { worker: Number.MAX_SAFE_INTEGER, main: 1 };
});
