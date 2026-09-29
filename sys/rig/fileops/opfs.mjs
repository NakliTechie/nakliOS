// OPFS workspace storage — persistent, same-origin, no user gesture.
//
// The Origin Private File System (navigator.storage.getDirectory) hands back a
// FileSystemDirectoryHandle, exactly the shape FsaBackend already speaks. So an
// OPFS-backed workspace needs no new backend class: navigate to a per-workspace
// subdirectory and wrap it in FsaBackend. Unlike File System Access it needs no
// showDirectoryPicker() gesture and no permission prompt, it survives reloads,
// and it works inside a same-origin iframe (e.g. an app embedded in NakliOS).
//
// Use it as the DEFAULT persistent workspace (files survive reload) — reserve
// FsaBackend-over-showDirectoryPicker for when the user wants a real disk folder.

import { FsaBackend } from './fsa-backend.mjs';

export function opfsAvailable() {
  return !!(typeof navigator !== 'undefined' && navigator.storage &&
    typeof navigator.storage.getDirectory === 'function');
}

// Resolve (creating as needed) the OPFS directory at `path` and return an
// FsaBackend rooted there. `path` is a '/'-separated namespace, e.g.
// 'anvil/ws/<projectId>'. Throws if OPFS is unavailable.
export async function createOpfsBackend({ path = 'workspace' } = {}) {
  if (!opfsAvailable()) throw new Error('OPFS is unavailable in this browser');
  let dir = await navigator.storage.getDirectory();
  for (const seg of String(path).split('/').filter(Boolean)) {
    dir = await dir.getDirectoryHandle(seg, { create: true });
  }
  return new FsaBackend(dir, { symlinkFree: true });
}

// Permanently remove an OPFS workspace subtree (e.g. when a project is deleted).
export async function deleteOpfsDir({ path } = {}) {
  if (!opfsAvailable() || !path) return;
  const segs = String(path).split('/').filter(Boolean);
  const name = segs.pop();
  if (!name) return;
  let dir = await navigator.storage.getDirectory();
  try { for (const seg of segs) dir = await dir.getDirectoryHandle(seg, { create: false }); }
  catch { return; }
  try { await dir.removeEntry(name, { recursive: true }); } catch { /* already gone */ }
}
