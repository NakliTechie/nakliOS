// Layer styles (P14): drop shadow, inner shadow, stroke and gradient overlay on image, text and raster layers. The
// engine renders them (tessella model.js stylePlan); this handler validates, turns hex colours into the engine's
// linear Rec.2020 values and stores the result on the layer. Colours stay as given (hex or [r, g, b]) in the document.

import { needLayer, fail, change } from './util.js';
import { hexToLinear2020 } from '../document.js';
import { stylePlan, STYLE_KEYS } from '../../vendor/tessella/src/model.js';

const COLOUR_KEYS = ['colour', 'from', 'to'];
// Hex '#rrggbb' → linear Rec.2020 [r, g, b]; arrays pass through.
export function engineStyles(styles) {
  const out = {};
  for (const [k, v] of Object.entries(styles)) {
    if (v === null) continue;
    out[k] = { ...v };
    for (const c of COLOUR_KEYS) if (typeof v[c] === 'string') {
      if (!/^#?[0-9a-f]{6}$/i.test(v[c])) fail('invalid', `${k}.${c} must be '#rrggbb' or [r, g, b] linear Rec.2020`, 'fix_argument', 'set_layer_style');
      out[k][c] = hexToLinear2020(v[c]).slice(0, 3);
    }
  }
  return out;
}

export function register(bus, ctx) {
  bus.register('layer.style', async (a) => {
    const l = needLayer(ctx, a.layerId);
    if (!['image', 'text', 'raster'].includes(l.kind)) fail('unsupported', 'layer styles apply to image, text and raster layers', 'change_target', 'set_layer_style');
    for (const k of Object.keys(a.styles)) if (!STYLE_KEYS.includes(k)) fail('unsupported', `layer style ${k}; use ${STYLE_KEYS.join(', ')}`, 'fix_argument', 'set_layer_style');
    // Each style given replaces that style; null removes it; styles not named stay.
    const merged = { ...(l.styleSource || {}), ...a.styles };
    for (const [k, v] of Object.entries(merged)) if (v === null) delete merged[k];
    const eng = engineStyles(merged);
    try { stylePlan(eng); } catch (e) { fail(e.code === 'unsupported' ? 'unsupported' : 'invalid', e.message, 'fix_argument', 'set_layer_style'); }
    await change(ctx, 'set_layer_style', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      if (Object.keys(merged).length) { x.styleSource = merged; x.styles = eng; } else { delete x.styleSource; delete x.styles; }
    });
    return { layerId: l.id, styles: Object.keys(merged).length ? merged : null };
  });
}
