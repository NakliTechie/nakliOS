// Lens profile corrections from lens data the person supplies (a lensfun XML database or Adobe .lcp files in the
// workspace). Atelier ships no lens data. load_lens_data reads a file into this session; set_lens_profile resolves a
// profile for a RAW layer's camera, lens and focal length (src/files/lensdb.js) and stores the resolved coefficients on
// the layer, so the document renders without the data file. The engine applies distortion, lateral CA and
// vignetting in its lens stage (tessella model.js lensProfilePlan).

import { needLayer, fail, change } from './util.js';
import { parseLensfun, parseLcp, findProfiles, resolveProfile, exifOf } from '../files/lensdb.js';

function rawLayer(ctx, id) {
  const l = needLayer(ctx, id);
  if (l.kind !== 'raw') fail('unsupported', 'lens profiles apply to RAW layers', 'change_target', 'open_photo');
  if (l.localOf) fail('unsupported', 'this layer is a local adjustment; set the lens profile on its base layer', 'change_target', 'set_lens_profile');
  return l;
}
async function exifFor(ctx, l) {
  const src = await ctx.renderer?.sourceSize(l);
  if (!src?.meta) fail('unsupported', 'the RAW decode gave no camera metadata', 'change_target', 'get_state');
  return exifOf(src.meta);
}
const dbsOf = (ctx) => (ctx.lensDbs ||= []);

export function register(bus, ctx) {
  bus.register('lens.load', async (a) => {
    const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace folder is open', 'use_ui_control', 'grant_folder');
    let text;
    try { text = await s.readText(a.path); } catch (e) { fail('invalid', `cannot read ${a.path}: ${e.message}`, 'fix_argument', 'list_files'); }
    let data;
    try { data = /<lensdatabase[\s>]/.test(text) ? parseLensfun(text) : parseLcp(text); } catch (e) { fail('invalid', `${a.path}: ${e.message}`, 'fix_argument', 'load_lens_data'); }
    const dbs = dbsOf(ctx);
    const i = dbs.findIndex((d) => d.path === a.path);
    if (i >= 0) dbs.splice(i, 1);
    dbs.push({ path: a.path, data });
    return data.kind === 'lensfun'
      ? { path: a.path, kind: 'lensfun', lenses: data.lenses.length, cameras: data.cameras.length, loaded: dbs.map((d) => d.path) }
      : { path: a.path, kind: 'lcp', profiles: data.profiles.length, lenses: [...new Set(data.profiles.map((p) => p.lensPretty || p.lens))], loaded: dbs.map((d) => d.path) };
  });

  bus.register('lens.list', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    const exif = await exifFor(ctx, l);
    return { layerId: l.id, exif, loaded: dbsOf(ctx).map((d) => d.path), candidates: findProfiles(dbsOf(ctx), exif).slice(0, 20), current: l.lensProfile ? { id: l.lensProfile.id, name: l.lensProfile.name, used: l.lensProfile.used } : null };
  });

  bus.register('lens.set', async (a) => {
    const l = rawLayer(ctx, a.layerId);
    if (a.profile === 'none') {
      await change(ctx, 'set_lens_profile', (doc) => { const x = doc.layers.find((y) => y.id === l.id); delete x.lensProfile; x.develop = { ...x.develop, lens_profile: 0 }; });
      return { layerId: l.id, lensProfile: null };
    }
    const dbs = dbsOf(ctx);
    if (!dbs.length) fail('unsupported', 'no lens data loaded; open a lensfun database (.xml) or Adobe lens profiles (.lcp) you own with load_lens_data', 'fix_argument', 'load_lens_data');
    const exif = await exifFor(ctx, l);
    let id = a.profile;
    if (id === 'auto') {
      const best = findProfiles(dbs, exif)[0];
      if (!best || best.score < 0.6) fail('unsupported', `no loaded profile matches the lens "${exif.lens || 'unknown'}"; pick one from list_lens_profiles`, 'fix_argument', 'list_lens_profiles');
      id = best.id;
    }
    if (!Number.isFinite(exif.focal) || exif.focal <= 0) fail('unsupported', 'the photo has no focal length in its metadata, so the profile cannot be interpolated', 'change_target', 'get_state');
    let r;
    try { r = resolveProfile(dbs, id, exif); } catch (e) { fail('invalid', e.message, 'fix_argument', 'list_lens_profiles'); }
    const amount = a.amount ?? 100;
    const dist = a.distortionAmount ?? amount; const vig = a.vignettingAmount ?? amount;
    await change(ctx, 'set_lens_profile', (doc) => {
      const x = doc.layers.find((y) => y.id === l.id);
      x.lensProfile = { id, name: r.profile.name, used: r.used, engine: r.profile };
      x.develop = { ...x.develop, lens_profile: 1, lens_profile_distortion: dist, lens_profile_vignetting: vig };
    });
    return { layerId: l.id, lensProfile: { id, name: r.profile.name, used: r.used, parts: Object.keys(r.profile).filter((k) => k !== 'name') }, amounts: { distortion: dist, vignetting: vig } };
  });
}
