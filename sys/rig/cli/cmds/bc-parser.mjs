import { ArgError } from '../args.mjs';

const words = new Set(['define', 'auto', 'if', 'else', 'while', 'for', 'break', 'continue', 'return', 'quit', 'halt', 'print', 'scale', 'ibase', 'obase', 'last', 'length', 'sqrt', 'read', 'limits', 'warranty']);
const assignments = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=']);
const comparisons = new Set(['<', '<=', '>', '>=', '==', '!=']);
const powers = new Map([['||', 10], ['&&', 20], ...[...comparisons].map((op) => [op, 40]),
  ...[...assignments].map((op) => [op, 50]), ['+', 60], ['-', 60], ['*', 70], ['/', 70], ['%', 70], ['^', 80]]);
const lvalue = (node) => node && (node.type === 'variable' || node.type === 'array');

// Source is one character per byte. Strings retain exact input bytes.
export function parseBc(source, { maxSourceBytes = 262144, maxNodes = 100000, maxDepth = 128, strict = false, warn = false, reserveNode = () => {} } = {}) {
  let offset = 0, line = 1, column = 1, nodes = 0, nesting = 0, loops = 0, functions = 0, conditionDepth = 0;
  let token, buffered = null, comparisonCount = 0;
  const warnings = [], quit = Symbol('compile-time quit'), depths = new WeakMap();
  const loc = () => ({ offset, line, column });
  const fail = (message, where = token?.loc || loc()) => { throw new ArgError(`bc: ${message} at line ${where.line}, column ${where.column}`); };
  const extension = (message, where = token?.loc || loc()) => {
    if (strict) fail(`non-POSIX extension: ${message}`, where);
    if (warn) {
      const text = `bc: warning: ${message} at line ${where.line}, column ${where.column}`;
      reserveNode(text.length * 2 + 32); warnings.push(text);
    }
  };
  for (const [name, value] of Object.entries({ maxSourceBytes, maxNodes, maxDepth })) if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${name} limit`);
  if (typeof source !== 'string' || source.length > maxSourceBytes) fail(`program exceeds the ${maxSourceBytes}-byte source limit`);
  const advance = () => { const c = source[offset++]; if (c === '\n') { line++; column = 1; } else column++; return c; };
  const make = (type, where, properties = {}) => {
    if (++nodes > maxNodes) fail(`program exceeds the ${maxNodes}-node syntax limit`, where);
    let depth = 1;
    for (const value of Object.values(properties)) for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object') depth = Math.max(depth, 1 + (depths.get(child) || 0));
    }
    if (depth > maxDepth) fail(`program exceeds the ${maxDepth}-level syntax limit`, where);
    reserveNode();
    const result = { type, ...properties, loc: where }; depths.set(result, depth); return result;
  };
  const nested = (fn) => {
    if (++nesting > maxDepth) fail(`program exceeds the ${maxDepth}-level syntax limit`);
    try { return fn(); } finally { nesting--; }
  };
  function lex() {
    while (offset < source.length) {
      const c = source[offset];
      if (' \t\r\v\f'.includes(c)) { advance(); continue; }
      if (c === '\\' && source[offset + 1] === '\n') { advance(); advance(); continue; }
      if (c === '/' && source[offset + 1] === '*') {
        const start = loc(); advance(); advance();
        while (offset < source.length && !(source[offset] === '*' && source[offset + 1] === '/')) advance();
        if (offset === source.length) fail('unterminated comment', start);
        advance(); advance(); continue;
      }
      if (c === '#') { extension('line comment', loc()); while (offset < source.length && source[offset] !== '\n') advance(); continue; }
      break;
    }
    const start = loc(), c = source[offset];
    if (offset === source.length) return { kind: 'eof', loc: start };
    if (c === '\n') { advance(); return { kind: 'nl', loc: start }; }
    if (c === '"') {
      advance(); const begin = offset;
      while (offset < source.length && source[offset] !== '"') { if (source[offset] === '\0') fail('NUL in string', loc()); advance(); }
      if (offset === source.length) fail('unterminated string', start);
      const value = source.slice(begin, offset); advance(); return { kind: 'string', value, loc: start };
    }
    if (/[a-z]/.test(c)) {
      let value = advance(); while (/[a-z0-9_]/.test(source[offset] || '\0')) value += advance();
      if (value.length > 1 && !words.has(value) && !['length', 'sqrt', 'read'].includes(value)) extension('multi-character name', start);
      if (value === 'last') extension('last variable', start);
      return { kind: words.has(value) ? value : 'name', value, loc: start };
    }
    if (/[0-9A-F]/.test(c) || c === '.' && /[0-9A-F]/.test(source[offset + 1] || '\0')) {
      let value = '';
      const numberPart = () => {
        for (;;) {
          if (/[0-9A-F]/.test(source[offset] || '\0')) value += advance();
          else if (source[offset] === '\\' && source[offset + 1] === '\n') { advance(); advance(); }
          else break;
        }
      };
      numberPart();
      if (source[offset] === '.') { value += advance(); numberPart(); }
      return { kind: 'number', value, loc: start };
    }
    if (c === '.') { extension('last-value dot', start); advance(); return { kind: 'last', value: 'last', loc: start }; }
    const pair = source.slice(offset, offset + 2);
    if (['++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '<=', '>=', '==', '!=', '&&', '||'].includes(pair)) {
      advance(); advance(); return { kind: pair, loc: start };
    }
    if ('+-*/%^=<>!()[]{},;'.includes(c)) { advance(); return { kind: c, loc: start }; }
    fail(`unexpected character ${JSON.stringify(c)}`, start);
  }
  const next = () => { const previous = token; token = buffered || lex(); buffered = null; return previous; };
  const eat = (kind) => token.kind === kind ? next() : null;
  const need = (kind) => { if (token.kind !== kind) fail(`expected ${kind}, found ${token.kind}`); return next(); };
  const newlines = () => { while (eat('nl')) {} };
  const separators = () => { while (token.kind === 'nl' || token.kind === ';') next(); };
  const isEnd = () => [';', 'nl', '}', 'eof'].includes(token.kind);
  const hasElse = () => {
    if (token.kind !== ';' && token.kind !== 'nl') return token.kind === 'else';
    let separator = token;
    while (token.kind === ';' || token.kind === 'nl') {
      if (token.kind === 'nl') separator = token;
      next();
    }
    if (token.kind === 'else') return true;
    buffered = token; token = separator; return false;
  };
  const condition = () => {
    const previous = comparisonCount; comparisonCount = 0; conditionDepth++;
    try { return expression(); } finally { conditionDepth--; comparisonCount = previous; }
  };
  function expression(min = 0) {
    return nested(() => {
      let left;
      const start = token.loc;
      if (token.kind === 'number') left = make('number', start, { text: next().value });
      else if (['name', 'scale', 'ibase', 'obase', 'last', 'length', 'sqrt', 'read'].includes(token.kind)) {
        const name = next().value;
        if (eat('(')) {
          if (name === 'read') fail('read() is not supported; supply source through files and stdin', start);
          const args = [];
          if (token.kind !== ')') { do { args.push(expression()); } while (eat(',')); }
          need(')'); left = make('call', start, { name, args });
        } else if (['length', 'sqrt', 'read'].includes(name)) fail(`${name} requires a function call`, start);
        else if (eat('[')) {
          if (['scale', 'ibase', 'obase', 'last'].includes(name)) fail('special variable cannot be an array', start);
          if (eat(']')) left = make('arrayRef', start, { name });
          else { const index = expression(); need(']'); left = make('array', start, { name, index }); }
        } else left = make('variable', start, { name });
      } else if (eat('(')) { const value = expression(); need(')'); left = make('group', start, { value }); }
      else if (['-', '+', '!', '++', '--'].includes(token.kind)) {
        const op = next().kind;
        if (op === '+' || op === '!') extension(`unary ${op}`, start);
        const argument = expression(op === '!' ? 30 : 90);
        if ((op === '++' || op === '--') && !lvalue(argument)) fail('increment requires a variable', start);
        left = make('unary', start, { op, argument, prefix: true });
      } else fail('expected an expression');
      for (;;) {
        const op = token.kind;
        if ((op === '++' || op === '--') && min <= 100) {
          if (!lvalue(left)) fail('increment requires a variable');
          next(); left = make('unary', left.loc, { op, argument: left, prefix: false }); continue;
        }
        const power = powers.get(op);
        if (power === undefined || power < min) break;
        const where = next().loc;
        if (op === '&&' || op === '||') extension(`boolean ${op}`, where);
        if (comparisons.has(op) && (!conditionDepth || ++comparisonCount > 1)) extension('comparison outside a single condition', where);
        if (assignments.has(op) && !lvalue(left)) fail('assignment requires a variable', where);
        const right = expression(power + (assignments.has(op) || op === '^' ? 0 : 1));
        left = make(assignments.has(op) ? 'assign' : 'binary', left.loc, { op, left, right });
      }
      return left;
    });
  }
  function declaration() {
    const reference = !!eat('*'); if (reference) extension('array reference parameter');
    const name = need('name').value;
    let array = false;
    if (eat('[')) { need(']'); array = true; }
    if (reference && !array) fail('reference parameter must be an array');
    reserveNode(64 + name.length * 2);
    return { name, array, reference };
  }
  function block() {
    return nested(() => {
      const start = need('{').loc, body = []; separators();
      while (token.kind !== '}') {
        if (token.kind === 'eof') fail('unterminated block', start);
        body.push(statement());
        if (!isEnd()) fail('expected a statement separator');
        separators();
      }
      need('}'); return make('block', start, { body });
    });
  }
  function statement() {
    return nested(() => {
      const start = token.loc;
      if (token.kind === 'quit') throw quit;
      if (token.kind === 'limits' || token.kind === 'warranty') fail(`${token.kind} is not supported`, start);
      if (eat('halt')) { extension('halt statement', start); return make('halt', start); }
      if (token.kind === '{') return block();
      if (eat('if')) {
        need('('); const test = condition(); need(')'); newlines();
        const consequent = statement(); let alternate = null;
          if (hasElse()) { extension('else clause'); next(); newlines(); alternate = statement(); }
        return make('if', start, { test, consequent, alternate });
      }
      if (eat('while')) {
        need('('); const test = condition(); need(')'); newlines(); loops++;
        try { return make('while', start, { test, body: statement() }); } finally { loops--; }
      }
      if (eat('for')) {
        need('('); const init = token.kind === ';' ? null : expression(); need(';');
        const test = token.kind === ';' ? null : condition(); need(';');
        const update = token.kind === ')' ? null : expression(); need(')');
        if (!init || !test || !update) extension('omitted for expression', start);
        newlines(); loops++;
        try { return make('for', start, { init, test, update, body: statement() }); } finally { loops--; }
      }
      if (token.kind === 'break' || token.kind === 'continue') {
        const type = next().kind; if (!loops) fail(`${type} outside a loop`, start);
        if (type === 'continue') extension('continue statement', start);
        return make(type, start);
      }
      if (eat('return')) {
        if (!functions) fail('return outside a function', start);
        let argument = null;
        if (!isEnd()) {
          if (token.kind !== '(') extension('return without parentheses', start);
          argument = expression();
        }
        return make('return', start, { argument });
      }
      if (eat('print')) {
        extension('print statement', start); const items = [];
        do { items.push(token.kind === 'string' ? make('string', token.loc, { value: next().value }) : expression()); } while (eat(','));
        return make('print', start, { items });
      }
      if (token.kind === 'string') return make('stringStatement', start, { value: next().value });
      if (token.kind === 'define' || token.kind === 'auto') fail(`${token.kind} is not valid here`);
      if (isEnd()) return make('empty', start);
      const value = expression();
      const beginsAssignment = (node) => node.type === 'assign' || node.type === 'binary' && beginsAssignment(node.left);
      return make('expression', start, { value, print: !beginsAssignment(value) });
    });
  }
  function definition() {
    const start = need('define').loc, name = need('name').value;
    need('('); const params = [];
    if (token.kind !== ')') do { params.push(declaration()); } while (eat(','));
    need(')'); if (token.kind === 'nl') { extension('newline before function brace'); newlines(); }
    const opening = need('{');
    if (opening.loc.line !== start.line || token.kind !== 'nl') extension('compact function definition', start);
    separators(); const autos = [];
    if (eat('auto')) {
      do { const value = declaration(); if (value.reference) fail('auto variables cannot be references'); autos.push(value); } while (eat(','));
      if (!isEnd()) fail('auto declaration needs a separator'); separators();
    }
    const names = new Set();
    for (const item of [...params, ...autos]) {
      const key = item.name + (item.array ? '[]' : '');
      if (names.has(key)) fail(`duplicate local declaration ${key}`, start); names.add(key);
    }
    const previousLoops = loops; loops = 0; functions++;
    const body = [];
    try {
      while (token.kind !== '}') {
        if (token.kind === 'eof') fail('unterminated function', start);
        body.push(statement()); if (!isEnd()) fail('expected a statement separator'); separators();
      }
      need('}');
    } finally { functions--; loops = previousLoops; }
    return make('define', start, { name, params, autos, body });
  }
  const body = [], pending = [];
  try {
    token = lex();
    while (token.kind !== 'eof') {
      if (eat('nl')) { body.push(...pending.splice(0)); continue; }
      if (eat(';')) continue;
      if (token.kind === '}') fail('unexpected closing brace');
      pending.push(token.kind === 'define' ? definition() : statement());
      if (!isEnd()) fail('expected a statement separator');
    }
    body.push(...pending);
  } catch (error) { if (error !== quit) throw error; return { type: 'program', body, warnings, quit: true, nodes }; }
  return { type: 'program', body, warnings, quit: false, nodes };
}
