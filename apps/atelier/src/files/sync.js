// Library sync (L52) between this device's workspace and a shared folder the person chose: a path in their
// NakliOS Folder or Crate, or a folder they picked (a Dropbox or iCloud folder, for example). No Atelier
// account and no Atelier server: the shared folder is the only meeting point. I/O goes through two storage
// adapters (src/storage.js interface), so node tests run two "devices" against one in-memory folder.
//
// What syncs: photo sidecars (*.atelier.json), collections/, presets/ (presets, looks, LUTs) and library/
// (P60 shared assets: colours, brushes, placed images). Photos themselves and .atelier documents do not:
// originals stay where the person keeps them, and documents carry large pixel buffers.
//
// Shared folder layout under root: <root>/<path> is the item's content as written (readable by people and
// other tools); <root>/.meta/<path>.json is { rev, hash, device, updated }, written after the content.
// This device's state, .atelier-sync.json in the workspace: { device, name, root, items: { path: { rev,
// hash } } (what it last synced), conflicts: { path: { rev, hash, device, updated } } }.
//
// Per item, with L = this device's content hash, R = the shared meta and B = the last synced record:
//   L only                    → push (rev 1)
//   R only                    → pull, unless B exists (deleted here since: kept deleted here, reported)
//   L.hash = R.hash           → in sync (B updated)
//   L changed, R.rev = B.rev  → push, rev R.rev + 1 (refused as a conflict if R moved meanwhile)
//   L = B.hash, R.rev ≠ B.rev → pull
//   both changed              → conflict, nothing written; the person keeps mine, takes theirs or keeps both
// Deletions do not propagate: an item deleted on one device stays on the others and in the shared folder.

import { COPY_ID, STRUCT } from './workspace.js';

export const STATE_FILE = '.atelier-sync.json';
export const SYNC_PREFIXES = ['collections/', 'presets/', 'library/'];
const enc = new TextEncoder();

export async function sha256(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const norm = (root) => String(root || '').replace(/^\/+|\/+$/g, '');
export function checkRoot(root) {
  const r = norm(root);
  if (!r || r.split('/').some((s) => !s || s === '.' || s === '..' || /[\\:*?"<>|]/.test(s))) return null;
  return r;
}
const isItem = (p, root) => !p.startsWith(`${root}/`) && !p.endsWith('.tmp') && (p.endsWith('.atelier.json') && !p.startsWith('documents/') || SYNC_PREFIXES.some((x) => p.startsWith(x)));

export async function readState(local) {
  if (await local.exists(STATE_FILE)) { try { return JSON.parse(await local.readText(STATE_FILE)); } catch { /* rebuilt below */ } }
  return null;
}
export async function writeState(local, st) { await local.write(STATE_FILE, enc.encode(`${JSON.stringify(st, null, 2)}\n`)); }
export function newState(root, name) {
  const id = `dev-${[...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
  return { format: 'atelier-sync-state', version: 1, device: id, name: name || id, root, items: {}, conflicts: {} };
}

async function remoteMeta(remote, root, p) {
  const m = `${root}/.meta/${p}.json`;
  if (!(await remote.exists(m))) return null;
  try { return JSON.parse(await remote.readText(m)); } catch { return null; }
}
async function push(remote, root, st, p, bytes, hash, rev) {
  await remote.write(`${root}/${p}`, bytes);   // content first, then the meta that advertises it
  const meta = { rev, hash, device: st.device, name: st.name, updated: new Date().toISOString() };
  await remote.write(`${root}/.meta/${p}.json`, enc.encode(`${JSON.stringify(meta)}\n`));
  st.items[p] = { rev, hash };
  return meta;
}
async function pull(local, remote, root, st, p, meta) {
  const bytes = await remote.readBinary(`${root}/${p}`);
  const hash = await sha256(bytes);
  if (hash !== meta.hash) throw new Error(`${p} in the shared folder does not match its meta (another device is mid-write); sync again`);
  await local.write(p, bytes);
  st.items[p] = { rev: meta.rev, hash };
}

// One sync pass. Returns { pushed, pulled, inSync, conflicts: [{ path, mine, theirs }], keptDeleted, errors }.
export async function syncOnce(local, remote, st) {
  const root = st.root;
  const out = { pushed: [], pulled: [], inSync: 0, conflicts: [], keptDeleted: [], errors: [] };
  const localPaths = (await local.list('')).map((e) => e.path).filter((p) => isItem(p, root));
  const remotePaths = (await remote.list(`${root}/.meta/`)).map((e) => e.path.slice(`${root}/.meta/`.length).replace(/\.json$/, '')).filter((p) => isItem(p, root));
  const all = [...new Set([...localPaths, ...remotePaths])].sort();
  const have = new Set(localPaths);
  for (const p of all) {
    try {
      const R = await remoteMeta(remote, root, p); const B = st.items[p] || null;
      if (!have.has(p)) {
        if (!R) continue;
        if (B) { out.keptDeleted.push(p); continue; }
        await pull(local, remote, root, st, p, R); out.pulled.push(p); delete st.conflicts[p]; continue;
      }
      const bytes = await local.readBinary(p); const L = await sha256(bytes);
      if (!R) { await push(remote, root, st, p, bytes, L, 1); out.pushed.push(p); continue; }
      if (L === R.hash) { st.items[p] = { rev: R.rev, hash: L }; delete st.conflicts[p]; out.inSync++; continue; }
      const localChanged = !B || L !== B.hash; const remoteChanged = !B || R.rev !== B.rev;
      if (localChanged && !remoteChanged) {
        const now = await remoteMeta(remote, root, p);   // another device may have pushed since the read above
        if (now && now.rev !== R.rev) { st.conflicts[p] = now; out.conflicts.push({ path: p, mine: L, theirs: now }); continue; }
        await push(remote, root, st, p, bytes, L, R.rev + 1); out.pushed.push(p); continue;
      }
      if (!localChanged && remoteChanged) { await pull(local, remote, root, st, p, R); out.pulled.push(p); continue; }
      st.conflicts[p] = R; out.conflicts.push({ path: p, mine: L, theirs: R });
    } catch (e) { out.errors.push({ path: p, message: e.message }); }
  }
  return out;
}

// The person's answer to one conflict. mine: this device's version wins (pushed over theirs). theirs:
// the shared version replaces this device's. both: a sidecar gets theirs as a virtual copy named after
// their device (one photo, two sets of settings), their own virtual copies appended under new ids and
// their caption kept where this device has none; any other file keeps theirs beside it as
// "<name> (<their device>).<ext>", and both are pushed.
// The answer covers the version the person saw (st.conflicts[p].rev): when a third device pushed since,
// nothing is written and the conflict is refreshed to the new version, so the person decides again.
export async function resolve(local, remote, st, p, choice, { normalize } = {}) {
  const root = st.root; const R = await remoteMeta(remote, root, p);
  if (!R) throw new Error(`${p} is not in the shared folder`);
  const seen = st.conflicts?.[p];
  if (seen && seen.rev !== R.rev) {
    st.conflicts[p] = R;
    const e = new Error(`${p} changed in the shared folder since you saw the conflict (revision ${seen.rev} → ${R.rev}, from ${R.name || R.device}); nothing was written; look again and resolve`);
    e.stale = true; throw e;
  }
  if (choice === 'theirs') { await pull(local, remote, root, st, p, R); delete st.conflicts[p]; return { path: p, kept: 'theirs' }; }
  const mine = await local.readBinary(p);
  if (choice === 'mine') { await push(remote, root, st, p, mine, await sha256(mine), R.rev + 1); delete st.conflicts[p]; return { path: p, kept: 'mine' }; }
  const theirs = await remote.readBinary(`${root}/${p}`);
  const who = String(R.name || R.device).replace(/[/\\:*?"<>|]/g, '_').slice(0, 40);
  if (p.endsWith('.atelier.json')) {
    const dec = new TextDecoder();
    const m = normalize(JSON.parse(dec.decode(mine))); const t = normalize(JSON.parse(dec.decode(theirs)));
    const copies = [...(m.copies || [])];
    const nextId = () => { let n = 1; while (copies.some((c) => c.id === `vc${n}`)) n++; const id = `vc${n}`; if (!COPY_ID.test(id)) throw new Error('too many virtual copies to keep both'); return id; };
    const SETTINGS = ['develop', ...STRUCT, 'locals'];
    const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => SETTINGS.includes(k)));
    const id = nextId();
    copies.push({ id, name: `From ${who}`, ...pick(t), created: new Date().toISOString() });
    // Their virtual copies come along under new ids (ids are per sidecar, so theirs may clash with mine).
    const theirCopies = [];
    for (const c of t.copies || []) { const cid = nextId(); copies.push({ ...c, id: cid, name: String(`${c.name} (${who})`).slice(0, 80) }); theirCopies.push({ from: c.id, id: cid }); }
    const merged = { ...m, copies, keywords: [...new Set([...(m.keywords || []), ...(t.keywords || [])])] };
    if (!merged.keywords.length) delete merged.keywords;
    if (!merged.caption && t.caption) merged.caption = t.caption;
    const bytes = enc.encode(`${JSON.stringify({ ...merged, updated: new Date().toISOString() }, null, 2)}\n`);
    await local.write(p, bytes);
    await push(remote, root, st, p, bytes, await sha256(bytes), R.rev + 1);
    delete st.conflicts[p];
    return { path: p, kept: 'both', copy: id, ...(theirCopies.length ? { theirCopies } : {}), ...(t.caption && merged.caption !== t.caption ? { theirCaption: t.caption } : {}) };
  }
  const dot = p.lastIndexOf('.'); const slash = p.lastIndexOf('/');
  const alt = dot > slash ? `${p.slice(0, dot)} (${who})${p.slice(dot)}` : `${p} (${who})`;
  await local.write(alt, theirs);
  await push(remote, root, st, alt, theirs, await sha256(theirs), 1);
  await push(remote, root, st, p, mine, await sha256(mine), R.rev + 1);
  delete st.conflicts[p];
  return { path: p, kept: 'both', theirsAt: alt };
}
