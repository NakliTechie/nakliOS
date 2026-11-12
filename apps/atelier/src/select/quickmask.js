// Quick mask overlay. While quick mask is on, the selection shows as a red film over the unselected
// area: one temporary engine layer on top of the stack, a document-size red pixel source at 50% opacity
// whose mask is the selection buffer itself, inverted. Painting the selection buffer updates the film
// on the next render, and undo restores it with the buffer.
//
// The overlay never enters the document (doc.layers), so saves never see it. Off-screen renders
// (engine.renderImage: exports, merges, samples, histograms, composite sampling for clone and heal)
// run on the layer list without it. Both are done by wrapping the engine's setLayers and renderImage
// from here; renderer.sync stays unaware of the overlay.

const OVERLAY_ID = '__quick_mask_overlay';

export function createQuickMask(ctx) {
  const eng = ctx.engine;
  if (!eng) return null;
  const setLayers0 = eng.setLayers; const renderImage0 = eng.renderImage;
  let base = [];          // the last layer list renderer.sync handed over
  let state = null;       // { buffer, docId, width, height, sourceId }
  let offscreen = 0;      // renderImage calls in flight: the overlay stays out until they finish

  const overlay = () => {
    const b = ctx.renderer.buffers.get(state.buffer);
    return { id: OVERLAY_ID, source: state.sourceId, matrix: [1, 0, 0, 1, 0, 0], opacity: 0.5, fill: 1, blend: 'normal', visible: true,
      mask: { components: [{ op: 'add', kind: 'bitmap', bitmap: b.engineId }], invert: true } };
  };
  const valid = () => {
    const d = ctx.store.doc;
    return !!(state && d && d.id === state.docId && d.width === state.width && d.height === state.height && ctx.renderer.buffers.get(state.buffer));
  };
  function push() {
    if (state && !valid()) drop();
    return setLayers0(state && !offscreen ? [...base, overlay()] : base);
  }
  function drop() { if (state) { eng.dropSource(state.sourceId); state = null; } }

  eng.setLayers = (list) => { base = list; return push(); };
  eng.renderImage = async (...args) => {
    offscreen++;
    try { if (offscreen === 1 && state) setLayers0(base); return await renderImage0(...args); }
    finally { offscreen--; if (!offscreen && state) { push(); eng.schedule(); } }
  };

  return {
    get on() { return valid(); },
    get buffer() { return valid() ? state.buffer : null; },
    // Turns the film on over selection buffer `buffer` (a document-size renderer mask buffer).
    enable(buffer) {
      drop();
      const d = ctx.store.doc;
      const red = new Uint8Array(d.width * d.height * 4);
      for (let i = 0; i < red.length; i += 4) { red[i] = 255; red[i + 3] = 255; }
      const s = eng.createPixelSource(red, d.width, d.height);
      state = { buffer, docId: d.id, width: d.width, height: d.height, sourceId: s.id };
    },
    disable() { drop(); },
    // Test hook: renders the document at a level of detail with the film, as the canvas shows it.
    async renderWithOverlay(lod = 0, rect = null) { push(); return renderImage0(lod, rect); },
  };
}
