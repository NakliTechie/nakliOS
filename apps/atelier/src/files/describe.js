// The "edited" label on exports (L66 disclosure): when a document holds AI-edited layers (layer.aiEdit:
// sky replacement, relight, generative fill), the exported file carries editedNote(doc) (src/ai/scene.js)
// as its description: PNG tEXt "Description", JPEG an XMP APP1 packet with dc:description, WebP an
// 'XMP ' chunk (VP8X flag 0x04). TIFF writes it as ImageDescription through writeTiff's page description.
// Pure byte surgery; readDescription reads the label back (tests and checks).

import { chunk, pngChunks } from './png.js';

const te = new TextEncoder(); const td = new TextDecoder();
const join = (parts) => { const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const XMP_NS = 'http://ns.adobe.com/xap/1.0/\0';

export function xmpPacket(text) {
  return `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(text)}</rdf:li></rdf:Alt></dc:description></rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
}

// PNG: a tEXt chunk (keyword "Description", Latin-1 text; characters above U+00FF become '?') after IHDR.
export function describePng(bytes, text) {
  const latin = Uint8Array.from([...'Description\0'].map((c) => c.charCodeAt(0)).concat([...String(text)].map((c) => (c.charCodeAt(0) <= 255 ? c.charCodeAt(0) : 63))));
  const parts = [bytes.subarray(0, 8)];
  for (const c of pngChunks(bytes)) {
    if (c.type === 'tEXt' && td.decode(c.data.subarray(0, 12)) === 'Description\0') continue;
    parts.push(c.bytes); if (c.type === 'IHDR') parts.push(chunk('tEXt', latin));
  }
  return join(parts);
}

// JPEG: an APP1 XMP segment after SOI and any APP0 / Exif APP1 segments (any old XMP segment is dropped).
export function describeJpeg(bytes, text) {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new Error('not a JPEG');
  const body = te.encode(XMP_NS + xmpPacket(text));
  if (body.length + 2 > 65535) throw new Error('description too long for one XMP segment');
  const seg = join([Uint8Array.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  const parts = [bytes.subarray(0, 2)]; let o = 2; let inserted = false;
  while (o < bytes.length && bytes[o] === 0xff) {
    const m = bytes[o + 1];
    if (m === 0xda || m === 0xd9) break;
    const L = (bytes[o + 2] << 8) | bytes[o + 3]; const s = bytes.subarray(o, o + 2 + L);
    const isXmp = m === 0xe1 && td.decode(s.subarray(4, 4 + XMP_NS.length)) === XMP_NS;
    const isExif = m === 0xe1 && !isXmp;
    if (!inserted && m !== 0xe0 && !isExif) { parts.push(seg); inserted = true; }
    if (!isXmp) parts.push(s);
    o += 2 + L;
  }
  if (!inserted) parts.push(seg);
  parts.push(bytes.subarray(o));
  return join(parts);
}

// WebP: needs the extended form (VP8X), which tagWebp and the animated muxer write; adds an 'XMP ' chunk
// at the end and sets the VP8X XMP flag.
export function describeWebp(bytes, text) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (o) => String.fromCharCode(...bytes.subarray(o, o + 4));
  if (str(0) !== 'RIFF' || str(8) !== 'WEBP' || str(12) !== 'VP8X') throw new Error('describeWebp needs an extended (VP8X) WebP');
  const parts = []; let o = 12;
  while (o + 8 <= bytes.length) { const n = dv.getUint32(o + 4, true); const t = str(o); const c = bytes.slice(o, o + 8 + n + (n & 1)); if (t === 'VP8X') c[8] |= 0x04; if (t !== 'XMP ') parts.push(c); o += 8 + n + (n & 1); }
  const x = te.encode(xmpPacket(text)); const h = new Uint8Array(8); h.set(te.encode('XMP ')); new DataView(h.buffer).setUint32(4, x.length, true);
  parts.push(h, x, x.length & 1 ? new Uint8Array(1) : new Uint8Array(0));
  const payload = join(parts); const head = new Uint8Array(12); head.set(te.encode('RIFF')); new DataView(head.buffer).setUint32(4, payload.length + 4, true); head.set(te.encode('WEBP'), 8);
  return join([head, payload]);
}

// Description of a PNG, JPEG or WebP file, or null.
export function readDescription(bytes) {
  const fromXmp = (s) => { const m = /<dc:description>[\s\S]*?<rdf:li[^>]*>([\s\S]*?)<\/rdf:li>/.exec(s); return m ? m[1].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&') : null; };
  if (bytes[0] === 0x89 && bytes[1] === 0x50) {
    for (const c of pngChunks(bytes)) if (c.type === 'tEXt') { const z = c.data.indexOf(0); if (td.decode(c.data.subarray(0, z)) === 'Description') return String.fromCharCode(...c.data.subarray(z + 1)); }
    return null;
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o < bytes.length && bytes[o] === 0xff && bytes[o + 1] !== 0xda) {
      const L = (bytes[o + 2] << 8) | bytes[o + 3];
      if (bytes[o + 1] === 0xe1 && td.decode(bytes.subarray(o + 4, o + 4 + XMP_NS.length)) === XMP_NS) return fromXmp(td.decode(bytes.subarray(o + 4 + XMP_NS.length, o + 2 + L)));
      o += 2 + L;
    }
    return null;
  }
  if (String.fromCharCode(...bytes.subarray(8, 12)) === 'WEBP') {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let o = 12;
    while (o + 8 <= bytes.length) { const t = String.fromCharCode(...bytes.subarray(o, o + 4)); const n = dv.getUint32(o + 4, true); if (t === 'XMP ') return fromXmp(td.decode(bytes.subarray(o + 8, o + 8 + n))); o += 8 + n + (n & 1); }
  }
  return null;
}
