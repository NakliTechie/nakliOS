// Minimal WebM muxer, Atelier's own: one video track (VP8 or VP9 chunks from the browser's WebCodecs
// VideoEncoder) written as EBML: header, Segment { Info, Tracks, Cluster... }. Built in memory, so every
// size is known; a new Cluster starts at each key frame. Pure code; runs in node tests.
//
// EBML element = ID bytes, size as a variable-length integer (vint: leading 1-bit marks the length),
// then the payload.

const te = new TextEncoder();
function vint(n) {
  for (let len = 1; len <= 8; len++) {
    if (n < 2 ** (7 * len) - 1) {
      const out = new Uint8Array(len); let v = n;
      for (let i = len - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
      out[0] |= 1 << (8 - len); return out;
    }
  }
  throw new Error('EBML size too large');
}
const idBytes = (id) => { const b = []; let v = id; while (v > 0) { b.unshift(v & 255); v = Math.floor(v / 256); } return Uint8Array.from(b); };
const cat = (parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const el = (id, payload) => cat([idBytes(id), vint(payload.length), payload]);
const uint = (id, v) => { const b = []; let x = v; do { b.unshift(x & 255); x = Math.floor(x / 256); } while (x > 0); return el(id, Uint8Array.from(b)); };
const str = (id, s) => el(id, te.encode(s));
const f64 = (id, v) => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return el(id, b); };

// chunks: [{ data: Uint8Array, timestampMs, key: boolean }] in decode order.
export function muxWebm(chunks, { width, height, codec = 'V_VP8', durationMs }) {
  const header = el(0x1a45dfa3, cat([uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), str(0x4282, 'webm'), uint(0x4287, 2), uint(0x4285, 2)]));
  const info = el(0x1549a966, cat([uint(0x2ad7b1, 1000000), str(0x4d80, 'Atelier'), str(0x5741, 'Atelier'), f64(0x4489, durationMs ?? (chunks.length ? chunks.at(-1).timestampMs : 0))]));
  const tracks = el(0x1654ae6b, el(0xae, cat([uint(0xd7, 1), uint(0x73c5, 1), uint(0x83, 1), str(0x86, codec), el(0xe0, cat([uint(0xb0, width), uint(0xba, height)]))])));
  const clusters = []; let cur = null;
  const flush = () => { if (cur) clusters.push(el(0x1f43b675, cat([uint(0xe7, cur.t), ...cur.blocks]))); };
  for (const c of chunks) {
    const t = Math.round(c.timestampMs);
    if (!cur || c.key || t - cur.t > 32000) { flush(); cur = { t, blocks: [] }; }
    const rel = t - cur.t;
    // SimpleBlock: track number (vint 0x81), signed 16-bit relative timecode, flags (0x80 = key frame).
    cur.blocks.push(el(0xa3, cat([Uint8Array.from([0x81, (rel >> 8) & 255, rel & 255, c.key ? 0x80 : 0]), c.data])));
  }
  flush();
  return cat([header, el(0x18538067, cat([info, tracks, ...clusters]))]);
}

// Reader: walks the EBML tree and returns the SimpleBlocks (one video track, no lacing) with absolute
// times in ms, plus the codec and size. Used by tests and by WebM video layers (src/motion/video.js).
// Handles known-size elements and the 'unknown size' marker on Segment and Cluster.
export function readWebm(bytes) {
  const readVint = (o, keepMarker) => { const b = bytes[o]; let len = 1; while (len <= 8 && !(b & (0x80 >> (len - 1)))) len++; let v = keepMarker ? b : b & ((0x80 >> (len - 1)) - 1); for (let i = 1; i < len; i++) v = v * 256 + bytes[o + i]; return { v, len }; };
  const MASTERS = new Set([0x18538067, 0x1654ae6b, 0xae, 0xe0, 0x1f43b675, 0x1549a966, 0xa0]);   // 0xa0 BlockGroup
  const out = { blocks: [], codec: null, width: 0, height: 0, docType: null };
  let clusterT = 0;
  const walk = (o, end) => {
    while (o < end) {
      const id = readVint(o, true); const sz = readVint(o + id.len, false); const p = o + id.len + sz.len; const q = sz.v === 2 ** (7 * sz.len) - 1 ? end : Math.min(end, p + sz.v);   // all-ones size = unknown (streamed files)
      const num = () => { let v = 0; for (let i = p; i < q; i++) v = v * 256 + bytes[i]; return v; };
      if (id.v === 0x1a45dfa3) walk(p, q);
      else if (MASTERS.has(id.v)) walk(p, q);
      else if (id.v === 0x4282) out.docType = new TextDecoder().decode(bytes.subarray(p, q));
      else if (id.v === 0x86) out.codec = new TextDecoder().decode(bytes.subarray(p, q));
      else if (id.v === 0xb0) out.width = num();
      else if (id.v === 0xba) out.height = num();
      else if (id.v === 0xe7) clusterT = num();
      else if (id.v === 0xa1) { const rel = (bytes[p + 1] << 24 >> 16) | bytes[p + 2]; out.blocks.push({ t: clusterT + rel, key: !out.blocks.length, size: q - p - 4, data: bytes.subarray(p + 4, q) }); }   // Block in a BlockGroup
      else if (id.v === 0xa3) { const rel = (bytes[p + 1] << 24 >> 16) | bytes[p + 2]; out.blocks.push({ t: clusterT + rel, key: !!(bytes[p + 3] & 0x80), size: q - p - 4, data: bytes.subarray(p + 4, q) }); }
      o = q;
    }
  };
  walk(0, bytes.length);
  return out;
}
