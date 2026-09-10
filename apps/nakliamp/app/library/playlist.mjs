// Playlist reading and writing.
//
// Playlists are files in your folder, not rows in a database. That is the whole
// point: the index is a cache you can throw away, and the playlist is an
// artifact any other player can open and NakliAmp's disappearance cannot take.
//
// Reads M3U and M3U8 (Winamp's format, with EXTINF), PLS, XSPF, and JSPF.
// Writes M3U8, which is the one every player understands and the only one this
// project treats as canonical.
//
// Headless by contract: no DOM, no network. XSPF is read with scoped pattern
// matching rather than a DOM parser, because the module must run identically in
// a worker, in a page, and under `node --test`, and a playlist is a strictly
// shaped document rather than arbitrary XML.

const XML_ENTITIES = new Map([
  ['&amp;', '&'], ['&lt;', '<'], ['&gt;', '>'], ['&quot;', '"'], ['&apos;', "'"],
]);

function decodeXml(text) {
  return String(text ?? '')
    .replace(/&(?:amp|lt|gt|quot|apos);/g, entity => XML_ENTITIES.get(entity))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, digits) => String.fromCodePoint(Number(digits)));
}

function encodeXml(text) {
  return String(text ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** A playlist entry may name a remote stream; that is recorded, never fetched. */
function isRemote(target) {
  return /^[a-z][a-z0-9+.-]*:/i.test(target) && !/^file:/i.test(target);
}

/**
 * Resolve one playlist entry to a path inside the granted folder.
 *
 * `base` is the playlist's own directory, relative to the folder root. An entry
 * that would climb above the root resolves to null: a playlist is data, and
 * data must not be able to name a file outside what you granted.
 */
export function resolveEntry(base, target) {
  const raw = String(target ?? '').trim();
  if (!raw || isRemote(raw)) return null;

  let cleaned = raw.replace(/\\/g, '/');
  if (cleaned.startsWith('file:')) {
    try { cleaned = decodeURIComponent(new URL(cleaned).pathname); } catch { return null; }
  } else if (cleaned.includes('%')) {
    try { cleaned = decodeURIComponent(cleaned); } catch { /* keep the raw text */ }
  }

  // An absolute path cannot be honoured: the grant has no filesystem root.
  const segments = (cleaned.startsWith('/') ? cleaned.slice(1) : `${base ? `${base}/` : ''}${cleaned}`).split('/');
  const resolved = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (!resolved.length) return null; // climbing above the granted root
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }
  return resolved.length ? resolved.join('/') : null;
}

// ------------------------------------------------------------- M3U ----

function parseM3u(text, base) {
  const entries = [];
  let pending = null;
  let name = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const extinf = /^#EXTINF:\s*(-?\d+(?:\.\d+)?)\s*,\s*(.*)$/i.exec(line);
      if (extinf) {
        const durationS = Number(extinf[1]);
        pending = {
          durationS: Number.isFinite(durationS) && durationS > 0 ? durationS : null,
          ...splitArtistTitle(extinf[2]),
        };
        continue;
      }
      const playlistName = /^#PLAYLIST:\s*(.+)$/i.exec(line);
      if (playlistName) name = playlistName[1].trim();
      continue;
    }
    entries.push({ ...(pending ?? { durationS: null, artist: null, title: null }), target: line, path: resolveEntry(base, line) });
    pending = null;
  }
  return { name, entries };
}

/** EXTINF titles are conventionally "Artist - Title"; the split is best effort. */
function splitArtistTitle(text) {
  const value = String(text ?? '').trim();
  if (!value) return { artist: null, title: null };
  const dash = value.indexOf(' - ');
  if (dash > 0) return { artist: value.slice(0, dash).trim(), title: value.slice(dash + 3).trim() };
  return { artist: null, title: value };
}

// ------------------------------------------------------------- PLS ----

function parsePls(text, base) {
  const files = new Map();
  const titles = new Map();
  const lengths = new Map();
  let name = null;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    const pair = /^(File|Title|Length)(\d+)\s*=\s*(.*)$/i.exec(line);
    if (pair) {
      const index = Number(pair[2]);
      const value = pair[3].trim();
      if (/^file$/i.test(pair[1])) files.set(index, value);
      else if (/^title$/i.test(pair[1])) titles.set(index, value);
      else lengths.set(index, Number(value));
      continue;
    }
    const playlistName = /^PlaylistName\s*=\s*(.+)$/i.exec(line);
    if (playlistName) name = playlistName[1].trim();
  }

  const entries = [...files.keys()].sort((left, right) => left - right).map(index => {
    const target = files.get(index);
    const length = lengths.get(index);
    return {
      target,
      path: resolveEntry(base, target),
      durationS: Number.isFinite(length) && length > 0 ? length : null,
      ...splitArtistTitle(titles.get(index)),
    };
  });
  return { name, entries };
}

// ------------------------------------------------------------ XSPF ----

function parseXspf(text, base) {
  const name = decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(text)?.[1] ?? '').trim() || null;
  const entries = [];
  for (const [, block] of text.matchAll(/<track\b[^>]*>([\s\S]*?)<\/track>/gi)) {
    const target = decodeXml(/<location>([\s\S]*?)<\/location>/i.exec(block)?.[1] ?? '').trim();
    if (!target) continue;
    const seconds = Number(/<duration>\s*(\d+)\s*<\/duration>/i.exec(block)?.[1]);
    entries.push({
      target,
      path: resolveEntry(base, target),
      // XSPF durations are milliseconds; everything else here is seconds.
      durationS: Number.isFinite(seconds) && seconds > 0 ? seconds / 1000 : null,
      title: decodeXml(/<title>([\s\S]*?)<\/title>/i.exec(block)?.[1] ?? '').trim() || null,
      artist: decodeXml(/<creator>([\s\S]*?)<\/creator>/i.exec(block)?.[1] ?? '').trim() || null,
    });
  }
  return { name, entries };
}

// ------------------------------------------------------------ JSPF ----

function parseJspf(text, base) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    return { name: null, entries: [] };
  }
  const playlist = document?.playlist ?? document;
  const tracks = Array.isArray(playlist?.track) ? playlist.track : [];
  const entries = [];
  for (const track of tracks) {
    const target = Array.isArray(track?.location) ? track.location[0] : track?.location;
    if (typeof target !== 'string' || !target.trim()) continue;
    entries.push({
      target: target.trim(),
      path: resolveEntry(base, target.trim()),
      durationS: Number.isFinite(track.duration) && track.duration > 0 ? track.duration / 1000 : null,
      title: typeof track.title === 'string' ? track.title : null,
      artist: typeof track.creator === 'string' ? track.creator : null,
    });
  }
  return { name: typeof playlist?.title === 'string' ? playlist.title : null, entries };
}

// -------------------------------------------------------- dispatch ----

export const PLAYLIST_EXTENSIONS = Object.freeze(['m3u', 'm3u8', 'pls', 'xspf', 'jspf']);
const PLAYLIST_PATTERN = new RegExp(`\\.(${PLAYLIST_EXTENSIONS.join('|')})$`, 'i');

export function isPlaylistPath(path) {
  return PLAYLIST_PATTERN.test(String(path ?? ''));
}

/**
 * Parse a playlist.
 * `path` is the playlist's own path relative to the granted folder, which is
 * what makes its relative entries resolvable.
 * Never throws: an unreadable playlist yields no entries rather than stopping
 * a scan that is walking a thousand files.
 */
export function parsePlaylist(text, path = '') {
  const source = String(text ?? '');
  const base = String(path).split('/').slice(0, -1).join('/');
  const extension = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase();

  let parsed;
  try {
    if (extension === 'pls' || /^\s*\[playlist\]/i.test(source)) parsed = parsePls(source, base);
    else if (extension === 'xspf' || /<playlist[\s>]/i.test(source)) parsed = parseXspf(source, base);
    else if (extension === 'jspf' || /^\s*\{/.test(source)) parsed = parseJspf(source, base);
    else parsed = parseM3u(source, base);
  } catch {
    parsed = { name: null, entries: [] };
  }

  return {
    name: parsed.name || String(path).split('/').pop()?.replace(/\.[^.]+$/, '') || 'Playlist',
    path: String(path),
    format: extension ?? 'm3u',
    entries: parsed.entries,
    // Entries that name a remote stream or climb outside the granted folder are
    // kept in `entries` with a null path, and counted here rather than hidden.
    unresolved: parsed.entries.filter(entry => entry.path === null).length,
  };
}

/**
 * A file name that survives the filesystem and still reads as what was typed.
 *
 * The previous `[^\w \-.]` was ASCII-only, so `Café`, `日本のミックス` and `Кайф`
 * all collapsed to runs of `_` and overwrote each other. Only the
 * characters a filesystem actually rejects are replaced. Leading dots go
 * because they hide the file and because `.` and `..` are not names.
 */
export function safePlaylistFileName(name) {
  const cleaned = String(name ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '')
    .trim();
  return cleaned || 'playlist';
}

/**
 * Express `path` relative to the directory `base`, climbing with `..` when it
 * has to.
 *
 * A playlist's entries are relative to the playlist's own directory, so a track
 * outside that directory can only be named by climbing out of it. Writing the
 * folder-relative path unchanged instead — which is what this did — makes
 * `Rock/song.mp3` in `Playlists/mix.m3u8` re-read as `Playlists/Rock/song.mp3`,
 * so every track outside the playlist's directory is lost on the next read.
 */
export function relativeTo(base, path) {
  const from = String(base ?? '').replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  const to = String(path ?? '').split('/').filter(Boolean);
  let shared = 0;
  // `to.length - 1` because the last segment is the file name, never a directory.
  while (shared < from.length && shared < to.length - 1 && from[shared] === to[shared]) shared += 1;
  return [...Array.from({ length: from.length - shared }, () => '..'), ...to.slice(shared)].join('/');
}

/**
 * Serialise playlist items as M3U8, with paths relative to `base`.
 *
 * An item is either a **track** from the index — which has a `path` and no
 * `target` — or a **parsed entry** read from an existing playlist, which has
 * both, or has only a `target` when nothing in the granted folder could resolve
 * it. Entries keep their original text verbatim. That is what lets a remote
 * stream, a not-yet-scanned file, and anything else this folder cannot resolve
 * survive an edit: the alternative, writing back only the entries that matched
 * the index, deletes the rest from the user's file.
 *
 * Byte-stable for the same input, so an export and a re-import round-trip.
 */
export function toM3u8(items, { name = null, base = '' } = {}) {
  const directory = String(base ?? '').replace(/\/+$/, '');
  const lines = ['#EXTM3U'];
  if (name) lines.push(`#PLAYLIST:${name}`);
  for (const item of items) {
    const duration = Number.isFinite(item.durationS) && item.durationS > 0 ? Math.round(item.durationS) : -1;
    const label = [item.artist, item.title || item.name].filter(Boolean).join(' - ');
    lines.push(`#EXTINF:${duration},${label}`);
    lines.push(typeof item.target === 'string' && item.target
      ? item.target
      : relativeTo(directory, String(item.path ?? '')));
  }
  return `${lines.join('\n')}\n`;
}
