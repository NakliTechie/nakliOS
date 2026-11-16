// NakliAmp tags: write edited tags back to the user's file, safely.
//
// The sequence (contract, "Tags writing"):
//   1. read the file and compare lastModified with what the library knew;
//   2. build the new bytes in memory (writeTags);
//   3. copy the original into OPFS at nakliamp-tag-backup/<name>;
//   4. re-check lastModified, so a change made meanwhile is not overwritten;
//   5. write through createWritable and close (the browser commits on close);
//   6. re-parse the written file with readTags and compare every field the
//      reader supports, and for MP3 check that every ID3 frame the patch did
//      not replace is still there byte for byte.
// The backup stays after the write either way, with a small record beside it
// (track path, file name, time, outcome), so the tag editor can list it and
// put the original back: that is the undo for a tag write. Backups of good
// writes are pruned oldest first once they pass a size limit; a backup of a
// failed write is never pruned automatically.
//
// Every browser API arrives through the handle or `options`, so tests run in
// Node with fakes.

import { readTags as defaultReadTags } from '../library/metadata.mjs';
import { normalisePatch, writeTagsDetailed, missingId3Frames } from './write.mjs';
import { readId3Header } from './id3.mjs';

export const BACKUP_DIRECTORY = 'nakliamp-tag-backup';
/** Records beside each backup live here, one `<backup>.json` per backup. */
export const BACKUP_INDEX_DIRECTORY = 'index';
/** Backups of good writes are pruned, oldest first, beyond this many bytes. */
export const DEFAULT_BACKUP_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

export class TagSaveError extends Error {
  /**
   * `code`: permission, changed, backup-failed, write-failed, verify-failed,
   * or a TagWriteError code (unsupported, invalid-patch, invalid-file).
   */
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = 'TagSaveError';
    this.code = code;
    Object.assign(this, details);
  }
}

async function defaultBackupRoot() {
  if (!globalThis.navigator?.storage?.getDirectory) {
    throw new TagSaveError('backup-failed', 'This browser has no private storage (OPFS) for the backup copy, so NakliAmp will not write tags.');
  }
  return globalThis.navigator.storage.getDirectory();
}

async function ensurePermission(handle) {
  if (typeof handle.queryPermission !== 'function') return;
  const descriptor = { mode: 'readwrite' };
  if (await handle.queryPermission(descriptor) === 'granted') return;
  if (typeof handle.requestPermission === 'function' && await handle.requestPermission(descriptor) === 'granted') return;
  throw new TagSaveError('permission', `NakliAmp does not have permission to change ${handle.name}.`);
}

async function exists(directory, name) {
  try {
    await directory.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** Pick `<name>`, or `<name> (2)` and so on when an earlier failed save left a backup. */
async function backupName(directory, name) {
  if (!await exists(directory, name)) return name;
  for (let copy = 2; copy < 1000; copy += 1) {
    const candidate = `${name} (${copy})`;
    if (!await exists(directory, candidate)) return candidate;
  }
  throw new TagSaveError('backup-failed', `Too many backups of ${name} are waiting in ${BACKUP_DIRECTORY}.`);
}

async function writeBlob(handle, blob) {
  const writable = await handle.createWritable({ keepExistingData: false });
  try {
    await writable.write(blob);
    await writable.close();
  } catch (error) {
    try { await writable.abort?.(); } catch { /* the original file is untouched until close succeeds */ }
    throw error;
  }
}

function sameBytes(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

/**
 * Compare what the reader sees after the write with what the patch asked for.
 * Returns the list of fields that do not match. A field the reader does not
 * report (undefined) is skipped, not failed.
 */
function samePicture(actual, expected) {
  if (expected === null) return actual === null;
  return actual !== null && actual.mime === expected.mime && sameBytes(actual.bytes, expected.bytes);
}

function fieldMatches(field, actual, expected) {
  if (field === 'picture') return samePicture(actual, expected);
  if (field === 'rating') return (actual ?? 0) === (expected ?? 0);
  return (actual ?? null) === expected;
}

export function verifyWrittenTags(after, clean, skipped = []) {
  const mismatched = [];
  for (const [field, expected] of Object.entries(clean)) {
    if (skipped.includes(field)) continue;
    const actual = after[field];
    if (actual === undefined) continue;
    if (!fieldMatches(field, actual, expected)) mismatched.push(field);
  }
  return mismatched;
}

function refuseIfChangedSinceScan(fileHandle, original, expected) {
  if (expected !== undefined && expected !== null && original.lastModified !== expected) {
    throw new TagSaveError('changed', `${fileHandle.name} changed on disk since NakliAmp read it. Rescan the folder, then edit again.`);
  }
}

async function refuseIfChangedDuringPrepare(fileHandle, original, backupDirectory, backup) {
  const again = await fileHandle.getFile();
  if (again.lastModified !== original.lastModified || again.size !== original.size) {
    await backupDirectory.removeEntry(backup).catch(() => {});
    throw new TagSaveError('changed', `${fileHandle.name} changed on disk while NakliAmp prepared the edit. Nothing was written.`);
  }
}

/** Copy the original into the backup directory and check the copy's size. */
async function keepBackup(fileHandle, originalBlob, originalLength, backupRoot) {
  try {
    const root = await (backupRoot ?? defaultBackupRoot)();
    const backupDirectory = await root.getDirectoryHandle(BACKUP_DIRECTORY, { create: true });
    const backup = await backupName(backupDirectory, fileHandle.name);
    const backupHandle = await backupDirectory.getFileHandle(backup, { create: true });
    await writeBlob(backupHandle, originalBlob);
    const check = await backupHandle.getFile();
    if (check.size !== originalLength) throw new Error(`backup holds ${check.size} of ${originalLength} bytes`);
    return { backupDirectory, backup, size: check.size };
  } catch (error) {
    if (error instanceof TagSaveError) throw error;
    throw new TagSaveError('backup-failed', `NakliAmp could not keep a backup copy of ${fileHandle.name}, so it did not write: ${error?.message ?? error}`, {}, { cause: error });
  }
}

/**
 * Write `patch` into the file behind `fileHandle` with the safe sequence.
 *
 * options:
 *   expectedLastModified  the lastModified the library recorded; a mismatch refuses the write
 *   backupRoot            async () => FileSystemDirectoryHandle (default: OPFS root)
 *   readTags              reader used to verify (default: app/library/metadata.mjs readTags)
 *   path                  the track's library path, recorded beside the backup
 *   backupLimitBytes      prune backups of good writes beyond this (default 2 GiB)
 *
 * Returns `{ before, after, notes, skipped, lastModified, size, backup }`.
 */
export async function saveTagsToHandle(fileHandle, patch, options = {}) {
  const readTags = options.readTags ?? defaultReadTags;
  const clean = normalisePatch(patch);
  await ensurePermission(fileHandle);
  const { original, originalBytes, originalBlob, before, written } = await prepareWrite(fileHandle, clean, options, readTags);

  // Backup first: nothing touches the user's file until a full copy exists.
  const { backupDirectory, backup, size: backupSize } = await keepBackup(fileHandle, originalBlob, originalBytes.length, options.backupRoot);
  await refuseIfChangedDuringPrepare(fileHandle, original, backupDirectory, backup);
  const record = { backup, path: options.path ?? null, name: fileHandle.name, savedAt: (options.now ?? Date.now)(), size: backupSize, patch: describePatch(clean) };

  try {
    await writeBlob(fileHandle, written.blob);
  } catch (error) {
    await writeRecord(backupDirectory, { ...record, status: 'failed' });
    throw new TagSaveError('write-failed', `Writing ${fileHandle.name} failed: ${error?.message ?? error}. A backup is in ${BACKUP_DIRECTORY}/${backup}.`, { backup }, { cause: error });
  }

  const { result, after, mismatched } = await verifyOnDisk(fileHandle, written, clean, readTags);
  if (mismatched.length) {
    await writeRecord(backupDirectory, { ...record, status: 'failed' });
    throw new TagSaveError(
      'verify-failed',
      `${fileHandle.name} did not read back as written (${mismatched.join(', ')}). The original is kept in ${BACKUP_DIRECTORY}/${backup}; restore it from the tag editor.`,
      { backup, mismatched, after },
    );
  }
  await writeRecord(backupDirectory, { ...record, status: 'written', writtenLastModified: result.lastModified, writtenSize: result.size });
  await pruneTagBackups({ backupRoot: options.backupRoot, maxBytes: options.backupLimitBytes ?? DEFAULT_BACKUP_LIMIT_BYTES, keep: backup });
  return { before, after, notes: written.notes, skipped: written.skipped, lastModified: result.lastModified, size: result.size, backup };
}

/** Read the file, check it is the one the library knew, and build the new bytes in memory. */
async function prepareWrite(fileHandle, clean, options, readTags) {
  const original = await fileHandle.getFile();
  refuseIfChangedSinceScan(fileHandle, original, options.expectedLastModified);
  const originalBytes = new Uint8Array(await original.arrayBuffer());
  const originalBlob = new Blob([originalBytes], { type: original.type || '' });
  const before = await readTags(originalBlob);
  try {
    return { original, originalBytes, originalBlob, before, written: await writeTagsDetailed(originalBlob, clean) };
  } catch (error) {
    throw new TagSaveError(error.code ?? 'write-failed', error.message, {}, { cause: error });
  }
}

/** Re-read the written file: every field the reader supports, and every ID3 frame that must survive. */
async function verifyOnDisk(fileHandle, written, clean, readTags) {
  const result = await fileHandle.getFile();
  const after = await readTags(result);
  const mismatched = result.size === written.blob.size ? verifyWrittenTags(after, clean, written.skipped) : ['size'];
  if (!mismatched.length && written.expectFrames?.length) {
    const missing = missingId3Frames(await writtenId3(result), written.expectFrames);
    if (missing.length) mismatched.push(`frames ${missing.join(', ')}`);
  }
  return { result, after, mismatched };
}

/** The leading ID3v2 tag of a written file, read again from disk. */
async function writtenId3(file) {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  const header = readId3Header(head);
  return header ? new Uint8Array(await file.slice(0, header.totalSize).arrayBuffer()) : head;
}

/** The patch as plain JSON for the backup record: picture bytes become a size. */
function describePatch(clean) {
  const out = {};
  for (const [field, value] of Object.entries(clean)) {
    out[field] = field === 'picture' && value ? { mime: value.mime, bytes: value.bytes.length } : value;
  }
  return out;
}

async function indexDirectory(backupDirectory, create) {
  return backupDirectory.getDirectoryHandle(BACKUP_INDEX_DIRECTORY, { create });
}

async function writeRecord(backupDirectory, record) {
  try {
    const index = await indexDirectory(backupDirectory, true);
    const handle = await index.getFileHandle(`${record.backup}.json`, { create: true });
    await writeBlob(handle, new Blob([JSON.stringify(record)], { type: 'application/json' }));
  } catch (error) {
    // The backup itself is safe; only the list entry is missing, and listTagBackups still shows the file.
    console.warn('[nakliamp] could not record the tag backup', error);
  }
}

async function readRecord(index, backup) {
  try {
    const file = await (await index.getFileHandle(`${backup}.json`)).getFile();
    return JSON.parse(await file.text());
  } catch {
    return null;
  }
}

async function backupDirectoryOf(backupRoot) {
  const root = await (backupRoot ?? defaultBackupRoot)();
  try { return await root.getDirectoryHandle(BACKUP_DIRECTORY); } catch { return null; }
}

/**
 * Every kept tag backup, newest first: `{ backup, path, name, savedAt, size,
 * status }`. `status` is `written` (the write succeeded; restoring undoes it),
 * `failed` (the write did not read back; the original is only here) or
 * `unknown` (a backup with no record, from an older NakliAmp or a crash).
 */
export async function listTagBackups(options = {}) {
  const directory = await backupDirectoryOf(options.backupRoot);
  if (!directory) return [];
  let index = null;
  try { index = await indexDirectory(directory, false); } catch { index = null; }
  const out = [];
  for await (const [name, handle] of directory.entries()) {
    if (handle.kind === 'file') out.push(await backupEntry(name, handle, index));
  }
  return out.sort((left, right) => (right.savedAt ?? 0) - (left.savedAt ?? 0));
}

/** One listed backup: its record, or what the file alone says. */
async function backupEntry(name, handle, index) {
  const record = (index ? await readRecord(index, name) : null) ?? {};
  let size = record.size ?? null;
  if (size === null) { try { size = (await handle.getFile()).size; } catch { size = null; } }
  return {
    backup: name,
    path: record.path ?? null,
    name: record.name ?? name.replace(/ \(\d+\)$/, ''),
    savedAt: record.savedAt ?? null,
    size,
    status: record.status ?? 'unknown',
    patch: record.patch ?? null,
  };
}

/** Delete one kept backup and its record. */
export async function deleteTagBackup(backup, options = {}) {
  const directory = await backupDirectoryOf(options.backupRoot);
  if (!directory) return;
  await directory.removeEntry(backup);
  try { await (await indexDirectory(directory, false)).removeEntry(`${backup}.json`); } catch { /* no record */ }
}

/**
 * Remove backups of good writes, oldest first, until the kept backups fit in
 * `maxBytes`. Backups of failed writes and backups with no record are never
 * removed here, and neither is `keep`. Returns the names removed.
 */
export async function pruneTagBackups({ backupRoot, maxBytes = DEFAULT_BACKUP_LIMIT_BYTES, keep = null } = {}) {
  let backups;
  try { backups = await listTagBackups({ backupRoot }); } catch { return []; }
  let total = backups.reduce((sum, item) => sum + (item.size ?? 0), 0);
  const removed = [];
  for (const item of [...backups].reverse()) {
    if (total <= maxBytes) break;
    if (item.status !== 'written' || item.backup === keep) continue;
    try { await deleteTagBackup(item.backup, { backupRoot }); removed.push(item.backup); total -= item.size ?? 0; } catch { /* try the next */ }
  }
  return removed;
}

/** Put a kept backup back over the user's file, then delete the backup and its record. */
export async function restoreTagBackup(fileHandle, backup, options = {}) {
  await ensurePermission(fileHandle);
  const root = await (options.backupRoot ?? defaultBackupRoot)();
  const directory = await root.getDirectoryHandle(BACKUP_DIRECTORY);
  const source = await (await directory.getFileHandle(backup)).getFile();
  await writeBlob(fileHandle, new Blob([await source.arrayBuffer()]));
  const restored = await fileHandle.getFile();
  if (restored.size !== source.size) {
    throw new TagSaveError('write-failed', `Restoring ${fileHandle.name} wrote ${restored.size} of ${source.size} bytes; the backup is kept.`, { backup });
  }
  await directory.removeEntry(backup);
  try { await (await indexDirectory(directory, false)).removeEntry(`${backup}.json`); } catch { /* no record */ }
  return { lastModified: restored.lastModified, size: restored.size };
}
