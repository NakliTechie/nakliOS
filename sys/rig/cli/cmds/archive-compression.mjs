// RFC1951 framing plus RFC1952 members. The platform performs the byte transform;
// framing determines exact boundaries and expanded sizes before decompression.
import { ShellInterrupted } from '../execution.mjs';
import { checksumNumber } from './digest-algorithms.mjs';
import { checkRange, read16, read32, put32, joinBytes } from './archive-common.mjs';

const lengthBase = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const lengthExtra = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const distanceBase = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const distanceExtra = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
const codeOrder = [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15];

function huffman(ctx, lengths, { empty = false } = {}) {
  const counts = new Uint16Array(16), next = new Uint16Array(16), maps = Array.from({ length: 16 }, () => new Map());
  let symbols = 0, maximum = 0;
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15) ctx.fail('invalid DEFLATE code length');
    if (length) { counts[length]++; symbols++; maximum = Math.max(maximum, length); }
  }
  if (!symbols && !empty) ctx.fail('empty DEFLATE alphabet');
  let remaining = 1, code = 0;
  for (let bits = 1; bits <= 15; bits++) {
    remaining = remaining * 2 - counts[bits];
    if (remaining < 0) ctx.fail('oversubscribed DEFLATE alphabet');
    code = (code + (counts[bits - 1] || 0)) * 2; next[bits] = code;
  }
  if (remaining && symbols > 1) ctx.fail('incomplete DEFLATE alphabet');
  for (let symbol = 0; symbol < lengths.length; symbol++) {
    const length = lengths[symbol]; if (length) maps[length].set(next[length]++, symbol);
  }
  return { maps, maximum };
}

export async function scanDeflate(ctx, bytes, start = 0, maximum = ctx.remainingExpanded) {
  checkRange(ctx, bytes, start, 1); let bit = start * 8, expanded = 0;
  const take = (count) => {
    if (bit + count > bytes.length * 8) ctx.fail('truncated DEFLATE stream');
    let result = 0;
    for (let i = 0; i < count; i++, bit++) result |= (bytes[Math.floor(bit / 8)] >>> (bit % 8) & 1) << i;
    return result;
  };
  const symbol = (table) => {
    let code = 0;
    for (let bits = 1; bits <= table.maximum; bits++) {
      code = code * 2 + take(1);
      const found = table.maps[bits].get(code); if (found !== undefined) return found;
    }
    ctx.fail('invalid DEFLATE symbol');
  };
  const grow = (count) => { expanded += count; if (expanded > maximum) ctx.fail('expanded bytes exceed the resource limit'); };
  let final;
  do {
    await ctx.budget.checkpoint(); final = take(1); const type = take(2);
    if (type === 0) {
      bit = Math.ceil(bit / 8) * 8; const length = take(16), inverse = take(16);
      if ((length ^ 65535) !== inverse) ctx.fail('invalid stored DEFLATE length');
      checkRange(ctx, bytes, bit / 8, length); grow(length); bit += length * 8; continue;
    }
    if (type === 3) ctx.fail('reserved DEFLATE block type');
    let literals, distances;
    if (type === 1) {
      literals = huffman(ctx, Array.from({ length: 288 }, (_, i) => i < 144 ? 8 : i < 256 ? 9 : i < 280 ? 7 : 8));
      distances = huffman(ctx, Array(32).fill(5));
    } else {
      const literalCount = take(5) + 257, distanceCount = take(5) + 1, codeCount = take(4) + 4;
      if (literalCount > 286) ctx.fail('reserved DEFLATE literal alphabet size');
      const codes = Array(19).fill(0);
      for (let i = 0; i < codeCount; i++) codes[codeOrder[i]] = take(3);
      const table = huffman(ctx, codes), lengths = [];
      while (lengths.length < literalCount + distanceCount) {
        await ctx.budget.checkpoint(); const value = symbol(table);
        if (value < 16) lengths.push(value);
        else {
          if (value === 16 && !lengths.length) ctx.fail('DEFLATE repeat has no preceding length');
          const count = value === 16 ? take(2) + 3 : value === 17 ? take(3) + 3 : take(7) + 11;
          if (lengths.length + count > literalCount + distanceCount) ctx.fail('DEFLATE code-length repeat exceeds its alphabet');
          const length = value === 16 ? lengths.at(-1) : 0;
          for (let i = 0; i < count; i++) lengths.push(length);
        }
      }
      if (!lengths[256]) ctx.fail('DEFLATE alphabet has no end marker');
      literals = huffman(ctx, lengths.slice(0, literalCount));
      distances = huffman(ctx, lengths.slice(literalCount), { empty: true });
    }
    while (true) {
      await ctx.budget.checkpoint(); const value = symbol(literals);
      if (value < 256) { grow(1); continue; }
      if (value === 256) break;
      if (value > 285) ctx.fail('reserved DEFLATE length symbol');
      const index = value - 257, length = lengthBase[index] + take(lengthExtra[index]);
      const distanceSymbol = symbol(distances);
      if (distanceSymbol > 29) ctx.fail('reserved DEFLATE distance symbol');
      const distance = distanceBase[distanceSymbol] + take(distanceExtra[distanceSymbol]);
      if (distance > expanded || distance > 32768) ctx.fail('DEFLATE distance precedes available history');
      grow(length);
    }
  } while (!final);
  ctx.budget.check(); return { end: Math.ceil(bit / 8), size: expanded };
}

async function transform(ctx, data, decompress, maximum) {
  ctx.budget.check();
  const Constructor = decompress ? globalThis.DecompressionStream : globalThis.CompressionStream;
  if (typeof Constructor !== 'function') ctx.fail('platform compression streams are unavailable');
  let stream;
  try { stream = new Constructor('deflate-raw'); }
  catch (_) { ctx.fail('this platform does not support deflate-raw compression streams'); }
  const source = new ReadableStream({ start(controller) { controller.enqueue(data); controller.close(); } });
  const reader = source.pipeThrough(stream, { signal: ctx.signal ?? undefined }).getReader();
  const chunks = [], releases = []; let size = 0;
  try {
    while (true) {
      ctx.budget.check(); const item = await reader.read(); ctx.budget.check();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > maximum) ctx.fail('transformed bytes exceed the resource limit');
      releases.push(ctx.budget.reserveRetained(item.value.byteLength)); chunks.push(item.value);
      await ctx.budget.checkpoint();
    }
    return joinBytes(ctx, chunks, maximum);
  } catch (error) {
    if (ctx.signal?.aborted) throw new ShellInterrupted();
    if (error?.name === 'ArchiveError' || error?.name === 'ArgError' || error?.shellFlow) throw error;
    ctx.fail(`invalid compressed data: ${error.message}`);
  } finally {
    try { await reader.cancel(); } catch (_) { /* preserve the owning failure */ }
    reader.releaseLock(); for (const release of releases) release();
  }
}

export async function inflateRaw(ctx, bytes, expected) {
  const frame = await scanDeflate(ctx, bytes);
  if (frame.end !== bytes.length) ctx.fail('trailing bytes after DEFLATE stream');
  if (expected !== undefined && frame.size !== expected) ctx.fail('compressed and declared expanded sizes disagree');
  ctx.expand(frame.size);
  const result = await transform(ctx, bytes, true, frame.size);
  if (result.length !== frame.size) ctx.fail('platform decompression size disagrees with framing');
  return result;
}
export const deflateRaw = (ctx, bytes) => transform(ctx, bytes, false, ctx.limits.maxOutputBytes);
export async function gzipBytes(ctx, bytes) {
  ctx.expand(bytes.length);
  const compressed = await deflateRaw(ctx, bytes), header = Uint8Array.of(31,139,8,0,0,0,0,0,0,255), trailer = new Uint8Array(8);
  put32(trailer, 0, await checksumNumber('crc32b', bytes, { context: ctx })); put32(trailer, 4, bytes.length >>> 0);
  return joinBytes(ctx, [header, compressed, trailer]);
}
export async function gunzipBytes(ctx, bytes) {
  let at = 0, members = 0; const results = [];
  while (at < bytes.length) {
    await ctx.budget.checkpoint(); const start = at;
    if (members && bytes[at] === 0) {
      for (; at < bytes.length; at++) { if ((at & 4095) === 0) await ctx.budget.checkpoint(); if (bytes[at] !== 0) ctx.fail('trailing junk after gzip member'); }
      break;
    }
    if (++members > ctx.limits.maxFiles) ctx.fail('gzip member count exceeds the resource limit');
    checkRange(ctx, bytes, at, 10);
    if (bytes[at] !== 31 || bytes[at + 1] !== 139 || bytes[at + 2] !== 8) ctx.fail('invalid gzip header or compression method');
    const flags = bytes[at + 3]; if (flags & 224) ctx.fail('reserved gzip header flags'); at += 10;
    if (flags & 4) { const length = read16(ctx, bytes, at); at += 2; checkRange(ctx, bytes, at, length); at += length; }
    for (const flag of [8,16]) if (flags & flag) {
      while (true) { checkRange(ctx, bytes, at, 1); if (at - start > ctx.limits.maxHeaderBytes) ctx.fail('gzip header exceeds its resource limit'); if (bytes[at++] === 0) break; }
    }
    if (at - start > ctx.limits.maxHeaderBytes) ctx.fail('gzip header exceeds its resource limit');
    if (flags & 2) {
      const expected = read16(ctx, bytes, at), actual = await checksumNumber('crc32b', bytes.subarray(start, at), { context: ctx });
      if ((actual & 65535) !== expected) ctx.fail('gzip header checksum mismatch'); at += 2;
    }
    const frame = await scanDeflate(ctx, bytes, at); checkRange(ctx, bytes, frame.end, 8);
    const crc = read32(ctx, bytes, frame.end), expected = read32(ctx, bytes, frame.end + 4);
    if (frame.size !== expected) ctx.fail('gzip expanded size mismatch');
    ctx.expand(frame.size);
    const output = await transform(ctx, bytes.subarray(at, frame.end), true, frame.size);
    if (output.length !== frame.size || await checksumNumber('crc32b', output, { context: ctx }) !== crc) ctx.fail('gzip data checksum mismatch');
    results.push(output); at = frame.end + 8;
  }
  if (!members) ctx.fail('empty gzip input');
  return joinBytes(ctx, results, ctx.limits.maxExpandedBytes);
}
