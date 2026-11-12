// Core commands: perception (capabilities, state, layers, history), the document, the view, the active
// target, undo, redo and snapshots.

import { newDocument } from '../document.js';
import { BLEND_MODES } from '../../vendor/tessella/src/shaders.js';
import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { needDoc, fail, change, layerRow } from './util.js';

export function register(bus, ctx) {
  bus.register('query.capabilities', () => ({
    app: 'atelier', manifestVersion: bus.manifest.manifestVersion,
    // Person-only acts are listed in neither: a handler may exist (download_model's UI button) but no door calls it.
    built: bus.built().filter((n) => !bus.manifest.tools.find((t) => t.name === n)?.personOnly),
    notBuilt: bus.manifest.tools.filter((t) => !t.personOnly && !bus.has(t.handler)).map((t) => t.name),
    host: ctx.host(),
    storage: ctx.storage() ? { kind: ctx.storage().kind, label: ctx.storage().label } : null,
    engine: ctx.engine ? { gpu: ctx.engine.getState().gpu } : null,
    develop: { rendered: DEVELOP_RENDERED, curveChannels: ['rgb', 'red', 'green', 'blue'] },
    blendModes: BLEND_MODES,
    maskKinds: ['bitmap', 'linear', 'radial', 'luminance-range'],
  }));

  bus.register('query.state', (_a, { state }) => {
    const d = ctx.store.doc;
    return {
      revision: state.revision,
      document: d && { id: d.id, title: d.title, width: d.width, height: d.height, blendSpace: d.blendSpace },
      layers: d ? d.layers.map(layerRow) : [],
      activeLayerId: d?.activeLayerId ?? null,
      activePhoto: ctx.activePhoto ?? null,
      selection: d?.selection ? { bounds: d.selection.bounds } : null,
      view: ctx.view,
      undoDepth: ctx.store.undoDepth, redoDepth: ctx.store.redoDepth,
      staged: [...ctx.staged.values()].map(({ id, tool, summary }) => ({ id, tool, summary })),
      storage: ctx.storage() ? ctx.storage().kind : null,
      quickMask: !!ctx.quickMask?.on,
    };
  });

  bus.register('query.layers', (a) => {
    const d = needDoc(ctx); const page = a.page ?? 0;
    if (a.groupId && !d.layers.some((l) => l.id === a.groupId && l.kind === 'group')) fail('invalid', `${a.groupId} is not a group`, 'get_state', 'list_layers');
    const rows = a.groupId ? d.layers.filter((l) => l.parentId === a.groupId) : d.layers;
    return { page, pages: Math.max(1, Math.ceil(rows.length / 100)), layers: rows.slice(page * 100, page * 100 + 100).map(layerRow) };
  });

  bus.register('query.history', (a, { state }) => {
    const page = a.page ?? 0;
    return { page, pages: Math.max(1, Math.ceil(state.editList.length / 50)), entries: state.editList.slice(page * 50, page * 50 + 50) };
  });

  bus.register('query.staged', () => ({ staged: [...ctx.staged.values()].map(({ id, tool, summary, at }) => ({ id, tool, summary, at })) }));
  bus.register('query.job', (a) => {
    const j = ctx.jobs.get(a.jobId);
    if (!j) fail('invalid', `no job ${a.jobId}`, 'get_state', 'get_staged');
    return { ...j };
  });

  bus.register('doc.new', async (a) => {
    ctx.store.replace(newDocument(a));
    await ctx.sync();
    return { document: summary(ctx.store.doc) };
  });

  bus.register('doc.set', async (a) => {
    const d = needDoc(ctx);
    if (a.anchor && !/^(top|middle|bottom)-(left|center|right)$/.test(a.anchor)) fail('invalid', 'anchor is top|middle|bottom-left|center|right', 'fix_argument', 'set_document');
    await change(ctx, 'set_document', (doc) => {
      if (a.blendSpace) doc.blendSpace = a.blendSpace;
      if (a.width || a.height) {
        const w = a.width ?? doc.width; const h = a.height ?? doc.height;
        const [v, hz] = (a.anchor || 'middle-center').split('-');
        const dx = hz === 'left' ? 0 : hz === 'right' ? w - doc.width : Math.round((w - doc.width) / 2);
        const dy = v === 'top' ? 0 : v === 'bottom' ? h - doc.height : Math.round((h - doc.height) / 2);
        shiftAll(doc, dx, dy); doc.width = w; doc.height = h;
      }
    });
    return { document: summary(d) };
  });

  bus.register('doc.crop', async (a) => {
    needDoc(ctx);
    const { x, y, w, h } = a.rect;
    await change(ctx, 'crop_document', (doc) => { shiftAll(doc, -x, -y); doc.width = w; doc.height = h; });
    return { document: summary(ctx.store.doc) };
  });

  bus.register('doc.active', (a, { viewOnly }) => {
    viewOnly();
    if (a.layerId) {
      const d = needDoc(ctx);
      if (!d.layers.some((l) => l.id === a.layerId)) fail('invalid', `no layer ${a.layerId}`, 'get_state', 'get_state');
      d.activeLayerId = a.layerId;
    }
    if (a.path) ctx.activePhoto = a.path;
    return { activeLayerId: ctx.store.doc?.activeLayerId ?? null, activePhoto: ctx.activePhoto ?? null };
  });

  bus.register('view.set', async (a, { viewOnly }) => {
    // before and after is drawn by the UI's compare viewer (src/ui/compare.js), which registers ctx.showBeforeAfter
    if (a.beforeAfter && a.beforeAfter !== 'off' && !ctx.showBeforeAfter) fail('unsupported', 'before and after needs the app window; render_preview with before:true shows the photo without develop', 'fix_argument', 'render_preview');
    if (a.beforeAfter && a.beforeAfter !== 'off') needDoc(ctx);
    viewOnly();
    if (a.beforeAfter) {
      const shown = await ctx.showBeforeAfter?.(a.beforeAfter);
      a.beforeAfter = shown ?? 'off';
    }
    if (a.fit) { delete a.fit; a.zoom = null; a.center = null; }
    ctx.view = { ...ctx.view, ...a };
    ctx.setView(ctx.view);
    return { view: ctx.view };
  });

  bus.register('history.undo', async () => {
    needDoc(ctx);
    const label = ctx.store.undo();
    if (!label) fail('unsupported', 'nothing to undo', 'get_state', 'get_history');
    await ctx.sync();
    return { undone: label };
  });
  bus.register('history.redo', async () => {
    needDoc(ctx);
    const label = ctx.store.redo();
    if (!label) fail('unsupported', 'nothing to redo', 'get_state', 'get_history');
    await ctx.sync();
    return { redone: label };
  });

  // Snapshots keep the document and copies of every buffer it references.
  bus.register('history.snapshot', async (a) => {
    const d = needDoc(ctx);
    if (a.action === 'create') {
      const ids = bufferIds(d);
      ctx.snapshots.set(a.name, { doc: structuredClone(d), buffers: Object.fromEntries(ids.map((id) => [id, ctx.renderer.bufferIO.read(id)])) });
      return { snapshots: [...ctx.snapshots.keys()] };
    }
    const s = ctx.snapshots.get(a.name);
    if (!s) fail('invalid', `no snapshot ${a.name}`, 'fix_argument', 'snapshot');
    if (a.action === 'delete') { ctx.snapshots.delete(a.name); return { snapshots: [...ctx.snapshots.keys()] }; }
    await change(ctx, `restore snapshot ${a.name}`, (doc) => {
      for (const k of Object.keys(doc)) delete doc[k];
      Object.assign(doc, structuredClone(s.doc));
    }, Object.keys(s.buffers));
    for (const [id, data] of Object.entries(s.buffers)) if (data) ctx.renderer.bufferIO.write(id, data);
    await ctx.sync();
    return { restored: a.name };
  });
}

export const summary = (d) => ({ id: d.id, title: d.title, width: d.width, height: d.height, blendSpace: d.blendSpace, layers: d.layers.length });

export function bufferIds(d) {
  const ids = [];
  for (const l of d.layers) {
    if (l.buffer) ids.push(l.buffer);
    for (const c of l.mask?.components || []) if (c.bitmap) ids.push(c.bitmap);
  }
  if (d.selection?.buffer) ids.push(d.selection.buffer);
  for (const v of Object.values(d.savedSelections || {})) ids.push(typeof v === 'string' ? v : v?.buffer);
  return ids.filter(Boolean);
}

// Moves every layer and every document-space mask parameter by (dx, dy).
export function shiftAll(doc, dx, dy) {
  for (const l of doc.layers) {
    if (l.kind !== 'fill') { l.matrix[4] += dx; l.matrix[5] += dy; }
    for (const c of l.mask?.components || []) {
      if (c.kind === 'linear') { c.p0[0] += dx; c.p0[1] += dy; c.p0[2] += dx; c.p0[3] += dy; }
      if (c.kind === 'radial') { c.p0[0] += dx; c.p0[1] += dy; }
    }
  }
  if (doc.selection) doc.selection = null;
}
