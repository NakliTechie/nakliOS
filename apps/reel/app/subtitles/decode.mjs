/* Subtitle file bytes to text. Pure: runs in the browser and in Node.
 *
 * Order: a UTF-16 byte-order mark wins; otherwise UTF-8 (its BOM is dropped); when UTF-8
 * decoding yields replacement characters the file is read as windows-1252 instead, which is
 * what most older European SRT files use. */

export function decodeSubtitleBytes(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
    return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
    return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be' };
  }
  const hasBom = bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF;
  const utf8 = new TextDecoder('utf-8').decode(hasBom ? bytes.subarray(3) : bytes);
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' };
  return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252' };
}
