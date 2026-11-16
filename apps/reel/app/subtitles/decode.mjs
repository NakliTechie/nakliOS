/* Subtitle file bytes to text. Pure: runs in the browser and in Node.
 *
 * Order (review finding V47):
 *   1. a UTF-16 byte-order mark wins;
 *   2. UTF-16 without a mark is recognised by its NUL bytes: Latin text in UTF-16LE has a NUL
 *      in most odd positions and none in even ones (UTF-16BE the other way round);
 *   3. UTF-8 (its BOM is dropped), decoded strictly, so a file that really holds U+FFFD
 *      stays UTF-8;
 *   4. only when strict UTF-8 decoding throws is the file read as windows-1252, which is what
 *      most older European SRT files use. */

const SAMPLE_PAIRS = 2048;

/* 'utf-16le', 'utf-16be' or null, from the NUL pattern of the first SAMPLE_PAIRS byte pairs. */
export function sniffUtf16(bytes) {
  const pairs = Math.min(SAMPLE_PAIRS, bytes.length >> 1);
  if (pairs < 2) return null;
  let evenNul = 0;
  let oddNul = 0;
  for (let i = 0; i < pairs; i += 1) {
    if (bytes[2 * i] === 0) evenNul += 1;
    if (bytes[2 * i + 1] === 0) oddNul += 1;
  }
  if (oddNul >= pairs * 0.3 && evenNul <= pairs * 0.02) return 'utf-16le';
  if (evenNul >= pairs * 0.3 && oddNul <= pairs * 0.02) return 'utf-16be';
  return null;
}

export function decodeSubtitleBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  if (!hasBom) {
    const utf16 = sniffUtf16(bytes);
    if (utf16) return { text: new TextDecoder(utf16).decode(bytes), encoding: utf16 };
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(hasBom ? bytes.subarray(3) : bytes);
    return { text, encoding: 'utf-8' };
  } catch {
    if (hasBom) return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
  }
}

/* UTF-8 byte length of a string, counted without copying. Stops counting once the length
 * passes `limit`, so a caller testing a cap pays at most for the cap. */
export function utf8ByteLength(text, limit = Infinity) {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xD800 && code <= 0xDBFF && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xDC00 && next <= 0xDFFF) { bytes += 4; i += 1; } else bytes += 3;
    } else bytes += 3;
    if (bytes > limit) return bytes;
  }
  return bytes;
}
