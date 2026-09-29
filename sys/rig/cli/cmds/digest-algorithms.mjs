// Original JavaScript implementations from the algorithm specifications:
// MD5: RFC 1321 §3; SHA-224: RFC 6234 §§4–6; BLAKE2b: RFC 7693 §§2–3.
// These are unkeyed file checksums. See README.md for provenance and limits.
import { ArgError } from '../args.mjs';

const md5Constants = Uint32Array.from({ length: 64 }, (_, i) => Math.floor(2 ** 32 * Math.abs(Math.sin(i + 1))));
const shifts = [[7, 12, 17, 22], [5, 9, 14, 20], [4, 11, 16, 23], [6, 10, 15, 21]];
const shaConstants = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const rotate = (n, bits) => (n >>> bits) | (n << (32 - bits));
const mask64 = (1n << 64n) - 1n;
const iv64 = [0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
  0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n];
const sigma = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15],
  [14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3],
  [11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4],
  [7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8],
  [9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13],
  [2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9],
  [12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11],
  [13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10],
  [6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5],
  [10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0],
];

async function digest32(algorithm, bytes, ctx) {
  const md5 = algorithm === 'md5', release = ctx.budget.reserveRetained(1024);
  try {
    const state = Uint32Array.from(md5 ? [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476]
      : [0xc1059ed8, 0x367cd507, 0x3070dd17, 0xf70e5939, 0xffc00b31, 0x68581511, 0x64f98fa7, 0xbefa4fa4]);
    const block = new Uint8Array(64), view = new DataView(block.buffer), words = new Uint32Array(64);
    const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
    for (let offset = 0; offset < paddedLength; offset += 64) {
      await ctx.budget.checkpoint(); block.fill(0);
      block.set(bytes.subarray(offset, Math.min(offset + 64, bytes.length)));
      if (offset <= bytes.length && bytes.length < offset + 64) block[bytes.length - offset] = 128;
      if (offset + 64 === paddedLength) {
        const length = BigInt(bytes.length) * 8n;
        view.setUint32(md5 ? 56 : 60, Number(length & 0xffffffffn), md5);
        view.setUint32(md5 ? 60 : 56, Number(length >> 32n), md5);
      }
      for (let i = 0; i < 16; i++) words[i] = view.getUint32(i * 4, md5);
      let [a, b, c, d, e, f, g, h] = state;
      if (md5) {
        for (let i = 0; i < 64; i++) {
          const round = i >>> 4;
          const functionValue = round === 0 ? (b & c) | (~b & d) : round === 1 ? (b & d) | (c & ~d) : round === 2 ? b ^ c ^ d : c ^ (b | ~d);
          const index = round === 0 ? i : round === 1 ? (5 * i + 1) % 16 : round === 2 ? (3 * i + 5) % 16 : (7 * i) % 16;
          const add = (a + functionValue + md5Constants[i] + words[index]) | 0, shift = shifts[round][i % 4];
          [a, b, c, d] = [d, (b + ((add << shift) | (add >>> (32 - shift)))) | 0, b, c];
        }
        for (const [i, value] of [a, b, c, d].entries()) state[i] += value;
      } else {
        for (let i = 16; i < 64; i++) {
          const x = words[i - 15], y = words[i - 2];
          words[i] = words[i - 16] + (rotate(x, 7) ^ rotate(x, 18) ^ (x >>> 3)) + words[i - 7] + (rotate(y, 17) ^ rotate(y, 19) ^ (y >>> 10));
        }
        for (let i = 0; i < 64; i++) {
          const t1 = (h + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + shaConstants[i] + words[i]) | 0;
          const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
          [a, b, c, d, e, f, g, h] = [(t1 + t2) | 0, a, b, c, (d + t1) | 0, e, f, g];
        }
        for (const [i, value] of [a, b, c, d, e, f, g, h].entries()) state[i] += value;
      }
    }
    const result = new Uint8Array(md5 ? 16 : 28), resultView = new DataView(result.buffer);
    for (let i = 0; i < result.length / 4; i++) resultView.setUint32(i * 4, state[i], md5);
    return result;
  } finally { release(); }
}

async function blake2b(bytes, bits, ctx) {
  if (!Number.isInteger(bits) || bits < 8 || bits > 512 || bits % 8) throw new ArgError('blake2b: length must be 8..512 bits in multiples of 8');
  const release = ctx.budget.reserveRetained(4096);
  try {
    const state = [...iv64]; state[0] ^= 0x01010000n ^ BigInt(bits / 8);
    const block = new Uint8Array(128), view = new DataView(block.buffer);
    const rotr = (x, n) => ((x >> n) | (x << (64n - n))) & mask64;
    for (let offset = 0; offset < bytes.length || offset === 0; offset += 128) {
      await ctx.budget.checkpoint(12);
      block.fill(0); block.set(bytes.subarray(offset, offset + 128));
      const m = Array.from({ length: 16 }, (_, i) => view.getBigUint64(i * 8, true));
      const v = [...state, ...iv64], consumed = BigInt(Math.min(offset + 128, bytes.length));
      v[12] ^= consumed & mask64; v[13] ^= consumed >> 64n;
      if (offset + 128 >= bytes.length) v[14] ^= mask64;
      const mix = (a, b, c, d, x, y) => {
        v[a] = (v[a] + v[b] + x) & mask64; v[d] = rotr(v[d] ^ v[a], 32n);
        v[c] = (v[c] + v[d]) & mask64; v[b] = rotr(v[b] ^ v[c], 24n);
        v[a] = (v[a] + v[b] + y) & mask64; v[d] = rotr(v[d] ^ v[a], 16n);
        v[c] = (v[c] + v[d]) & mask64; v[b] = rotr(v[b] ^ v[c], 63n);
      };
      for (let r = 0; r < 12; r++) {
        const s = sigma[r % 10];
        for (let i = 0; i < 4; i++) mix(i, i + 4, i + 8, i + 12, m[s[i * 2]], m[s[i * 2 + 1]]);
        for (let i = 0; i < 4; i++) mix(i, ((i + 1) % 4) + 4, ((i + 2) % 4) + 8, ((i + 3) % 4) + 12, m[s[8 + i * 2]], m[s[9 + i * 2]]);
      }
      for (let i = 0; i < 8; i++) state[i] ^= v[i] ^ v[i + 8];
    }
    const result = new Uint8Array(bits / 8);
    for (let i = 0; i < result.length; i++) result[i] = Number((state[i >>> 3] >> BigInt((i % 8) * 8)) & 255n);
    return result;
  } finally { release(); }
}

export async function digestBytes(algorithm, bytes, { context: ctx, bits = 512, subtle = globalThis.crypto?.subtle } = {}) {
  if (!(bytes instanceof Uint8Array) || !ctx) throw new TypeError('digest requires bytes and a bounded context');
  ctx.budget.check();
  if (algorithm === 'md5' || algorithm === 'sha224') return digest32(algorithm, bytes, ctx);
  if (algorithm === 'blake2b') return blake2b(bytes, bits, ctx);
  const name = { sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' }[algorithm];
  if (!name) throw new ArgError(`unsupported checksum algorithm: ${algorithm}`);
  if (!subtle || typeof subtle.digest !== 'function') throw new ArgError(`${algorithm}: WebCrypto digest capability is unavailable`);
  await ctx.budget.checkpoint();
  let result;
  try { result = await subtle.digest(name, bytes); }
  catch (error) { ctx.budget.check(); throw new ArgError(`${algorithm}: WebCrypto digest failed: ${error.message}`); }
  ctx.budget.check(); // The platform operation cannot be cancelled; suppress late results.
  if (!(result instanceof ArrayBuffer) || result.byteLength !== { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[algorithm]) {
    throw new ArgError(`${algorithm}: WebCrypto returned an invalid digest`);
  }
  return new Uint8Array(result);
}

export async function checksumNumber(algorithm, bytes, { context: ctx } = {}) {
  if (!(bytes instanceof Uint8Array) || !ctx) throw new TypeError('checksum requires bytes and a bounded context');
  if (!['crc', 'crc32b', 'bsd', 'sysv'].includes(algorithm)) throw new ArgError(`unsupported checksum algorithm: ${algorithm}`);
  let value = algorithm === 'crc32b' ? 0xffffffff : 0;
  const crcByte = (byte) => {
    value ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) value = (value << 1) ^ (value < 0 ? 0x04c11db7 : 0);
  };
  for (let at = 0; at < bytes.length; at++) {
    if ((at & 255) === 0) await ctx.budget.checkpoint();
    const byte = bytes[at];
    if (algorithm === 'crc') crcByte(byte);
    else if (algorithm === 'crc32b') {
      value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    } else if (algorithm === 'bsd') value = (((value >>> 1) | ((value & 1) << 15)) + byte) & 65535;
    else value = (value + byte) >>> 0;
  }
  if (algorithm === 'crc') for (let length = bytes.length; length; length = Math.floor(length / 256)) crcByte(length & 255);
  if (algorithm === 'crc' || algorithm === 'crc32b') return (~value) >>> 0;
  if (algorithm === 'sysv') { value = (value & 65535) + (value >>> 16); value = (value & 65535) + (value >>> 16); }
  ctx.budget.check(); return value;
}
