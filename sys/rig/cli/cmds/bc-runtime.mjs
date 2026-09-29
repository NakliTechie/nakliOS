import { ArgError } from '../args.mjs';
import { createDecimalMath } from './u2-decimal.mjs';
import { createBcMathLibrary } from './bc-math.mjs';

const abs = (n) => n < 0n ? -n : n;
const alphabet = '0123456789ABCDEF';
const specials = new Set(['scale', 'ibase', 'obase', 'last']);
class Control { constructor(type, value) { this.type = type; this.value = value; } }

export function createBcRuntime({ context: ctx, mathLibrary = false, limits = {} } = {}) {
  const { budget, output } = ctx;
  const maxDigits = ctx.limits.maxDecimalDigits, maxScale = ctx.limits.maxDecimalScale;
  const maxExponent = ctx.limits.maxExponent, maxRecursion = limits.maxRecursion ?? 128;
  const maxArrayIndex = limits.maxArrayIndex ?? 65535, maxCells = limits.maxCells ?? 100000;
  const maxScratchDigits = limits.maxScratchDigits ?? 2 * maxDigits + 2 * maxScale + 32;
  const maxScratchScale = limits.maxScratchScale ?? 2 * maxDigits + 2 * maxScale + 32;
  const fail = (message, node) => { throw new ArgError(`bc: ${message}${node ? ` at line ${node.loc.line}, column ${node.loc.column}` : ''}`); };
  for (const [name, value] of Object.entries({ maxRecursion, maxArrayIndex, maxCells })) {
    if (!Number.isSafeInteger(value) || value < 0) fail(`invalid ${name} limit`);
  }
  const config = { budget, maxDigits, maxScale, maxExponent, maxScratchDigits, maxScratchScale };
  const math = createDecimalMath(config), library = mathLibrary ? createBcMathLibrary(config) : null;
  const zero = math.integer(0), one = math.integer(1);
  const state = { scale: mathLibrary ? 20 : 0, ibase: 10, obase: 10, last: zero };
  if (state.scale > maxScale) fail('math library initial scale exceeds the scale limit');
  const globals = { scalars: new Map(), arrays: new Map() }, frames = [], functions = new Map();
  let cells = 0, stopped = false, outputColumn = 0, releaseLast = () => {};
  const setLast = (value) => {
    const release = budget.reserveRetained(32 + math.digits(value) * 4);
    releaseLast(); releaseLast = release; state.last = value; return value;
  };
  const cell = (value, label, replacement = false) => {
    if (cells >= maxCells && !replacement) fail(`variables and array entries exceed the ${maxCells}-cell limit`);
    const release = budget.reserveRetained(64 + label.length * 2 + math.digits(value) * 4);
    cells++; let active = true;
    return { value, release() { if (active) { active = false; cells--; release(); } } };
  };
  const replace = (map, key, value) => {
    const previous = map.get(key), next = cell(value, String(key), !!previous);
    map.set(key, next); previous?.release(); return value;
  };
  const arrayObject = (name) => ({ cells: new Map(), release: budget.reserveRetained(64 + name.length * 2) });
  const scope = (name, arrays = false) => {
    const kind = arrays ? 'arrays' : 'scalars';
    for (let i = frames.length - 1; i >= 0; i--) if (frames[i][kind].has(name)) return frames[i][kind];
    return globals[kind];
  };
  const getArray = (name) => {
    const map = scope(name, true);
    if (!map.has(name)) {
      if (globals.arrays.size + frames.reduce((count, frame) => count + frame.arrays.size, 0) >= maxCells) fail('array count exceeds the cell limit');
      map.set(name, arrayObject(name));
    }
    return map.get(name);
  };
  const getVariable = (name) => specials.has(name) ? name === 'last' ? state.last : math.integer(state[name]) : scope(name).get(name)?.value || zero;
  const setVariable = (name, value) => {
    if (!specials.has(name)) return replace(scope(name), name, value);
    if (name === 'last') return setLast(value);
    let number = math.toInteger(value);
    if (name === 'scale') {
      if (number < 0n) fail('scale cannot be negative');
      if (number > BigInt(maxScale)) fail(`scale exceeds the ${maxScale} resource limit`);
    } else if (name === 'ibase') number = number < 2n ? 2n : number > 16n ? 16n : number;
    else {
      if (number > 999n) fail('output base exceeds the 999 resource limit');
      number = number < 2n ? 2n : number;
    }
    state[name] = Number(number); return math.integer(number);
  };
  const pow10 = (power) => {
    if (power + 1 > maxScratchDigits) fail('base conversion exceeds the scratch digit limit');
    budget.spend('steps', Math.max(1, Math.ceil(power / 128)));
    const release = budget.reserveRetained((power + 1) * 4 + 64);
    try { return 10n ** BigInt(power); } finally { release(); }
  };
  function literal(text) {
    const base = frames.length ? frames.at(-1).ibase : state.ibase;
    if (base === 10 && /^[0-9.]+$/.test(text)) return math.parse(text);
    if (text.length === 1) return math.integer(alphabet.indexOf(text));
    const dot = text.indexOf('.'), scale = dot < 0 ? 0 : text.length - dot - 1;
    if (scale > maxScale || text.length > maxDigits + maxScale + 1) fail('numeric literal exceeds decimal limits');
    const digits = text.replace('.', '');
    // A base-16 digit needs at most two decimal digits. Bound before BigInt work.
    const projected = Math.ceil(digits.length * 5 / 4) + scale + 2;
    if (projected > maxScratchDigits) fail('input-base conversion exceeds the scratch digit limit');
    const release = budget.reserveRetained(projected * 8 + 64);
    try {
      let coefficient = 0n, denominator = 1n;
      for (let i = 0; i < digits.length; i++) {
        budget.spend('steps'); coefficient = coefficient * BigInt(base) + BigInt(digits.length === 1 ? alphabet.indexOf(digits[i]) : Math.min(alphabet.indexOf(digits[i]), base - 1));
      }
      for (let i = 0; i < scale; i++) { budget.spend('steps'); denominator *= BigInt(base); }
      if (scale) coefficient = coefficient * pow10(scale) / denominator;
      const value = Object.freeze({ coefficient, scale }); math.digits(value); return value;
    } finally { release(); }
  }
  const truth = (value) => value.coefficient !== 0n;
  async function reference(node) {
    if (node.type === 'variable') return { get: () => getVariable(node.name), set: (value) => setVariable(node.name, value) };
    if (node.type !== 'array') fail('expected a variable', node);
    const index = math.toInteger(await evaluate(node.index));
    if (index < 0n || index > BigInt(maxArrayIndex)) fail(`array index must be from 0 to ${maxArrayIndex}`, node);
    const array = getArray(node.name), key = Number(index);
    return { get: () => array.cells.get(key)?.value || zero, set: (value) => replace(array.cells, key, value) };
  }
  async function arithmetic(op, a, b, node) {
    if (op === '+') return math.add(a, b);
    if (op === '-') return math.subtract(a, b);
    if (op === '*') return math.multiply(a, b, { scale: Math.min(a.scale + b.scale, Math.max(state.scale, a.scale, b.scale)), rounding: 'trunc' });
    if (op === '/') return math.divide(a, b, { scale: state.scale, rounding: 'trunc' });
    if (op === '%') return math.remainder(a, b, { quotientScale: state.scale });
    if (op === '^') {
      const exponent = math.toInteger(b);
      if (b.scale && b.coefficient % pow10(b.scale)) emitBytes('bc: warning: non-integer exponent truncated toward zero\n');
      if (abs(exponent) > BigInt(maxExponent)) fail(`exponent exceeds the ${maxExponent} resource limit`, node);
      const scale = exponent === 0n ? 0 : exponent < 0n ? state.scale : Math.min(a.scale * Number(exponent), Math.max(state.scale, a.scale));
      return math.power(a, exponent, { scale, rounding: 'trunc' });
    }
    const relation = math.compare(a, b);
    if (op === '<') return relation < 0 ? one : zero;
    if (op === '<=') return relation <= 0 ? one : zero;
    if (op === '>') return relation > 0 ? one : zero;
    if (op === '>=') return relation >= 0 ? one : zero;
    if (op === '==') return relation === 0 ? one : zero;
    if (op === '!=') return relation !== 0 ? one : zero;
    fail(`unsupported operator ${op}`, node);
  }
  async function evaluate(node) {
    await budget.checkpoint();
    if (node.type === 'number') return literal(node.text);
    if (node.type === 'variable') return getVariable(node.name);
    if (node.type === 'array') return (await reference(node)).get();
    if (node.type === 'arrayRef') fail('array name requires an array function parameter', node);
    if (node.type === 'group') return evaluate(node.value);
    if (node.type === 'call') return call(node);
    if (node.type === 'assign') {
      const target = await reference(node.left), before = node.op === '=' ? null : target.get();
      const right = await evaluate(node.right);
      return target.set(before === null ? right : await arithmetic(node.op[0], before, right, node));
    }
    if (node.type === 'unary') {
      if (node.op === '++' || node.op === '--') {
        const target = await reference(node.argument), previous = target.get();
        const value = target.set(node.op === '++' ? math.add(previous, one) : math.subtract(previous, one));
        return node.prefix ? value : previous;
      }
      const value = await evaluate(node.argument);
      return node.op === '-' ? math.negate(value) : node.op === '!' ? truth(value) ? zero : one : value;
    }
    if (node.type === 'binary') {
      const left = await evaluate(node.left);
      // GNU bc evaluates both operands of its boolean extension.
      const right = await evaluate(node.right);
      if (node.op === '&&') return truth(left) && truth(right) ? one : zero;
      if (node.op === '||') return truth(left) || truth(right) ? one : zero;
      return arithmetic(node.op, left, right, node);
    }
    fail(`invalid expression ${node.type}`, node);
  }
  async function call(node) {
    if (['length', 'scale', 'sqrt'].includes(node.name)) {
      if (node.args.length !== 1) fail(`${node.name} requires one argument`, node);
      const value = await evaluate(node.args[0]);
      if (node.name === 'length') return math.integer(Math.max(math.digits(value), value.scale));
      if (node.name === 'scale') return math.integer(value.scale);
      return math.sqrt(value, { scale: Math.max(state.scale, value.scale), rounding: 'trunc' });
    }
    const definition = functions.get(node.name);
    if (!definition) {
      if (library && ['s', 'c', 'a', 'l', 'e', 'j'].includes(node.name)) {
        const args = []; for (const argument of node.args) args.push(await evaluate(argument));
        return library.call(node.name, args, state.scale);
      }
      fail(`undefined function ${node.name}`, node);
    }
    if (node.args.length !== definition.params.length) fail(`wrong argument count for ${node.name}`, node);
    if (frames.length >= maxRecursion) fail(`function recursion exceeds the ${maxRecursion}-level limit`, node);
    const args = [];
    for (let i = 0; i < node.args.length; i++) {
      const argument = node.args[i], parameter = definition.params[i];
      if (parameter.array) {
        if (argument.type !== 'arrayRef') fail(`parameter ${parameter.name} requires an array`, argument);
        args.push(getArray(argument.name));
      } else args.push(await evaluate(argument));
    }
    const frame = { scalars: new Map(), arrays: new Map(), ownedArrays: [], ibase: state.ibase,
      release: budget.reserveRetained(128 + (definition.params.length + definition.autos.length) * 32) };
    const newArray = (name) => { const array = arrayObject(name); frame.arrays.set(name, array); frame.ownedArrays.push(array); return array; };
    const cleanup = () => {
      for (const item of frame.scalars.values()) item.release();
      for (const array of frame.ownedArrays) { for (const item of array.cells.values()) item.release(); array.release(); }
      frame.release();
    };
    try {
      for (let i = 0; i < definition.params.length; i++) {
        const parameter = definition.params[i];
        if (!parameter.array) replace(frame.scalars, parameter.name, args[i]);
        else if (parameter.reference) frame.arrays.set(parameter.name, args[i]);
        else {
          const array = newArray(parameter.name);
          for (const [key, entry] of args[i].cells) { await budget.checkpoint(); replace(array.cells, key, entry.value); }
        }
      }
      for (const item of definition.autos) item.array ? newArray(item.name) : replace(frame.scalars, item.name, zero);
      frames.push(frame);
      try { await statements(definition.body); return zero; }
      catch (control) { if (control instanceof Control && control.type === 'return') return control.value; throw control; }
      finally { frames.pop(); }
    } finally { cleanup(); }
  }
  const emitBytes = (text) => {
    if (text.length > budget.remaining('outputBytes')) fail('output exceeds its byte resource limit');
    const bytes = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    output.append(bytes);
    const newline = text.lastIndexOf('\n'); outputColumn = newline < 0 ? outputColumn + text.length : text.length - newline - 1;
  };
  const emitNumberText = (text, newline) => {
    for (let at = 0; at < text.length;) {
      if (outputColumn >= 68) emitBytes('\\\n');
      const count = Math.min(text.length - at, 68 - outputColumn);
      emitBytes(text.slice(at, at + count)); at += count;
    }
    if (newline) emitBytes('\n');
  };
  async function format(value) {
    if (!value.coefficient) return '0';
    if (state.obase === 10) return math.toFixed(value).replace(/^(-?)0\./, '$1.');
    const base = BigInt(state.obase), negative = value.coefficient < 0n, denominator = pow10(value.scale);
    let integer = abs(value.coefficient) / denominator, fraction = abs(value.coefficient) % denominator;
    const width = String(state.obase - 1).length, wide = state.obase > 16;
    const projected = (math.digits(value) + value.scale + 2) * 4 * (wide ? width + 1 : 1) + 4;
    if (projected > ctx.limits.maxOutputBytes) fail('base-converted number exceeds the output limit');
    const release = budget.reserveRetained(projected * 4 + 64);
    try {
      const parts = [];
      while (integer) {
        await budget.checkpoint(); const digit = Number(integer % base); integer /= base;
        parts.push(wide ? String(digit).padStart(width, '0') : alphabet[digit]);
      }
      let result = wide ? parts.reverse().map((part) => ' ' + part).join('') : parts.reverse().join('');
      if (!result && !value.scale) result = wide ? ' ' + '0'.repeat(width) : '0';
      if (value.scale) {
        result += '.'; let precisionPower = 1n;
        while (precisionPower < denominator) {
          await budget.checkpoint(); precisionPower *= base; fraction *= base;
          const digit = Number(fraction / denominator); fraction %= denominator;
          result += wide ? String(digit).padStart(width, '0') + ' ' : alphabet[digit];
        }
        if (wide) result = result.trimEnd();
      }
      return (negative ? '-' : '') + result;
    } finally { release(); }
  }
  async function printValue(value, newline) {
    const text = await format(value); setLast(value); emitNumberText(text, newline);
  }
  function printString(text) {
    const escapes = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', q: '"', t: '\t', '\\': '\\' };
    let result = '';
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\\' && Object.hasOwn(escapes, text[i + 1])) result += escapes[text[++i]];
      else result += text[i];
    }
    emitBytes(result);
  }
  async function statement(node) {
    await budget.checkpoint();
    if (node.type === 'empty') return;
    if (node.type === 'block') return statements(node.body);
    if (node.type === 'define') { functions.set(node.name, node); return; }
    if (node.type === 'expression') { const value = await evaluate(node.value); if (node.print) await printValue(value, true); return; }
    if (node.type === 'stringStatement') { emitBytes(node.value); return; }
    if (node.type === 'print') {
      for (const item of node.items) item.type === 'string' ? printString(item.value) : await printValue(await evaluate(item), false);
      return;
    }
    if (node.type === 'if') return truth(await evaluate(node.test)) ? statement(node.consequent) : node.alternate ? statement(node.alternate) : undefined;
    if (node.type === 'while' || node.type === 'for') {
      if (node.init) await evaluate(node.init);
      while (!node.test || truth(await evaluate(node.test))) {
        await budget.checkpoint();
        try { await statement(node.body); }
        catch (control) {
          if (!(control instanceof Control)) throw control;
          if (control.type === 'break') break;
          if (control.type !== 'continue') throw control;
        }
        if (node.update) await evaluate(node.update);
      }
      return;
    }
    if (node.type === 'return') throw new Control('return', node.argument ? await evaluate(node.argument) : zero);
    if (['break', 'continue', 'halt'].includes(node.type)) throw new Control(node.type);
    fail(`invalid statement ${node.type}`, node);
  }
  async function statements(nodes) { for (const node of nodes) await statement(node); }
  return {
    get stopped() { return stopped; },
    get outputColumn() { return outputColumn; },
    async execute(program) {
      if (stopped) return;
      for (const warning of program.warnings) emitBytes(warning + '\n');
      try { await statements(program.body); }
      catch (control) { if (!(control instanceof Control) || control.type !== 'halt') throw control; stopped = true; }
      if (program.quit) stopped = true;
    },
  };
}
