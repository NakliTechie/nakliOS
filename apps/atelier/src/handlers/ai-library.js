// AI library commands: keyword suggestions (L71) and find-similar (L64) from CLIP image embeddings, faces
// (L64 grouping, L61 face-part masks, L63 closed eyes) from the MediaPipe face mesh and SFace. Every
// command needs its model downloaded first and answers `unsupported`, naming the download, without it.
// Keywords are only proposed here; they reach a photo when the person accepts them, through set_keywords
// (the library's command). Face-part masks go through the selection and set_mask commands on the bus, so
// they become an ordinary bitmap mask component the person can edit or delete.
//
// ctx.aiVision (tests set it): { status(id), embedImage(px, w, h), embedText(s), detectFaces(px, w, h),
// embedFace(px, w, h, mesh) }. Without it the handlers use src/ai/vision-ort.js.

import * as C from '../ai/clip.js';
import * as F from '../ai/faces.js';
import * as P from '../ai/portrait.js';
import { stretch, coverage } from '../ai/masks.js';
import * as R from '../select/raster.js';
import { pixelModel } from '../ai/models-pixels.js';
import { photoPaths } from '../files/workspace.js';
import { photoDocument } from './views.js';
import { alone, renderLayers } from '../files/layered.js';
import { needDoc, needLayer, fail, change } from './util.js';

export const FACES_FILE = 'library/faces-sface.json';
const FACE_PIPELINE = 'f4';   // bump when detection or alignment changes, so cached faces are found again
const EMBED_EDGE = 448;   // CLIP sees 224 px; a 448 px render keeps the area-averaged reduction clean
const FACE_EDGE = 1536;   // faces are found on a render this long

export function register(bus, ctx) {
  let ioP = null;
  const io = async () => ctx.aiVision ?? (ioP ??= import('../ai/vision-ort.js'));
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder'); return s; };
  const rd = () => { if (!ctx.renderer) fail('unsupported', 'this command needs the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return ctx.renderer; };
  async function needModel(id, tool) {
    const m = pixelModel(id);
    if ((await (await io()).status(id)) !== 'ready') fail('unsupported', `${tool} needs the on-device model "${m.label}" (${m.licence}, ${m.repo}); the person downloads it in the AI pixel tools panel (download_model ${id})`, 'use_ui_control', 'download_model');
    return m;
  }
  async function holding(tool, fn) {
    if (ctx.busy) fail('busy', `${ctx.busy} holds the engine`, 'get_job', 'get_job');
    ctx.busy = tool; try { return await fn(); } finally { ctx.busy = null; }
  }

  // A photo rendered as it would open (sidecar develop), long edge at most maxEdge, without opening it.
  // The key changes when the photo's look changes (its layers' settings), not when keywords change.
  // Layer masks are left out (an open photo may carry one), so the whole photo is analysed.
  async function renderPhoto(path, maxEdge) {
    const r = rd(); const doc = await photoDocument(ctx, path); doc.layers = doc.layers.map((l) => ({ ...l, mask: null }));
    const key = C.hash32(JSON.stringify(doc.layers.map(({ id, name, ...rest }) => rest)));
    try {
      await r.sync(doc);
      const im = await r.resize(await r.image8(r.lodFor(doc, maxEdge), null, 1), maxEdge);
      return { px: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), w: im.width, h: im.height, key };
    } finally {
      if (ctx.store.doc) await r.sync(ctx.store.doc); else { ctx.engine?.setLayers([]); ctx.engine?.schedule(); }
      for (const l of doc.layers) if (l.file && !ctx.store.doc?.layers.some((x) => x.file === l.file)) r.dropFile(l.kind, l.file);
    }
  }

  // ---- CLIP: embeddings, keywords, similar --------------------------------------------------------

  async function embeddings(paths) {
    const s = store(); const m = pixelModel('clip-b32');
    const map = (await s.exists(C.EMBED_FILE)) ? C.readEmbeddings(await s.readText(C.EMBED_FILE), m) : new Map();
    let added = 0; const x = await io();
    for (const p of paths) {
      const doc = await photoDocument(ctx, p);
      const key = C.hash32(JSON.stringify(doc.layers.map(({ id, name, ...rest }) => rest)));
      if (map.get(p)?.key === key) continue;
      const im = await renderPhoto(p, EMBED_EDGE);
      map.set(p, { key, v: await x.embedImage(im.px, im.w, im.h) }); added++;
    }
    if (added) await s.write(C.EMBED_FILE, new TextEncoder().encode(C.embeddingsText(map, m)));
    return { map, added };
  }
  let vocab = null;
  async function vocabulary() {
    if (!vocab) { const x = await io(); const t = []; for (const w of C.VOCABULARY) t.push(await x.embedText(C.prompt(w))); vocab = t; }
    return vocab;
  }
  const checkPaths = async (paths, tool) => {
    const s = store(); const all = new Set(photoPaths(await s.list('')));
    for (const p of paths) if (!all.has(p)) fail('invalid', `${p} is not a photo in the workspace`, 'fix_argument', 'list_folder');
    return [...all];
  };

  bus.register('ai.keywords', async (a) => {
    const T = 'ai_suggest_keywords'; await needModel('clip-b32', T); await checkPaths(a.paths, T);
    return holding(T, async () => {
      const { map, added } = await embeddings(a.paths); const texts = await vocabulary();
      return {
        suggestions: a.paths.map((p) => ({ path: p, keywords: C.zeroShot(map.get(p).v, texts, C.VOCABULARY, { count: a.count ?? 5, minScore: (a.minScore ?? 5) / 100 }) })),
        embedded: added, note: 'proposals only: accept them with set_keywords (mode add)',
      };
    });
  });

  bus.register('ai.similar', async (a) => {
    const T = 'ai_find_similar'; await needModel('clip-b32', T);
    const all = await checkPaths([a.path], T);
    return holding(T, async () => {
      const { map, added } = await embeddings(all);
      const ranked = C.rankSimilar(map.get(a.path).v, all.map((p) => ({ path: p, v: map.get(p).v })), { exclude: a.path, limit: a.limit ?? 20 });
      return { path: a.path, similar: ranked.map((r) => ({ path: r.path, score: Math.round(r.score * 1000) / 1000 })), searched: all.length - 1, embedded: added };
    });
  });

  // ---- faces --------------------------------------------------------------------------------------

  const faceRow = (f, i) => ({ face: i, box: f.box.map((v) => Math.round(v)), score: Math.round(f.score * 1000) / 1000, meshScore: Math.round((f.meshScore ?? 1) * 1000) / 1000, eyes: F.eyesClosed(f.mesh, f.blink) });

  // The open document's layer (or the composite) rendered at full size, for masks in document pixels.
  async function layerPixels(l) {
    const d = needDoc(ctx); const r = rd();
    try { const im = await renderLayers(r, d, alone(d, l, { includeLocals: true }), 1); return { px: new Uint8Array(im.data.buffer, im.data.byteOffset, im.data.byteLength), w: im.width, h: im.height }; }
    finally { await r.sync(d); }
  }

  bus.register('ai.faces', async (a) => {
    const T = 'ai_find_faces'; await needModel('mediapipe-face', T);
    return holding(T, async () => {
      let im;
      if (a.path) { await checkPaths([a.path], T); im = await renderPhoto(a.path, FACE_EDGE); }
      else { const l = needLayer(ctx, a.layerId, { unlocked: false }); im = await layerPixels(l); }
      const faces = await (await io()).detectFaces(im.px, im.w, im.h);
      return { ...(a.path ? { path: a.path, renderedAt: [im.w, im.h] } : { coordinates: 'document pixels' }), faces: faces.map(faceRow), eyesClosed: faces.some((f) => F.eyesClosed(f.mesh, f.blink).closed) };
    });
  });

  // The person-parsing model's answer for a part, as a document-size u8 plane (bilinear up from 256 × 256).
  async function personPlane(px, w, h, part) {
    const r = await (await io()).parsePerson(px, w, h);
    const plane = P.partPlane(r.logits, r.size * r.size, r.classes, P.PERSON_PARTS[part]);
    return stretch(plane, r.size, r.size, w, h);
  }
  // Same rule as set_selection: the selection is one document-size 8-bit buffer.
  async function writeSelection(label, data) {
    const doc = needDoc(ctx); const b = R.bounds(data, doc.width, doc.height);
    const existing = doc.selection?.buffer ?? null; const buf = existing ?? rd().newMask(doc.width, doc.height);
    await change(ctx, label, (d) => { rd().bufferIO.write(buf, data); d.selection = b ? { buffer: buf, bounds: b } : null; }, existing ? [existing] : []);
    return b;
  }

  // L61: a face part becomes the selection (polygons from the face mesh, or for hair, skin areas and clothes
  // the person-parsing model's bitmap), then a bitmap mask component.
  const ALL_PARTS = [...F.PARTS, ...Object.keys(P.PERSON_PARTS)];
  bus.register('ai.face-mask', async (a, { door, caller }) => {
    const T = 'ai_face_mask'; const rev0 = bus.state.revision;
    if (!ALL_PARTS.includes(a.part)) fail('invalid', `part must be one of ${ALL_PARTS.join(', ')}`, 'fix_argument', T);
    const parsed = a.part in P.PERSON_PARTS;
    await needModel(parsed ? 'mediapipe-multiclass' : 'mediapipe-face', T);
    const l = needLayer(ctx, a.layerId);
    const im = await holding(T, () => layerPixels(l));
    const calls = [];
    // The inner calls carry the revision this command started from, then the one each inner call answered, so an
    // edit made while the model ran (or between the inner calls) makes them answer stale instead of being
    // overwritten. Before the first write, a changed document answers stale with nothing applied.
    let rev = rev0;
    const fresh = () => { if (bus.state.revision !== rev) fail('stale', `the document changed while ${T} ran (revision ${rev} → ${bus.state.revision}); nothing applied, call it again`, 'retry_with_revision', 'get_state'); };
    const send = async (name, args) => {
      const r = await bus.dispatch(name, { ...args, revision: rev }, { door, caller: `${caller ?? door} via ai_face_mask` });
      calls.push({ tool: name, status: r.status });
      if (r.status === 'ok') rev = r.revision;
      if (r.status !== 'ok') fail(r.status === 'stale' ? 'outcome_unknown' : r.status, `${name} answered ${r.status}: ${r.error?.message ?? ''}`, r.remedy?.action ?? 'get_state', r.remedy?.tool ?? 'get_state');
      return r;
    };
    if (parsed) {
      if (a.face !== undefined) fail('invalid', `face picks a face for mesh parts; ${a.part} comes from the whole layer`, 'fix_argument', T);
      const data = await personPlane(im.px, im.w, im.h, a.part);
      const cov = coverage(data);
      if (!(cov > 0.0005)) fail('invalid', `no ${a.part} found on this layer`, 'change_target', 'ai_find_faces');
      fresh();
      await writeSelection(`AI ${a.part} selection`, data);
      calls.push({ tool: 'selection', status: 'ok' });
      if (a.feather) await send('refine_selection', { action: 'feather', amount: a.feather });
      if (a.refine) await send('refine_edge', { band: a.refine === true ? 12 : a.refine });
      const info = { part: a.part, model: 'mediapipe-multiclass', coverage: Math.round(cov * 10000) / 10000 };
      if (a.selectOnly) return { ...info, selection: true, calls };
      const r = await send('set_mask', { layerId: l.id, ...(a.maskId ? { maskId: a.maskId } : {}), components: [{ op: 'add', kind: 'bitmap', params: { from: 'selection' } }] });
      return { ...info, mask: r.result, calls };
    }
    const faces = await (await io()).detectFaces(im.px, im.w, im.h);
    if (!faces.length) fail('invalid', 'no face found on this layer', 'change_target', 'ai_find_faces');
    const which = a.face === undefined ? faces.map((_, i) => i) : [a.face];
    if (which.some((i) => !faces[i])) fail('invalid', `face must be 0 to ${faces.length - 1}`, 'fix_argument', T);
    fresh();
    let first = true;
    for (const i of which) for (const poly of F.partPolygons(faces[i].mesh, a.part)) {
      await send('set_selection', { op: first ? 'replace' : poly.op, shape: 'polygon', params: { points: poly.points.map(([x, y]) => [Math.round(x * 10) / 10, Math.round(y * 10) / 10]) } });
      first = false;
    }
    if (a.feather) await send('refine_selection', { action: 'feather', amount: a.feather });
    if (a.selectOnly) return { part: a.part, faces: which, selection: true, calls };
    const r = await send('set_mask', { layerId: l.id, ...(a.maskId ? { maskId: a.maskId } : {}), components: [{ op: 'add', kind: 'bitmap', params: { from: 'selection' } }] });
    return { part: a.part, faces: which, mask: r.result, calls };
  });

  // L64 face grouping and L63 closed eyes across photos. Faces and their identity vectors are cached in
  // library/faces-sface.json by photo look, so a second run embeds only new or edited photos.
  bus.register('ai.group-faces', async (a) => {
    const T = 'ai_group_faces'; await needModel('mediapipe-face', T); await needModel('sface', T);
    const all = await checkPaths(a.paths || [], T); const paths = a.paths?.length ? a.paths : all;
    const s = store(); const x = await io();
    return holding(T, async () => {
      let cache = {}; try { if (await s.exists(FACES_FILE)) cache = JSON.parse(await s.readText(FACES_FILE)).photos || {}; } catch { cache = {}; }
      let added = 0; const faces = [];
      for (const p of paths) {
        const doc = await photoDocument(ctx, p); const key = `${FACE_PIPELINE}:${C.hash32(JSON.stringify(doc.layers.map(({ id, name, ...rest }) => rest)))}`;
        if (cache[p]?.key !== key) {
          const im = await renderPhoto(p, FACE_EDGE); const found = await x.detectFaces(im.px, im.w, im.h); const rows = [];
          for (const f of found) rows.push({ box: f.box.map((v) => Math.round(v)), eyes: F.eyesClosed(f.mesh, f.blink), v: Array.from(await x.embedFace(im.px, im.w, im.h, f.mesh), (n) => Math.round(n * 1e5) / 1e5) });
          cache[p] = { key, faces: rows }; added++;
        }
        cache[p].faces.forEach((f, i) => faces.push({ path: p, face: i, box: f.box, eyesClosed: f.eyes.closed, v: f.v }));
      }
      if (added) await s.write(FACES_FILE, new TextEncoder().encode(`${JSON.stringify({ format: 'atelier-faces', note: 'Faces and SFace identity vectors Atelier found on this device; delete freely, they are rebuilt.', photos: cache })}\n`));
      const groups = F.groupFaces(faces, a.threshold ?? 0.363);
      return { groups, photos: paths.length, faces: faces.length, closedEyes: [...new Set(faces.filter((f) => f.eyesClosed).map((f) => f.path))], analysed: added };
    });
  });
}
