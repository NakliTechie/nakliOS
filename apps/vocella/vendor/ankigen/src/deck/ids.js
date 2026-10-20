// @ts-check
// Stable identifiers for the Anki package (ARCHITECTURE §7.2).
//
// The note GUID, deck ID and note type ID are hashes of permanent strings: Anki matches notes by GUID
// and note types by ID, so re-importing updates the same objects and keeps review history.
// Note and card IDs follow Anki's own convention instead: export time in milliseconds, offset by the
// note's position. Anki never matches on them (it shifts a clashing ID on import), but it shows them
// as "Created"/"Added" dates and the `added:N` search compares card IDs.
//
// Never change the `ankigen/v1/` prefix: every user's notes would turn into new notes.

const PREFIX = 'ankigen/v1/';

/** Anki's base91 alphabet (anki/utils.py): ASCII letters, digits, then 29 symbols. */
const BASE91 = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';

const HASH_ID_MIN = 1_000_000_000_000n; // 1e12
const HASH_ID_SPAN = (1n << 53n) - HASH_ID_MIN; // results stay below 2^53, safe as JS numbers

/**
 * @param {'SHA-256' | 'SHA-1'} algorithm
 * @param {string} text
 */
async function digest(algorithm, text) {
  return new Uint8Array(await crypto.subtle.digest(algorithm, new TextEncoder().encode(text)));
}

/** First 8 bytes, big-endian, as an unsigned 64-bit integer. @param {Uint8Array} bytes */
function uint64(bytes) {
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(bytes[i]);
  return n;
}

/** Anki's base91 encoding, most significant digit first (0 encodes as ''). @param {bigint} n */
export function base91(n) {
  let out = '';
  while (n > 0n) {
    out = BASE91[Number(n % 91n)] + out;
    n /= 91n;
  }
  return out;
}

/**
 * Note GUID. `know` is '=' in same-language mode; `key` is the note key (first concept of its merge set).
 * @param {string} learn @param {string} know @param {string} key
 */
export async function noteGuid(learn, know, key) {
  return base91(uint64(await digest('SHA-256', `${PREFIX}note|${learn}|${know}|${key}`)));
}

/** @param {string} text */
async function hashId(text) {
  return Number(HASH_ID_MIN + (uint64(await digest('SHA-256', PREFIX + text)) % HASH_ID_SPAN));
}

/** @param {string} learn @param {string} know */
export function deckId(learn, know) {
  return hashId(`deck|${learn}|${know}`);
}

/** @param {string} learn @param {string} know */
export function modelId(learn, know) {
  return hashId(`model|${learn}|${know}`);
}

/**
 * @param {number} exportMs export time in milliseconds (a fixed clock in tests)
 * @param {number} position 0-based note position in the deck
 */
export function noteId(exportMs, position) {
  return exportMs + position;
}

/**
 * @param {number} exportMs
 * @param {number} position 0-based note position
 * @param {number} ord 0 = forward, 1 = reverse
 */
export function cardId(exportMs, position, ord) {
  return exportMs + 2 * position + ord;
}

/**
 * Anki's field checksum: the first 8 hex digits of SHA-1 of the stripped first field, as an integer.
 * @param {string} text plain text (HTML already stripped)
 */
export async function fieldChecksum(text) {
  const h = await digest('SHA-1', text);
  return h[0] * 2 ** 24 + h[1] * 2 ** 16 + h[2] * 2 ** 8 + h[3];
}
