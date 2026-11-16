// Several music folders in one library (parity row L13).
//
// Each granted folder keeps its own handle. The first folder is the primary
// one: its tracks keep plain relative paths, exactly as a single-folder
// library always had, so a library with one folder is unchanged. Every other
// folder gets an id, and its tracks' paths start with `//<id>/`. A walk never
// produces an empty path segment, so a path starting with `//` can only be a
// prefixed one, and the two kinds never collide. Track ids hash the path, so
// they differ per folder too.
//
// Headless: the IndexedDB and scan functions are injected, defaulting to the
// real ones, so the folder list logic runs in Node with fakes.

import { getMeta, setMeta, allTracks, deleteTracks, allPlaylists, deletePlaylists } from './store.mjs';

const FOLDERS_KEY = 'folders';
const LEGACY_HANDLE_KEY = 'rootHandle';
const LEGACY_NAME_KEY = 'rootName';
const PREFIX = '//';
const ID_PATTERN = /^[a-z0-9]{1,16}$/;

export class FolderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FolderError';
    this.code = code;
  }
}

/**
 * The library path for a file at `relativePath` in folder `folderId`.
 * The primary folder passes null and gets the relative path unchanged.
 */
export function libraryPath(folderId, relativePath) {
  if (folderId === null || folderId === undefined) return relativePath;
  if (!ID_PATTERN.test(folderId)) throw new FolderError('ERR_NAKLIAMP_FOLDER_ID', `Not a folder id: ${folderId}`);
  return `${PREFIX}${folderId}/${relativePath}`;
}

/** Split a library path into `{ folderId, relativePath }`; folderId is null for the primary folder. */
export function splitLibraryPath(path) {
  const text = String(path ?? '');
  if (!text.startsWith(PREFIX)) return { folderId: null, relativePath: text };
  const slash = text.indexOf('/', PREFIX.length);
  if (slash < 0) return { folderId: text.slice(PREFIX.length), relativePath: '' };
  return { folderId: text.slice(PREFIX.length, slash), relativePath: text.slice(slash + 1) };
}

/** Whether a library path belongs to folder `folderId` (null = primary). */
export function inFolder(path, folderId = null) {
  return (splitLibraryPath(path).folderId ?? null) === (folderId ?? null);
}

/** Records of one folder, by path. */
export function recordsInFolder(records, folderId = null) {
  return records.filter(record => inFolder(record.path, folderId));
}

/**
 * Resolve a library path to a file handle, given the folder list.
 * Walks the relative path from the owning folder's handle. A virtual (cue)
 * path resolves to its parent file: strip `#n` first with the cue helpers.
 */
export async function fileHandleFor(folders, path) {
  const { folderId, relativePath } = splitLibraryPath(path);
  const folder = folders.find(entry => (folderId === null ? entry.primary : entry.id === folderId));
  if (!folder?.handle) {
    throw new FolderError('ERR_NAKLIAMP_FOLDER_MISSING', 'The folder holding this track is no longer in the library.');
  }
  const segments = relativePath.split('/').filter(Boolean);
  let directory = folder.handle;
  for (const segment of segments.slice(0, -1)) directory = await directory.getDirectoryHandle(segment);
  return directory.getFileHandle(segments[segments.length - 1]);
}

function newId(existing) {
  const taken = new Set(existing.map(folder => folder.id));
  for (let n = 1; ; n += 1) {
    const id = `f${n}`;
    if (!taken.has(id)) return id;
  }
}

async function sameEntry(left, right) {
  if (left === right) return true;
  if (typeof left?.isSameEntry !== 'function') return false;
  try { return await left.isSameEntry(right); } catch { return false; }
}

/**
 * The folder list, persisted in the meta table.
 *
 * `deps` lets tests replace the store and scan functions:
 * `{ getMeta, setMeta, allTracks, deleteTracks, allPlaylists, deletePlaylists,
 *    scan(handle, { folderId }) }`. `scan` defaults to none; the shell passes
 * its own (the worker scan) so this module does not start workers itself.
 *
 * Folder rows: `{ id, name, handle, primary }`. The primary folder also stays
 * under the old `rootHandle` meta key, so code that reads only that key keeps
 * working.
 */
export function createFolderLibrary(deps = {}) {
  const store = {
    getMeta, setMeta, allTracks, deleteTracks, allPlaylists, deletePlaylists,
    scan: null,
    ...deps,
  };

  async function load() {
    const saved = await store.getMeta(FOLDERS_KEY, null);
    if (Array.isArray(saved)) return saved.map(folder => ({ ...folder }));
    // No list yet: a library from before L13 has at most the one legacy grant.
    const handle = await store.getMeta(LEGACY_HANDLE_KEY, null);
    if (!handle) return [];
    const name = (await store.getMeta(LEGACY_NAME_KEY, null)) ?? handle.name ?? null;
    return [{ id: 'main', name, handle, primary: true }];
  }

  async function save(folders) {
    await store.setMeta(FOLDERS_KEY, folders);
    const primary = folders.find(folder => folder.primary) ?? null;
    await store.setMeta(LEGACY_HANDLE_KEY, primary?.handle ?? null);
    await store.setMeta(LEGACY_NAME_KEY, primary?.name ?? null);
    return folders;
  }

  /** The folder a scan of this row writes into: null for primary, else its id. */
  const scanId = folder => (folder.primary ? null : folder.id);

  return {
    load,

    /**
     * Add a granted folder. The first one becomes primary. Adding a folder
     * that is already in the list (same entry) returns that row unchanged.
     */
    async add(handle) {
      if (!handle || handle.kind !== 'directory') {
        throw new FolderError('ERR_NAKLIAMP_FOLDER_NOT_DIRECTORY', 'Only a folder can be added to the library.');
      }
      const folders = await load();
      for (const folder of folders) {
        if (await sameEntry(folder.handle, handle)) return { folder, added: false };
      }
      const primary = !folders.some(folder => folder.primary);
      const folder = { id: primary ? 'main' : newId(folders), name: handle.name ?? null, handle, primary };
      if (primary && folders.some(entry => entry.id === 'main')) folder.id = newId(folders);
      await save([...folders, folder]);
      return { folder, added: true };
    },

    /**
     * Remove a folder and its tracks and playlists from the index. The files
     * on disk are untouched; only the index forgets them.
     */
    async forget(id) {
      const folders = await load();
      const folder = folders.find(entry => entry.id === id);
      if (!folder) throw new FolderError('ERR_NAKLIAMP_FOLDER_UNKNOWN', `No folder with id ${id} in the library.`);
      const target = scanId(folder);
      const tracks = recordsInFolder(await store.allTracks(), target);
      const playlists = (await store.allPlaylists()).filter(playlist => inFolder(playlist.path, target));
      await store.deleteTracks(tracks.map(track => track.id));
      await store.deletePlaylists(playlists.map(playlist => playlist.path));
      await save(folders.filter(entry => entry.id !== id));
      return { removedTracks: tracks.length, removedPlaylists: playlists.length };
    },

    /** Scan one folder into the index through the injected scan function. */
    async rescan(id, options = {}) {
      if (typeof store.scan !== 'function') {
        throw new FolderError('ERR_NAKLIAMP_FOLDER_NO_SCAN', 'No scan function was given to the folder library.');
      }
      const folder = (await load()).find(entry => entry.id === id);
      if (!folder) throw new FolderError('ERR_NAKLIAMP_FOLDER_UNKNOWN', `No folder with id ${id} in the library.`);
      return store.scan(folder.handle, { ...options, folderId: scanId(folder) });
    },

    /** Scan every folder, one after another. Returns one summary per folder id. */
    async rescanAll(options = {}) {
      const results = {};
      for (const folder of await load()) results[folder.id] = await this.rescan(folder.id, options);
      return results;
    },

    /** Resolve a track path to its file handle across all folders. */
    async fileHandleFor(path) {
      return fileHandleFor(await load(), path);
    },
  };
}
