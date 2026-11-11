// The document model and its store (spec 002 §4.1). The document is plain JSON; pixel-like data (mask
// bitmaps, raster pixels) lives in the renderer's buffers and is referenced by id. Every change goes
// through store.mutate, which records the previous state for undo, including copies of any buffer the
// change will touch.

let nextLayer = 1;
export const layerId = () => `L${Date.now().toString(36)}${(nextLayer++).toString(36)}`;
export const IDENTITY = Object.freeze([1, 0, 0, 1, 0, 0]);

export function newDocument({ width, height, background = 'white', title = 'Untitled' }) {
  const doc = { id: crypto.randomUUID(), title, width, height, blendSpace: 'compatible', layers: [], activeLayerId: null, selection: null, savedSelections: {}, snapshots: {} };
  if (background !== 'transparent') {
    const l = makeLayer('fill', { name: 'Background', color: background === 'black' ? '#000000' : '#ffffff' });
    doc.layers.push(l); doc.activeLayerId = l.id;
  }
  return doc;
}

// kind: raw | image | raster | text | fill
export function makeLayer(kind, props = {}) {
  return { id: layerId(), name: props.name || kind, kind, visible: true, locked: false, opacity: 1, fill: 1, blend: 'normal', matrix: [...IDENTITY], mask: null, ...props };
}

export function findLayer(doc, id) { return doc.layers.find((l) => l.id === id) || null; }

export function createStore({ limit = 50 } = {}) {
  let doc = null;
  const undo = []; const redo = [];
  let buffers = { read: () => null, write: () => {} };   // set by the renderer: copy and restore buffer data
  let gesture = null; let gestureSeq = 0;   // changes inside one gesture (a slider drag) merge into one undo step
  return {
    get doc() { return doc; },
    get undoDepth() { return undo.length; },
    get redoDepth() { return redo.length; },
    useBuffers(io) { buffers = io; },
    replace(d) { doc = d; undo.length = 0; redo.length = 0; },
    // fn mutates the document in place; touched lists buffer ids the change will modify.
    beginGesture() { gesture = ++gestureSeq; },
    endGesture() { gesture = null; },
    mutate(label, fn, touched = []) {
      if (!doc) throw new Error('no document');
      const last = undo.at(-1);
      if (gesture && last && last.gesture === gesture && last.label === label) {
        for (const id of touched) if (!(id in last.buffers)) last.buffers[id] = buffers.read(id);
        const merged = fn(doc); redo.length = 0; return merged;
      }
      const entry = { label, gesture, doc: structuredClone(doc), buffers: Object.fromEntries(touched.map((id) => [id, buffers.read(id)])), redo: redo.slice() };
      const result = fn(doc);
      undo.push(entry); if (undo.length > limit) undo.shift();
      redo.length = 0;
      return result;
    },
    // Drops the last change as if it never happened (no redo step): used when it could not be rendered.
    rollback() {
      const e = undo.pop(); if (!e) return null;
      doc = e.doc;
      if (e.redo) redo.splice(0, redo.length, ...e.redo);   // a refused change keeps the redo history
      for (const [id, data] of Object.entries(e.buffers)) if (data) buffers.write(id, data);
      return e.label;
    },
    undo() { return step(undo, redo); },
    redo() { return step(redo, undo); },
  };
  function step(from, to) {
    const e = from.pop();
    if (!e) return null;
    to.push({ label: e.label, doc: structuredClone(doc), buffers: Object.fromEntries(Object.keys(e.buffers).map((id) => [id, buffers.read(id)])) });
    doc = e.doc;
    for (const [id, data] of Object.entries(e.buffers)) if (data) buffers.write(id, data);
    return e.label;
  }
}

// Hex sRGB (#rrggbb or #rrggbbaa) → linear Rec.2020 RGBA, the engine's working space.
export function hexToLinear2020(hex) {
  const h = hex.replace('#', '');
  const v = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((x) => (x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  const a = h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  const M = [[0.6274, 0.3293, 0.0433], [0.0691, 0.9195, 0.0114], [0.0164, 0.0880, 0.8956]];
  return [...M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]), a];
}
