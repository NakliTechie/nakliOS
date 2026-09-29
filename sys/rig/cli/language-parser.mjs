// One bounded grammar for execution and static permission inspection.
// Words retain quote metadata; shell operators never travel inside marker strings.
import { utf8Length } from './cmds/u2-common.mjs';

export const LANGUAGE_LIMITS = Object.freeze({ maxSourceBytes: 262144, maxTokens: 32768, maxDepth: 64,
  maxLoopIterations: 10000, maxFunctionDepth: 64, maxSteps: 1000000, yieldEvery: 64,
  maxArgumentBytes: 262144, maxOutputBytes: 16777216 });
export class LanguageError extends Error {
  constructor(message) { super(`shell: ${message}`); this.code = 2; }
}
export function languageLimits(overrides = {}) {
  const limits = { ...LANGUAGE_LIMITS, ...overrides };
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(LANGUAGE_LIMITS, key) || !Number.isSafeInteger(value) || value < 0
      || ['maxDepth', 'maxFunctionDepth', 'yieldEvery'].includes(key) && value === 0) throw new LanguageError(`invalid ${key} limit`);
  }
  return limits;
}
export function staticWord(word) {
  return word?.parts?.every((part) => part.kind === 'literal') ? word.parts.map((part) => part.text).join('') : null;
}
export function plainWord(word) {
  return word?.parts?.every((part) => part.kind === 'literal' && !part.quoted) ? staticWord(word) : null;
}
const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const reserved = new Set(['if', 'then', 'elif', 'else', 'fi', 'for', 'in', 'do', 'done', 'while', 'until', 'case', 'esac', 'function', '{', '}']);
const literal = (text, quoted = false) => ({ kind: 'literal', text, quoted });
function syntax(message, at) { throw new LanguageError(`${message} at character ${at + 1}`); }
function enter(shared, operation) {
  if (++shared.depth > shared.limits.maxDepth) throw new LanguageError('parser nesting exceeds its limit');
  try { return operation(); } finally { shared.depth--; }
}
function charge(shared) {
  if (++shared.tokens > shared.limits.maxTokens) throw new LanguageError('parser token count exceeds its limit');
}

class Lexer {
  constructor(source, shared, at = 0) { this.source = source; this.shared = shared; this.at = at; this.buffer = []; this.heredocs = []; }
  peek(n = 0) { while (this.buffer.length <= n) this.buffer.push(this.next()); return this.buffer[n]; }
  take() { return this.buffer.length ? this.buffer.shift() : this.next(); }
  op(value) { return this.peek().type === 'op' && this.peek().value === value; }
  keyword(value) { return this.peek().type === 'word' && plainWord(this.peek()) === value; }
  needOp(value) { if (!this.op(value)) syntax(`expected '${value}'`, this.peek().at); return this.take(); }
  needWord() { if (this.peek().type !== 'word') syntax('expected a word', this.peek().at); return this.take(); }
  needKeyword(value) { if (!this.keyword(value)) syntax(`expected '${value}'`, this.peek().at); return this.take(); }
  newlineBodies() {
    for (const doc of this.heredocs) {
      const chunks = []; let found = false;
      while (this.at < this.source.length) {
        const end = this.source.indexOf('\n', this.at), stop = end < 0 ? this.source.length : end;
        let line = this.source.slice(this.at, stop); this.at = end < 0 ? stop : stop + 1;
        if (doc.strip) line = line.replace(/^\t+/, '');
        if (line === doc.delimiter) { found = true; break; }
        chunks.push(line + (end < 0 ? '' : '\n'));
      }
      if (!found) syntax(`heredoc has no terminator '${doc.delimiter}'`, this.at);
      doc.body = chunks.join('');
      if (!doc.quoted && /[$`]/.test(doc.body)) syntax('heredoc expansion is unavailable; quote its delimiter for a literal body', this.at);
    }
    this.heredocs = [];
  }
  next() {
    const s = this.source;
    while (this.at < s.length) {
      if (s[this.at] === ' ' || s[this.at] === '\t') { this.at++; continue; }
      if (s.startsWith('\\\n', this.at)) { this.at += 2; continue; }
      if (s[this.at] === '#') { while (this.at < s.length && s[this.at] !== '\n') this.at++; continue; }
      break;
    }
    const at = this.at;
    if (at >= s.length) {
      if (this.heredocs.length) syntax('heredoc requires a newline and terminator', at);
      return { type: 'eof', at };
    }
    charge(this.shared);
    if (s[at] === '\n') { this.at++; this.newlineBodies(); return { type: 'op', value: '\n', at }; }
    if (s.startsWith('((', at)) {
      this.at += 2;
      return { type: 'arithmetic', word: this.arithmetic(), at };
    }
    const redirection = /^(?:([0-9]+))?(<<-|<<<|<<|>>|>&|<&|<>|>|<)|^(&>>|&>)/.exec(s.slice(at));
    if (redirection) {
      const op = redirection[2] || redirection[3], number = redirection[1];
      if (number && !/^[012]$/.test(number)) syntax('only descriptors 0, 1 and 2 are available', at);
      if (['<<<', '<>'].includes(op)) syntax(`unsupported redirection '${op}'`, at);
      this.at += redirection[0].length;
      return { type: 'redirect', op, fd: number === undefined ? op.startsWith('<') ? 0 : 1 : Number(number), at };
    }
    for (const value of ['&&', '||', ';;', ';&', '|&', ';', '|', '&', '(', ')']) {
      if (s.startsWith(value, at)) {
        if (['&', ';&', '|&'].includes(value)) syntax(value === '&' ? 'background jobs are unavailable' : `unsupported operator '${value}'`, at);
        this.at += value.length; return { type: 'op', value, at };
      }
    }
    return { type: 'word', parts: this.parts('word'), at };
  }
  add(parts, part) {
    const prior = parts.at(-1);
    if (part.kind === 'literal' && prior?.kind === 'literal' && part.quoted === prior.quoted) prior.text += part.text;
    else { charge(this.shared); parts.push(part); }
  }
  parameter(quoted) {
    return enter(this.shared, () => {
      const start = this.at; this.at += 2;
      let length = false;
      if (this.source[this.at] === '#' && this.source[this.at + 1] !== '}') { length = true; this.at++; }
      const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[@*?#])/.exec(this.source.slice(this.at));
      if (!match) syntax('invalid parameter expansion', start);
      const name = match[0]; this.at += name.length;
      if (this.source[this.at] === '}') { this.at++; return { kind: 'parameter', name, operator: length ? 'length' : '', quoted }; }
      if (length) syntax('length expansion cannot have another operator', this.at);
      let operator = '';
      for (const op of [':-', ':=', ':+', ':?', '##', '%%', '//', '/#', '/%', '-', '=', '+', '?', '#', '%', '/', ':']) {
        if (this.source.startsWith(op, this.at)) { operator = op; this.at += op.length; break; }
      }
      if (!operator) syntax('unsupported parameter operator', this.at);
      const word = { type: 'word', parts: this.parts('parameter'), at: this.at };
      if (this.source[this.at] !== '}') syntax('unclosed parameter expansion', start);
      this.at++;
      return { kind: 'parameter', name, operator, word, quoted };
    });
  }
  substitution(quoted) {
    return enter(this.shared, () => {
      const start = this.at; this.at += 2;
      const inner = new Lexer(this.source, this.shared, this.at), parser = new Parser(inner);
      const body = parser.list(new Set(), new Set([')']));
      inner.needOp(')'); this.at = inner.at;
      return { kind: 'substitution', body, quoted, at: start };
    });
  }
  backtick(quoted) {
    return enter(this.shared, () => {
      const start = this.at++; let source = '', closed = false;
      while (this.at < this.source.length) {
        const c = this.source[this.at++];
        if (c === '`') { closed = true; break; }
        if (c === '\\' && /[$`\\]/.test(this.source[this.at] || '\0')) source += this.source[this.at++];
        else source += c;
      }
      if (!closed) syntax('unclosed backtick substitution', start);
      const inner = new Lexer(source, this.shared), parser = new Parser(inner), body = parser.list();
      if (inner.peek().type !== 'eof') syntax('unexpected substitution suffix', inner.peek().at);
      return { kind: 'substitution', body, quoted, at: start };
    });
  }
  arithmetic() {
    return enter(this.shared, () => {
      const at = this.at, parts = this.parts('arithmetic');
      if (!this.source.startsWith('))', this.at)) syntax('unclosed arithmetic expression', at);
      this.at += 2; return { type: 'word', parts, at };
    });
  }
  parts(mode) {
    const parts = [], s = this.source; let quote = null, opened = this.at, parentheses = 0, doubleContent = false;
    while (this.at < s.length) {
      const c = s[this.at];
      if (quote === "'") {
        this.at++;
        if (c === "'") quote = null; else this.add(parts, literal(c, true));
        continue;
      }
      if (quote === '"' && c !== '"' && !(c === '\\' && s[this.at + 1] === '\n')) doubleContent = true;
      if (!quote) {
        if (mode === 'word' && /[ \t\n;|&<>()]/.test(c)) break;
        if (mode === 'parameter' && c === '}') break;
        if (mode === 'arithmetic') {
          if (c === ')' && parentheses === 0 && s[this.at + 1] === ')') break;
          if (c === '(' && ++parentheses > this.shared.limits.maxDepth) syntax('arithmetic nesting exceeds its limit', this.at);
          if (c === ')' && --parentheses < 0) syntax('unexpected arithmetic parenthesis', this.at);
        }
      }
      if (c === '\\') {
        const next = s[this.at + 1];
        if (next === undefined) syntax('trailing backslash', this.at);
        if (!quote || /[$`"\\\n]/.test(next)) {
          this.at += 2; if (next !== '\n') this.add(parts, literal(next, true)); continue;
        }
      }
      if (c === '"') {
        if (quote === '"') { if (!doubleContent) this.add(parts, literal('', true)); quote = null; this.at++; continue; }
        if (!quote) { quote = '"'; opened = this.at++; doubleContent = false; continue; }
      }
      if (c === "'" && !quote) { quote = "'"; opened = this.at++; this.add(parts, literal('', true)); continue; }
      const quoted = quote === '"';
      if (c === '`') { this.add(parts, this.backtick(quoted)); continue; }
      if (c === '$') {
        if (s.startsWith('$((', this.at)) { this.at += 3; this.add(parts, { kind: 'arithmetic', word: this.arithmetic(), quoted }); continue; }
        if (s.startsWith('$(', this.at)) { this.add(parts, this.substitution(quoted)); continue; }
        if (s.startsWith('${', this.at)) { this.add(parts, this.parameter(quoted)); continue; }
        const match = /^(?:[A-Za-z_][A-Za-z0-9_]*|[0-9@*?#])/.exec(s.slice(this.at + 1));
        if (match) { this.at += match[0].length + 1; this.add(parts, { kind: 'parameter', name: match[0], operator: '', quoted }); continue; }
        if (['!', '$', '-'].includes(s[this.at + 1])) syntax('host process and shell-option parameters are unavailable', this.at);
        if (s[this.at + 1] === "'") syntax('ANSI-C shell quoting is unavailable; use printf escapes', this.at);
        if (s[this.at + 1] === '"' && !quoted) syntax('locale translation quoting is unavailable', this.at);
      }
      this.add(parts, literal(c, quoted)); this.at++;
    }
    if (quote) syntax('unclosed quote', opened);
    if (mode === 'word' && !parts.length) syntax('expected a shell word', this.at);
    return parts;
  }
}

class Parser {
  constructor(lexer) { this.lex = lexer; }
  newline() { while (this.lex.op('\n')) this.lex.take(); }
  stopped(words, operators) { return this.lex.peek().type === 'eof' || words.has(plainWord(this.lex.peek())) || this.lex.peek().type === 'op' && operators.has(this.lex.peek().value); }
  list(words = new Set(), operators = new Set()) {
    const items = []; this.newline();
    while (!this.stopped(words, operators)) {
      items.push(this.andOr());
      if (this.lex.op(';') || this.lex.op('\n')) { this.lex.take(); this.newline(); }
      else if (!this.stopped(words, operators)) syntax('expected a command separator', this.lex.peek().at);
    }
    return { kind: 'list', items };
  }
  andOr() {
    const first = this.pipeline(), rest = [];
    while (this.lex.op('&&') || this.lex.op('||')) {
      const operator = this.lex.take().value; this.newline(); rest.push({ operator, node: this.pipeline() });
    }
    return { kind: 'andor', first, rest };
  }
  pipeline() {
    let negate = false;
    if (this.lex.keyword('!')) { this.lex.take(); negate = true; }
    const commands = [this.command()];
    while (this.lex.op('|')) { this.lex.take(); this.newline(); commands.push(this.command()); }
    return { kind: 'pipeline', commands, negate };
  }
  redirects(node) {
    node.redirects ??= [];
    while (this.lex.peek().type === 'redirect') {
      const redirect = this.lex.take(), target = this.lex.needWord();
      const { op, fd } = redirect;
      if (op.startsWith('<') && fd !== 0 || !op.startsWith('<') && fd === 0) syntax('descriptor direction is unsupported', redirect.at);
      const item = { op, fd, target };
      if (op === '<<' || op === '<<-') {
        const delimiter = staticWord(target);
        if (delimiter === null) syntax('heredoc delimiter must be a literal word', target.at);
        Object.assign(item, { delimiter, quoted: target.parts.some((part) => part.quoted), strip: op === '<<-' });
        this.lex.heredocs.push(item);
      }
      node.redirects.push(item);
    }
    return node;
  }
  command() {
    return enter(this.lex.shared, () => {
      const lex = this.lex; let node;
      if (lex.keyword('if')) node = this.ifCommand();
      else if (lex.keyword('for')) node = this.forCommand();
      else if (lex.keyword('while') || lex.keyword('until')) {
        const kind = plainWord(lex.take()), condition = this.list(new Set(['do']));
        if (!condition.items.length) syntax('empty loop condition', lex.peek().at);
        lex.needKeyword('do'); const body = this.list(new Set(['done'])); this.nonempty(body); lex.needKeyword('done');
        node = { kind, condition, body };
      } else if (lex.keyword('case')) node = this.caseCommand();
      else if (lex.keyword('{')) {
        lex.take(); const body = this.list(new Set(['}'])); this.nonempty(body); lex.needKeyword('}'); node = { kind: 'group', body };
      } else if (lex.op('(')) {
        lex.take(); const body = this.list(new Set(), new Set([')'])); this.nonempty(body); lex.needOp(')'); node = { kind: 'subshell', body };
      } else if (lex.peek().type === 'arithmetic') node = { kind: 'arithmetic', word: lex.take().word };
      else if (lex.keyword('function')) {
        lex.take(); const name = plainWord(lex.needWord());
        if (!identifier.test(name || '')) syntax('invalid function name', lex.peek().at);
        if (lex.op('(')) { lex.take(); lex.needOp(')'); }
        this.newline(); node = { kind: 'function', name, body: this.functionBody() };
      } else if (lex.peek().type === 'word' && identifier.test(plainWord(lex.peek()) || '')
        && lex.peek(1).type === 'op' && lex.peek(1).value === '(') {
        const name = plainWord(lex.take()); lex.needOp('('); lex.needOp(')'); this.newline();
        node = { kind: 'function', name, body: this.functionBody() };
      } else {
        node = { kind: 'simple', words: [], redirects: [] };
        while (lex.peek().type === 'word' || lex.peek().type === 'redirect') {
          if (lex.peek().type === 'redirect') this.redirects(node);
          else {
            if (!node.words.length && reserved.has(plainWord(lex.peek()))) syntax('unexpected reserved word', lex.peek().at);
            node.words.push(lex.take());
          }
        }
        if (!node.words.length && !node.redirects.length) syntax('expected a command', lex.peek().at);
      }
      return this.redirects(node);
    });
  }
  functionBody() {
    if (!(this.lex.keyword('{') || this.lex.op('('))) syntax('function body must be a group or subshell', this.lex.peek().at);
    return this.command();
  }
  nonempty(body) { if (!body.items.length) syntax('empty compound command', this.lex.peek().at); }
  ifCommand() {
    const branches = []; this.lex.needKeyword('if');
    while (true) {
      const condition = this.list(new Set(['then']));
      if (!condition.items.length) syntax('empty if condition', this.lex.peek().at);
      this.lex.needKeyword('then'); const body = this.list(new Set(['elif', 'else', 'fi']));
      this.nonempty(body);
      branches.push({ condition, body });
      if (!this.lex.keyword('elif')) break;
      this.lex.take();
    }
    let otherwise = null;
    if (this.lex.keyword('else')) { this.lex.take(); otherwise = this.list(new Set(['fi'])); this.nonempty(otherwise); }
    this.lex.needKeyword('fi'); return { kind: 'if', branches, otherwise };
  }
  forCommand() {
    const lex = this.lex; lex.needKeyword('for'); const name = plainWord(lex.needWord());
    if (!identifier.test(name || '')) syntax('invalid for variable', lex.peek().at);
    let words = null; const initialNewline = lex.op('\n'); this.newline();
    if (lex.keyword('in')) {
      lex.take(); words = [];
      while (lex.peek().type === 'word') words.push(lex.take());
    }
    if (lex.op(';') || lex.op('\n')) { lex.take(); this.newline(); }
    else if (words !== null || !initialNewline) syntax('for list needs a separator before do', lex.peek().at);
    lex.needKeyword('do'); const body = this.list(new Set(['done'])); this.nonempty(body); lex.needKeyword('done');
    return { kind: 'for', name, words, body };
  }
  caseCommand() {
    const lex = this.lex; lex.needKeyword('case'); const word = lex.needWord(); this.newline(); lex.needKeyword('in'); this.newline();
    const cases = [];
    while (!lex.keyword('esac')) {
      if (lex.peek().type === 'eof') syntax('unclosed case', lex.peek().at);
      if (lex.op('(')) lex.take();
      const patterns = [lex.needWord()];
      while (lex.op('|')) { lex.take(); patterns.push(lex.needWord()); }
      lex.needOp(')'); const body = this.list(new Set(['esac']), new Set([';;'])); cases.push({ patterns, body });
      if (lex.op(';;')) { lex.take(); this.newline(); }
      else break;
    }
    lex.needKeyword('esac'); return { kind: 'case', word, cases };
  }
}

export function parseShell(source, overrides = {}) {
  source = String(source ?? ''); const limits = languageLimits(overrides);
  try { utf8Length(source, limits.maxSourceBytes); } catch (_) { throw new LanguageError('source bytes exceed their limit'); }
  if (source.includes('\0')) throw new LanguageError('NUL is unavailable in shell source');
  const shared = { limits, depth: 0, tokens: 0 }, lexer = new Lexer(source, shared), parser = new Parser(lexer);
  const body = parser.list();
  if (lexer.peek().type !== 'eof') syntax('unexpected token', lexer.peek().at);
  return body;
}

// Split only an unquoted literal delimiter, preserving nested expansion trees.
export function splitWord(word, separator, { last = false } = {}) {
  let selected = null;
  for (let p = 0; p < word.parts.length; p++) {
    const part = word.parts[p]; if (part.kind !== 'literal' || part.quoted) continue;
    const at = last ? part.text.lastIndexOf(separator) : part.text.indexOf(separator);
    if (at >= 0) { selected = { p, at }; if (!last) break; }
  }
  if (!selected) return [word, null];
  const { p, at } = selected, part = word.parts[p];
  return [
    { ...word, parts: [...word.parts.slice(0, p), { ...part, text: part.text.slice(0, at) }] },
    { ...word, parts: [{ ...part, text: part.text.slice(at + separator.length) }, ...word.parts.slice(p + 1)] },
  ];
}
export function assignmentWord(word) {
  const first = word.parts[0];
  if (first?.kind !== 'literal' || first.quoted) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(first.text);
  return match ? { name: match[1], word: { ...word, parts: [{ ...first, text: first.text.slice(match[0].length) }, ...word.parts.slice(1)] } } : null;
}
