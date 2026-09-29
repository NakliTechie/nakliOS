// Original bounded implementations of RFC 4648 and ZeroMQ Z85 encodings.
// Base58 uses the Bitcoin alphabet. See README.md for provenance/contracts.
import { ArgError } from '../args.mjs';

export const ALPHABETS = Object.freeze({
  base64: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  base64url: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
  base32: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', base32hex: '0123456789ABCDEFGHIJKLMNOPQRSTUV',
  base16: '0123456789ABCDEF', base2lsbf: '01', base2msbf: '01',
  z85: '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ.-:+=^!/*?&<>()[]{}@%$#',
  base58: '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz',
});
const shapes = { base64: [6, 4], base64url: [6, 4], base32: [5, 8], base32hex: [5, 8],
  base16: [4, 2], base2lsbf: [1, 8], base2msbf: [1, 8] };
export class InvalidEncoding extends Error {
  constructor() { super('invalid input'); }
}
const invalid = () => { throw new InvalidEncoding(); };

// Buffers become owned output fragments when flushed. Scratch allocations and
// expansion are bounded before allocation; no per-byte fragment arrays grow.
function writer(ctx, wrap) {
  let buffer, release, used = 0, column = 0;
  const flush = () => {
    if (used) ctx.output.append(buffer.subarray(0, used));
    release?.(); buffer = null; used = 0;
  };
  const raw = (byte) => {
    if (used >= ctx.budget.remaining('outputBytes')) throw new ArgError(`${ctx.command}: output bytes exceed the resource limit`);
    if (!buffer) {
      const size = Math.min(4096, ctx.budget.remaining('outputBytes'));
      release = ctx.budget.reserveRetained(size); buffer = new Uint8Array(size);
    }
    buffer[used++] = byte;
    if (used === buffer.length) flush();
  };
  return {
    put(byte) { raw(byte); if (wrap && ++column === wrap) { raw(10); column = 0; } },
    end() { if (wrap && column) raw(10); flush(); },
    flush,
    dispose() { release?.(); },
  };
}

export function encodeDigestBase64(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length > 64) throw new TypeError('expected at most 64 digest bytes');
  const alphabet = ALPHABETS.base64; let text = '';
  for (let at = 0; at < bytes.length; at += 3) {
    const left = bytes.length - at, value = (bytes[at] << 16) | ((bytes[at + 1] ?? 0) << 8) | (bytes[at + 2] ?? 0);
    text += alphabet[value >>> 18] + alphabet[(value >>> 12) & 63]
      + (left > 1 ? alphabet[(value >>> 6) & 63] : '=') + (left > 2 ? alphabet[value & 63] : '=');
  }
  return text;
}

async function radix58(ctx, bytes, decode, ignore, out) {
  if (bytes.length > 8192) throw new ArgError(`${ctx.command}: base58 input exceeds 8192 bytes`);
  const alphabet = ALPHABETS.base58;
  const release = ctx.budget.reserveRetained(bytes.length * 12 + 16);
  try {
    const input = decode ? [] : bytes;
    if (decode) for (const byte of bytes) {
      await ctx.budget.checkpoint(); if (byte === 10) continue;
      const value = alphabet.indexOf(String.fromCharCode(byte));
      if (value < 0) { if (ignore) continue; invalid(); }
      input.push(value);
    }
    const sourceBase = decode ? 58 : 256, targetBase = decode ? 256 : 58;
    const digits = new Uint8Array(Math.ceil(input.length * (decode ? 0.733 : 1.366)) + 1);
    let zeroes = 0, length = 0;
    while (zeroes < input.length && input[zeroes] === 0) zeroes++;
    for (let at = zeroes; at < input.length; at++) {
      let carry = input[at];
      for (let i = 0; i < length; i++) {
        await ctx.budget.checkpoint(); carry += digits[i] * sourceBase;
        digits[i] = carry % targetBase; carry = Math.floor(carry / targetBase);
      }
      while (carry) { await ctx.budget.checkpoint(); digits[length++] = carry % targetBase; carry = Math.floor(carry / targetBase); }
    }
    for (let i = 0; i < zeroes; i++) { await ctx.budget.checkpoint(); out.put(decode ? 0 : 49); }
    for (let i = length - 1; i >= 0; i--) { await ctx.budget.checkpoint(); out.put(decode ? digits[i] : alphabet.charCodeAt(digits[i])); }
  } finally { release(); }
}

export async function transformEncoding(ctx, bytes, { format, decode = false, ignore = false, wrap = 76 }) {
  const alphabet = ALPHABETS[format];
  if (!alphabet) throw new ArgError(`${ctx.command}: unsupported encoding`);
  const out = writer(ctx, decode ? 0 : wrap);
  try {
    if (format === 'base58') await radix58(ctx, bytes, decode, ignore, out);
    else if (format === 'z85') {
      const group = []; const size = decode ? 5 : 4;
      for (let at = 0; at < bytes.length; at++) {
        if ((at & 255) === 0) await ctx.budget.checkpoint();
        let value = bytes[at];
        if (decode) {
          if (value === 10) continue;
          value = alphabet.indexOf(String.fromCharCode(value));
          if (value < 0) { if (ignore) continue; invalid(); }
        }
        group.push(value);
        if (group.length === size) {
          let number = group.reduce((n, digit) => n * (decode ? 85 : 256) + digit, 0);
          if (decode && number > 0xffffffff) invalid();
          const result = new Uint8Array(decode ? 4 : 5);
          for (let i = result.length - 1; i >= 0; i--) { result[i] = number % (decode ? 256 : 85); number = Math.floor(number / (decode ? 256 : 85)); }
          for (const digit of result) out.put(decode ? digit : alphabet.charCodeAt(digit));
          group.length = 0;
        }
      }
      if (group.length) invalid();
    } else {
      const [bits, quantum] = shapes[format], mask = (1 << bits) - 1;
      if (!decode) {
        let accumulator = 0, pending = 0, chars = 0;
        for (let at = 0; at < bytes.length; at++) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          if (format === 'base2lsbf') { for (let bit = 0; bit < 8; bit++) out.put(48 + ((bytes[at] >>> bit) & 1)); continue; }
          accumulator = (accumulator << 8) | bytes[at]; pending += 8;
          while (pending >= bits) { pending -= bits; out.put(alphabet.charCodeAt((accumulator >>> pending) & mask)); chars++; }
          accumulator &= (1 << pending) - 1;
        }
        if (pending) { out.put(alphabet.charCodeAt((accumulator << (bits - pending)) & mask)); chars++; }
        if (bits === 5 || bits === 6) while (chars % quantum) { out.put(61); chars++; }
      } else {
        let ended = false; const group = [];
        for (let at = 0; at < bytes.length; at++) {
          if ((at & 255) === 0) await ctx.budget.checkpoint();
          const byte = bytes[at]; if (byte === 10) continue;
          const normalized = format === 'base16' && byte >= 97 && byte <= 102 ? byte - 32 : byte;
          const value = alphabet.indexOf(String.fromCharCode(normalized)), padding = byte === 61 && (bits === 5 || bits === 6);
          if (value < 0 && !padding) { if (ignore) continue; invalid(); }
          if (ended) invalid();
          group.push(padding ? -1 : value);
          if (group.length !== quantum) continue;
          const pad = group.indexOf(-1), count = pad < 0 ? quantum : pad;
          if (pad >= 0 && (!group.slice(pad).every((n) => n === -1)
            || !(bits === 6 ? [2, 3] : [2, 4, 5, 7]).includes(count))) invalid();
          let accumulator = 0, pending = 0; const decoded = [];
          if (format === 'base2lsbf') decoded.push(group.reduce((n, bit, i) => n | (bit << i), 0));
          else {
            for (let i = 0; i < count; i++) {
              accumulator = (accumulator << bits) | group[i]; pending += bits;
              if (pending >= 8) { pending -= 8; decoded.push((accumulator >>> pending) & 255); }
              accumulator &= (1 << pending) - 1;
            }
            if (accumulator !== 0) invalid(); // canonical unused pad bits
          }
          for (const byte of decoded) out.put(byte);
          ended = pad >= 0; group.length = 0;
        }
        if (group.length) invalid();
      }
    }
    out.end();
  } catch (error) { out.flush(); throw error; }
  finally { out.dispose(); }
}
