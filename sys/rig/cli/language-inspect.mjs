// Static inspection shares execution's grammar. Unknown executable positions
// fail closed; ordinary expanded arguments retain their known command prefix.
import { parseShell, staticWord, assignmentWord } from './language-parser.mjs';
import { parseArgs } from './args.mjs';
import { parseFind } from './cmds/find.mjs';

const aliases = { egrep: ['grep', '-E'], fgrep: ['grep', '-F'], more: ['cat'], dir: ['ls'], vdir: ['ls', '-l'] };
const envSpec = { ignore: { short: 'i', long: 'ignore-environment' }, unset: { short: 'u', long: 'unset', value: true, multiple: true } };
const timeoutSpec = { preserve: { long: 'preserve-status' }, verbose: { short: 'v', long: 'verbose' } };
const xargsSpec = { maxArgs: { short: 'n', long: 'max-args', value: true }, replace: { short: 'I', value: true },
  null: { short: '0', long: 'null' }, delimiter: { short: 'd', long: 'delimiter', value: true },
  noRun: { short: 'r', long: 'no-run-if-empty' }, maxLines: { short: 'L', long: 'max-lines', value: true } };
const literalArgument = (word) => {
  const value = staticWord(word);
  if (value === null || word.parts.some((part) => !part.quoted && /[*?\[]/.test(part.text))
    || word.parts[0]?.quoted === false && /^~(?:\/|$)/.test(word.parts[0].text)) return null;
  return value;
};
const uncertain = () => { throw new Error('uninspectable shell invocation'); };

export function inspectShell(command, { functions = new Map() } = {}) {
  try {
    const body = parseShell(command), segments = [], definitions = new Map(), seen = new WeakSet(), called = new Set();
    const inheritedFunctions = new Set(functions.keys());
    let steps = 0;
    const tick = () => { if (++steps > 100000) uncertain(); };
    const register = (name, node) => { const list = definitions.get(name) ?? []; list.push(node); definitions.set(name, list); };
    for (const [name, node] of functions) register(name, node);
    // Definitions in untaken branches still contribute every potential body.
    function gather(node) {
      if (!node || typeof node !== 'object' || seen.has(node)) return;
      tick(); seen.add(node);
      if (node.kind === 'function') register(node.name, node.body);
      for (const value of Object.values(node)) if (Array.isArray(value)) { for (const item of value) gather(item); }
      else if (value && typeof value === 'object') gather(value);
    }
    gather(body); for (const list of definitions.values()) for (const node of list) gather(node);
    const visited = new WeakSet();
    function wrapper(argv, spec) {
      const encoded = argv.slice(1).map((arg) => arg === null ? '\0unknown' : arg);
      const parsed = parseArgs(encoded, spec, { stopAtOperand: true });
      const consumed = encoded.length - parsed.operands.length;
      if (argv.slice(1, consumed + 1).includes(null)) uncertain();
      return { ...parsed, operands: argv.slice(consumed + 1) };
    }
    function invocation(argv, depth = 0) {
      tick(); if (depth > 64 || argv[0] === null) uncertain();
      if (!argv.length) return;
      segments.push(argv);
      const verb = argv[0];
      if (definitions.has(verb) && !called.has(verb)) {
        called.add(verb); for (const node of definitions.get(verb)) walk(node);
      }
      // A persisted function shadows the dispatcher throughout this invocation.
      if (inheritedFunctions.has(verb)) return;
      if (Object.hasOwn(aliases, verb)) { invocation([...aliases[verb], ...argv.slice(1)], depth + 1); return; }
      if (verb === 'env') {
        const { operands } = wrapper(argv, envSpec);
        while (operands.length && operands[0] !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(operands[0])) operands.shift();
        if (operands.length) invocation(operands, depth + 1);
      } else if (verb === 'timeout') {
        const { operands } = wrapper(argv, timeoutSpec);
        if (operands.length < 2 || operands[0] === null) uncertain();
        invocation(operands.slice(1), depth + 1);
      } else if (verb === 'xargs') {
        const { operands, occurrences } = wrapper(argv, xargsSpec);
        let batching;
        for (const item of occurrences) {
          if (!['replace', 'maxArgs', 'maxLines'].includes(item.key)) continue;
          if (item.key === 'maxArgs' && Number(item.value) === 1 && batching?.key === 'replace') continue;
          batching = item;
        }
        const executable = operands.length ? operands : ['echo'];
        if (batching?.key === 'replace') {
          if (!batching.value) uncertain();
          invocation(executable.map((arg) => arg === null || arg.includes(batching.value) ? null : arg), depth + 1);
        } else invocation([...executable, null], depth + 1);
      } else if (verb === 'find') {
        if (argv.includes(null)) uncertain();
        const program = parseFind(argv.slice(1));
        if (program.deletes) invocation(['rm', null], depth + 1);
        for (const action of program.executions) invocation(action.template.map((arg) => arg.includes('{}') ? null : arg), depth + 1);
      }
    }
    function word(value) {
      if (!value) return;
      for (const part of value.parts) {
        tick();
        if (part.kind === 'substitution') walk(part.body);
        else if (part.word) word(part.word);
      }
    }
    function walk(node) {
      if (!node || visited.has(node)) return;
      tick(); visited.add(node);
      for (const redirect of node.redirects ?? []) if (!['<<', '<<-'].includes(redirect.op)) word(redirect.target);
      switch (node.kind) {
        case 'list': for (const item of node.items) walk(item); break;
        case 'andor': walk(node.first); for (const item of node.rest) walk(item.node); break;
        case 'pipeline': for (const item of node.commands) walk(item); break;
        case 'simple': {
          for (const value of node.words) word(value);
          let at = 0; while (at < node.words.length && assignmentWord(node.words[at])) at++;
          invocation(node.words.slice(at).map(literalArgument)); break;
        }
        case 'if': for (const branch of node.branches) { walk(branch.condition); walk(branch.body); } walk(node.otherwise); break;
        case 'for': for (const value of node.words ?? []) word(value); walk(node.body); break;
        case 'while': case 'until': walk(node.condition); walk(node.body); break;
        case 'case': word(node.word); for (const arm of node.cases) { for (const pattern of arm.patterns) word(pattern); walk(arm.body); } break;
        case 'arithmetic': word(node.word); break;
        case 'group': case 'subshell': case 'function': walk(node.body); break;
        default: uncertain();
      }
    }
    walk(body); return segments;
  } catch (_) { return null; }
}

// Canonical presentation only. Policy matches argv directly, never this text.
export const describeInvocation = (argv) => argv.map((arg) => arg === null ? '${…}'
  : !arg || /[\s;|&<>"'`\\]/.test(arg) ? JSON.stringify(arg) : arg).join(' ');

export function commandMatches(rule, argv, possible = false) {
  if (rule.spec === null || rule.spec === '') return true;
  let expected;
  try {
    const root = parseShell(rule.spec);
    const item = root.items[0], pipe = item?.first, node = pipe?.commands[0];
    if (root.items.length !== 1 || item.rest.length || pipe.negate || pipe.commands.length !== 1 || node.kind !== 'simple' || node.redirects.length) return false;
    expected = node.words.map(staticWord); if (expected.includes(null)) return false;
  } catch (_) { return false; }
  for (let at = 0; at < expected.length; at++) {
    if (argv[at] === null) return possible;
    if (argv[at] !== expected[at]) return false;
  }
  return rule.prefix || argv.length === expected.length || possible && argv.slice(expected.length).every((arg) => arg === null);
}
