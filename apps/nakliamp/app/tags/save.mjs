// NakliAmp tags: write edited tags back to the user's file, safely.
//
// The sequence (contract, "Tags writing"):
//   1. read the file and compare lastModified with what the library knew;
//   2. build the new bytes in memory (writeTags);
//   3. copy the original into OPFS at nakliamp-tag-backup/<name>;
//   4. re-check lastModified, so a change made meanwhile is not overwritten;
//   5. write through createWritable and close (the browser commits on close);
//   6. re-parse the written file with readTags and compare every field the
//      reader supports; delete the backup only when they match.
// When step 6 fails the backup stays and restoreTagBackup puts it back.
//
// Every browser API arrives through the handle or `options`, so tests run in
// Node with fakes.

import { readTags as defaultReadTags } from '../library/metadata.mjs';
import { normalisePatch, writeTagsDetailed } from './write.mjs';

export const BACKUP_DIRECTORY = 'nakliamp-tag-backup';

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
    return { backupDirectory, backup };
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
 *
 * Returns `{ before, after, notes, skipped, lastModified, size }`.
 */
export async function saveTagsToHandle(fileHandle, patch, options = {}) {
  const readTags = options.readTags ?? defaultReadTags;
  const clean = normalisePatch(patch);
  await ensurePermission(fileHandle);

  const original = await fileHandle.getFile();
  refuseIfChangedSinceScan(fileHandle, original, options.expectedLastModified);
  const originalBytes = new Uint8Array(await original.arrayBuffer());
  const originalBlob = new Blob([originalBytes], { type: original.type || '' });
  const before = await readTags(originalBlob);

  let written;
  try {
    written = await writeTagsDetailed(originalBlob, clean);
  } catch (error) {
    throw new TagSaveError(error.code ?? 'write-failed', error.message, {}, { cause: error });
  }

  // Backup first: nothing touches the user's file until a full copy exists.
  const { backupDirectory, backup } = await keepBackup(fileHandle, originalBlob, originalBytes.length, options.backupRoot);

  await refuseIfChangedDuringPrepare(fileHandle, original, backupDirectory, backup);

  try {
    await writeBlob(fileHandle, written.blob);
  } catch (error) {
    throw new TagSaveError('write-failed', `Writing ${fileHandle.name} failed: ${error?.message ?? error}. A backup is in ${BACKUP_DIRECTORY}/${backup}.`, { backup }, { cause: error });
  }

  const result = await fileHandle.getFile();
  const after = await readTags(result);
  const mismatched = result.size === written.blob.size ? verifyWrittenTags(after, clean, written.skipped) : ['size'];
  if (mismatched.length) {
    throw new TagSaveError(
      'verify-failed',
      `${fileHandle.name} did not read back as written (${mismatched.join(', ')}). The original is kept in ${BACKUP_DIRECTORY}/${backup}; restore it from the tag editor.`,
      { backup, mismatched, after },
    );
  }
  await backupDirectory.removeEntry(backup);
  return { before, after, notes: written.notes, skipped: written.skipped, lastModified: result.lastModified, size: result.size };
}

/** Put a kept backup back over the user's file, then delete the backup. */
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
  return { lastModified: restored.lastModified, size: restored.size };
}
