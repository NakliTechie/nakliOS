import { ArgError } from '../args.mjs';
import { parseRegex } from './sed-regex.mjs';

const fail = (message) => { throw new ArgError(`sed: ${message}`); };
const integer = (text, label) => {
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number < 0) fail(`invalid ${label}: ${text}`);
  return number;
};

// Scripts and pattern spaces use one string character per byte. The caller
// converts UTF-8 option strings and filesystem bytes without lossy decoding.
export function parseSed(source, { extended = false } = {}) {
  let at = 0;
  const commands = [], blocks = [], labels = new Map();
  const blanks = () => { while (source[at] === ' ' || source[at] === '\t' || source[at] === '\r') at++; };
  const separators = () => { while (/[;\s]/.test(source[at] || '\0')) at++; };
  const number = () => { const m = /^\d+/.exec(source.slice(at)); if (!m) return null; at += m[0].length; return integer(m[0], 'number'); };
  function delimited(delimiter, pattern = false) {
    let text = '', bracket = false, bracketFirst = false;
    while (at < source.length) {
      const c = source[at++];
      if (c === '\\') {
        if (at === source.length) fail('unterminated delimited expression');
        const next = source[at++];
        if (next === '\n') text += '\n';
        else if (next === delimiter) text += !pattern && (delimiter === '&' || delimiter === '\\') ? '\\' + delimiter : delimiter;
        else text += '\\' + next;
        if (bracket) bracketFirst = false;
        continue;
      }
      if (c === '\n') fail('unterminated delimited expression');
      if (c === delimiter && !bracket) return text;
      if (pattern) {
        if (bracket && c === '[' && ':=.'.includes(source[at] || '\0')) {
          const tag = source[at], end = source.indexOf(tag + ']', at + 1);
          if (end < 0) fail('unterminated bracket expression');
          text += c + source.slice(at, end + 2); at = end + 2; bracketFirst = false; continue;
        }
        if (c === '[' && !bracket) { bracket = true; bracketFirst = true; }
        else if (c === ']' && bracket && !bracketFirst) bracket = false;
        else if (bracket && !(bracketFirst && c === '^')) bracketFirst = false;
      }
      text += c;
    }
    fail('unterminated delimited expression');
  }
  function regex(delimiter) {
    const text = delimited(delimiter, true);
    let insensitive = false, multiline = false;
    while (source[at] === 'I' || source[at] === 'M') {
      if (source[at++] === 'I') insensitive = true; else multiline = true;
    }
    if (!text && (insensitive || multiline)) fail('cannot modify an empty regular expression');
    return { regex: text ? parseRegex(text, extended) : null, insensitive, multiline };
  }
  function address(second = false) {
    blanks();
    const n = number();
    if (n != null) {
      if (source[at] === '~') {
        at++; const step = number();
        if (step == null || step < 1) fail('step address requires a positive step');
        return { kind: 'step', first: n, step };
      }
      return { kind: 'line', line: n };
    }
    if (source[at] === '$') { at++; return { kind: 'last' }; }
    if (source[at] === '/' || source[at] === '\\') {
      const alternate = source[at++] === '\\';
      const delimiter = alternate ? source[at++] : '/';
      if (!delimiter || delimiter === '\n' || delimiter === '\\') fail('invalid address delimiter');
      return { kind: 'regex', ...regex(delimiter) };
    }
    if (second && (source[at] === '+' || source[at] === '~')) {
      const kind = source[at++] === '+' ? 'relative' : 'multiple';
      const count = number();
      if (count == null || kind === 'multiple' && count === 0) fail('relative range requires a valid count');
      return { kind, count };
    }
    return null;
  }
  function endOfCommand() {
    blanks();
    if (at < source.length && !';\n}#'.includes(source[at])) fail(`extra characters after command: ${source[at]}`);
  }
  function remainder({ label = false } = {}) {
    blanks(); const begin = at;
    while (at < source.length && source[at] !== '\n' && (!label || source[at] !== ';' && source[at] !== '}')) at++;
    return source.slice(begin, at).replace(/[\t\r ]+$/, '');
  }
  function commandText() {
    blanks();
    if (source[at] === '\\') { at++; if (source[at] === '\n') at++; }
    let text = '';
    while (at < source.length && source[at] !== '\n') {
      const c = source[at++];
      if (c !== '\\') { text += c; continue; }
      if (at === source.length) fail('trailing backslash in text command');
      const next = source[at++];
      if (next === '\n') text += '\n';
      else text += decodeEscape(next);
    }
    return text;
  }
  function transliteration(delimiter) {
    const raw = delimited(delimiter);
    let value = '';
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] !== '\\') value += raw[i];
      else {
        if (++i === raw.length) fail('trailing backslash in transliteration');
        value += decodeEscape(raw[i]);
      }
    }
    return value;
  }
  while (at < source.length) {
    separators(); if (at === source.length) break;
    if (source[at] === '#') { while (at < source.length && source[at] !== '\n') at++; continue; }
    if (source[at] === '}') {
      at++;
      if (!blocks.length) fail('unexpected closing brace');
      const opening = blocks.pop(); commands[opening].end = commands.length;
      commands.push({ op: '}' }); continue;
    }
    const first = address(); blanks();
    let second = null;
    if (source[at] === ',') {
      if (!first) fail('range has no first address');
      at++; second = address(true); if (!second) fail('range has no second address');
    }
    if (first?.kind === 'line' && first.line === 0 && second?.kind !== 'regex') fail('address 0 is valid only in a 0,/regexp/ range');
    if (second?.kind === 'line' && second.line === 0) fail('range end must be positive');
    blanks();
    const negate = source[at] === '!'; if (negate) { at++; blanks(); }
    const op = source[at++];
    if (!op || !'sdDpPnNaicyqQ=lrwhHgGxbtT:{}'.includes(op)) fail(`unsupported command ${op == null ? '(missing)' : op}`);
    if (op === '}') fail('closing brace cannot have an address');
    if (':'.includes(op) && (first || negate)) fail('label cannot have an address');
    if ('qQ'.includes(op) && second) fail(`${op} accepts at most one address`);
    const command = { op, first, second, negate };
    if (op === '{') {
      if (blocks.length >= 128) fail('block nesting exceeds 128');
      blocks.push(commands.length);
    } else if (op === 's') {
      const delimiter = source[at++];
      if (!delimiter || delimiter === '\n' || delimiter === '\\') fail('invalid substitution delimiter');
      const pattern = delimited(delimiter, true);
      command.pattern = pattern ? parseRegex(pattern, extended) : null;
      command.replacement = delimited(delimiter);
      command.global = false; command.print = false; command.insensitive = false; command.multiline = false; command.occurrence = null;
      while (at < source.length && !';\n}'.includes(source[at])) {
        const flag = source[at];
        if (flag === ' ' || flag === '\t' || flag === '\r') { at++; continue; }
        if (flag === '#') { while (at < source.length && source[at] !== '\n') at++; break; }
        if (flag === 'g' || flag === 'p' || flag === 'I' || flag === 'i' || flag === 'M' || flag === 'm') {
          at++;
          const key = flag === 'g' ? 'global' : flag === 'p' ? 'print' : flag.toLowerCase() === 'i' ? 'insensitive' : 'multiline';
          if (command[key]) fail(`duplicate substitution flag ${flag}`);
          command[key] = true;
        } else if (/\d/.test(flag)) {
          if (command.occurrence != null) fail('multiple substitution counts');
          command.occurrence = number();
          if (!command.occurrence) fail('substitution count must be positive');
        } else if (flag === 'w') {
          at++; command.file = remainder(); if (!command.file) fail('substitution w requires a filename'); break;
        } else fail(`unsupported substitution flag ${flag}`);
      }
      if (!pattern && (command.insensitive || command.multiline)) fail('cannot modify an empty regular expression');
      const refs = [];
      for (let i = 0; i < command.replacement.length; i++) if (command.replacement[i] === '\\') {
        const escaped = command.replacement[++i];
        if (escaped != null && /^[1-9]$/.test(escaped)) refs.push(+escaped);
      }
      if (command.pattern && refs.some((ref) => ref > command.pattern.groups)) fail('invalid reference in substitution replacement');
    } else if (op === 'y') {
      const delimiter = source[at++];
      if (!delimiter || delimiter === '\n' || delimiter === '\\') fail('invalid transliteration delimiter');
      command.from = transliteration(delimiter); command.to = transliteration(delimiter);
      if (command.from.length !== command.to.length) fail('transliteration strings have different lengths');
      endOfCommand();
    } else if ('aic'.includes(op)) command.text = commandText();
    else if ('rw'.includes(op)) {
      command.file = remainder(); if (!command.file) fail(`${op} requires a filename`);
    } else if (':btT'.includes(op)) {
      command.label = remainder({ label: true });
      if (op === ':') {
        if (!command.label) fail('label is empty');
        if (labels.has(command.label)) fail(`duplicate label ${command.label}`);
        labels.set(command.label, commands.length);
      }
    } else if ('qQl'.includes(op)) {
      blanks(); command.number = number();
      if ('qQ'.includes(op) && command.number > 255) fail('exit code must be between 0 and 255');
      endOfCommand();
    } else endOfCommand();
    commands.push(command);
  }
  if (blocks.length) fail('unmatched opening brace');
  for (const command of commands) if ('btT'.includes(command.op) && command.label) {
    if (!labels.has(command.label)) fail(`undefined label ${command.label}`);
    command.target = labels.get(command.label);
  }
  return { commands, quiet: source.startsWith('#n') };
}

export function decodeEscape(c) {
  return ({ n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v' })[c] ?? c;
}
