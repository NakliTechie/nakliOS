// Lens correction data the person supplies: a lensfun XML database or Adobe Lens Profile (.lcp) files. Atelier
// ships no lens data (lensfun's database is CC-BY-SA and its code LGPL; Adobe's profiles are Adobe's), so the person
// opens files they own. This module parses both formats, matches a photo's camera and lens, interpolates between
// calibrated focal lengths, and resolves one profile in the engine's form (tessella model.js lensProfilePlan):
//   { name, distortion?: { unit, c: [c0..c6] }, tca?: { unit, red: [c0..c6], blue: [c0..c6] }, vignette?: { unit, k: [k1, k2, k3] } }
// Every polynomial g(r) = Σ c_i r^i maps an undistorted radius to the sensor radius (r in unit radii).
//
// Conversions (Atelier's own reading of each format; formulas next to the code):
//   lensfun distortion, r in half the shorter image side × (camera crop / calibration crop):
//     poly3: Rd = Ru (1 - k1 + k1 Ru²) → [1 - k1, 0, k1]; poly5: Rd = Ru (1 + k1 Ru² + k2 Ru⁴) → [1, 0, k1, 0, k2];
//     ptlens: Rd = Ru (a Ru³ + b Ru² + c Ru + 1 - a - b - c) → [1 - a - b - c, c, b, a].
//   lensfun TCA (same unit): linear Rd = k Ru → [k]; poly3 Rd = Ru (b Ru² + c Ru + v) → [v, c, b] (red: vr, cr, br; blue: vb, cb, bb).
//   lensfun vignetting pa, r in half the image diagonal × (camera crop / calibration crop): Cd = Cs (1 + k1 r² + k2 r⁴ + k3 r⁶).
//   LCP (Adobe camera model), r in FocalLengthX × the longer image side: distortion x_d = x (1 + k1 r² + k2 r⁴ + k3 r⁶)
//     → [1, 0, k1, 0, k2, 0, k3]; lateral CA x_c = ScaleFactor (1 + k1 r² + k2 r⁴ + k3 r⁶) x_green; vignette
//     1 + a1 r² + a2 r⁴ + a3 r⁶. Each LCP polynomial is rescaled to r in the longer side (c_i / F^i), so entries share a unit.
//   Interpolation: per calibrated focal length one entry (vignetting: the aperture nearest the photo's, in stops, then the
//   largest focus distance); coefficients interpolate linearly in focal length between the two nearest focal lengths and
//   hold the nearest outside the calibrated range.
// Limits: the optical centre is the image centre (LCP ImageXCenter/YCenter and lensfun centre offsets are not applied);
// LCP tangential terms are not applied.

// ---- a small XML reader (elements, attributes, text; enough for lensfun and LCP files) --------------------------------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENT[e] ?? m));
export function parseXml(text) {
  const root = { name: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<![^>]*>|<\/\s*([^\s>]+)\s*>|<([^\s/>]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(text))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2]) {
      if (stack.length > 1 && top.name === m[2]) stack.pop();
      else throw new Error(`XML: </${m[2]}> does not close <${top.name}>`);
    } else if (m[3]) {
      const attrs = {};
      for (const a of m[4].matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[2] ?? a[3]);
      const el = { name: m[3], attrs, children: [], text: '' };
      top.children.push(el);
      if (!m[5]) stack.push(el);
    } else if (m[6] !== undefined) top.text += decode(m[6]);
  }
  if (stack.length !== 1) throw new Error(`XML: <${stack[stack.length - 1].name}> is not closed`);
  return root;
}
const kids = (el, name) => el.children.filter((c) => c.name === name);
const firstText = (el, name) => {
  const all = kids(el, name);
  const plain = all.find((c) => !c.attrs.lang) || all[0];
  return plain ? plain.text.trim() : '';
};
const num = (v, d = 0) => { const x = parseFloat(v); return Number.isFinite(x) ? x : d; };

// ---- lensfun ------------------------------------------------------------------------------------------------------
export function parseLensfun(text) {
  const root = parseXml(text);
  const db = root.children.find((c) => c.name === 'lensdatabase');
  if (!db) throw new Error('not a lensfun database (no <lensdatabase>)');
  const cameras = kids(db, 'camera').map((c) => ({ maker: firstText(c, 'maker'), model: firstText(c, 'model'), variant: firstText(c, 'variant'), mount: firstText(c, 'mount'), crop: num(firstText(c, 'cropfactor'), 1) }));
  const lenses = kids(db, 'lens').map((l) => {
    const cal = kids(l, 'calibration')[0] || { children: [] };
    const at = (e) => Object.fromEntries(Object.entries(e.attrs).map(([k, v]) => [k, k === 'model' ? v : num(v, NaN)]));
    return {
      maker: firstText(l, 'maker'), model: firstText(l, 'model'), mount: firstText(l, 'mount'), crop: num(firstText(l, 'cropfactor'), 1),
      distortion: kids(cal, 'distortion').map(at), tca: kids(cal, 'tca').map(at), vignetting: kids(cal, 'vignetting').map(at),
    };
  }).filter((l) => l.model && (l.distortion.length || l.tca.length || l.vignetting.length));
  return { kind: 'lensfun', cameras, lenses };
}

// lensfun model → polynomial coefficients (see the header).
export function lensfunDistortion(e) {
  if (e.model === 'poly3') return [1 - e.k1, 0, e.k1];
  if (e.model === 'poly5') return [1, 0, e.k1, 0, e.k2 || 0];
  if (e.model === 'ptlens') { const a = e.a || 0; const b = e.b || 0; const c = e.c || 0; return [1 - a - b - c, c, b, a]; }
  if (e.model === 'none') return [1];
  throw new Error(`lensfun distortion model ${e.model} is not supported`);
}
export function lensfunTca(e) {
  if (e.model === 'linear') return { red: [e.kr ?? 1], blue: [e.kb ?? 1] };
  if (e.model === 'poly3') return { red: [e.vr ?? 1, e.cr || 0, e.br || 0], blue: [e.vb ?? 1, e.cb || 0, e.bb || 0] };
  if (e.model === 'none') return { red: [1], blue: [1] };
  throw new Error(`lensfun TCA model ${e.model} is not supported`);
}

// ---- Adobe LCP ----------------------------------------------------------------------------------------------------
// Properties of an rdf:Description, as attributes or simple child elements, without the stCamera: prefix.
function props(d) {
  const out = {};
  for (const [k, v] of Object.entries(d.attrs)) out[k.replace(/^[^:]*:/, '')] = v;
  for (const c of d.children) if (!c.children.length) out[c.name.replace(/^[^:]*:/, '')] = c.text.trim();
  return out;
}
const sub = (d, name) => { const c = d.children.find((x) => x.name.replace(/^[^:]*:/, '') === name); return c ? c.children.find((x) => x.name === 'rdf:Description') || null : null; };
export function parseLcp(text) {
  const root = parseXml(text);
  const out = [];
  const walk = (el) => {
    if (el.name === 'rdf:li') {
      const d = el.children.find((c) => c.name === 'rdf:Description');
      const pm = d && sub(d, 'PerspectiveModel');
      if (pm) {
        const p = props(d); const q = props(pm);
        const F = num(q.FocalLengthX, 1);
        const radial = (x, F0) => { const f = num(x.FocalLengthX, F0); return { F: f, k: [num(x.RadialDistortParam1), num(x.RadialDistortParam2), num(x.RadialDistortParam3)] }; };
        const ca = (name) => { const e = sub(pm, name); if (!e) return null; const x = props(e); return { ...radial(x, F), scale: num(x.ScaleFactor, 1) }; };
        const vg = sub(pm, 'VignetteModel'); const v = vg ? props(vg) : null;
        out.push({
          make: p.Make || '', model: p.Model || '', lens: p.Lens || p.LensPrettyName || '', lensPretty: p.LensPrettyName || '', profileName: p.ProfileName || '',
          raw: String(p.CameraRawProfile).toLowerCase() === 'true', crop: num(p.SensorFormatFactor, 1),
          focal: num(p.FocalLength, NaN), distance: num(p.FocusDistance, 0), aperture: p.ApertureValue !== undefined ? 2 ** (num(p.ApertureValue) / 2) : NaN,
          distortion: radial(q, F), red: ca('ChromaticRedGreenModel'), blue: ca('ChromaticBlueGreenModel'),
          vignette: v ? { F: num(v.FocalLengthX, F), k: [num(v.VignetteModelParam1), num(v.VignetteModelParam2), num(v.VignetteModelParam3)] } : null,
        });
      }
    }
    el.children.forEach(walk);
  };
  walk(root);
  if (!out.length) throw new Error('not an Adobe lens profile (no stCamera PerspectiveModel)');
  return { kind: 'lcp', profiles: out };
}
// c_i (r_F) with r_F = r / F → coefficients in r (the longer side): c_i / F^i.
const rescale = (c, F) => c.map((v, i) => v / F ** i);

// ---- matching -----------------------------------------------------------------------------------------------------
// Lens names compare as token sets: lower case, "f/2.8" and "F2.8" both → "f2.8", "16-35mm" → "16", "35mm".
const tokens = (s) => String(s || '').toLowerCase().replace(/f\s*\/\s*(?=\d)/g, 'f').split(/[^a-z0-9.]+/).filter(Boolean);
export function nameScore(exifName, dbName, maker = '') {
  const drop = new Set(tokens(maker));
  const a = tokens(exifName).filter((t) => !drop.has(t)); const b = new Set(tokens(dbName).filter((t) => !drop.has(t)));
  if (!a.length || !b.size) return 0;
  const hit = a.filter((t) => b.has(t)).length;
  return (2 * hit) / (a.length + b.size);
}
const sameText = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

// exif: { make, model, lens, focal, aperture, focal35 } from the RAW decode. Returns candidates, best first:
// [{ id, name, source, kind, score }]. dbs: [{ path, data: parseLensfun | parseLcp result }].
export function findProfiles(dbs, exif) {
  const out = [];
  for (const { path, data } of dbs) {
    if (data.kind === 'lensfun') {
      data.lenses.forEach((l, i) => {
        const score = nameScore(exif.lens, `${l.maker} ${l.model}`, l.maker);
        if (score > 0) out.push({ id: `${path}#${i}`, name: `${l.maker} ${l.model}`.trim(), source: path, kind: 'lensfun', score: +score.toFixed(3) });
      });
    } else {
      const groups = new Map();
      for (const p of data.profiles) {
        const key = `${p.make}|${p.model}|${p.lens}|${p.raw}`;
        if (!groups.has(key)) groups.set(key, p);
      }
      for (const [key, p] of groups) {
        let score = Math.max(nameScore(exif.lens, p.lens), nameScore(exif.lens, p.lensPretty));
        if (score > 0 && p.model && !sameText(p.model, exif.model)) score *= 0.9; // a profile for another body
        if (score > 0 && !p.raw) score *= 0.95; // a JPEG profile, when a RAW one may exist
        if (score > 0) out.push({ id: `${path}#${key}`, name: p.lensPretty || p.lens, source: path, kind: 'lcp', camera: `${p.make} ${p.model}`.trim(), score: +score.toFixed(3) });
      }
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

// Camera crop factor: a lensfun camera entry for the body, else EXIF's 35 mm focal length ÷ focal length, else 1.
export function cameraCrop(dbs, exif) {
  for (const { data } of dbs) if (data.kind === 'lensfun') {
    const c = data.cameras.find((x) => sameText(x.maker, exif.make) && sameText(x.model, exif.model));
    if (c) return c.crop;
  }
  if (exif.focal35 > 0 && exif.focal > 0) return Math.round((exif.focal35 / exif.focal) * 100) / 100;
  return 1;
}

// One entry per focal length → coefficients at the photo's focal length (linear in focal, nearest outside the range).
// entries: [{ focal, value: number[] }]; arrays are padded with zeros to the longest.
export function interpolateFocal(entries, focal) {
  const e = entries.filter((x) => Number.isFinite(x.focal)).sort((a, b) => a.focal - b.focal);
  if (!e.length) return null;
  const n = Math.max(...e.map((x) => x.value.length));
  const pad = (v) => [...v, ...new Array(n - v.length).fill(0)];
  if (!(focal > e[0].focal)) return pad(e[0].value);
  if (focal >= e[e.length - 1].focal) return pad(e[e.length - 1].value);
  let i = 0; while (e[i + 1].focal < focal) i++;
  const t = (focal - e[i].focal) / (e[i + 1].focal - e[i].focal);
  const a = pad(e[i].value); const b = pad(e[i + 1].value);
  return a.map((v, k) => v + (b[k] - v) * t);
}
const stops = (a, b) => Math.abs(Math.log2(a) - Math.log2(b));
// Per focal length, the entry whose aperture is nearest the photo's (in stops; widest when unknown), then the farthest focus.
function perFocal(list, aperture, apOf = (x) => x.aperture, distOf = (x) => x.distance) {
  const by = new Map();
  for (const x of list) { const f = x.focal; if (!by.has(f)) by.set(f, []); by.get(f).push(x); }
  return [...by.values()].map((g) => g.slice().sort((p, q) => {
    const ap = Number.isFinite(aperture) && aperture > 0
      ? (Number.isFinite(apOf(p)) ? stops(apOf(p), aperture) : 99) - (Number.isFinite(apOf(q)) ? stops(apOf(q), aperture) : 99)
      : (apOf(p) || 99) - (apOf(q) || 99);
    return ap || ((distOf(q) || 0) - (distOf(p) || 0));
  })[0]);
}

// Resolves candidate `id` for the photo → the engine profile, plus what was used.
export function resolveProfile(dbs, id, exif) {
  const hash = id.indexOf('#');
  const path = id.slice(0, hash); const key = id.slice(hash + 1);
  const db = dbs.find((d) => d.path === path);
  if (!db) throw new Error(`no lens data loaded from ${path}`);
  const focal = exif.focal;
  if (db.data.kind === 'lensfun') {
    const l = db.data.lenses[+key];
    if (!l) throw new Error(`no lens ${key} in ${path}`);
    const scale = cameraCrop(dbs, exif) / (l.crop || 1);
    const prof = { name: `${l.maker} ${l.model}`.trim() };
    const short = { norm: 'halfShort', scale }; const diag = { norm: 'halfDiag', scale };
    if (l.distortion.length) prof.distortion = { unit: short, c: interpolateFocal(l.distortion.map((e) => ({ focal: e.focal, value: lensfunDistortion(e) })), focal) };
    if (l.tca.length) {
      const t = l.tca.map((e) => ({ focal: e.focal, ...lensfunTca(e) }));
      prof.tca = { unit: short, red: interpolateFocal(t.map((e) => ({ focal: e.focal, value: e.red })), focal), blue: interpolateFocal(t.map((e) => ({ focal: e.focal, value: e.blue })), focal) };
    }
    if (l.vignetting.length) {
      const v = perFocal(l.vignetting.filter((e) => e.model === 'pa'), exif.aperture);
      if (v.length) prof.vignette = { unit: diag, k: interpolateFocal(v.map((e) => ({ focal: e.focal, value: [e.k1 || 0, e.k2 || 0, e.k3 || 0] })), focal) };
    }
    return { profile: prof, used: { kind: 'lensfun', lens: prof.name, focal, cropScale: +scale.toFixed(4), focalLengths: [...new Set(l.distortion.concat(l.tca, l.vignetting).map((e) => e.focal))].sort((a, b) => a - b) } };
  }
  const [make, model, lens, raw] = key.split('|');
  const list = db.data.profiles.filter((p) => p.make === make && p.model === model && p.lens === lens && String(p.raw) === raw);
  if (!list.length) throw new Error(`no profile ${key} in ${path}`);
  const pick = perFocal(list, exif.aperture);
  const long1 = { norm: 'long', scale: 1 };
  const prof = { name: list[0].lensPretty || list[0].lens };
  prof.distortion = { unit: long1, c: interpolateFocal(pick.map((p) => ({ focal: p.focal, value: rescale([1, 0, p.distortion.k[0], 0, p.distortion.k[1], 0, p.distortion.k[2]], p.distortion.F) })), focal) };
  const caOf = (x) => (x ? rescale([x.scale, 0, x.scale * x.k[0], 0, x.scale * x.k[1], 0, x.scale * x.k[2]], x.F) : [1]);
  if (pick.some((p) => p.red || p.blue)) prof.tca = { unit: long1, red: interpolateFocal(pick.map((p) => ({ focal: p.focal, value: caOf(p.red) })), focal), blue: interpolateFocal(pick.map((p) => ({ focal: p.focal, value: caOf(p.blue) })), focal) };
  const vs = pick.filter((p) => p.vignette);
  // Vignette 1 + a1 r_F² + a2 r_F⁴ + a3 r_F⁶ with r_F = r / F: k_j = a_j / F^(2j).
  if (vs.length) prof.vignette = { unit: long1, k: interpolateFocal(vs.map((p) => ({ focal: p.focal, value: p.vignette.k.map((a, j) => a / p.vignette.F ** (2 * j + 2)) })), focal) };
  return { profile: prof, used: { kind: 'lcp', lens: prof.name, camera: `${make} ${model}`.trim(), focal, focalLengths: [...new Set(pick.map((p) => p.focal))].sort((a, b) => a - b) } };
}

// Data a handler needs from a RAW decode's metadata (LibRaw field names).
export const exifOf = (meta) => ({
  make: meta?.camera_make || '', model: meta?.camera_model || '', lens: meta?.lens?.Lens || '',
  focal: meta?.focal_len || NaN, aperture: meta?.aperture || NaN, focal35: meta?.lens?.FocalLengthIn35mmFormat || NaN,
});
