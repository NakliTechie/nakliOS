// Library sync (L52) and the shared asset library (P60), both through storage the person owns: a path in
// their NakliOS Folder or Crate, or a folder they picked. No Atelier account and no Atelier server.
// The sync logic is src/files/sync.js; this file holds the commands.
//
// The shared folder: when Atelier runs in NakliOS with a Folder or Crate, the person names a path in it
// (set_sync_folder); standalone, the person picks a folder first (the "Choose sync folder…" control,
// a browser gesture), which the UI keeps in ctx.syncTarget for the session.
//
// P60 assets live in the workspace and sync with the library: presets and LUTs in presets/ (save_preset
// and add_library_asset kind lut), colours in library/colours.json, brushes in library/brushes/<name>.json
// and placed images in library/images/<name>.<ext> (placed with open_photo asLayer).

import { parseCube } from '../../vendor/tessella/src/lut.js';
import { DEVELOP_RENDERED } from '../../vendor/tessella/src/model.js';
import { fail, stageOrRun } from './util.js';
import { safeName, normalizeSidecar } from '../files/workspace.js';
import { extOf } from '../storage.js';
import { readState, writeState, newState, checkRoot, syncOnce, resolve } from '../files/sync.js';

const enc = new TextEncoder();
const COLOURS = 'library/colours.json';
const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp'];

export function register(bus, ctx) {
  function store() {
    const s = ctx.storage();
    if (!s) fail('unsupported', 'no workspace storage; grant a folder or allow browser storage', 'use_ui_control', 'grant_folder');
    return s;
  }
  // The shared folder's storage: a folder the person picked this session, else the NakliOS Folder or Crate.
  function target() {
    if (ctx.syncTarget) return ctx.syncTarget;
    const s = ctx.storage();
    if (s?.kind === 'host') return s;
    fail('unsupported', 'no shared folder: in NakliOS connect a Folder or Crate; standalone, choose a sync folder (a person act)', 'use_ui_control', 'set_sync_folder');
    return null;
  }
  async function state(s) {
    const st = await readState(s);
    if (!st) fail('unsupported', 'sync is not set up on this device; name the shared folder first', 'fix_argument', 'set_sync_folder');
    return st;
  }

  // ---- sync (L52) ----------------------------------------------------------------------------------
  bus.register('share.set-folder', async (a, { viewOnly }) => {
    viewOnly(); const s = store(); const t = target();
    const root = checkRoot(a.root);
    if (!root) fail('invalid', 'root is a relative folder path such as shared/atelier-library (no . or .. segments)', 'fix_argument', 'set_sync_folder');
    const old = await readState(s);
    // A new root starts a new history: the last-synced records belong to the old folder.
    const st = old && old.root === root ? { ...old, name: a.deviceName || old.name } : { ...newState(root, a.deviceName || old?.name), ...(old ? { device: old.device } : {}) };
    await writeState(s, st);
    return { root, device: st.device, name: st.name, target: t.label };
  });
  bus.register('share.status', async () => {
    const s = store(); const st = await readState(s);
    if (!st) return { configured: false, target: ctx.syncTarget?.label ?? (ctx.storage()?.kind === 'host' ? ctx.storage().label : null) };
    return { configured: true, root: st.root, device: st.device, name: st.name, synced: Object.keys(st.items).length, lastSync: st.lastSync ?? null,
      conflicts: Object.entries(st.conflicts).map(([path, r]) => ({ path, theirs: { rev: r.rev, device: r.name || r.device, updated: r.updated } })) };
  });
  bus.register('share.sync', async (a, { viewOnly }) => {
    viewOnly(); const s = store(); const t = target(); const st = await state(s);
    const out = await syncOnce(s, t, st);
    st.lastSync = new Date().toISOString();
    await writeState(s, st);
    return { root: st.root, pushed: out.pushed, pulled: out.pulled, inSync: out.inSync, keptDeleted: out.keptDeleted, errors: out.errors,
      conflicts: out.conflicts.map((c) => ({ path: c.path, theirs: { rev: c.theirs.rev, device: c.theirs.name || c.theirs.device, updated: c.theirs.updated } })) };
  });
  // Every answer overwrites something (mine: the shared copy; theirs: this device's; both: both), so an
  // agent's call waits for the person. The run re-reads the state, so a staged answer stays tied to the
  // revision the person saw (sync.js resolve refuses a newer one).
  bus.register('share.resolve', async (a, { viewOnly, door }) => {
    viewOnly(); const s = store(); const t = target(); const st0 = await state(s);
    const c = st0.conflicts[a.path];
    if (!c) fail('invalid', `${a.path} has no open conflict; sync_library lists them`, 'fix_argument', 'get_sync_status');
    if (!(await s.exists(a.path)) && a.choice !== 'theirs') fail('invalid', `${a.path} is gone on this device; take theirs`, 'fix_argument', 'resolve_sync_conflict');
    const who = c.name || c.device;
    const what = { mine: `REPLACE the shared ${a.path} (revision ${c.rev} from ${who}) with this device's version`, theirs: `REPLACE this device's ${a.path} with the shared version (revision ${c.rev} from ${who})`, both: `MERGE ${a.path}: keep this device's version and the shared one (revision ${c.rev} from ${who}), then push the result` }[a.choice];
    return stageOrRun(ctx, { door }, 'resolve_sync_conflict', what, async () => {
      const st = await state(s);
      if (!st.conflicts[a.path] || st.conflicts[a.path].rev !== c.rev) fail('invalid', `${a.path}: the conflict changed since this was asked (sync again and look)`, 'fix_argument', 'get_sync_status');
      let r;
      try { r = await resolve(s, t, st, a.path, a.choice, { normalize: (o) => normalizeSidecar(o, DEVELOP_RENDERED) }); } catch (e) {
        if (e.stale) { await writeState(s, st); fail('invalid', e.message, 'fix_argument', 'get_sync_status'); }
        throw e;
      }
      await writeState(s, st);
      return r;
    });
  });

  // ---- shared asset library (P60) ------------------------------------------------------------------
  async function readColours(s) {
    if (!(await s.exists(COLOURS))) return [];
    try { return JSON.parse(await s.readText(COLOURS)).colours || []; } catch { return []; }
  }
  bus.register('share.assets', async () => {
    const s = store(); const out = [];
    for (const e of await s.list('presets/')) {
      const x = extOf(e.path);
      if (['json', 'xmp', 'cube'].includes(x)) out.push({ kind: x === 'cube' ? 'lut' : 'preset', name: e.path.split('/').pop().replace(/\.[^.]+$/, ''), path: e.path });
    }
    for (const c of await readColours(s)) out.push({ kind: 'colour', name: c.name, hex: c.hex, path: COLOURS });
    for (const e of await s.list('library/brushes/')) if (e.path.endsWith('.json')) {
      let b = {}; try { b = JSON.parse(await s.readText(e.path)); } catch { /* listed without settings */ }
      out.push({ kind: 'brush', name: e.path.split('/').pop().replace(/\.json$/, ''), path: e.path, brush: { size: b.size, hardness: b.hardness, flow: b.flow, opacity: b.opacity } });
    }
    for (const e of await s.list('library/images/')) if (IMAGE_EXT.includes(extOf(e.path))) out.push({ kind: 'image', name: e.path.split('/').pop(), path: e.path });
    return { assets: out };
  });
  bus.register('share.add-asset', async (a, { viewOnly }) => {
    viewOnly(); const s = store(); const T = 'add_library_asset';
    const name = safeName(a.name);
    if (!name) fail('invalid', 'name is one path segment without / \\ : * ? " < > |', 'fix_argument', T);
    const exists = async (p) => { if (await s.exists(p)) fail('invalid', `${p} exists; pick another name or delete it first`, 'fix_argument', 'list_library_assets'); };
    if (a.kind === 'colour') {
      if (!/^#[0-9a-f]{6}$/i.test(a.color || '')) fail('invalid', "color is '#rrggbb'", 'fix_argument', T);
      const list = await readColours(s);
      if (list.some((c) => c.name === name)) fail('invalid', `a colour named ${name} exists`, 'fix_argument', 'list_library_assets');
      list.push({ name, hex: a.color.toLowerCase() });
      await s.write(COLOURS, enc.encode(`${JSON.stringify({ format: 'atelier-colours', version: 1, colours: list }, null, 2)}\n`));
      return { kind: 'colour', name, path: COLOURS };
    }
    if (a.kind === 'brush') {
      const b = a.brush || {}; const num = (k, lo, hi, d) => { const v = b[k] ?? d; if (!Number.isFinite(v) || v < lo || v > hi) fail('invalid', `brush.${k} is ${lo} to ${hi}`, 'fix_argument', T); return v; };
      const brush = { format: 'atelier-brush', version: 1, size: num('size', 1, 5000, 20), hardness: num('hardness', 0, 100, 100), flow: num('flow', 1, 100, 100), opacity: num('opacity', 1, 100, 100) };
      const p = `library/brushes/${name}.json`; await exists(p);
      await s.write(p, enc.encode(`${JSON.stringify(brush, null, 2)}\n`));
      return { kind: 'brush', name, path: p };
    }
    // image and lut copy a workspace file (fromPath) or the file the person picked in the UI.
    let bytes; let ext;
    if (a.fromPath) { if (!(await s.exists(a.fromPath))) fail('invalid', `no file ${a.fromPath}`, 'fix_argument', 'list_folder'); bytes = await s.readBinary(a.fromPath); ext = extOf(a.fromPath); }
    else if (ctx.pickedAsset) { bytes = ctx.pickedAsset.bytes; ext = extOf(ctx.pickedAsset.name); }
    else fail('invalid', 'pass fromPath (a file in the workspace), or pick a file with the Add to library control', 'fix_argument', T);
    if (a.kind === 'image') {
      if (!IMAGE_EXT.includes(ext)) fail('unsupported', `library images are ${IMAGE_EXT.join(', ')}`, 'fix_argument', T);
      if (!(await looksLikeImage(bytes, ext))) fail('invalid', `${ctx.pickedAsset?.name ?? a.fromPath} is not a readable ${ext.toUpperCase()} image`, 'fix_argument', T);
      const p = `library/images/${name.replace(/\.[^.]+$/, '')}.${ext}`; await exists(p);
      await s.write(p, bytes); return { kind: 'image', name, path: p };
    }
    if (a.kind === 'lut') {
      if (ext !== 'cube') fail('unsupported', 'a LUT is a .cube file', 'fix_argument', T);
      try { parseCube(new TextDecoder().decode(bytes)); } catch (e) { fail('invalid', `${ctx.pickedAsset?.name ?? a.fromPath} is not a usable .cube LUT: ${e.message}`, 'fix_argument', T); }
      const p = `presets/${name.replace(/\.cube$/i, '')}.cube`; await exists(p);
      await s.write(p, bytes); return { kind: 'lut', name, path: p };
    }
    return fail('invalid', 'kind is colour, brush, image or lut (presets come from save_preset)', 'fix_argument', T);
  });
  bus.register('share.delete-asset', async (a, { door }) => {
    const s = store();
    if (a.kind === 'colour') {
      const list = await readColours(s);
      if (!list.some((c) => c.name === a.name)) fail('invalid', `no colour ${a.name}`, 'fix_argument', 'list_library_assets');
      return stageOrRun(ctx, { door }, 'delete_library_asset', `DELETE colour ${a.name} from the library`, async () => {
        await s.write(COLOURS, enc.encode(`${JSON.stringify({ format: 'atelier-colours', version: 1, colours: (await readColours(s)).filter((c) => c.name !== a.name) }, null, 2)}\n`));
        return { deleted: a.name };
      });
    }
    const p = a.path;
    if (!p || !/^(library\/(brushes|images)\/|presets\/)[^/]+$/.test(p) || !(await s.exists(p))) fail('invalid', 'path names a library asset from list_library_assets', 'fix_argument', 'list_library_assets');
    return stageOrRun(ctx, { door }, 'delete_library_asset', `DELETE library asset ${p}`, async () => { await s.delete(p); return { deleted: p }; });
  });
}

// An image the library can place: its first bytes match the extension's format, and where the browser can
// decode that format (everything but TIFF and PSD), it decodes. A renamed text file or random bytes fail.
const SIGNATURES = { jpg: [[0xff, 0xd8, 0xff]], jpeg: [[0xff, 0xd8, 0xff]], png: [[0x89, 0x50, 0x4e, 0x47]], gif: [[0x47, 0x49, 0x46, 0x38]],
  webp: [[0x52, 0x49, 0x46, 0x46]], tif: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]], tiff: [[0x49, 0x49, 0x2a, 0x00], [0x4d, 0x4d, 0x00, 0x2a]], psd: [[0x38, 0x42, 0x50, 0x53]] };
export async function looksLikeImage(bytes, ext) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length < 12) return false;
  const sigs = SIGNATURES[ext];
  if (ext === 'avif') { if (String.fromCharCode(...b.subarray(4, 8)) !== 'ftyp') return false; }
  else if (sigs && !sigs.some((sig) => sig.every((v, i) => b[i] === v))) return false;
  if (ext === 'webp' && String.fromCharCode(...b.subarray(8, 12)) !== 'WEBP') return false;
  if (['tif', 'tiff', 'psd'].includes(ext) || typeof createImageBitmap !== 'function') return true;
  try { (await createImageBitmap(new Blob([b]))).close(); return true; } catch { return false; }
}
