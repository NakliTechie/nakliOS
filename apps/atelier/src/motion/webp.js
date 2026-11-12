// Animated WebP muxer, Atelier's own: wraps still WebP files (one per frame, from the browser's canvas
// WebP encoder) into one animated WebP (RIFF 'WEBP' with VP8X, ANIM and one ANMF chunk per frame), per
// the WebP container specification. Pure code: the still encoding happens in the browser.

const fourcc = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const le32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) >>> 0;

// Chunks of a RIFF WebP: [{ id, data }] (data without the 8-byte header, unpadded).
export function webpChunks(bytes) {
  if (fourcc(bytes, 0) !== 'RIFF' || fourcc(bytes, 8) !== 'WEBP') throw new Error('not a WebP file');
  const out = []; let o = 12;
  while (o + 8 <= bytes.length) {
    const id = fourcc(bytes, o); const n = le32(bytes, o + 4);
    out.push({ id, data: bytes.subarray(o + 8, o + 8 + n) });
    o += 8 + n + (n & 1);
  }
  return out;
}

function chunk(id, data) {
  const pad = data.length & 1; const out = new Uint8Array(8 + data.length + pad);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  out[4] = data.length & 255; out[5] = (data.length >> 8) & 255; out[6] = (data.length >> 16) & 255; out[7] = (data.length >>> 24) & 255;
  out.set(data, 8); return out;
}
const u24 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255];
const cat = (parts) => { const n = parts.reduce((s, p) => s + p.length, 0); const o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };

// stills: [Uint8Array WebP], all width × height. durationMs per frame; loop 0 = forever.
export function muxAnimatedWebp(stills, { width, height, durationMs = 83, loop = 0, background = [0, 0, 0, 0] }) {
  let alpha = false;
  const frames = stills.map((s) => {
    const ch = webpChunks(s).filter((c) => c.id === 'ALPH' || c.id === 'VP8 ' || c.id === 'VP8L');
    if (!ch.some((c) => c.id === 'VP8 ' || c.id === 'VP8L')) throw new Error('a frame has no VP8 or VP8L bitstream');
    if (ch.some((c) => c.id === 'ALPH' || c.id === 'VP8L')) alpha = true;
    // ANMF: X/2, Y/2 (24 bits each), width − 1, height − 1, duration (24 bits), flags: bit 1 = do not
    // blend (each frame replaces the canvas), bit 0 = dispose to background: both set.
    const head = Uint8Array.from([...u24(0), ...u24(0), ...u24(width - 1), ...u24(height - 1), ...u24(durationMs), 0x03]);
    return chunk('ANMF', cat([head, ...ch.map((c) => chunk(c.id, c.data))]));
  });
  // VP8X flags: 0x02 animation, 0x10 alpha.
  const vp8x = chunk('VP8X', Uint8Array.from([0x02 | (alpha ? 0x10 : 0), 0, 0, 0, ...u24(width - 1), ...u24(height - 1)]));
  // ANIM: background colour in B, G, R, A order, then the loop count (16 bits).
  const anim = chunk('ANIM', Uint8Array.from([background[2], background[1], background[0], background[3], loop & 255, (loop >> 8) & 255]));
  const body = cat([new TextEncoder().encode('WEBP'), vp8x, anim, ...frames]);
  const head = new Uint8Array(8); head.set(new TextEncoder().encode('RIFF'));
  head[4] = body.length & 255; head[5] = (body.length >> 8) & 255; head[6] = (body.length >> 16) & 255; head[7] = (body.length >>> 24) & 255;
  return cat([head, body]);
}
