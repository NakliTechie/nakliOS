// Independent byte fixtures. Do not import production archive parsers or encoders.
import { deflateRawSync, gzipSync, constants } from 'node:zlib';
export { gzipSync, constants };
export const binary = Uint8Array.from({ length: 769 }, (_, index) => (index * 73) & 255);
export const asBytes = (value = '') => typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value);
export function concat(...values) {
  const parts = values.map(asBytes), output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let at = 0; for (const part of parts) { output.set(part, at); at += part.length; } return output;
}
export function crc32(value) {
  let sum = 0xffffffff;
  for (const byte of asBytes(value)) { sum ^= byte; for (let bit = 0; bit < 8; bit++) sum = (sum >>> 1) ^ ((sum & 1) ? 0xedb88320 : 0); }
  return (sum ^ 0xffffffff) >>> 0;
}
export const view = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
function putText(bytes, offset, width, text) { bytes.set(asBytes(text).subarray(0, width), offset); }
function octal(bytes, offset, width, value) { putText(bytes, offset, width, Number(value).toString(8).padStart(width - 1, '0') + '\0'); }
export function tarHeader({ name, data = '', type = '0', size = asBytes(data).length, prefix = '', link = '' }) {
  const bytes = new Uint8Array(512);
  putText(bytes, 0, 100, name); octal(bytes, 100, 8, type === '5' ? 0o755 : 0o644);
  octal(bytes, 108, 8, 0); octal(bytes, 116, 8, 0); octal(bytes, 124, 12, size); octal(bytes, 136, 12, 0);
  bytes.fill(32, 148, 156); putText(bytes, 156, 1, type); putText(bytes, 157, 100, link);
  putText(bytes, 257, 6, 'ustar\0'); putText(bytes, 263, 2, '00'); putText(bytes, 345, 155, prefix);
  repairTarChecksum(bytes); return bytes;
}
export function repairTarChecksum(header) {
  header.fill(32, 148, 156);
  const sum = header.reduce((total, value) => total + value, 0);
  putText(header, 148, 8, sum.toString(8).padStart(6, '0') + '\0 '); return header;
}
export function tarFixture(entries) {
  return concat(...entries.flatMap((entry) => {
    const bytes = asBytes(entry.data); return [tarHeader(entry), bytes, new Uint8Array((512 - bytes.length % 512) % 512)];
  }), new Uint8Array(1024));
}
export function paxRecord(key, value) {
  const body = `${key}=${value}\n`; let length = asBytes(body).length + 2;
  while (asBytes(`${length} ${body}`).length !== length) length = asBytes(`${length} ${body}`).length;
  return `${length} ${body}`;
}
// Standards-level ZIP writer with configurable contradictions for negative tests.
export function zipFixture(entries, { disk = 0, endPatch } = {}) {
  const locals = [], centrals = []; let localOffset = 0;
  for (const entry of entries) {
    const name = asBytes(entry.name), data = asBytes(entry.data), method = entry.method ?? 0;
    const packed = entry.packed ? asBytes(entry.packed) : method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const flags = entry.flags ?? (entry.descriptor ? 8 : 0), checksum = entry.crc ?? crc32(data), size = entry.size ?? data.length;
    const local = new Uint8Array(30 + name.length), lv = view(local);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, entry.descriptor ? 0 : checksum, true); lv.setUint32(18, entry.descriptor ? 0 : packed.length, true);
    lv.setUint32(22, entry.descriptor ? 0 : size, true); lv.setUint16(26, name.length, true); local.set(name, 30);
    entry.localPatch?.(local);
    let descriptor = new Uint8Array(0);
    if (entry.descriptor) {
      descriptor = new Uint8Array(entry.descriptor === 'unsigned' ? 12 : 16); const dv = view(descriptor), base = descriptor.length === 16 ? 4 : 0;
      if (base) dv.setUint32(0, 0x08074b50, true);
      dv.setUint32(base, checksum, true); dv.setUint32(base + 4, packed.length, true); dv.setUint32(base + 8, size, true);
      entry.descriptorPatch?.(descriptor);
    }
    const central = new Uint8Array(46 + name.length), cv = view(central);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, (3 << 8) | 20, true); cv.setUint16(6, 20, true);
    cv.setUint16(8, flags, true); cv.setUint16(10, method, true); cv.setUint32(16, checksum, true);
    cv.setUint32(20, packed.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint32(38, entry.attributes ?? (((entry.name.endsWith('/') ? 0o40755 : 0o100644) << 16) >>> 0), true);
    cv.setUint32(42, localOffset, true); central.set(name, 46); entry.centralPatch?.(central);
    locals.push(local, packed, descriptor); centrals.push(central); localOffset += local.length + packed.length + descriptor.length;
  }
  const centralBytes = concat(...centrals), end = new Uint8Array(22), ev = view(end);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, disk, true); ev.setUint16(6, disk, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true); ev.setUint32(12, centralBytes.length, true); ev.setUint32(16, localOffset, true);
  endPatch?.(end); return concat(...locals, centralBytes, end);
}
export function gzipWithMetadata(data) {
  const standard = new Uint8Array(gzipSync(data)), header = standard.slice(0, 10); header[3] = 4 | 8 | 16 | 2;
  const prefix = concat(header, Uint8Array.of(3, 0, 7, 8, 9), 'fixture.bin\0', 'independent fixture\0');
  const headerCrc = crc32(prefix); return concat(prefix, Uint8Array.of(headerCrc & 255, (headerCrc >>> 8) & 255), standard.subarray(10));
}
