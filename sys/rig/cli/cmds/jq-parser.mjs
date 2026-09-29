import { DataError } from './data-common.mjs';
import { utf8Length } from './u2-common.mjs';

export function parseJq(ctx, source, variables = new Map()) {
  const fail = (message) => { throw new DataError(ctx.command, `filter: ${message}`, 3); };
  if (utf8Length(source) > ctx.limits.maxFilterBytes) fail('filter exceeds the byte limit');
  const tokens = []; let at = 0, depth = 0;
  while (at < source.length) {
    ctx.budget.spend('steps'); const c = source[at];
    if (/\s/.test(c)) { at++; continue; }
    if (c === '#') { while (at < source.length && source[at] !== '\n') at++; continue; }
    const start = at;
    if (c === '"') {
      at++; let escaped = false;
      while (at < source.length) { const ch = source[at++]; if (escaped) escaped = false; else if (ch === '\\') escaped = true; else if (ch === '"') break; }
      let value; try { value = JSON.parse(source.slice(start, at)); } catch { fail(`invalid string at ${start}`); }
      tokens.push({ type: 'literal', value }); continue;
    }
    const number = /^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(source.slice(at));
    if (number) { at += number[0].length; const value = Number(number[0]); if (!Number.isFinite(value)) fail('nonfinite number'); tokens.push({ type: 'literal', value }); continue; }
    const identifier = /^\$?[A-Za-z_][A-Za-z_0-9]*/.exec(source.slice(at));
    if (identifier) {
      const name = identifier[0]; at += name.length;
      if (['null', 'true', 'false'].includes(name)) tokens.push({ type: 'literal', value: JSON.parse(name) });
      else tokens.push({ type: name.startsWith('$') ? 'variable' : 'name', value: name.startsWith('$') ? name.slice(1) : name });
      continue;
    }
    const pair = source.slice(at, at + 2);
    if (['==', '!=', '<=', '>=', '//'].includes(pair)) { tokens.push({ type: pair }); at += 2; continue; }
    if ('.[]{}(),:|?<>+-*/%'.includes(c)) { tokens.push({ type: c }); at++; continue; }
    fail(`unsupported token ${c} at ${at}`);
  }
  tokens.push({ type: 'end' }); at = 0;
  const peek = () => tokens[at], take = () => tokens[at++];
  const is = (type) => peek().type === type || peek().type === 'name' && peek().value === type;
  const accept = (type) => is(type) ? (take(), true) : false;
  const need = (type) => { if (!accept(type)) fail(`expected ${type}`); };
  const node = (type, fields = {}) => { ctx.value(); return { type, ...fields }; };
  const precedence = { '|': 1, ',': 2, '//': 3, or: 4, and: 5, '==': 6, '!=': 6, '<': 6, '<=': 6, '>': 6, '>=': 6, '+': 7, '-': 7, '*': 8, '/': 8, '%': 8 };
  function expression(min = 1, comma = true) {
    if (++depth > ctx.limits.maxDepth) fail('filter nesting exceeds the resource limit');
    try {
      let value = primary();
      while (true) {
        const op = peek().type === 'name' ? peek().value : peek().type, rank = precedence[op];
        if (!rank || rank < min || op === ',' && !comma) break;
        take(); value = node('binary', { op, left: value, right: expression(rank + 1, comma) });
      }
      return value;
    } finally { depth--; }
  }
  function primary() {
    const token = take(); let value;
    if (token.type === 'literal') value = node('literal', { value: token.value });
    else if (token.type === 'variable') {
      if (!variables.has(token.value)) fail(`undefined variable $${token.value}`);
      value = node('variable', { name: token.value });
    }
    else if (token.type === '.') {
      value = node('identity');
      if (peek().type === 'name' || peek().type === 'literal' && typeof peek().value === 'string') value = node('index', { base: value, key: node('literal', { value: take().value }) });
    } else if (token.type === '(') { value = expression(); need(')'); }
    else if (token.type === '-') value = node('negate', { value: expression(9) });
    else if (token.type === '[') { value = node('collect', { value: accept(']') ? null : expression() }); if (value.value) need(']'); }
    else if (token.type === '{') {
      const fields = [];
      if (!accept('}')) {
        do {
          let key, expressionValue;
          if (accept('(')) { key = expression(); need(')'); need(':'); expressionValue = expression(1, false); }
          else {
            const name = take();
            if (name.type !== 'name' && !(name.type === 'literal' && typeof name.value === 'string')) fail('object keys require a name, string or parenthesized filter');
            key = node('literal', { value: name.value });
            expressionValue = accept(':') ? expression(1, false) : node('index', { base: node('identity'), key });
          }
          fields.push({ key, value: expressionValue });
        } while (accept(','));
        need('}');
      }
      value = node('object', { fields });
    } else if (token.type === 'name') {
      const name = token.value;
      if (['select', 'map', 'has'].includes(name)) { need('('); const argument = expression(); need(')'); value = node('call', { name, argument }); }
      else if (['keys', 'keys_unsorted', 'length', 'type', 'empty', 'not'].includes(name)) value = node('call', { name });
      else fail(`unsupported filter ${name}`);
    } else fail(`unexpected ${token.type}`);
    while (true) {
      if (accept('?')) { value = node('optional', { value }); continue; }
      if (accept('.')) {
        const key = take(); if (key.type !== 'name' && !(key.type === 'literal' && typeof key.value === 'string')) fail('expected a field name');
        value = node('index', { base: value, key: node('literal', { value: key.value }) }); continue;
      }
      if (accept('[')) {
        if (accept(']')) value = node('iterate', { base: value });
        else {
          const key = is(':') ? null : expression();
          if (accept(':')) { const end = is(']') ? null : expression(); value = node('slice', { base: value, start: key, end }); }
          else value = node('index', { base: value, key });
          need(']');
        }
        continue;
      }
      break;
    }
    return value;
  }
  if (is('end')) fail('empty filter');
  const result = expression(); if (!is('end')) fail(`unexpected ${peek().value ?? peek().type}`);
  return result;
}
