// Shared validation for additive atomic mutations. Existing write/remove paths
// retain their legacy contract unless callers request these capabilities.
export const DEFAULT_MUTATION_BYTES = 16 * 1024 * 1024;
export const TRUNCATE_MODES = Object.freeze(['set', 'add', 'subtract', 'min', 'max', 'roundDown', 'roundUp']);
export const mutationError = (code, message) => Object.assign(new Error(message), { code });

export function requireMutation(backend, capability, method, label) {
  if (backend?.[capability] !== true || typeof backend?.[method] !== 'function') {
    throw mutationError('ENOTSUP', `${label} is not supported by this storage backend`);
  }
  if (backend.supportsMetadataOnly !== true) throw mutationError('ENOTSUP', `${label} requires content-free metadata`);
}

export function checkCreateOptions({ directory = false } = {}) {
  if (typeof directory !== 'boolean') throw mutationError('EINVAL', 'directory must be a boolean');
  return { directory };
}

export function checkTruncateOptions({ size, mode = 'set', create = true, maxBytes = DEFAULT_MUTATION_BYTES } = {}) {
  if (!Number.isSafeInteger(size) || size < 0) throw mutationError('EINVAL', 'truncate size must be a nonnegative safe integer');
  if (!TRUNCATE_MODES.includes(mode)) throw mutationError('EINVAL', 'unsupported truncate mode');
  if ((mode === 'roundDown' || mode === 'roundUp') && size === 0) throw mutationError('EINVAL', 'truncate rounding multiple must be positive');
  if (typeof create !== 'boolean') throw mutationError('EINVAL', 'truncate create must be a boolean');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw mutationError('EINVAL', 'truncate maxBytes must be a nonnegative safe integer');
  return { size, mode, create, maxBytes };
}

export function truncateSize(currentSize, options) {
  const opts = checkTruncateOptions(options);
  if (!Number.isSafeInteger(currentSize) || currentSize < 0) throw mutationError('EIO', 'current file size is unavailable');
  const current = BigInt(currentSize), amount = BigInt(opts.size);
  let result;
  switch (opts.mode) {
    case 'set': result = amount; break;
    case 'add': result = current + amount; break;
    case 'subtract': result = current > amount ? current - amount : 0n; break;
    case 'min': result = current < amount ? current : amount; break;
    case 'max': result = current > amount ? current : amount; break;
    case 'roundDown': result = current / amount * amount; break;
    case 'roundUp': result = (current + amount - 1n) / amount * amount; break;
  }
  if (result > BigInt(opts.maxBytes)) throw mutationError('EFBIG', `truncated file exceeds the ${opts.maxBytes}-byte limit`);
  return Number(result);
}
