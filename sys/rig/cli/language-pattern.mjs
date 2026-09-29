// Linear-state shell glob matcher. Character iteration uses Unicode code points;
// named POSIX classes retain the shell's documented C-locale interpretation.
import { LanguageError } from './language-parser.mjs';

const classes = {
  digit: (c) => c >= 48 && c <= 57,
  lower: (c) => c >= 97 && c <= 122,
  upper: (c) => c >= 65 && c <= 90,
  alpha: (c) => classes.lower(c) || classes.upper(c),
  alnum: (c) => classes.alpha(c) || classes.digit(c),
  blank: (c) => c === 32 || c === 9,
  space: (c) => c === 32 || c >= 9 && c <= 13,
  cntrl: (c) => c < 32 || c === 127,
  print: (c) => c >= 32 && c <= 126,
  graph: (c) => c >= 33 && c <= 126,
  punct: (c) => classes.graph(c) && !classes.alnum(c),
  xdigit: (c) => classes.digit(c) || c >= 65 && c <= 70 || c >= 97 && c <= 102,
};
export function parsePattern(source, tick) {
  const chars = [...source], tokens = []; let at = 0;
  const fail = (text) => { throw new LanguageError('pattern: ' + text); };
  if (chars.length > 16384) fail('length exceeds its limit');
  function bracket() {
    const saved = at, negate = chars[at] === '!' || chars[at] === '^'; if (negate) at++;
    const tests = []; let first = true;
    function item() {
      tick();
      if (chars[at] === '[' && chars[at + 1] === ':') {
        at += 2; let name = '';
        while (at < chars.length && !(chars[at] === ':' && chars[at + 1] === ']')) { tick(); name += chars[at++]; }
        if (at === chars.length || !Object.hasOwn(classes, name)) fail('invalid named character class');
        at += 2; return { name };
      }
      if (chars[at] === '[' && ['.', '='].includes(chars[at + 1])) fail('collating and equivalence classes are unavailable');
      if (chars[at] === '\\') at++;
      if (at >= chars.length) return null;
      return { low: chars[at++].codePointAt(0) };
    }
    while (at < chars.length) {
      tick();
      if (chars[at] === ']' && !first) { at++; return { kind: 'class', tests, negate }; }
      first = false; const begin = item(); if (!begin) break;
      if (chars[at] === '-' && chars[at + 1] !== ']' && at + 1 < chars.length) {
        at++; const end = item();
        if (!end || begin.low === undefined || end.low === undefined || begin.low > end.low) fail('invalid character range');
        tests.push({ low: begin.low, high: end.low });
      } else tests.push(begin.name ? begin : { low: begin.low, high: begin.low });
    }
    at = saved; return { kind: 'char', value: '[' };
  }
  while (at < chars.length) {
    tick(); const value = chars[at++];
    if (value === '*') { if (tokens.at(-1)?.kind !== 'star') tokens.push({ kind: 'star' }); }
    else if (value === '?') tokens.push({ kind: 'any' });
    else if (value === '[') tokens.push(bracket());
    else if (value === '\\') {
      if (at === chars.length) fail('trailing escape');
      tokens.push({ kind: 'char', value: chars[at++] });
    } else tokens.push({ kind: 'char', value });
  }
  return tokens;
}

export function matchesPattern(tokens, text, tick) {
  const add = (states, index) => { states.add(index); while (tokens[index]?.kind === 'star') { tick(); states.add(++index); } };
  let states = new Set(); add(states, 0);
  for (const char of text) {
    const next = new Set(), code = char.codePointAt(0);
    for (const at of states) {
      tick(); const token = tokens[at]; if (!token) continue;
      if (token.kind === 'star') { add(next, at); continue; }
      const yes = token.kind === 'any' || token.kind === 'char' && token.value === char
        || token.kind === 'class' && token.tests.some((test) => { tick(); return test.name ? classes[test.name](code) : code >= test.low && code <= test.high; }) !== token.negate;
      if (yes) add(next, at + 1);
    }
    if (!next.size) return false;
    states = next;
  }
  return states.has(tokens.length);
}
