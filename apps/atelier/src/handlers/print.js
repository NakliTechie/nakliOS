// Print preparation: a soft-proof adjustment layer on top of the document (printed colour, optional gamut warning),
// CMYK readouts at a point, and CMYK TIFF export. Two presses: the engine's built-in naive press (tessella model.js
// PRESS, the default) or a CMYK ICC output profile the person keeps in the workspace (profile: path), read with
// LittleCMS (src/files/cms.js): the proof layer stores the profile path and intent, the renderer builds the engine's
// proof table from it, and export separates through it and embeds the profile. Readouts stay on the naive press.

import { needDoc, fail, change, stageOrRun } from './util.js';
import { makeLayer } from '../document.js';
import { printColour, floatToCmyk8 } from '../files/print.js';
import { writeTiff } from '../files/tiff.js';
import { cmykProfileInfo, rgb16ToCmyk16 } from '../files/cms.js';
import { M2020_709 } from '../files/print.js';

const PRESS_NAME = 'Atelier naive press (built-in four-ink model, not a characterised printing condition)';
const isProof = (l) => l.kind === 'adjustment' && l.adjustment?.type === 'proof' && !l.parentId;
const isIcc = (p) => /\.(icc|icm)$/i.test(p);

export function register(bus, ctx) {
  // A person's CMYK profile from the workspace: { bytes, name }, refused unless LittleCMS reads it as CMYK.
  async function profileAt(path, tool) {
    const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace folder is open', 'use_ui_control', 'grant_folder');
    if (!isIcc(path)) fail('invalid', 'profile is a workspace path ending in .icc or .icm', 'fix_argument', tool);
    if (!(await s.exists(path))) fail('invalid', `no file ${path} in the workspace`, 'fix_argument', 'list_folder');
    const bytes = await s.readBinary(path);
    try { return { bytes, name: (await cmykProfileInfo(bytes)).name }; } catch (e) { fail('invalid', `${path}: ${e.message}`, 'change_target', tool); }
  }

  bus.register('print.proof', async (a) => {
    const d = needDoc(ctx);
    const cur = d.layers.find(isProof);
    if (!a.on) {
      if (!cur) return { softProof: null };
      await change(ctx, 'set_soft_proof', (doc) => { doc.layers = doc.layers.filter((l) => l.id !== cur.id); });
      return { softProof: null };
    }
    const was = cur?.adjustment.params || {};
    const profile = a.profile === null ? null : a.profile ?? (was.model === 'icc' ? was.profile : null);
    let params; let press = PRESS_NAME;
    if (profile) {
      if (a.tac != null) fail('invalid', 'tac sets the naive press ink limit; an ICC profile carries its own', 'fix_argument', 'set_soft_proof');
      press = `ICC profile: ${(await profileAt(profile, 'set_soft_proof')).name}`;
      params = { model: 'icc', profile, intent: a.intent ?? (was.model === 'icc' ? was.intent : null) ?? 'relative', warning: a.warning ?? was.warning ?? false };
    } else {
      if (a.intent != null) fail('invalid', 'intent applies to an ICC profile; pass profile too', 'fix_argument', 'set_soft_proof');
      params = { tac: a.tac ?? was.tac ?? 300, warning: a.warning ?? was.warning ?? false };
    }
    if (a.warningColour) params.warningColour = a.warningColour;
    else if (was.warningColour) params.warningColour = was.warningColour;
    let id = cur?.id;
    await change(ctx, 'set_soft_proof', (doc) => {
      const x = doc.layers.find((l) => l.id === id);
      if (x) { x.adjustment = { type: 'proof', params }; doc.layers = [...doc.layers.filter((l) => l !== x), x]; }   // keep it on top
      else { const l = makeLayer('adjustment', { name: 'Soft proof', adjustment: { type: 'proof', params } }); id = l.id; doc.layers.push(l); }
    });
    return { softProof: { layerId: id, ...params, press } };
  });

  bus.register('print.sample', async (a) => {
    const doc = needDoc(ctx);
    const r = a.radius ?? 0;
    if (a.x < 0 || a.y < 0 || a.x >= doc.width || a.y >= doc.height) fail('invalid', 'point is outside the document', 'fix_argument', 'sample_print_color');
    const proof = doc.layers.find(isProof);
    if (proof?.visible) await ctx.renderer.sync({ ...doc, layers: doc.layers.filter((l) => l !== proof) });   // read the colour before the proof
    let im;
    try { im = await ctx.engine.renderImage(0, [a.x - r, a.y - r, a.x + r + 1, a.y + r + 1]); } finally { if (proof?.visible) await ctx.renderer.sync(doc); }
    const n = im.width * im.height; const sum = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) for (let c = 0; c < 4; c++) sum[c] += im.data[i * 4 + c];
    const k = sum[3] > 0 ? 1 / sum[3] : 0; const alpha = sum[3] / n;
    const lin = [0, 1, 2].map((c) => sum[c] * k * alpha + (1 - alpha));   // flattened on white paper
    return { x: a.x, y: a.y, radius: r, ...printColour(lin, a.tac ?? 300), tac: a.tac ?? 300, press: PRESS_NAME };
  });

  bus.register('print.export', async (a, { door }) => {
    const s = ctx.storage(); const d = needDoc(ctx);
    if (!s) fail('unsupported', 'no workspace folder is open', 'use_ui_control', 'grant_folder');
    if (!/\.tiff?$/i.test(a.path)) fail('invalid', 'the path must end in .tif or .tiff', 'fix_argument', 'export_cmyk_tiff');
    const tac = a.tac ?? 300; const bits = a.bits ?? 8;
    if (a.profile && a.tac != null) fail('invalid', 'tac sets the naive press ink limit; an ICC profile carries its own', 'fix_argument', 'export_cmyk_tiff');
    if (!a.profile && (a.intent != null || a.bits === 16)) fail('invalid', 'intent and 16-bit output need an ICC profile; pass profile', 'fix_argument', 'export_cmyk_tiff');
    const prof = a.profile ? await profileAt(a.profile, 'export_cmyk_tiff') : null;
    const replaces = await s.exists(a.path);
    const via = prof ? `ICC profile ${prof.name}, ${a.intent ?? 'relative'} intent` : `naive press, total ink ${tac} %`;
    return stageOrRun(ctx, { door }, 'export_cmyk_tiff', `${replaces ? `REPLACE existing ${a.path} with ` : ''}export "${d.title}" as a ${bits}-bit CMYK TIFF (${via})${replaces ? '' : ` to ${a.path}`}`, async () => {
      const doc = needDoc(ctx);
      const lod = a.maxEdge ? ctx.renderer.lodFor(doc, a.maxEdge) : 0;
      await ctx.renderer.sync({ ...doc, layers: doc.layers.filter((l) => !isProof(l)) });
      let im;
      try { im = await ctx.engine.renderImage(lod); } finally { await ctx.sync(); }
      if (prof) {
        // linear Rec.2020 premultiplied → flattened on white paper → linear Rec.709 → sRGB-encoded 16-bit (clipped to
        // Rec.709, LittleCMS's sRGB input profile) → CMYK 16-bit through the person's profile (BPC on).
        const n = im.width * im.height; const rgb = new Uint16Array(n * 3);
        for (let p = 0; p < n; p++) {
          const al = im.data[p * 4 + 3]; const lin = [0, 1, 2].map((c) => im.data[p * 4 + c] + (1 - al));
          for (let c = 0; c < 3; c++) { const v = Math.min(1, Math.max(0, M2020_709[c][0] * lin[0] + M2020_709[c][1] * lin[1] + M2020_709[c][2] * lin[2])); rgb[p * 3 + c] = Math.round(65535 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)); }
        }
        const { cmyk } = await rgb16ToCmyk16(prof.bytes, rgb, n, { intent: a.intent ?? 'relative' });
        const data = bits === 16 ? cmyk : Uint8Array.from(cmyk, (v) => Math.round(v / 257));
        const bytes = await writeTiff([{ width: im.width, height: im.height, bits, channels: 4, photometric: 5, data, icc: prof.bytes, description: `CMYK, ICC profile ${prof.name}` }]);
        await s.write(a.path, bytes);
        return { path: a.path, bytes: bytes.length, width: im.width, height: im.height, colour: `CMYK ${bits}-bit, ICC profile embedded`, profile: a.profile, profileName: prof.name, intent: a.intent ?? 'relative', replaced: replaces };
      }
      const data = floatToCmyk8(im, tac);
      const bytes = await writeTiff([{ width: im.width, height: im.height, bits: 8, channels: 4, photometric: 5, data, description: `CMYK, ${PRESS_NAME}, total ink ${tac} %` }]);
      await s.write(a.path, bytes);
      return { path: a.path, bytes: bytes.length, width: im.width, height: im.height, colour: 'CMYK 8-bit, no ICC profile', press: PRESS_NAME, tac, replaced: replaces };
    }, { force: replaces });
  });
}
