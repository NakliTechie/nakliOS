import { LanguageError, splitWord } from './language-parser.mjs';
import { arithmetic } from './language-arithmetic.mjs';
import { parsePattern, matchesPattern } from './language-pattern.mjs';
import { IOFailure } from './io.mjs';

const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
const empty = () => ({ text: '', quoted: [], splitting: [], forced: false, emptyAt: new Set() });
const append = (field, text, quoted, splitting) => {
  if (quoted && !text) field.emptyAt.add(field.text.length);
  field.text += text;
  for (let i = 0; i < text.length; i++) { field.quoted.push(quoted); field.splitting.push(splitting); }
  field.forced ||= quoted;
};
const slice = (field, start, end) => ({ text: field.text.slice(start, end), quoted: field.quoted.slice(start, end), splitting: field.splitting.slice(start, end), forced: field.forced,
  emptyAt: new Set([...field.emptyAt].filter((at) => at >= start && at <= end).map((at) => at - start)) });
const globText = (field) => field.text.split('').map((char, i) => field.quoted[i] && /[\\*?\[\]]/.test(char) ? '\\' + char : char).join('');
function splitFields(field, ifs) {
  if (!ifs) return field.text || field.forced ? [field] : [];
  const separators = new Set(ifs), whitespace = (c) => /[ \t\n]/.test(c);
  const separator = (at) => at < field.text.length && field.splitting[at] && separators.has(field.text[at]);
  const out = [], markers = new Set(field.emptyAt); let current = empty(), at = 0;
  const mark = () => { if (markers.delete(at)) current.forced = true; };
  while (at < field.text.length) {
    mark();
    if (!separator(at)) {
      append(current, field.text[at], field.quoted[at], false); at++; continue;
    }
    let nonspace = !whitespace(field.text[at]);
    if (!nonspace) {
      do { at++; } while (!markers.has(at) && separator(at) && whitespace(field.text[at]));
      if (!markers.has(at) && separator(at) && !whitespace(field.text[at])) { nonspace = true; at++; }
    } else at++;
    while (!markers.has(at) && separator(at) && whitespace(field.text[at])) at++;
    if (current.text || current.forced || nonspace) out.push(current);
    current = empty();
  }
  mark(); if (current.text || current.forced) out.push(current);
  return out;
}

export function createWordExpander(ctx) {
  const ifs = () => ctx.get('IFS') ?? ' \t\n';
  const joiner = () => ifs()[0] ?? '';
  const parameter = (name) => name === '@' || name === '*' ? [...ctx.positionals()]
    : name === '#' ? String(ctx.positionals().length) : name === '?' ? String(ctx.lastCode())
      : name === '0' ? 'sh' : /^[0-9]+$/.test(name) ? ctx.positionals()[Number(name) - 1] : ctx.get(name);
  const arithmeticContext = { limits: ctx.limits, spend: ctx.spend, tick: ctx.tick, argument: ctx.argument, get: ctx.get, set: ctx.set };
  const math = (text) => arithmetic(text, arithmeticContext);
  const compilePattern = (pattern) => {
    ctx.argument(pattern);
    return parsePattern(pattern, ctx.spend);
  };
  const matches = (pattern, value) => matchesPattern(pattern, value, ctx.spend);
  async function removePattern(value, pattern, operator) {
    value = [...value];
    const prefix = operator[0] === '#', longest = operator.length === 2;
    for (let n = longest ? value.length : 0; longest ? n >= 0 : n <= value.length; longest ? n-- : n++) {
      await ctx.tick();
      if (matches(pattern, (prefix ? value.slice(0, n) : value.slice(value.length - n)).join(''))) return (prefix ? value.slice(n) : value.slice(0, value.length - n)).join('');
    }
    return value.join('');
  }
  async function replacePattern(value, pattern, replacement, operator) {
    if (!pattern.length) return operator === '/#' ? replacement + value : operator === '/%' ? value + replacement : value;
    value = [...value];
    let output = '', cursor = 0;
    while (cursor <= value.length) {
      let found = null;
      for (let begin = cursor; begin <= value.length && !found; begin++) {
        await ctx.tick();
        if (operator === '/#' && begin !== 0) break;
        for (let end = value.length; end >= begin; end--) {
          ctx.spend();
          if (operator === '/%' && end !== value.length) continue;
          if (matches(pattern, value.slice(begin, end).join(''))) { found = { begin, end }; break; }
        }
      }
      if (!found) { output += value.slice(cursor).join(''); break; }
      output += value.slice(cursor, found.begin).join('') + replacement;
      if (operator !== '//') { output += value.slice(found.end).join(''); break; }
      cursor = found.end;
      if (cursor === value.length) break;
      if (found.begin === found.end) {
        if (cursor === value.length) break;
        output += value[cursor++];
      }
      ctx.argument(output);
    }
    return output;
  }
  async function param(part) {
    let value = parameter(part.name);
    const array = Array.isArray(value), absent = value === undefined || array && value.length === 0;
    const text = array ? value.join(joiner()) : value ?? '';
    const op = part.operator;
    if (!op) return value ?? '';
    if (op === 'length') return String(array ? value.length : [...text].length);
    if (/^:?[=+?\-]$/.test(op)) {
      const missing = absent || op.startsWith(':') && text === '', action = op.at(-1);
      if (action === '+') return missing ? '' : scalar(part.word);
      if (!missing) return value;
      const replacement = await scalar(part.word);
      if (action === '?') throw new LanguageError(`${part.name}: ${replacement || 'parameter is unset or empty'}`);
      if (action === '=') {
        if (!identifier.test(part.name)) throw new LanguageError('cannot assign a special or positional parameter');
        ctx.set(part.name, replacement);
      }
      return replacement;
    }
    if (op === ':') {
      const [offsetWord, lengthWord] = splitWord(part.word, ':');
      const offset = await math(await scalar(offsetWord)), length = lengthWord ? await math(await scalar(lengthWord)) : null;
      const values = array ? ['sh', ...value] : [...text];
      const start = offset < 0n ? BigInt(values.length) + offset : offset;
      if (array && length !== null && length < 0n) throw new LanguageError('positional substring length must be nonnegative');
      const end = length === null ? BigInt(values.length) : length < 0n ? BigInt(values.length) + length : start + length;
      if (end < start) throw new LanguageError('substring length ends before its offset');
      if (start < 0n || start >= BigInt(values.length)) return array ? [] : '';
      const clippedEnd = end > BigInt(values.length) ? values.length : Number(end);
      const selected = values.slice(Number(start), clippedEnd);
      return array ? selected : selected.join('');
    }
    if (['#', '##', '%', '%%'].includes(op)) {
      const pattern = compilePattern(await patternWord(part.word));
      if (array) { const values = []; for (const item of value) values.push(await removePattern(item, pattern, op)); return values; }
      return removePattern(text, pattern, op);
    }
    if (['/', '//', '/#', '/%'].includes(op)) {
      const [patternSource, replacementSource] = splitWord(part.word, '/');
      const pattern = compilePattern(await patternWord(patternSource)), replacement = replacementSource ? await scalar(replacementSource) : '';
      if (array) { const values = []; for (const item of value) values.push(await replacePattern(item, pattern, replacement, op)); return values; }
      return replacePattern(text, pattern, replacement, op);
    }
    throw new LanguageError(`unsupported parameter operator '${op}'`);
  }
  async function fragments(word) {
    const fields = [empty()];
    for (let index = 0; index < word.parts.length; index++) {
      await ctx.tick();
      const part = word.parts[index]; let value;
      if (part.kind === 'literal') {
        value = part.text;
        if (index === 0 && !part.quoted && /^~(?:\/|$)/.test(value)) value = (ctx.get('HOME') ?? '/') + value.slice(1);
        ctx.argument(value); append(fields.at(-1), value, part.quoted, false); continue;
      }
      if (part.kind === 'parameter') value = await param(part);
      else if (part.kind === 'arithmetic') value = String(await math(await scalar(part.word)));
      else if (part.kind === 'substitution') value = await ctx.substitute(part.body);
      else throw new LanguageError('unknown word part');
      if (part.kind === 'parameter' && part.name === '*' && Array.isArray(value)) value = value.join(joiner());
      const values = Array.isArray(value) ? value : [String(value ?? '')];
      for (let i = 0; i < values.length; i++) {
        if (i) fields.push(empty());
        ctx.argument(values[i]); append(fields.at(-1), values[i], !!part.quoted, !part.quoted);
      }
    }
    return fields;
  }
  async function scalar(word) {
    const fields = await fragments(word);
    return fields.map((field) => field.text).join(joiner());
  }
  async function patternWord(word) {
    const fields = await fragments(word);
    return fields.map(globText).join(joiner());
  }
  async function pathname(field) {
    const active = field.text.split('').some((char, at) => !field.quoted[at] && '*?['.includes(char));
    if (!active) return [field.text];
    const absolute = field.text.startsWith('/'), trailing = field.text.endsWith('/');
    const segments = []; let at = 0;
    for (const text of field.text.split('/')) { segments.push(slice(field, at, at + text.length)); at += text.length + 1; }
    let candidates = [{ path: absolute ? '' : ctx.cwd(), display: absolute ? '/' : '' }];
    for (let index = absolute ? 1 : 0; index < segments.length; index++) {
      const segment = segments[index], final = index === segments.length - 1;
      if (!segment.text) continue;
      const wildcard = segment.text.split('').some((char, i) => !segment.quoted[i] && '*?['.includes(char));
      const next = [];
      for (const candidate of candidates) {
        await ctx.tick();
        if (!wildcard) {
          const path = ctx.io.resolve('/' + candidate.path + '/' + segment.text);
          const display = candidate.display + segment.text + (final && !trailing ? '' : '/');
          if (!final && !trailing) { next.push({ path, display }); continue; }
          try {
            const stat = await ctx.io.stat('/' + path, { metadataOnly: true, rejectSymlinks: true });
            if (!trailing || stat.type === 'dir') next.push({ path, display });
          } catch (error) { if (!(error instanceof IOFailure && ['ENOENT', 'ENOTDIR'].includes(error.code))) throw error; }
          continue;
        }
        const pattern = compilePattern(globText(segment)); let entries;
        try { entries = await ctx.io.list('/' + candidate.path, { metadataOnly: true, rejectSymlinks: true }); }
        catch (error) { if (error instanceof IOFailure && ['ENOENT', 'ENOTDIR'].includes(error.code)) continue; throw error; }
        if (entries.length > ctx.limits.maxTokens) throw new LanguageError('glob entry count exceeds its limit');
        for (const entry of entries) {
          await ctx.tick();
          if (entry.name.startsWith('.') && !segment.text.startsWith('.')) continue;
          if ((!final || trailing) && entry.type !== 'dir') continue;
          if (matches(pattern, entry.name)) next.push({ path: entry.path,
            display: candidate.display + entry.name + (final && !trailing ? '' : '/') });
        }
      }
      if (next.length > ctx.limits.maxTokens) throw new LanguageError('glob result count exceeds its limit');
      candidates = next;
      if (!candidates.length) break;
    }
    const results = candidates.map((item) => item.display).sort();
    for (const text of results) ctx.argument(text);
    return results.length ? results : [field.text];
  }
  async function expand(word, { split = true, glob = true } = {}) {
    let fields = await fragments(word);
    if (!split) return [fields.map((field) => field.text).join(joiner())];
    fields = fields.flatMap((field) => splitFields(field, ifs()));
    const result = [];
    for (const field of fields) result.push(...(glob ? await pathname(field) : [field.text]));
    return result;
  }
  return { expand, scalar, pattern: patternWord, math, compilePattern, matches };
}
