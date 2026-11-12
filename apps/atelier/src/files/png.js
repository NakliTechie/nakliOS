// Lossless 8-bit PNG encode and decode for document buffers (raster pixels as RGBA, mask bitmaps as
// grayscale). A canvas round trip premultiplies alpha and loses colour under partial transparency, so
// buffers use this codec instead. Uses CompressionStream('deflate') (zlib), present in browsers and node.

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xffffffff; for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

async function pipe(bytes, stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(stream)).arrayBuffer());
}

export function chunk(type, data) {
  const out = new Uint8Array(12 + data.length); const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// Splits a PNG into chunks: [{ type, data, bytes }] (bytes is the whole chunk with length and CRC).
export function pngChunks(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out = []; let o = 8;
  while (o + 12 <= bytes.length) {
    const len = dv.getUint32(o); const type = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    out.push({ type, data: bytes.subarray(o + 8, o + 8 + len), bytes: bytes.subarray(o, o + 12 + len) });
    o += 12 + len; if (type === 'IEND') break;
  }
  return out;
}

// channels: 1 (grayscale) or 4 (RGBA, straight alpha).
export async function encodePng(data, width, height, channels) {
  if (channels !== 1 && channels !== 4) throw new Error('channels must be 1 or 4');
  if (data.length !== width * height * channels) throw new Error(`buffer is ${data.length} bytes, expected ${width * height * channels}`);
  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {   // filter 1 (Sub) per row: smaller files for smooth data
    const o = y * (stride + 1); const s = y * stride; raw[o] = 1;
    for (let x = 0; x < stride; x++) raw[o + 1 + x] = (data[s + x] - (x >= channels ? data[s + x - channels] : 0)) & 255;
  }
  const ihdr = new Uint8Array(13); const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width); dv.setUint32(4, height); ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 6;
  const parts = [new Uint8Array(SIG), chunk('IHDR', ihdr), chunk('IDAT', await pipe(raw, new CompressionStream('deflate'))), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Decodes 8-bit grayscale (0), grayscale+alpha (4), RGB (2) or RGBA (6), non-interlaced.
// Returns { width, height, channels, data } with data in the file's own channel count.
export async function decodePng(bytes) {
  for (let i = 0; i < 8; i++) if (bytes[i] !== SIG[i]) throw new Error('not a PNG');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 8; let width; let height; let depth; let type; let interlace; const idat = [];
  while (o < bytes.length) {
    const len = dv.getUint32(o); const t = String.fromCharCode(...bytes.subarray(o + 4, o + 8));
    const body = bytes.subarray(o + 8, o + 8 + len);
    if (t === 'IHDR') { const h = new DataView(body.buffer, body.byteOffset, 13); width = h.getUint32(0); height = h.getUint32(4); depth = body[8]; type = body[9]; interlace = body[12]; }
    else if (t === 'IDAT') idat.push(body);
    else if (t === 'IEND') break;
    o += 12 + len;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  if (depth !== 8 || !channels || interlace) throw new Error(`unsupported PNG: depth ${depth}, colour type ${type}, interlace ${interlace}`);
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0)); let j = 0; for (const p of idat) { joined.set(p, j); j += p.length; }
  const raw = await pipe(joined, new DecompressionStream('deflate'));
  const stride = width * channels; const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)]; const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = y * stride; const prev = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? data[cur + x - channels] : 0; const b = y > 0 ? data[prev + x] : 0; const c = x >= channels && y > 0 ? data[prev + x - channels] : 0;
      let v = src[x];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      else if (f !== 0) throw new Error(`bad PNG filter ${f}`);
      data[cur + x] = v & 255;
    }
  }
  return { width, height, channels, data };
}
