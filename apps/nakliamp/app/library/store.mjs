// NakliAmp library index — IndexedDB persistence.
// Headless by contract: no DOM, no engine import, no network.
//
// The index is a cache. The folder on disk is the truth, and playlists are
// `.m3u8` files in that folder. Nothing here is authoritative; a lost database
// costs a rescan, never a track.
//
// Records are versioned and validated on ingress, so a schema change is a
// migration rather than a field that silently disappears.

const DATABASE = 'nakliamp';
const VERSION = 2;

export const TRACK_SCHEMA = 1;

const STORE_TRACKS = 'tracks';
const STORE_ART = 'art';
const STORE_META = 'meta';
const STORE_PLAYLISTS = 'playlists';

/** Fields that define index identity. The hash covers these and nothing else. */
const IDENTITY_FIELDS = Object.freeze([
  'path', 'size', 'container', 'title', 'artist', 'album', 'albumArtist',
  'trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'genre',
  'durationS', 'sampleRate', 'channels',
]);

/** Playback state, which changes as you listen and must not perturb the hash. */
const MUTABLE_FIELDS = Object.freeze([
  'resumePositionS', 'playCount', 'lastPlayedAt', 'bookmarked', 'addedAt',
]);

// Delimiters for composite keys and index-hash rows. These are declared as
// escapes, never written literally: a raw control character is invisible in a
// diff, and `scripts/verify-source-hygiene.mjs` fails the build if one appears.
const KEY_SEPARATOR = '\u001f';
const FIELD_SEPARATOR = '\u001f';
const ROW_SEPARATOR = '\u001e';

let openPromise = null;

function request(operation) {
  return new Promise((resolve, reject) => {
    operation.onsuccess = () => resolve(operation.result);
    operation.onerror = () => reject(operation.error);
  });
}

function finish(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error('Library transaction aborted.'));
  });
}

export function openLibrary() {
  openPromise ??= new Promise((resolve, reject) => {
    const open = indexedDB.open(DATABASE, VERSION);
    open.onupgradeneeded = () => {
      const database = open.result;
      if (!database.objectStoreNames.contains(STORE_TRACKS)) {
        const tracks = database.createObjectStore(STORE_TRACKS, { keyPath: 'id' });
        tracks.createIndex('albumKey', 'albumKey', { unique: false });
        tracks.createIndex('artistKey', 'artistKey', { unique: false });
        tracks.createIndex('path', 'path', { unique: true });
        tracks.createIndex('bookmarked', 'bookmarked', { unique: false });
        tracks.createIndex('lastPlayedAt', 'lastPlayedAt', { unique: false });
      }
      if (!database.objectStoreNames.contains(STORE_ART)) database.createObjectStore(STORE_ART, { keyPath: 'key' });
      if (!database.objectStoreNames.contains(STORE_META)) database.createObjectStore(STORE_META, { keyPath: 'key' });
      // Added in schema 2. Playlists are files in the folder; this table is a
      // cache of what the scan found, exactly like the track table.
      if (!database.objectStoreNames.contains(STORE_PLAYLISTS)) {
        database.createObjectStore(STORE_PLAYLISTS, { keyPath: 'path' });
      }
    };
    open.onsuccess = () => resolve(open.result);
    open.onerror = () => reject(open.error);
    open.onblocked = () => reject(new Error('Another NakliAmp tab is holding the library open.'));
  });
  return openPromise;
}

/** Drop the cached handle so a deleted database is reopened cleanly. */
export function resetLibraryHandle() {
  openPromise = null;
}

// ------------------------------------------------------------ keys ----

/** Fold a display string into a stable grouping key. */
export function groupKey(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim() || 'unknown';
}

/** An album is identified by its album artist and title together. */
export function albumKeyOf(record) {
  return `${groupKey(record.albumArtist || record.artist)}${KEY_SEPARATOR}${groupKey(record.album)}`;
}

/**
 * A track's id is derived from its path, so rescanning the same folder
 * reproduces the same ids and the index hash is reproducible.
 */
export async function trackId(path) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(path)));
  return [...new Uint8Array(digest).subarray(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ------------------------------------------------------ validation ----

export class LibraryValidationError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'LibraryValidationError';
    this.code = 'ERR_NAKLIAMP_LIBRARY_INVALID';
    this.field = field;
  }
}

const isFiniteOrNull = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const isStringOrNull = value => value === null || typeof value === 'string';

/**
 * Ingress validation: every record entering the index is checked and normalised.
 * Returns a new normalised record; throws LibraryValidationError on a bad one.
 */
export function validateTrack(input) {
  if (!input || typeof input !== 'object') throw new LibraryValidationError('Track record is not an object.', null);
  if (typeof input.id !== 'string' || !input.id) throw new LibraryValidationError('Track id is missing.', 'id');
  if (typeof input.path !== 'string' || !input.path) throw new LibraryValidationError('Track path is missing.', 'path');
  if (!Number.isFinite(input.size) || input.size < 0) throw new LibraryValidationError('Track size is not a byte count.', 'size');

  for (const field of ['title', 'artist', 'album', 'albumArtist', 'genre', 'container', 'name']) {
    if (!isStringOrNull(input[field] ?? null)) throw new LibraryValidationError(`Field ${field} is not text.`, field);
  }
  for (const field of ['trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'durationS', 'sampleRate', 'channels']) {
    if (!isFiniteOrNull(input[field] ?? null)) throw new LibraryValidationError(`Field ${field} is not a number.`, field);
  }

  const record = {
    schema: TRACK_SCHEMA,
    id: input.id,
    path: input.path,
    name: input.name ?? null,
    size: input.size,
    lastModified: Number.isFinite(input.lastModified) ? input.lastModified : 0,
    container: input.container ?? null,
    title: input.title ?? null,
    artist: input.artist ?? null,
    album: input.album ?? null,
    albumArtist: input.albumArtist ?? null,
    trackNo: input.trackNo ?? null,
    trackTotal: input.trackTotal ?? null,
    discNo: input.discNo ?? null,
    discTotal: input.discTotal ?? null,
    year: input.year ?? null,
    genre: input.genre ?? null,
    durationS: input.durationS ?? null,
    sampleRate: input.sampleRate ?? null,
    channels: input.channels ?? null,
    hasLyrics: Boolean(input.hasLyrics),
    artKey: input.artKey ?? null,
    // D4: the index carries a resume position from its first version.
    resumePositionS: Number.isFinite(input.resumePositionS) ? input.resumePositionS : 0,
    playCount: Number.isFinite(input.playCount) ? input.playCount : 0,
    lastPlayedAt: Number.isFinite(input.lastPlayedAt) ? input.lastPlayedAt : 0,
    // IndexedDB cannot index a boolean, so the flag is stored as 0 or 1.
    bookmarked: input.bookmarked ? 1 : 0,
    addedAt: Number.isFinite(input.addedAt) ? input.addedAt : 0,
  };
  record.albumKey = albumKeyOf(record);
  record.artistKey = groupKey(record.artist || record.albumArtist);
  return record;
}

// --------------------------------------------------------- writing ----

export async function putTracks(records) {
  if (!records.length) return 0;
  const validated = records.map(validateTrack);
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  for (const record of validated) store.put(record);
  await finish(transaction);
  return validated.length;
}

export async function deleteTracks(ids) {
  if (!ids.length) return 0;
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  for (const id of ids) store.delete(id);
  await finish(transaction);
  return ids.length;
}

/**
 * Apply a partial update to one track's mutable playback fields.
 * Identity fields are refused here so playback can never perturb the index hash.
 */
export async function updateTrackState(id, patch) {
  const unknown = Object.keys(patch).filter(key => !MUTABLE_FIELDS.includes(key));
  if (unknown.length) throw new LibraryValidationError(`Not a mutable field: ${unknown.join(', ')}`, unknown[0]);
  const database = await openLibrary();
  const transaction = database.transaction(STORE_TRACKS, 'readwrite');
  const store = transaction.objectStore(STORE_TRACKS);
  const existing = await request(store.get(id));
  if (!existing) { transaction.abort(); return null; }
  const next = validateTrack({ ...existing, ...patch });
  store.put(next);
  await finish(transaction);
  return next;
}

export async function clearLibrary() {
  const database = await openLibrary();
  const stores = [STORE_TRACKS, STORE_ART, STORE_META, STORE_PLAYLISTS];
  const transaction = database.transaction(stores, 'readwrite');
  for (const store of stores) transaction.objectStore(store).clear();
  await finish(transaction);
}

// ------------------------------------------------------- playlists ----

export async function putPlaylists(playlists) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_PLAYLISTS, 'readwrite');
  const store = transaction.objectStore(STORE_PLAYLISTS);
  for (const playlist of playlists) store.put(playlist);
  await finish(transaction);
  return playlists.length;
}

export async function allPlaylists() {
  const database = await openLibrary();
  const rows = await request(
    database.transaction(STORE_PLAYLISTS, 'readonly').objectStore(STORE_PLAYLISTS).getAll(),
  );
  return rows.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

export async function deletePlaylists(paths) {
  if (!paths.length) return 0;
  const database = await openLibrary();
  const transaction = database.transaction(STORE_PLAYLISTS, 'readwrite');
  const store = transaction.objectStore(STORE_PLAYLISTS);
  for (const path of paths) store.delete(path);
  await finish(transaction);
  return paths.length;
}

// --------------------------------------------------------- reading ----

export async function allTracks() {
  const database = await openLibrary();
  return request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).getAll());
}

export async function trackCount() {
  const database = await openLibrary();
  return request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).count());
}

export async function getTrack(id) {
  const database = await openLibrary();
  return (await request(database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).get(id))) ?? null;
}

export async function tracksByIndex(indexName, key) {
  const database = await openLibrary();
  const index = database.transaction(STORE_TRACKS, 'readonly').objectStore(STORE_TRACKS).index(indexName);
  return request(index.getAll(key));
}

/** Sort within an album: disc, then track number, then title. */
export function compareAlbumOrder(left, right) {
  return (left.discNo ?? 1) - (right.discNo ?? 1)
    || (left.trackNo ?? 1e9) - (right.trackNo ?? 1e9)
    || String(left.title ?? left.name ?? '').localeCompare(String(right.title ?? right.name ?? ''));
}

/** Fold the track table into album rows for the album view. */
export function groupAlbums(tracks) {
  const albums = new Map();
  for (const track of tracks) {
    let album = albums.get(track.albumKey);
    if (!album) {
      album = {
        key: track.albumKey,
        album: track.album,
        albumArtist: track.albumArtist || track.artist,
        year: track.year,
        artKey: track.artKey,
        trackCount: 0,
        durationS: 0,
      };
      albums.set(track.albumKey, album);
    }
    album.trackCount += 1;
    album.durationS += track.durationS ?? 0;
    album.artKey ??= track.artKey;
    album.year ??= track.year;
  }
  return [...albums.values()].sort((left, right) =>
    String(left.albumArtist ?? '').localeCompare(String(right.albumArtist ?? ''))
    || (left.year ?? 0) - (right.year ?? 0)
    || String(left.album ?? '').localeCompare(String(right.album ?? '')));
}

/** Fold the track table into artist rows for the artist view. */
export function groupArtists(tracks) {
  const artists = new Map();
  for (const track of tracks) {
    let artist = artists.get(track.artistKey);
    if (!artist) {
      artist = { key: track.artistKey, artist: track.artist || track.albumArtist, trackCount: 0, albums: new Set() };
      artists.set(track.artistKey, artist);
    }
    artist.trackCount += 1;
    artist.albums.add(track.albumKey);
  }
  return [...artists.values()]
    .map(artist => ({ ...artist, albumCount: artist.albums.size, albums: undefined }))
    .sort((left, right) => String(left.artist ?? '').localeCompare(String(right.artist ?? '')));
}

// ------------------------------------------------------------- art ----

export async function putArt(key, blob) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_ART, 'readwrite');
  transaction.objectStore(STORE_ART).put({ key, blob });
  await finish(transaction);
  return key;
}

export async function getArt(key) {
  if (!key) return null;
  const database = await openLibrary();
  const record = await request(database.transaction(STORE_ART, 'readonly').objectStore(STORE_ART).get(key));
  return record?.blob ?? null;
}

/** Remove art no live track still points at. */
export async function pruneArt() {
  const tracks = await allTracks();
  const live = new Set(tracks.map(track => track.artKey).filter(Boolean));
  const database = await openLibrary();
  const transaction = database.transaction(STORE_ART, 'readwrite');
  const store = transaction.objectStore(STORE_ART);
  const keys = await request(store.getAllKeys());
  let removed = 0;
  for (const key of keys) {
    if (!live.has(key)) { store.delete(key); removed += 1; }
  }
  await finish(transaction);
  return removed;
}

// ------------------------------------------------------------ meta ----

export async function setMeta(key, value) {
  const database = await openLibrary();
  const transaction = database.transaction(STORE_META, 'readwrite');
  transaction.objectStore(STORE_META).put({ key, value });
  await finish(transaction);
  return value;
}

export async function getMeta(key, fallback = null) {
  const database = await openLibrary();
  const record = await request(database.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(key));
  return record === undefined ? fallback : record.value;
}

// ------------------------------------------------------ index hash ----

/**
 * A deterministic hash over the index's identity fields.
 * The M1 gate rescans the same folder and requires the same hash, which proves
 * scanning is reproducible and that playback state never leaks into identity.
 */
export async function indexHash(tracks) {
  const rows = [...tracks]
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
    .map(track => IDENTITY_FIELDS.map(field => {
      const value = track[field];
      return value === null || value === undefined ? '' : String(value);
    }).join(FIELD_SEPARATOR));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rows.join(ROW_SEPARATOR)));
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export { IDENTITY_FIELDS, MUTABLE_FIELDS };
