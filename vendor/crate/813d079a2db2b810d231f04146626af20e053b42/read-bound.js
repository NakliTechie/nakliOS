// SPDX-License-Identifier: AGPL-3.0-or-later
// Optional read limits are refusal contracts, never hints to download first.
export const MAX_BOUNDED_READ_BYTES = 64 * 1024 * 1024;
export function readBoundError(code, message) { return Object.assign(new Error(message), { code }); }
export function checkReadBound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BOUNDED_READ_BYTES)
    throw readBoundError('EINVAL', 'maxBytes must be an integer from zero through 64 MiB');
}
export function boundedCiphertextSize(entry, maxBytes) {
  checkReadBound(maxBytes);
  if (!Number.isSafeInteger(entry?.size) || entry.size < 0)
    throw readBoundError('EIO', 'signed object size is unavailable or invalid');
  if (entry.size > maxBytes) throw readBoundError('EFBIG', 'signed object size exceeds maxBytes');
  // Native DecompressionStream offers no allocation-budget guarantee. Refuse
  // before GET or decryption rather than inflate first and check afterwards.
  if (entry.compression) throw readBoundError('ENOTSUP', 'bounded compressed-object reads are unavailable');
  let chunks = 1;
  if (entry.chunk_size != null) {
    if (!Number.isSafeInteger(entry.chunk_size) || entry.chunk_size <= 0)
      throw readBoundError('EIO', 'signed object chunk size is invalid');
    chunks = Math.max(1, Math.ceil(entry.size / entry.chunk_size));
    if (chunks > 65536) throw readBoundError('ENOTSUP', 'bounded object chunk count exceeds 65536');
  }
  return entry.size + chunks * 28;
}

// Fetch body must be a byte stream. BYOB makes every network read request
// finite; a backend without it refuses before arrayBuffer or an unbounded read.
export function checkCiphertextBound(maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > MAX_BOUNDED_READ_BYTES + 65536 * 28)
    throw readBoundError('EINVAL', 'invalid ciphertext byte bound');
}
export async function readResponseBounded(response, maxBytes) {
  checkCiphertextBound(maxBytes);
  const advertised = response.headers?.get('content-length');
  if (advertised != null && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw readBoundError('EFBIG', 'response Content-Length exceeds byte bound');
  }
  let reader;
  try { reader = response.body?.getReader({ mode: 'byob' }); }
  catch (_) { await response.body?.cancel().catch(() => {}); throw readBoundError('ENOTSUP', 'bounded GET requires a BYOB response stream'); }
  if (!reader) throw readBoundError('ENOTSUP', 'bounded GET requires a response byte stream');
  let used = 0;
  try {
    const output = new Uint8Array(maxBytes);
    while (true) {
      // One extra byte proves an oversized response even at an exact limit.
      const wanted = Math.min(65536, maxBytes - used + 1);
      const { value, done } = await reader.read(new Uint8Array(wanted));
      if (value && value.byteLength > maxBytes - used) throw readBoundError('EFBIG', 'response stream exceeds byte bound');
      if (value?.byteLength) { output.set(value, used); used += value.byteLength; }
      if (done) return output.subarray(0, used);
      if (!value?.byteLength) throw readBoundError('EIO', 'response byte stream made no progress');
    }
  } finally {
    try { await reader.cancel(); } catch (_) {}
    reader.releaseLock();
  }
}
