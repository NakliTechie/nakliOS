// C-locale formatting shared by printf, sprintf, OFMT, and CONVFMT.
import { ArgError } from '../args.mjs';
const fail = (message) => { throw new ArgError(`awk: ${message}`); };
// Round the exact binary64 rational using C's default nearest-even rule.
// Decimal scaling stays below 10^425 because supported precision is <=100.
const bits = new DataView(new ArrayBuffer(8));
function decimalInteger(value, places) {
  bits.setFloat64(0, value);
  const raw = bits.getBigUint64(0), biased = Number((raw >> 52n) & 2047n);
  let numerator = (raw & ((1n << 52n) - 1n)) + (biased ? 1n << 52n : 0n), denominator = 1n;
  const power = biased ? biased - 1075 : -1074;
  if (power >= 0) numerator <<= BigInt(power); else denominator <<= BigInt(-power);
  if (places >= 0) numerator *= 10n ** BigInt(places); else denominator *= 10n ** BigInt(-places);
  let result = numerator / denominator;
  const twiceRemainder = (numerator % denominator) * 2n;
  if (twiceRemainder > denominator || twiceRemainder === denominator && result % 2n) result++;
  return result;
}
function scientific(value, significant) {
  let power = value === 0 ? 0 : Number(value.toExponential(17).split('e')[1]);
  let rounded = decimalInteger(value, significant - 1 - power);
  if (rounded >= 10n ** BigInt(significant)) { rounded /= 10n; power++; }
  return { digits: rounded.toString().padStart(significant, '0'), power };
}
const exponentText = (power) => `e${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`;
const decimalDigits = (digits, point) => point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
export function formatAwk(format, args, { number, string, numeric, maxBytes = 16777216 }) {
  let index = 0, output = '';
  const add = (text) => { if (output.length + text.length > maxBytes) fail('formatted output exceeds the buffer limit'); output += text; };
  const next = () => { if (index >= args.length) fail('not enough arguments for printf format'); return args[index++]; };
  for (let at = 0; at < format.length;) {
    if (format[at] !== '%') { const end = format.indexOf('%', at); add(format.slice(at, end < 0 ? format.length : end)); at = end < 0 ? format.length : end; continue; }
    at++;
    if (format[at] === '%') { add('%'); at++; continue; }
    let flags = '';
    while ('-+ #0'.includes(format[at] || '\0')) flags += format[at++];
    let width = 0, precision = null;
    if (format[at] === '*') { width = Math.trunc(number(next())); at++; }
    else { const m = /^\d+/.exec(format.slice(at)); if (m) { width = Number(m[0]); at += m[0].length; } }
    if (width < 0) { flags += '-'; width = -width; }
    if (format[at] === '.') {
      at++; precision = 0;
      if (format[at] === '*') { precision = Math.trunc(number(next())); at++; if (precision < 0) precision = null; }
      else { const m = /^\d+/.exec(format.slice(at)); if (m) { precision = Number(m[0]); at += m[0].length; } }
    }
    if (!Number.isSafeInteger(width) || width > maxBytes || precision != null && (!Number.isSafeInteger(precision) || precision > maxBytes)) fail('format width or precision exceeds the buffer limit');
    const conversion = format[at++];
    if (!conversion || !'cdiouxXeEfFgGs'.includes(conversion)) fail(`unsupported printf conversion %${conversion || ''}`);
    const value = next(); let text, prefix = '';
    if (conversion === 's') { text = string(value); if (precision != null) text = text.slice(0, precision); }
    else if (conversion === 'c') text = numeric(value) ? String.fromCharCode(Math.trunc(number(value)) & 255) : string(value).slice(0, 1) || '\0';
    else {
      const n = number(value), negative = n < 0 || Object.is(n, -0), magnitude = Math.abs(n);
      if ('diouxX'.includes(conversion)) {
        if (!Number.isFinite(n)) text = String(n).toLowerCase();
        else {
          const signed = conversion === 'd' || conversion === 'i';
          const integer = BigInt(Math.trunc(signed ? magnitude : n));
          text = (signed ? integer : BigInt.asUintN(64, integer)).toString(conversion === 'o' ? 8 : 'xX'.includes(conversion) ? 16 : 10);
          if (precision === 0 && integer === 0n) text = '';
          if (precision != null) text = text.padStart(precision, '0');
          if (signed) prefix = negative && integer !== 0n ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
          if (flags.includes('#') && conversion === 'o' && !text.startsWith('0')) prefix = '0';
          if (flags.includes('#') && 'xX'.includes(conversion) && integer !== 0n) prefix = conversion === 'X' ? '0X' : '0x';
          if (conversion === 'X') text = text.toUpperCase();
        }
      } else {
        const p = precision == null ? 6 : precision;
        if (p > 100) fail('floating-point precision exceeds 100');
        const kind = conversion.toLowerCase();
        if (!Number.isFinite(magnitude)) text = Number.isNaN(magnitude) ? 'nan' : 'inf';
        else if (kind === 'f') {
          const digits = decimalInteger(magnitude, p).toString().padStart(p + 1, '0');
          text = p ? digits.slice(0, -p) + '.' + digits.slice(-p) : digits;
        } else if (kind === 'e') {
          const { digits, power } = scientific(magnitude, p + 1);
          text = digits[0] + (p ? '.' + digits.slice(1) : '') + exponentText(power);
        } else {
          const significant = p || 1, { digits, power } = scientific(magnitude, significant);
          text = power < -4 || power >= significant ? digits[0] + (significant > 1 ? '.' + digits.slice(1) : '') + exponentText(power) : decimalDigits(digits, power + 1);
          if (!flags.includes('#')) text = text.replace(/(\.\d*?[1-9])0+(?=e|$)/, '$1').replace(/\.0*(?=e|$)/, '');
        }
        if (flags.includes('#') && Number.isFinite(magnitude) && !text.includes('.')) text = text.replace(/e|$/, '.e').replace(/e$/, '');
        prefix = negative ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        if (conversion === conversion.toUpperCase()) text = text.toUpperCase();
      }
    }
    const padding = Math.max(0, width - prefix.length - text.length);
    if (flags.includes('-')) add(prefix + text + ' '.repeat(padding));
    else if (flags.includes('0') && !'sc'.includes(conversion) && (!'diouxX'.includes(conversion) || precision == null)) add(prefix + '0'.repeat(padding) + text);
    else add(' '.repeat(padding) + prefix + text);
  }
  return output;
}
