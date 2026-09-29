import { checkRange, read16, read32, put16, put32, joinBytes } from './archive-common.mjs';
import { encoder, decodeName, memberName } from './archive-files.mjs';
import { inflateRaw, deflateRaw } from './archive-compression.mjs';
import { checksumNumber } from './digest-algorithms.mjs';

function extraFields(ctx, bytes, start, length) {
  checkRange(ctx, bytes, start, length); const end = start + length;
  if (length > ctx.limits.maxHeaderBytes) ctx.fail('ZIP extra metadata exceeds the header limit');
  while (start < end) {
    ctx.budget.spend('steps'); if (end - start < 4) ctx.fail('truncated ZIP extra field');
    const kind = read16(ctx, bytes, start), size = read16(ctx, bytes, start + 2); start += 4;
    if (size > end - start) ctx.fail('truncated ZIP extra field');
    if (kind === 1 || kind === 0x9901) ctx.fail('ZIP64 and encrypted ZIP entries are unsupported'); start += size;
  }
}
const same = (a, b) => a.length === b.length && a.every((byte, index) => byte === b[index]);
export async function parseZip(ctx, bytes) {
  if (bytes.length < 22) ctx.fail('truncated ZIP end record');
  let end = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 65557); at--) {
    if ((at & 255) === 0) await ctx.budget.checkpoint();
    if (read32(ctx, bytes, at) === 0x06054b50 && at + 22 + read16(ctx, bytes, at + 20) === bytes.length) { end = at; break; }
  }
  if (end < 0) ctx.fail('missing ZIP end record');
  const count = read16(ctx, bytes, end + 10), directorySize = read32(ctx, bytes, end + 12), directoryOffset = read32(ctx, bytes, end + 16);
  if (read16(ctx, bytes, end + 4) || read16(ctx, bytes, end + 6) || read16(ctx, bytes, end + 8) !== count) ctx.fail('split ZIP archives are unsupported');
  if (count === 65535 || directorySize === 0xffffffff || directoryOffset === 0xffffffff) ctx.fail('ZIP64 archives are unsupported');
  if (directoryOffset + directorySize !== end) ctx.fail('ZIP central directory boundaries disagree');
  if (count > ctx.limits.maxFiles) ctx.fail('ZIP entry count exceeds the resource limit');
  const entries = [], ranges = []; let at = directoryOffset, expandedSize = 0;
  for (let i = 0; i < count; i++) {
    await ctx.budget.checkpoint(); ctx.budget.spend('files'); checkRange(ctx, bytes, at, 46);
    if (read32(ctx, bytes, at) !== 0x02014b50) ctx.fail('invalid ZIP central directory signature');
    const version = read16(ctx, bytes, at + 6), flags = read16(ctx, bytes, at + 8), method = read16(ctx, bytes, at + 10);
    const crc = read32(ctx, bytes, at + 16), packedSize = read32(ctx, bytes, at + 20), size = read32(ctx, bytes, at + 24);
    const nameLength = read16(ctx, bytes, at + 28), extraLength = read16(ctx, bytes, at + 30), commentLength = read16(ctx, bytes, at + 32);
    const local = read32(ctx, bytes, at + 42), attributes = read32(ctx, bytes, at + 38), platform = bytes[at + 5];
    if ([packedSize, size, local].includes(0xffffffff) || read16(ctx, bytes, at + 34)) ctx.fail('ZIP64 and split entries are unsupported');
    if (version > 20 || flags & ~0x080e) ctx.fail('encrypted or unsupported ZIP flags/version');
    if (![0, 8].includes(method) || method === 0 && flags & 6) ctx.fail(`unsupported ZIP compression method or flags: ${method}`);
    const unixKind = (attributes >>> 16) & 0xf000;
    if (platform === 3 && unixKind && ![0x4000, 0x8000].includes(unixKind)) ctx.fail('ZIP links and special files are unsupported');
    checkRange(ctx, bytes, at + 46, nameLength + extraLength + commentLength);
    if (at + 46 + nameLength + extraLength + commentLength > end) ctx.fail('ZIP central entry exceeds its directory');
    const rawName = bytes.subarray(at + 46, at + 46 + nameLength), text = decodeName(ctx, rawName);
    const directory = text.endsWith('/');
    if (platform === 3 && unixKind && (unixKind === 0x4000) !== directory || attributes & 16 && !directory) ctx.fail('ZIP directory metadata disagrees');
    const name = memberName(ctx, text, directory);
    if (directory && size) ctx.fail('ZIP directory contains file data');
    extraFields(ctx, bytes, at + 46 + nameLength, extraLength);
    expandedSize += size;
    if (expandedSize > ctx.remainingExpanded) ctx.fail('ZIP expanded bytes exceed the resource limit');
    checkRange(ctx, bytes, local, 30);
    if (read32(ctx, bytes, local) !== 0x04034b50 || read16(ctx, bytes, local + 4) !== version
      || read16(ctx, bytes, local + 6) !== flags || read16(ctx, bytes, local + 8) !== method) ctx.fail('ZIP local and central metadata disagree');
    const localNameLength = read16(ctx, bytes, local + 26), localExtraLength = read16(ctx, bytes, local + 28);
    checkRange(ctx, bytes, local + 30, localNameLength + localExtraLength);
    if (!same(rawName, bytes.subarray(local + 30, local + 30 + localNameLength))) ctx.fail('ZIP local and central filenames disagree');
    extraFields(ctx, bytes, local + 30 + localNameLength, localExtraLength);
    for (const [offset, expected] of [[14, crc], [18, packedSize], [22, size]]) {
      const actual = read32(ctx, bytes, local + offset);
      if (actual !== expected && (!(flags & 8) || actual !== 0)) ctx.fail('ZIP local and central CRC/size disagree');
    }
    const payload = local + 30 + localNameLength + localExtraLength; checkRange(ctx, bytes, payload, packedSize);
    let finish = payload + packedSize;
    if (flags & 8) {
      const matches = (base) => base + 12 <= directoryOffset && read32(ctx, bytes, base) === crc
        && read32(ctx, bytes, base + 4) === packedSize && read32(ctx, bytes, base + 8) === size;
      if (matches(finish)) finish += 12;
      else if (finish + 16 <= directoryOffset && read32(ctx, bytes, finish) === 0x08074b50 && matches(finish + 4)) finish += 16;
      else ctx.fail('ZIP data descriptor disagrees with central metadata');
    }
    if (finish > directoryOffset) ctx.fail('ZIP member overlaps central directory');
    ranges.push({ start: local, end: finish });
    entries.push({ name, directory, method, size, crc, packed: bytes.subarray(payload, payload + packedSize) });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== end) ctx.fail('ZIP entry count and central directory size disagree');
  ranges.sort((a, b) => a.start - b.start); let previous = 0;
  for (const range of ranges) {
    if (range.start !== previous) ctx.fail('ZIP members overlap or contain unsupported intervening records'); previous = range.end;
  }
  if (previous !== directoryOffset) ctx.fail('ZIP contains unsupported leading or intervening records');
  for (const entry of entries) {
    await ctx.budget.checkpoint();
    if (entry.method === 0) {
      if (entry.packed.length !== entry.size) ctx.fail('stored ZIP size mismatch');
      ctx.expand(entry.size); entry.data = entry.packed;
    } else entry.data = await inflateRaw(ctx, entry.packed, entry.size);
    if (await checksumNumber('crc32b', entry.data, { context: ctx }) !== entry.crc) ctx.fail('ZIP data checksum mismatch');
  }
  return entries;
}
export async function createZip(ctx, entries, { stored = false } = {}) {
  if (entries.length >= 65535 || entries.length > ctx.limits.maxFiles) ctx.fail('ZIP entry count exceeds the resource limit');
  const locals = [], central = []; let offset = 0;
  for (const entry of entries) {
    await ctx.budget.checkpoint();
    const name = encoder.encode((entry.name || '.') + (entry.directory ? '/' : ''));
    if (name.length > 65535) ctx.fail('ZIP pathname exceeds its format limit');
    const method = stored || entry.directory ? 0 : 8;
    const packed = method === 0 ? entry.data : await deflateRaw(ctx, entry.data);
    const crc = await checksumNumber('crc32b', entry.data, { context: ctx });
    const local = new Uint8Array(30 + name.length), record = new Uint8Array(46 + name.length);
    put32(local, 0, 0x04034b50); put16(local, 4, 20); put16(local, 6, 0x800); put16(local, 8, method); put16(local, 12, 33);
    put32(local, 14, crc); put32(local, 18, packed.length); put32(local, 22, entry.data.length); put16(local, 26, name.length); local.set(name, 30);
    put32(record, 0, 0x02014b50); put16(record, 4, 0x314); put16(record, 6, 20); put16(record, 8, 0x800); put16(record, 10, method); put16(record, 14, 33);
    put32(record, 16, crc); put32(record, 20, packed.length); put32(record, 24, entry.data.length); put16(record, 28, name.length);
    put32(record, 38, ((entry.directory ? 0o40755 : 0o100644) << 16) | (entry.directory ? 16 : 0)); put32(record, 42, offset); record.set(name, 46);
    locals.push(local, packed); central.push(record); offset += local.length + packed.length;
    if (offset > ctx.limits.maxOutputBytes) ctx.fail('ZIP output exceeds the byte resource limit');
  }
  const directory = joinBytes(ctx, central), end = new Uint8Array(22);
  put32(end, 0, 0x06054b50); put16(end, 8, entries.length); put16(end, 10, entries.length); put32(end, 12, directory.length); put32(end, 16, offset);
  return joinBytes(ctx, [...locals, directory, end]);
}
