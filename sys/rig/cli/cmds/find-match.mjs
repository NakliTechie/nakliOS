// Bounded C-locale ERE matching for find. Backslash extensions from awk and
// sed are deliberately excluded. Whole-path matching starts at byte zero.
import { ArgError } from '../args.mjs';

const fail = (message) => { throw new ArgError(`find: invalid regular expression: ${message}`); };
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

export function parseRegex(source, { wholePath = true } = {}) {
  if (source.length > 16384) fail('expression exceeds the 16384-byte limit');
  const extended = true;
  let at = 0, groups = 0, depth = 0;
  const op = (text) => extended || !'()|+?{}'.includes(text) ? text : '\\' + text;
  const is = (text) => source.startsWith(op(text), at);
  const consume = (text) => { if (!is(text)) return false; at += op(text).length; return true; };
  const escaped = () => {
    if (at >= source.length) fail('trailing backslash');
    const c = source[at++];
    if (/[A-Za-z0-9]/.test(c)) fail(`unsupported escape \\${c}`);
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
        if (node.kind === 'anchor') fail('cannot repeat a zero-width assertion');
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
  return { root: wholePath ? { kind: 'sequence', nodes: [{ kind: 'anchor', which: '^' }, root, { kind: 'anchor', which: '$' }] } : root, groups, source };
}

export function findRegex(regex, input, start = 0, { insensitive = false, multiline = false, tick = () => {} } = {}) {
  const push = (states, value) => {
    if (states.length >= 65536) fail('match state count exceeds the 65536-state limit');
    states.push(value);
  };
  const same = (a, b) => insensitive ? asciiLower(a) === asciiLower(b) : a === b;
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
      case 'group': return evaluate(node.child, state);
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
  for (let begin = start; begin <= Math.min(start, input.length); begin++) {
    tick(); let best;
    for (const result of evaluate(regex.root, { pos: begin })) if (!best || result.pos > best.pos) best = result;
    if (best) return { index: begin, end: best.pos };
  }
  return null;
}


// Glob matching uses a bounded NFA. Bracket membership is compiled for all 256
// byte values, so long bracket expressions cannot hide work inside one step.
export function parseGlob(source) {
  if (source.length > 16384) fail('glob exceeds the 16384-byte limit');
  const tokens = []; let at = 0, parsing = 0;
  const parseTick = () => { if (++parsing > 1000000) fail('glob parsing exceeds the operation limit'); };
  const finalBracket = source.lastIndexOf(']');
  const closingBracket = (start) => {
    if (finalBracket < start) return -1;
    let scan = start;
    if (source[scan] === '!' || source[scan] === '^') scan++;
    if (source[scan] === ']') scan++;
    while (scan < source.length) {
      parseTick();
      if (source[scan] === '\\') { scan += 2; continue; }
      if (source[scan] === '[' && ':=.'.includes(source[scan + 1] || '\0')) {
        const end = source.indexOf(source[scan + 1] + ']', scan + 2);
        if (end < 0) return -1;
        scan = end + 2; continue;
      }
      if (source[scan] === ']') return scan;
      scan++;
    }
    return -1;
  };
  const character = () => {
    if (at >= source.length) fail('unterminated bracket expression');
    if (source[at] === '\\') { at++; if (at >= source.length) fail('trailing backslash'); }
    return source.charCodeAt(at++);
  };
  const classItem = () => {
    if (source[at] === '[' && ':=.'.includes(source[at + 1] || '\0')) {
      const tag = source[at + 1], end = source.indexOf(tag + ']', at + 2);
      if (end < 0) fail('unterminated named character class');
      const name = source.slice(at + 2, end); at = end + 2;
      if (tag !== ':') {
        if (name.length !== 1) fail('C-locale collating elements must contain one byte');
        return { code: name.charCodeAt(0) };
      }
      if (name === 'word' || !Object.hasOwn(classes, name)) fail(`unknown character class ${name}`);
      return { predicate: classes[name] };
    }
    return { code: character() };
  };
  while (at < source.length) {
    parseTick(); const c = source[at++];
    if (c === '*') { if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' }); }
    else if (c === '?') tokens.push({ kind: 'any' });
    else if (c === '\\') {
      if (at >= source.length) fail('trailing backslash in glob');
      tokens.push({ kind: 'char', code: source.charCodeAt(at++) });
    } else if (c === '[') {
      // POSIX shell patterns give an unmatched bracket opener literal meaning.
      if (closingBracket(at) < 0) { tokens.push({ kind: 'char', code: 91 }); continue; }
      const negate = source[at] === '!' || source[at] === '^'; if (negate) at++;
      const table = new Uint8Array(256); let first = true;
      while (at < source.length) {
        parseTick();
        if (source[at] === ']' && !first) { at++; break; }
        first = false;
        const low = classItem();
        if (source[at] === '-' && source[at + 1] !== ']' && at + 1 < source.length) {
          at++; const high = classItem();
          if (low.code == null || high.code == null || high.code < low.code) fail('invalid glob character range');
          for (let code = low.code; code <= high.code; code++) table[code] = 1;
        } else if (low.predicate) {
          for (let code = 0; code < 256; code++) if (low.predicate(code)) table[code] = 1;
        } else table[low.code] = 1;
      }
      tokens.push({ kind: 'class', table, negate });
    } else tokens.push({ kind: 'char', code: c.charCodeAt(0) });
  }
  return tokens;
}

export function matchesGlob(tokens, input, { insensitive = false, tick = () => {} } = {}) {
  const add = (states, index) => {
    states.add(index);
    while (tokens[index]?.kind === 'star') { tick(); states.add(++index); }
  };
  let states = new Set(); add(states, 0);
  for (let at = 0; at < input.length; at++) {
    const next = new Set(), code = input.charCodeAt(at), lower = asciiLower(code), upper = code >= 97 && code <= 122 ? code - 32 : code;
    for (const index of states) {
      tick(); const token = tokens[index]; if (!token) continue;
      if (token.kind === 'star') { add(next, index); continue; }
      const yes = token.kind === 'any' || token.kind === 'char' && (insensitive ? asciiLower(token.code) === lower : token.code === code)
        || token.kind === 'class' && (!!(token.table[code] || insensitive && (token.table[lower] || token.table[upper])) !== token.negate);
      if (yes) add(next, index + 1);
    }
    if (!next.size) return false;
    states = next;
  }
  return states.has(tokens.length);
}
