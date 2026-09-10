// Main-thread controller for the library scan worker.
//
// Owns the folder grant and the worker lifecycle. The worker does the walking,
// parsing, and index writing; this module only starts it, relays progress, and
// keeps the grant available across sessions.

import { getMeta, setMeta } from './store.mjs';

const GRANT_KEY = 'rootHandle';

// Read-write from the first prompt. Playlists are files in your folder, so
// saving one needs write access; asking once is smoother than asking again
// later, and the browser's prompt is a single dialog either way.
const GRANT_MODE = Object.freeze({ mode: 'readwrite' });

/**
 * Ask the browser not to evict our storage.
 * Without it the folder handle and the whole index are best-effort data that a
 * browser may clear under pressure, and "remember my folder" quietly stops
 * being true. Failure is not fatal; it just means the grant may not survive.
 */
export async function persistStorage() {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

export class GrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

/** True when this browser can hold a directory grant at all (R1 storage path). */
export function supportsFolderGrant() {
  return typeof globalThis.showDirectoryPicker === 'function';
}

/** Ask for a music folder. Returns the handle, or null if the person cancelled. */
export async function requestFolder() {
  if (!supportsFolderGrant()) {
    throw new GrantError(
      'ERR_NAKLIAMP_NO_FOLDER_GRANT',
      'This browser cannot grant a folder. Open single tracks instead, or use a Chromium browser for the library.',
    );
  }
  try {
    const handle = await showDirectoryPicker({ id: 'nakliamp-library', ...GRANT_MODE });
    await adoptFolder(handle);
    return handle;
  } catch (error) {
    if (error?.name === 'AbortError') return null;
    throw error;
  }
}

/**
 * Remember a folder handle, however it arrived: the picker, or a drag and drop.
 * Dropping a folder onto the window is the shortest path from "I have music"
 * to "it is playing", so it must persist exactly like the picker does.
 */
export async function adoptFolder(handle) {
  await setMeta(GRANT_KEY, handle);
  await setMeta('rootName', handle?.name ?? null);
  await persistStorage();
  return handle;
}

/** The name of the remembered folder, for showing which one it is. */
export async function storedFolderName() {
  return getMeta('rootName', null);
}

/** The stored handle, or null when there is none. Does not prompt. */
export async function storedFolder() {
  return (await getMeta(GRANT_KEY)) ?? null;
}

/**
 * Whether the stored grant is still usable without prompting.
 * A grant revoked between sessions is the expected case, not an error.
 */
export async function grantState(handle) {
  if (!handle) return 'none';
  if (typeof handle.queryPermission !== 'function') return 'granted';
  return handle.queryPermission(GRANT_MODE);
}

/** Re-request an existing grant. Must be called from a user gesture. */
export async function reclaimFolder(handle) {
  if (!handle) return 'none';
  if (typeof handle.requestPermission !== 'function') return 'granted';
  return handle.requestPermission(GRANT_MODE);
}

export async function forgetFolder() {
  await setMeta(GRANT_KEY, null);
  await setMeta('rootName', null);
}

/**
 * Pull a directory handle out of a drop, if the drop was a folder.
 * Returns null for a plain file drop, which the caller plays directly.
 */
export async function directoryFromDrop(dataTransfer) {
  const items = [...(dataTransfer?.items ?? [])];
  for (const item of items) {
    if (item.kind !== 'file' || typeof item.getAsFileSystemHandle !== 'function') continue;
    try {
      const handle = await item.getAsFileSystemHandle();
      if (handle?.kind === 'directory') return handle;
    } catch {
      // A drop that cannot yield a handle is simply not a folder drop.
    }
  }
  return null;
}

/**
 * Run a scan. Returns a controller with a `done` promise and a `cancel()`.
 * `onProgress` is called with the worker's own progress messages.
 */
export function startScan(rootHandle, { onProgress = () => {}, onFileError = () => {} } = {}) {
  const worker = new Worker(new URL('./scan-worker.mjs', import.meta.url), { type: 'module' });
  let settle;
  let fail;
  const done = new Promise((resolve, reject) => { settle = resolve; fail = reject; });

  worker.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'progress') onProgress(message);
    else if (message.type === 'file-error') onFileError(message);
    else if (message.type === 'done') { worker.terminate(); settle(message); }
    else if (message.type === 'error') {
      worker.terminate();
      const error = new Error(message.message);
      error.code = message.code;
      fail(error);
    }
  });
  worker.addEventListener('error', event => {
    worker.terminate();
    const error = new Error(event.message || 'The library scan worker failed to start.');
    error.code = 'ERR_NAKLIAMP_SCAN_WORKER';
    fail(error);
  });

  worker.postMessage({ type: 'scan', rootHandle });

  return {
    done,
    cancel() { worker.postMessage({ type: 'cancel' }); },
  };
}

