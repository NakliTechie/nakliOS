// Type-constrained removal over the File System Access API, shared by FsaBackend (a folder Anvil picked
// itself) and the NakliOS host (a folder behind naklios.fs). `rmdir` must remove only an empty
// directory and `unlink` only a non-directory. FileSystemHandle.remove() removes the entry the handle
// names, so the browser does the type and emptiness checks as part of the removal: a non-empty
// directory refuses with InvalidModificationError instead of losing what was added after a check.

export function handleRemovalSupported(handle) {
  return !!handle && typeof handle.getDirectoryHandle === 'function'
    && typeof globalThis.FileSystemHandle === 'function' && typeof globalThis.FileSystemHandle.prototype.remove === 'function';
}

const fail = (code, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { code });

// parent: the FileSystemDirectoryHandle holding `name`. kind: 'dir' | 'non-dir'.
export async function removeHandleTyped(parent, name, kind, path = name) {
  if (kind !== 'dir' && kind !== 'non-dir') throw fail('EINVAL', 'invalid removal kind');
  if (!name) throw fail('EBUSY', 'cannot remove the filesystem root');
  let handle;
  try {
    handle = kind === 'dir' ? await parent.getDirectoryHandle(name) : await parent.getFileHandle(name);
  } catch (error) {
    if (error?.name === 'TypeMismatchError') throw fail(kind === 'dir' ? 'ENOTDIR' : 'EISDIR', `${kind === 'dir' ? 'not a directory' : 'is a directory'}: ${path}`, error);
    if (error?.name === 'NotFoundError') throw fail('ENOENT', `no such path: ${path}`, error);
    throw fail(error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'EACCES' : 'EIO', `remove ${path}: ${error?.message || 'provider failed'}`, error);
  }
  if (typeof handle.remove !== 'function') throw fail('ENOTSUP', 'this browser cannot remove a file system entry by handle');
  try { await handle.remove({ recursive: false }); }
  catch (error) {
    if (error?.name === 'InvalidModificationError') throw fail('ENOTEMPTY', `directory not empty: ${path}`, error);
    if (error?.name === 'NotFoundError') throw fail('ENOENT', `no such path: ${path}`, error);
    if (error?.name === 'TypeMismatchError') throw fail(kind === 'dir' ? 'ENOTDIR' : 'EISDIR', `type changed before removal: ${path}`, error);
    throw fail(error?.name === 'NotAllowedError' || error?.name === 'SecurityError' ? 'EACCES' : 'EIO', `remove ${path}: ${error?.message || 'provider failed'}`, error);
  }
}
