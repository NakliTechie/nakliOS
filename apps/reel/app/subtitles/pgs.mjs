/* PGS (Blu-ray bitmap subtitle) packets to a .sup byte stream. Pure.
 *
 * Matroska S_HDMV/PGS blocks hold PGS segments without the 13-byte .sup header
 * ("PG", 32-bit PTS and DTS at 90 kHz). libpgs reads .sup files, so each segment gets that
 * header back with the block's start time as its PTS. Packets that already start with "PG"
 * are copied unchanged. */

export function pgsPacketsToSup(packets) {
  const parts = [];
  let total = 0;
  const push = bytes => { parts.push(bytes); total += bytes.length; };
  for (const packet of packets) {
    const data = packet.data instanceof Uint8Array ? packet.data : new Uint8Array(packet.data);
    if (data.length >= 2 && data[0] === 0x50 && data[1] === 0x47) { push(data); continue; }
    const pts = Math.max(0, Math.round(Number(packet.startS || 0) * 90_000)) >>> 0;
    for (let at = 0; at + 3 <= data.length;) {
      const size = (data[at + 1] << 8) | data[at + 2];
      // A segment whose declared size runs past the packet is truncated: drop it and the rest
      // of the packet, rather than write a header that claims bytes it does not carry (V51).
      if (at + 3 + size > data.length) break;
      const end = at + 3 + size;
      const header = new Uint8Array(10);
      header[0] = 0x50; header[1] = 0x47;
      new DataView(header.buffer).setUint32(2, pts);
      push(header);
      push(data.subarray(at, end));
      at = end;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}

export function isBitmapCodec(codec) {
  return /pgs|hdmv|sup/i.test(String(codec || ''));
}
