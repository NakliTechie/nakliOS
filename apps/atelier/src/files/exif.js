// EXIF reader (L54): camera, lens, ISO, focal length and capture date from the first bytes of a photo,
// without decoding pixels. Pure, so node tests run it on hand-built files.
//
// Containers handled (tag numbers from the TIFF 6.0 and Exif 2.32 specifications, CIPA DC-008):
// - TIFF-based files: TIFF, DNG, ARW, NEF, CR2, ORF (magic 0x4F52 / 0x5352), RW2 (magic 0x55).
// - JPEG: the APP1 "Exif\0\0" segment holds a TIFF structure.
// - RAF: Fujifilm's header names the embedded JPEG (offset at byte 84, big-endian), which holds the EXIF.
// - CR3: ISO base media boxes CMT1 (IFD0) and CMT2 (the Exif IFD), each a TIFF structure.
// A field the file does not carry is left out. An offset past the bytes given throws a RangeError
// named 'truncated', so the caller can retry with more of the file.

const T = { Make: 0x010f, Model: 0x0110, DateTime: 0x0132, ExifIFD: 0x8769, ExposureTime: 0x829a, FNumber: 0x829d, ISO: 0x8827, DateTimeOriginal: 0x9003, FocalLength: 0x920a, LensMake: 0xa433, LensModel: 0xa434, PanasonicISO: 0x0017, DNGLensInfo: 0xc630 };

class Truncated extends RangeError { constructor() { super('truncated'); this.name = 'truncated'; } }

function tiffReader(b, base) {
  if (base + 8 > b.length) throw new Truncated();
  const order = String.fromCharCode(b[base], b[base + 1]);
  if (order !== 'II' && order !== 'MM') return null;
  const le = order === 'II';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const need = (o, n) => { if (o < 0 || base + o + n > b.length) throw new Truncated(); };
  const u16 = (o) => { need(o, 2); return dv.getUint16(base + o, le); };
  const u32 = (o) => { need(o, 4); return dv.getUint32(base + o, le); };
  const magic = u16(2);
  if (![42, 0x55, 0x4f52, 0x5352].includes(magic)) return null;
  const SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8, 11: 4, 12: 8 };
  // One IFD → Map(tag → value). Strings come back trimmed; rationals as numbers; arrays for counts > 1.
  function ifd(off) {
    const out = new Map(); const n = u16(off);
    for (let i = 0; i < n; i++) {
      const e = off + 2 + i * 12; const tag = u16(e); const type = u16(e + 2); const count = u32(e + 4);
      const size = (SIZE[type] || 1) * count; const at = size <= 4 ? e + 8 : u32(e + 8);
      if (count > 4096) continue;
      try {
        let v;
        if (type === 2) { need(at, count); v = String.fromCharCode(...b.subarray(base + at, base + at + count)).replace(/\0[\s\S]*$/, '').trim(); }
        else if (type === 3) v = Array.from({ length: count }, (_, k) => u16(at + 2 * k));
        else if (type === 4 || type === 13) v = Array.from({ length: count }, (_, k) => u32(at + 4 * k));
        else if (type === 5 || type === 10) v = Array.from({ length: count }, (_, k) => { let nu = u32(at + 8 * k); let de = u32(at + 8 * k + 4); if (type === 10) { nu |= 0; de |= 0; } return de ? nu / de : null; });
        else continue;
        out.set(tag, Array.isArray(v) && v.length === 1 ? v[0] : v);
      } catch (err) { if (err instanceof Truncated && [T.Make, T.Model, T.ExifIFD, T.LensModel, T.DateTimeOriginal].includes(tag)) throw err; }
    }
    return out;
  }
  return { ifd0: () => ifd(u32(4)), ifd };
}

const isoDate = (s) => { const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(s || ''); return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null; };

// Merges IFD0 and Exif IFD maps into the summary shape.
function summarize(i0, ex) {
  const g = (t) => (ex.has(t) ? ex.get(t) : i0.get(t));
  const make = (i0.get(T.Make) || '').trim(); const model = (i0.get(T.Model) || '').trim();
  // "Canon Canon EOS R5" → "Canon EOS R5": the model often repeats the make.
  const camera = model ? (make && !model.toLowerCase().startsWith(make.split(' ')[0].toLowerCase()) ? `${make} ${model}` : model) : make || null;
  const out = {};
  if (camera) out.camera = camera;
  const lens = g(T.LensModel);
  if (typeof lens === 'string' && lens && !/^-+$/.test(lens)) out.lens = lens;
  let iso = g(T.ISO); if (Array.isArray(iso)) iso = iso[0];
  if (!Number.isFinite(iso) || iso <= 0) { iso = i0.get(T.PanasonicISO); if (Array.isArray(iso)) iso = iso[0]; }
  if (Number.isFinite(iso) && iso > 0) out.iso = iso;
  const f = g(T.FocalLength); if (Number.isFinite(f) && f > 0) out.focalLength = Math.round(f * 10) / 10;
  const n = g(T.FNumber); if (Number.isFinite(n) && n > 0) out.aperture = Math.round(n * 10) / 10;
  const t = g(T.ExposureTime); if (Number.isFinite(t) && t > 0) out.shutter = t;
  const d = isoDate(g(T.DateTimeOriginal)) || isoDate(i0.get(T.DateTime)); if (d) out.date = d;
  return out;
}

function fromTiff(b, base) {
  const r = tiffReader(b, base); if (!r) return null;
  const i0 = r.ifd0(); const p = i0.get(T.ExifIFD);
  const ex = Number.isInteger(p) ? r.ifd(p) : new Map();
  return summarize(i0, ex);
}

function fromJpeg(b, start = 0) {
  let o = start + 2;
  while (o + 4 <= b.length) {
    if (b[o] !== 0xff) return null;
    const m = b[o + 1]; const len = (b[o + 2] << 8) | b[o + 3];
    if (m === 0xda || m === 0xd9) return null;
    if (m === 0xe1 && b[o + 4] === 0x45 && b[o + 5] === 0x78 && b[o + 6] === 0x69 && b[o + 7] === 0x66) return fromTiff(b, o + 10);
    o += 2 + len;
  }
  throw new Truncated();
}

function findBox(b, name, from = 0, to = b.length) {
  const c = [...name].map((x) => x.charCodeAt(0));
  for (let i = from + 4; i + 4 <= to; i++) if (b[i] === c[0] && b[i + 1] === c[1] && b[i + 2] === c[2] && b[i + 3] === c[3]) return i + 4;
  return -1;
}

// bytes: Uint8Array of the file's start (or the whole file). Returns the summary, or null when the
// container is not one this reader knows.
export function readExif(bytes) {
  const b = bytes;
  if (b.length < 16) throw new Truncated();
  if (b[0] === 0xff && b[1] === 0xd8) return fromJpeg(b);
  if (String.fromCharCode(...b.subarray(0, 15)) === 'FUJIFILMCCD-RAW') {
    if (b.length < 92) throw new Truncated();
    const off = ((b[84] << 24) | (b[85] << 16) | (b[86] << 8) | b[87]) >>> 0;
    if (off + 4 > b.length) throw new Truncated();
    return fromJpeg(b, off);
  }
  if (String.fromCharCode(b[4], b[5], b[6], b[7]) === 'ftyp') {
    const c1 = findBox(b, 'CMT1'); const c2 = findBox(b, 'CMT2');
    if (c1 < 0) throw new Truncated();
    const r1 = tiffReader(b, c1); const i0 = r1 ? r1.ifd0() : new Map();
    let ex = new Map();
    if (c2 >= 0) { const r2 = tiffReader(b, c2); if (r2) ex = r2.ifd0(); }
    return summarize(i0, ex);
  }
  return fromTiff(b, 0);
}
export const isTruncated = (e) => e instanceof RangeError && e.message === 'truncated';

// Builds a minimal little-endian TIFF/EXIF block for tests and fixtures: entries [{ tag, type, value }]
// in IFD0, and exif entries in an Exif IFD it links. Types: 2 ASCII, 3 SHORT, 5 RATIONAL ([num, den]).
export function buildTiff({ ifd0 = [], exif = [] }) {
  const parts = []; let size = 8;
  const plan = (entries) => { const n = entries.length; return { n, bytes: 2 + 12 * n + 4 }; };
  const all = [...ifd0, ...(exif.length ? [{ tag: T.ExifIFD, type: 4, value: 0 }] : [])].sort((a, b) => a.tag - b.tag);
  const p0 = plan(all); const pe = plan(exif);
  const ifd0At = 8; const exifAt = ifd0At + p0.bytes; let dataAt = exifAt + (exif.length ? pe.bytes : 0);
  const buf = new Uint8Array(4096); const dv = new DataView(buf.buffer);
  buf.set([0x49, 0x49]); dv.setUint16(2, 42, true); dv.setUint32(4, ifd0At, true);
  const write = (at, entries) => {
    dv.setUint16(at, entries.length, true);
    entries.sort((a, b) => a.tag - b.tag).forEach((e, i) => {
      const o = at + 2 + i * 12; dv.setUint16(o, e.tag, true); dv.setUint16(o + 2, e.type, true);
      if (e.tag === T.ExifIFD) { dv.setUint32(o + 4, 1, true); dv.setUint32(o + 8, exifAt, true); return; }
      if (e.type === 2) { const s = `${e.value}\0`; dv.setUint32(o + 4, s.length, true); const tgt = s.length <= 4 ? o + 8 : dataAt; for (let k = 0; k < s.length; k++) buf[tgt + k] = s.charCodeAt(k); if (s.length > 4) { dv.setUint32(o + 8, dataAt, true); dataAt += s.length + (s.length & 1); } }
      else if (e.type === 3) { dv.setUint32(o + 4, 1, true); dv.setUint16(o + 8, e.value, true); }
      else if (e.type === 5) { dv.setUint32(o + 4, 1, true); dv.setUint32(o + 8, dataAt, true); dv.setUint32(dataAt, e.value[0], true); dv.setUint32(dataAt + 4, e.value[1], true); dataAt += 8; }
    });
    dv.setUint32(at + 2 + entries.length * 12, 0, true);
  };
  write(ifd0At, all); if (exif.length) write(exifAt, exif);
  void parts; void size;
  return buf.slice(0, dataAt);
}
export const TAGS = T;
