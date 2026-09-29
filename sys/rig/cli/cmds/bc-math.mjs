import { ArgError } from '../args.mjs';

const abs = (n) => n < 0n ? -n : n;
const floorDiv = (a, b) => { if (b < 0n) { a = -a; b = -b; } const q = a / b; return a < 0n && a % b ? q - 1n : q; };
const ceilDiv = (a, b) => -floorDiv(-a, b);
class MorePrecision extends Error {}

// Every intermediate is an outward-rounded interval of scaled integers.
// The returned decimal is accepted only when both enclosing endpoints truncate
// to the same requested result. Series remainder bounds are included explicitly.
// Series: NIST DLMF 4.6.4, 4.19, 4.24, and 10.2.2.
export function createBcMathLibrary({ budget, maxDigits = 10000, maxScale = 1000,
  maxScratchDigits = 2 * maxDigits + 2 * maxScale + 32,
  maxScratchScale = 2 * maxDigits + 2 * maxScale + 32, maxExponent = 10000 } = {}) {
  const fail = (message) => { throw new ArgError(`bc: ${message}`); };
  const digits = (n) => abs(n).toString().length;
  const checkedPower = (n) => {
    if (!Number.isSafeInteger(n) || n < 0 || n + 1 > maxScratchDigits) fail('math library scratch precision exceeds its resource limit');
    budget.spend('steps', Math.max(1, Math.ceil(n / 128)));
    const release = budget.reserveRetained((n + 1) * 4 + 64);
    try { return 10n ** BigInt(n); } finally { release(); }
  };
  const piCache = new Map();
  function engine(precision) {
    if (precision > maxScratchScale) fail('math library cannot establish the requested precision within its scratch limit');
    const unit = checkedPower(precision), zero = { lo: 0n, hi: 0n }, one = { lo: unit, hi: unit };
    const protect = (size, count, run) => {
      if (size > maxScratchDigits) fail('math library intermediate exceeds its digit limit');
      budget.spend('steps', Math.max(1, Math.ceil(size * count / 64)));
      const release = budget.reserveRetained(size * count * 4 + 64);
      try { return run(); } finally { release(); }
    };
    const magnitude = (x) => abs(x.lo) > abs(x.hi) ? abs(x.lo) : abs(x.hi);
    const size = (x) => digits(magnitude(x));
    const add = (a, b) => protect(Math.max(size(a), size(b)) + 1, 2, () => ({ lo: a.lo + b.lo, hi: a.hi + b.hi }));
    const neg = (a) => ({ lo: -a.hi, hi: -a.lo });
    const sub = (a, b) => add(a, neg(b));
    const mul = (a, b) => protect(size(a) + size(b), 4, () => {
      const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
      let lo = products[0], hi = lo;
      for (const n of products) { if (n < lo) lo = n; if (n > hi) hi = n; }
      return { lo: floorDiv(lo, unit), hi: ceilDiv(hi, unit) };
    });
    const square = (a) => {
      const result = mul(a, a);
      if (a.lo <= 0n && a.hi >= 0n) result.lo = 0n;
      return result;
    };
    const div = (a, b) => {
      if (b.lo <= 0n && b.hi >= 0n) throw new MorePrecision();
      return protect(size(a) + precision + 1, 4, () => {
        const pairs = [[a.lo, b.lo], [a.lo, b.hi], [a.hi, b.lo], [a.hi, b.hi]];
        let lo, hi;
        for (const [n, d] of pairs) {
          const lower = floorDiv(n * unit, d), upper = ceilDiv(n * unit, d);
          if (lo === undefined || lower < lo) lo = lower;
          if (hi === undefined || upper > hi) hi = upper;
        }
        return { lo, hi };
      });
    };
    const divInt = (a, n) => {
      if (n < 0n) return neg(divInt(a, -n));
      return { lo: floorDiv(a.lo, n), hi: ceilDiv(a.hi, n) };
    };
    const mulInt = (a, n) => protect(size(a) + digits(n), 2, () => n < 0n
      ? { lo: a.hi * n, hi: a.lo * n } : { lo: a.lo * n, hi: a.hi * n });
    const from = (value) => {
      const shift = precision - value.scale;
      if (shift < 0) { const divisor = checkedPower(-shift); return { lo: floorDiv(value.coefficient, divisor), hi: ceilDiv(value.coefficient, divisor) }; }
      return protect(digits(value.coefficient) + shift, 2, () => {
        const n = value.coefficient * checkedPower(shift); return { lo: n, hi: n };
      });
    };
    const around = (a, radius) => ({ lo: a.lo - radius, hi: a.hi + radius });
    async function rootInteger(n) {
      if (n < 2n) return n;
      let current = checkedPower(Math.ceil(digits(n) / 2));
      for (;;) {
        await budget.checkpoint(Math.max(1, Math.ceil(digits(current) / 128)));
        const next = (current + n / current) / 2n;
        if (next >= current) return current;
        current = next;
      }
    }
    async function sqrt(a) {
      if (a.lo < 0n) throw new MorePrecision();
      const release = budget.reserveRetained((size(a) + precision + 1) * 8 + 64);
      try {
        if (size(a) + precision + 1 > maxScratchDigits) fail('math square root exceeds its scratch limit');
        const left = a.lo * unit, right = a.hi * unit;
        const lo = await rootInteger(left), root = await rootInteger(right);
        return { lo, hi: root * root === right ? root : root + 1n };
      } finally { release(); }
    }
    async function atanSmall(x) {
      if (magnitude(x) * 2n > unit) throw new MorePrecision();
      const x2 = square(x); let power = x, sum = x;
      for (let k = 1; ; k++) {
        await budget.checkpoint(); power = mul(power, x2);
        const term = divInt(power, BigInt(2 * k + 1));
        if (magnitude(term) <= 2n) return around(sum, magnitude(term));
        sum = k % 2 ? sub(sum, term) : add(sum, term);
      }
    }
    async function pi() {
      if (piCache.has(precision)) return piCache.get(precision);
      const result = sub(mulInt(await atanSmall(divInt(one, 5n)), 16n), mulInt(await atanSmall(divInt(one, 239n)), 4n));
      budget.reserveRetained((precision + 2) * 8 + 64); piCache.set(precision, result); return result;
    }
    async function trig(x, cosine) {
      const halfPi = divInt(await pi(), 2n), ratio = div(x, halfPi);
      const left = floorDiv(ratio.lo + unit / 2n, unit), right = floorDiv(ratio.hi + unit / 2n, unit);
      if (left !== right) throw new MorePrecision();
      const reduced = sub(x, mulInt(halfPi, left));
      if (magnitude(reduced) > unit) throw new MorePrecision();
      const quadrant = Number((left % 4n + 4n) % 4n);
      const useCosine = cosine ? quadrant % 2 === 0 : quadrant % 2 !== 0;
      const negative = cosine ? quadrant === 1 || quadrant === 2 : quadrant === 2 || quadrant === 3;
      const x2 = square(reduced); let term = useCosine ? one : reduced, sum = term;
      for (let k = 1; ; k++) {
        await budget.checkpoint();
        const denominator = useCosine ? BigInt((2 * k - 1) * (2 * k)) : BigInt((2 * k) * (2 * k + 1));
        term = neg(divInt(mul(term, x2), denominator));
        if (magnitude(term) <= 2n) { const result = around(sum, magnitude(term)); return negative ? neg(result) : result; }
        sum = add(sum, term);
      }
    }
    async function atan(x) {
      if (x.lo === 0n && x.hi === 0n) return zero;
      if (x.hi <= 0n) return neg(await atan(neg(x)));
      if (x.lo < 0n) throw new MorePrecision();
      const reciprocal = x.hi > unit;
      if (reciprocal) x = div(one, x);
      for (let i = 0; i < 2; i++) x = div(x, add(one, await sqrt(add(one, square(x)))));
      const result = mulInt(await atanSmall(x), 4n);
      return reciprocal ? sub(divInt(await pi(), 2n), result) : result;
    }
    async function logNear(x) {
      const t = div(sub(x, one), add(x, one)), t2 = square(t);
      if (magnitude(t) * 2n > unit) throw new MorePrecision();
      let power = t, sum = t;
      for (let k = 1; ; k++) {
        await budget.checkpoint(); power = mul(power, t2);
        const term = divInt(power, BigInt(2 * k + 1));
        if (magnitude(term) <= 2n) return around(mulInt(sum, 2n), magnitude(term) * 4n);
        sum = add(sum, term);
      }
    }
    async function log(x) {
      if (x.lo <= 0n) throw new MorePrecision();
      let power = 0n;
      while (x.lo >= 2n * unit) { await budget.checkpoint(); x = divInt(x, 2n); power++; }
      while (x.hi < unit) { await budget.checkpoint(); x = mulInt(x, 2n); power--; }
      return add(await logNear(x), mulInt(await logNear(mulInt(one, 2n)), power));
    }
    async function exp(x) {
      if (x.hi < 0n) return div(one, await exp(neg(x)));
      if (x.lo < 0n) throw new MorePrecision();
      let squarings = 0;
      while (x.hi * 2n > unit) { await budget.checkpoint(); x = divInt(x, 2n); squarings++; }
      let sum = one, term = one;
      for (let k = 1; ; k++) {
        await budget.checkpoint(); term = divInt(mul(term, x), BigInt(k));
        if (magnitude(term) <= 2n) { sum = { lo: sum.lo, hi: sum.hi + 2n * magnitude(term) }; break; }
        sum = add(sum, term);
      }
      while (squarings--) { await budget.checkpoint(); sum = square(sum); }
      return sum;
    }
    async function bessel(order, x) {
      let sign = 1n;
      if (order < 0n) { order = -order; if (order % 2n) sign = -sign; }
      if (x.hi <= 0n) { x = neg(x); if (order % 2n) sign = -sign; }
      if (x.lo < 0n) throw new MorePrecision();
      let term = one;
      for (let k = 1n; k <= order; k++) { await budget.checkpoint(); term = divInt(mul(term, x), 2n * k); }
      let sum = term;
      const x2 = divInt(square(x), 4n);
      for (let k = 1n; ; k++) {
        await budget.checkpoint();
        const divisor = k * (order + k);
        term = neg(divInt(mul(term, x2), divisor));
        if (x2.hi < divisor * unit && magnitude(term) <= 2n) return mulInt(around(sum, magnitude(term)), sign);
        sum = add(sum, term);
      }
    }
    return { from, trig, atan, log, exp, bessel };
  }
  return {
    async call(name, args, scale) {
      if (!['s', 'c', 'a', 'l', 'e', 'j'].includes(name)) fail(`unknown math library function ${name}`);
      if (args.length !== (name === 'j' ? 2 : 1)) fail(`wrong argument count for ${name}`);
      if (!Number.isSafeInteger(scale) || scale < 0 || scale > maxScale) fail('math library scale exceeds its limit');
      const x = args[name === 'j' ? 1 : 0];
      if (name === 'l' && x.coefficient <= 0n) fail('logarithm requires a positive argument');
      const target = (coefficient) => {
        if (digits(coefficient) > maxDigits) fail('math result exceeds the decimal digit limit');
        return Object.freeze({ coefficient, scale });
      };
      let order = 0n;
      if (name === 'j') {
        order = args[0].coefficient / checkedPower(args[0].scale);
        if (abs(order) > BigInt(maxExponent)) fail('Bessel order exceeds the exponent resource limit');
      }
      if (x.coefficient === 0n) {
        if (name === 'c' || name === 'e' || name === 'j' && order === 0n) return target(checkedPower(scale));
        return target(0n);
      }
      if (name === 'l' && x.coefficient === checkedPower(x.scale)) return target(0n);
      const xWhole = abs(x.coefficient) / checkedPower(x.scale);
      if (name === 'e' && x.coefficient < 0n && xWhole >= BigInt(3 * (scale + 1))) return target(0n);
      if (name === 'e' && x.coefficient > 0n && xWhole > BigInt(3 * maxDigits)) fail('exponential result exceeds the decimal digit limit');
      const integerDigits = Math.max(0, digits(x.coefficient) - x.scale);
      let extra = name === 's' || name === 'c' ? integerDigits : 0;
      if (name === 'e' || name === 'j') {
        if (xWhole > BigInt(maxScratchScale)) fail('math argument requires scratch precision beyond the resource limit');
        extra = Number(xWhole / 2n) + 2;
      }
      let guard = 16;
      for (;;) {
        await budget.checkpoint();
        const precision = scale + extra + guard;
        if (precision > maxScratchScale) fail('math result could not be certified within the precision resource limit');
        const release = budget.reserveRetained((precision + integerDigits + 1) * 16 + 256);
        try {
          const work = engine(precision), input = work.from(x);
          const result = name === 's' || name === 'c' ? await work.trig(input, name === 'c')
            : name === 'a' ? await work.atan(input) : name === 'l' ? await work.log(input)
              : name === 'e' ? await work.exp(input) : await work.bessel(order, input);
          const divisor = checkedPower(precision - scale), lo = result.lo / divisor, hi = result.hi / divisor;
          if (lo === hi) {
            if (digits(lo) > maxDigits) fail('math result exceeds the decimal digit limit');
            return target(lo);
          }
        } catch (error) { if (!(error instanceof MorePrecision)) throw error; }
        finally { release(); }
        guard *= 2;
      }
    },
  };
}
