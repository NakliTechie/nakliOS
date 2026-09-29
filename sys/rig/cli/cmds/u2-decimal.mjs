import { ArgError } from '../args.mjs';

const abs = (value) => value < 0n ? -value : value;
const modes = new Set(['trunc', 'floor', 'ceil', 'half-away', 'half-even']);

export function createDecimalMath({ budget, maxDigits = 10000, maxScale = 1000, maxExponent = 10000,
  maxScratchDigits = 2 * maxDigits + 2 * maxScale + 32, maxScratchScale = 2 * maxDigits + 2 * maxScale + 32 } = {}) {
  const fail = (message) => { throw new ArgError(`${budget?.command || 'decimal'}: ${message}`); };
  for (const [key, value] of Object.entries({ maxDigits, maxScale, maxExponent, maxScratchDigits, maxScratchScale })) {
    if (!Number.isSafeInteger(value) || value < (key.includes('Digits') ? 1 : 0)) fail(`invalid ${key} limit`);
  }
  if (maxScratchDigits < maxDigits || maxScratchScale < maxScale) fail('scratch limits cannot be smaller than public decimal limits');
  const charge = (count = 1) => { budget?.check(); budget?.spend('steps', count); };
  const reserve = (digits) => {
    if (!Number.isSafeInteger(digits) || digits > maxScratchDigits || digits < 0) fail(`decimal scratch exceeds the ${maxScratchDigits}-digit limit`);
    return budget?.reserveRetained(digits * 4 + 64) || (() => {});
  };
  const pow10 = (power) => {
    if (!Number.isSafeInteger(power) || power < 0 || power + 1 > maxScratchDigits) fail('decimal alignment exceeds the scratch digit limit');
    const release = reserve(power + 1);
    try { charge(Math.max(1, Math.ceil(power / 128))); return 10n ** BigInt(power); } finally { release(); }
  };
  // Fixed-size thresholds reject externally supplied oversized BigInts before
  // converting them to a decimal string for digit counting.
  reserve(maxScratchDigits); // the threshold remains retained for this math engine
  charge(); const scratchCeiling = 10n ** BigInt(maxScratchDigits);
  const digitsOf = (coefficient) => {
    if (typeof coefficient !== 'bigint') throw new TypeError('decimal coefficient must be BigInt');
    const value = abs(coefficient);
    if (value >= scratchCeiling) fail(`decimal exceeds the ${maxScratchDigits}-digit scratch limit`);
    return value.toString().length;
  };
  const inspect = (value, scratch = false) => {
    if (!value || !Number.isSafeInteger(value.scale) || value.scale < 0 || value.scale > (scratch ? maxScratchScale : maxScale)) fail('decimal scale exceeds the resource limit');
    const digits = digitsOf(value.coefficient);
    if (digits > (scratch ? maxScratchDigits : maxDigits)) fail(`decimal exceeds the ${maxDigits}-digit limit`);
    return digits;
  };
  const make = (coefficient, scale, scratch = false) => {
    const result = { coefficient, scale }; inspect(result, scratch); return Object.freeze(result);
  };
  const rounding = (mode) => { if (!modes.has(mode)) fail(`unsupported decimal rounding mode: ${mode}`); };
  const divideInteger = (numerator, denominator, mode) => {
    rounding(mode); if (!denominator) fail('division by zero');
    if (denominator < 0n) { numerator = -numerator; denominator = -denominator; }
    const quotient = numerator / denominator, remainder = numerator % denominator;
    if (!remainder || mode === 'trunc') return quotient;
    const sign = numerator < 0n ? -1n : 1n;
    if (mode === 'floor') return sign < 0n ? quotient - 1n : quotient;
    if (mode === 'ceil') return sign > 0n ? quotient + 1n : quotient;
    const twice = abs(remainder) * 2n;
    if (twice > denominator || twice === denominator && (mode === 'half-away' || quotient % 2n !== 0n)) return quotient + sign;
    return quotient;
  };
  const scaleChecked = (scale) => { if (!Number.isSafeInteger(scale) || scale < 0 || scale > maxScale) fail(`scale exceeds the ${maxScale} limit`); };
  function quantizeRaw(value, scale, mode) {
    scaleChecked(scale); rounding(mode); const digits = inspect(value, true);
    const difference = scale - value.scale;
    if (!difference) return make(value.coefficient, scale);
    if (difference > 0) {
      if (value.coefficient === 0n) return make(0n, scale);
      if (digits + difference > maxDigits) fail(`decimal exceeds the ${maxDigits}-digit limit`);
      const release = reserve(digits + difference);
      try { charge(); return make(value.coefficient * pow10(difference), scale); } finally { release(); }
    }
    if (-difference > digits) {
      const result = mode === 'floor' && value.coefficient < 0n ? -1n : mode === 'ceil' && value.coefficient > 0n ? 1n : 0n;
      return make(result, scale);
    }
    charge(); return make(divideInteger(value.coefficient, pow10(-difference), mode), scale);
  }
  const align = (value, scale) => value.coefficient * pow10(scale - value.scale);
  function addRaw(a, b, subtract = false) {
    const da = inspect(a, true), db = inspect(b, true), scale = Math.max(a.scale, b.scale);
    const size = Math.max(da + scale - a.scale, db + scale - b.scale) + 1;
    const release = reserve(size);
    try { charge(Math.max(1, Math.ceil(size / 128))); return make(align(a, scale) + (subtract ? -1n : 1n) * align(b, scale), scale, true); }
    finally { release(); }
  }
  function divideRaw(a, b, scale, mode) {
    const da = inspect(a, true), db = inspect(b, true); scaleChecked(scale); rounding(mode);
    if (!b.coefficient) fail('division by zero');
    const shift = b.scale + scale - a.scale;
    const size = Math.max(da + Math.max(0, shift), db + Math.max(0, -shift));
    const release = reserve(size);
    try {
      charge(Math.max(1, Math.ceil((da + db + Math.abs(shift)) / 64)));
      const numerator = a.coefficient * pow10(Math.max(0, shift));
      const denominator = b.coefficient * pow10(Math.max(0, -shift));
      return make(divideInteger(numerator, denominator, mode), scale);
    } finally { release(); }
  }
  async function rootInteger(number) {
    if (number < 2n) return number;
    let current = pow10(Math.ceil(digitsOf(number) / 2));
    for (;;) {
      await budget?.checkpoint(Math.max(1, Math.ceil(digitsOf(current) / 128)));
      const next = (current + number / current) / 2n;
      if (next >= current) return current;
      current = next;
    }
  }
  const math = {
    parse(text, { exponent = false } = {}) {
      if (typeof text !== 'string') throw new TypeError('decimal text must be a string');
      if (text.length > maxDigits + maxScale + String(maxExponent).length + 5) fail('decimal source exceeds the digit resource limit');
      const pattern = exponent ? /^([+-]?)([0-9]*)(?:\.([0-9]*))?(?:[eE]([+-]?[0-9]+))?$/ : /^([+-]?)([0-9]*)(?:\.([0-9]*))?$/;
      const match = pattern.exec(text);
      if (!match || !(match[2].length + (match[3]?.length || 0))) fail(`invalid decimal: ${text.slice(0, 80)}`);
      const expText = match[4] || '0';
      if (expText.replace(/^[+-]?0*/, '').length > String(maxExponent).length) fail('decimal exponent exceeds the resource limit');
      const exp = Number(expText);
      if (!Number.isSafeInteger(exp) || Math.abs(exp) > maxExponent) fail('decimal exponent exceeds the resource limit');
      let scale = (match[3]?.length || 0) - exp;
      if (scale > maxScale) fail(`scale exceeds the ${maxScale} limit`);
      const joined = match[2] + (match[3] || ''), significant = joined.replace(/^0+/, '') || '0';
      if (significant.length + Math.max(0, -scale) > maxDigits) fail(`decimal exceeds the ${maxDigits}-digit limit`);
      charge(Math.max(1, Math.ceil(text.length / 128)));
      let coefficient = BigInt(significant) * (match[1] === '-' ? -1n : 1n);
      if (scale < 0) { coefficient *= pow10(-scale); scale = 0; }
      return make(coefficient, scale);
    },
    integer(value) {
      if (typeof value === 'number') { if (!Number.isSafeInteger(value)) fail('integer is outside the exact number range'); value = BigInt(value); }
      charge(); return make(value, 0);
    },
    compare(a, b) {
      inspect(a); inspect(b); const scale = Math.max(a.scale, b.scale);
      const release = reserve(Math.max(digitsOf(a.coefficient) + scale - a.scale, digitsOf(b.coefficient) + scale - b.scale));
      try { charge(); const left = align(a, scale), right = align(b, scale); return left === right ? 0 : left < right ? -1 : 1; }
      finally { release(); }
    },
    negate(value) { inspect(value); charge(); return make(-value.coefficient, value.scale); },
    abs(value) { inspect(value); charge(); return make(abs(value.coefficient), value.scale); },
    add(a, b) { inspect(a); inspect(b); const value = addRaw(a, b); return make(value.coefficient, value.scale); },
    subtract(a, b) { inspect(a); inspect(b); const value = addRaw(a, b, true); return make(value.coefficient, value.scale); },
    multiply(a, b, target) {
      const size = inspect(a) + inspect(b), scale = a.scale + b.scale;
      if (scale > maxScratchScale) fail('product scale exceeds the scratch resource limit');
      const release = reserve(size);
      try {
        charge(Math.max(1, Math.ceil(size / 64)));
        const value = make(a.coefficient * b.coefficient, scale, true);
        return target ? quantizeRaw(value, target.scale, target.rounding) : make(value.coefficient, scale);
      } finally { release(); }
    },
    quantize(value, scale, mode) { inspect(value); return quantizeRaw(value, scale, mode); },
    divide(a, b, { scale, rounding: mode } = {}) { inspect(a); inspect(b); return divideRaw(a, b, scale, mode); },
    remainder(a, b, { quotientScale = 0 } = {}) {
      inspect(a); inspect(b);
      const quotient = divideRaw(a, b, quotientScale, 'trunc');
      const release = reserve(digitsOf(quotient.coefficient) + digitsOf(b.coefficient));
      try {
        const product = make(quotient.coefficient * b.coefficient, quotient.scale + b.scale, true);
        const value = addRaw(a, product, true); return make(value.coefficient, value.scale);
      } finally { release(); }
    },
    async power(value, exponent, { scale, rounding: mode } = {}) {
      inspect(value); scaleChecked(scale); rounding(mode);
      if (typeof exponent === 'number') { if (!Number.isSafeInteger(exponent)) fail('exponent must be an integer'); exponent = BigInt(exponent); }
      if (typeof exponent !== 'bigint' || abs(exponent) > BigInt(maxExponent)) fail(`exponent exceeds the ${maxExponent} limit`);
      if (exponent === 0n) return quantizeRaw(make(1n, 0), scale, mode);
      if (value.coefficient === 0n && exponent < 0n) fail('division by zero');
      const count = Number(abs(exponent)), productScale = value.scale * count;
      if (productScale > maxScratchScale) fail('power scale exceeds the scratch resource limit');
      const release = reserve(abs(value.coefficient) <= 1n ? 1 : digitsOf(value.coefficient) * count);
      try {
        let result = 1n, base = value.coefficient, remaining = abs(exponent);
        while (remaining) {
          await budget?.checkpoint(Math.max(1, Math.ceil((digitsOf(result) + digitsOf(base)) / 64)));
          if (remaining & 1n) result *= base;
          remaining >>= 1n; if (remaining) base *= base;
        }
        const raw = make(result, productScale, true);
        return exponent < 0n ? divideRaw(make(1n, 0), raw, scale, mode) : quantizeRaw(raw, scale, mode);
      } finally { release(); }
    },
    async sqrt(value, { scale, rounding: mode } = {}) {
      const digits = inspect(value); scaleChecked(scale); rounding(mode);
      if (value.coefficient < 0n) fail('square root of a negative value');
      const shift = 2 * scale - value.scale;
      const release = reserve(Math.max(digits + Math.max(0, shift), Math.max(0, -shift) + 1) + 2);
      try {
        const numerator = value.coefficient * pow10(Math.max(shift, 0)), denominator = pow10(Math.max(-shift, 0));
        let root = await rootInteger(numerator / denominator);
        const exact = root * root * denominator === numerator;
        if (!exact && mode === 'ceil') root++;
        else if (!exact && (mode === 'half-away' || mode === 'half-even')) {
          const middle = (2n * root + 1n) ** 2n * denominator, actual = 4n * numerator;
          if (actual > middle || actual === middle && (mode === 'half-away' || root % 2n)) root++;
        }
        return make(root, scale);
      } finally { release(); }
    },
    toFixed(value, { scale = value.scale, rounding: mode = 'trunc', trim = false } = {}) {
      const rounded = quantizeRaw(value, scale, mode), negative = rounded.coefficient < 0n;
      const digits = abs(rounded.coefficient).toString();
      const length = Math.max(digits.length, scale + 1) + (scale ? 1 : 0) + (negative ? 1 : 0);
      if (length > maxDigits + maxScale + 3) fail('formatted decimal exceeds the resource limit');
      const release = budget?.reserveRetained(length * 2) || (() => {});
      try {
        charge(Math.max(1, Math.ceil(length / 128)));
        const padded = digits.padStart(scale + 1, '0');
        let result = scale ? padded.slice(0, -scale) + '.' + padded.slice(-scale) : padded;
        if (trim && scale) result = result.replace(/0+$/, '').replace(/\.$/, '');
        return (negative ? '-' : '') + result;
      } finally { release(); }
    },
    toInteger(value, { rounding: mode = 'trunc' } = {}) { return quantizeRaw(value, 0, mode).coefficient; },
    digits(value) { inspect(value); return digitsOf(value.coefficient); },
  };
  return Object.freeze(math);
}
