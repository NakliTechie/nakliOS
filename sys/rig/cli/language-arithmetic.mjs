// Bounded signed 64-bit shell arithmetic. No host evaluation or dynamic code.
import { LanguageError } from './language-parser.mjs';

const wrap = (value) => BigInt.asIntN(64, value);
const binary = new Map([
  [',', 1], ['=', 2], ['+=', 2], ['-=', 2], ['*=', 2], ['/=', 2], ['%=', 2], ['<<=', 2], ['>>=', 2], ['&=', 2], ['^=', 2], ['|=', 2],
  ['||', 4], ['&&', 5], ['|', 6], ['^', 7], ['&', 8], ['==', 9], ['!=', 9],
  ['<', 10], ['<=', 10], ['>', 10], ['>=', 10], ['<<', 11], ['>>', 11], ['+', 12], ['-', 12],
  ['*', 13], ['/', 13], ['%', 13], ['**', 14],
]);
const operations = ['<<=', '>>=', '++', '--', '**', '&&', '||', '==', '!=', '<=', '>=', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '^=', '|=', '+', '-', '*', '/', '%', '~', '!', '<', '>', '&', '^', '|', '=', '?', ':', ',', '(', ')'];
const fail = (message) => { throw new LanguageError(`arithmetic: ${message}`); };
function compile(source, ctx) {
  let at = 0, current, depth = 0;
  function scan() {
    ctx.spend();
    while (/[ \t\r\n]/.test(source[at] || '\0')) at++;
    if (at === source.length) return { type: 'end' };
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(at));
    if (name) { at += name[0].length; return { type: 'variable', value: name[0] }; }
    const number = /^[0-9][0-9A-Za-z_#@]*/.exec(source.slice(at));
    if (number) { at += number[0].length; return { type: 'number', value: number[0] }; }
    for (const value of operations) if (source.startsWith(value, at)) { at += value.length; return { type: 'op', value }; }
    fail(`unsupported character '${source[at]}'`);
  }
  const peek = () => current ??= scan();
  const take = () => { const value = peek(); current = null; return value; };
  const need = (value) => { if (peek().value !== value) fail(`expected '${value}'`); take(); };
  function expression(minimum = 0) {
    if (++depth > ctx.limits.maxDepth) fail('expression nesting exceeds its limit');
    let left;
    try {
      const token = take();
      if (token.type === 'number' || token.type === 'variable') left = { kind: token.type, value: token.value };
      else if (token.value === '(') { left = expression(); need(')'); }
      else if (['+', '-', '~', '!', '++', '--'].includes(token.value)) left = { kind: 'unary', operator: token.value, node: expression(15) };
      else fail('expected an integer or variable');
      while (true) {
        const operator = peek().value;
        if ((operator === '++' || operator === '--') && minimum <= 16) { take(); left = { kind: 'postfix', operator, node: left }; continue; }
        if (operator === '?' && minimum <= 3) {
          take(); const yes = expression(); need(':'); const no = expression(3); left = { kind: 'conditional', condition: left, yes, no }; continue;
        }
        const precedence = binary.get(operator);
        if (precedence === undefined || precedence < minimum) break;
        take(); const assignment = precedence === 2;
        const right = expression(assignment || operator === '**' ? precedence : precedence + 1);
        left = { kind: assignment ? 'assignment' : 'binary', operator, left, right };
      }
      return left;
    } finally { depth--; }
  }
  if (peek().type === 'end') return { kind: 'number', value: '0' };
  const ast = expression();
  if (peek().type !== 'end') fail('unexpected expression suffix');
  return ast;
}

export async function arithmetic(source, ctx, variableStack = []) {
  ctx.argument(source);
  const ast = compile(String(source), ctx);
  async function number(text) {
    let base = 10, digits = text;
    if (text.includes('#')) {
      const parts = text.split('#');
      if (parts.length !== 2 || !/^[0-9]{1,2}$/.test(parts[0])) fail('invalid integer base');
      base = Number(parts[0]); digits = parts[1];
      if (base < 2 || base > 64) fail('integer base must be from 2 to 64');
    } else if (/^0[xX]/.test(text)) { base = 16; digits = text.slice(2); }
    else if (text.length > 1 && text.startsWith('0')) { base = 8; digits = text.slice(1); }
    if (!digits) fail('integer has no digits');
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ@_';
    let value = 0n;
    for (const ch of digits) {
      await ctx.tick();
      const digit = alphabet.indexOf(base <= 36 ? ch.toLowerCase() : ch);
      if (digit < 0 || digit >= base) fail(`invalid digit for base ${base}`);
      value = wrap(value * BigInt(base) + BigInt(digit));
    }
    return value;
  }
  const reference = (node) => { if (node.kind !== 'variable') fail('assignment needs a variable'); return node.value; };
  async function operation(op, a, b) {
    switch (op) {
      case '+': return wrap(a + b); case '-': return wrap(a - b); case '*': return wrap(a * b);
      case '/': if (!b) fail('division by zero'); return wrap(a / b);
      case '%': if (!b) fail('division by zero'); return wrap(a % b);
      case '<<': return wrap(a << (b & 63n)); case '>>': return wrap(a >> (b & 63n));
      case '&': return a & b; case '^': return a ^ b; case '|': return a | b;
      case '<': return a < b ? 1n : 0n; case '<=': return a <= b ? 1n : 0n;
      case '>': return a > b ? 1n : 0n; case '>=': return a >= b ? 1n : 0n;
      case '==': return a === b ? 1n : 0n; case '!=': return a !== b ? 1n : 0n;
      case '**': {
        if (b < 0n) fail('negative exponent');
        let result = 1n;
        while (b) { await ctx.tick(); if (b & 1n) result = wrap(result * a); b >>= 1n; if (b) a = wrap(a * a); }
        return result;
      }
      default: fail(`unsupported operator '${op}'`);
    }
  }
  async function evaluate(node, depth = 0) {
    await ctx.tick();
    if (depth > ctx.limits.maxDepth) fail('evaluation nesting exceeds its limit');
    const run = (child) => evaluate(child, depth + 1);
    if (node.kind === 'number') return number(node.value);
    if (node.kind === 'variable') {
      const value = ctx.get(node.value);
      if (value == null || value === '') return 0n;
      if (variableStack.includes(node.value) || variableStack.length >= ctx.limits.maxDepth) fail('recursive variable value');
      return arithmetic(value, ctx, [...variableStack, node.value]);
    }
    if (node.kind === 'conditional') return await run(node.condition) !== 0n ? run(node.yes) : run(node.no);
    if (node.kind === 'assignment') {
      const name = reference(node.left), right = await run(node.right);
      const value = node.operator === '=' ? right : await operation(node.operator.slice(0, -1), await run(node.left), right);
      ctx.set(name, String(value)); return value;
    }
    if (node.kind === 'unary' || node.kind === 'postfix') {
      const value = await run(node.node);
      if (node.operator === '++' || node.operator === '--') {
        const name = reference(node.node), changed = wrap(value + (node.operator === '++' ? 1n : -1n));
        ctx.set(name, String(changed)); return node.kind === 'postfix' ? value : changed;
      }
      if (node.operator === '+') return value;
      if (node.operator === '-') return wrap(-value);
      if (node.operator === '~') return wrap(~value);
      if (node.operator === '!') return value === 0n ? 1n : 0n;
    }
    if (node.kind === 'binary') {
      const left = await run(node.left);
      if (node.operator === '&&') return left === 0n ? 0n : await run(node.right) !== 0n ? 1n : 0n;
      if (node.operator === '||') return left !== 0n ? 1n : await run(node.right) !== 0n ? 1n : 0n;
      const right = await run(node.right);
      return node.operator === ',' ? right : operation(node.operator, left, right);
    }
    fail('invalid expression node');
  }
  return evaluate(ast);
}
