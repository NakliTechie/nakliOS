// Gate checks and reference-solution steps shared by the battery modules.
//
// A gate is ({ file, files, seed, changed, answer, metrics, stop }) → { ok, why } (bed.mjs builds the
// argument). `all` composes checks; the first failing one wins. A `why` never names the expected
// answer: on a gated task the loop shows it to the model.
import vm from 'node:vm';
import { createJsRunner } from '../../sys/kiln/js-runner.mjs';
import { nodeJsHost } from './bed.mjs';

export const ok = () => ({ ok: true });
export const no = (why) => ({ ok: false, why });
export const all = (...checks) => async (c) => { for (const f of checks) { const r = await f(c); if (!r.ok) return r; } return ok(); };
export const norm = (p) => String(p).replace(/^\.?\//, '');
// An allowed entry ending in "/" admits every path under it (a build task may add its own tests).
export const onlyChanged = (allowed = []) => (c) => {
  const extra = c.changed.filter((p) => !allowed.some((a) => (a.endsWith('/') ? p.startsWith(a) : p === a)));
  return extra.length ? no(`files changed outside the ask: ${extra.join(', ')}`) : ok();
};
export const fileEq = (p, want, { trim = true } = {}) => (c) => {
  const t = c.file(p);
  if (t === null) return no(`${p} does not exist`);
  return (trim ? t.trim() === want.trim() : t === want) ? ok() : no(`${p} does not have the required content`);
};
export const absent = (p) => (c) => (c.file(p) === null ? ok() : no(`${p} still exists`));
export const answerHas = (re, what) => (c) => (re.test(c.answer) ? ok() : no(`the final answer does not state ${what}`));
export const stepsAtMost = (n) => (c) => (!c.metrics || c.metrics.steps <= n ? ok() : no(`${c.metrics.steps} steps, the bar is ${n}`));
export const noTools = (c) => (!c.metrics || c.metrics.toolCalls === 0 ? ok() : no(`${c.metrics.toolCalls} tool call(s) on an ask that said not to use tools`));
export const answerFile = (p, want, what = 'the right value') => (c) => {
  const t = c.file(p);
  if (t === null) return no(`${p} does not exist`);
  return norm(t.trim()) === String(want) ? ok() : no(`${p} does not hold ${what}`);
};
// A JSON file whose parsed value equals `want` (key order included: JSON.stringify compares).
// Key order is ignored unless `ordered` (a spec that fixes the order says so).
export const canon = (v) => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x));
export const jsonEq = (p, want, { ordered = false } = {}) => (c) => {
  const t = c.file(p);
  if (t === null) return no(`${p} does not exist`);
  let v;
  try { v = JSON.parse(t); } catch (_) { return no(`${p} is not valid JSON`); }
  const same = ordered ? JSON.stringify(v) === JSON.stringify(want) : canon(v) === canon(want);
  return same ? ok() : no(`${p} does not hold the required data`);
};

// A JS source literal for a value, so a gate's arguments are BUILT INSIDE the sandbox's realm. An
// array made in this realm fails `instanceof Array` in the vm's, which would fail a correct answer.
export function lit(v) {
  if (v === undefined) return 'undefined';
  if (typeof v === 'number') return Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : String(v);
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(lit).join(', ') + ']';
  return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + lit(x)).join(', ') + '}';
}

// A gate over a model-written ES module. The source runs as a script in a fresh vm context (the
// `export` keywords stripped): no process, no require, 2 s per evaluation. vm is not a security
// boundary (Node docs); it keeps a bench gate from handing the model's code this process's globals.
// A case is [fnName, args, want] or { expr, want, label }; `want: { throws: /re/ }` expects a throw.
export const jsGate = (p, cases) => (c) => {
  const src = c.file(p);
  if (src === null) return no(`${p} does not exist`);
  const body = String(src).replace(/^\s*export\s+\{[^}]*\};?\s*$/gm, '').replace(/^(\s*)export\s+(default\s+)?/gm, '$1');
  const ctx = vm.createContext({});
  try { vm.runInContext(body, ctx, { timeout: 2000 }); } catch (e) { return no(`${p} does not load: ${String(e && e.message).slice(0, 120)}`); }
  for (const k of cases) {
    const expr = Array.isArray(k) ? `${k[0]}(${k[1].map(lit).join(', ')})` : k.expr;
    const label = Array.isArray(k) ? expr : (k.label || k.expr);
    const want = Array.isArray(k) ? k[2] : k.want;
    if (Array.isArray(k) && vm.runInContext(`typeof ${k[0]}`, ctx) !== 'function') return no(`${p} does not define ${k[0]}`);
    let got, threw = null;
    try { got = vm.runInContext(`JSON.stringify(${expr})`, ctx, { timeout: 2000 }); } catch (e) { threw = e; }
    if (want && want.throws instanceof RegExp) {
      if (!threw || !want.throws.test(String(threw.message))) return no(`${label} did not throw as required`);
      continue;
    }
    if (threw) return no(`${label} threw: ${String(threw.message).slice(0, 80)}`);
    // Key order is not part of any spec here: both sides are compared with sorted keys.
    if ((got === undefined ? undefined : canon(JSON.parse(got))) !== (want === undefined ? undefined : canon(want))) return no(`${label} returned ${String(got).slice(0, 120)}`);
  }
  return ok();
};

// A hidden test module, run over the FINISHED workspace by the same js-runner the agent's `node` uses.
// The test lives at __gate__/hidden.test.mjs (never in the workspace), so it imports "../<file>".
// Passes on exit 0. The why is the runner's ✖ lines, as a test command would print them.
export const GATE_ENTRY = '__gate__/hidden.test.mjs';
export const hiddenTest = (source) => async (c) => {
  const runner = createJsRunner({ ...nodeJsHost, timeoutMs: 20000, read: async (p) => (p === GATE_ENTRY ? source : c.files.has(p) ? c.files.get(p) : null) });
  const r = await runner.run({ entry: GATE_ENTRY });
  if (r.code === 0) return ok();
  const lines = String(r.output || '').split('\n').filter((l) => /✖|Error|failed|refus/i.test(l)).slice(0, 6).join(' | ');
  return no(`hidden tests: exit ${r.code} — ${lines.slice(0, 400) || String(r.output).slice(0, 200)}`);
};
// The source of a hidden test: `imports` is the import line(s); each case is [expr, want] or
// [expr, { throws: /re/ }], checked with node:assert/strict in the runner's own realm.
export function testSource(imports, cases) {
  const body = cases.map(([expr, want], i) => {
    const check = want && want.throws instanceof RegExp ? `assert.throws(() => ${expr}, ${want.throws})` : `assert.deepStrictEqual(${expr}, ${lit(want)})`;
    return `try { ${check}; } catch (e) { failed++; console.log(${JSON.stringify(`✖ case ${i + 1}: ${expr.slice(0, 120)}`)} + ' — ' + String(e && e.message).split('\\n')[0].slice(0, 160)); }`;
  });
  return `import assert from 'node:assert/strict';\n${imports}\nlet failed = 0;\n${body.join('\n')}\nif (failed) { console.log(failed + ' of ${cases.length} failed'); process.exit(1); }\nconsole.log('all ${cases.length} passed');\n`;
}

// Reference-solution steps (bed.mjs scriptedInfer).
export const sh = (command) => ({ tool: 'shell', args: { command } });
export const read = (path) => ({ tool: 'read', args: { path } });
export const write = (path, content) => ({ tool: 'write', args: { path, content } });
export const edit = (path, old_string, new_string, extra = {}) => ({ tool: 'edit', args: { path, old_string, new_string, ...extra } });
export const say = (text) => ({ say: text });
export const done = (summary = 'done') => ({ tool: 'task_done', args: { summary } });
