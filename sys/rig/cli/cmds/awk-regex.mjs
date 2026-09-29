// Bounded byte-oriented POSIX ERE matcher. Adapted from sed-regex.mjs, with
// awk escape rules: no sed word boundaries, backreferences, or numeric extensions.
// Matching uses leftmost-longest selection and the interpreter's shared budget.
import { ArgError } from '../args.mjs';

const fail = (message) => { throw new ArgError(`awk: invalid regular expression: ${message}`); };
const asciiLower = (code) => code >= 65 && code <= 90 ? code + 32 : code;
const classes = {
  alnum: (c) => c >= 48 && c <= 57 || c >= 65 && c <= 90 || c >= 97 && c <= 122,
  alpha: (c) => c >= 65 && c <= 90 || c >= 97 && c <= 122,
  blank: (c) => c === 32 || c === 9,
  cntrl: (c) => c < 32 || c === 127,
  digit: (c) => c >= 48 && c <= 57,
  graph: (c) => c >= 33 && c <= 126,
  lower: (c) => c >= 97 && c <= 122,
  print: (c) => c >= 32 && c <= 126,
  punct: (c) => c >= 33 && c <= 126 && !classes.alnum(c),
  space: (c) => c === 32 || c >= 9 && c <= 13,
  upper: (c) => c >= 65 && c <= 90,
  xdigit: (c) => c >= 48 && c <= 57 || c >= 65 && c <= 70 || c >= 97 && c <= 102,
  word: (c) => classes.alnum(c) || c === 95,
};

export function parseRegex(source) {
  if (source.length > 16384) fail('expression exceeds the 16384-byte limit');
  const extended = true;
  let at = 0, groups = 0, depth = 0;
  const op = (text) => extended || !'()|+?{}'.includes(text) ? text : '\\' + text;
  const is = (text) => source.startsWith(op(text), at);
  const consume = (text) => { if (!is(text)) return false; at += op(text).length; return true; };
  const escaped = () => {
    if (at >= source.length) fail('trailing backslash');
    const c = source[at++];
    const values = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11 };
    if (c in values) return { kind: 'char', code: values[c] };
    if (/^[0-7]$/.test(c)) {
      const rest = /^[0-7]{0,2}/.exec(source.slice(at))[0];
      at += rest.length;
      return { kind: 'char', code: parseInt(c + rest, 8) & 255 };
    }
    if (/[A-Za-z]/.test(c)) fail(`unsupported escape \\${c}`);
    return { kind: 'char', code: c.charCodeAt(0) };
  };
  function characterClass() {
    const negate = source[at] === '^'; if (negate) at++;
    const tests = []; let first = true, closed = false;
    function item() {
      if (source[at] === '[' && ':=.'.includes(source[at + 1] || '\0')) {
        const tag = source[at + 1];
        const end = source.indexOf(tag + ']', at + 2);
        if (end < 0) fail('unterminated character class');
        const name = source.slice(at + 2, end); at = end + 2;
        if (tag !== ':') {
          if (name.length !== 1) fail('C-locale collating elements must contain one byte');
          return { code: name.charCodeAt(0) };
        }
        if (name === 'word' || !Object.hasOwn(classes, name)) fail(`unknown character class ${name}`);
        return { test: classes[name] };
      }
      if (source[at] === '\\') {
        at++; const node = escaped();
        if (node.kind !== 'char') fail('unsupported escape in bracket expression');
        return { code: node.code };
      }
      if (at >= source.length) fail('unterminated bracket expression');
      return { code: source.charCodeAt(at++) };
    }
    while (at < source.length) {
      if (source[at] === ']' && !first) { at++; closed = true; break; }
      first = false;
      const begin = item();
      if (source[at] === '-' && source[at + 1] !== ']' && at + 1 < source.length) {
        at++; const end = item();
        if (begin.code == null || end.code == null || begin.code > end.code) fail('invalid character range');
        tests.push((c) => c >= begin.code && c <= end.code);
      } else tests.push(begin.test || ((c) => c === begin.code));
    }
    if (!closed) fail('unterminated bracket expression');
    return { kind: 'class', negate, tests };
  }
  function sequence(inGroup) {
    const nodes = [];
    while (at < source.length && !is('|') && !(inGroup && is(')'))) {
      let node;
      if (is(')')) fail('unmatched closing parenthesis');
      if (consume('(')) {
        if (++depth > 64) fail('group nesting exceeds 64');
        if (groups >= 64) fail('capture count exceeds 64');
        const group = ++groups; node = { kind: 'group', group, child: expression(true) }; depth--;
        if (!consume(')')) fail('unmatched opening parenthesis');
      } else {
        const c = source[at++];
        if (c === '[') node = characterClass();
        else if (c === '\\') node = escaped();
        else if (c === '.') node = { kind: 'dot' };
        else if (c === '^' && (extended || nodes.length === 0)) node = { kind: 'anchor', which: '^' };
        else if (c === '$' && (extended || at === source.length || is('|') || inGroup && is(')'))) node = { kind: 'anchor', which: '$' };
        else if (extended && '*+?{}'.includes(c)) fail(`unexpected repetition operator ${c}`);
        else node = { kind: 'char', code: c.charCodeAt(0) };
      }
      let min, max;
      if (consume('*')) { min = 0; max = Infinity; }
      else if (consume('+')) { min = 1; max = Infinity; }
      else if (consume('?')) { min = 0; max = 1; }
      else if (consume('{')) {
        const m = /^(\d+)(?:,(\d*))?/.exec(source.slice(at));
        if (!m) fail('invalid repetition count');
        at += m[0].length;
        if (!consume('}')) fail('unterminated repetition count');
        min = +m[1]; max = m[2] === undefined ? min : m[2] === '' ? Infinity : +m[2];
        if (!Number.isSafeInteger(min) || min > 1000000 || max < min || max !== Infinity && (!Number.isSafeInteger(max) || max > 1000000)) fail('invalid repetition count');
      }
      if (min != null) {
        if (node.kind === 'anchor' || node.kind === 'boundary') fail('cannot repeat a zero-width assertion');
        node = { kind: 'repeat', child: node, min, max };
        if (is('*') || is('+') || is('?') || is('{')) fail('repeated repetition operator');
      }
      nodes.push(node);
    }
    return nodes.length === 1 ? nodes[0] : { kind: 'sequence', nodes };
  }
  function expression(inGroup = false) {
    const alternatives = [sequence(inGroup)];
    while (consume('|')) alternatives.push(sequence(inGroup));
    return alternatives.length === 1 ? alternatives[0] : { kind: 'alternative', alternatives };
  }
  const root = expression();
  if (at !== source.length) fail('unexpected expression suffix');
  return { root, groups, source };
}

export function findRegex(regex, input, start = 0, { insensitive = false, multiline = false, tick = () => {} } = {}) {
  const push = (states, value) => {
    if (states.length >= 65536) fail('match state count exceeds the 65536-state limit');
    states.push(value);
  };
  const same = (a, b) => insensitive ? asciiLower(a) === asciiLower(b) : a === b;
  const word = (at) => at >= 0 && at < input.length && classes.word(input.charCodeAt(at));
  function evaluate(node, state) {
    tick();
    const pos = state.pos, code = input.charCodeAt(pos);
    switch (node.kind) {
      case 'char': return pos < input.length && same(code, node.code) ? [{ ...state, pos: pos + 1 }] : [];
      case 'dot': return pos < input.length && (!multiline || code !== 10) ? [{ ...state, pos: pos + 1 }] : [];
      case 'class': {
        if (pos === input.length) return [];
        const matches = node.tests.some((test) => { tick(); return test(code) || insensitive && (test(asciiLower(code)) || test(code >= 97 && code <= 122 ? code - 32 : code)); });
        return matches !== node.negate ? [{ ...state, pos: pos + 1 }] : [];
      }
      case 'anchor': {
        const yes = node.which === '^' ? pos === 0 || multiline && !node.absolute && input[pos - 1] === '\n'
          : pos === input.length || multiline && !node.absolute && input[pos] === '\n';
        return yes ? [state] : [];
      }
      case 'boundary': {
        const before = word(pos - 1), after = word(pos);
        const yes = node.which === 'b' ? before !== after : node.which === 'B' ? before === after : node.which === '<' ? !before && after : before && !after;
        return yes ? [state] : [];
      }
      case 'ref': {
        const capture = state.caps[node.group]; if (!capture) return [];
        const text = input.slice(capture[0], capture[1]);
        if (pos + text.length > input.length) return [];
        for (let i = 0; i < text.length; i++) { tick(); if (!same(input.charCodeAt(pos + i), text.charCodeAt(i))) return []; }
        return [{ ...state, pos: pos + text.length }];
      }
      case 'group': return evaluate(node.child, state).map((result) => {
        const caps = result.caps.slice(); caps[node.group] = [pos, result.pos]; return { ...result, caps };
      });
      case 'sequence': {
        let states = [state];
        for (const child of node.nodes) {
          const next = [];
          for (const current of states) for (const result of evaluate(child, current)) push(next, result);
          states = next; if (!states.length) break;
        }
        return states;
      }
      case 'alternative': {
        const states = [];
        for (const alternative of node.alternatives) for (const result of evaluate(alternative, state)) push(states, result);
        return states;
      }
      case 'repeat': {
        const results = node.min === 0 ? [state] : [];
        let frontier = [state];
        const ceiling = Math.min(node.max, input.length - pos + node.min + 1);
        for (let count = 1; count <= ceiling && frontier.length; count++) {
          const next = [];
          for (const current of frontier) {
            for (const result of evaluate(node.child, current)) {
              if (count >= node.min) push(results, result);
              // A zero-width repetition cannot improve a future match. Keep it
              // only until the minimum repetition count has been satisfied.
              if (result.pos !== current.pos || count < node.min) push(next, result);
            }
          }
          frontier = next;
        }
        return results;
      }
      default: throw new Error(`unknown regex node ${node.kind}`);
    }
  }
  const better = (a, b) => {
    if (!b || a.pos !== b.pos) return !b || a.pos > b.pos;
    for (let group = 1; group <= regex.groups; group++) {
      const x = a.caps[group], y = b.caps[group];
      if (!x && !y) continue;
      if (!x || !y) return !!x;
      const length = x[1] - x[0] - (y[1] - y[0]);
      if (length) return length > 0;
    }
    return false;
  };
  for (let begin = start; begin <= input.length; begin++) {
    tick(); let best;
    for (const result of evaluate(regex.root, { pos: begin, caps: [] })) if (better(result, best)) best = result;
    if (best) return { index: begin, end: best.pos, captures: [input.slice(begin, best.pos), ...Array.from({ length: regex.groups }, (_, i) => {
      const cap = best.caps[i + 1]; return cap ? input.slice(cap[0], cap[1]) : '';
    })] };
  }
  return null;
}
