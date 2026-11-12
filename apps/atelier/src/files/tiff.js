// Baseline TIFF reader and writer (P53, P48). Reader: little- or big-endian, strips or tiles,
// compression none (1), LZW (5), Deflate (8, 32946) and PackBits (32773), horizontal predictor (2),
// 8 or 16 bits, grayscale (photometric 0, 1) or RGB (2), with or without an alpha extra sample,
// every page (reduced-resolution thumbnails skipped). Writer: 8- or 16-bit RGB(A), Deflate with the
// horizontal predictor, one page per entry, PageName, ImageDescription, X/YPosition and an ICC
// profile (tag 34675). Pure code: node and browser (CompressionStream for Deflate).

const T = {
  NewSubfileType: 254, ImageWidth: 256, ImageLength: 257, BitsPerSample: 258, Compression: 259, Photometric: 262,
  ImageDescription: 270, StripOffsets: 273, SamplesPerPixel: 277, RowsPerStrip: 278, StripByteCounts: 279,
  XResolution: 282, YResolution: 283, PlanarConfig: 284, PageName: 285, XPosition: 286, YPosition: 287,
  ResolutionUnit: 296, PageNumber: 297, Software: 305, Predictor: 317, TileWidth: 322, TileLength: 323, TileOffsets: 324,
  TileByteCounts: 325, ExtraSamples: 338, SampleFormat: 339, ICC: 34675,
};
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

async function inflate(bytes, mode = 'decompress') {
  const s = mode === 'compress' ? new CompressionStream('deflate') : new DecompressionStream('deflate');
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(s)).arrayBuffer());
}

// TIFF LZW: MSB-first codes of 9 to 12 bits, Clear 256, EOI 257, code width grows one code early.
export function lzwDecode(src, expected) {
  const out = new Uint8Array(expected); let op = 0;
  const prefix = new Int32Array(4096); const suffix = new Uint8Array(4096); const len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { prefix[i] = -1; suffix[i] = i; len[i] = 1; }
  let bitPos = 0; let width = 9; let next = 258; let old = -1;
  const read = () => {
    let v = 0;
    for (let i = 0; i < width; i++) { const byte = src[(bitPos >> 3)]; v = (v << 1) | (byte === undefined ? 0 : (byte >> (7 - (bitPos & 7))) & 1); bitPos++; }
    return v;
  };
  const first = (c) => { while (prefix[c] >= 0) c = prefix[c]; return suffix[c]; };
  const emit = (c) => { const n = len[c]; let p = op + n - 1; for (let k = c; k >= 0 && p >= op; k = prefix[k]) { if (p < out.length) out[p] = suffix[k]; p--; } op += n; };
  while (bitPos + width <= src.length * 8 && op < expected) {
    const code = read();
    if (code === 257) break;
    if (code === 256) { width = 9; next = 258; old = -1; continue; }
    if (old < 0) { emit(code); old = code; continue; }
    if (code < next) { emit(code); prefix[next] = old; suffix[next] = first(code); len[next] = len[old] + 1; }
    else { prefix[next] = old; suffix[next] = first(old); len[next] = len[old] + 1; emit(next); }
    next++;
    if (next + 1 >= (1 << width) && width < 12) width++;
    old = code;
  }
  return out;
}

function packBits(src, expected) {
  const out = new Uint8Array(expected); let i = 0; let o = 0;
  while (i < src.length && o < expected) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n; k++) out[o++] = src[i++]; }
    else if (n !== -128) { const v = src[i++]; for (let k = 0; k < 1 - n; k++) out[o++] = v; }
  }
  return out;
}

// ---- reader ---------------------------------------------------------------------------------------
export async function readTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = dv.getUint16(0) === 0x4949;
  if (!le && dv.getUint16(0) !== 0x4d4d) throw new Error('not a TIFF');
  if (dv.getUint16(2, le) !== 42) throw new Error(dv.getUint16(2, le) === 43 ? 'BigTIFF is not supported' : 'not a TIFF');
  const u16 = (o) => dv.getUint16(o, le); const u32 = (o) => dv.getUint32(o, le);
  const pages = []; const seen = new Set();
  for (let ifd = u32(4); ifd && !seen.has(ifd); ) {
    seen.add(ifd);
    const n = u16(ifd); const tags = {};
    for (let i = 0; i < n; i++) {
      const e = ifd + 2 + i * 12; const tag = u16(e); const type = u16(e + 2); const count = u32(e + 4);
      const size = (TYPE_SIZE[type] || 1) * count; const at = size <= 4 ? e + 8 : u32(e + 8);
      const vals = [];
      if (type === 2 || type === 7 || type === 1) tags[tag] = bytes.subarray(at, at + count);
      else {
        for (let k = 0; k < count; k++) {
          if (type === 3) vals.push(u16(at + k * 2));
          else if (type === 4) vals.push(u32(at + k * 4));
          else if (type === 5) vals.push(u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
          else vals.push(0);
        }
        tags[tag] = vals;
      }
    }
    ifd = u32(ifd + 2 + n * 12);
    const sub = tags[T.NewSubfileType]?.[0] ?? 0;
    if (sub & 1) continue;   // reduced-resolution copy of another page
    pages.push(await decodePage(bytes, tags, le));
  }
  if (!pages.length) throw new Error('TIFF holds no full-resolution page');
  return { pages };
}

const text = (b) => (b ? new TextDecoder().decode(b).replace(/\0+$/, '') : null);

async function decodePage(bytes, tags, le) {
  const W = tags[T.ImageWidth][0]; const H = tags[T.ImageLength][0];
  const spp = tags[T.SamplesPerPixel]?.[0] ?? 1;
  const bits = tags[T.BitsPerSample]?.[0] ?? 1;
  const comp = tags[T.Compression]?.[0] ?? 1; const photo = tags[T.Photometric]?.[0] ?? 1;
  const pred = tags[T.Predictor]?.[0] ?? 1; const planar = tags[T.PlanarConfig]?.[0] ?? 1;
  const fmt = tags[T.SampleFormat]?.[0] ?? 1;
  if (bits !== 8 && bits !== 16) throw new Error(`${bits}-bit TIFF samples are not supported (8 or 16)`);
  if (fmt !== 1) throw new Error('only unsigned integer TIFF samples are supported');
  if (![0, 1, 2].includes(photo)) throw new Error(`TIFF photometric ${photo} (palette, CMYK, YCbCr or other) is not supported`);
  if (planar !== 1 && spp > 1) throw new Error('planar (separate-plane) TIFF is not supported');
  if (![1, 5, 8, 32946, 32773].includes(comp)) throw new Error(`TIFF compression ${comp} is not supported (none, LZW, Deflate, PackBits)`);
  const color = photo === 2 ? 3 : 1;
  if (spp < color) throw new Error(`TIFF has ${spp} samples for photometric ${photo}`);
  const extra = tags[T.ExtraSamples] ? Array.from(tags[T.ExtraSamples]) : [];
  const hasAlpha = spp > color; const premult = hasAlpha && extra[0] === 1;
  const tiled = !!tags[T.TileWidth];
  const bw = tiled ? tags[T.TileWidth][0] : W; const bh = tiled ? tags[T.TileLength][0] : (tags[T.RowsPerStrip]?.[0] ?? H);
  const offs = tags[tiled ? T.TileOffsets : T.StripOffsets]; const counts = tags[tiled ? T.TileByteCounts : T.StripByteCounts];
  const bps = bits / 8; const max = bits === 16 ? 65535 : 255;
  const samples = bits === 16 ? new Uint16Array(W * H * spp) : new Uint8Array(W * H * spp);
  const across = Math.ceil(W / bw);
  for (let b = 0; b < offs.length; b++) {
    const bx = tiled ? (b % across) * bw : 0; const by = tiled ? Math.floor(b / across) * bh : b * bh;
    if (by >= H) continue;
    const rows = tiled ? bh : Math.min(bh, H - by);
    const expected = bw * rows * spp * bps;
    const src = bytes.subarray(offs[b], offs[b] + counts[b]);
    let raw;
    if (comp === 1) raw = src;
    else if (comp === 5) raw = lzwDecode(src, expected);
    else if (comp === 32773) raw = packBits(src, expected);
    else raw = await inflate(src);
    const dvr = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const blk = bits === 16 ? new Uint16Array(bw * rows * spp) : new Uint8Array(bw * rows * spp);
    for (let i = 0; i < blk.length && (i + 1) * bps <= raw.length; i++) blk[i] = bits === 16 ? dvr.getUint16(i * 2, le) : raw[i];
    if (pred === 2) for (let y = 0; y < rows; y++) for (let x = spp; x < bw * spp; x++) { const i = y * bw * spp + x; blk[i] = (blk[i] + blk[i - spp]) & max; }
    for (let y = 0; y < rows && by + y < H; y++) {
      const w = Math.min(bw, W - bx);
      samples.set(blk.subarray(y * bw * spp, (y * bw + w) * spp), ((by + y) * W + bx) * spp);
    }
  }
  // → straight-alpha RGBA in the file's bit depth
  const data = bits === 16 ? new Uint16Array(W * H * 4) : new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const s = i * spp; const a = hasAlpha ? samples[s + color] : max;
    for (let c = 0; c < 3; c++) {
      let v = samples[s + (color === 3 ? c : 0)];
      if (photo === 0) v = max - v;
      if (premult) v = a > 0 ? Math.min(max, Math.round((v * max) / a)) : 0;
      data[i * 4 + c] = v;
    }
    data[i * 4 + 3] = a;
  }
  const xres = tags[T.XResolution]?.[0] || 72; const yres = tags[T.YResolution]?.[0] || 72;
  return {
    width: W, height: H, bits, data, hasAlpha, name: text(tags[T.PageName]), description: text(tags[T.ImageDescription]),
    icc: tags[T.ICC] ? tags[T.ICC].slice() : null, photoshopLayers: !!tags[37724],
    x: Math.round((tags[T.XPosition]?.[0] ?? 0) * xres), y: Math.round((tags[T.YPosition]?.[0] ?? 0) * yres),
  };
}

// ---- writer ---------------------------------------------------------------------------------------
// pages: [{ width, height, bits: 8 | 16, channels: 3 | 4, data (interleaved samples), name?, description?,
// icc?, x?, y? }]. Returns the file bytes (little-endian).
export async function writeTiff(pages, { software = 'Atelier' } = {}) {
  const enc = new TextEncoder();
  const prepared = [];
  for (const p of pages) {
    const { width: W, height: H, bits, channels: spp, data } = p;
    if (data.length !== W * H * spp) throw new Error(`page data is ${data.length} samples, expected ${W * H * spp}`);
    const bps = bits / 8; const rowBytes = W * spp * bps;
    const rps = Math.max(1, Math.min(H, Math.floor((256 * 1024) / rowBytes)));
    const strips = [];
    for (let y0 = 0; y0 < H; y0 += rps) {
      const rows = Math.min(rps, H - y0);
      const raw = new Uint8Array(rows * rowBytes); const dv = new DataView(raw.buffer);
      for (let y = 0; y < rows; y++) {   // horizontal predictor: each sample minus the same sample one pixel left
        const base = (y0 + y) * W * spp;
        for (let x = 0; x < W * spp; x++) {
          const v = data[base + x]; const d = x >= spp ? (v - data[base + x - spp]) : v;
          if (bits === 16) dv.setUint16((y * W * spp + x) * 2, d & 0xffff, true); else raw[y * W * spp + x] = d & 255;
        }
      }
      strips.push(await inflate(raw, 'compress'));
    }
    prepared.push({ p, rps, strips });
  }
  // Layout: header, then per page: IFD, out-of-line values, strip data.
  const chunks = []; let off = 8; const ifdOffsets = [];
  const head = new Uint8Array(8); const hdv = new DataView(head.buffer); hdv.setUint16(0, 0x4949, true); hdv.setUint16(2, 42, true);
  chunks.push(head);
  prepared.forEach(({ p, rps, strips }, idx) => {
    const spp = p.channels;
    const entries = [
      [T.NewSubfileType, 4, [pages.length > 1 ? 2 : 0]], [T.ImageWidth, 4, [p.width]], [T.ImageLength, 4, [p.height]],
      [T.BitsPerSample, 3, Array(spp).fill(p.bits)], [T.Compression, 3, [8]], [T.Photometric, 3, [2]],
      ...(p.description ? [[T.ImageDescription, 2, enc.encode(`${p.description}\0`)]] : []),
      [T.StripOffsets, 4, strips.map(() => 0)], [T.SamplesPerPixel, 3, [spp]], [T.RowsPerStrip, 4, [rps]],
      [T.StripByteCounts, 4, strips.map((s) => s.length)], [T.XResolution, 5, [[72, 1]]], [T.YResolution, 5, [[72, 1]]],
      [T.PlanarConfig, 3, [1]], ...(p.name ? [[T.PageName, 2, enc.encode(`${p.name}\0`)]] : []),
      ...(p.x || p.y ? [[T.XPosition, 5, [[Math.max(0, p.x || 0), 72]]], [T.YPosition, 5, [[Math.max(0, p.y || 0), 72]]]] : []),
      [T.ResolutionUnit, 3, [2]], ...(pages.length > 1 ? [[T.PageNumber, 3, [idx, pages.length]]] : []),
      [T.Software, 2, enc.encode(`${software}\0`)], [T.Predictor, 3, [2]],
      ...(spp === 4 ? [[T.ExtraSamples, 3, [2]]] : []), [T.SampleFormat, 3, Array(spp).fill(1)],
      ...(p.icc ? [[T.ICC, 7, p.icc]] : []),
    ].sort((a, b) => a[0] - b[0]);
    const ifdSize = 2 + entries.length * 12 + 4;
    const sizeOf = ([, type, v]) => (TYPE_SIZE[type] * v.length);
    let extra = 0; for (const e of entries) { const s = sizeOf(e); if (s > 4) extra += (s + 1) & ~1; }
    const ifdAt = off; const extraAt = ifdAt + ifdSize; let dataAt = extraAt + extra;
    const stripOffsets = strips.map((s) => { const o = dataAt; dataAt += s.length; return o; });
    entries.find((e) => e[0] === T.StripOffsets)[2] = stripOffsets;
    dataAt = (dataAt + 1) & ~1;   // the next IFD starts on a word boundary
    const block = new Uint8Array(dataAt - ifdAt); const dv = new DataView(block.buffer);
    dv.setUint16(0, entries.length, true);
    let x = extraAt - ifdAt;
    entries.forEach(([tag, type, v], i) => {
      const e = 2 + i * 12; dv.setUint16(e, tag, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, v.length, true);
      const size = TYPE_SIZE[type] * v.length; let at = e + 8;
      if (size > 4) { dv.setUint32(e + 8, ifdAt + x, true); at = x; x += (size + 1) & ~1; }
      for (let k = 0; k < v.length; k++) {
        if (type === 2 || type === 7 || type === 1) block[at + k] = v[k];
        else if (type === 3) dv.setUint16(at + k * 2, v[k], true);
        else if (type === 4) dv.setUint32(at + k * 4, v[k], true);
        else if (type === 5) { dv.setUint32(at + k * 8, v[k][0], true); dv.setUint32(at + k * 8 + 4, v[k][1], true); }
      }
    });
    let so = extraAt - ifdAt + extra; for (const s of strips) { block.set(s, so); so += s.length; }
    ifdOffsets.push({ block, nextAt: 2 + entries.length * 12 });
    chunks.push(block); if (idx === 0) hdv.setUint32(4, ifdAt, true);
    off = dataAt;
  });
  // chain the IFDs
  let at = 8;
  ifdOffsets.forEach(({ block, nextAt }, i) => {
    at += block.length;
    if (i + 1 < ifdOffsets.length) new DataView(block.buffer).setUint32(nextAt, at, true);
  });
  const out = new Uint8Array(off); let o = 0; for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}
