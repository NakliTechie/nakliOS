// Backends advertise bounded reads only when both stat traversal and byte reads
// avoid allocating file contents beyond the supplied limit.
export function readLimitError(code, message) {
  return Object.assign(new Error(message), { code });
}

export function checkReadLimit(maxBytes) {
  if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
    throw readLimitError('EINVAL', 'maxBytes must be a non-negative safe integer');
  }
}

export function checkReadSize(size, maxBytes) {
  if (maxBytes === undefined) return;
  checkReadLimit(maxBytes);
  if (!Number.isSafeInteger(size) || size < 0) throw readLimitError('ENOTSUP', 'bounded read requires a reliable byte size');
  if (size > maxBytes) throw readLimitError('EFBIG', `file exceeds the ${maxBytes}-byte read limit`);
}

export function requireBoundedReads(backend, maxBytes) {
  checkReadLimit(maxBytes);
  if (maxBytes !== undefined && backend.supportsBoundedReads !== true) {
    throw readLimitError('ENOTSUP', 'storage backend does not support bounded reads');
  }
}
