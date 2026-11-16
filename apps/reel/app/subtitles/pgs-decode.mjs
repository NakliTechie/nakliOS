/* PGS (Blu-ray bitmap subtitle) decoder. Pure: no DOM, runs in the PGS worker
 * (pgs-worker.mjs) and in Node for test/subtitles.test.mjs.
 *
 * Reel decodes PGS itself instead of running libpgs-js, so every size and run length from the
 * file is checked before use (review findings V8, V14, V51):
 *   - a segment whose declared size runs past the end of the data is dropped, with the rest;
 *   - a composition (PCS) larger than 4096x2304, or of size 0, drops its display set;
 *   - an object that is empty, larger than its composition, or whose joined run-length data
 *     exceeds its declared length or OBJECT_DATA_LIMIT, is dropped;
 *   - a run never writes past the end of its line or past the last line of its object.
 * Decoding work is linear in the object's data plus its pixel count.
 *
 * .sup stream: segments of "PG", PTS (32-bit, 90 kHz), DTS, type, 16-bit size, payload.
 * A display set runs from a PCS (0x16) to an END (0x80) segment. */

export const PGS_LIMITS = Object.freeze({
  maxWidth: 4096,
  maxHeight: 2304,
  objectDataBytes: 8 * 1024 * 1024,
  objectsPerComposition: 8,
  epochLookback: 256,
});

const PDS = 0x14;
const ODS = 0x15;
const PCS = 0x16;
const WDS = 0x17;
const END = 0x80;

/* Splits .sup bytes into segments; stops at the first truncated or unframed segment. */
export function readSegments(bytes) {
  const segments = [];
  let truncated = false;
  let at = 0;
  while (at + 13 <= bytes.length) {
    if (bytes[at] !== 0x50 || bytes[at + 1] !== 0x47) { truncated = true; break; }
    const pts = ((bytes[at + 2] << 24) | (bytes[at + 3] << 16) | (bytes[at + 4] << 8) | bytes[at + 5]) >>> 0;
    const type = bytes[at + 10];
    const size = (bytes[at + 11] << 8) | bytes[at + 12];
    const start = at + 13;
    if (start + size > bytes.length) { truncated = true; break; }
    segments.push({ type, pts, payload: bytes.subarray(start, start + size) });
    at = start + size;
  }
  if (at < bytes.length && !truncated) truncated = true;
  return { segments, truncated };
}

const u16 = (b, i) => (b[i] << 8) | b[i + 1];

function readPcs(p) {
  if (p.length < 11) return null;
  const pcs = {
    width: u16(p, 0),
    height: u16(p, 2),
    compositionNumber: u16(p, 5),
    state: p[7],
    paletteUpdate: (p[8] & 0x80) !== 0,
    paletteId: p[9],
    objects: [],
  };
  const count = p[10];
  let i = 11;
  for (let k = 0; k < count && i + 8 <= p.length; k += 1) {
    const flags = p[i + 3];
    const object = { objectId: u16(p, i), windowId: p[i + 2], cropped: (flags & 0x80) !== 0, x: u16(p, i + 4), y: u16(p, i + 6) };
    i += 8;
    if (object.cropped) {
      if (i + 8 > p.length) break;
      object.crop = { x: u16(p, i), y: u16(p, i + 2), width: u16(p, i + 4), height: u16(p, i + 6) };
      i += 8;
    }
    pcs.objects.push(object);
  }
  return pcs;
}

/* BT.601 full range, the conversion libpgs-js uses. */
function readPalette(p) {
  if (p.length < 2) return null;
  const rgba = new Uint8ClampedArray(256 * 4);
  for (let i = 2; i + 5 <= p.length; i += 5) {
    const index = p[i];
    const y = p[i + 1];
    const cr = p[i + 2] - 128;
    const cb = p[i + 3] - 128;
    const o = index * 4;
    rgba[o] = Math.round(y + 1.402 * cr);
    rgba[o + 1] = Math.round(y - 0.34414 * cb - 0.71414 * cr);
    rgba[o + 2] = Math.round(y + 1.772 * cb);
    rgba[o + 3] = p[i + 4];
  }
  return { id: p[0], version: p[1], rgba };
}

/* Parses a .sup stream into display sets. Returns { sets, times, dropped, truncated }:
 * times[i] is set i's start in seconds; dropped counts display sets and objects refused by
 * the limits above. */
export function parseSup(input, limits = PGS_LIMITS) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const { segments, truncated } = readSegments(bytes);
  const sets = [];
  let dropped = 0;
  let current = null;
  let building = null; // object being joined from several ODS segments

  const finishObject = () => {
    if (!building) return;
    const object = building;
    building = null;
    if (object.received !== object.expected) { dropped += 1; return; }
    current.objects.push(object);
  };
  const finishSet = () => {
    if (!current) return;
    finishObject();
    if (current.valid) sets.push(current);
    else dropped += 1;
    current = null;
  };

  for (const segment of segments) {
    const p = segment.payload;
    if (segment.type === PCS) {
      finishSet();
      const pcs = readPcs(p);
      const valid = !!pcs && pcs.width > 0 && pcs.height > 0 && pcs.width <= limits.maxWidth && pcs.height <= limits.maxHeight;
      current = { pts: segment.pts, pcs, valid, palettes: [], objects: [] };
      continue;
    }
    if (!current) continue; // segments before the first PCS belong to no display set
    if (segment.type === END) { finishSet(); continue; }
    if (!current.valid) continue;
    if (segment.type === PDS) {
      const palette = readPalette(p);
      if (palette) current.palettes.push(palette);
    } else if (segment.type === ODS) {
      if (p.length < 4) { dropped += 1; continue; }
      const id = u16(p, 0);
      const first = (p[3] & 0x80) !== 0;
      if (first) {
        finishObject();
        if (p.length < 11) { dropped += 1; continue; }
        const declared = (p[4] << 16) | (p[5] << 8) | p[6];
        const width = u16(p, 7);
        const height = u16(p, 9);
        const expected = declared - 4; // the declared length counts the width and height fields
        const fits = width > 0 && height > 0 && width <= current.pcs.width && height <= current.pcs.height;
        const sane = expected > 0 && expected <= Math.min(limits.objectDataBytes, 4 * width * height + 2 * height + 16);
        if (!fits || !sane) { dropped += 1; continue; }
        building = { id, version: p[2], width, height, expected, received: 0, chunks: [] };
        const data = p.subarray(11);
        building.chunks.push(data);
        building.received += data.length;
      } else if (building && building.id === id) {
        building.chunks.push(p.subarray(4));
        building.received += p.length - 4;
      } else {
        dropped += 1;
        continue;
      }
      if (building && building.received > building.expected) { building = null; dropped += 1; continue; }
      if (building && (p[3] & 0x40) !== 0) finishObject();
    } else if (segment.type === WDS) {
      // Windows only bound where objects may draw; objects carry their own position.
    }
  }
  finishSet();
  return { sets, times: sets.map(set => set.pts / 90_000), dropped, truncated };
}

/* Index of the last display set starting at or before timeS, or -1. */
export function indexAtTime(times, timeS) {
  let lo = 0;
  let hi = times.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= timeS) { found = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return found;
}

function joinChunks(object) {
  if (object.chunks.length === 1) return object.chunks[0];
  const out = new Uint8Array(object.received);
  let at = 0;
  for (const chunk of object.chunks) { out.set(chunk, at); at += chunk.length; }
  return out;
}

/* PGS run-length data to palette indices. Runs are clipped at the end of their line and at the
 * last line, so no input can write outside width x height. Returns { indices, clipped }. */
export function decodeRle(data, width, height) {
  const indices = new Uint8Array(width * height);
  let x = 0;
  let y = 0;
  let p = 0;
  let clipped = 0;
  while (p < data.length && y < height) {
    let colour = data[p++];
    let length = 1;
    if (colour === 0) {
      if (p >= data.length) break;
      const flag = data[p++];
      if (flag === 0) { x = 0; y += 1; continue; } // end of line
      length = flag & 0x3F;
      if (flag & 0x40) { if (p >= data.length) break; length = (length << 8) | data[p++]; }
      if (flag & 0x80) { if (p >= data.length) break; colour = data[p++]; } else colour = 0;
    }
    const room = width - x;
    if (length > room) { clipped += 1; length = room; }
    if (length > 0) {
      if (colour !== 0) indices.fill(colour, y * width + x, y * width + x + length);
      x += length;
    }
  }
  return { indices, clipped };
}

/* Draws display set `index` as rectangles of RGBA pixels. Objects and palettes defined earlier
 * in the same epoch (since the last epoch start or acquisition point) are reused, as the
 * format allows. Returns { width, height, rects: [{ x, y, width, height, rgba }] }; an empty
 * rects list clears the screen. */
export function renderDisplaySet(sup, index, limits = PGS_LIMITS) {
  const set = sup.sets[index];
  if (!set) return { width: 0, height: 0, rects: [] };
  const { pcs } = set;
  const objects = new Map();
  const palettes = new Map();
  let from = index;
  while (from > 0 && index - from < limits.epochLookback && !(sup.sets[from].pcs.state & 0xC0)) from -= 1;
  for (let k = from; k <= index; k += 1) {
    const step = sup.sets[k];
    if (step.pcs.width !== pcs.width || step.pcs.height !== pcs.height) { objects.clear(); palettes.clear(); }
    for (const palette of step.palettes) palettes.set(palette.id, palette);
    for (const object of step.objects) objects.set(object.id, object);
  }
  const palette = palettes.get(pcs.paletteId);
  const rects = [];
  if (!palette) return { width: pcs.width, height: pcs.height, rects };
  for (const placed of pcs.objects.slice(0, limits.objectsPerComposition)) {
    const object = objects.get(placed.objectId);
    if (!object) continue;
    // Decoded per render, never cached: a film holds thousands of objects.
    const { indices } = decodeRle(joinChunks(object), object.width, object.height);
    let sx = 0;
    let sy = 0;
    let w = object.width;
    let h = object.height;
    if (placed.crop) {
      sx = Math.min(placed.crop.x, object.width);
      sy = Math.min(placed.crop.y, object.height);
      w = Math.min(placed.crop.width, object.width - sx);
      h = Math.min(placed.crop.height, object.height - sy);
    }
    w = Math.min(w, pcs.width - placed.x);
    h = Math.min(h, pcs.height - placed.y);
    if (w <= 0 || h <= 0) continue;
    const rgba = new Uint8ClampedArray(w * h * 4);
    const colours = palette.rgba;
    for (let row = 0; row < h; row += 1) {
      const src = (sy + row) * object.width + sx;
      let out = row * w * 4;
      for (let col = 0; col < w; col += 1, out += 4) {
        const c = indices[src + col] * 4;
        rgba[out] = colours[c];
        rgba[out + 1] = colours[c + 1];
        rgba[out + 2] = colours[c + 2];
        rgba[out + 3] = colours[c + 3];
      }
    }
    rects.push({ x: placed.x, y: placed.y, width: w, height: h, rgba });
  }
  return { width: pcs.width, height: pcs.height, rects };
}
