// Workspace commands: open, save, export, batch export, export presets, folder listing, culling,
// develop presets (Atelier JSON and Lightroom XMP) and settings sync (spec 002 §4.2-4.4, §9.3).
// All file access goes through the storage adapter, whose writes are temp file then move.

import { parseCube } from '../../vendor/tessella/src/lut.js';
import { cropGeometry } from './develop.js';
import { localId } from './select.js';
import { newDocument, makeLayer } from '../document.js';
import { extOf, serial } from '../storage.js';
import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { PANELS, settingsOf } from './develop.js';
import { needDoc, needLayer, fail, change, layerRow, stageOrRun } from './util.js';
import { summary, bufferIds } from './core.js';
import { parseXmpPreset } from '../files/xmp.js';
import { encodePng, decodePng } from '../files/png.js';
import {
  sidecarPath, baseName, stem, photoKind, safeName, normalizeSidecar, applyCull, applySettings, sidecarText,
  photoPaths, filterPhotos, pageOf, FORMATS, exportPath, checkExportSettings, resizeFloat, STRUCT, LAYERED_FORMATS, fileSafe,
} from '../files/workspace.js';
import { readPsdPlan, writePsdPlan } from '../files/psd.js';
import { readTiff, writeTiff } from '../files/tiff.js';
import { encodeLinear, decodeLinear } from '../files/linear.js';
import { SPACES, convertFloat, makeIcc, tagPng, tagJpeg, tagWebp } from '../files/icc.js';
import { describePng, describeJpeg, describeWebp } from '../files/describe.js';
import { editedNote } from '../ai/scene.js';
import { planToLayers, documentToPsdPlan, documentToLayeredTiff, tiffToPlan, alone, renderLayers } from '../files/layered.js';

const enc = new TextEncoder();
const json = (v) => enc.encode(`${JSON.stringify(v, null, 2)}\n`);
// Copies a sidecar's or preset's develop values onto a RAW layer object (scalars merge, objects replace).
function developInto(layer, src) {
  layer.develop = { ...(layer.develop || {}), ...Object.fromEntries(Object.entries(src.develop || {}).filter(([k]) => DEVELOP_RENDERED.includes(k))) };
  for (const k of STRUCT) if (src[k]) layer[k] = structuredClone(src[k]);
}
// Splits settingsOf output into scalar develop values and whole objects.
function splitSettings(all) {
  const develop = {}; const objects = {};
  for (const [k, v] of Object.entries(all)) (STRUCT.includes(k) ? objects : develop)[k] = v;
  return { develop, objects };
}

// The last document or photo opened or saved, so a reopened window returns to the person's work.
export const STATE_FILE = '.atelier-state.json';
async function remember(s, path) {
  try { await s.write(STATE_FILE, new TextEncoder().encode(JSON.stringify({ format: 'atelier-state', version: 1, last: path, at: new Date().toISOString() }) + '\n')); } catch { /* best effort */ }
}

// A photo as a document, the way open_photo opens it: the RAW or image layer with its sidecar's develop
// settings (or a virtual copy's, with copy), crop and straighten, and local adjustments. Nothing is
// opened: the caller decides whether this becomes the open document (open_photo), a layer (asLayer), or
// a temporary render (views). doc.photo carries the path, cull values and the virtual copy id.
export async function photoDocument(ctx, path, { copy = null } = {}) {
  const s = ctx.storage();
  if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder');
  const kind = photoKind(path);
  if (!kind) fail('unsupported', `${path} is not a RAW or browser image`, 'fix_argument', 'list_folder');
  if (!(await s.exists(path))) fail('invalid', `no file ${path} in the workspace`, 'fix_argument', 'list_folder');
  if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities');
  if (copy && kind !== 'raw') fail('unsupported', 'virtual copies hold develop settings, which only RAW photos have', 'fix_argument', 'open_photo');
  const layer = makeLayer(kind, { name: baseName(path), file: path, ...(kind === 'raw' ? { develop: {} } : {}) });
  const size = await ctx.renderer.sourceSize(layer);
  let side = { exists: false, sidecar: normalizeSidecar({}, DEVELOP_RENDERED) };
  if (kind === 'raw' && await s.exists(sidecarPath(path))) {
    let raw; try { raw = JSON.parse(await s.readText(sidecarPath(path))); } catch { raw = {}; }
    side = { exists: true, sidecar: normalizeSidecar(raw, DEVELOP_RENDERED) };
  }
  let settings = side.sidecar; let title = baseName(path);
  if (copy) {
    settings = (side.sidecar.copies || []).find((c) => c.id === copy);
    if (!settings) fail('invalid', `${path} has no virtual copy ${copy}`, 'fix_argument', 'list_folder');
    title = `${baseName(path)} · ${settings.name}`;
  }
  if (kind === 'raw') developInto(layer, settings);
  const doc = newDocument({ width: size.width, height: size.height, background: 'transparent', title });
  if (layer.crop) {   // restore crop and straighten from the sidecar
    const g = cropGeometry(size.width, size.height, layer.crop.rect, layer.crop.angle);
    doc.width = g.width; doc.height = g.height; layer.matrix = g.matrix;
  }
  doc.layers.push(layer); doc.activeLayerId = layer.id;
  for (const loc of settings.locals || []) {
    doc.layers.push({ ...structuredClone(layer), id: localId(layer.id, loc.maskId), name: `${layer.name} · ${loc.maskId}`, localOf: layer.id, localDelta: loc.delta || {}, mask: loc.mask, visible: loc.visible !== false });
  }
  const cull = { rating: side.sidecar.rating ?? 0, flag: side.sidecar.flag ?? 'none', label: side.sidecar.label ?? 'none' };
  doc.photo = { path, ...cull, ...(copy ? { copy } : {}) };
  return { doc, layer, size, sidecarExists: side.exists, cull };
}

export function register(bus, ctx) {
  const ranges = (() => {
    const p = bus.manifest.tools.find((t) => t.name === 'set_develop')?.inputSchema.properties.params.properties || {};
    return Object.fromEntries(Object.entries(p).map(([k, s]) => [k, [s.minimum ?? -Infinity, s.maximum ?? Infinity]]));
  })();

  function store() {
    const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder');
    return s;
  }
  function renderer() {
    if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities');
    return ctx.renderer;
  }
  async function readJson(s, path) {
    try { return JSON.parse(await s.readText(path)); } catch (e) { fail('invalid', `${path} is not valid JSON: ${e.message}`, 'fix_argument'); }
  }
  async function readSidecar(s, path) {
    const p = sidecarPath(path);
    if (!(await s.exists(p))) return { exists: false, sidecar: normalizeSidecar({}, DEVELOP_RENDERED) };
    let raw;
    try { raw = JSON.parse(await s.readText(p)); } catch { raw = {}; }
    return { exists: true, sidecar: normalizeSidecar(raw, DEVELOP_RENDERED) };
  }
  const writeSidecar = (s, path, sidecar) => s.write(sidecarPath(path), enc.encode(sidecarText(sidecar, baseName(path))));
  async function needPhoto(s, path, tool) {
    if (!photoKind(path)) fail('unsupported', `${path} is not a RAW or browser image`, 'fix_argument', tool);
    if (!(await s.exists(path))) fail('invalid', `no file ${path} in the workspace`, 'fix_argument', 'list_folder');
  }
  // The open document's RAW layers whose file is path.
  const openRawLayers = (path) => (ctx.store.doc?.layers || []).filter((l) => l.kind === 'raw' && l.file === path);
  // A document whose whole content is one RAW layer saves as that photo's sidecar.
  // (its local adjustments with shader-evaluated masks travel in the sidecar too; painted masks need a .atelier document).
const singleRaw = (d) => {
  const raws = d.layers.filter((l) => l.kind === 'raw' && !l.localOf);
  if (raws.length !== 1 || raws[0].buffer) return null;   // a linear float source (HDR merge) has no photo file: .atelier only
  const others = d.layers.filter((l) => l !== raws[0]);
  const ok = others.every((l) => l.localOf === raws[0].id && !(l.mask?.components || []).some((c) => c.kind === 'bitmap'));
  return ok ? raws[0] : null;
};

  // ---- open --------------------------------------------------------------------------------------
  bus.register('file.open', async (a) => {
    const s = store(); const e = extOf(a.path);
    if (!(await s.exists(a.path))) fail('invalid', `no file ${a.path} in the workspace`, 'fix_argument', 'list_folder');
    if (e === 'atelier') {
      if (a.asLayer) fail('unsupported', 'a saved document opens as a document, not as a layer', 'fix_argument', 'open_photo');
      const loaded = await loadDocument(s, a.path); await remember(s, a.path); return loaded;
    }
    if (['tif', 'tiff', 'psd'].includes(e)) {
      const bytes = await s.readBinary(a.path);
      let plan;
      try { plan = e === 'psd' ? readPsdPlan(bytes) : tiffToPlan((await readTiff(bytes)).pages); } catch (err) { fail('invalid', `${a.path}: ${err.message}`, 'change_target', 'open_photo'); }
      return openPlan(a.path, plan, a.asLayer);
    }
    if (!photoKind(a.path)) fail('unsupported', `cannot open .${e} files`, 'change_target', 'open_photo');
    renderer();
    const { doc, layer, size, sidecarExists, cull } = await photoDocument(ctx, a.path, { copy: a.copy ?? null });
    if (a.asLayer) {
      const d = needDoc(ctx);
      layer.matrix = [1, 0, 0, 1, Math.round((d.width - size.width) / 2), Math.round((d.height - size.height) / 2)];
      await change(ctx, 'open_photo as layer', (dd) => {
        const k = dd.layers.findIndex((l) => l.id === dd.activeLayerId);
        dd.layers.splice(k < 0 ? dd.layers.length : k + 1, 0, layer);
        dd.activeLayerId = layer.id;
      });
    } else {
      ctx.store.replace(doc);
      await ctx.sync();
    }
    ctx.activePhoto = a.path;
    if (!a.asLayer) await remember(s, a.path);
    return { document: summary(ctx.store.doc), layer: layerRow(layer), sidecar: sidecarExists, ...cull, ...(a.copy ? { copy: a.copy } : {}) };
  });

  // A PSD or TIFF layer plan opens as a new document, or (asLayer) as a group of layers centred in the
  // open document. Everything the file holds that Atelier does not render is listed in skipped.
  async function openPlan(path, plan, asLayer) {
    const r = renderer();
    let layers; let notes;
    if (asLayer) {
      const d = needDoc(ctx);
      ({ layers, notes } = planToLayers(plan, r, { offset: [Math.round((d.width - plan.width) / 2), Math.round((d.height - plan.height) / 2)], docWidth: d.width, docHeight: d.height }));
      const group = makeLayer('group', { name: baseName(path), isolation: 'pass-through' });
      for (const l of layers) if (!l.parentId) l.parentId = group.id;
      await change(ctx, 'open_photo as layers', (doc) => {
        const act = doc.layers.find((l) => l.id === doc.activeLayerId);
        if (act?.parentId) group.parentId = act.parentId;
        const i = doc.layers.indexOf(act);
        doc.layers.splice(i < 0 ? doc.layers.length : i + 1, 0, ...layers, group);
        doc.activeLayerId = group.id;
      });
      layers = [...layers, group];
    } else {
      const doc = newDocument({ width: plan.width, height: plan.height, background: 'transparent', title: baseName(path) });
      ({ layers, notes } = planToLayers(plan, r, { docWidth: plan.width, docHeight: plan.height }));
      doc.layers.push(...layers);
      doc.activeLayerId = layers.at(-1)?.id ?? null;
      ctx.store.replace(doc);
      await ctx.sync();
    }
    ctx.activePhoto = path;
    return { document: summary(ctx.store.doc), layers: layers.map(layerRow), skipped: plan.skipped, notes: [...plan.notes, ...notes.map((n) => `${n.layer}: ${n.note}`)] };
  }

  // ---- save --------------------------------------------------------------------------------------
  bus.register('file.save', async (a, { viewOnly, door }) => {
    viewOnly();   // saving writes files; the document (and so its revision) is unchanged
    const s = store(); const d = needDoc(ctx);
    const raw = singleRaw(d);
    const asDocument = a.path ? a.path.endsWith('.atelier') : !raw;
    if (!asDocument) {
      if (a.path && a.path !== sidecarPath(raw.file)) fail('invalid', `a single RAW photo saves to its sidecar ${sidecarPath(raw.file)}, or pass a path ending .atelier`, 'fix_argument', 'save_document');
      // One read-modify-write of the sidecar at a time: library commands (set_keywords, set_rating…) take
      // the same lock, so an autosave never writes back a sidecar it read before their change.
      return serial(sidecarPath(raw.file), async () => {
      const { sidecar } = await readSidecar(s, raw.file);
      const next = { ...sidecar, develop: Object.fromEntries(Object.entries(raw.develop || {}).filter(([k]) => DEVELOP_RENDERED.includes(k))) };
      for (const k of STRUCT) { if (raw[k]) next[k] = structuredClone(raw[k]); else delete next[k]; }
      const locals = d.layers.filter((l) => l.localOf === raw.id).map((l) => ({ maskId: l.id.slice(raw.id.length + 1), mask: structuredClone(l.mask), delta: structuredClone(l.localDelta || {}), visible: l.visible }));
      if (locals.length) next.locals = locals; else delete next.locals;
      const photo = d.photo?.path === raw.file ? d.photo : null;
      let out;
      if (photo?.copy) {
        // An open virtual copy saves into its own entry; the photo's settings stay as they are on disk.
        const copies = [...(sidecar.copies || [])]; const k = copies.findIndex((c) => c.id === photo.copy);
        if (k < 0) fail('invalid', `virtual copy ${photo.copy} of ${raw.file} was deleted; nothing saved (make a new virtual copy and open it)`, 'change_target', 'create_virtual_copy');
        const entry = { id: copies[k].id, name: copies[k].name, develop: next.develop, ...Object.fromEntries(STRUCT.filter((x) => next[x]).map((x) => [x, next[x]])), ...(next.locals ? { locals: next.locals } : {}), ...(copies[k].created ? { created: copies[k].created } : {}) };
        copies[k] = entry;
        out = { ...sidecar, copies };
      } else out = next;
      // Rating, flag and label are the sidecar's on disk: every cull command (set_rating, import_xmp,
      // import_lightroom_catalog, accept_cull_suggestions) writes them there, and the open document's copy
      // in doc.photo may be older. The document takes the disk's values instead of writing its own back.
      if (photo) Object.assign(photo, { rating: out.rating ?? 0, flag: out.flag ?? 'none', label: out.label ?? 'none' });
      await writeSidecar(s, raw.file, out);
      await remember(s, raw.file);
      return { kind: 'sidecar', path: sidecarPath(raw.file), develop: out.develop, objects: STRUCT.filter((k) => out[k]), rating: out.rating ?? 0, flag: out.flag ?? 'none', label: out.label ?? 'none' };
      });
    }
    if (a.path && !a.path.endsWith('.atelier')) fail('invalid', 'a document path ends with .atelier', 'fix_argument', 'save_document');
    const path = a.path || `documents/${d.id}.atelier`;
    // Writing over a file that belongs to another document is replacing it: the person confirms.
    if (a.path && a.path !== `documents/${d.id}.atelier` && !(d.savedPaths || []).includes(a.path) && await s.exists(a.path)) {
      return stageOrRun(ctx, { door }, 'save_document', `REPLACE ${a.path} with "${d.title}"`, () => writeDocument(s, d, path), { force: true });
    }
    return writeDocument(s, d, path);
  });

  async function writeDocument(s, d, path) {
    const dir = `${path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : ''}${d.id}/buffers/`;
    const r = bufferIds(d).length ? renderer() : ctx.renderer;
    const buffers = {};
    for (const id of bufferIds(d)) {   // binaries first, then the JSON that advertises them (§9.3)
      const b = r.buffers.get(id);
      if (!b) fail('outcome_unknown', `buffer ${id} is missing from the renderer`, 'get_state', 'get_state');
      if (b.kind === 'linear') {   // float32 linear RGB (HDR merge): a 32-bit float TIFF keeps values above 1.0
        const file = `${dir}${id}.tif`;
        await s.write(file, await encodeLinear(r.bufferData(id), b.width, b.height));
        buffers[id] = { kind: 'linear', width: b.width, height: b.height, file, colour: b.colour };
        continue;
      }
      const channels = b.kind === 'mask' ? 1 : 4;
      const file = `${dir}${id}.png`;
      await s.write(file, await encodePng(r.bufferData(id), b.width, b.height, channels));
      buffers[id] = { kind: b.kind, width: b.width, height: b.height, file };
    }
    const body = json({ format: 'atelier-document', version: 1, savedAt: new Date().toISOString(), document: structuredClone(d), buffers, editList: ctx.bus?.state.editList ?? [] });
    await s.write(path, body);
    d.savedPaths = [...new Set([...(d.savedPaths || []), path])];
    await remember(s, path);
    return { kind: 'document', path, buffers: Object.keys(buffers).length, bytes: body.length };
  }

  async function loadDocument(s, path) {
    const file = await readJson(s, path);
    if (file?.format !== 'atelier-document' || !file.document) fail('invalid', `${path} is not an Atelier document`, 'fix_argument', 'open_photo');
    const doc = structuredClone(file.document);
    const entries = Object.entries(file.buffers || {});
    const r = entries.length || doc.layers.some((l) => l.kind === 'raw' || l.kind === 'image') ? renderer() : ctx.renderer;
    const remap = {};
    for (const [oldId, b] of entries) {
      if (b.kind === 'linear') {
        let lin; try { lin = await decodeLinear(await s.readBinary(b.file)); } catch (err) { fail('invalid', `${b.file}: ${err.message}`, 'fix_argument'); }
        if (lin.width !== b.width || lin.height !== b.height) fail('invalid', `${b.file} is ${lin.width}x${lin.height}, expected ${b.width}x${b.height}`, 'fix_argument');
        remap[oldId] = await r.newLinear(b.width, b.height, lin.data, b.colour || {});
        continue;
      }
      const png = await decodePng(await s.readBinary(b.file));
      if (png.width !== b.width || png.height !== b.height) fail('invalid', `${b.file} is ${png.width}x${png.height}, expected ${b.width}x${b.height}`, 'fix_argument');
      if (b.kind === 'mask') {
        if (png.channels !== 1) fail('invalid', `${b.file}: a mask is a grayscale PNG`, 'fix_argument');
        remap[oldId] = r.newMask(b.width, b.height); r.bufferIO.write(remap[oldId], png.data);
      } else {
        if (png.channels !== 4) fail('invalid', `${b.file}: raster pixels are an RGBA PNG`, 'fix_argument');
        remap[oldId] = r.newPixels(b.width, b.height, png.data);
      }
    }
    for (const l of doc.layers) {
      if (l.buffer) { if (!remap[l.buffer]) fail('invalid', `layer ${l.name} names buffer ${l.buffer}, which the file lacks`, 'fix_argument'); l.buffer = remap[l.buffer]; }
      for (const c of l.mask?.components || []) if (c.bitmap) { if (!remap[c.bitmap]) fail('invalid', `a mask on ${l.name} names buffer ${c.bitmap}, which the file lacks`, 'fix_argument'); c.bitmap = remap[c.bitmap]; }
      if ((l.kind === 'raw' || l.kind === 'image') && !l.buffer && !(await s.exists(l.file))) fail('invalid', `layer ${l.name} needs ${l.file}, which is not in the workspace`, 'fix_argument', 'list_folder');
    }
    ctx.store.replace(doc);
    await ctx.sync();
    ctx.activePhoto = path;
    return { document: summary(doc), buffers: entries.length, savedAt: file.savedAt ?? null, editListEntries: (file.editList || []).length };
  }

  // ---- export ------------------------------------------------------------------------------------
  // Whether this browser's canvas encodes a MIME type (it falls back to PNG when it cannot). Cached.
  const encoders = new Map();
  async function canEncode(mime) {
    if (!encoders.has(mime)) {
      encoders.set(mime, (async () => {
        try { const oc = new OffscreenCanvas(2, 2); oc.getContext('2d').fillRect(0, 0, 1, 1); return (await oc.convertToBlob({ type: mime })).type === mime; } catch { return false; }
      })());
    }
    return encoders.get(mime);
  }
  // Which format and colour space pairs are built (P48): sRGB everywhere (PNG gets the sRGB chunk, JPEG,
  // WebP and TIFF an ICC v4 sRGB profile); Display P3 for PNG, JPEG, WebP and TIFF; Rec.2020 for 16-bit
  // TIFF only (8 bits band in so wide a space). Layered formats are sRGB: raster layers are 8-bit sRGB.
  async function checkFormat(fmt, colorSpace, { layers = false, maxEdge } = {}) {
    const cs = colorSpace || 'srgb';
    if (!FORMATS[fmt]) fail('invalid', `format must be one of ${Object.keys(FORMATS).join(', ')}`, 'fix_argument', 'export_image');
    if (layers && LAYERED_FORMATS.includes(fmt)) fail('invalid', 'layers: true writes one flat file per layer; choose jpeg, png, webp, avif or tiff16', 'fix_argument', 'export_image');
    if (LAYERED_FORMATS.includes(fmt) && maxEdge) fail('unsupported', `${fmt} export writes the document at full size; leave maxEdge out`, 'fix_argument', 'export_image');
    if (LAYERED_FORMATS.includes(fmt) && cs !== 'srgb') fail('unsupported', `${fmt} export is sRGB only, because Atelier raster layers are 8-bit sRGB`, 'fix_argument', 'export_image');
    if (fmt === 'avif' && cs !== 'srgb') fail('unsupported', 'AVIF export is sRGB only: the browser encoder takes no ICC profile', 'fix_argument', 'export_image');
    if (cs === 'rec2020' && fmt !== 'tiff16') fail('unsupported', 'rec2020 export needs 16 bits; use tiff16', 'fix_argument', 'export_image');
    if (!['tiff16', ...LAYERED_FORMATS].includes(fmt) && !(await canEncode(FORMATS[fmt].mime))) fail('unsupported', `this browser cannot encode ${fmt}; choose jpeg, png or tiff16`, 'fix_argument', 'export_image');
  }
  const colorTag = (fmt, cs) => (fmt === 'avif' ? 'none (browser AVIF encoder default)' : fmt === 'png' && cs === 'srgb' ? 'PNG sRGB chunk' : `ICC v4 profile "${SPACES[cs].name}"`);

  // Encodes one rendered image. render(background) returns image8's result (8-bit sRGB plus .float,
  // premultiplied linear Rec.2020). Non-sRGB spaces convert from the float data (src/files/icc.js).
  // note: the "edited" label (editedNote) when AI-edited layers are in the export; written as the file's description.
  async function encodeRendered(render, { format, quality = 90, maxEdge, colorSpace, note = null }) {
    const r = renderer(); const cs = colorSpace || 'srgb';
    if (format === 'tiff16') {
      const im = await render(null);
      let f = { width: im.float.width, height: im.float.height, data: im.float.data };
      if (maxEdge) f = resizeFloat(f, maxEdge);
      let alpha = false;
      for (let i = 3; i < f.data.length; i += 4) if (f.data[i] < 0.9999) { alpha = true; break; }
      const rgba = convertFloat(f, cs, 16);
      const data = alpha ? rgba : rgba.filter((_, i) => (i & 3) !== 3);
      return { bytes: await writeTiff([{ width: f.width, height: f.height, bits: 16, channels: alpha ? 4 : 3, data, icc: makeIcc(cs), ...(note ? { description: note } : {}) }]), width: f.width, height: f.height };
    }
    let im;
    if (cs === 'srgb') {
      im = await render(format === 'jpeg' ? 1 : null);   // JPEG has no alpha: flatten on white
      if (maxEdge) im = await r.resize(im, maxEdge);
    } else {
      const src = await render(null);
      let f = { width: src.float.width, height: src.float.height, data: src.float.data };
      if (maxEdge) f = resizeFloat(f, maxEdge);
      im = { width: f.width, height: f.height, data: convertFloat(f, cs, 8, format === 'jpeg' ? 1 : null) };
    }
    if (format === 'avif') {
      const oc = new OffscreenCanvas(im.width, im.height);
      oc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(im.data), im.width, im.height), 0, 0);
      const blob = await oc.convertToBlob({ type: 'image/avif', quality: quality / 100 });
      if (blob.type !== 'image/avif') fail('unsupported', `this browser cannot encode AVIF (it produced ${blob.type}); choose jpeg, png, webp or tiff16`, 'fix_argument', 'export_image');
      return { bytes: new Uint8Array(await blob.arrayBuffer()), width: im.width, height: im.height };
    }
    let bytes = await r.encode(im, FORMATS[format].mime, quality / 100);
    if (format === 'png') bytes = await tagPng(bytes, cs);
    else if (format === 'jpeg') bytes = tagJpeg(bytes, cs);
    else if (format === 'webp') bytes = tagWebp(bytes, cs);
    if (note) bytes = format === 'png' ? describePng(bytes, note) : format === 'jpeg' ? describeJpeg(bytes, note) : format === 'webp' ? describeWebp(bytes, note) : bytes;
    return { bytes, width: im.width, height: im.height };
  }

  // Renders whatever document the engine holds (doc gives its size) and encodes it. Returns bytes and size.
  // Layered formats render layer by layer and leave the engine showing doc again.
  async function renderBytes(doc, settings) {
    const r = renderer(); const { format, maxEdge } = settings;
    if (format === 'psd' || format === 'tiff-layered') {
      if (format === 'psd') {
        const { plan, notes } = await documentToPsdPlan(r, doc);
        const bytes = writePsdPlan(plan);
        return { bytes, width: doc.width, height: doc.height, layers: plan.layers.length, notes };
      }
      const t = await documentToLayeredTiff(r, doc);
      return { bytes: t.bytes, width: doc.width, height: doc.height, pages: t.pages, notes: t.notes };
    }
    const lod = maxEdge ? Math.max(0, Math.floor(Math.log2(Math.max(doc.width, doc.height) / maxEdge))) : 0;
    return encodeRendered((bg) => r.image8(lod, null, bg), { ...settings, note: editedNote(doc) });
  }

  // Export layers as files (P54): each visible top-level layer (a group as its composite, a RAW layer with
  // its local adjustments) rendered alone at canvas size with its opacity and mask, normal blend.
  // path names the folder; files are <folder>/<nn>-<layer name>.<ext>.
  async function exportLayerFiles(doc, folder, settings) {
    const r = renderer();
    const items = doc.layers.filter((l) => !l.parentId && !l.localOf);
    const files = []; const skipped = [];
    try {
      let n = 0;
      for (const l of items) {
        if (!l.visible) { skipped.push({ layer: l.name, reason: 'hidden' }); continue; }
        n++;
        const path = exportPath(`${folder}/${String(n).padStart(2, '0')}-${fileSafe(l.name)}`, settings.format);
        const list = alone(doc, l, { keepOpacity: true, includeLocals: true });
        const out = await encodeRendered((bg) => renderLayers(r, doc, list, bg), { ...settings, note: editedNote({ layers: list }) });
        await store().write(path, out.bytes);
        files.push({ layer: l.name, path, bytes: out.bytes.length, width: out.width, height: out.height });
      }
    } finally { await r.sync(doc); }
    return { files, skipped };
  }

  bus.register('file.export', async (a, { door }) => {
    const s = store(); const d = needDoc(ctx); renderer();
    await checkFormat(a.format, a.colorSpace, { layers: a.layers, maxEdge: a.maxEdge });
    const cs = a.colorSpace || 'srgb';
    const settings = { format: a.format, quality: a.quality ?? 90, maxEdge: a.maxEdge, colorSpace: cs };
    if (a.layers) {
      let folder = a.path.replace(/^\/+|\/+$/g, '');
      if (!folder.includes('/')) folder = `exports/${folder}`;
      const visible = d.layers.filter((l) => !l.parentId && !l.localOf && l.visible).length;
      if (!visible) fail('invalid', 'the document has no visible top-level layer to export', 'change_target', 'list_layers');
      const prefix = `${folder}/`;
      const existing = (await s.list(folder)).filter((e) => e.path.startsWith(prefix)).length;
      const what = `export ${visible} layer${visible > 1 ? 's' : ''} of "${d.title}" as ${a.format.toUpperCase()} files to ${folder}/${existing ? ` (the folder already holds ${existing} file${existing > 1 ? 's' : ''}; same-named files are REPLACED)` : ''}`;
      return stageOrRun(ctx, { door }, 'export_image', what, async () => {
        const doc = needDoc(ctx);
        ctx.busy = 'export_image';
        try { const out = await exportLayerFiles(doc, folder, settings); return { folder, format: a.format, colorSpace: cs, colorTag: colorTag(a.format, cs), ...out }; }
        finally { ctx.busy = null; await ctx.sync(); }
      }, { force: existing > 0 });
    }
    const path = exportPath(a.path, a.format);
    if (!path) fail('invalid', `the extension of ${a.path} names a different format than ${a.format}`, 'fix_argument', 'export_image');
    const what = `${a.format.toUpperCase()}${a.maxEdge ? ` at ${a.maxEdge} px max edge` : ' at full size'}${cs !== 'srgb' ? ` in ${cs}` : ''}`;
    const replaces = await s.exists(path);
    return stageOrRun(ctx, { door }, 'export_image', `${replaces ? `REPLACE existing ${path} with ` : ''}export "${d.title}" as ${what}${replaces ? '' : ` to ${path}`}`, async () => {
      const doc = needDoc(ctx);
      await ctx.sync();
      const layered = LAYERED_FORMATS.includes(a.format);
      if (layered) ctx.busy = 'export_image';
      let out;
      try { out = await renderBytes(doc, settings); } finally { if (layered) { ctx.busy = null; await ctx.sync(); } }
      await s.write(path, out.bytes);
      return { path, bytes: out.bytes.length, width: out.width, height: out.height, format: a.format, colorSpace: cs, colorTag: layered ? (a.format === 'psd' ? 'ICC v4 sRGB profile (image resource 1039)' : colorTag('tiff16', cs)) : colorTag(a.format, cs), replaced: replaces,
        ...(out.layers != null ? { layers: out.layers } : {}), ...(out.pages != null ? { pages: out.pages } : {}), ...(out.notes ? { notes: out.notes.map((n) => `${n.layer}: ${n.note}`) } : {}) };
    }, { force: replaces });
  });

  bus.register('file.export-preset', async (a, { door }) => {
    const s = store(); const name = safeName(a.name);
    if (!name) fail('invalid', 'name is one path segment without / \\ : * ? " < > |', 'fix_argument', 'save_export_preset');
    const bad = checkExportSettings(a.settings);
    if (bad) fail(bad.status, bad.message, 'fix_argument', 'save_export_preset');
    const path = `presets/export/${name}.json`;
    const write = async () => { await s.write(path, json({ format: 'atelier-export-preset', version: 1, name, settings: a.settings })); return { path, settings: a.settings }; };
    if (await s.exists(path)) return stageOrRun(ctx, { door }, 'save_export_preset', `REPLACE export preset ${name}`, write, { force: true });
    return write();
  });

  async function readExportPreset(s, preset) {
    const name = safeName(preset);
    const path = name && !preset.includes('/') ? `presets/export/${name}.json` : preset;
    if (!(await s.exists(path))) fail('invalid', `no export preset ${preset} (looked for ${path})`, 'fix_argument', 'save_export_preset');
    const p = await readJson(s, path);
    const settings = p?.settings || {};
    const bad = checkExportSettings(settings);
    if (bad) fail(bad.status, `${path}: ${bad.message}`, 'fix_argument', 'save_export_preset');
    await checkFormat(settings.format, settings.colorSpace, { maxEdge: settings.maxEdge });
    return settings;
  }

  // Each photo renders off-screen: the engine is pointed at a temporary document, and the open
  // document (its store, undo history and buffers untouched) is synced back afterwards.
  bus.register('file.export-batch', async (a, { door }) => {
    const s = store(); renderer();
    const settings = await readExportPreset(s, a.preset);
    for (const p of a.paths) await needPhoto(s, p, 'export_batch');
    const folder = (a.folder || 'exports').replace(/^\/+|\/+$/g, '');
    const targets = a.paths.map((p) => exportPath(`${folder}/${stem(p)}`, settings.format));
    if (new Set(targets).size !== targets.length) fail('invalid', 'two photos share a file name and would export to the same file', 'fix_argument', 'export_batch');
    let existing = 0; for (const t of targets) if (await s.exists(t)) existing++;
    const summaryText = `export ${a.paths.length} photo${a.paths.length > 1 ? 's' : ''} as ${settings.format.toUpperCase()} (preset ${a.preset}) to ${folder}/${existing ? `, REPLACING ${existing} existing file${existing > 1 ? 's' : ''}` : ''}`;
    return stageOrRun(ctx, { door }, 'export_batch', summaryText, async () => {
      const job = { id: `batch-${Date.now().toString(36)}`, tool: 'export_batch', summary: summaryText, state: 'running', started: new Date().toISOString(), total: a.paths.length, done: 0, files: [], failed: [] };
      ctx.jobs.set(job.id, job);
      ctx.busy = job.id;   // the engine shows a temporary document until the batch ends
      try {
        for (let i = 0; i < a.paths.length; i++) {
          const path = a.paths[i];
          try {
            const { layer, size } = await photoLayer(path);
            if (layer.kind === 'raw') {
              developInto(layer, (await readSidecar(s, path)).sidecar);
            }
            const tmp = newDocument({ width: size.width, height: size.height, background: 'transparent', title: baseName(path) });
            tmp.layers.push(layer);
            await ctx.renderer.sync(tmp);
            const out = await renderBytes(tmp, settings);
            await s.write(targets[i], out.bytes);
            job.files.push({ source: path, path: targets[i], bytes: out.bytes.length, width: out.width, height: out.height });
          } catch (e) { job.failed.push({ source: path, error: e.message }); }
          // release the decoded source unless the open document still uses it
          if (!ctx.store.doc?.layers.some((l) => l.file === path)) ctx.renderer.dropFile?.(photoKind(path) === 'raw' ? 'raw' : 'image', path);
          job.done = i + 1;
        }
        job.state = job.failed.length ? (job.files.length ? 'partial' : 'failed') : 'done';
      } finally {
        ctx.busy = null;
        await ctx.sync();   // the engine shows the open document again
        job.finished = new Date().toISOString();
      }
      return { jobId: job.id, state: job.state, files: job.files, failed: job.failed };
    }, { force: existing > 0 });
  });

  // ---- folder and culling ------------------------------------------------------------------------
  bus.register('query.folder', async (a) => {
    const s = store();
    const listing = await s.list('');
    const have = new Set(listing.map((e) => e.path));
    const rows = [];
    for (const path of photoPaths(listing)) {
      const hasSide = have.has(sidecarPath(path));
      const { sidecar } = hasSide ? await readSidecar(s, path) : { sidecar: {} };
      rows.push({ path, kind: photoKind(path), rating: sidecar.rating ?? 0, flag: sidecar.flag ?? 'none', label: sidecar.label ?? 'none', sidecar: hasSide });
    }
    const pg = pageOf(filterPhotos(rows, a.filter), a.page ?? 0);
    return { page: pg.page, pages: pg.pages, total: pg.total, photos: pg.rows };
  });

  bus.register('cull.set', async (a) => {
    const s = store();
    if (a.rating === undefined && a.flag === undefined && a.label === undefined) fail('invalid', 'pass rating, flag or label', 'fix_argument', 'set_rating');
    for (const p of a.paths) await needPhoto(s, p, 'set_rating');   // check every path before writing any
    const out = [];
    for (const p of a.paths) {
      const { sidecar } = await readSidecar(s, p);
      const next = applyCull(sidecar, a);
      await writeSidecar(s, p, next);
      out.push({ path: p, rating: next.rating ?? 0, flag: next.flag ?? 'none', label: next.label ?? 'none' });
    }
    const photo = ctx.store.doc?.photo;
    if (photo && a.paths.includes(photo.path)) Object.assign(photo, { rating: a.rating ?? photo.rating, flag: a.flag ?? photo.flag, label: a.label ?? photo.label });
    return { photos: out };
  });

  // ---- develop presets ---------------------------------------------------------------------------
  bus.register('query.presets', async () => {
    const s = store();
    const files = (await s.list('presets')).map((e) => e.path);
    const presets = []; const exportPresets = [];
    for (const p of files) {
      const e = extOf(p);
      if (p.startsWith('presets/export/')) { if (e === 'json') exportPresets.push({ name: stem(p), path: p }); continue; }
      if (e === 'json') {
        let keys = []; try { const j = JSON.parse(await s.readText(p)); keys = [...Object.keys(j.settings || {}), ...STRUCT.filter((k) => j[k])]; } catch { keys = null; }
        presets.push({ name: stem(p), path: p, kind: 'atelier', settings: keys });
      } else if (e === 'xmp') presets.push({ name: stem(p), path: p, kind: 'xmp' });
      else if (e === 'cube') presets.push({ name: stem(p), path: p, kind: 'lut', applies: true });
    }
    const cap = 200;
    return { presets: presets.slice(0, cap), exportPresets: exportPresets.slice(0, cap), truncated: presets.length > cap || exportPresets.length > cap };
  });

  function rawLayer(id, tool) {
    const l = needLayer(ctx, id);
    if (l.kind !== 'raw') fail('unsupported', `${l.name} is not a RAW layer; develop presets apply to RAW layers`, 'change_target', tool);
    return l;
  }

  bus.register('develop.save-preset', async (a, { door }) => {
    const s = store(); const l = rawLayer(a.layerId, 'save_preset');
    const name = safeName(a.name);
    if (!name) fail('invalid', 'name is one path segment without / \\ : * ? " < > |', 'fix_argument', 'save_preset');
    const panels = a.panels?.length ? a.panels : Object.keys(PANELS);
    const unbuilt = panels.filter((p) => !(p in PANELS));
    if (unbuilt.length) fail('unsupported', `panels not built yet: ${unbuilt.join(', ')}; built: ${Object.keys(PANELS).join(', ')}`, 'fix_argument', 'save_preset');
    const { develop: settings, objects } = splitSettings(settingsOf(l, panels));
    const path = `presets/${name}.json`;
    const write = async () => { await s.write(path, json({ format: 'atelier-preset', version: 1, name, panels, settings, ...objects })); return { path, settings, ...objects }; };
    if (await s.exists(path)) return stageOrRun(ctx, { door }, 'save_preset', `REPLACE develop preset ${name}`, write, { force: true });
    return write();
  });

  async function readPreset(s, preset) {
    const name = safeName(preset);
    const path = preset.includes('/') || /\.(json|xmp|cube)$/i.test(preset) ? preset : name && `presets/${name}.json`;
    if (!path || !(await s.exists(path))) fail('invalid', `no preset ${preset}`, 'fix_argument', 'list_presets');
    const e = extOf(path);
    if (e === 'cube') {
      try { parseCube(await s.readText(path)); } catch (err) { fail('invalid', `${path} is not a valid .cube LUT: ${err.message}`, 'fix_argument', 'list_presets'); }
      return { path, kind: 'lut', settings: {}, objects: { lut: { path, amount: 1 } }, skipped: [], metadata: [] };
    }
    if (e === 'xmp') {
      let parsed;
      try { parsed = parseXmpPreset(await s.readText(path), ranges); } catch (err) { fail('invalid', `${path}: ${err.message}`, 'fix_argument', 'list_presets'); }
      return { path, kind: 'xmp', settings: parsed.settings, objects: parsed.curve ? { curve: parsed.curve } : {}, skipped: parsed.skipped, metadata: parsed.metadata };
    }
    if (e !== 'json') fail('unsupported', `.${e} presets are not supported; use .json or .xmp`, 'change_target', 'list_presets');
    const j = await readJson(s, path);
    const settings = {}; const skipped = [];
    for (const [k, v] of Object.entries(j?.settings || {})) {
      const [lo, hi] = ranges[k] || [-Infinity, Infinity];
      if (!DEVELOP_RENDERED.includes(k)) skipped.push({ setting: k, value: String(v), reason: 'not rendered yet' });
      else if (!Number.isFinite(v) || v < lo || v > hi) skipped.push({ setting: k, value: String(v), reason: `outside ${lo} to ${hi}` });
      else settings[k] = v;
    }
    const objects = Object.fromEntries(STRUCT.filter((k) => j?.[k] && typeof j[k] === 'object').map((k) => [k, j[k]]));
    return { path, kind: 'atelier', settings, objects, skipped, metadata: [] };
  }

  bus.register('develop.preset', async (a) => {
    const s = store();
    const layers = a.layerIds.map((id) => rawLayer(id, 'apply_preset'));
    const p = await readPreset(s, a.preset);
    if (!Object.keys(p.settings).length && !Object.keys(p.objects).length) fail('unsupported', `${p.path} holds no setting Atelier renders; skipped: ${p.skipped.map((x) => x.setting).join(', ') || 'none'}`, 'change_target', 'list_presets');
    await change(ctx, `apply_preset ${baseName(p.path)}`, (doc) => {
      for (const l of layers) {
        const x = doc.layers.find((y) => y.id === l.id);
        x.develop = { ...x.develop, ...p.settings };
        for (const [k, v] of Object.entries(p.objects)) x[k] = k === 'curve' ? { ...(x.curve || {}), ...structuredClone(v) } : structuredClone(v);
      }
    });
    return { preset: p.path, kind: p.kind, layers: layers.map((l) => l.id), applied: p.settings, ...p.objects, skipped: p.skipped, metadata: p.metadata };
  });

  bus.register('develop.sync', async (a) => {
    const s = store();
    const copied = ctx.clipboard;
    if (!copied || !Object.keys(copied).length) fail('unsupported', 'the settings clipboard is empty; copy settings first', 'change_target', 'copy_settings');
    for (const p of a.paths) {
      await needPhoto(s, p, 'sync_settings');
      if (photoKind(p) !== 'raw') fail('unsupported', `${p} is not a RAW photo; develop settings apply to RAW`, 'change_target', 'sync_settings');
    }
    for (const p of a.paths) {
      const { sidecar } = await readSidecar(s, p);
      await writeSidecar(s, p, applySettings(sidecar, copied, DEVELOP_RENDERED));
    }
    const open = a.paths.flatMap(openRawLayers);
    if (open.length) {
      await change(ctx, 'sync_settings', (doc) => {
        for (const l of open) {
          const { develop, objects } = splitSettings(copied);
          developInto(doc.layers.find((y) => y.id === l.id), { develop, ...objects });
        }
      });
    }
    return { synced: a.paths, settings: copied, openLayersUpdated: open.map((l) => l.id) };
  });
}
