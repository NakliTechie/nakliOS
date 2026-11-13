// App boot: engine, renderer, storage, document store and one command bus behind four doors (UI,
// window.atelier.tools, navigator.modelContext, the NakliOS rail), plus the NakliOS lifecycle
// (spec 002 §9.2). naklios.* is called here and in the durability adapter (src/autosave.js) only.

import { STATE_FILE } from './handlers/files.js';
import { createBus } from './bus.js';
import { registerAll } from './handlers/index.js';
import { runStaged } from './handlers/util.js';
import { registerRail } from './rail.js';
import { createStore } from './document.js';
import { createRenderer } from './renderer.js';
import { pickStore, RAW_EXT, IMAGE_EXT, extOf } from './storage.js';
import { createEngine } from '../vendor/tessella/src/engine.js';
import { mountUI } from './ui/index.js';
import { createDurability } from './autosave.js';

const naklios = window.naklios;
const $ = (s) => document.querySelector(s);
const manifest = await (await fetch(new URL('../agent/tools.manifest.json', import.meta.url))).json();
let ctxRef = null;
const bus = createBus(manifest, { busy: () => ctxRef?.busy ?? null });

const hostCaps = () => { const c = naklios?.capabilities || {}; return { hosted: !!c.hosted, flagged: !!c.flagged, fs: !!c.fs, ai: !!c.ai, version: c.version ?? null }; };
const canvas = $('#canvas');
function size() { const r = canvas.getBoundingClientRect(); canvas.width = Math.max(1, Math.round(r.width * devicePixelRatio)); canvas.height = Math.max(1, Math.round(r.height * devicePixelRatio)); }
size();

let engine = null; let engineError = null;
try { engine = await createEngine({ canvas }); } catch (e) { engineError = e; }
let storage = null;
const store = createStore();
const renderer = engine ? createRenderer({ engine, storage: () => storage }) : null;
if (renderer) store.useBuffers(renderer.bufferIO);

let mounted = null; let durability = null;
const ctx = {
  bus, store, renderer, engine, host: hostCaps, storage: () => storage,
  view: { mode: 'develop', zoom: null, center: null, beforeAfter: 'off' },
  staged: new Map(), jobs: new Map(), clipboard: null, snapshots: new Map(), folder: null,
  async sync() { if (renderer && store.doc) { await renderer.sync(store.doc); } mounted?.render(); },
  setView(v) {
    if (!engine || !store.doc) return;
    if (v.zoom && v.center) engine.setView({ fit: false, scale: v.zoom, cx: v.center[0], cy: v.center[1] });
    else if (v.zoom) engine.setView({ fit: false, scale: v.zoom, cx: store.doc.width / 2, cy: store.doc.height / 2 });
    else engine.setView({ fit: true });
    engine.schedule();
  },
  async pickStorage() {
    storage = await pickStore({ naklios, folder: ctx.folder });
    await durability?.storageChanged();
    mounted?.refreshFolder().catch(() => {});
    mounted?.render();
    if (booted) await restoreLast();
    return storage;
  },
  onStaged: () => mounted?.render(),
  flush: () => durability?.flush() ?? Promise.resolve(),
};
ctxRef = ctx;
if (engine) registerAll(bus, ctx);

// A slider drag is one gesture: its changes merge into one undo step (pointerdown → pointerup on a range input).
document.addEventListener('pointerdown', (e) => { if (e.target.matches?.('input[type=range]')) store.beginGesture(); }, true);
addEventListener('pointerup', () => store.endGesture(), true);

// Every door's reply passes the durability observer (an edit from an agent autosaves like one from the
// person) and redraws the UI. A command that replaces the document saves the old one first.
// The mode a document was last in (Develop or Composite), per workspace path, so reopening a composite
// returns to Composite. A per-viewer convenience in localStorage; a missing or blocked store is ignored.
const MODES_KEY = 'atelier.modeByPath';
let docPath = null;
const modes = { read() { try { return JSON.parse(localStorage.getItem(MODES_KEY)) || {}; } catch { return {}; } },
  get(path) { return path ? this.read()[path] ?? null : null; },
  set(path, mode) { if (!path) return; const m = this.read(); delete m[path]; m[path] = mode; const keys = Object.keys(m); for (const k of keys.slice(0, Math.max(0, keys.length - 200))) delete m[k]; try { localStorage.setItem(MODES_KEY, JSON.stringify(m)); } catch { /* storage blocked */ } } };
const dispatch = bus.dispatch;
bus.dispatch = async (name, args = {}, opts = {}) => {
  await durability?.before(name, args, opts);
  const reply = await dispatch(name, args, opts);
  if (reply.status === 'ok') {
    if (name === 'open_photo' && !args.asLayer) {
      docPath = args.path ?? null;
      const want = modes.get(docPath);
      if (want && want !== ctx.view.mode) await dispatch('set_view', { mode: want }, { ...opts, caller: 'remembered mode' });
    } else if (name === 'new_document') docPath = null;
    else if (name === 'save_document' && reply.result?.path) { docPath = reply.result.path; modes.set(docPath, ctx.view.mode); }
    else if (name === 'set_view' && args.mode) modes.set(docPath, ctx.view.mode);
  }
  try { await durability?.observe(name, args, reply); } catch (e) { console.warn('[atelier] durability observer', e); }
  if (bus.manifest.tools.find((t) => t.name === name)?.effect !== 'read') mounted?.render();
  return reply;
};

// grant_folder is person-only: the picker needs the person's own click (standalone only); hosted, the
// host owns the Folder or Crate connection.
async function grantFolder() {
  if (naklios?.capabilities?.hosted && naklios.capabilities.fs) { naklios.openSettings?.('storage'); return; }
  if (!window.showDirectoryPicker) { mounted?.say('This browser cannot open a folder; Atelier keeps files in this browser.'); return; }
  try { ctx.folder = await window.showDirectoryPicker({ mode: 'readwrite' }); await ctx.pickStorage(); } catch { /* the person cancelled */ }
}

// Reopen the last document or photo when a window starts (or storage first becomes available) with nothing open.
let booted = false; let restoring = false;
async function restoreLast() {
  if (restoring || store.doc || !storage || !engine) return;
  restoring = true;
  try {
    if (!(await storage.exists(STATE_FILE))) return;
    const last = JSON.parse(await storage.readText(STATE_FILE))?.last;
    if (typeof last !== 'string' || !(await storage.exists(last))) return;
    mounted?.ui.loading(`Opening ${last.split('/').pop()}…`);
    const r = await bus.dispatch('open_photo', { path: last }, { door: 'ui', caller: 'restore' });
    if (r.status !== 'ok') console.warn('[atelier] could not reopen', last, r.error?.message);
  } catch (e) { console.warn('[atelier] restore failed', e); } finally { restoring = false; mounted?.ui.loading(null); }
}

mounted = mountUI({ bus, ctx, manifest, engineError, grantFolder, importFiles: (f) => importFiles(f), runStaged: (id) => runStaged(ctx, id), hostCaps });
const { ui } = mounted;
durability = createDurability({ naklios, bus, ctx, dialogs: ui.dialogs, notice: (t, a) => ui.notice(t, a), onState: (s, info) => ui.saveState(s, info) });
await ctx.pickStorage().catch((e) => { console.warn('[atelier] storage unavailable', e); });
await durability.start();
booted = true;
await restoreLast();

window.atelier = {
  manifest,
  tools: Object.fromEntries(manifest.tools.map((t) => [t.name, (args = {}) => bus.dispatch(t.name, args, { door: 'window' })])),
  dispatch: (name, args = {}) => bus.dispatch(name, args, { door: 'window' }),
};
// Test hooks: stand in for the person's Confirm click on a staged action; reach the durability adapter.
window.atelier.__confirmStaged = (id) => runStaged(ctx, id);
window.atelier.__ctx = ctx;
window.atelier.__durability = durability;
window.atelier.__ui = ui;

if (navigator.modelContext?.registerTool) {
  for (const t of manifest.tools) {
    if (t.personOnly || !bus.has(t.handler)) continue;
    try { navigator.modelContext.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, execute: (args) => bus.dispatch(t.name, args ?? {}, { door: 'modelContext' }) }); }
    catch (err) { console.warn('[atelier] modelContext registerTool failed', t.name, err); }
  }
}

// Host theme tokens map onto the chrome's variables only; the canvas surround stays 18% grey (§9.2).
function applyTheme(theme) {
  const c = theme?.colors; if (!c) return;
  const root = document.documentElement.style;
  root.setProperty('--body', c.BODY); root.setProperty('--panel', c.PANEL); root.setProperty('--ink', c.INK); root.setProperty('--accent', c.ACT);
  // dark or light from the body colour's luma (0.299 R + 0.587 G + 0.114 B), because host moods include 'warm' and 'cool'
  const hx = String(c.BODY || '#ffffff').replace('#', '');
  const luma = (parseInt(hx.slice(0, 2), 16) * 299 + parseInt(hx.slice(2, 4), 16) * 587 + parseInt(hx.slice(4, 6), 16) * 114) / 255000;
  document.documentElement.style.colorScheme = luma < 0.5 ? 'dark' : 'light';
}

// Copies one photo's bytes into Atelier's own storage under photos/imported/ (never writing to the source)
// and opens the copy through the bus. Used by Open photo, a drop on the canvas and the host's file handoff.
// A RAW photo opens in Develop; any other image opens in Composite, where its layer can be edited.
async function importBytes(fileName, bytes, caller, { open = true } = {}) {
  const s = ctx.storage();
  if (!s) throw new Error('Atelier has no storage to copy the photo into');
  const name = String(fileName || 'photo').split('/').pop().replace(/[\\:*?"<>|]/g, '_') || 'photo';
  const dot = name.lastIndexOf('.'); const stemName = dot > 0 ? name.slice(0, dot) : name; const ext = dot > 0 ? name.slice(dot) : '';
  let path = `photos/imported/${name}`;
  for (let i = 2; await s.exists(path); i++) path = `photos/imported/${stemName}-${i}${ext}`;
  await s.write(path, bytes);
  if (!open) { mounted.refreshFolder().catch(() => {}); return { path, name, reply: null }; }
  const r = await bus.dispatch('open_photo', { path }, { door: 'ui', caller });
  if (r.status === 'ok') {
    const mode = RAW_EXT.includes(extOf(path)) ? 'develop' : 'composite';
    if (ctx.view.mode !== mode) await bus.dispatch('set_view', { mode }, { door: 'ui', caller });
  }
  mounted.refreshFolder().catch(() => {});
  return { path, name, reply: r };
}

// Open photo… and a drop on the canvas: the person's own files, chosen in the browser's file picker.
async function importFiles(files) {
  const list = [...(files || [])];
  const ok = list.filter((f) => [...RAW_EXT, ...IMAGE_EXT].includes(extOf(f.name)));
  const skipped = list.filter((f) => !ok.includes(f));
  if (!ok.length) { mounted.say(list.length ? `${skipped.map((f) => f.name).join(', ')}: Atelier opens JPEG, PNG, WebP, AVIF, GIF, TIFF, PSD and camera RAW files.` : 'No file was chosen.'); return null; }
  let first = null;
  try {
    for (const f of ok) {   // copy every photo; open the first, the rest wait in the filmstrip
      const r = await importBytes(f.name, new Uint8Array(await f.arrayBuffer()), 'open photo', { open: !first });
      first ??= r;
    }
  } catch (e) { mounted.say(`Could not open the photo: ${e.message}`); return null; }
  const extra = ok.length > 1 ? ` The other ${ok.length - 1} are in the filmstrip.` : '';
  const skip = skipped.length ? ` Skipped ${skipped.map((f) => f.name).join(', ')}: not a photo.` : '';
  mounted.say(first.reply.status === 'ok' ? `Opened ${first.name}.${extra}${skip}` : `Copied ${first.name} but could not open it: ${first.reply.error?.message ?? first.reply.status}.${skip}`);
  return first;
}

// File handoff (commands.json `accepts`, action import): the host's Files app sends one read-only token per
// file. Atelier copies the bytes and opens the copy (importBytes), then releases the token.
// Standalone no grant ever arrives.
async function receiveHandoff(grant) {
  try {
    const file = await naklios.files.read(grant.token);
    const raw = file.bytes ?? file.data;
    const bytes = raw instanceof Uint8Array ? raw : raw instanceof ArrayBuffer ? new Uint8Array(raw) : ArrayBuffer.isView(raw) ? new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength) : new TextEncoder().encode(String(raw ?? ''));
    const { path, name, reply: r } = await importBytes(file.name || file.path, bytes, `handoff from ${file.sourceAppId ?? 'NakliOS'}`);
    mounted.say(r.status === 'ok' ? `Imported ${name} as ${path}.` : `Copied ${name} to ${path}, but it did not open${r.error?.message ? `: ${r.error.message}` : '.'}`);
  } catch (e) { mounted.say(`Import failed: ${e.message}`); }
  finally { try { naklios.files.release(grant.token); } catch { /* the host already ended it */ } }
}

if (naklios) {
  naklios.files?.onOpen?.(receiveHandoff);
  naklios.theme.onChange(applyTheme);
  naklios.onCapabilitiesChange(() => { ctx.pickStorage().catch(() => {}); });
  naklios.beforeClose?.(() => ctx.flush());
  naklios.ready();
  naklios.theme.request();
  naklios.requestCapabilities();
  if (engine) { try { await registerRail(naklios, bus); } catch (err) { console.warn('[atelier] rail registration failed', err); } }
}
new ResizeObserver(() => { size(); engine?.schedule(); mounted.render(); }).observe(canvas);
$('#version').textContent = `manifest ${manifest.manifestVersion}`;
mounted.render();
window.atelier.ready = true;
