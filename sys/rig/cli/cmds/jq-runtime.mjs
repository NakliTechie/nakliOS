import { DataError, own, setKey, objectValue, compareStrings } from './data-common.mjs';

export const truthy = (value) => value !== false && value !== null;
const rank = (value) => value === null ? 0 : value === false ? 1 : value === true ? 2 : typeof value === 'number' ? 3 : typeof value === 'string' ? 4 : Array.isArray(value) ? 5 : 6;
export function compareValues(ctx, left, right, depth = 0) {
  ctx.budget.spend('steps'); if (depth > ctx.limits.maxDepth) ctx.fail('comparison nesting exceeds the resource limit');
  const a = rank(left), b = rank(right); if (a !== b) return Math.sign(a - b);
  if (a < 3) return 0;
  if (a === 3) return left < right ? -1 : left > right ? 1 : 0;
  if (a === 4) return compareStrings(left, right);
  const keys = a === 6 ? [Object.keys(left).sort(compareStrings), Object.keys(right).sort(compareStrings)] : null;
  if (keys) { const order = compareValues(ctx, keys[0], keys[1], depth + 1); if (order) return order; }
  const xs = keys ? keys[0].map((key) => left[key]) : left, ys = keys ? keys[1].map((key) => right[key]) : right;
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) { const order = compareValues(ctx, xs[i], ys[i], depth + 1); if (order) return order; }
  return Math.sign(xs.length - ys.length);
}
function index(ctx, value, key) {
  if (value === null) return null;
  if (typeof key === 'string' && objectValue(value)) return own(value, key);
  if (typeof key === 'number' && Array.isArray(value)) {
    if (!Number.isSafeInteger(key)) ctx.fail('array indices must be safe integers');
    const at = key < 0 ? value.length + key : key; return at >= 0 && at < value.length ? value[at] : null;
  }
  ctx.fail(`cannot index ${Array.isArray(value) ? 'array' : typeof value} with ${typeof key}`);
}
function iterable(ctx, value) {
  if (Array.isArray(value)) return value;
  if (objectValue(value)) return Object.values(value);
  ctx.fail('cannot iterate a scalar value');
}
function arithmetic(ctx, op, a, b) {
  if (op === '+') {
    if (a === null) return b;
    if (b === null) return a;
    if (typeof a === 'string' && typeof b === 'string') { ctx.value(32 + (a.length + b.length) * 2); return a + b; }
    if (Array.isArray(a) && Array.isArray(b)) { ctx.value(32 + (a.length + b.length) * 8); return [...a, ...b]; }
    if (objectValue(a) && objectValue(b)) {
      const out = Object.create(null); ctx.value();
      for (const obj of [a, b]) for (const key of Object.keys(obj)) { ctx.budget.spend('steps'); ctx.budget.reserveRetained(16 + key.length * 2); setKey(out, key, obj[key]); }
      return out;
    }
  }
  if (typeof a === 'number' && typeof b === 'number') {
    if (['/', '%'].includes(op) && b === 0) ctx.fail('division by zero');
    const value = op === '+' ? a + b : op === '-' ? a - b : op === '*' ? a * b : op === '/' ? a / b : a % b;
    if (!Number.isFinite(value)) ctx.fail('numeric result is not finite'); ctx.value(); return value;
  }
  ctx.fail(`unsupported operand types for ${op}`);
}

export async function* evaluateJq(ctx, tree, input, variables, depth = 0) {
  await ctx.budget.checkpoint(); if (depth > ctx.limits.maxDepth) ctx.fail('filter evaluation nesting exceeds the resource limit');
  const evaluate = (node, value = input) => evaluateJq(ctx, node, value, variables, depth + 1);
  switch (tree.type) {
    case 'identity': yield input; return;
    case 'literal': yield tree.value; return;
    case 'variable': if (!variables.has(tree.name)) ctx.fail(`undefined variable $${tree.name}`, 3); yield variables.get(tree.name); return;
    case 'optional':
      try { yield* evaluate(tree.value); } catch (error) { if (!(error instanceof DataError) || error.code !== 5 || /resource limit|byte limit/.test(error.message)) throw error; }
      return;
    case 'negate':
      for await (const value of evaluate(tree.value)) { if (typeof value !== 'number') ctx.fail('unary minus requires a number'); yield -value; } return;
    case 'index':
      for await (const base of evaluate(tree.base)) for await (const key of evaluate(tree.key)) yield index(ctx, base, key); return;
    case 'iterate':
      for await (const base of evaluate(tree.base)) for (const item of iterable(ctx, base)) { await ctx.budget.checkpoint(); yield item; } return;
    case 'slice':
      for await (const base of evaluate(tree.base)) {
        if (base === null) { yield null; continue; }
        if (!Array.isArray(base) && typeof base !== 'string') ctx.fail('slice requires an array or string');
        const starts = [], ends = [];
        if (tree.start) for await (const value of evaluate(tree.start)) { ctx.value(8); starts.push(value); } else starts.push(null);
        if (tree.end) for await (const value of evaluate(tree.end)) { ctx.value(8); ends.push(value); } else ends.push(null);
        for (const start of starts) for (const end of ends) {
          if ([start, end].some((n) => n !== null && !Number.isSafeInteger(n))) ctx.fail('slice bounds must be safe integers or null');
          ctx.value(32 + base.length * 8);
          const items = typeof base === 'string' ? Array.from(base) : base;
          const out = items.slice(start ?? 0, end ?? items.length); yield typeof base === 'string' ? out.join('') : out;
        }
      }
      return;
    case 'collect': {
      const out = []; ctx.value();
      if (tree.value) for await (const value of evaluate(tree.value)) { ctx.value(8); out.push(value); }
      yield out; return;
    }
    case 'object': {
      let out = [Object.create(null)]; ctx.value();
      for (const field of tree.fields) {
        const next = [];
        for (const prior of out) for await (const key of evaluate(field.key)) {
          if (typeof key !== 'string') ctx.fail('object keys must be strings');
          for await (const value of evaluate(field.value)) {
            const keys = Object.keys(prior); ctx.value(32 + keys.length * 24 + key.length * 2);
            const copy = Object.create(null); for (const name of keys) setKey(copy, name, prior[name]);
            setKey(copy, key, value); next.push(copy);
          }
        }
        out = next;
      }
      yield* out; return;
    }
    case 'binary': {
      if (tree.op === ',') { yield* evaluate(tree.left); yield* evaluate(tree.right); return; }
      if (tree.op === '|') { for await (const value of evaluate(tree.left)) yield* evaluate(tree.right, value); return; }
      if (tree.op === '//') {
        let found = false;
        for await (const value of evaluate(tree.left)) if (truthy(value)) { found = true; yield value; }
        if (!found) yield* evaluate(tree.right); return;
      }
      for await (const left of evaluate(tree.left)) {
        if (tree.op === 'and' && !truthy(left)) { yield false; continue; }
        if (tree.op === 'or' && truthy(left)) { yield true; continue; }
        for await (const right of evaluate(tree.right)) {
        await ctx.budget.checkpoint();
        if (tree.op === 'and') yield truthy(left) && truthy(right);
        else if (tree.op === 'or') yield truthy(left) || truthy(right);
        else if (['==', '!=', '<', '<=', '>', '>='].includes(tree.op)) {
          const order = compareValues(ctx, left, right);
          yield tree.op === '==' ? order === 0 : tree.op === '!=' ? order !== 0 : tree.op === '<' ? order < 0 : tree.op === '<=' ? order <= 0 : tree.op === '>' ? order > 0 : order >= 0;
        } else yield arithmetic(ctx, tree.op, left, right);
        }
      }
      return;
    }
    case 'call': {
      if (tree.name === 'empty') return;
      if (tree.name === 'not') { yield !truthy(input); return; }
      if (tree.name === 'type') { yield input === null ? 'null' : Array.isArray(input) ? 'array' : typeof input; return; }
      if (tree.name === 'select') { for await (const value of evaluate(tree.argument)) if (truthy(value)) yield input; return; }
      if (tree.name === 'map') {
        const out = []; ctx.value();
        for (const item of iterable(ctx, input)) for await (const value of evaluate(tree.argument, item)) { ctx.value(8); out.push(value); }
        yield out; return;
      }
      if (tree.name === 'has') {
        for await (const key of evaluate(tree.argument)) {
          if (input === null) yield false;
          else if (Array.isArray(input) && typeof key === 'number') yield Number.isSafeInteger(key) && key >= 0 && key < input.length;
          else if (objectValue(input) && typeof key === 'string') yield Object.hasOwn(input, key);
          else ctx.fail('has requires a matching object/string or array/number pair');
        }
        return;
      }
      if (tree.name === 'length') {
        if (input === null) yield 0;
        else if (typeof input === 'number') yield Math.abs(input);
        else if (typeof input === 'string') yield Array.from(input).length;
        else if (Array.isArray(input)) yield input.length;
        else if (objectValue(input)) yield Object.keys(input).length;
        else ctx.fail('length is unavailable for booleans'); return;
      }
      if (Array.isArray(input)) { ctx.value(32 + input.length * 8); yield input.map((_, i) => i); }
      else if (objectValue(input)) {
        const keys = Object.keys(input); ctx.value(32 + keys.length * 8);
        yield tree.name === 'keys' ? keys.sort(compareStrings) : keys;
      } else ctx.fail('keys requires an object or array');
      return;
    }
    default: ctx.fail(`unsupported filter node ${tree.type}`);
  }
}
