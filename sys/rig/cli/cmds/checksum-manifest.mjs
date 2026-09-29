// Manifests are data. Parsing never invokes the shell or changes its cwd.
export const DIGEST_LENGTHS = Object.freeze({ md5: 16, sha1: 20, sha224: 28, sha256: 32, sha384: 48, sha512: 64, blake2b: 64 });
export const DIGEST_TAGS = Object.freeze({ md5: 'MD5', sha1: 'SHA1', sha224: 'SHA224', sha256: 'SHA256', sha384: 'SHA384', sha512: 'SHA512', blake2b: 'BLAKE2b' });
export const digestHex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
export function escapeChecksumName(name) {
  return { escaped: /[\\\n\r]/.test(name), name: name.replace(/[\\\n\r]/g, (c) => c === '\\' ? '\\\\' : c === '\n' ? '\\n' : '\\r') };
}
function unescapeName(name) {
  let result = '';
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== '\\') { result += name[i]; continue; }
    const next = name[++i];
    if (!['\\', 'n', 'r'].includes(next)) return null;
    result += next === 'n' ? '\n' : next === 'r' ? '\r' : '\\';
  }
  return result;
}

export function parseChecksumRecord(line, { algorithm = null, allowBase64 = false } = {}) {
  if (line.endsWith('\r')) line = line.slice(0, -1);
  if (!line || line.startsWith('#')) return { skip: true };
  if (line.includes('\0')) return null;
  const escaped = line.startsWith('\\'); if (escaped) line = line.slice(1);
  let name, token, bits, selected = algorithm;
  const tagged = /^([A-Za-z0-9-]+) \((.*)\) = ([^ ]+)$/.exec(line);
  if (tagged) {
    const tag = tagged[1], short = /^BLAKE2b-([0-9]+)$/.exec(tag);
    selected = short ? 'blake2b' : Object.keys(DIGEST_TAGS).find((key) => DIGEST_TAGS[key] === tag);
    if (!selected || algorithm && algorithm !== selected) return null;
    if (short) { bits = Number(short[1]); if (bits < 8 || bits > 512 || bits % 8) return null; }
    else if (selected === 'blake2b') bits = 512;
    [, , name, token] = tagged;
  } else {
    if (!selected) return null; // Untagged auto-detection would confuse algorithms with equal widths.
    const untagged = /^([^ ]+) ([ *])(.+)$/.exec(line);
    if (untagged) [, token, , name] = untagged;
    else {
      const reversed = /^([^ ]+) (.+)$/.exec(line);
      if (!reversed) return null;
      [, token, name] = reversed;
    }
  }
  if (escaped) name = unescapeName(name);
  if (!name) return null;
  const expected = bits ? bits / 8 : DIGEST_LENGTHS[selected];
  let encoding = 'hex', byteLength;
  if (/^[0-9a-fA-F]+$/.test(token) && token.length % 2 === 0
      && (selected === 'blake2b' && !bits ? token.length <= 128 : token.length === expected * 2)) {
    byteLength = token.length / 2; token = token.toLowerCase();
  } else if (allowBase64 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(token)) {
    byteLength = token.length / 4 * 3 - (token.endsWith('==') ? 2 : token.endsWith('=') ? 1 : 0);
    if (selected === 'blake2b' && !bits ? byteLength < 1 || byteLength > 64 : byteLength !== expected) return null;
    encoding = 'base64';
  } else return null;
  return { algorithm: selected, bits: selected === 'blake2b' ? byteLength * 8 : undefined, name, token, encoding };
}
