// Point a card's media references at URLs the card frame can load. Anki fields name media by file name
// (<img src="dot.png">, <audio src="beep.wav">, url("_font.ttf") in CSS); the files live in the package,
// so each name is swapped for the URL `urlFor` returns (a blob: URL in the page, a marker in tests).
// Remote URLs and data: URLs are left alone; the frame's CSP still blocks remote ones.

const ATTR = /(<(?:img|audio|video|source)\b[^>]*?\ssrc\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

/** @param {string} s */
const isLocal = (s) => s !== '' && !/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(s);

/** File name from an attribute value: entities decoded, %-escapes decoded when valid. @param {string} raw */
function fileName(raw) {
  const s = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** @param {string} s */
const attr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * @param {string} html
 * @param {(name: string) => string | null} urlFor  null when the package has no such file
 */
export function resolveMedia(html, urlFor) {
  return html.replace(ATTR, (whole, pre, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare ?? '';
    if (!isLocal(raw)) return whole;
    const url = urlFor(fileName(raw));
    return url ? `${pre}"${attr(url)}"` : `${pre}"" data-missing="${attr(fileName(raw))}"`;
  });
}

/** @param {string} css @param {(name: string) => string | null} urlFor */
export function resolveMediaCss(css, urlFor) {
  return css.replace(CSS_URL, (whole, dq, sq, bare) => {
    const raw = dq ?? sq ?? bare ?? '';
    if (!isLocal(raw)) return whole;
    const url = urlFor(fileName(raw));
    return url ? `url("${url}")` : whole;
  });
}

/** Media type by extension, for blob: URLs. @param {string} name */
export function mediaType(name) {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return (
    {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif',
      mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', flac: 'audio/flac',
      mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
      ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2',
    }[ext] ?? 'application/octet-stream'
  );
}
