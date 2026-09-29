import { loadAll, dump, CORE_SCHEMA } from '../../../../vendor/js-yaml/js-yaml.mjs';
import { createDataContext, parseJsonValues, normalizeValue, jsonText, setKey } from './data-common.mjs';
import { parseJq } from './jq-parser.mjs';
import { evaluateJq, truthy } from './jq-runtime.mjs';
import { createFdCommand } from './fd.mjs';
import { createSqliteCommand } from './sqlite.mjs';
import { toBytes } from '../io.mjs';

function filterArguments(ctx, argv) {
  const options = { raw: false, compact: false, slurp: false, nullInput: false, exitStatus: false, yaml: ctx.command === 'yq' };
  const variables = new Map(), operands = []; let positional = false;
  const names = { r: 'raw', c: 'compact', s: 'slurp', n: 'nullInput', e: 'exitStatus' };
  const long = { '--raw-output': 'raw', '--compact-output': 'compact', '--slurp': 'slurp', '--null-input': 'nullInput', '--exit-status': 'exitStatus' };
  for (let at = 0; at < argv.length; at++) {
    const word = argv[at];
    const take = () => { if (++at >= argv.length) ctx.fail(`${word} requires an argument`, 2); return argv[at]; };
    if (!positional && word === '--') { positional = true; continue; }
    if (!positional && (word === '--arg' || word === '--argjson')) {
      const name = take(), text = take();
      if (!name || name.includes('\0')) ctx.fail('variable name must not be empty or contain NUL', 2);
      let value = text;
      if (word === '--argjson') {
        const parsed = awaitableJson(text, ctx);
        value = parsed;
      }
      variables.set(name, value); continue;
    }
    if (!positional && Object.hasOwn(long, word)) { options[long[word]] = true; continue; }
    if (!positional && ctx.command === 'yq' && ['-j', '--output-json', '-y', '--yaml-output'].includes(word)) {
      options.yaml = word === '-y' || word === '--yaml-output'; continue;
    }
    if (!positional && word.startsWith('-') && word !== '-') {
      if (word.startsWith('--')) ctx.fail(`unsupported option ${word}`, 2);
      for (const flag of word.slice(1)) {
        if (ctx.command === 'yq' && (flag === 'j' || flag === 'y')) { options.yaml = flag === 'y'; continue; }
        if (!Object.hasOwn(names, flag)) ctx.fail(`unsupported option -${flag}`, 2);
        options[names[flag]] = true;
      }
      continue;
    }
    operands.push(word);
  }
  return { options, variables, filter: operands.shift() ?? '.', files: operands };
}
function awaitableJson(text, ctx) {
  // Full bounded graph validation is performed before compiling/evaluating.
  try { return JSON.parse(text); } catch { ctx.fail('--argjson requires one valid JSON value', 2); }
}
async function runFilter(command, io, settings, argv, stdin) {
  const ctx = createDataContext(command, io, stdin, settings.signal, settings.limits); ctx.arguments(argv);
  const { options, variables, filter, files } = filterArguments(ctx, argv);
  for (const [name, value] of variables) variables.set(name, await normalizeValue(ctx, value));
  const named = Object.create(null); for (const [name, value] of variables) setKey(named, name, value);
  variables.set('ARGS', { named, positional: [] });
  const tree = parseJq(ctx, filter, variables); let inputs = [];
  if (options.nullInput) inputs = [null];
  else {
    for (const operand of ctx.inputs.operands(files)) {
      const bytes = await (await operand.open()).rest(); ctx.budget.reserveRetained(bytes.length * 2);
      const text = ctx.decode(bytes);
      if (command === 'jq') for (const value of await parseJsonValues(ctx, text)) inputs.push(value);
      else {
        let parsed;
        try { parsed = loadAll(text, { schema: CORE_SCHEMA, maxDepth: ctx.limits.maxDepth, maxAliases: ctx.limits.maxValues, maxTotalMergeKeys: ctx.limits.maxValues }); }
        catch (error) { ctx.fail(`invalid YAML: ${String(error?.message || error)}`, 4); }
        for (const value of parsed) inputs.push(await normalizeValue(ctx, value));
      }
    }
    if (options.slurp) { ctx.value(32 + inputs.length * 8); inputs = [inputs]; }
  }
  let count = 0, last = null;
  for (const input of inputs) for await (const value of evaluateJq(ctx, tree, input, variables)) {
    ctx.result(); count++; last = value;
    if (options.raw && typeof value === 'string') ctx.output.argument(value + '\n');
    else if (options.yaml) {
      const normal = await normalizeValue(ctx, value);
      let output;
      try { output = dump(normal, { schema: CORE_SCHEMA, noRefs: true, lineWidth: -1 }); }
      catch (error) { ctx.fail(`YAML output failed: ${String(error?.message || error)}`); }
      if (count > 1) ctx.output.argument('---\n');
      ctx.output.argument(output);
    } else ctx.output.argument(await jsonText(ctx, value, options.compact) + '\n');
  }
  return ctx.finish(options.exitStatus ? count ? truthy(last) ? 0 : 1 : 4 : 0);
}
async function* scanVariables(ctx, bytes) {
  const alpha = (c) => c === 95 || c >= 65 && c <= 90 || c >= 97 && c <= 122;
  const alnum = (c) => alpha(c) || c >= 48 && c <= 57;
  for (let at = 0; at < bytes.length; at++) {
    if (at % 4096 === 0) await ctx.budget.checkpoint();
    if (bytes[at] !== 36) continue;
    const start = at; let nameAt = at + 1, braced = bytes[nameAt] === 123;
    if (braced) nameAt++;
    if (!alpha(bytes[nameAt])) continue;
    let end = nameAt + 1; while (end < bytes.length && alnum(bytes[end])) end++;
    if (braced && bytes[end] !== 125) continue;
    let name = ''; for (let i = nameAt; i < end; i++) name += String.fromCharCode(bytes[i]);
    if (braced) end++;
    ctx.value(32 + name.length * 2); yield { start, end, name }; at = end - 1;
  }
}
async function envsubst(io, settings, argv, stdin) {
  const ctx = createDataContext('envsubst', io, stdin, settings.signal, settings.limits); ctx.arguments(argv);
  let variablesOnly = false, positional = false; const operands = [];
  for (const word of argv) {
    if (!positional && word === '--') positional = true;
    else if (!positional && (word === '-v' || word === '--variables')) variablesOnly = true;
    else if (!positional && word.startsWith('-')) ctx.fail(`unsupported option ${word}`, 1);
    else operands.push(word);
  }
  if (operands.length > 1 || variablesOnly && operands.length !== 1) ctx.fail('expected at most one SHELL-FORMAT; -v requires it', 1);
  const formats = operands.length ? [] : null;
  if (formats) for await (const item of scanVariables(ctx, toBytes(operands[0]))) formats.push(item);
  if (variablesOnly) { for (const item of formats) { await ctx.budget.checkpoint(); ctx.output.argument(item.name + '\n'); } return ctx.finish(); }
  const allowed = formats && new Set(formats.map((item) => item.name)), environment = new Map(settings.environment());
  const [source] = ctx.inputs.operands([]), bytes = await (await source.open()).rest();
  let at = 0;
  for await (const match of scanVariables(ctx, bytes)) {
    await ctx.budget.checkpoint(); if (allowed && !allowed.has(match.name)) continue;
    ctx.output.append(bytes.subarray(at, match.start)); ctx.output.argument(String(environment.get(match.name) ?? '')); at = match.end;
  }
  ctx.output.append(bytes.subarray(at)); return ctx.finish();
}
export function createDataCommands(io, { signal = () => null, environment = () => new Map(), limits = {}, ...runtime } = {}) {
  const settings = { signal, environment, limits, ...runtime };
  return {
    jq: (argv, stdin = '') => runFilter('jq', io, settings, argv, stdin),
    yq: (argv, stdin = '') => runFilter('yq', io, settings, argv, stdin),
    envsubst: (argv, stdin = '') => envsubst(io, settings, argv, stdin),
    fd: createFdCommand(io, settings), sqlite3: createSqliteCommand(io, settings),
    duckdb: async () => ({ text: 'duckdb: no DuckDB runtime is installed in this shell', code: 1 }),
  };
}
