// Book (L51): a Paginella layout document (.naklidoc, spec paginella-001 §2a.3 and §6) with one photo per page.
// The .naklidoc is a stored zip: manifest.json { nakliDocVersion: '1.0', type: 'layout', layout }, edits.jsonl,
// provenance.json and assets/<sha256>.jpg. The layout object follows Paginella's newDocument() shape; the
// defaults below are copied from Paginella src/model/doc.js (MIT, same author) and tests/views-batch2 checks
// them against Paginella's own code, so a drift fails a test rather than a person's book.

const PT_MM = 72 / 25.4;
const mm = (v) => v * PT_MM;
const enc = new TextEncoder();

function defaultSwatches() {
  return {
    black: { name: 'Black', model: 'cmyk', v: [0, 0, 0, 100] },
    paper: { name: 'Paper', model: 'cmyk', v: [0, 0, 0, 0] },
    registration: { name: 'Registration', model: 'registration', v: [100, 100, 100, 100], locked: true },
    accent: { name: 'Vermilion', model: 'cmyk', v: [0, 75, 90, 0] },
    ink: { name: 'Indigo', model: 'cmyk', v: [90, 70, 0, 20] },
    grey: { name: 'Grey 20%', model: 'cmyk', v: [0, 0, 0, 20] },
  };
}
function defaultParaStyles() {
  return {
    Body: { name: 'Body', basedOn: null, next: 'Body', family: 'Noto Serif', size: 10.5, leading: 14, align: 'justify', hyphenate: true, color: 'black', spaceAfter: 0, indentFirst: 0, orphans: 2, widows: 2, lang: 'en' },
    'Body Hindi': { name: 'Body Hindi', basedOn: 'Body', next: 'Body Hindi', size: 11, leading: 17, lang: 'hi', hyphenate: false },
    'Heading 1': { name: 'Heading 1', basedOn: 'Body', next: 'Body', family: 'Noto Sans', bold: true, size: 24, leading: 28, align: 'left', hyphenate: false, spaceBefore: 12, spaceAfter: 10, keepWithNext: true },
    'Heading 2': { name: 'Heading 2', basedOn: 'Heading 1', size: 15, leading: 19, spaceBefore: 10, spaceAfter: 4 },
    Caption: { name: 'Caption', basedOn: 'Body', family: 'Noto Sans', size: 8.5, leading: 11, align: 'left', hyphenate: false, color: 'grey' },
    Bullet: { name: 'Bullet', basedOn: 'Body', align: 'left', indentLeft: 14, indentFirst: -14, list: { type: 'bullet', marker: '•' } },
    Numbered: { name: 'Numbered', basedOn: 'Body', align: 'left', indentLeft: 18, indentFirst: -18, list: { type: 'number', format: '{n}.', numerals: 'arabic' } },
    'Running head': { name: 'Running head', basedOn: 'Body', family: 'Noto Sans', size: 8, leading: 10, align: 'left', hyphenate: false },
  };
}
function defaultCharStyles() {
  return {
    Emphasis: { name: 'Emphasis', basedOn: null, italic: true },
    Strong: { name: 'Strong', basedOn: null, bold: true },
    'Small caps': { name: 'Small caps', basedOn: null, caps: 'small' },
    Accent: { name: 'Accent', basedOn: null, color: 'accent' },
  };
}

// photos: [{ name, hash, width, height, bytes }] (JPEG). Page A4 (portrait unless most photos are landscape),
// 15 mm margins; each photo is fitted inside the margins and centred, so frame fill equals fit.
export function bookLayout(title, photos, { now = new Date().toISOString(), id = (i) => `p${i + 1}` } = {}) {
  const landscape = photos.filter((p) => p.width > p.height).length > photos.length / 2;
  const [W, H] = landscape ? [mm(297), mm(210)] : [mm(210), mm(297)];
  const M = mm(15);
  const doc = {
    format: 'paginella', version: 1, name: title,
    page: { w: W, h: H }, facing: false,
    margins: { top: M, bottom: M, inside: M, outside: M }, columns: { count: 1, gutter: mm(5) },
    bleed: { top: mm(3), bottom: mm(3), inside: mm(3), outside: mm(3) }, slug: 0,
    grid: { start: M, increment: 14, show: false },
    sections: [{ start: 0, first: 1, style: 'arabic', prefix: '', name: '' }],
    masters: [{ id: 'A', name: 'A-Master', basedOn: null, items: [] }],
    pages: [], frames: {}, stories: {},
    paraStyles: defaultParaStyles(), charStyles: defaultCharStyles(), swatches: defaultSwatches(),
    assets: {}, fonts: [], guides: [], layers: [{ id: 'L1', name: 'Layer 1', visible: true, locked: false }],
    variables: { title }, output: { profile: null, condition: 'FOGRA39', name: '' }, meta: { created: now, source: 'atelier' },
  };
  photos.forEach((p, i) => {
    const bw = W - 2 * M; const bh = H - 2 * M;
    const k = Math.min(bw / p.width, bh / p.height);
    const w = p.width * k; const h = p.height * k;
    const fid = `f${i + 1}`;
    doc.frames[fid] = { id: fid, kind: 'image', x: (W - w) / 2, y: (H - h) / 2, w, h, image: { asset: p.hash, fit: 'fill' } };
    doc.assets[p.hash] = { name: p.name, type: 'image/jpeg', size: p.bytes.length, width: p.width, height: p.height, ppi: 72 };
    doc.pages.push({ id: id(i), master: 'A', items: [fid], overrides: {} });
  });
  return doc;
}

export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Stored zip writer (CRC-32, no compression; JPEGs are compressed already).
let crcTable;
function crc32(b) {
  if (!crcTable) { crcTable = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; } }
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
export function writeZip(files) {
  const parts = []; const central = []; let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name); const data = f.data; const crc = crc32(data);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true);
    lh.setUint32(14, crc, true); lh.setUint32(18, data.length, true); lh.setUint32(22, data.length, true); lh.setUint16(26, name.length, true);
    parts.push(new Uint8Array(lh.buffer), name, data);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint32(16, crc, true); ch.setUint32(20, data.length, true); ch.setUint32(24, data.length, true); ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cd = central.reduce((s, b) => s + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, cd, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((s, b) => s + b.length, 0)); let p = 0;
  for (const b of all) { out.set(b, p); p += b.length; }
  return out;
}

export function packBook(layout, photos) {
  const manifest = { nakliDocVersion: '1.0', type: 'layout', tool: 'atelier', name: layout.name, modified: new Date().toISOString(), layout };
  const files = [
    { name: 'manifest.json', data: enc.encode(JSON.stringify(manifest, null, 1)) },
    { name: 'edits.jsonl', data: new Uint8Array(0) },
    { name: 'provenance.json', data: enc.encode(JSON.stringify({ tool: 'atelier', exported: manifest.modified, ai: [] })) },
  ];
  const seen = new Set();
  for (const p of photos) if (!seen.has(p.hash)) { seen.add(p.hash); files.push({ name: `assets/${p.hash}.jpg`, data: p.bytes }); }
  return writeZip(files);
}
