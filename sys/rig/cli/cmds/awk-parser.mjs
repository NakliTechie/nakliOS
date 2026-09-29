import { ArgError } from '../args.mjs';

// The command adapter supplies byte strings. Locations and limits therefore
// count source bytes, including when a script originally contains UTF-8 text.
const KEYWORDS = new Set([
  'BEGIN', 'END', 'function', 'if', 'else', 'while', 'do', 'for', 'in',
  'break', 'continue', 'next', 'exit', 'return', 'delete', 'print', 'printf', 'getline',
]);
const BUILTINS = new Set([
  'atan2', 'cos', 'sin', 'exp', 'log', 'sqrt', 'int', 'rand', 'srand',
  'gsub', 'sub', 'index', 'length', 'match', 'split', 'sprintf', 'substr',
  'tolower', 'toupper', 'close', 'system',
]);
const SPECIALS = new Set([
  'ARGC', 'ARGV', 'CONVFMT', 'ENVIRON', 'FILENAME', 'FNR', 'FS', 'NF', 'NR',
  'OFMT', 'OFS', 'ORS', 'RLENGTH', 'RS', 'RSTART', 'SUBSEP',
]);
const ASSIGNMENTS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=']);
const PRECEDENCE = new Map([
  ...[...ASSIGNMENTS].map(op => [op, 10]),
  ['?', 20], ['||', 40], ['&&', 50], ['in', 60], ['~', 70], ['!~', 70],
  ['<', 80], ['<=', 80], ['==', 80], ['!=', 80], ['>', 80], ['>=', 80], ['|', 80],
  ['concat', 90], ['+', 100], ['-', 100], ['*', 110], ['/', 110], ['%', 110],
  ['^', 130], ['++', 140], ['--', 140],
]);
const ESCAPES = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v' };
const isDigit = c => c >= '0' && c <= '9';
const isNameStart = c => !!c && /[A-Za-z_]/.test(c);
const isNamePart = c => !!c && /[A-Za-z_0-9]/.test(c);
const isLValue = node => ['variable', 'array', 'field'].includes(node?.type);

export function parseAwk(source, { maxSourceBytes = 262144, maxNodes = 100000, maxDepth = 128 } = {}) {
  const fail = (message, loc = token?.loc || { offset: 0, line: 1, column: 1 }) => {
    throw new ArgError(`awk: ${message} at line ${loc.line}, column ${loc.column}`);
  };
  let token;
  for (const [name, value] of Object.entries({ maxSourceBytes, maxNodes, maxDepth })) {
    if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${name} limit`);
  }
  if (typeof source !== 'string') fail('program source must be a string');
  if (source.length > maxSourceBytes) fail(`program exceeds source limit (${maxSourceBytes} bytes)`);

  let offset = 0, line = 1, column = 1, nodes = 0, nesting = 0;
  let loopDepth = 0, functionDepth = 0, ruleContext = null;
  const grouped = new WeakSet();
  const depths = new WeakMap(), functions = [], rules = [], declared = new Map();
  const location = () => ({ offset, line, column });
  const advance = () => {
    const c = source[offset++];
    if (c === '\n') { line++; column = 1; } else column++;
    return c;
  };
  const node = (type, loc, properties = {}) => {
    if (++nodes > maxNodes) fail(`program exceeds syntax node limit (${maxNodes})`, loc);
    let depth = 1;
    for (const value of Object.values(properties)) {
      const children = Array.isArray(value) ? value : [value];
      for (const child of children) if (child && typeof child === 'object') depth = Math.max(depth, 1 + (depths.get(child) || 0));
    }
    if (depth > maxDepth) fail(`program exceeds syntax depth limit (${maxDepth})`, loc);
    const result = { type, ...properties, loc: { ...loc } };
    depths.set(result, depth);
    return result;
  };
  const nested = fn => {
    if (++nesting > maxDepth) fail(`program exceeds syntax depth limit (${maxDepth})`);
    try { return fn(); } finally { nesting--; }
  };
  function lexString(start) {
    advance();
    let value = '';
    while (offset < source.length) {
      const c = advance();
      if (c === '"') return { kind: 'string', value, loc: start, end: offset };
      if (c === '\n' || c === '\r' || c === '\0') fail('unterminated string literal', start);
      if (c !== '\\') { value += c; continue; }
      if (offset >= source.length) break;
      const escaped = advance();
      if (escaped === '\n') continue;
      if (escaped === '\r' && source[offset] === '\n') { advance(); continue; }
      if (/[0-7]/.test(escaped)) {
        let octal = escaped;
        for (let count = 1; count < 3 && /[0-7]/.test(source[offset] || 'x'); count++) octal += advance();
        value += String.fromCharCode(parseInt(octal, 8) & 255);
      } else value += ESCAPES[escaped] ?? escaped;
    }
    fail('unterminated string literal', start);
  }
  function lex() {
    while (offset < source.length) {
      const c = source[offset];
      if (c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v') { advance(); continue; }
      if (c === '#') { while (offset < source.length && source[offset] !== '\n') advance(); continue; }
      if (c === '\\' && source[offset + 1] === '\n') { advance(); advance(); continue; }
      if (c === '\\' && source[offset + 1] === '\r' && source[offset + 2] === '\n') { advance(); advance(); advance(); continue; }
      break;
    }
    const start = location(), c = source[offset];
    if (offset >= source.length) return { kind: 'eof', value: '', loc: start, end: offset };
    if (c === '\n') { advance(); return { kind: 'nl', value: '\n', loc: start, end: offset }; }
    if (c === '"') return lexString(start);
    if (isNameStart(c)) {
      let value = advance();
      while (isNamePart(source[offset])) value += advance();
      return { kind: KEYWORDS.has(value) ? value : 'id', value, loc: start, end: offset };
    }
    if (isDigit(c) || c === '.' && isDigit(source[offset + 1])) {
      let value = '';
      while (isDigit(source[offset])) value += advance();
      if (source[offset] === '.') {
        value += advance();
        while (isDigit(source[offset])) value += advance();
      }
      if ((source[offset] === 'e' || source[offset] === 'E') &&
          (isDigit(source[offset + 1]) || '+-'.includes(source[offset + 1] || '\0') && isDigit(source[offset + 2]))) {
        value += advance();
        if (source[offset] === '+' || source[offset] === '-') value += advance();
        if (!isDigit(source[offset])) fail('invalid numeric exponent', start);
        while (isDigit(source[offset])) value += advance();
      }
      const number = Number(value);
      if (!Number.isFinite(number)) fail('numeric literal is outside the finite number range', start);
      return { kind: 'number', value: number, loc: start, end: offset };
    }
    const pair = source.slice(offset, offset + 2);
    if (['++', '--', '+=', '-=', '*=', '/=', '%=', '^=', '==', '!=', '<=', '>=', '!~', '&&', '||', '>>'].includes(pair)) {
      advance(); advance(); return { kind: pair, value: pair, loc: start, end: offset };
    }
    if ('{}()[],;?:$+-*/%^!<>=~|'.includes(c)) {
      advance(); return { kind: c, value: c, loc: start, end: offset };
    }
    fail(c === '\0' ? 'NUL byte in program' : `unexpected character ${JSON.stringify(c)}`, start);
  }
  const take = () => { const previous = token; token = lex(); return previous; };
  const at = kind => token.kind === kind;
  const accept = kind => at(kind) ? take() : null;
  const expect = kind => {
    if (!at(kind)) fail(`expected ${JSON.stringify(kind)}, found ${at('eof') ? 'end of program' : JSON.stringify(token.value)}`);
    return take();
  };
  const newlines = () => { while (at('nl')) take(); };
  const separators = () => { while (at('nl') || at(';')) take(); };
  const terminator = () => at(';') || at('nl') || at('}') || at('eof');
  const requireLValue = (value, context) => { if (!isLValue(value) || grouped.has(value)) fail(`${context} requires a variable, array element, or field`, value.loc); };

  function regexLiteral() {
    const start = token.loc;
    // Slash has already been lexed as / or /=. Re-scan it in operand context.
    offset = start.offset; line = start.line; column = start.column; advance();
    let pattern = '', bracket = false, bracketFirst = false;
    while (offset < source.length) {
      const c = advance();
      if (c === '\n' || c === '\r' || c === '\0') fail('unterminated regular expression', start);
      if (c === '\\') {
        if (offset >= source.length) break;
        const escaped = advance();
        if (escaped === '\n') continue;
        if (escaped === '\r' && source[offset] === '\n') { advance(); continue; }
        pattern += escaped === '/' ? '/' : '\\' + escaped;
        if (bracket) bracketFirst = false;
        continue;
      }
      if (c === '/') { token = lex(); return node('regex', start, { source: pattern }); }
      if (bracket && c === '[' && ':=.'.includes(source[offset] || '\0')) {
        const tag = source[offset];
        pattern += c + advance();
        let closed = false;
        while (offset < source.length && source[offset] !== '\n') {
          const part = advance(); pattern += part;
          if (part === tag && source[offset] === ']') { pattern += advance(); closed = true; break; }
        }
        if (!closed) fail('unterminated regular expression bracket expression', start);
        bracketFirst = false;
        continue;
      }
      if (c === '[' && !bracket) { bracket = true; bracketFirst = true; }
      else if (c === ']' && bracket && !bracketFirst) bracket = false;
      else if (bracket && !(bracketFirst && c === '^')) bracketFirst = false;
      pattern += c;
    }
    fail('unterminated regular expression', start);
  }

  function argumentsList(closing) {
    const args = [];
    if (!at(closing)) {
      args.push(expression());
      while (accept(',')) { newlines(); args.push(expression()); }
    }
    expect(closing);
    return args;
  }
  function namedValue() {
    const name = expect('id');
    if (at('(') && (name.end === token.loc.offset || BUILTINS.has(name.value))) {
      take();
      return node('call', name.loc, { name: name.value, args: argumentsList(')') });
    }
    if (BUILTINS.has(name.value)) {
      if (name.value === 'length') return node('call', name.loc, { name: 'length', args: [] });
      fail(`builtin ${name.value} requires parentheses`, name.loc);
    }
    if (accept('[')) {
      const indices = argumentsList(']');
      if (!indices.length) fail('array subscript cannot be empty', name.loc);
      return node('array', name.loc, { name: name.value, indices });
    }
    return node('variable', name.loc, { name: name.value });
  }
  function getline(start, sourceValue = null) {
    let target = null;
    if (at('id') && !BUILTINS.has(token.value) || at('$')) {
      target = at('id') ? namedValue() : prefix();
      requireLValue(target, 'getline');
    }
    let sourceKind = sourceValue === null ? 'main' : 'command';
    if (sourceKind === 'main' && accept('<')) {
      sourceValue = expression(81);
      sourceKind = 'file';
    }
    return node('getline', start, { target, source: sourceValue, sourceKind });
  }
  function prefix() {
    const start = token.loc;
    if (at('number') || at('string')) {
      const literal = take(); return node(literal.kind, start, { value: literal.value });
    }
    if (at('/') || at('/=')) return regexLiteral();
    if (at('id')) return namedValue();
    if (accept('(')) {
      const first = expression();
      if (!accept(',')) { expect(')'); grouped.add(first); return first; }
      const items = [first];
      do { newlines(); items.push(expression()); } while (accept(','));
      expect(')');
      if (!at('in')) fail('a parenthesized expression list requires the in operator', start);
      return node('tuple', start, { items });
    }
    if (accept('$')) return node('field', start, { index: expression(150) });
    if (at('!') || at('+') || at('-')) {
      const op = take().kind;
      return node('unary', start, { op, argument: expression(120), prefix: true });
    }
    if (at('++') || at('--')) {
      const op = take().kind, argument = expression(140);
      requireLValue(argument, op);
      return node('update', start, { op, argument, prefix: true });
    }
    if (accept('getline')) return getline(start);
    fail(`expected an expression, found ${at('eof') ? 'end of program' : JSON.stringify(token.value)}`, start);
  }
  const beginsConcatenation = () => at('id') || at('number') || at('string') || at('(') || at('$') || at('!') || at('getline');
  function expression(minimum = 0, output = false, initial = null) {
    return nested(() => {
      let left = initial || prefix();
      for (;;) {
        let op = token.kind;
        if (output && (op === '>' || op === '>>' || op === '|')) break;
        if (output && ['<', '<=', '==', '!=', '>='].includes(op)) fail('comparison in print or printf requires parentheses');
        if (!PRECEDENCE.has(op)) {
          if (!beginsConcatenation()) break;
          op = 'concat';
        }
        const precedence = PRECEDENCE.get(op);
        if (precedence < minimum) break;
        const operator = op === 'concat' ? token : take();
        if (op === '++' || op === '--') {
          requireLValue(left, op);
          left = node('update', left.loc, { op, argument: left, prefix: false });
          continue;
        }
        if (op === '?') {
          const consequent = expression(0, output);
          expect(':'); const alternate = expression(10, output);
          left = node('conditional', left.loc, { test: left, consequent, alternate });
          continue;
        }
        if (op === '|') {
          expect('getline');
          left = getline(left.loc, left);
          continue;
        }
        if (op === 'in') {
          const array = expect('id');
          if (BUILTINS.has(array.value)) fail('array membership requires an array name', array.loc);
          left = node('binary', left.loc, { op, left, right: node('variable', array.loc, { name: array.value }) });
          continue;
        }
        if (op === '&&' || op === '||') newlines();
        if (ASSIGNMENTS.has(op)) {
          requireLValue(left, op);
          const value = expression(precedence, output);
          left = node('assign', left.loc, { op, target: left, value });
          continue;
        }
        const right = expression(precedence + (op === '^' ? 0 : 1), output);
        if (left.type === 'tuple' || right.type === 'tuple') fail('expression list is only valid before in', operator.loc);
        left = node('binary', left.loc, { op, left, right });
      }
      if (left.type === 'tuple') fail('expression list is only valid before in', left.loc);
      return left;
    });
  }

  function parenthesizedTest() {
    expect('('); const test = expression(); expect(')'); newlines(); return test;
  }
  function block() {
    return nested(() => {
      const opening = expect('{'), body = [];
      separators();
      while (!at('}')) {
        if (at('eof')) fail('unterminated action block', opening.loc);
        const next = statement();
        if (next) body.push(next);
        separators();
      }
      expect('}');
      return node('block', opening.loc, { body });
    });
  }
  function simpleEnd() {
    if (at(';') || at('nl')) { take(); return; }
    if (at('}') || at('eof')) return;
    fail('expected a statement separator');
  }
  function outputStatement(kind, start) {
    const args = [];
    if (!terminator() && !at('>') && !at('>>') && !at('|')) {
      // Parentheses around print's complete argument list are statement syntax.
      // An ordinary grouped first argument can still participate in an expression.
      const opening = accept('(');
      if (opening) {
        if (at(')')) fail(`${kind} requires an argument inside parentheses`, start);
        for (const argument of argumentsList(')')) args.push(argument);
        if (args.length > 1 && at('in')) {
          const tuple = node('tuple', opening.loc, { items: args.slice() });
          args.length = 0; args.push(expression(0, true, tuple));
        } else if (args.length === 1) {
          grouped.add(args[0]); args[0] = expression(0, true, args[0]);
        }
      } else args.push(expression(0, true));
      while (accept(',')) { newlines(); args.push(expression(0, true)); }
    }
    if (kind === 'printf' && !args.length) fail('printf requires a format argument', start);
    let redirect = null;
    if (at('>') || at('>>') || at('|')) {
      const operator = take();
      redirect = node('redirect', operator.loc, { op: operator.kind, destination: expression(81) });
    }
    simpleEnd();
    return node(kind, start, { args, redirect });
  }
  function loopBody() {
    loopDepth++;
    try { return statement(); } finally { loopDepth--; }
  }
  function statement() {
    return nested(() => {
      const start = token.loc;
      if (at('{')) return block();
      if (accept(';')) return node('block', start, { body: [] });
      if (accept('if')) {
        const test = parenthesizedTest(), consequent = statement();
        newlines();
        const alternate = accept('else') ? (newlines(), statement()) : null;
        return node('if', start, { test, consequent, alternate });
      }
      if (accept('while')) {
        const test = parenthesizedTest(), body = loopBody();
        return node('while', start, { test, body });
      }
      if (accept('do')) {
        newlines(); const body = loopBody(); newlines(); expect('while');
        expect('('); const test = expression(); expect(')'); simpleEnd();
        return node('doWhile', start, { body, test });
      }
      if (accept('for')) {
        expect('(');
        let init = null, test = null, update = null;
        if (!at(';')) init = expression();
        if (at(')') && init?.type === 'binary' && init.op === 'in' && init.left.type === 'variable') {
          take(); newlines(); const body = loopBody();
          return node('forIn', start, { name: init.left.name, array: init.right.name, body });
        }
        expect(';'); newlines();
        if (!at(';')) test = expression();
        expect(';'); newlines();
        if (!at(')')) update = expression();
        expect(')'); newlines(); const body = loopBody();
        return node('for', start, { init, test, update, body });
      }
      if (at('break') || at('continue')) {
        const kind = take().kind;
        if (!loopDepth) fail(`${kind} is only valid inside a loop`, start);
        simpleEnd(); return node(kind, start);
      }
      if (accept('next')) {
        if (!functionDepth && (ruleContext === 'begin' || ruleContext === 'end')) fail('next is not valid in BEGIN or END', start);
        simpleEnd(); return node('next', start);
      }
      if (at('return') || at('exit')) {
        const kind = take().kind;
        if (kind === 'return' && !functionDepth) fail('return is only valid inside a function', start);
        const argument = terminator() ? null : expression();
        simpleEnd(); return node(kind, start, { argument });
      }
      if (accept('delete')) {
        if (!at('id')) fail('delete requires an array name', start);
        const target = namedValue();
        if (target.type !== 'array' && target.type !== 'variable') fail('delete requires an array or array element', start);
        simpleEnd(); return node('delete', start, { target });
      }
      if (at('print') || at('printf')) return outputStatement(take().kind, start);
      const value = expression();
      simpleEnd(); return node('expression', start, { expression: value });
    });
  }

  function declaration() {
    const start = expect('function').loc, name = expect('id');
    if (BUILTINS.has(name.value) || SPECIALS.has(name.value)) fail(`invalid function name ${name.value}`, name.loc);
    if (declared.has(name.value)) fail(`duplicate function ${name.value}`, name.loc);
    expect('(');
    const params = [], parameterNames = new Set();
    if (!at(')')) {
      for (;;) {
        const parameter = expect('id');
        if (BUILTINS.has(parameter.value) || SPECIALS.has(parameter.value) || parameter.value === name.value) fail(`invalid function parameter ${parameter.value}`, parameter.loc);
        if (parameterNames.has(parameter.value)) fail(`duplicate function parameter ${parameter.value}`, parameter.loc);
        params.push(parameter.value); parameterNames.add(parameter.value);
        if (!accept(',')) break;
        newlines();
      }
    }
    expect(')'); newlines();
    const priorLoop = loopDepth, priorContext = ruleContext;
    loopDepth = 0; functionDepth++; ruleContext = null;
    let body;
    try { body = block(); } finally { loopDepth = priorLoop; functionDepth--; ruleContext = priorContext; }
    const result = node('function', start, { name: name.value, params, body });
    declared.set(name.value, result); functions.push(result);
  }

  token = lex();
  separators();
  while (!at('eof')) {
    if (at('function')) { declaration(); separators(); continue; }
    const start = token.loc;
    let pattern = null, action = null;
    if (at('BEGIN') || at('END')) {
      const kind = take().kind.toLowerCase();
      pattern = node(kind, start); newlines();
      if (!at('{')) fail(`${kind.toUpperCase()} requires an action block`, start);
    } else if (!at('{')) {
      pattern = expression();
      if (accept(',')) {
        newlines(); const end = expression();
        pattern = node('range', start, { start: pattern, end });
      }
    }
    if (at('{')) {
      const previous = ruleContext;
      ruleContext = pattern?.type || null;
      try { action = block(); } finally { ruleContext = previous; }
    } else if (!terminator()) fail('expected an action block or rule separator');
    rules.push(node('rule', start, { pattern, action }));
    separators();
  }
  const program = node('program', { offset: 0, line: 1, column: 1 }, { functions, rules });
  // Function names cannot simultaneously name variables or parameters. Walk
  // iteratively so this final validation never adds unbounded host recursion.
  const pending = [program];
  while (pending.length) {
    const current = pending.pop();
    if ((current.type === 'variable' || current.type === 'array') && declared.has(current.name)) fail(`function ${current.name} cannot be used as a variable`, current.loc);
    if (current.type === 'forIn' && (declared.has(current.name) || declared.has(current.array))) fail('a function name cannot be used in an array loop', current.loc);
    if (current.type === 'function') for (const param of current.params) if (declared.has(param)) fail(`function ${param} cannot be used as a parameter`, current.loc);
    for (const [key, value] of Object.entries(current)) {
      if (key === 'loc') continue;
      if (Array.isArray(value)) { for (const child of value) if (child && typeof child === 'object') pending.push(child); }
      else if (value && typeof value === 'object') pending.push(value);
    }
  }
  return program;
}
