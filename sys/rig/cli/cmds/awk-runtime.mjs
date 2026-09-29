import { ArgError } from '../args.mjs';
import { IOFailure, autoData, toBytes, concatData } from '../io.mjs';
import { ShellInterrupted } from '../execution.mjs';
import { parseRegex, findRegex } from './awk-regex.mjs';
import { formatAwk } from './awk-format.mjs';

const fail = (message) => { throw new ArgError(`awk: ${message}`); };
// Count UTF-8 before encoding a string or constructing a binary string.
// Return early on overflow so oversized stdin never needs another full copy.
export function awkByteLength(data, ceiling = Infinity) {
  if (typeof data !== 'string') return data instanceof Uint8Array || data instanceof ArrayBuffer ? data.byteLength : toBytes(data).length;
  if (data.length > ceiling) return ceiling + 1;
  let length = 0;
  for (let at = 0; at < data.length; at++) {
    const code = data.charCodeAt(at);
    if (code < 128) length++;
    else if (code < 2048) length += 2;
    else if (code >= 0xd800 && code <= 0xdbff && data.charCodeAt(at + 1) >= 0xdc00 && data.charCodeAt(at + 1) <= 0xdfff) { length += 4; at++; }
    else length += 3;
    if (length > ceiling) return length;
  }
  return length;
}
export function awkBinary(data) {
  const bytes = toBytes(data), parts = [];
  for (let at = 0; at < bytes.length; at += 8192) parts.push(String.fromCharCode(...bytes.subarray(at, at + 8192)));
  return parts.join('');
}
const bytes = (text) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const scalar = (kind, value) => kind === 'number' ? { kind, number: value } : { kind, string: value };
const num = (value) => scalar('number', value);
const str = (value) => scalar('string', value);
const empty = () => ({ kind: 'unset', string: '', number: 0 });
const numericPattern = /^[\t\n\v\f\r ]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[\t\n\v\f\r ]*$/;
const inputValue = (value) => numericPattern.test(value) ? { kind: 'strnum', string: value, number: Number(value) } : str(value);
const number = (value = empty()) => {
  if (value.number !== undefined) return value.number;
  const match = /^[\t\n\v\f\r ]*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(value.string);
  return match ? Number(match[1]) : 0;
};
const numeric = (value = empty()) => value.kind !== 'string';
const truth = (value) => numeric(value) ? number(value) !== 0 : value.string.length !== 0;
const cell = () => ({ mode: null, value: empty(), entries: null });
const isLvalue = (node) => node && ['variable', 'array', 'field'].includes(node.type);
export function decodeAwkArgument(value) {
  let result = '';
  const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', '/': '/' };
  for (let at = 0; at < value.length; at++) {
    if (value[at] !== '\\') { result += value[at]; continue; }
    const c = value[++at];
    if (c == null) fail('trailing backslash in assignment');
    if (/[0-7]/.test(c)) { const rest = /^[0-7]{0,2}/.exec(value.slice(at + 1))[0]; at += rest.length; result += String.fromCharCode(parseInt(c + rest, 8) & 255); }
    else if (Object.hasOwn(escapes, c)) result += escapes[c];
    else fail(`unsupported escape \\${c} in assignment`);
  }
  return result;
}
const builtins = new Map([
  ['atan2', [2, 2]], ['cos', [1, 1]], ['sin', [1, 1]], ['exp', [1, 1]], ['log', [1, 1]], ['sqrt', [1, 1]],
  ['int', [1, 1]], ['rand', [0, 0]], ['srand', [0, 1]], ['length', [0, 1]], ['index', [2, 2]], ['substr', [2, 3]],
  ['split', [2, 3]], ['match', [2, 2]], ['sub', [2, 3]], ['gsub', [2, 3]], ['tolower', [1, 1]], ['toupper', [1, 1]],
  ['sprintf', [1, Infinity]], ['close', [1, 1]], ['system', [1, 1]],
]);
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  if (typeof node.type === 'string') visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc') continue;
    if (Array.isArray(value)) for (const item of value) walk(item, visit);
    else if (value && typeof value === 'object') walk(value, visit);
  }
}

export async function runAwk(program, { io, stdin = '', operands = [], preassignments = [], fieldSeparator, environ = new Map(), signal = () => null, limits = {} }) {
  const cap = { maxSteps: 1000000, maxOutputBytes: 16777216, maxBufferBytes: 16777216, maxInputBytes: 67108864,
    maxRecords: 262144, maxFields: 100000, maxArrayEntries: 100000, maxArrayBytes: 16777216, maxScalarBytes: 16777216, maxOpenFiles: 64, maxRecursion: 128, ...limits };
  for (const [name, value] of Object.entries(cap)) if (!Number.isSafeInteger(value) || value < 1) fail(`invalid ${name} limit`);
  let steps = 0, yieldedAt = 0, outputSize = 0, inputSize = 0, recordCount = 0, arraySize = 0, arrayBytes = 0, scalarBytes = 0, recursion = 0;
  const stdout = [], diagnostics = [], globals = new Map(), functions = new Map(), arrayParams = new Map(), regexes = new Map();
  const readers = new Map(), writers = new Map(), ranges = new Map();
  const arraySizes = new WeakMap(), scalarSizes = new WeakMap();
  let frame = null, record = '', recordValue = empty(), fields = [], fieldsReady = true, fieldFS = ' ', paragraph = false;
  let exitCode = 0, didExit = false, stdinUsed = false, currentInput = null, argvIndex = 1, hadFile = false, implicitStdin = false;
  let randomState = 1, randomSeed = 1;
  const checkStop = () => { if (signal()?.aborted) throw new ShellInterrupted(); };
  const tick = () => { checkStop(); if (++steps > cap.maxSteps) fail(`execution exceeds the ${cap.maxSteps}-step limit`); };
  const checkpoint = async () => {
    tick();
    if (steps - yieldedAt >= 256) { yieldedAt = steps; await new Promise((resolve) => setTimeout(resolve, 0)); checkStop(); }
  };
  const bounded = (text) => { if (text.length > cap.maxBufferBytes) fail(`buffer exceeds the ${cap.maxBufferBytes}-byte limit`); return text; };
  const joinBounded = (values, separator, render = (value) => value) => {
    const parts = []; let size = 0;
    for (const value of values) {
      const text = render(value); size += text.length + (parts.length ? separator.length : 0);
      if (size > cap.maxBufferBytes) fail(`buffer exceeds the ${cap.maxBufferBytes}-byte limit`);
      parts.push(text);
    }
    return parts.join(separator);
  };
  const getCell = (name) => {
    if (frame?.has(name)) return frame.get(name);
    if (!globals.has(name)) globals.set(name, cell());
    return globals.get(name);
  };
  const readCell = (entry) => { if (entry.mode === 'array') fail('array used as a scalar'); entry.mode = 'scalar'; return entry.value; };
  const asArray = (entry) => {
    if (entry.mode === 'scalar') fail('scalar used as an array');
    if (entry.mode !== 'array') { entry.mode = 'array'; entry.entries = new Map(); }
    return entry.entries;
  };
  const valueBytes = (value) => value.string?.length ?? 8;
  const writeScalar = (entry, value) => {
    const before = scalarSizes.get(entry) || 0, after = valueBytes(value);
    if (scalarBytes - before + after > cap.maxScalarBytes) fail(`scalar values exceed the ${cap.maxScalarBytes}-byte limit`);
    scalarBytes += after - before; scalarSizes.set(entry, after); entry.mode = 'scalar'; entry.value = value;
  };
  const putEntry = (array, key, value) => {
    bounded(key);
    const exists = array.has(key), before = exists ? key.length + valueBytes(array.get(key)) : 0;
    const after = key.length + valueBytes(value);
    if (!exists && arraySize >= cap.maxArrayEntries) fail(`arrays exceed the ${cap.maxArrayEntries}-entry limit`);
    if (arrayBytes - before + after > cap.maxArrayBytes) fail(`array storage exceeds the ${cap.maxArrayBytes}-byte limit`);
    if (!exists) arraySize++;
    arrayBytes += after - before; arraySizes.set(array, (arraySizes.get(array) || 0) + after - before);
    array.set(key, value);
  };
  const clearArray = (array) => {
    arraySize -= array.size; arrayBytes -= arraySizes.get(array) || 0; arraySizes.set(array, 0); array.clear();
  };
  const deleteEntry = (array, key) => {
    if (!array.has(key)) return;
    const size = key.length + valueBytes(array.get(key));
    arraySize--; arrayBytes -= size; arraySizes.set(array, (arraySizes.get(array) || 0) - size); array.delete(key);
  };
  const rawGlobal = (name) => readCell(getCell(name));
  const initial = (name, value) => { writeScalar(getCell(name), value); };
  const string = (value = empty(), print = false) => {
    if (value.kind !== 'number') return value.string;
    const n = value.number;
    if (Number.isInteger(n) && Number.isFinite(n)) return String(n);
    const formatCell = getCell(print ? 'OFMT' : 'CONVFMT');
    const fmt = formatCell.mode === 'scalar' && formatCell.value.kind !== 'number' ? formatCell.value.string : '%.6g';
    return formatAwk(fmt, [value], { number, string: (v) => String(number(v)), numeric, maxBytes: cap.maxBufferBytes });
  };
  const format = (fmt, args) => formatAwk(fmt, args, { number, string, numeric, maxBytes: cap.maxBufferBytes });
  const compile = (source) => {
    if (!regexes.has(source)) { if (regexes.size >= 256) regexes.delete(regexes.keys().next().value); regexes.set(source, parseRegex(source)); }
    return regexes.get(source);
  };
  const find = (source, text, from = 0) => findRegex(compile(source), text, from, { tick });
  const split = (text, separator, forceRegex = false, includeNewline = false) => {
    if (!text.length) return [];
    const result = [];
    const emit = (part) => {
      tick();
      if (result.length >= cap.maxFields) fail(`field count exceeds the ${cap.maxFields}-field limit`);
      result.push(part);
    };
    if (!forceRegex && separator === ' ') {
      const whitespace = (c) => c === ' ' || c === '\t' || c === '\n';
      let at = 0;
      while (at < text.length) {
        while (at < text.length && whitespace(text[at])) { if ((at & 255) === 0) tick(); at++; }
        const from = at;
        while (at < text.length && !whitespace(text[at])) { if ((at & 255) === 0) tick(); at++; }
        if (from < at) emit(text.slice(from, at));
      }
    } else if (!forceRegex && separator === '') {
      for (let at = 0; at < text.length; at++) emit(text[at]);
    } else if (!forceRegex && separator.length === 1) {
      let from = 0;
      for (;;) {
        let end = text.indexOf(separator, from);
        if (includeNewline && separator !== '\n') {
          const newline = text.indexOf('\n', from);
          if (newline >= 0 && (end < 0 || newline < end)) end = newline;
        }
        if (end < 0) { emit(text.slice(from)); break; }
        emit(text.slice(from, end)); from = end + 1;
      }
    } else {
      // GNU/BSD paragraph rules add newline only for single-byte FS.
      const source = separator;
      let from = 0, search = 0;
      while (search <= text.length) {
        const found = find(source, text, search); if (!found) break;
        if (found.index === found.end) { search = found.end + 1; continue; }
        emit(text.slice(from, found.index)); from = search = found.end;
      }
      emit(text.slice(from));
    }
    return result;
  };
  const ensureFields = () => {
    if (!fieldsReady) { fields = split(record, fieldFS, false, paragraph).map(inputValue); fieldsReady = true; initial('NF', num(fields.length)); }
  };
  const setRecord = (text, paragraphMode = string(rawGlobal('RS')) === '', value = inputValue(text)) => { recordValue = value; record = bounded(text); fieldFS = string(rawGlobal('FS')); paragraph = paragraphMode; fieldsReady = false; };
  const rebuild = () => { record = joinBounded(fields, string(rawGlobal('OFS')), (value) => string(value)); recordValue = str(record); initial('NF', num(fields.length)); fieldsReady = true; };
  const readVariable = (name) => { if (name === 'NF' && !(frame?.has(name))) ensureFields(); return readCell(getCell(name)); };
  const writeVariable = (name, value) => {
    const entry = getCell(name); if (entry.mode === 'array') fail(`array ${name} used as a scalar`);
    if (name === 'NF' && !(frame?.has(name))) {
      const count = Math.trunc(number(value));
      if (!Number.isFinite(count) || count < 0 || count > cap.maxFields) fail('invalid NF value');
      ensureFields(); while (fields.length < count) fields.push(empty()); fields.length = count; rebuild(); return num(count);
    }
    writeScalar(entry, value); return value;
  };
  const pathName = (value) => {
    let path; try { path = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes(value)); } catch (_) { fail('filenames must be valid UTF-8'); }
    if (!path || path.includes('\0')) fail('invalid empty or NUL-containing filename');
    return path;
  };
  const streamLimit = () => { if (readers.size + writers.size >= cap.maxOpenFiles) fail(`open files exceed the ${cap.maxOpenFiles}-stream limit`); };
  const load = async (path, bufferLimit = Infinity) => {
    checkStop();
    const remaining = cap.maxInputBytes - inputSize, maxBytes = Math.min(remaining, bufferLimit);
    const overflow = () => fail(bufferLimit <= remaining
      ? `${path}: buffer exceeds the ${bufferLimit}-byte limit (EFBIG)`
      : `${path}: input exceeds the ${cap.maxInputBytes}-byte limit (EFBIG)`);
    let raw;
    try { raw = path === '-' ? stdinUsed ? '' : stdin : await io.readBytes(path, { maxBytes }); }
    catch (error) { if (error instanceof IOFailure && error.code === 'EFBIG') overflow(); throw error; }
    checkStop();
    if (awkByteLength(raw, maxBytes) > maxBytes) overflow();
    const data = toBytes(raw);
    if (data.length > maxBytes) overflow();
    if (path === '-') stdinUsed = true;
    inputSize += data.length;
    if (inputSize > cap.maxInputBytes) fail(`input exceeds the ${cap.maxInputBytes}-byte limit`);
    return { data: awkBinary(data), pos: 0, path };
  };
  const readRecord = (stream) => {
    tick();
    const text = stream.data, rs = string(rawGlobal('RS'));
    let start = stream.pos, end, after;
    if (start >= text.length) return null;
    if (rs === '') {
      while (text[start] === '\n') start++;
      if (start >= text.length) { stream.pos = start; return null; }
      end = text.indexOf('\n\n', start);
      if (end < 0) { end = text.length; if (text[end - 1] === '\n') end--; after = text.length; }
      else { after = end + 2; while (text[after] === '\n') after++; }
    } else if (rs.length === 1) { end = text.indexOf(rs, start); after = end < 0 ? text.length : end + 1; if (end < 0) end = text.length; }
    else {
      let found = find(rs, text, start);
      let search = start;
      while (found && found.index === found.end) { search = found.end + 1; found = search <= text.length ? find(rs, text, search) : null; }
      end = found ? found.index : text.length; after = found ? found.end : text.length;
    }
    stream.pos = after;
    if (++recordCount > cap.maxRecords) fail(`input exceeds the ${cap.maxRecords}-record limit`);
    return { text: bounded(text.slice(start, end)), paragraph: rs === '' };
  };
  const assignText = (assignment) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/.exec(assignment);
    if (!match) fail(`invalid assignment ${assignment}`);
    writeVariable(match[1], inputValue(decodeAwkArgument(match[2])));
  };
  const nextMain = async () => {
    for (;;) {
      await checkpoint();
      if (currentInput) {
        const item = readRecord(currentInput);
        if (item) { writeVariable('NR', num(number(readVariable('NR')) + 1)); writeVariable('FNR', num(number(readVariable('FNR')) + 1)); return item; }
        currentInput = null;
      }
      let selected = null;
      const argc = number(readVariable('ARGC'));
      if (!Number.isFinite(argc) || argc < 0 || argc > cap.maxArrayEntries) fail('invalid ARGC value');
      const argv = asArray(getCell('ARGV'));
      while (argvIndex < argc) {
        const value = argv.get(String(argvIndex++));
        if (!value) continue;
        const arg = string(value); if (!arg.length) continue;
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg)) { assignText(arg); continue; }
        selected = pathName(arg); hadFile = true; break;
      }
      if (selected == null && !hadFile && !implicitStdin) { selected = '-'; implicitStdin = true; }
      if (selected == null) return null;
      currentInput = await load(selected); writeVariable('FILENAME', str(awkBinary(selected))); writeVariable('FNR', num(0));
    }
  };
  const output = async (text, redirect) => {
    bounded(text); outputSize += text.length;
    if (outputSize > cap.maxOutputBytes) fail(`output exceeds the ${cap.maxOutputBytes}-byte limit`);
    if (!redirect) { stdout.push(text); return; }
    const path = pathName(string(await evaluate(redirect.destination)));
    let stream = writers.get(path);
    if (!stream) {
      streamLimit(); let existing = '';
      if (redirect.op === '>>') {
        try { existing = (await load(path, cap.maxBufferBytes)).data; }
        catch (error) { if (!(error instanceof IOFailure) || error.code !== 'ENOENT') throw error; }
      }
      stream = { data: existing }; writers.set(path, stream);
    }
    stream.data = bounded(stream.data + text); checkStop(); await io.write(path, autoData(bytes(stream.data)));
  };
  const keyFor = async (indices) => {
    const keys = []; for (const index of indices) keys.push(string(await evaluate(index)));
    return joinBounded(keys, string(readVariable('SUBSEP')));
  };
  const reference = async (node) => {
    if (node.type === 'variable') return { get: () => readVariable(node.name), set: (v) => writeVariable(node.name, v) };
    if (node.type === 'array') {
      const array = asArray(getCell(node.name)), key = await keyFor(node.indices);
      return { get: () => { if (!array.has(key)) putEntry(array, key, empty()); return array.get(key); }, set: (v) => { putEntry(array, key, v); return v; } };
    }
    if (node.type === 'field') {
      const index = Math.trunc(number(await evaluate(node.index)));
      if (!Number.isFinite(index) || index < 0 || index > cap.maxFields) fail('invalid field index');
      return {
        get: () => { if (index === 0) return recordValue; ensureFields(); return fields[index - 1] || empty(); },
        set: (v) => {
          if (index === 0) setRecord(string(v), undefined, v);
          else { ensureFields(); while (fields.length < index) fields.push(empty()); fields[index - 1] = v; rebuild(); }
          return v;
        },
      };
    }
    fail('expression is not assignable');
  };
  const regexArgument = async (node) => node.type === 'regex' ? node.source : string(await evaluate(node));
  const compare = (a, b) => {
    const x = numeric(a) && numeric(b) ? number(a) : string(a), y = numeric(a) && numeric(b) ? number(b) : string(b);
    return x < y ? -1 : x > y ? 1 : x === y ? 0 : NaN;
  };
  const arithmetic = (op, left, right) => {
    const a = number(left), b = number(right);
    if ((op === '/' || op === '%') && b === 0) fail('division by zero');
    return num(op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : op === '%' ? a % b : a ** b);
  };
  async function evaluate(node) {
    await checkpoint();
    switch (node.type) {
      case 'number': return num(node.value);
      case 'string': return str(node.value);
      case 'regex': return num(find(node.source, record) ? 1 : 0);
      case 'variable': return readVariable(node.name);
      case 'field': case 'array': return (await reference(node)).get();
      case 'unary': { const value = await evaluate(node.argument); return node.op === '!' ? num(truth(value) ? 0 : 1) : num(node.op === '-' ? -number(value) : number(value)); }
      case 'update': { const ref = await reference(node.argument), previous = ref.get(), value = num(number(previous) + (node.op === '++' ? 1 : -1)); ref.set(value); return node.prefix ? value : num(number(previous)); }
      case 'assign': {
        const ref = await reference(node.target), before = node.op === '=' ? null : ref.get(), right = await evaluate(node.value);
        const value = node.op === '=' ? right : arithmetic(node.op.slice(0, -1), before, right); ref.set(value); return value;
      }
      case 'conditional': return evaluate(truth(await evaluate(node.test)) ? node.consequent : node.alternate);
      case 'binary': {
        if (node.op === 'in') {
          const key = node.left.type === 'tuple' ? await keyFor(node.left.items) : string(await evaluate(node.left));
          return num(asArray(getCell(node.right.name)).has(key) ? 1 : 0);
        }
        const left = await evaluate(node.left);
        if (node.op === '&&') return num(truth(left) && truth(await evaluate(node.right)) ? 1 : 0);
        if (node.op === '||') return num(truth(left) || truth(await evaluate(node.right)) ? 1 : 0);
        if (node.op === '~' || node.op === '!~') { const yes = !!find(await regexArgument(node.right), string(left)); return num(yes === (node.op === '~') ? 1 : 0); }
        const right = await evaluate(node.right);
        if (node.op === 'concat') return str(bounded(string(left) + string(right)));
        if (['==', '!=', '<', '<=', '>', '>='].includes(node.op)) {
          const c = compare(left, right);
          return num((node.op === '==' ? c === 0 : node.op === '!=' ? c !== 0 : node.op === '<' ? c < 0 : node.op === '<=' ? c <= 0 : node.op === '>' ? c > 0 : c >= 0) ? 1 : 0);
        }
        return arithmetic(node.op, left, right);
      }
      case 'call': return call(node);
      case 'getline': {
        const ref = node.target ? await reference(node.target) : null;
        let item;
        if (node.sourceKind === 'main') {
          try { item = await nextMain(); } catch (error) { if (!(error instanceof IOFailure)) throw error; return num(-1); }
        }
        else {
          const path = pathName(await regexArgument(node.source));
          try {
            if (!readers.has(path)) { streamLimit(); readers.set(path, await load(path)); }
            item = readRecord(readers.get(path));
          } catch (error) {
            if (!(error instanceof IOFailure)) throw error;
            return num(-1);
          }
        }
        if (!item) return num(0);
        if (ref) ref.set(inputValue(item.text)); else setRecord(item.text, item.paragraph);
        return num(1);
      }
      default: fail(`unsupported expression ${node.type}`);
    }
  }
  const substitute = (source, replacement, text, global) => {
    const parts = []; let from = 0, search = 0, previousEnd = -1, count = 0, size = 0;
    const add = (part) => { size += part.length; if (size > cap.maxBufferBytes) fail('substitution exceeds the buffer limit'); parts.push(part); };
    while (search <= text.length) {
      const found = find(source, text, search); if (!found) break;
      if (found.index === found.end && found.index === previousEnd) { search = found.end + 1; continue; }
      add(text.slice(from, found.index)); let replaced = '';
      for (let at = 0; at < replacement.length; at++) {
        const c = replacement[at];
        if (c === '&') replaced += found.captures[0];
        else if (c === '\\' && (replacement[at + 1] === '&' || replacement[at + 1] === '\\')) replaced += replacement[++at];
        else replaced += c;
        bounded(replaced);
      }
      add(replaced); from = found.end; previousEnd = found.end; count++;
      search = found.end === found.index ? found.end + 1 : found.end;
      if (!global) break;
    }
    add(text.slice(from)); return { text: parts.join(''), count };
  };
  async function call(node) {
    const { name, args } = node;
    if (functions.has(name)) {
      if (++recursion > cap.maxRecursion) fail(`function recursion exceeds the ${cap.maxRecursion}-call limit`);
      const fn = functions.get(name), params = arrayParams.get(name), locals = new Map();
      for (let at = 0; at < fn.params.length; at++) {
        const arg = args[at]; let entry;
        if (params.has(fn.params[at])) {
          entry = arg ? getCell(arg.name) : cell(); asArray(entry);
        } else if (arg?.type === 'variable' && getCell(arg.name).mode === 'array') entry = getCell(arg.name);
        else { entry = cell(); if (arg) writeScalar(entry, await evaluate(arg)); }
        locals.set(fn.params[at], entry);
      }
      const previous = frame; frame = locals;
      try { const control = await execute(fn.body); if (control && control.type !== 'return') throw control; return control?.value || empty(); }
      finally {
        frame = previous; recursion--;
        const references = new Set([...globals.values(), ...(previous ? previous.values() : [])]);
        for (const entry of new Set(locals.values())) if (!references.has(entry)) {
          if (entry.mode === 'array') clearArray(entry.entries);
          else { scalarBytes -= scalarSizes.get(entry) || 0; scalarSizes.delete(entry); }
        }
      }
    }
    if (name === 'split') {
      const text = string(await evaluate(args[0])), array = asArray(getCell(args[1].name));
      const separator = args[2] ? await regexArgument(args[2]) : string(readVariable('FS'));
      const parts = split(text, separator, args[2]?.type === 'regex'); clearArray(array);
      parts.forEach((part, at) => putEntry(array, String(at + 1), inputValue(part))); return num(parts.length);
    }
    if (name === 'match') {
      const text = string(await evaluate(args[0]));
      const found = find(await regexArgument(args[1]), text);
      writeVariable('RSTART', num(found ? found.index + 1 : 0)); writeVariable('RLENGTH', num(found ? found.end - found.index : -1));
      return num(found ? found.index + 1 : 0);
    }
    if (name === 'sub' || name === 'gsub') {
      const source = await regexArgument(args[0]), replacement = string(await evaluate(args[1]));
      const ref = args[2] ? await reference(args[2]) : { get: () => recordValue, set: (value) => setRecord(string(value), undefined, value) };
      const result = substitute(source, replacement, string(ref.get()), name === 'gsub');
      if (result.count) ref.set(str(result.text)); return num(result.count);
    }
    const values = []; for (const arg of args) values.push(await evaluate(arg));
    const n = number(values[0]);
    switch (name) {
      case 'length': return num((args.length ? string(values[0]) : record).length);
      case 'index': return num(string(values[0]).indexOf(string(values[1])) + 1);
      case 'substr': { const text = string(values[0]), start = Math.max(0, Math.trunc(number(values[1])) - 1); return str(text.slice(start, args.length === 3 ? start + Math.max(0, Math.trunc(number(values[2]))) : undefined)); }
      case 'tolower': return str(string(values[0]).replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32)));
      case 'toupper': return str(string(values[0]).replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32)));
      case 'sprintf': return str(format(string(values[0]), values.slice(1)));
      case 'atan2': return num(Math.atan2(n, number(values[1])));
      case 'cos': return num(Math.cos(n)); case 'sin': return num(Math.sin(n)); case 'exp': return num(Math.exp(n));
      case 'log': return num(Math.log(n)); case 'sqrt': return num(Math.sqrt(n)); case 'int': return num(Math.trunc(n));
      case 'rand': randomState = (Math.imul(randomState, 1664525) + 1013904223) >>> 0; return num(randomState / 4294967296);
      case 'srand': { const previous = randomSeed; randomSeed = args.length ? n : Math.floor(Date.now() / 1000); randomState = randomSeed >>> 0; return num(previous); }
      case 'close': { const path = pathName(string(values[0])); const existed = readers.delete(path); const wrote = writers.delete(path); return num(existed || wrote ? 0 : -1); }
      default: fail(`unsupported function ${name}`);
    }
  }
  async function execute(node) {
    await checkpoint();
    switch (node.type) {
      case 'block': for (const statement of node.body) { const control = await execute(statement); if (control) return control; } return null;
      case 'expression': await evaluate(node.expression); return null;
      case 'if': return truth(await evaluate(node.test)) ? execute(node.consequent) : node.alternate ? execute(node.alternate) : null;
      case 'while': case 'doWhile': {
        let first = true;
        while (node.type === 'doWhile' && first || truth(await evaluate(node.test))) {
          first = false; const control = await execute(node.body);
          if (control?.type === 'break') break;
          if (control && control.type !== 'continue') return control;
        }
        return null;
      }
      case 'for': {
        if (node.init) await evaluate(node.init);
        while (!node.test || truth(await evaluate(node.test))) {
          const control = await execute(node.body); if (control?.type === 'break') break;
          if (control && control.type !== 'continue') return control;
          if (node.update) await evaluate(node.update);
        }
        return null;
      }
      case 'forIn': {
        const array = asArray(getCell(node.array));
        for (const key of [...array.keys()]) {
          if (!array.has(key)) continue;
          writeVariable(node.name, inputValue(key)); const control = await execute(node.body);
          if (control?.type === 'break') break;
          if (control && control.type !== 'continue') return control;
        }
        return null;
      }
      case 'break': case 'continue': case 'next': return { type: node.type };
      case 'return': return { type: 'return', value: node.argument ? await evaluate(node.argument) : empty() };
      case 'exit': return { type: 'exit', value: node.argument ? number(await evaluate(node.argument)) : exitCode };
      case 'delete': {
        const array = asArray(getCell(node.target.name));
        if (node.target.type === 'variable') clearArray(array);
        else deleteEntry(array, await keyFor(node.target.indices));
        return null;
      }
      case 'print': case 'printf': {
        const values = []; for (const arg of node.args) values.push(await evaluate(arg));
        const text = node.type === 'printf' ? format(string(values[0]), values.slice(1)) : bounded((values.length ? joinBounded(values, string(readVariable('OFS')), (value) => string(value, true)) : record) + string(readVariable('ORS')));
        await output(text, node.redirect); return null;
      }
      default: fail(`unsupported statement ${node.type}`);
    }
  }
  const executeRules = async (kind) => {
    for (const rule of program.rules) {
      if (kind === 'main' ? rule.pattern?.type === 'begin' || rule.pattern?.type === 'end' : rule.pattern?.type !== kind) continue;
      let control;
      try {
        let selected = true;
        if (kind === 'main' && rule.pattern) {
          if (rule.pattern.type === 'range') {
            selected = ranges.get(rule) || truth(await evaluate(rule.pattern.start));
            if (selected) ranges.set(rule, !truth(await evaluate(rule.pattern.end)));
          } else selected = truth(await evaluate(rule.pattern));
        }
        if (!selected) continue;
        control = rule.action ? await execute(rule.action) : (await output(record + string(readVariable('ORS')), null), null);
      } catch (error) { if (error?.type === 'next' || error?.type === 'exit') control = error; else throw error; }
      if (control?.type === 'exit') { exitCode = Math.trunc(control.value) & 255; didExit = true; return; }
      if (control?.type === 'next') { if (kind !== 'main') fail('next is invalid in BEGIN or END'); return; }
      if (control) fail(`unexpected ${control.type}`);
    }
  };

  // Resolve array parameters before execution, including functions forwarding
  // arrays to other functions. Static errors and process forms precede writes.
  for (const fn of program.functions) {
    if (builtins.has(fn.name) || functions.has(fn.name)) fail(`duplicate or reserved function ${fn.name}`);
    functions.set(fn.name, fn); arrayParams.set(fn.name, new Set());
  }
  const directArray = (node) => node.type === 'array' ? node.name : node.type === 'forIn' ? node.array : node.type === 'binary' && node.op === 'in' ? node.right.name : node.type === 'delete' ? node.target.name : node.type === 'call' && node.name === 'split' ? node.args[1]?.name : null;
  let changed = true;
  while (changed) {
    changed = false;
    for (const fn of program.functions) walk(fn.body, (node) => {
      tick();
      const names = []; const direct = directArray(node); if (direct) names.push(direct);
      if (node.type === 'call' && functions.has(node.name)) {
        const callee = functions.get(node.name);
        callee.params.forEach((name, at) => { if (arrayParams.get(callee.name).has(name) && node.args[at]?.type === 'variable') names.push(node.args[at].name); });
      }
      for (const name of names) if (fn.params.includes(name) && !arrayParams.get(fn.name).has(name)) { arrayParams.get(fn.name).add(name); changed = true; }
    });
  }
  walk(program, (node) => {
    tick();
    if (node.type === 'regex') compile(node.source);
    if (node.type === 'call') {
      if (node.name === 'system') fail('system() requires process execution, which is unavailable');
      const definition = builtins.get(node.name), fn = functions.get(node.name);
      if (!definition && !fn) fail(`undefined function ${node.name}`);
      const range = definition || [0, fn.params.length];
      if (node.args.length < range[0] || node.args.length > range[1]) fail(`invalid argument count for ${node.name}`);
      if (node.name === 'split' && node.args[1]?.type !== 'variable') fail('split requires an array variable');
      if ((node.name === 'sub' || node.name === 'gsub') && node.args[2] && !isLvalue(node.args[2])) fail(`${node.name} requires an assignable target`);
      if (fn) fn.params.forEach((name, at) => { if (arrayParams.get(fn.name).has(name) && node.args[at] && node.args[at].type !== 'variable') fail(`array parameter ${name} requires an array variable`); });
    }
    if (node.type === 'getline' && node.sourceKind === 'command' || node.redirect?.op === '|') fail('process pipes require process execution, which is unavailable');
  });
  const globalKinds = new Map([['ARGV', 'array'], ['ENVIRON', 'array']]);
  for (const name of ['FS', 'OFS', 'ORS', 'RS', 'OFMT', 'CONVFMT', 'SUBSEP', 'FILENAME', 'NR', 'FNR', 'NF', 'RSTART', 'RLENGTH', 'ARGC']) globalKinds.set(name, 'scalar');
  const classify = (root, fn = null) => {
    const localKinds = new Map();
    const mark = (name, mode) => {
      if (functions.has(name)) fail(`function ${name} used as a variable`);
      const kinds = fn?.params.includes(name) ? localKinds : globalKinds;
      if (kinds.has(name) && kinds.get(name) !== mode) fail(`${name} used as both scalar and array`);
      kinds.set(name, mode);
    };
    const visit = (node, mode = 'scalar') => {
      if (!node || typeof node !== 'object') return;
      tick();
      if (node.type === 'variable') { if (mode !== 'argument') mark(node.name, mode); return; }
      if (node.type === 'array') { mark(node.name, 'array'); node.indices.forEach((item) => visit(item)); return; }
      if (node.type === 'binary' && node.op === 'in') { visit(node.left); visit(node.right, 'array'); return; }
      if (node.type === 'forIn') { mark(node.name, 'scalar'); mark(node.array, 'array'); visit(node.body); return; }
      if (node.type === 'delete') { visit(node.target, 'array'); return; }
      if (node.type === 'call') {
        const callee = functions.get(node.name);
        node.args.forEach((arg, at) => visit(arg, node.name === 'split' && at === 1 || callee && arrayParams.get(callee.name).has(callee.params[at]) ? 'array' : callee ? 'argument' : 'scalar'));
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        if (key === 'loc') continue;
        if (Array.isArray(value)) value.forEach((item) => visit(item));
        else if (value && typeof value === 'object') visit(value);
      }
    };
    visit(root);
  };
  for (const fn of program.functions) classify(fn.body, fn);
  for (const rule of program.rules) classify(rule);
  for (const [name, mode] of globalKinds) if (mode === 'array') asArray(getCell(name));
  for (const [name, value] of Object.entries({ FS: ' ', OFS: ' ', ORS: '\n', RS: '\n', OFMT: '%.6g', CONVFMT: '%.6g', SUBSEP: '\x1c', FILENAME: '' })) initial(name, str(value));
  for (const name of ['NR', 'FNR', 'NF', 'RSTART']) initial(name, num(0));
  initial('RLENGTH', num(-1)); initial('ARGC', num(operands.length + 1));
  const argv = asArray(getCell('ARGV')); putEntry(argv, '0', str('awk'));
  operands.forEach((arg, at) => putEntry(argv, String(at + 1), inputValue(awkBinary(arg))));
  const environmentArray = asArray(getCell('ENVIRON'));
  for (const [name, value] of environ instanceof Map ? environ : Object.entries(environ || {})) putEntry(environmentArray, awkBinary(name), inputValue(awkBinary(String(value))));
  if (fieldSeparator !== undefined) writeVariable('FS', inputValue(decodeAwkArgument(awkBinary(fieldSeparator))));
  for (const assignment of preassignments) assignText(awkBinary(assignment));
  try {
    await executeRules('begin');
    if (!didExit && program.rules.some((rule) => rule.pattern?.type !== 'begin')) {
      for (;;) {
        const item = await nextMain(); if (!item) break;
        setRecord(item.text, item.paragraph); await executeRules('main'); if (didExit) break;
      }
    }
    didExit = false; await executeRules('end');
  } catch (error) {
    if (error instanceof ArgError) { diagnostics.push(error.message); exitCode = 2; }
    else if (error instanceof IOFailure) { diagnostics.push(`awk: ${error.code}: ${error.message}`); exitCode = 2; }
    else throw error;
  }
  const result = autoData(bytes(stdout.join('')));
  return { text: diagnostics.length ? concatData([diagnostics.join('\n') + '\n', result]) : result, code: exitCode, raw: true };
}
