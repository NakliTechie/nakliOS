// Photo merge (L44 panorama, L45 HDR, L46 focus stack; P57): reads two or more workspace photos, merges
// them with classical code (src/merge/, no model) in a module worker, writes the result as a new file
// next to the first photo and opens it.
// Output: HDR (default) → an Atelier document (.atelier) whose one layer develops a linear float source
// (tessella createLinearSource): float32 linear camera RGB (sRGB primaries for browser images), saved as a
// 32-bit float TIFF beside the document (src/files/linear.js), so values above 1.0 keep full float precision.
// HDR with an output ending .dng, and panorama and focus stack of RAW inputs → a linear DNG (16-bit LinearRaw
// in the camera's own RGB, with the camera's colour matrix and as-shot neutral, src/merge/dng.js), so the
// Develop module tones it like any RAW. Both HDR forms map the brightest white-balanced value to 1.0 (the
// develop pass clips there) and open with the exposure that brings the reference bracket back to its own
// brightness. Panorama and focus stack of browser images → a 16-bit sRGB TIFF (panorama with alpha).
// Writing a file is irreversible: staged for the person unless the call is their own click; replacing a
// file that exists is always staged.

import { writeLinearDng, XYZ_TO_SRGB } from '../merge/dng.js';
import { dropAlpha, oetf } from '../merge/image.js';
import { writeTiff } from '../files/tiff.js';
import { linearDocument } from '../files/linear.js';
import { SRGB_TO_REC2020 } from '../../vendor/tessella/src/model.js';
import { photoKind, baseName, stem } from '../files/workspace.js';
import { fail, stageOrRun } from './util.js';

const OPS = {
  merge_hdr: { op: 'hdr', suffix: 'HDR', min: 2 },
  merge_panorama: { op: 'panorama', suffix: 'Pano', min: 2 },
  merge_focus_stack: { op: 'focus', suffix: 'Stack', min: 2 },
};

// Runs a merge in a module worker (browser) or inline (node tests).
async function runMerge(op, frames, opts) {
  if (typeof Worker === 'undefined') {
    const mod = op === 'hdr' ? await import('../merge/hdr.js') : op === 'panorama' ? await import('../merge/pano.js') : await import('../merge/focus.js');
    const { LIN16_LUT, SRGB8_LUT } = await import('../merge/image.js');
    const fn = op === 'hdr' ? mod.mergeHdr : op === 'panorama' ? mod.stitchPanorama : mod.focusStack;
    return fn(frames.map((f) => ({ ...f, lut: f.lut === 'lin16' ? LIN16_LUT : f.lut === 'srgb8' ? SRGB8_LUT : null })), opts);
  }
  const w = new Worker(new URL('../merge/worker.js', import.meta.url), { type: 'module', name: 'atelier-merge' });
  try {
    return await new Promise((resolve, reject) => {
      w.onmessage = (e) => (e.data.ok ? resolve(e.data.result) : reject(new Error(e.data.error)));
      w.onerror = (e) => reject(new Error(`merge worker failed: ${e.message || 'could not start'}`));
      const transfer = frames.map((f) => f.data.buffer).filter((b, i) => frames[i].data.byteOffset === 0 && frames[i].data.byteLength === b.byteLength);
      w.postMessage({ op, frames, opts }, [...new Set(transfer)]);
    });
  } finally { w.terminate(); }
}

export function register(bus, ctx) {
  const engine = () => { const e = ctx.renderer?.engine ?? ctx.engine; if (!e) fail('unsupported', 'merging decodes photos with the WebGPU engine, which did not start', 'get_state', 'get_capabilities'); return e; };
  const store = () => { const s = ctx.storage(); if (!s) fail('unsupported', 'no workspace folder is open', 'use_ui_control', 'grant_folder'); return s; };

  // Decodes the inputs into compact linear frames. RAW: LibRaw's 16-bit camera RGB (white-balanced as shot);
  // browser images: 8-bit sRGB. The engine sources are dropped once their pixels are copied out.
  async function loadFrames(paths) {
    const s = store(); const kinds = paths.map(photoKind);
    const bad = paths.filter((p, i) => !kinds[i]); if (bad.length) fail('unsupported', `${bad.join(', ')}: merges read RAW or browser images (JPEG, PNG, WebP)`, 'fix_argument', 'list_folder');
    if (new Set(kinds).size > 1) fail('invalid', 'mix of RAW and non-RAW photos; merge photos of one kind', 'fix_argument', 'list_folder');
    for (const p of paths) if (!(await s.exists(p))) fail('invalid', `no file ${p} in the workspace`, 'fix_argument', 'list_folder');
    const e = engine(); const frames = []; let camXyz = null; let gains = null; let camToRec2020 = null;
    for (const p of paths) {
      const bytes = await s.readBinary(p);
      if (kinds[0] === 'raw') {
        const src = await e.createRawSource(bytes); const x = e.source(src.id);
        frames.push({ width: x.width, height: x.height, data: x.data, lut: 'lin16' });
        camXyz ||= x.camXyz; gains ||= x.asShot?.gains; camToRec2020 ||= x.camToRec2020; // tessella reads a DNG's ColorMatrix (D65) when cam_xyz is zero
        e.dropSource(src.id);
      } else {
        const src = await e.createImageSource(new Blob([bytes])); const x = e.source(src.id);
        frames.push({ width: x.width, height: x.height, data: dropAlpha(x.pixels, x.width * x.height), lut: 'srgb8' });
        e.dropSource(src.id);
      }
    }
    if (kinds[0] === 'raw' && !camXyz) fail('unsupported', 'the RAW decode gave no camera colour matrix (cam_xyz), which the merged DNG needs', 'change_target', 'list_folder');
    return { kind: kinds[0], frames, camXyz, gains: gains || [1, 1, 1], camToRec2020 };
  }

  async function encode(tool, kind, res, { camXyz, gains, camToRec2020 }, outPath) {
    const neutral = gains.map((g) => 1 / g); const nmax = Math.max(...neutral);
    const raw = kind === 'raw';
    const dngOpts = raw ? { camXyz, neutral: neutral.map((v) => v / nmax), channelScale: gains.map((g) => 1 / g) } : { camXyz: XYZ_TO_SRGB, neutral: [1, 1, 1] };
    if (tool === 'merge_hdr') {
      let max = 0; for (let i = 0; i < res.data.length; i++) if (res.data[i] > max) max = res.data[i];
      max = max || 1;
      const exposure = Math.min(5, Math.max(0, Math.log2(max)));
      if (outPath.toLowerCase().endsWith('.atelier')) {
        // Float source: data stays unscaled (values above 1.0 kept); scale = 1/max maps the brightest
        // white-balanced value to the develop pass's 1.0 clip; exposure log2(max) restores the reference.
        const data = res.data instanceof Float32Array ? res.data : Float32Array.from(res.data);
        const colour = raw ? { camToRec2020, camXyz, gains, scale: 1 / max } : { camToRec2020: SRGB_TO_REC2020, camXyz: XYZ_TO_SRGB, gains: [1, 1, 1], scale: 1 / max };
        const ev = Math.round(exposure * 100) / 100;
        const d = await linearDocument({ path: outPath, title: baseName(outPath), width: res.width, height: res.height, data, colour, develop: ev > 0.01 ? { exposure: ev } : {} });
        return { ext: 'atelier', bytes: d.json, files: d.files, exposure: 0, docExposure: ev, max };
      }
      // 16-bit linear, brightest white-balanced value at full scale; Develop exposure log2(max) restores the reference.
      return { ext: 'dng', bytes: writeLinearDng(res, { ...dngOpts, bits: 16, scale: 1 / max, model: 'Atelier HDR merge', description: `HDR merge; reference exposure at 1/${max.toFixed(3)} of full scale` }), exposure };
    }
    if (raw) return { ext: 'dng', bytes: writeLinearDng(res, { ...dngOpts, bits: 16, scale: 1 / 65535, model: tool === 'merge_panorama' ? 'Atelier panorama' : 'Atelier focus stack' }) };
    // browser images: 16-bit sRGB TIFF (panorama keeps its uncovered corners transparent)
    const n = res.width * res.height; const alpha = tool === 'merge_panorama' && res.coverage; const ch = alpha ? 4 : 3;
    const lut = Uint16Array.from({ length: 65536 }, (_, i) => Math.round(65535 * oetf(i / 65535)));
    const out = new Uint16Array(n * ch);
    for (let i = 0; i < n; i++) { for (let c = 0; c < 3; c++) out[i * ch + c] = lut[res.data[i * 3 + c]]; if (alpha) out[i * 4 + 3] = res.coverage[i] ? 65535 : 0; }
    return { ext: 'tif', bytes: await writeTiff([{ width: res.width, height: res.height, bits: 16, channels: ch, data: out }]) };
  }

  for (const [tool, spec] of Object.entries(OPS)) {
    bus.register(`merge.${spec.op}`, async (a, opts) => {
      const s = store(); engine();
      const paths = [...new Set(a.paths)];
      if (paths.length < spec.min) fail('invalid', `${tool} needs at least ${spec.min} different photos`, 'fix_argument', tool);
      const kinds = paths.map(photoKind);
      const raw = kinds.every((k) => k === 'raw');
      const ext = tool === 'merge_hdr' ? (a.output && /\.dng$/i.test(a.output) ? 'dng' : 'atelier') : raw ? 'dng' : 'tif';
      const dir = paths[0].includes('/') ? paths[0].slice(0, paths[0].lastIndexOf('/') + 1) : '';
      const out = a.output ?? `${dir}${stem(paths[0])}-${spec.suffix}.${ext}`;
      if (!out.toLowerCase().endsWith(`.${ext}`)) fail('invalid', tool === 'merge_hdr' ? 'merge_hdr writes an Atelier document (.atelier, float) or a linear DNG (.dng, 16-bit); output must end in one of those' : `this merge writes a .${ext} file; output must end in .${ext}`, 'fix_argument', tool);
      if (paths.includes(out)) fail('invalid', 'output would replace one of the inputs', 'fix_argument', tool);
      const replaces = await s.exists(out);
      const what = `${replaces ? `REPLACE ${out} with ` : ''}merge ${paths.length} photos (${paths.map(baseName).join(', ')}) into ${tool === 'merge_hdr' ? 'an HDR' : tool === 'merge_panorama' ? 'a panorama' : 'a focus stack'}${replaces ? '' : ` → ${out}`}`;
      return stageOrRun(ctx, opts, tool, what, async () => {
        ctx.busy = tool;
        let res; let file;
        try {
          const loaded = await loadFrames(paths);
          const mergeOpts = tool === 'merge_hdr' ? { align: a.align ?? true, deghost: a.deghost ?? 'off' }
            : tool === 'merge_panorama' ? { projection: a.projection ?? 'cylindrical', out16: true }
              : { align: a.align ?? true, out16: true, ...(a.smoothing ? { smoothing: a.smoothing } : {}) };
          try { res = await runMerge(spec.op, loaded.frames, mergeOpts); } catch (e) { fail('invalid', `nothing written: ${e.message}`, 'change_target', 'list_folder'); }
          file = await encode(tool, loaded.kind, res, loaded, out);
          for (const f of file.files || []) await s.write(f.path, f.bytes);   // buffer binaries before the document that names them
          await s.write(out, file.bytes);
        } finally { ctx.busy = null; }
        const result = {
          path: out, bytes: file.bytes.length, width: res.width, height: res.height, frames: paths.length, format: file.ext === 'atelier' ? 'Atelier document, float32 linear source (32-bit float TIFF)' : file.ext === 'dng' ? 'linear DNG, 16-bit' : 'TIFF, 16-bit sRGB',
          ...(file.ext === 'atelier' ? { sourceFile: file.files[0].path, maxValue: Math.round(file.max * 1000) / 1000, exposure: file.docExposure } : {}),
          ...(tool === 'merge_hdr' ? { reference: paths[res.reference], exposures: res.exposures.map((t) => Math.round(Math.log2(t) * 100) / 100), shifts: res.shifts, deghostPixels: res.ghostPixels, fallbackPixels: res.fallback } : {}),
          ...(tool === 'merge_panorama' ? { reference: paths[res.reference], projection: res.projection, focal: res.focal && Math.round(res.focal), links: res.edges.map((e) => ({ from: paths[e.from], to: paths[e.to], inliers: e.inliers })), gains: res.gains.map((g) => Math.round(g * 1000) / 1000) } : {}),
          ...(tool === 'merge_focus_stack' ? { reference: paths[res.reference], shifts: res.shifts, share: res.share } : {}),
        };
        if (a.open === false) return result;
        const o = await bus.dispatch('open_photo', { path: out }, { door: opts.door, caller: opts.caller });
        result.opened = o.status === 'ok';
        if (o.status === 'ok' && file.exposure > 0.01) {
          const ev = Math.round(file.exposure * 100) / 100;
          const d = await bus.dispatch('set_develop', { revision: bus.state.revision, layerId: o.result.layer.id, params: { exposure: ev } }, { door: opts.door, caller: opts.caller });
          if (d.status === 'ok') result.exposure = ev;
        }
        return result;
      }, { force: replaces });
    });
  }
}
