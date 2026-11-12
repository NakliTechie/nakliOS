// Animated GIF encoder (GIF89a), Atelier's own: per-frame median-cut palette of up to 255 colours plus
// one transparent index, nearest-colour mapping through a 15-bit lookup table, LZW compression, and the
// NETSCAPE2.0 loop extension. Pure code; runs in node tests and the browser.
//
// frames: [{ width, height, data: RGBA 8-bit straight alpha }], all the same size. Pixels with alpha < 128
// become transparent. delayCs: frame delay in centiseconds (GIF's unit). loop: 0 = forever.

// Median cut over a 32×32×32 histogram (5 bits per channel): repeatedly split the box with the most
// pixels × widest channel range at the pixel-weighted median of that channel; each box's colour is its
// pixel-weighted mean.
export function medianCut(data, maxColours = 255) {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < data.length; i += 4) if (data[i + 3] >= 128) hist[((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3)]++;
  const cells = []; for (let c = 0; c < 32768; c++) if (hist[c]) cells.push(c);
  if (!cells.length) return [[0, 0, 0]];
  const ch = (c, k) => (k === 0 ? c >> 10 : k === 1 ? (c >> 5) & 31 : c & 31);
  const box = (list) => {
    let n = 0; const lo = [31, 31, 31]; const hi = [0, 0, 0];
    for (const c of list) { n += hist[c]; for (let k = 0; k < 3; k++) { const v = ch(c, k); if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; } }
    return { list, n, lo, hi };
  };
  const boxes = [box(cells)];
  while (boxes.length < maxColours) {
    let best = -1; let bs = 0;
    boxes.forEach((b, i) => { const r = Math.max(...[0, 1, 2].map((k) => b.hi[k] - b.lo[k])); const s = r * b.n; if (r > 0 && s > bs) { bs = s; best = i; } });
    if (best < 0) break;
    const b = boxes[best];
    const k = [0, 1, 2].reduce((m, j) => (b.hi[j] - b.lo[j] > b.hi[m] - b.lo[m] ? j : m), 0);
    const sorted = b.list.slice().sort((p, q) => ch(p, k) - ch(q, k));
    let acc = 0; let cut = 1;
    for (let i = 0; i < sorted.length - 1; i++) { acc += hist[sorted[i]]; if (acc >= b.n / 2) { cut = i + 1; break; } cut = i + 1; }
    boxes.splice(best, 1, box(sorted.slice(0, cut)), box(sorted.slice(cut)));
  }
  return boxes.map((b) => {
    const s = [0, 0, 0];
    for (const c of b.list) for (let k = 0; k < 3; k++) s[k] += hist[c] * ((ch(c, k) << 3) | 4);
    return s.map((v) => Math.round(v / b.n));
  });
}

// Palette index per pixel; transparent pixels get index `transparent`.
export function mapPixels(data, palette, transparent) {
  const lut = new Int16Array(32768).fill(-1);
  const out = new Uint8Array(data.length / 4);
  for (let p = 0, i = 0; i < data.length; i += 4, p++) {
    if (data[i + 3] < 128) { out[p] = transparent; continue; }
    const c = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let ix = lut[c];
    if (ix < 0) {
      const r = (data[i] >> 3 << 3) | 4; const g = (data[i + 1] >> 3 << 3) | 4; const b = (data[i + 2] >> 3 << 3) | 4;
      let bd = Infinity;
      for (let k = 0; k < palette.length; k++) { const d = (palette[k][0] - r) ** 2 + (palette[k][1] - g) ** 2 + (palette[k][2] - b) ** 2; if (d < bd) { bd = d; ix = k; } }
      lut[c] = ix;
    }
    out[p] = ix;
  }
  return out;
}

// GIF LZW: variable code size from minCode + 1 up to 12 bits, clear code at start and when the table fills.
export function lzwEncode(indices, minCode) {
  const out = []; let cur = 0; let bits = 0;
  const clear = 1 << minCode; const eoi = clear + 1;
  let size = minCode + 1; let next = eoi + 1;
  let dict = new Map();
  const put = (code) => { cur |= code << bits; bits += size; while (bits >= 8) { out.push(cur & 255); cur >>>= 8; bits -= 8; } };
  put(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i]; const key = prefix * 4096 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    put(prefix);
    if (next < 4096) { dict.set(key, next++); if (next > (1 << size) && size < 12) size++; }
    else { put(clear); dict = new Map(); size = minCode + 1; next = eoi + 1; }
    prefix = k;
  }
  put(prefix); put(eoi);
  if (bits > 0) out.push(cur & 255);
  return Uint8Array.from(out);
}

// comment: optional text written as a GIF comment extension (the "edited" label for AI-edited layers).
export function encodeGif(frames, { delayCs = 8, loop = 0, comment = null } = {}) {
  const { width: W, height: H } = frames[0];
  const bytes = [];
  const u16 = (v) => bytes.push(v & 255, (v >> 8) & 255);
  const str = (s) => { for (const c of s) bytes.push(c.charCodeAt(0)); };
  str('GIF89a'); u16(W); u16(H);
  bytes.push(0x00, 0, 0);   // no global colour table; each frame carries its own
  bytes.push(0x21, 0xff, 11); str('NETSCAPE2.0'); bytes.push(3, 1); u16(loop); bytes.push(0);
  if (comment) { const c = [...String(comment)].map((ch) => (ch.charCodeAt(0) < 128 ? ch.charCodeAt(0) : 63)); bytes.push(0x21, 0xfe); for (let i = 0; i < c.length; i += 255) { const part = c.slice(i, i + 255); bytes.push(part.length, ...part); } bytes.push(0); }
  for (const f of frames) {
    if (f.width !== W || f.height !== H) throw new Error('all GIF frames must be the same size');
    const pal = medianCut(f.data, 255); const transparent = pal.length;
    const idx = mapPixels(f.data, pal, transparent);
    // Graphic control: dispose 2 (restore to background) so transparent areas do not keep the last frame.
    bytes.push(0x21, 0xf9, 4, (2 << 2) | 1); u16(delayCs); bytes.push(transparent, 0);
    const n = pal.length + 1; let bitsPer = 1; while ((1 << bitsPer) < n) bitsPer++;
    bytes.push(0x2c); u16(0); u16(0); u16(W); u16(H); bytes.push(0x80 | (bitsPer - 1));
    for (let i = 0; i < (1 << bitsPer); i++) { const c = pal[i] || [0, 0, 0]; bytes.push(c[0], c[1], c[2]); }
    const minCode = Math.max(2, bitsPer);
    bytes.push(minCode);
    const data = lzwEncode(idx, minCode);
    for (let i = 0; i < data.length; i += 255) { const n2 = Math.min(255, data.length - i); bytes.push(n2); for (let j = 0; j < n2; j++) bytes.push(data[i + j]); }
    bytes.push(0);
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}
